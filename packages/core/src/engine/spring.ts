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
}

export interface Dto extends Located { readonly name: string; readonly module: string; readonly fields: readonly DtoField[] }

export interface Entity extends Located {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly (Located & { readonly field: string; readonly column: string; readonly explicit: boolean })[];
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

export interface CallEdge extends Located { readonly from: string; readonly to: string }

/** A method an AI model can call: `@Tool`, or a `@Bean` function handed to a chat client by name. */
export interface Tool extends Located { readonly cls: string; readonly method: string; readonly mark: string }
export interface ToolWiring extends Located { readonly toolsClass: string; readonly holder: string; readonly expr: string }
export interface Listener extends Located { readonly kind: string; readonly cls: string; readonly method: string; readonly mentions: readonly string[] }
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

  // ---- DTOs: any record or class with fields; constraints and JSON names on them
  const dtos = new Map<string, Dto>();
  for (const { file, t } of allTypes) {
    if (t.kind !== 'record' && t.kind !== 'class') continue;
    const fields: DtoField[] = t.fields.filter((fl) => !/\bstatic\b/.test(fl.type)).map((fl) => {
      const jp = hasAnn(fl.annotations, 'JsonProperty');
      const jf = hasAnn(fl.annotations, 'JsonFormat');
      const pattern = jf ? annPairs(jf).get('pattern')?.replace(/^"|"$/g, '') : undefined;
      return {
        name: fl.name, type: fl.type, file, line: fl.line,
        json: (jp && (annPairs(jp).get('value')?.replace(/^"|"$/g, '') ?? annStrings(jp)[0])) || fl.name,
        constraints: fl.annotations.filter((a) => CONSTRAINTS.has(a.name)).map((a) => ({ file, line: a.line, rule: annText(a), name: a.name })),
        ...(jf && pattern ? { jsonFormat: { file, line: jf.line, pattern } } : {}),
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
    const columns = t.fields.filter((fl) => !/\bstatic\b/.test(fl.type)).map((fl) => {
      const c = hasAnn(fl.annotations, 'Column', 'JoinColumn');
      const column = (c && annPairs(c).get('name')?.replace(/^"|"$/g, '')) || fl.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      return { field: fl.name, column, explicit: !!c, file, line: c ? c.line : fl.line };
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
  const callEdges: CallEdge[] = [];
  const calls: JavaCall[] = [];
  const tools: Tool[] = [];
  const wiring: ToolWiring[] = [];
  const listeners: Listener[] = [];
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
        listeners.push({ kind: `@${la.name}`, cls, method: m.name, file, line: la.line, mentions: [...entityNames].filter((e) => words.has(e)) });
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
          if (x.t === 'this' && own.has(body[k + 2]!.t)) edge(`${cls}.${body[k + 2]!.t}`, x.line);
          else if (type && fieldTypes.has(type)) edge(`${type}.${body[k + 2]!.t}`, x.line);
        }
        // calls inside the class: helper(…), and to static methods: Other.helper(…)
        if (/^[a-z]\w*$/.test(x.t) && body[k + 1]?.t === '(' && body[k - 1]?.t !== '.' && body[k - 1]?.t !== 'new' && own.has(x.t)) edge(`${cls}.${x.t}`, x.line);
        if (/^[A-Z]\w*$/.test(x.t) && body[k + 1]?.t === '.' && /^[a-z]\w*$/.test(body[k + 2]?.t ?? '') && body[k + 3]?.t === '(' && fieldTypes.has(x.t)) edge(`${x.t}.${body[k + 2]!.t}`, x.line);
        // method references: this::helper, Type::helper
        if (body[k + 1]?.t === '::' && /^[a-z]\w*$/.test(body[k + 2]?.t ?? '')) {
          const target = x.t === 'this' ? cls : /^[A-Z]/.test(x.t) && fieldTypes.has(x.t) ? x.t : (ft.get(x.t) ?? locals.get(x.t));
          if (target) edge(`${target}.${body[k + 2]!.t}`, x.line);
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
  return { services, javaFiles, unreadable, endpoints, dtos, entities, calls, callEdges, tools, wiring, listeners, timed, gateway, gatewayService, configRepos, supertypes, moduleOf, serviceOf, dto };
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
