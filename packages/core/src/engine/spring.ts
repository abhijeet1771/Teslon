import type { Snapshot } from './snapshot.js';
import { readJavaFile, annStrings, annPairs, annText, hasAnn, type JavaFile, type JType, type JMethod, type JAnnotation, type Tok } from './java.js';

/**
 * Facts about a Spring code base, each with the file and line it came from.
 * Nothing here decides what is affected; it only says what exists.
 */

export interface Located { readonly file: string; readonly line: number }

export interface Endpoint extends Located {
  readonly service: string | null;
  readonly module: string;
  readonly verb: string;
  readonly path: string;
  readonly cls: string;
  readonly method: string;
  readonly methodLine: number;
  readonly body: null | { readonly type: string; readonly valid: boolean; readonly line: number };
  /** The handler's declared return type, as written: `ResponseEntity<List<Pet>>`. */
  readonly returns: string;
}

export interface Constraint extends Located { readonly rule: string; readonly name: string }

export interface DtoField extends Located {
  readonly name: string;
  readonly json: string;
  readonly type: string;
  readonly constraints: readonly Constraint[];
  readonly jsonFormat?: Located & { readonly pattern: string };
  /** @Valid on the field or its element type: the rules of the type it holds are enforced too */
  readonly valid?: boolean;
}

export interface Dto extends Located { readonly name: string; readonly module: string; readonly fields: readonly DtoField[] }

export interface Entity extends Located {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly (Located & { readonly field: string; readonly column: string; readonly explicit: boolean; /** false for @Transient: JPA neither saves nor loads it */ readonly stored?: false })[];
}

/** An HTTP call made from Java to another service. */
export interface JavaCall extends Located {
  readonly cls: string;
  readonly method: string;
  readonly verb: string;
  readonly service: string;
  readonly tpl: string;
  readonly how: string;
  /** Type of the request body this call sends, when it can be read. */
  readonly bodyType?: string;
  readonly handles4xx: boolean;
  readonly module: string;
}

export interface CallEdge extends Located {
  readonly from: string; readonly to: string;
  /** What the line shows when it is not the callee's name: an event published to a listener. */
  readonly quote?: string; readonly how?: string;
}

/** A method an AI model can call: `@Tool`, or a `@Bean` function handed to a chat client by name. */
export interface Tool extends Located { readonly cls: string; readonly method: string; readonly mark: string }
export interface ToolWiring extends Located { readonly toolsClass: string; readonly holder: string; readonly expr: string }
/** A topic or queue name, and how it was worked out from the code. */
export interface Channel { readonly name: string; readonly how: string; readonly pattern?: boolean }
/** A place that publishes to a message broker: `kafkaTemplate.send(Topics.X, key, message)`. */
export interface Producer extends Located {
  /** The method that sends: `OrderEventsPublisher.orderPlaced`. */
  readonly from: string;
  /** The topic, when it could be worked out; `expr` is what the code writes. */
  readonly channel: Channel | null;
  readonly expr: string;
  /** The type of the record value sent, when known. */
  readonly payload?: string;
  /** The key argument as written. */
  readonly key?: string;
  readonly module: string;
}
export interface Listener extends Located {
  readonly kind: string; readonly cls: string; readonly method: string; readonly mentions: readonly string[];
  /** Topics or queues a broker listener takes records from, resolved through constants and settings. */
  readonly channels?: readonly Channel[];
  /** The consumer group, as resolved. */
  readonly group?: string;
  /** Line of the last line of its annotation list: a change in between is a change to how it listens. */
  readonly annEnd?: number;
  readonly module?: string;
  /** Simple types of its parameters: for an @EventListener, the event it takes. */
  readonly takes: readonly string[];
  /** @Async: it runs on another thread, and the request that started it does not wait for it. */
  readonly async?: boolean;
}
export interface Timed extends Located { readonly metric: string; readonly cls: string; readonly method?: string }
export interface GatewayRoute extends Located { readonly service: string; readonly prefix: string; readonly strip: number }

export interface SpringFacts {
  readonly services: ReadonlyMap<string, string>;
  readonly javaFiles: ReadonlyMap<string, JavaFile>;
  readonly unreadable: readonly { file: string; error: string }[];
  readonly endpoints: readonly Endpoint[];
  readonly dtos: ReadonlyMap<string, Dto>;
  readonly entities: readonly Entity[];
  readonly calls: readonly JavaCall[];
  readonly callEdges: readonly CallEdge[];
  readonly tools: readonly Tool[];
  readonly wiring: readonly ToolWiring[];
  readonly listeners: readonly Listener[];
  /** Places that publish to a message broker. */
  readonly producers: readonly Producer[];
  /** `static final String` constants: `Topics.ORDER_PLACED` → "shop.orders.placed". */
  readonly constants: ReadonlyMap<string, string>;
  /** Settings of each module's application.yml / .properties, flattened: `billing.tax-rate` → "0.19". */
  readonly settings: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly timed: readonly Timed[];
  readonly gateway: readonly GatewayRoute[];
  readonly gatewayService: string | null;
  readonly configRepos: readonly (Located & { readonly uri: string })[];
  /** Simple class name → simple names of what it extends or implements. */
  readonly supertypes: ReadonlyMap<string, readonly string[]>;
  moduleOf(file: string): string;
  serviceOf(file: string): string | null;
  dto(module: string, type: string): Dto | undefined;
}

const CONSTRAINTS = new Set(['NotNull', 'NotBlank', 'NotEmpty', 'Size', 'Min', 'Max', 'Past', 'PastOrPresent', 'Future', 'FutureOrPresent', 'Pattern', 'Email', 'Positive', 'PositiveOrZero', 'Negative', 'NegativeOrZero', 'Digits', 'DecimalMin', 'DecimalMax', 'AssertTrue', 'AssertFalse', 'Length']);
const MAPPINGS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY' };
const LISTENERS = new Set(['Scheduled', 'EventListener', 'TransactionalEventListener', 'KafkaListener', 'RabbitListener', 'JmsListener', 'SqsListener']);

const joinPath = (a: string, b: string): string => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const lineOf = (src: string, i: number): number => src.slice(0, i).split('\n').length;

function mappingPaths(a: JAnnotation): string[] {
  const p = annPairs(a);
  const direct = p.get('value') ?? p.get('path');
  if (direct) return [...direct.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const s = annStrings(a);
  return s.length ? s : [''];
}

function verbOf(a: JAnnotation): string {
  const v = MAPPINGS[a.name] ?? 'ANY';
  if (v !== 'ANY') return v;
  const m = /RequestMethod\s*\.\s*(\w+)/.exec(annPairs(a).get('method') ?? '');
  return m?.[1] ?? 'ANY';
}

/** `a + "/x/" + b()` → its top-level parts. */
function splitPlus(toks: readonly Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [], d = 0;
  for (const t of toks) {
    if (t.t === '(') d++;
    if (t.t === ')') d--;
    if (t.t === '+' && d === 0) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Arguments of the call whose `(` is at index i. */
function callArgs(body: readonly Tok[], i: number): Tok[][] {
  const out: Tok[][] = [];
  let d = 0, cur: Tok[] = [];
  for (let k = i; k < body.length; k++) {
    const t = body[k]!.t;
    if (t === '(') { d++; if (d === 1) continue; }
    if (t === ')') { d--; if (d === 0) { if (cur.length) out.push(cur); return out; } }
    if (t === ',' && d === 1) { out.push(cur); cur = []; continue; }
    cur.push(body[k]!);
  }
  return out;
}

/** A YAML file's scalar settings, flattened to dotted keys. Lists and multi-line values are left out. */
export function flattenYaml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of text.split('\n')) {
    if (/^---/.test(raw)) { stack.length = 0; continue; }
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-/.test(raw)) continue;
    const m = /^(\s*)(["']?[\w.\-[\]]+["']?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const seg = m[2]!.replace(/^['"]|['"]$/g, '');
    const key = [...stack.map((x) => x.key), seg].join('.');
    const v = (m[3] ?? '').replace(/\s+#.*$/, '').trim();
    if (v === '' || v === '|' || v === '>') stack.push({ indent, key: seg });
    else if (!out.has(key)) out.set(key, v.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

const MESSAGE_TEMPLATES = /^(KafkaTemplate|KafkaOperations|ReactiveKafkaProducerTemplate)$/;

export function readSpring(snap: Snapshot): SpringFacts {
  // ---- modules and service names
  const services = new Map<string, string>();
  for (const f of snap.files) {
    const m = /^(.*?)\/?src\/main\/resources\/(?:application|bootstrap)\.ya?ml$/.exec(f);
    if (!m) continue;
    const name = /application:\s*\n\s+name:\s*([\w-]+)/.exec(snap.read(f) ?? '')?.[1] ?? /spring\.application\.name\s*[:=]\s*([\w-]+)/.exec(snap.read(f) ?? '')?.[1];
    if (name && !services.has(m[1] ?? '')) services.set(m[1] ?? '', name);
  }
  const modules = [...services.keys()].sort((a, b) => b.length - a.length);
  const moduleOf = (file: string): string => modules.find((d) => d === '' || file.startsWith(d + '/')) ?? '';
  const serviceOf = (file: string): string | null => services.get(moduleOf(file)) ?? null;
  // each module's own settings (the default profile): what a ${placeholder} in its code resolves to
  const settings = new Map<string, Map<string, string>>();
  for (const f of snap.files) {
    const m = /^(.*?)\/?src\/main\/resources\/application\.(ya?ml|properties)$/.exec(f);
    if (!m) continue;
    const text = snap.read(f) ?? '';
    const flat = m[2] === 'properties' ? new Map([...text.matchAll(/^\s*([\w.\-[\]]+)\s*[=:]\s*(.*?)\s*$/gm)].map((x) => [x[1]!, x[2]!] as [string, string])) : flattenYaml(text);
    const mod = moduleOf(f) || m[1] || '';
    const cur = settings.get(mod) ?? new Map<string, string>();
    for (const [k, v] of flat) if (!cur.has(k)) cur.set(k, v);
    settings.set(mod, cur);
  }

  // ---- java
  const javaFiles = new Map<string, JavaFile>();
  const unreadable: { file: string; error: string }[] = [];
  for (const f of snap.files) {
    if (!f.endsWith('.java') || /\/src\/test\//.test(f)) continue;
    const jf = readJavaFile(f, snap.read(f) ?? '');
    javaFiles.set(f, jf);
    if (!jf.ok) unreadable.push({ file: f, error: jf.error ?? 'parse error' });
  }
  const allTypes: { file: string; t: JType }[] = [];
  for (const [file, jf] of javaFiles) for (const t of jf.types) allTypes.push({ file, t });
  // string constants: Topics.ORDER_PLACED, and ORDER_PLACED alone when only one class has it (a static import)
  const constants = new Map<string, string>();
  const bare = new Map<string, string[]>();
  for (const { t } of allTypes) for (const fl of t.fields) {
    if (fl.init.length !== 1 || !/^"/.test(fl.init[0]!.t) || !(fl.mods?.includes('static') || t.kind === 'interface')) continue;
    const v = fl.init[0]!.t.slice(1, -1);
    constants.set(`${t.name.split('.').pop()}.${fl.name}`, v);
    bare.set(fl.name, [...(bare.get(fl.name) ?? []), v]);
  }
  for (const [k, vs] of bare) if (new Set(vs).size === 1 && !constants.has(k)) constants.set(k, vs[0]!);
  /** A topic expression → its name: "a.b", Topics.X, X, "${key}" through the module's settings. */
  const resolveChannel = (expr: string, module: string, own: ReadonlyMap<string, string>): Channel | null => {
    const e = expr.trim();
    const lit = /^"(.*)"$/.exec(e);
    if (lit) {
      const ph = /^\$\{([^}:]+)(?::([^}]*))?\}$/.exec(lit[1]!);
      if (!ph) return { name: lit[1]!, how: `"${lit[1]}"` };
      const v = settings.get(module)?.get(ph[1]!) ?? ph[2];
      return v === undefined ? null : { name: v, how: `\${${ph[1]}} = ${v} (${settings.get(module)?.has(ph[1]!) ? 'application settings' : 'its default'})` };
    }
    const q = /^(\w+)\s*\.\s*(\w+)$/.exec(e);
    if (q && constants.has(`${q[1]}.${q[2]}`)) return { name: constants.get(`${q[1]}.${q[2]}`)!, how: `${q[1]}.${q[2]} = "${constants.get(`${q[1]}.${q[2]}`)}"` };
    if (/^\w+$/.test(e) && own.has(e)) return { name: own.get(e)!, how: `${e} = "${own.get(e)}"` };
    if (/^\w+$/.test(e) && constants.has(e)) return { name: constants.get(e)!, how: `${e} = "${constants.get(e)}"` };
    return null;
  };

  // ---- DTOs: any record or class with fields; constraints and JSON names on them
  const dtos = new Map<string, Dto>();
  for (const { file, t } of allTypes) {
    if (t.kind !== 'record' && t.kind !== 'class') continue;
    const fields: DtoField[] = t.fields.filter((fl) => !/\bstatic\b/.test(fl.type) && !fl.mods?.includes('static')).map((fl) => {
      const jp = hasAnn(fl.annotations, 'JsonProperty');
      const jf = hasAnn(fl.annotations, 'JsonFormat');
      const pattern = jf ? annPairs(jf).get('pattern')?.replace(/^"|"$/g, '') : undefined;
      return {
        name: fl.name, type: fl.type, file, line: fl.line,
        json: (jp && (annPairs(jp).get('value')?.replace(/^"|"$/g, '') ?? annStrings(jp)[0])) || fl.name,
        constraints: fl.annotations.filter((a) => CONSTRAINTS.has(a.name)).map((a) => ({ file, line: a.line, rule: annText(a), name: a.name })),
        ...(jf && pattern ? { jsonFormat: { file, line: jf.line, pattern } } : {}),
        ...(hasAnn(fl.annotations, 'Valid') || /@((jakarta|javax)\.validation\.)?Valid(?![a-z0-9_])/.test(fl.type) ? { valid: true } : {}),
      };
    });
    const simple = t.name.split('.').pop()!;
    dtos.set(`${moduleOf(file)}|${simple}`, { name: simple, module: moduleOf(file), file, line: t.line, fields });
  }
  const dto = (module: string, type: string): Dto | undefined => dtos.get(`${module}|${type.replace(/<.*$/, '')}`);

  // ---- endpoints
  const endpoints: Endpoint[] = [];
  for (const { file, t } of allTypes) {
    if (!hasAnn(t.annotations, 'RestController', 'Controller')) continue;
    const baseAnn = hasAnn(t.annotations, 'RequestMapping');
    const bases = baseAnn ? mappingPaths(baseAnn) : [''];
    for (const m of t.methods) {
      for (const a of m.annotations) {
        if (!(a.name in MAPPINGS)) continue;
        const bodyParam = m.params.find((p) => hasAnn(p.annotations, 'RequestBody'));
        for (const b of bases) for (const p of mappingPaths(a)) {
          endpoints.push({
            service: serviceOf(file), module: moduleOf(file), verb: verbOf(a), path: joinPath(b, p),
            file, line: a.line, cls: t.name.split('.').pop()!, method: m.name, methodLine: m.line, returns: m.returnType,
            body: bodyParam ? { type: bodyParam.type, valid: !!hasAnn(bodyParam.annotations, 'Valid', 'Validated'), line: bodyParam.line } : null,
          });
        }
      }
    }
  }

  // ---- entities
  const entities: Entity[] = [];
  for (const { file, t } of allTypes) {
    if (!hasAnn(t.annotations, 'Entity')) continue;
    const ta = hasAnn(t.annotations, 'Table');
    const table = (ta && (annPairs(ta).get('name')?.replace(/^"|"$/g, '') ?? annStrings(ta)[0])) || t.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const columns = t.fields.filter((fl) => !/\bstatic\b/.test(fl.type) && !fl.mods?.includes('static')).map((fl) => {
      const c = hasAnn(fl.annotations, 'Column', 'JoinColumn');
      const column = (c && annPairs(c).get('name')?.replace(/^"|"$/g, '')) || fl.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      const tr = hasAnn(fl.annotations, 'Transient');
      return { field: fl.name, column, explicit: !!c, file, line: tr ? tr.line : c ? c.line : fl.line, ...(tr || fl.mods?.includes('transient') ? { stored: false as const } : {}) };
    });
    entities.push({ name: t.name.split('.').pop()!, table, file, line: ta ? ta.line : t.line, columns });
  }

  // ---- inside each class: field types, methods, calls between beans
  const fieldTypes = new Map<string, Map<string, string>>(); // cls -> field -> type
  const classFile = new Map<string, string>();
  for (const { file, t } of allTypes) {
    const cls = t.name.split('.').pop()!;
    classFile.set(cls, file);
    const ft = new Map<string, string>();
    for (const fl of t.fields) ft.set(fl.name, fl.type.replace(/<.*$/, ''));
    fieldTypes.set(cls, ft);
  }
  // what a getter returns, by property: order.getCustomer() is a Customer wherever a class has a field customer of that type
  const propTypes = new Map<string, Set<string>>();
  for (const { t } of allTypes) for (const fl of t.fields) {
    const ty = fl.type.replace(/<.*$/, '').split('.').pop()!;
    if (!/^[A-Z]/.test(ty) || /^(String|Long|Integer|Boolean|Double|BigDecimal|Instant|LocalDate|LocalDateTime|List|Set|Map|Optional|Collection)$/.test(ty)) continue;
    if (!propTypes.has(fl.name)) propTypes.set(fl.name, new Set());
    propTypes.get(fl.name)!.add(ty);
  }
  const callEdges: CallEdge[] = [];
  const calls: JavaCall[] = [];
  const tools: Tool[] = [];
  const wiring: ToolWiring[] = [];
  const listeners: Listener[] = [];
  const producers: Producer[] = [];
  const published: { from: string; type: string; file: string; line: number }[] = [];
  const timed: Timed[] = [];
  const functionRefs: { name: string; holder: string; file: string; line: number; call: string }[] = [];
  const entityNames = new Set(entities.map((e) => e.name));
  for (const { file, t } of allTypes) {
    const cls = t.name.split('.').pop()!;
    const ft = fieldTypes.get(cls)!;
    const consts = new Map<string, string>();
    for (const fl of t.fields) if (fl.init.length === 1 && /^"/.test(fl.init[0]!.t)) consts.set(fl.name, fl.init[0]!.t.slice(1, -1));
    // which methods of this class resolve a service through discovery
    const discovers = new Map<string, string>();
    for (const m of t.methods) {
      for (let k = 0; k < m.body.length; k++) {
        if (m.body[k]!.t === 'getInstances' && m.body[k + 1]?.t === '(' && /^"/.test(m.body[k + 2]?.t ?? '')) discovers.set(m.name, m.body[k + 2]!.t.slice(1, -1));
      }
    }
    const classTimed = hasAnn(t.annotations, 'Timed');
    if (classTimed && annStrings(classTimed)[0]) timed.push({ metric: annStrings(classTimed)[0]!, cls, file, line: classTimed.line });
    // Feign: an interface that names its service
    const feign = hasAnn(t.annotations, 'FeignClient');
    if (feign) {
      const service = (annPairs(feign).get('name') ?? annPairs(feign).get('value') ?? '').replace(/^"|"$/g, '') || annStrings(feign)[0] || '';
      for (const m of t.methods) for (const a of m.annotations) if (a.name in MAPPINGS) for (const p of mappingPaths(a)) {
        const bodyParam = m.params.find((x) => hasAnn(x.annotations, 'RequestBody'));
        calls.push({ file, line: a.line, cls, method: m.name, verb: verbOf(a), service, tpl: joinPath('', p).replace(/\{[^}]*\}/g, '{*}'), how: `@FeignClient("${service}")`, handles4xx: false, module: moduleOf(file), ...(bodyParam ? { bodyType: bodyParam.type } : {}) });
      }
    }
    for (const m of t.methods) {
      const mt = hasAnn(m.annotations, 'Timed');
      if (mt && annStrings(mt)[0]) timed.push({ metric: annStrings(mt)[0]!, cls, method: m.name, file, line: mt.line });
      if (hasAnn(m.annotations, 'Tool')) tools.push({ cls, method: m.name, file, line: hasAnn(m.annotations, 'Tool')!.line, mark: 'Tool' });
      const la = m.annotations.find((a) => LISTENERS.has(a.name));
      if (la) {
        const words = new Set(m.body.map((x) => x.t));
        // a broker listener's topics or queues: topics = X, topics = {A, B}, queues = "…", destination = "…"
        const pairs = annPairs(la);
        const raw = pairs.get('topics') ?? pairs.get('queues') ?? pairs.get('destination') ?? pairs.get('topicPattern') ?? (/^(RabbitListener|JmsListener|SqsListener)$/.test(la.name) ? pairs.get('value') : undefined);
        const own = new Map([...consts]);
        const channels = raw === undefined ? undefined : raw.replace(/^\{|\}$/g, '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean).map((x) => resolveChannel(x, moduleOf(file), own) ?? { name: x, how: `${x} (not resolved)` }).map((c) => (pairs.has('topicPattern') ? { ...c, pattern: true } : c));
        const groupRaw = pairs.get('groupId') ?? pairs.get('id');
        const group = groupRaw ? (resolveChannel(groupRaw, moduleOf(file), own)?.name ?? groupRaw) : (/^KafkaListener$/.test(la.name) ? settings.get(moduleOf(file))?.get('spring.kafka.consumer.group-id') : undefined);
        const annEnd = Math.max(...m.annotations.map((a) => a.line + Math.max(0, ...a.args.map((x) => x.line - a.line))));
        listeners.push({ kind: `@${la.name}`, cls, method: m.name, file, line: la.line, mentions: [...entityNames].filter((e) => words.has(e) || m.params.some((p) => p.type.replace(/<.*$/, '').split('.').pop() === e)), takes: m.params.map((p) => p.type.replace(/<.*$/, '').split('.').pop()!), ...(hasAnn(m.annotations, 'Async') || hasAnn(t.annotations, 'Async') ? { async: true } : {}), ...(channels ? { channels } : {}), ...(group ? { group } : {}), annEnd, module: moduleOf(file) });
      }
      const locals = new Map<string, string>(m.params.map((p) => [p.name, p.type.replace(/<.*$/, '')]));
      const body = m.body;
      const own = new Set(t.methods.map((x) => x.name));
      const edge = (to: string, line: number): void => { if (to !== `${cls}.${m.name}`) callEdges.push({ from: `${cls}.${m.name}`, to, file, line }); };
      for (let k = 0; k < body.length; k++) {
        const x = body[k]!;
        // local variables: `Type name =` and `Type name;`
        if (/^[A-Z]\w*$/.test(x.t) && /^[a-z]\w*$/.test(body[k + 1]?.t ?? '') && (body[k + 2]?.t === '=' || body[k + 2]?.t === ';' || body[k + 2]?.t === ':')) locals.set(body[k + 1]!.t, x.t);
        // bean calls: field.method( and local.method(
        if (/^[a-z]/.test(x.t) && body[k + 1]?.t === '.' && /^[a-z]\w*$/.test(body[k + 2]?.t ?? '') && body[k + 3]?.t === '(' && body[k - 1]?.t !== '.') {
          const type = ft.get(x.t) ?? locals.get(x.t);
          if (x.t === 'this' && own.has(body[k + 2]!.t)) edge(`${cls}.${body[k + 2]!.t}`, body[k + 2]!.line);
          else if (type && fieldTypes.has(type)) edge(`${type}.${body[k + 2]!.t}`, body[k + 2]!.line);
        }
        // a broker send: kafkaTemplate.send(topic, [key,] value), or send(new ProducerRecord<>(topic, key, value))
        if (x.t === 'send' && body[k - 1]?.t === '.' && body[k + 1]?.t === '(' && MESSAGE_TEMPLATES.test(ft.get(body[k - 2]?.t ?? '') ?? locals.get(body[k - 2]?.t ?? '') ?? '')) {
          let args = callArgs(body, k + 1);
          if (args.length === 1 && args[0]![0]?.t === 'new' && args[0]![1]?.t === 'ProducerRecord') { const at = args[0]!.findIndex((y) => y.t === '('); args = at >= 0 ? callArgs(args[0]!, at) : args; }
          const expr = (args[0] ?? []).map((y) => y.t).join(' ').replace(/\s*\.\s*/g, '.');
          const val = args.length >= 3 ? args[2]! : args.length === 2 ? args[1]! : [];
          const payload = val[0]?.t === 'new' ? val[1]?.t : val.length === 1 ? (locals.get(val[0]!.t) ?? ft.get(val[0]!.t))?.split('.').pop() : undefined;
          producers.push({ from: `${cls}.${m.name}`, file, line: x.line, channel: resolveChannel(expr, moduleOf(file), consts), expr, ...(payload ? { payload } : {}), ...(args.length >= 3 ? { key: args[1]!.map((y) => y.t).join('') } : {}), module: moduleOf(file) });
        }
        // events: publishEvent(new OrderPlacedEvent(…)), or a local or parameter of the event's type
        if (x.t === 'publishEvent' && body[k + 1]?.t === '(') {
          const a = body[k + 2]?.t === 'new' ? body[k + 3]?.t : locals.get(body[k + 2]?.t ?? '')?.split('.').pop();
          if (a && /^[A-Z]/.test(a)) published.push({ from: `${cls}.${m.name}`, type: a, file, line: x.line });
        }
        // a call on what a getter returns: o.getCustomer().getName() calls Customer.getName
        if (/^(get|is)[A-Z]\w*$/.test(x.t) && body[k - 1]?.t === '.' && body[k + 1]?.t === '(' && body[k + 2]?.t === ')' && body[k + 3]?.t === '.' && /^[a-z]\w*$/.test(body[k + 4]?.t ?? '') && body[k + 5]?.t === '(') {
          const prop = x.t.replace(/^(get|is)/, '').replace(/^./, (c) => c.toLowerCase());
          for (const ty of propTypes.get(prop) ?? []) if (fieldTypes.has(ty)) edge(`${ty}.${body[k + 4]!.t}`, body[k + 4]!.line);
        }
        // calls inside the class: helper(…), and to static methods: Other.helper(…)
        if (/^[a-z]\w*$/.test(x.t) && body[k + 1]?.t === '(' && body[k - 1]?.t !== '.' && body[k - 1]?.t !== 'new' && own.has(x.t)) edge(`${cls}.${x.t}`, x.line);
        if (/^[A-Z]\w*$/.test(x.t) && body[k + 1]?.t === '.' && /^[a-z]\w*$/.test(body[k + 2]?.t ?? '') && body[k + 3]?.t === '(' && fieldTypes.has(x.t)) edge(`${x.t}.${body[k + 2]!.t}`, body[k + 2]!.line);
        // method references: this::helper, Type::helper
        if (body[k + 1]?.t === '::' && /^[a-z]\w*$/.test(body[k + 2]?.t ?? '')) {
          const target = x.t === 'this' ? cls : /^[A-Z]/.test(x.t) && fieldTypes.has(x.t) ? x.t : (ft.get(x.t) ?? locals.get(x.t));
          if (target) edge(`${target}.${body[k + 2]!.t}`, body[k + 2]!.line);
        }
        // functions handed to a chat client by bean name: .defaultFunctions("listOwners", …)
        if ((x.t === 'defaultFunctions' || x.t === 'functions' || x.t === 'toolNames' || x.t === 'defaultToolNames') && body[k - 1]?.t === '.' && body[k + 1]?.t === '(') {
          for (const arg of callArgs(body, k + 1)) if (/^"/.test(arg[0]?.t ?? '')) functionRefs.push({ name: arg[0]!.t.slice(1, -1), holder: cls, file, line: arg[0]!.line, call: x.t });
        }
        // tools handed to a chat client
        if ((x.t === 'defaultTools' || x.t === 'tools') && body[k - 1]?.t === '.' && body[k + 1]?.t === '(') {
          for (const arg of callArgs(body, k + 1)) {
            const name = arg[0]?.t;
            const type = name ? (locals.get(name) ?? ft.get(name)) : undefined;
            if (type) wiring.push({ toolsClass: type, holder: cls, file, line: x.line, expr: `.${x.t}(${name})` });
          }
        }
        // RestClient / WebClient: .post() … .uri(expr) … .body(x) … .retrieve()
        if (x.t === 'uri' && body[k - 1]?.t === '.' && body[k + 1]?.t === '(') {
          const args = callArgs(body, k + 1);
          const expr = args[0] ?? [];
          let verb = 'GET';
          for (let b = k - 1; b >= Math.max(0, k - 12); b--) {
            const v = body[b]!.t;
            if (/^(get|post|put|delete|patch)$/.test(v) && body[b - 1]?.t === '.') { verb = v.toUpperCase(); break; }
          }
          let service = '', how = '', tpl = '';
          for (const part of splitPlus(expr)) {
            const first = part[0]?.t ?? '';
            if (part.length >= 3 && part[1]?.t === '(' && discovers.has(first)) { service = discovers.get(first)!; how = `${first}() → DiscoveryClient.getInstances("${service}")`; continue; }
            // a field holding a constant URL reads exactly like the literal it holds
            const isConst = part.length === 1 && consts.has(first);
            if (isConst || (part.length === 1 && /^"/.test(first))) {
              const lit = isConst ? consts.get(first)! : first.slice(1, -1);
              const u = /^(?:https?|lb):\/\/([\w-]+)(\/.*)?$/.exec(lit);
              if (u) { service = u[1]!; how = isConst ? `${first} = "${lit}" names the service ${service}` : `URL names the service ${service}`; tpl += (u[2] ?? '/').replace(/\{[^}]*\}/g, '{*}'); }
              else tpl += lit.replace(/\{[^}]*\}/g, '{*}');
              continue;
            }
            tpl += '{*}';
          }
          if (!service) continue;
          // what follows on the same chain: the body sent, and whether 4xx is handled
          let bodyType: string | undefined;
          let handles4xx = false;
          let e = k;
          for (let d = 0; e < body.length; e++) {
            const t2 = body[e]!.t;
            if (t2 === '(') d++;
            else if (t2 === ')') d--;
            else if (t2 === ';' && d <= 0) break;
            if (t2 === 'body' && body[e - 1]?.t === '.' && body[e + 1]?.t === '(') {
              const arg = body[e + 2]?.t;
              const ty = arg ? locals.get(arg) : undefined;
              if (ty) bodyType = ty;
            }
            if (t2 === 'onStatus' || t2 === 'exchange' || t2 === 'onErrorResume' || t2 === 'exchangeToMono') handles4xx = true;
          }
          const tryAround = body.slice(0, k).some((q) => q.t === 'try');
          calls.push({ file, line: x.line, cls, method: m.name, verb, service, tpl: tpl.replace(/(\{\*\})+/g, '{*}'), how, handles4xx: handles4xx || tryAround, module: moduleOf(file), ...(bodyType ? { bodyType } : {}) });
        }
      }
    }
  }

  // ---- gateway routes and config server
  const gateway: GatewayRoute[] = [];
  const configRepos: (Located & { uri: string })[] = [];
  for (const f of snap.files) {
    if (!/src\/main\/resources\/(application|bootstrap)(-[\w-]+)?\.ya?ml$/.test(f)) continue;
    const y = snap.read(f) ?? '';
    if (/gateway:/.test(y) || /\n\s*-\s*Path=/.test(y)) {
      const blocks = y.split(/\n(?=\s*-\s+id:)/);
      let offset = 0;
      for (const blk of blocks) {
        const uri = /uri:\s*lb:\/\/([\w-]+)/.exec(blk)?.[1];
        const path = /-\s*Path=([^\s,]+)/.exec(blk);
        const strip = Number(/StripPrefix=(\d+)/.exec(blk)?.[1] ?? 0);
        if (uri && path) gateway.push({ service: uri, prefix: path[1]!.replace(/\/\*\*$/, ''), strip, file: f, line: lineOf(y, offset + path.index + path[0].indexOf('Path=')) });
        offset += blk.length + 1;
      }
    }
    const git = /config:\s*\n(?:.*\n)*?\s*server:\s*\n(?:.*\n)*?\s*git:\s*\n\s*uri:\s*(\S+)/.exec(y);
    if (git) configRepos.push({ uri: git[1]!, file: f, line: lineOf(y, git.index + git[0].lastIndexOf('uri:')) });
  }
  const gatewayService = gateway.length ? serviceOf(gateway[0]!.file) : null;

  // a function named to the chat client is the @Bean method of that name
  for (const ref of functionRefs) {
    for (const { file, t } of allTypes) {
      const m = t.methods.find((x) => x.name === ref.name && hasAnn(x.annotations, 'Bean'));
      if (!m) continue;
      const cls = t.name.split('.').pop()!;
      if (!tools.some((x) => x.cls === cls && x.method === m.name)) tools.push({ cls, method: m.name, file, line: hasAnn(m.annotations, 'Bean')!.line, mark: 'Bean' });
      wiring.push({ toolsClass: cls, holder: ref.holder, file: ref.file, line: ref.line, expr: `.${ref.call}("${ref.name}")` });
    }
  }
  const supertypes = new Map<string, string[]>();
  for (const { t } of allTypes) supertypes.set(t.name.split('.').pop()!, t.supertypes.map((x) => x.split('.').pop()!.replace(/<.*$/, '')));
  // a MapStruct mapper's generated code calls its own methods for nested types: toDto(Order) calls toLineDto for List<OrderLineDto>
  for (const { file, t } of allTypes) {
    if (!t.annotations.some((a) => a.name === 'Mapper')) continue;
    const cls = t.name.split('.').pop()!;
    for (const a of t.methods) {
      const out = dtos.get(`${moduleOf(file)}|${a.returnType.replace(/<.*$/, '').split('.').pop()}`);
      if (!out) continue;
      const nested = new Set(out.fields.flatMap((fl) => fl.type.match(/[A-Z]\w*/g) ?? []));
      for (const b of t.methods) if (b !== a && nested.has(b.returnType.replace(/^.*<|>.*$/g, '').split('.').pop()!)) callEdges.push({ from: `${cls}.${a.name}`, to: `${cls}.${b.name}`, file, line: a.line, quote: a.name, how: `MapStruct's ${cls}.${a.name}() maps ${b.returnType} with ${b.name}()` });
    }
  }
  // an in-process listener that is not @Async runs inside the call that publishes: the request waits for it, and its failure is the request's
  for (const p of published) for (const l of listeners) {
    if (l.async || !/^@(EventListener|TransactionalEventListener)$/.test(l.kind) || !l.takes.includes(p.type)) continue;
    callEdges.push({ from: p.from, to: `${l.cls}.${l.method}`, file: p.file, line: p.line, quote: 'publishEvent', how: `${p.from}() publishes ${p.type}, and ${l.cls}.${l.method}() (${l.kind}) runs inside that call` });
  }
  return { services, javaFiles, unreadable, endpoints, dtos, entities, calls, callEdges, tools, wiring, listeners, producers, constants, settings, timed, gateway, gatewayService, configRepos, supertypes, moduleOf, serviceOf, dto };
}

/** Where an external path through the gateway really lands. */
export function throughGateway(f: SpringFacts, extPath: string): { service: string | null; path: string; route: GatewayRoute | null } {
  for (const r of f.gateway) if (extPath === r.prefix || extPath.startsWith(r.prefix + '/')) {
    return { service: r.service, path: '/' + extPath.split('/').filter(Boolean).slice(r.strip).join('/'), route: r };
  }
  return { service: f.gatewayService, path: extPath, route: null };
}

/** The external path an endpoint is reachable at, through the gateway. */
export function exposedAs(f: SpringFacts, e: Endpoint): { path: string; route: GatewayRoute } | null {
  for (const r of f.gateway) {
    if (r.service !== e.service) continue;
    const prefixSegs = r.prefix.split('/').filter(Boolean);
    if (prefixSegs.length !== r.strip) continue;
    return { path: r.prefix + e.path, route: r };
  }
  return null;
}

/** Does a consumer URL template reach this endpoint? Holes are tried as an id, a segment, and empty. */
export function templateHits(tpl: string, endpointPath: string): boolean {
  const re = new RegExp('^' + endpointPath.split('/').map((s) => (s === '*' || /^\{.*\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))).join('/') + '$');
  const holes = tpl.split('{*}').length - 1;
  let out = [tpl];
  for (let i = 0; i < holes && out.length < 512; i++) out = out.flatMap((t) => ['7', '/7', ''].map((v) => t.replace('{*}', v)));
  return out.some((p) => re.test(p.replace(/\/+/g, '/').replace(/\?.*$/, '')));
}

export type { JMethod };
