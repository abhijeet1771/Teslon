import ts from 'typescript';
import type { Snapshot, ChangedFile } from './snapshot.js';
import { exposedAs, templateHits, type SpringFacts, type Endpoint } from './spring.js';
import { targetsRoute, routeQuote, callMadeBy, usesMembers, type FrontendFacts, type Route, type Component, type ApiCall } from './vue.js';
import { annStrings, annPairs, sameTokens, type JType, type JMethod } from './java.js';
import { startupRisks, activeProfiles } from './startup.js';
import type { Delta, Surface, Case, Hop, Unseen, Tier } from './model.js';
import { fileKind } from './kinds.js';

/**
 * Where code that changed lands, when what it does is not typed.
 *
 * A typed delta says exactly what to try. Most PRs change code whose meaning
 * no rule types: a method body, a template, a dependency. For those, Teslon
 * still owes the reader the places that run the changed code, each with the
 * chain that leads there, so a tester knows where to look. These are "test
 * next" claims, never "test first", and never a skip.
 */

export interface WhereCtx {
  readonly B: Snapshot;
  readonly H: Snapshot;
  readonly fb: SpringFacts;
  readonly fh: SpringFacts;
  readonly ui: FrontendFacts;
  readonly ub: FrontendFacts;
  readonly changes: readonly ChangedFile[];
  readonly deltas: Delta[];
  readonly unseen: Unseen[];
  surface(s: Surface): Surface;
  addCase(c: Case): void;
  explained(file: string, line: number): boolean;
  follow(file: string, line: number, side?: 'base'): void;
  /** The file's changes cannot alter the running app, for this reason. */
  noEffect(file: string, reason: string): void;
  closure(file: string): Set<string>;
  /** Endpoints reached by changed code, so screens calling them are never skipped. */
  readonly touched: Set<Endpoint>;
  /** Front-end files that changed, at head or deleted. */
  readonly touchedUi: Set<string>;
  /** Broker listeners whose way of receiving changed (a setting, a topic), found here and followed into the data they write. */
  readonly receiving?: { cls: string; method: string; why: string; hop: Hop }[];
  /** Methods that behave differently without a changed line in them (a setting they read): what they return may be written. */
  readonly affected?: { at: string; hop: Hop }[];
  /** Front-end modules where only named members changed: the members, so a screen that uses none of them is ruled out. */
  readonly uiMembers?: Map<string, { owner: string; member: string; line: number }[]>;
  /** Reasons no area can be ruled out (a service that may not start): every area not listed is held. */
  readonly holdAll?: string[];
}

const fileName = (p: string): string => p.split('/').pop() ?? p;
const simple = (n: string): string => n.split('.').pop()!;
const snippet = (t: string | null): string => (t ?? '').trim().slice(0, 24).trim();
const trivial = (t: string): boolean => t === '' || t === '}' || t === '{' || t === ');' || /^(\/\/|\*|\/\*|\*\/)/.test(t) || /^(import|package)\s/.test(t);

/** Lines inside TypeScript declarations that compile to nothing: interfaces, type aliases, `import type`, `declare`. */
function typeOnlyLines(text: string): Set<number> {
  const out = new Set<number>();
  if (!text) return out;
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const mark = (n: ts.Node): void => {
    const a = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, b = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
    for (let i = a; i <= b; i++) out.add(i);
  };
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) mark(st);
    else if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) mark(st);
    else if (ts.isExportDeclaration(st) && st.isTypeOnly) mark(st);
    else if (ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) mark(st);
  }
  // a line shared with code that runs is not erased
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
    const a = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1, b = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    for (let i = a; i <= b; i++) out.delete(i);
  }
  return out;
}

/**
 * The methods an aspect's pointcuts name: execution(* pkg..*(..)), within(pkg..*),
 * @annotation(X). Null when a pointcut cannot be read, so the change stays unfollowed and is said.
 */
function pointcutTargets(f: SpringFacts, aspect: JType): string[] | null {
  const pcs = aspect.methods.flatMap((m) => m.annotations.filter((a) => /^(Around|Before|After|AfterReturning|AfterThrowing|Pointcut)$/.test(a.name)).flatMap((a) => annStrings(a)));
  if (!pcs.length) return null;
  const out = new Set<string>();
  for (const pc of pcs) {
    const parts = [...pc.matchAll(/(execution|within|@annotation|@within)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)];
    // a pointcut that names other pointcuts or beans is not read
    if (!parts.length) { if (/^\s*\w+\(\)\s*$/.test(pc) || /\b\w+\(\)/.test(pc)) continue; return null; }
    for (const [, kind, arg] of parts) {
      if (kind === '@annotation' || kind === '@within') {
        const ann = arg!.trim().split('.').pop()!;
        for (const jf of f.javaFiles.values()) for (const t of jf.types) for (const m of t.methods) if ((kind === '@annotation' ? m.annotations : t.annotations).some((a) => a.name === ann)) out.add(`${simple(t.name)}.${m.name}`);
        continue;
      }
      // the declaring type pattern: com.orderdesk.service..* or com.orderdesk.service.*.*
      const decl = kind === 'within' ? arg!.trim() : (/^\S+\s+([\w.*]+)\s*\(/.exec(arg!.trim())?.[1] ?? '');
      const pkg = decl.split(/\.\.|\.\*/)[0]!.replace(/\.$/, '');
      if (!pkg || pkg === '*') return null;
      for (const jf of f.javaFiles.values()) {
        if (!(jf.pkg === pkg || jf.pkg.startsWith(`${pkg}.`) || (!decl.includes('..') && jf.pkg === pkg))) continue;
        for (const t of jf.types) for (const m of t.methods) if (m.name !== simple(t.name)) out.add(`${simple(t.name)}.${m.name}`);
      }
    }
  }
  return [...out];
}

/** Does a Spring path pattern (/api/reports/** or /api/{x}/items) match an endpoint path (/api/reports/{id})? */
function antMatch(pattern: string, path: string): boolean {
  const re = pattern.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/]+').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\/\u0000/g, '(/.*)?').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}/?$`).test(path.replace(/\{[^}]*\}/g, 'x'));
}

/** Framework settings that configure one client bean, and the types that bean is injected as. */
const CLIENT_KEYS: [RegExp, RegExp][] = [
  [/^spring\.mail\./, /^(JavaMailSender|MailSender|JavaMailSenderImpl)$/],
  [/^spring\.rabbitmq\./, /^(RabbitTemplate|AmqpTemplate|RabbitOperations)$/],
  [/^spring\.kafka\.producer\./, /^(KafkaTemplate|KafkaOperations)$/],
  [/^spring\.(data\.)?redis\./, /^(RedisTemplate|StringRedisTemplate|ReactiveRedisTemplate|RedisConnectionFactory)$/],
];

/** Line ranges of every `{ … }` in a source text, strings and comments skipped. */
function objectSpans(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const stack: number[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') { line++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 1; for (let k = i; k < end; k++) if (text[k] === '\n') line++; i = end; continue; }
    if (c === '"' || c === "'" || c === '`') { let k = i + 1; while (k < text.length && text[k] !== c) { if (text[k] === '\\') k++; else if (text[k] === '\n') line++; k++; } i = k; continue; }
    if (c === '{') stack.push(line);
    else if (c === '}' && stack.length) out.push({ from: stack.pop()!, to: line });
  }
  return out;
}

/** Innermost type and method that hold a line. */
function locate(types: readonly JType[], line: number): { type: JType; method: JMethod | null } | null {
  let best: JType | null = null;
  for (const t of types) {
    const start = Math.min(t.line, ...t.annotations.map((a) => a.line));
    if (line >= start && line <= t.endLine && (!best || t.endLine - t.line < best.endLine - best.line)) best = t;
  }
  if (!best) return null;
  const method = best.methods.find((m) => line >= Math.min(m.line, ...m.annotations.map((a) => a.line)) && line <= m.endLine) ?? null;
  return { type: best, method };
}

interface Reach { readonly kind: 'endpoint' | 'tool' | 'listener'; readonly at: string; readonly hops: Hop[] }

/** Walk callers from a method up to endpoints, AI tools and jobs, through interfaces to their implementations. */
function reachFrom(f: SpringFacts, start: string): Reach[] {
  const out: Reach[] = [];
  const seen = new Set<string>();
  // callers of I.m reach C.m when C implements I
  const asCalled = (at: string): string[] => {
    const [cls, m] = at.split('.') as [string, string];
    return [at, ...(f.supertypes.get(cls) ?? []).map((s) => `${s}.${m}`)];
  };
  const walk = (at: string, hops: Hop[], depth: number): void => {
    if (seen.has(at) || depth > 8) return;
    seen.add(at);
    const [cls, method] = at.split('.') as [string, string];
    if (f.endpoints.some((x) => x.cls === cls && x.method === method)) out.push({ kind: 'endpoint', at, hops });
    if (f.tools.some((t) => t.cls === cls && t.method === method)) out.push({ kind: 'tool', at, hops });
    if (f.listeners.some((l) => l.cls === cls && l.method === method)) out.push({ kind: 'listener', at, hops });
    for (const name of asCalled(at)) {
      for (const e of f.callEdges.filter((x) => x.to === name)) {
        walk(e.from, [...hops, { label: e.how ? 'Runs inside' : 'Called by', file: e.file, line: e.line, quote: e.quote ?? method, rule: e.how ?? `${e.from}() calls ${name}()` }], depth + 1);
      }
    }
  };
  walk(start, [], 0);
  return out;
}

/** Browser calls that land on an endpoint, through the gateway when there is one. */
export function browserCalls(f: SpringFacts, ui: FrontendFacts, e: Endpoint): ApiCall[] {
  return ui.calls.filter((c) => {
    if (!c.verbs.includes(e.verb)) return false;
    const route = f.gateway.find((r) => c.tpl === r.prefix || c.tpl.startsWith(r.prefix + '/') || c.tpl.startsWith(r.prefix + '{'));
    if (f.gateway.length && (route ? route.service : f.gatewayService) !== e.service) return false;
    const internal = route ? '/' + c.tpl.split('/').filter(Boolean).slice(route.strip).join('/') : c.tpl;
    return templateHits(internal, e.path);
  });
}

/** The import chain from a screen's component to a file it runs, as hops. */
export function importChain(ui: FrontendFacts, from: string, to: string): Hop[] | null {
  if (from === to) return [];
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const f = queue.shift()!;
    for (const d of ui.components.get(f)?.deps ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      prev.set(d, f);
      if (d === to) {
        const hops: Hop[] = [];
        let cur = to;
        while (cur !== from) {
          const p = prev.get(cur)!;
          const comp = ui.components.get(p);
          const line = comp?.depLines[cur] ?? 1;
          hops.unshift({ label: 'Uses', file: comp?.depFiles?.[cur] ?? p, line, quote: '', rule: `${fileName(p)} uses ${fileName(cur)}` });
          cur = p;
        }
        return hops;
      }
      queue.push(d);
    }
  }
  return null;
}

export function screenTitle(comp: Component | undefined, route: string): string {
  const h = comp?.elements.find((e) => /^h[1-3]$/.test(e.tag) && e.text && !e.text.includes('{{'));
  return h?.text ?? route;
}

function describe(el: Component['elements'][number], comp: Component): string {
  const id = el.attrs['id'];
  const label = id ? comp.elements.find((x) => x.tag === 'label' && x.attrs['for'] === id)?.text : undefined;
  const text = el.text.replace(/\{\{.*?\}\}/g, '…').trim();
  if (/^(input|select|textarea)$/.test(el.tag)) return `field "${label ?? el.attrs['placeholder'] ?? el.attrs['name'] ?? Object.entries(el.attrs).find(([k]) => k.startsWith('v-model'))?.[1] ?? el.tag}"`;
  if (el.tag === 'button') return `button "${text || el.attrs['title'] || 'button'}"`;
  if (/^h[1-6]$/.test(el.tag)) return `heading "${text}"`;
  if (el.tag === 'router-link' || el.tag === 'a') return `link "${text}"`;
  if (/^(th|dt|label)$/.test(el.tag)) return `label "${text}"`;
  if (/^(td|dd)$/.test(el.tag)) return `value ${text}`;
  return `<${el.tag}>${text ? ` "${text.slice(0, 30)}"` : ''}`;
}

/** The dotted key of a YAML line: its own key and those of the lines it is nested under. */
export function yamlKey(lines: readonly string[], n: number): string | null {
  const own = /^(\s*)(?:-\s+)?([\w.\-"']+)\s*:/.exec(lines[n - 1] ?? '');
  if (!own) return null;
  const parts = [own[2]!.replace(/["']/g, '')];
  let indent = own[1]!.length;
  for (let i = n - 2; i >= 0 && indent > 0; i--) {
    const m = /^(\s*)([\w.\-"']+)\s*:/.exec(lines[i]!);
    if (!m || lines[i]!.trim().startsWith('#')) continue;
    if (m[1]!.length < indent) { parts.unshift(m[2]!.replace(/["']/g, '')); indent = m[1]!.length; }
  }
  return parts.join('.');
}

const camel = (k: string): string => k.replace(/[-_](\w)/g, (_m, c: string) => c.toUpperCase());

/** Methods that read a configuration key: @Value / ${…} placeholders, and @ConfigurationProperties accessors. */
/** The app's own @ConfigurationProperties class whose prefix holds the key, and whether a component binds it. */
function ownPrefix(f: SpringFacts, key: string): { type: string; prefix: string; file: string; line: number; bound: boolean } | null {
  for (const [file, jf] of f.javaFiles) for (const t of jf.types) {
    const cp = t.annotations.find((a) => a.name === 'ConfigurationProperties');
    if (!cp) continue;
    const prefix = (cp.args.map((x) => x.t).join('').match(/"([^"]+)"/)?.[1] ?? '').replace(/\.$/, '');
    if (!prefix || !key.startsWith(`${prefix}.`)) continue;
    const prop = camel(key.slice(prefix.length + 1).split('.')[0]!);
    return { type: simple(t.name), prefix, file, line: cp.line, bound: t.fields.some((x) => x.name === prop) };
  }
  return null;
}

function configReaders(f: SpringFacts, key: string): { at: string; file: string; line: number; quote: string; how: string }[] {
  const out: { at: string; file: string; line: number; quote: string; how: string }[] = [];
  const toks = (xs: readonly { t: string }[]): string => xs.map((x) => x.t).join('');
  const placeholder = (text: string): boolean => text.includes('${' + key + '}') || text.includes('${' + key + ':');
  const props: { type: string; accessor: string; file: string; line: number }[] = [];
  for (const [file, jf] of f.javaFiles) {
    for (const t of jf.types) {
      const cls = simple(t.name);
      // @ConfigurationProperties(prefix = "orderdesk"): orderdesk.page-size is pageSize()
      const cp = t.annotations.find((a) => a.name === 'ConfigurationProperties');
      if (cp) {
        const prefix = (toks(cp.args).match(/"([^"]+)"/)?.[1] ?? '').replace(/\.$/, '');
        if (prefix && key.startsWith(`${prefix}.`)) {
          const prop = camel(key.slice(prefix.length + 1).split('.')[0]!);
          const field = t.fields.find((x) => x.name === prop);
          if (field) props.push({ type: cls, accessor: t.kind === 'record' ? prop : `get${prop[0]!.toUpperCase()}${prop.slice(1)}`, file, line: field.line });
        }
      }
      for (const fl of t.fields) for (const a of fl.annotations) {
        if (!placeholder(toks(a.args))) continue;
        // a field set from the key: every method that uses the field reads it
        for (const m of t.methods) if (m.body.some((x) => x.t === fl.name)) out.push({ at: `${cls}.${m.name}`, file, line: a.line, quote: key.split('.').pop()!, how: `${cls}.${fl.name} is @${a.name}("\${${key}}"), used by ${m.name}()` });
      }
      for (const m of t.methods) {
        for (const a of m.annotations) if (placeholder(toks(a.args))) out.push({ at: `${cls}.${m.name}`, file, line: a.line, quote: key.split('.').pop()!, how: `@${a.name} on ${cls}.${m.name}() takes \${${key}}` });
        for (const pa of m.params) for (const a of pa.annotations) if (placeholder(toks(a.args))) for (const mm of t.methods) out.push({ at: `${cls}.${mm.name}`, file, line: a.line, quote: key.split('.').pop()!, how: `${cls} is built with \${${key}}` });
        // environment.getProperty("orderdesk.page-size")
        const lit = m.body.find((x) => x.t === `"${key}"`);
        if (lit) out.push({ at: `${cls}.${m.name}`, file, line: lit.line, quote: key, how: `${cls}.${m.name}() reads "${key}"` });
      }
    }
  }
  // a bean that exists only when the key says so: @ConditionalOnProperty(prefix = "orderdesk", name = "mail-enabled")
  for (const [file, jf] of f.javaFiles) for (const t of jf.types) {
    const conds = [...t.annotations.map((a) => ({ a, methods: t.methods })), ...t.methods.flatMap((m) => m.annotations.map((a) => ({ a, methods: [m] })))].filter(({ a }) => /^ConditionalOn(Property|Expression)$/.test(a.name));
    for (const { a, methods } of conds) {
      const text = toks(a.args);
      const strs = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      const prefix = (/prefix="([^"]*)"/.exec(text)?.[1] ?? '').replace(/\.$/, '');
      const names = a.name === 'ConditionalOnExpression' ? strs.flatMap((x) => [...x.matchAll(/\$\{([^}:]+)/g)].map((m) => m[1]!)) : strs.filter((x) => x !== prefix && !/^(true|false)$/.test(x)).map((x) => (prefix ? `${prefix}.${x}` : x));
      if (!names.some((n) => n === key || camel(n) === camel(key))) continue;
      for (const m of methods) out.push({ at: `${simple(t.name)}.${m.name}`, file, line: a.line, quote: a.name, how: `@${a.name} on ${simple(t.name)}: it exists only as ${key} says` });
    }
  }
  // who calls the accessor: a field or parameter of the properties type, then .pageSize()
  for (const p of props) {
    for (const [file, jf] of f.javaFiles) for (const t of jf.types) {
      const holders = new Set([...t.fields.filter((x) => simple(x.type) === p.type).map((x) => x.name), ...t.methods.flatMap((m) => m.params.filter((x) => simple(x.type) === p.type).map((x) => x.name))]);
      if (!holders.size) continue;
      for (const m of t.methods) {
        for (let i = 0; i + 2 < m.body.length; i++) {
          if (holders.has(m.body[i]!.t) && m.body[i + 1]!.t === '.' && m.body[i + 2]!.t === p.accessor) {
            out.push({ at: `${simple(t.name)}.${m.name}`, file, line: m.body[i + 2]!.line, quote: p.accessor, how: `${simple(t.name)}.${m.name}() reads ${p.type}.${p.accessor}(), bound from ${key}` });
            break;
          }
        }
      }
    }
  }
  return out;
}

interface MigrationOp { readonly file?: string; readonly kind: 'add-not-null' | 'add' | 'drop' | 'rename' | 'index' | 'unique' | 'retype' | 'seed' | 'other'; readonly table: string; readonly column: string; readonly line: number; readonly lines: readonly number[]; readonly quote: string; readonly text: string }

/** Column-level operations of a Liquibase XML changelog or a Flyway SQL script, with their lines. */
function migrationOps(path: string, text: string): MigrationOp[] {
  const out: MigrationOp[] = [];
  const lineOf = (i: number): number => text.slice(0, i).split('\n').length;
  const span = (a: number, b: number): number[] => { const s = lineOf(a), e = lineOf(b); return Array.from({ length: e - s + 1 }, (_x, k) => s + k); };
  if (/\.xml$/.test(path)) {
    for (const m of text.matchAll(/<addColumn\b[^>]*tableName="([^"]+)"[^>]*>([\s\S]*?)<\/addColumn>/g)) {
      for (const c of m[2]!.matchAll(/<column\b[^>]*name="([^"]+)"[^>]*?(\/>|>[\s\S]*?<\/column>)/g)) {
        const at = m.index! + m[0].indexOf(c[0]);
        const notNull = /nullable="false"/.test(c[0]);
        const dflt = /defaultValue\w*=/.test(c[0]);
        out.push({ kind: notNull && !dflt ? 'add-not-null' : 'add', table: m[1]!, column: c[1]!, line: lineOf(at), lines: span(m.index!, m.index! + m[0].length), quote: c[1]!, text: `adds ${c[1]}${notNull ? ' NOT NULL' : ''}${notNull && !dflt ? ' with no default' : ''}` });
      }
    }
    for (const m of text.matchAll(/<dropColumn\b[^>]*tableName="([^"]+)"[^>]*columnName="([^"]+)"[^>]*\/?>/g)) out.push({ kind: 'drop', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `drops ${m[2]}` });
    for (const m of text.matchAll(/<renameColumn\b[^>]*tableName="([^"]+)"[^>]*oldColumnName="([^"]+)"[^>]*newColumnName="([^"]+)"[^>]*\/?>/g)) out.push({ kind: 'rename', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `renames ${m[2]} to ${m[3]}` });
    for (const m of text.matchAll(/<createIndex\b([^>]*)>([\s\S]*?)<\/createIndex>/g)) {
      const table = /tableName="([^"]+)"/.exec(m[1]!)?.[1]; if (!table) continue;
      const cols = [...m[2]!.matchAll(/<column\b[^>]*name="([^"]+)"/g)].map((c) => c[1]!);
      const unique = /unique="true"/.test(m[1]!);
      out.push({ kind: unique ? 'unique' : 'index', table, column: cols[0] ?? '*', line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: table, text: `${unique ? 'adds a unique index' : 'adds an index'} on ${cols.join(', ')}` });
    }
    for (const m of text.matchAll(/<dropIndex\b[^>]*tableName="([^"]+)"[^>]*\/?>/g)) out.push({ kind: 'index', table: m[1]!, column: '*', line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[1]!, text: 'drops an index' });
    for (const m of text.matchAll(/<addUniqueConstraint\b[^>]*tableName="([^"]+)"[^>]*columnNames="([^"]+)"[^>]*\/?>/g)) out.push({ kind: 'unique', table: m[1]!, column: m[2]!.split(',')[0]!.trim(), line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[1]!, text: `makes ${m[2]} unique` });
    for (const m of text.matchAll(/<modifyDataType\b[^>]*tableName="([^"]+)"[^>]*columnName="([^"]+)"[^>]*newDataType="([^"]+)"[^>]*\/?>/g)) out.push({ kind: 'retype', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `changes ${m[2]} to ${m[3]}` });
    for (const m of text.matchAll(/<(loadData|loadUpdateData)\b([^>]*?)(\/>|>[\s\S]*?<\/\1>)/g)) {
      const table = /tableName="([^"]+)"/.exec(m[2]!)?.[1]; if (!table) continue;
      out.push({ kind: 'seed', table, column: '*', line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: table, text: `loads rows from ${/file="([^"]+)"/.exec(m[2]!)?.[1] ?? 'a file'}` });
    }
    for (const m of text.matchAll(/<(insert|update|delete)\b[^>]*tableName="([^"]+)"[^>]*(\/>|>[\s\S]*?<\/\1>)/g)) out.push({ kind: 'seed', table: m[2]!, column: '*', line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `${m[1]}s rows` });
  } else if (/\.sql$/.test(path)) {
    for (const m of text.matchAll(/create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+["`]?(\w+)["`]?\s*\(([^)]*)\)[^;]*;/gi)) out.push({ kind: m[1] ? 'unique' : 'index', table: m[2]!, column: m[3]!.split(',')[0]!.trim().replace(/["`]/g, ''), line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `${m[1] ? 'adds a unique index' : 'adds an index'} on ${m[3]!.trim()}` });
    for (const m of text.matchAll(/alter\s+table\s+["`]?(\w+)["`]?\s+(?:alter|modify)\s+(?:column\s+)?["`]?(\w+)["`]?\s+(?:set\s+data\s+)?(?:type\s+)?([^;]*);/gi)) if (!/^(set|drop)\s+(default|not\s+null)/i.test(m[3]!.trim())) out.push({ kind: 'retype', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `changes ${m[2]} to ${m[3]!.trim()}` });
    for (const m of text.matchAll(/(insert\s+into|update|delete\s+from)\s+["`]?(\w+)["`]?[^;]*;/gi)) out.push({ kind: 'seed', table: m[2]!, column: '*', line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `${m[1]!.split(/\s+/)[0]!.toLowerCase()}s rows` });
    for (const m of text.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?["`]?(\w+)["`]?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?["`]?(\w+)["`]?([^;]*);/gi)) {
      const notNull = /not\s+null/i.test(m[3]!), dflt = /default/i.test(m[3]!);
      out.push({ kind: notNull && !dflt ? 'add-not-null' : 'add', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `adds ${m[2]}${notNull ? ' NOT NULL' : ''}${notNull && !dflt ? ' with no default' : ''}` });
    }
    for (const m of text.matchAll(/alter\s+table\s+["`]?(\w+)["`]?\s+drop\s+(?:column\s+)?(?:if\s+exists\s+)?["`]?(\w+)["`]?[^;]*;/gi)) out.push({ kind: 'drop', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `drops ${m[2]}` });
    for (const m of text.matchAll(/alter\s+table\s+["`]?(\w+)["`]?\s+rename\s+column\s+["`]?(\w+)["`]?\s+to\s+["`]?(\w+)["`]?[^;]*;/gi)) out.push({ kind: 'rename', table: m[1]!, column: m[2]!, line: lineOf(m.index!), lines: span(m.index!, m.index! + m[0].length), quote: m[2]!, text: `renames ${m[2]} to ${m[3]}` });
  }
  // an element can span lines: cite the line its quoted word is on, so the citation re-checks
  const lines = text.split('\n');
  return out.map((o) => {
    if ((lines[o.line - 1] ?? '').includes(o.quote)) return o;
    const at = o.lines.find((n) => (lines[n - 1] ?? '').includes(o.quote));
    return at ? { ...o, line: at } : o;
  });
}

const idsOf = (t: string): string[] => (t.match(/[A-Za-z_$][\w$]*/g) ?? []).map((x) => x.split('.').pop()!);
const ids = idsOf;
const words = (n: string): string => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** Does an endpoint's method (or what it calls, two levels down) save this entity through its repository? */
function savesEntity(f: SpringFacts, e: Endpoint, entity: string): boolean {
  const repos = new Set<string>();
  for (const jf of f.javaFiles.values()) for (const t of jf.types) if (t.kind === 'interface' && t.supertypes.some((s) => new RegExp(`<\\s*${entity}\\s*,`).test(s))) repos.add(simple(t.name));
  if (!repos.size) return false;
  const seen = new Set<string>();
  const visit = (at: string, depth: number): boolean => {
    if (seen.has(at) || depth > 3) return false;
    seen.add(at);
    const [cls, method] = at.split('.') as [string, string];
    for (const jf of f.javaFiles.values()) for (const t of jf.types) {
      if (simple(t.name) !== cls) continue;
      const repoFields = new Set(t.fields.filter((x) => repos.has(simple(x.type))).map((x) => x.name));
      for (const m of t.methods.filter((x) => x.name === method)) {
        for (let i = 0; i + 2 < m.body.length; i++) if (repoFields.has(m.body[i]!.t) && m.body[i + 1]!.t === '.' && /^save/.test(m.body[i + 2]!.t)) return true;
      }
    }
    return f.callEdges.filter((x) => x.from === at).some((x) => visit(x.to, depth + 1));
  };
  return visit(`${e.cls}.${e.method}`, 0);
}

/**
 * Entities whose rows bring this one along: an eager @ManyToOne or @OneToOne (JPA's default) joins it into
 * every query, and a collection Jackson writes loads it. Order → Customer, OrderItem → Product.
 */
function holders(f: SpringFacts, entity: string, written: boolean): Set<string> {
  const names = new Set(f.entities.map((e) => e.name));
  const edges: [string, string][] = [];
  for (const en of f.entities) {
    const t = f.javaFiles.get(en.file)?.types.find((x) => simple(x.name) === en.name);
    for (const fl of t?.fields ?? []) {
      const target = (fl.type.match(/[A-Z]\w*/g) ?? []).find((x) => names.has(x) && x !== en.name);
      if (!target) continue;
      const rel = fl.annotations.find((a) => /^(ManyToOne|OneToOne|OneToMany|ManyToMany|ElementCollection)$/.test(a.name));
      if (!rel) continue;
      const text = rel.args.map((x) => x.t).join(' ');
      const lazy = /^(OneToMany|ManyToMany|ElementCollection)$/.test(rel.name) ? !/\bEAGER\b/.test(text) : /\bLAZY\b/.test(text);
      // a lazy relation loads only when something reads it: Jackson, when the entity is what the API returns
      if (!lazy || (written && !fl.annotations.some((a) => a.name === 'JsonIgnore'))) edges.push([en.name, target]);
    }
  }
  const out = new Set([entity]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [from, to] of edges) if (out.has(to) && !out.has(from)) { out.add(from); grew = true; }
  }
  return out;
}

/** Does an endpoint load rows of this entity: it returns or takes it, or its code (or what it calls) uses it or its repository, directly or through an entity that brings it along? */
function loadsEntity(f: SpringFacts, e: Endpoint, entity: string): string | null {
  for (const n of holders(f, entity, true)) if (ids(e.returns).includes(n) || (!!e.body && ids(e.body.type).includes(n))) return n;
  // code that names an entity loads it and what it joins eagerly; a lazy collection it walks names the element type
  const via = holders(f, entity, false);
  const repos = new Map<string, string>();
  for (const jf of f.javaFiles.values()) for (const t of jf.types) if (t.kind === 'interface') for (const n of via) if (t.supertypes.some((s) => new RegExp(`<\\s*${n}\\s*,`).test(s))) repos.set(simple(t.name), n);
  const seen = new Set<string>();
  const visit = (at: string, depth: number): string | null => {
    if (seen.has(at) || depth > 4) return null;
    seen.add(at);
    const [cls, method] = at.split('.') as [string, string];
    for (const jf of f.javaFiles.values()) for (const t of jf.types) {
      if (simple(t.name) !== cls) continue;
      const repoFields = new Map(t.fields.filter((x) => repos.has(simple(x.type))).map((x) => [x.name, repos.get(simple(x.type))!]));
      for (const m of t.methods.filter((x) => x.name === method)) for (const tok of m.body) {
        if (via.has(tok.t)) return tok.t;
        if (repoFields.has(tok.t)) return repoFields.get(tok.t)!;
      }
    }
    for (const x of f.callEdges.filter((y) => y.from === at)) { const r = visit(x.to, depth + 1); if (r) return r; }
    return null;
  };
  return visit(`${e.cls}.${e.method}`, 0);
}

export function followChanges(ctx: WhereCtx): void {
  const { fh, fb, ui, ub, H, B } = ctx;
  const allScreens = (u: FrontendFacts): readonly Route[] => u.routes;

  /* ---------- what reaches an endpoint: screens, the chat, other services ---------- */
  const consumers = (e: Endpoint, chain: Hop[], deltaId: string, why: string, depth = 0): number => {
    let n = 0;
    const exp = exposedAs(fh, e);
    const ext = exp ? exp.path : e.path;
    const apiHop: Hop = { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} in ${e.service ?? 'the app'}` };
    const gwHop: Hop[] = exp ? [{ label: 'Gateway', file: exp.route.file, line: exp.route.line, quote: `Path=${exp.route.prefix}`, rule: `exposed as ${e.verb} ${ext}` }] : [];
    const aid = `api:${e.verb} ${ext}`;
    ctx.surface({ id: aid, kind: 'api', name: `${e.verb} ${ext}`, where: `${e.service ?? ''} ${e.verb} ${e.path}`.trim(), tier: 'test-next' });
    ctx.addCase({ surface: aid, delta: deltaId, tier: 'test-next', do: `Call ${e.verb} ${ext} the way its screens do and compare with the last release.`, expect: `Same result unless the change means otherwise: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: [...chain, apiHop, ...gwHop] });
    ctx.touched.add(e);
    n++;
    for (const c of browserCalls(fh, ui, e)) {
      const callHop: Hop = { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}${c.baseAssumed ? ' (its base URL is taken as the server root)' : ''}` };
      const global = ui.globals.find((g) => callMadeBy(ui, ctx.closure(g.file), c));
      if (global) {
        const sid = `widget:${global.tag}`;
        ctx.surface({ id: sid, kind: 'widget', name: global.tag.replace(/^[a-z]+-/, (m) => (/^(app|jhi|ng|v)-$/.test(m) ? '' : m)).replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), where: `every screen · <${global.tag}>`, tier: 'test-next' });
        ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-next', do: `Use <${global.tag}> for what calls ${e.verb} ${ext}.`, expect: `Works as before: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: [...chain, apiHop, ...gwHop, callHop, { label: 'On every screen', file: global.root, line: global.line, quote: global.quote ?? `<${global.tag}`, rule: `<${global.tag}> is ${global.how ?? 'drawn beside <router-view>'}` }] });
        n++;
      }
      for (const r of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
        const comp = ui.components.get(r.component);
        const sid = `screen:${r.path}`;
        const title = screenTitle(comp, r.path);
        ctx.surface({ id: sid, kind: 'screen', name: title, where: r.path, tier: 'test-next' });
        const write = e.verb !== 'GET';
        const chainUi = importChain(ui, r.component, c.file) ?? [];
        ctx.addCase({
          surface: sid, delta: deltaId, tier: 'test-next',
          do: write ? `On ${title}, do what sends ${e.verb} ${c.tpl} and check it is saved as before.` : `Open ${title} and check what it shows from ${c.tpl}.`,
          expect: `Works as before: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived',
          hops: [...chain, apiHop, ...gwHop, callHop, ...chainUi, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }],
        });
        n++;
      }
    }
    if (depth < 2) {
      // another service calls this endpoint: what reaches that call reaches this change
      for (const jc of fh.calls.filter((x) => x.service === e.service && x.verb === e.verb && templateHits(x.tpl, e.path))) {
        const hop: Hop = { label: 'Another service calls it', file: jc.file, line: jc.line, quote: jc.how.startsWith('@FeignClient') ? 'Mapping' : 'uri', rule: `${jc.cls}.${jc.method}() · ${jc.how}` };
        for (const r of reachFrom(fh, `${jc.cls}.${jc.method}`)) n += entry(r, [...chain, apiHop, hop, ...r.hops], deltaId, why, depth + 1);
      }
    }
    return n;
  };

  const entry = (r: Reach, chain: Hop[], deltaId: string, why: string, depth = 0): number => {
    const [cls, method] = r.at.split('.') as [string, string];
    if (r.kind === 'endpoint') {
      let n = 0;
      for (const e of fh.endpoints.filter((x) => x.cls === cls && x.method === method)) n += consumers(e, chain, deltaId, why, depth);
      return n;
    }
    if (r.kind === 'listener') {
      const lh = fh.listeners.find((x) => x.cls === cls && x.method === method);
      // reached through code the PR removed, and gone at head too: the job no longer runs at all
      if (!lh) {
        const lb = fb.listeners.find((x) => x.cls === cls && x.method === method);
        if (!lb) return 0;
        const sid = `job:${cls}.${method}`;
        ctx.surface({ id: sid, kind: 'job', name: `${cls}.${method}() ${lb.kind} (removed)`, where: lb.file, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-first', do: `Check that nothing relied on ${cls}.${method}(): it ran ${lb.kind} before this change.`, expect: `It no longer runs; what it did (${why}) is done elsewhere or no longer needed.`, before: 'Ran.', after: 'Gone.', proof: 'derived', hops: [...chain, { label: 'Job removed', file: lb.file, line: lb.line, quote: lb.kind.replace('@', ''), side: 'base', rule: `${cls}.${method}() ${lb.kind} existed at base` }] });
        return 1;
      }
      const l = lh;
      const sid = `job:${cls}.${method}`;
      ctx.surface({ id: sid, kind: 'job', name: `${cls}.${method}() ${l.kind}`, where: l.file, tier: 'test-next' });
      ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-next', do: `Let ${cls}.${method}() run (or trigger it) and check what it does.`, expect: `Same effect unless the change means otherwise: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: [...chain, { label: 'Job', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${cls}.${method}() ${l.kind}` }] });
      return 1;
    }
    // an AI tool: the chat that is given it
    let n = 0;
    const tool = fh.tools.find((t) => t.cls === cls && t.method === method);
    // a tool reached through removed code and gone at head: the chats that had it are found from the base below, if anywhere
    if (!tool) return 0;
    const toolHop: Hop = { label: 'Exposed to an AI model', file: tool.file, line: tool.line, quote: tool.mark, rule: `${cls}.${method}() is a tool the model can call` };
    for (const w of fh.wiring.filter((x) => x.toolsClass === cls)) {
      const wire: Hop = { label: 'Wired into the chat', file: w.file, line: w.line, quote: w.expr.split('(')[0]!.replace('.', ''), rule: `${w.holder}${w.expr}` };
      for (const e of fh.endpoints.filter((x) => x.cls === w.holder)) n += consumers(e, [...chain, toolHop, wire], deltaId, why, depth + 1);
    }
    return n;
  };

  /* ---------- Java: changed methods and types ---------- */
  const isConfig = (t: JType): boolean => t.annotations.some((a) => /^(Configuration|SpringBootApplication|EnableWebSecurity|ControllerAdvice|RestControllerAdvice|EnableMethodSecurity|EnableScheduling|EnableAsync|EnableCaching|ConfigurationProperties)$/.test(a.name)) || t.supertypes.some((x) => /(Filter|WebMvcConfigurer|HandlerInterceptor|SecurityConfigurer)$/.test(x));
  const isBean = (t: JType): boolean => t.annotations.some((a) => /^(Service|Component|Repository|RestController|Controller|Configuration|SpringBootApplication)$/.test(a.name));
  const isAccessor = (m: JMethod): boolean => /^(get|set|is)[A-Z]\w*$|^(equals|hashCode|toString)$/.test(m.name);
  /** Every changed line of a security filter chain is a path rule: `.requestMatchers("/api/reports/**").hasRole(…)`. */
  const MATCHER = /\.\s*(requestMatchers|antMatchers|mvcMatchers|pathMatchers|regexMatchers)\s*\(([^)]*)\)/;
  const securityScope = (g: { method: JMethod | null; lines: number[]; baseLines: number[] }): { patterns: string[]; verbs?: string[]; line: number; word: string; side?: 'base' } | null => {
    if (!g.method || !/SecurityFilterChain|SecurityWebFilterChain/.test(g.method.returnType)) return null;
    const lines = [...g.lines.map((n) => ({ n, text: H.line(fileOfGroup, n) ?? '', side: undefined as 'base' | undefined })), ...g.baseLines.map((n) => ({ n, text: B.line(fileOfGroup, n) ?? '', side: 'base' as const }))];
    if (!lines.length) return null;
    // CSRF protection only checks requests that change state
    if (lines.every((l) => /\.\s*csrf\s*\(/.test(l.text))) return { patterns: ['/**'], verbs: ['POST', 'PUT', 'PATCH', 'DELETE'], line: lines[0]!.n, word: 'csrf', ...(lines[0]!.side ? { side: lines[0]!.side } : {}) };
    const patterns: string[] = [];
    for (const l of lines) {
      const m = MATCHER.exec(l.text);
      const lits = m ? [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
      if (!m || !lits.length || m[1] === 'regexMatchers') return null;
      patterns.push(...lits);
    }
    const first = lines[0]!;
    return { patterns: [...new Set(patterns)], line: first.n, word: MATCHER.exec(first.text)![1]!, ...(first.side ? { side: first.side } : {}) };
  };
  let fileOfGroup = '';

  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java') continue;
    fileOfGroup = cf.path;
    // the same Java token for token: only comments or layout changed, and it compiles to the same code
    if (cf.status === 'modified' && /\.java$/.test(cf.path) && sameTokens(B.read(cf.path) ?? '', H.read(cf.path) ?? '')) {
      for (const n of cf.headLines) ctx.follow(cf.path, n);
      for (const n of cf.baseLines) ctx.follow(cf.path, n, 'base');
      ctx.noEffect(cf.path, 'only comments or layout changed: the code is the same, token for token');
      continue;
    }
    const jh = fh.javaFiles.get(cf.path);
    const jbf = fb.javaFiles.get(cf.path);
    interface Group { type: JType; method: JMethod | null; lines: number[]; baseLines: number[]; gone: boolean }
    const groups = new Map<string, Group>();
    const add = (types: readonly JType[] | undefined, line: number, base: boolean): void => {
      if (!types) return;
      const loc = locate(types, line);
      if (!loc) return;
      let { type, method } = loc;
      let gone = false;
      // a method changed at base is the same method at head when it still exists
      if (base) {
        const ht = jh?.types.find((t) => t.name === type.name);
        const hm = method && ht ? ht.methods.find((m) => m.name === method!.name) : undefined;
        if (ht && (!method || hm)) { type = ht; method = hm ?? null; } else gone = true;
      }
      const key = `${gone ? 'base:' : ''}${type.name}#${method?.name ?? ''}`;
      if (!groups.has(key)) groups.set(key, { type, method, lines: [], baseLines: [], gone });
      (base ? groups.get(key)!.baseLines : groups.get(key)!.lines).push(line);
    };
    for (const n of cf.headLines) {
      if (ctx.explained(cf.path, n) || trivial((H.line(cf.path, n) ?? '').trim())) continue;
      add(jh?.types, n, false);
    }
    // a removed line counts only when what replaced it is not already explained
    for (const h of cf.hunks) {
      const replacedBy = h.head.filter((n) => !trivial((H.line(cf.path, n) ?? '').trim()));
      if (replacedBy.length && replacedBy.every((n) => ctx.explained(cf.path, n))) continue;
      for (const n of h.base) {
        if (trivial((B.line(cf.path, n) ?? '').trim())) continue;
        add(jbf?.types, n, true);
      }
    }
    // a method whose tokens, signature and annotations are the same on both sides changed only in comments or
    // layout: it compiles to the same code and runs as before
    const sig = (m: JMethod): string => [m.returnType, ...m.annotations.map((a) => `@${a.name}(${a.args.map((x) => x.t).join(' ')})`), ...m.params.map((v) => `${v.annotations.map((a) => `@${a.name}(${a.args.map((x) => x.t).join(' ')})`).join(' ')} ${v.type} ${v.name}`), '{', ...m.body.map((x) => x.t)].join('\u0001');
    const sameCode = (g: Group): boolean => {
      if (g.gone || !g.method) return false;
      const bt = jbf?.types.find((t) => t.name === g.type.name);
      const bm = bt?.methods.filter((m) => m.name === g.method!.name && m.params.length === g.method!.params.length) ?? [];
      const hm = g.type.methods.filter((m) => m.name === g.method!.name && m.params.length === g.method!.params.length);
      return bm.length === 1 && hm.length === 1 && sig(bm[0]!) === sig(g.method);
    };
    const quiet = [...groups.values()].filter(sameCode);
    for (const g of quiet) {
      for (const n of g.lines) ctx.follow(cf.path, n);
      for (const n of g.baseLines) ctx.follow(cf.path, n, 'base');
      groups.delete([...groups].find(([, v]) => v === g)![0]);
    }
    if (quiet.length && !groups.size) { ctx.noEffect(cf.path, `only comments or layout changed in ${[...new Set(quiet.map((g) => `${simple(g.type.name)}.${g.method!.name}()`))].join(', ')}: the code is the same, token for token`); continue; }
    for (const g of groups.values()) {
      const cls = simple(g.type.name);
      const S0 = g.gone ? B : H;
      const at = (g.gone ? g.baseLines[0] : g.lines[0]) ?? g.method?.line ?? g.type.line;
      const atText = S0.line(cf.path, at);
      const changed: Hop = {
        label: g.gone ? 'Removed' : 'Changed', file: cf.path, line: at, quote: snippet(atText),
        rule: g.method ? `${cls}.${g.method.name}() ${g.gone ? 'was removed' : 'changed'}` : `${cls} ${g.gone ? 'was removed' : 'changed outside any method'}`,
        ...(g.gone ? { side: 'base' as const } : {}),
      };
      const id = `code:${g.gone ? 'removed:' : ''}${cls}${g.method ? `.${g.method.name}` : ''}`;
      const why = `${g.method ? `${cls}.${g.method.name}()` : cls} ${g.gone ? 'was removed' : 'changed'} (${fileName(cf.path)}:${at})`;
      let reached = 0;
      const starts: { at: string; lead: Hop[] }[] = [];
      const module = (g.gone ? fb : fh).moduleOf(cf.path);
      const outerType = g.type.name.includes('.') ? (g.gone ? jbf : jh)?.types.find((t) => t.name === g.type.name.split('.')[0]) : undefined;
      const wide = isConfig(g.type) || (!!outerType && isConfig(outerType) && !g.type.annotations.length && (g.type.kind !== 'record' || outerType.annotations.some((a) => a.name === 'ConfigurationProperties'))) || (g.method?.annotations.some((a) => a.name === 'Bean') ?? false);
      const bean = isBean(g.type);
      const ctor = !!g.method && g.method.name === cls;
      // data types (DTOs, records, entities, their builders) travel to where the type is used
      let dataType = !bean && (!g.method || ctor || isAccessor(g.method) || g.type.name.includes('.'));
      // an aspect runs around the methods its pointcuts name: follow those methods as if they changed
      const advised = !g.gone && g.type.annotations.some((a) => a.name === 'Aspect') ? pointcutTargets(fh, g.type) : null;
      if (advised && advised.length) {
        const note: Hop = { label: 'Runs around them', file: cf.path, line: g.type.annotations.find((a) => a.name === 'Aspect')!.line, quote: 'Aspect', rule: `${cls} is an @Aspect around ${advised.length} methods (${advised.slice(0, 3).join(', ')}${advised.length > 3 ? ', …' : ''})` };
        for (const at0 of advised) for (const r of reachFrom(fh, at0)) reached += entry(r, [changed, note, ...r.hops], id, why);
      } else if (wide && securityScope(g)) {
        // a security rule for some paths: the endpoints those paths match, and no other
        const sc = securityScope(g)!;
        const note: Hop = { label: 'Applies to', file: cf.path, line: sc.line, quote: sc.word, rule: sc.verbs ? `CSRF checks only ${sc.verbs.join(', ')} requests` : `this rule matches ${sc.patterns.join(', ')}`, ...(sc.side === 'base' ? { side: 'base' as const } : {}) };
        for (const e of fh.endpoints.filter((x) => x.module === module && (!sc.verbs || sc.verbs.includes(x.verb)) && sc.patterns.some((p) => antMatch(p, x.path)))) reached += consumers(e, [changed, note], id, why);
      } else if (wide) {
        // configuration and beans: every request of the service goes through them
        const note: Hop = { label: 'Applies to the whole service', file: cf.path, line: g.type.line, quote: simple(g.type.name), rule: `${cls} configures ${fh.serviceOf(cf.path) ?? 'the service'}${g.method ? `: ${g.method.name}() is a @Bean` : ''}`, ...(g.gone ? { side: 'base' as const } : {}) };
        for (const e of fh.endpoints.filter((x) => x.module === module)) reached += consumers(e, [changed, note], id, why);
      } else if (bean && (ctor || !g.method)) {
        // a changed field (a constant, a setting) reaches the methods that use it; anything else at class level, every method
        const fieldLines = (g.gone ? g.baseLines : g.lines);
        const fields = g.type.fields.filter((fl) => fieldLines.some((n) => n === fl.line || (n > fl.line && n <= fl.line + 2 && !g.type.methods.some((m) => m.line <= n && n <= m.endLine))));
        const onlyFields = !ctor && fields.length && fieldLines.every((n) => fields.some((fl) => n >= fl.line && n <= fl.line + 2) || /^\s*@/.test((g.gone ? B : H).line(cf.path, n) ?? ''));
        const users = onlyFields ? g.type.methods.filter((m) => m.name !== cls && m.body.some((x) => fields.some((fl) => fl.name === x.t))) : [];
        if (onlyFields && users.length) {
          // cite the token itself: its line and its text, read where the method is
          for (const m of users) { const tok = m.body.find((x) => fields.some((fl) => fl.name === x.t))!; starts.push({ at: `${cls}.${m.name}`, lead: [{ label: 'Uses it', file: cf.path, line: tok.line, quote: tok.t, rule: `${cls}.${m.name}() uses ${tok.t}`, ...(g.gone ? { side: 'base' as const } : {}) }] }); }
        } else for (const m of g.type.methods) if (m.name !== cls) starts.push({ at: `${cls}.${m.name}`, lead: [] });
      } else if (g.method && !dataType) {
        starts.push({ at: `${cls}.${g.method.name}`, lead: [] });
      }
      for (const st of starts) {
        // a removed method is found from the callers it had at base
        if (g.gone) {
          for (const r of reachFrom(fb, st.at)) reached += removedEntry(r, [changed, ...st.lead, ...r.hops.map((h) => ({ ...h, side: 'base' as const }))], id, why);
        } else {
          for (const r of reachFrom(fh, st.at)) reached += entry(r, [changed, ...st.lead, ...r.hops], id, why);
        }
      }
      // a data type, or a method of a plain class nobody calls directly: where the type is used
      if (!g.gone && !wide && !bean && (dataType || !reached)) {
        reached += followType(cls, g.type.name, [changed], id, why, starts);
        if (!reached && g.type.name.includes('.')) {
          const outer = g.type.name.split('.')[0]!;
          reached += followType(outer, outer, [changed, { label: 'Part of', file: cf.path, line: g.type.line, quote: simple(g.type.name), rule: `${g.type.name} is declared inside ${outer}` }], id, why, starts);
        }
        const late = starts.splice(0);
        // an accessor is also read by Java code: o.getCustomer().getName() in a service that builds another answer
        if (g.method && !ctor && isAccessor(g.method)) late.push({ at: `${cls}.${g.method.name}`, lead: [] });
        for (const st of late) for (const r of reachFrom(fh, st.at)) reached += entry(r, [changed, ...st.lead, ...r.hops], id, why);
        dataType = true;
      }
      if (reached) {
        for (const n of g.lines) ctx.follow(cf.path, n);
        for (const n of g.baseLines) ctx.follow(cf.path, n, 'base');
        ctx.deltas.push({ id, kind: 'code-changed', title: why, endpoint: '', rules: [], causes: [changed] });
      } else if (!g.gone && g.lines.length && cf.hunks.every((h) => h.base.every((n) => trivial((B.line(cf.path, n) ?? '').trim()))) && g.lines.every((n) => newConstantUnused(cf.path, n))) {
        // only new constants that no file names: nothing reads them yet
        for (const n of g.lines) ctx.follow(cf.path, n);
        ctx.noEffect(cf.path, 'only new constants that nothing in this repository uses yet');
      } else if (cf.status === 'added' && !g.gone && unused(cls, cf.path, g.type)) {
        // a new class no other file names, with nothing the framework starts on its own: nothing runs it yet
        for (const n of g.lines) ctx.follow(cf.path, n);
        ctx.deltas.push({ id, kind: 'code-changed', title: `${cls} added; nothing uses it yet`, endpoint: '', rules: [], causes: [changed] });
      } else {
        ctx.unseen.push({ what: `${g.gone ? 'removed' : 'changed'} code in ${g.method ? `${cls}.${g.method.name}()` : cls} (${fileName(cf.path)}:${at})`, why: 'it reaches no API, job, AI tool or screen this build can see: it may be called through reflection, events, an unresolved interface, or only from tests', resolve: 'ask the developer where it runs', files: [cf.path] });
      }
    }
  }

  /** A line that declares a constant (static final) whose name appears nowhere else. */
  function newConstantUnused(path: string, n: number): boolean {
    const text = (H.line(path, n) ?? '').trim();
    if (trivial(text)) return true;
    const m = /^(?:(?:public|private|protected)\s+)?static\s+final\s+[\w<>,.?[\]\s]+?\s+(\w+)\s*=.*;\s*$/.exec(text);
    if (!m) return false;
    const word = new RegExp(`\\b${m[1]}\\b`, 'g');
    if (((H.read(path) ?? '').match(word) ?? []).length !== 1) return false;
    return !H.files.some((f) => f !== path && /\.(java|kt|groovy|ya?ml|properties|xml|[jt]sx?|vue)$/.test(f) && new RegExp(`\\b${m[1]}\\b`).test(H.read(f) ?? ''));
  }

  /** A class no other Java or front-end file names, with no annotation the framework acts on (a bean, an endpoint, a listener, an entity). */
  function unused(cls: string, path: string, t: JType): boolean {
    if (t.annotations.length || t.methods.some((m) => m.annotations.some((a) => !/^(Override|Deprecated|SuppressWarnings|Nullable|NonNull)$/.test(a.name))) || t.supertypes.length) return false;
    const word = new RegExp(`\\b${cls}\\b`);
    for (const f of H.files) {
      if (f === path || !/\.(java|kt|groovy|xml|ya?ml|properties|factories|imports)$/.test(f)) continue;
      if (word.test(H.read(f) ?? '')) return false;
    }
    return true;
  }

  /** Who uses a type: endpoints that take or return it (or a type that holds it), and methods that do. */
  function followType(cls: string, fullName: string, lead: Hop[], id: string, why: string, starts: { at: string; lead: Hop[] }[]): number {
    let reached = 0;
    const declared = [...fh.javaFiles.values()].flatMap((jf) => jf.types).find((t) => t.name === fullName);
    const controller = declared?.annotations.some((a) => /^(RestController|Controller)$/.test(a.name)) ?? false;
    // a type held by another type travels inside it: Operation.bankAccount is a BankAccount. A field that never
    // leaves in the JSON (@JsonIgnore, transient, static) carries nothing, and a field-level
    // @JsonIgnoreProperties({"bankAccount"}) cuts the path through it.
    const holdersHops = new Map<string, Hop[]>([[cls, []]]);
    const via = new Map<string, string | null>([[cls, null]]);
    for (let round = 0; round < 3; round++) {
      for (const [, jf] of fh.javaFiles) for (const t of jf.types) {
        const tn = simple(t.name);
        if (holdersHops.has(tn)) continue;
        const classIgnore = new Set(t.annotations.filter((a) => a.name === 'JsonIgnoreProperties').flatMap((a) => annStrings(a)));
        for (const fl of t.fields) {
          if (fl.mods?.includes('static') || fl.mods?.includes('transient')) continue;
          const ji = fl.annotations.find((a) => a.name === 'JsonIgnore');
          if (ji && !/false/.test(ji.args.map((x) => x.t).join(''))) continue;
          const jp = fl.annotations.find((a) => a.name === 'JsonProperty');
          const json = (jp && annStrings(jp)[0]) || fl.name;
          if (classIgnore.has(json)) continue;
          const held = [...holdersHops.keys()].find((h) => new RegExp(`\\b${h}\\b`).test(fl.type));
          if (!held) continue;
          const cut = new Set(fl.annotations.filter((a) => a.name === 'JsonIgnoreProperties').flatMap((a) => annStrings(a)));
          const next = via.get(held);
          if (next && cut.has(next)) continue;
          holdersHops.set(tn, [...holdersHops.get(held)!, { label: 'Held by', file: jf.path, line: fl.line, quote: fl.name, rule: `${tn}.${fl.name} is ${fl.type}` }]);
          via.set(tn, json);
          break;
        }
      }
    }
    const holders = holdersHops;
    const usesType = (text: string): string | undefined => [...holders.keys()].find((h) => new RegExp(`\\b${h}\\b`).test(text));
    // an interface or base class: what implements it runs its contract
    if (declared && (declared.kind === 'interface' || declared.annotations.length === 0)) {
      for (const [, jf] of fh.javaFiles) for (const t of jf.types) {
        if (!t.supertypes.some((x) => simple(x).replace(/<.*$/, '') === cls)) continue;
        for (const m of t.methods) starts.push({ at: `${simple(t.name)}.${m.name}`, lead: [{ label: 'Implemented by', file: jf.path, line: t.line, quote: simple(t.name), rule: `${simple(t.name)} implements ${cls}` }] });
      }
    }
    const eps = controller ? fh.endpoints.filter((e) => e.cls === cls) : fh.endpoints.filter((e) => usesType(e.returns) || usesType(e.body?.type ?? ''));
    for (const e of eps) {
      const held = !controller ? usesType(`${e.returns} ${e.body?.type ?? ''}`)! : undefined;
      const use: Hop[] = held ? [...holders.get(held)!, { label: 'Uses the type', file: e.file, line: e.methodLine, quote: e.method, rule: `${e.cls}.${e.method}() ${usesType(e.body?.type ?? '') ? 'takes' : 'returns'} ${held}` }] : [];
      reached += consumers(e, [...lead, ...use], id, why);
    }
    // methods elsewhere that take or return the type, and whatever calls them
    if (!controller) {
      for (const [, jf] of fh.javaFiles) for (const t of jf.types) for (const m of t.methods) {
        if (t.name === fullName) continue;
        let held = usesType(`${m.returnType} ${m.params.map((p) => p.type).join(' ')}`);
        // an enum is decided on inside methods (status != CANCELLED, switch): a new or removed value changes them
        if (!held && declared?.kind === 'enum' && m.body.some((x) => x.t === cls)) {
          const at = m.body.find((x) => x.t === cls)!;
          starts.push({ at: `${simple(t.name)}.${m.name}`, lead: [{ label: 'Decides on it', file: jf.path, line: at.line, quote: cls, rule: `${simple(t.name)}.${m.name}() uses ${cls} values` }] });
          continue;
        }
        if (!held) continue;
        if (fh.endpoints.some((e) => e.cls === simple(t.name) && e.method === m.name)) continue;
        starts.push({ at: `${simple(t.name)}.${m.name}`, lead: [...holders.get(held)!, { label: 'Uses the type', file: jf.path, line: m.line, quote: m.name, rule: `${simple(t.name)}.${m.name}() takes or returns ${held}` }] });
      }
    }
    return reached;
  }

  /** What a removed method reached at base, as it stands at head. An endpoint that is gone is a finding of its own. */
  function removedEntry(r: Reach, chain: Hop[], deltaId: string, why: string): number {
    const [cls, method] = r.at.split('.') as [string, string];
    if (r.kind !== 'endpoint') return entry(r, chain, deltaId, why);
    let n = 0;
    for (const eb of fb.endpoints.filter((x) => x.cls === cls && x.method === method)) {
      const eh = fh.endpoints.find((x) => x.verb === eb.verb && x.path === eb.path && x.service === eb.service);
      if (eh) { n += consumers(eh, chain, deltaId, why); continue; }
      const exp = exposedAs(fb, eb);
      const ext = exp ? exp.path : eb.path;
      const aid = `api:${eb.verb} ${ext}`;
      const apiHop: Hop = { label: 'API removed', file: eb.file, line: eb.line, quote: 'Mapping', side: 'base', rule: `${eb.verb} ${eb.path} existed at base and is gone at head` };
      ctx.surface({ id: aid, kind: 'api', name: `${eb.verb} ${ext} (removed)`, where: `${eb.service ?? ''} ${eb.verb} ${eb.path}`.trim(), tier: 'test-first' });
      ctx.addCase({ surface: aid, delta: deltaId, tier: 'test-first', do: `Call ${eb.verb} ${ext}.`, expect: 'It no longer exists (404 or 405). Nothing should still call it.', before: 'Answered.', after: 'Gone.', proof: 'derived', hops: [...chain, apiHop] });
      n++;
      // pages at head that still call the path it had
      for (const c of browserCalls(fb, ui, eb)) {
        for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
          const sid = `screen:${rt.path}`;
          const title = screenTitle(ui.components.get(rt.component), rt.path);
          ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
          ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-first', do: `Open ${title} and use what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: `It still calls ${eb.verb} ${ext}, which was removed: it now fails.`, before: 'Worked.', after: 'Calls an API that is gone.', proof: 'derived', hops: [...chain, apiHop, { label: 'Still calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
          n++;
        }
      }
    }
    return n;
  }

  /* ---------- another service reads this API with its own type: a field the API no longer sends arrives empty there ---------- */
  {
    const jsonNames = (f: SpringFacts, module: string, type: string): Set<string> | null => { const d = f.dto(module, type); return d ? new Set(d.fields.map((x) => x.json)) : null; };
    for (const e of fh.endpoints) {
      const eb = fb.endpoints.find((x) => x.verb === e.verb && x.path === e.path && x.service === e.service);
      const rt = e.returns.match(/[A-Z]\w*/g)?.filter((x) => !/^(List|Set|Collection|Optional|ResponseEntity|Page|Mono|Flux|Map|String|Long|Integer|Object|Void)$/.test(x)) ?? [];
      if (!eb || rt.length !== 1) continue;
      const nowSent = jsonNames(fh, e.module, rt[0]!), wasSent = jsonNames(fb, eb.module, rt[0]!);
      if (!nowSent || !wasSent) continue;
      const gone = [...wasSent].filter((x) => !nowSent.has(x));
      if (!gone.length) continue;
      const dtoNow = fh.dto(e.module, rt[0]!)!;
      for (const c of fh.calls.filter((x) => x.service === e.service && x.verb === e.verb && templateHits(x.tpl, e.path))) {
        const ct = [...fh.javaFiles.values()].flatMap((jf) => jf.types).find((t) => simple(t.name) === c.cls);
        const m = ct?.methods.find((x) => x.name === c.method);
        const consumer = m?.returnType.match(/[A-Z]\w*/g)?.filter((x) => !/^(List|Set|Optional|ResponseEntity|Mono|Flux)$/.test(x))[0];
        const reads = consumer ? fh.dto(c.module, consumer) : undefined;
        if (!reads) continue;
        for (const fl of reads.fields.filter((x) => gone.includes(x.json))) {
          const id = `contract-java:${reads.name}.${fl.json}`;
          const readHop: Hop = { label: 'Another service reads', file: reads.file, line: fl.line, quote: fl.name, rule: `${reads.name}.${fl.name} in ${fh.serviceOf(reads.file) ?? c.module} is read from "${fl.json}" of ${e.service}'s ${e.verb} ${e.path}` };
          const sendHop: Hop = { label: 'The API sends', file: dtoNow.file, line: dtoNow.line, quote: dtoNow.name, rule: `${dtoNow.name} as JSON now: ${[...nowSent].join(', ')}; no "${fl.json}"` };
          const callHop: Hop = { label: 'Called by', file: c.file, line: c.line, quote: c.how.startsWith('@FeignClient') ? 'Mapping' : 'uri', rule: `${c.cls}.${c.method}() · ${c.how}` };
          const why = `${reads.name}.${fl.name} (${fh.serviceOf(reads.file) ?? c.module}) arrives empty: ${e.service} no longer sends "${fl.json}"`;
          let n = 0;
          for (const r of reachFrom(fh, `${c.cls}.${c.method}`)) n += entry(r, [sendHop, readHop, callHop, ...r.hops], id, why);
          if (!ctx.deltas.some((d) => d.id === id)) ctx.deltas.push({ id, kind: 'response-shape-changed', title: `${reads.name}.${fl.json} is read by ${fh.serviceOf(reads.file) ?? c.module}, but ${dtoNow.name} no longer sends "${fl.json}"`, endpoint: '', rules: [], causes: [sendHop, readHop] });
          if (!n) ctx.unseen.push({ what: `${fh.serviceOf(reads.file) ?? c.module}'s use of ${reads.name}.${fl.name}`, why, resolve: `rename ${reads.name}.${fl.name} in the same release, or keep sending "${fl.json}"` });
        }
      }
    }
  }

  /* ---------- feature switches: @EnableAsync and friends change how every method they govern runs ---------- */
  const SWITCHES: Record<string, { anns: string[]; how: string }> = {
    Async: { anns: ['Async'], how: 'runs on another thread, and its caller does not wait' },
    Scheduling: { anns: ['Scheduled'], how: 'runs on its schedule' },
    Caching: { anns: ['Cacheable', 'CachePut', 'CacheEvict', 'Caching'], how: 'answers from the cache' },
    Retry: { anns: ['Retryable'], how: 'is retried when it fails' },
    Kafka: { anns: ['KafkaListener'], how: 'receives from Kafka' },
    Rabbit: { anns: ['RabbitListener'], how: 'receives from RabbitMQ' },
    Jms: { anns: ['JmsListener'], how: 'receives from JMS' },
    TransactionManagement: { anns: ['Transactional'], how: 'runs in a transaction' },
  };
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java') continue;
    for (const [side, S, f, ns] of [['head', H, fh, cf.headLines], ['base', B, fb, cf.baseLines]] as const) {
      for (const n of ns) {
        const m = /@Enable(Async|Scheduling|Caching|Retry|Kafka|Rabbit|Jms|TransactionManagement)\b/.exec(S.line(cf.path, n) ?? '');
        if (!m) continue;
        const sw = SWITCHES[m[1]!]!;
        const module = f.moduleOf(cf.path);
        const turned = side === 'head' ? (B.read(cf.path) ?? '').includes(`@Enable${m[1]}`) ? 'changed' : 'turned on' : (H.read(cf.path) ?? '').includes(`@Enable${m[1]}`) ? 'changed' : 'turned off';
        const hop: Hop = { label: 'Switch changed', file: cf.path, line: n, quote: `Enable${m[1]}`, rule: `@Enable${m[1]} ${turned} in ${f.serviceOf(cf.path) ?? 'this service'}: every @${sw.anns[0]} method ${turned === 'turned off' ? 'no longer' : 'now'} ${sw.how}`, ...(side === 'base' ? { side: 'base' as const } : {}) };
        const id = `switch:${cf.path}:${m[1]}`;
        let reached = 0;
        for (const [file, jf] of fh.javaFiles) {
          if (fh.moduleOf(file) !== module) continue;
          for (const t of jf.types) {
            const onClass = t.annotations.find((a) => sw.anns.includes(a.name));
            for (const meth of t.methods) {
              const a = meth.annotations.find((x) => sw.anns.includes(x.name)) ?? onClass;
              if (!a) continue;
              const at = `${simple(t.name)}.${meth.name}`;
              const annHop: Hop = { label: `@${a.name}`, file, line: a.line, quote: a.name, rule: `${at}() is @${a.name}` };
              for (const r of reachFrom(fh, at)) reached += entry(r, [hop, annHop, ...r.hops], id, `@Enable${m[1]} ${turned}`);
            }
          }
        }
        if (!reached) continue;
        ctx.follow(cf.path, n, side === 'base' ? 'base' : undefined);
        if (!ctx.deltas.some((d) => d.id === id)) ctx.deltas.push({ id, kind: 'code-changed', title: hop.rule, endpoint: '', rules: [], causes: [hop] });
      }
    }
  }

  /* ---------- configuration keys: application.yml / .properties, to the code that reads them ---------- */
  for (const cf of ctx.changes) {
    if (!/(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/.test(cf.path)) continue;
    const yaml = /\.ya?ml$/.test(cf.path);
    const keysOf = (S: Snapshot, ns: readonly number[]): Map<string, number[]> => {
      const text = S.read(cf.path) ?? '';
      const lines = text.split('\n');
      const out = new Map<string, number[]>();
      for (const n of ns) {
        const raw = lines[n - 1] ?? '';
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const key = yaml ? yamlKey(lines, n) : /^\s*([\w.\-[\]]+)\s*[=:]/.exec(raw)?.[1] ?? null;
        if (!key) continue;
        if (!out.has(key)) out.set(key, []);
        out.get(key)!.push(n);
      }
      return out;
    };
    const head = cf.status === 'deleted' ? new Map<string, number[]>() : keysOf(H, cf.headLines);
    const base = keysOf(B, cf.baseLines);
    const service = fh.serviceOf(cf.path);
    const module = fh.moduleOf(cf.path);
    for (const [key, lines] of [...head, ...[...base].filter(([k]) => !head.has(k))]) {
      const atHead = head.has(key);
      const before = base.has(key) ? (B.line(cf.path, base.get(key)![0]!) ?? '').trim() : null;
      const now = atHead ? (H.line(cf.path, lines[0]!) ?? '').trim() : null;
      const changed: Hop = atHead
        ? { label: 'Setting changed', file: cf.path, line: lines[0]!, quote: snippet(now), rule: `${key}${before ? `: ${before.replace(/^[^:=]*[:=]\s*/, '')} → ${now!.replace(/^[^:=]*[:=]\s*/, '')}` : ' added'}` }
        : { label: 'Setting removed', file: cf.path, line: lines[0]!, quote: snippet(before), side: 'base', rule: `${key} removed` };
      const id = `cfg:${cf.path}:${key}`;
      const why = `${key} changed`;
      let reached = 0;
      // log levels and log format: what the app writes to its own logs, nothing a user sees
      if (/^logging(\.(level|pattern|file|charset|group|logback|log4j2|threshold)\b.*)?$/.test(key)) {
        for (const n of lines) ctx.follow(cf.path, n, atHead ? undefined : 'base');
        ctx.deltas.push({ id, kind: 'code-changed', title: `${changed.rule} (only what the app writes to its logs)`, endpoint: '', rules: [], causes: [changed] });
        continue;
      }
      // a key under this app's own @ConfigurationProperties prefix that no component binds: nothing reads it
      const own = ownPrefix(fh, key);
      // "nothing reads it" only when no Java string anywhere names the key or its last part: env.getProperty("…"), SpEL, a condition
      const last = key.split('.').pop()!;
      const named = own && [...fh.javaFiles.keys()].some((jf) => { const t = H.read(jf) ?? ''; return t.includes(`"${key}`) || t.includes(`"${last}"`) || t.includes(`${camel(last)}"`) || t.includes(`'${last}'`); });
      if (own && !named && !configReaders(fh, key).length && !own.bound) {
        const hop: Hop = { label: 'Bound by', file: own.file, line: own.line, quote: 'ConfigurationProperties', rule: `${own.type} binds ${own.prefix}.*, and has no ${camel(key.slice(own.prefix.length + 1).split('.')[0]!)}` };
        for (const n of lines) ctx.follow(cf.path, n, atHead ? undefined : 'base');
        ctx.deltas.push({ id, kind: 'code-changed', title: `${changed.rule}: nothing in this repository reads it`, endpoint: '', rules: [], causes: [changed, hop] });
        continue;
      }
      // how a service receives from its broker (consumer settings, JSON trust, the listener container): its listeners, not its API
      if (/^spring\.(kafka\.(consumer|listener|streams|bootstrap-servers)|kafka\.properties\.spring\.json|json\.|rabbitmq\.listener|jms\.listener)/.test(key) || /^spring\.kafka\.consumer\./.test(key)) {
        const ls = fh.listeners.filter((l) => l.module === module && /^@(KafkaListener|RabbitListener|JmsListener|SqsListener)$/.test(l.kind));
        if (ls.length) {
          for (const l of ls) {
            const sid = `job:${l.cls}.${l.method}`;
            ctx.surface({ id: sid, kind: 'job', name: `${l.cls}.${l.method}() ${l.kind}`, where: l.file, tier: 'test-first' });
            ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: `Publish what ${l.cls}.${l.method}() listens for${l.channels?.length ? ` (${l.channels.map((c) => c.name).join(', ')})` : ''} and check that it still receives and handles it.`, expect: `It receives every record as before. Risk: ${key} changes how ${service ?? 'the service'} reads records, and a record it cannot read is skipped or retried for ever.`, before: 'Received.', after: 'Receives with new settings.', proof: 'derived', hops: [changed, { label: 'Listens', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${l.cls}.${l.method}() ${l.kind} in ${service ?? module}` }] });
            ctx.receiving?.push({ cls: l.cls, method: l.method, why: `${key} changed how it receives`, hop: changed });
          }
          for (const n of lines) ctx.follow(cf.path, n, atHead ? undefined : 'base');
          ctx.deltas.push({ id, kind: 'code-changed', title: `${changed.rule} (how ${service ?? 'the service'} receives messages)`, endpoint: '', rules: [], causes: [changed] });
          continue;
        }
      }
      // framework settings that configure one client bean (mail, a message broker, a cache store): the code that uses that bean
      const client = CLIENT_KEYS.find(([re]) => re.test(key));
      const users: { at: string; lead: Hop[] }[] = [];
      if (client) for (const [file, jf] of fh.javaFiles) {
        if (fh.moduleOf(file) !== module) continue;
        for (const t of jf.types) for (const fl of t.fields.filter((x) => client[1].test(simple(x.type).replace(/<.*$/, '')))) {
          const ty = simple(fl.type).replace(/<.*$/, '');
          const fieldHop: Hop = { label: 'Uses it', file, line: fl.line, quote: ty, rule: `${simple(t.name)}.${fl.name} is the ${ty} that ${key.split('.').slice(0, 2).join('.')} configures` };
          for (const m of t.methods) {
            const tok = m.body.find((x) => x.t === fl.name);
            if (tok) users.push({ at: `${simple(t.name)}.${m.name}`, lead: [fieldHop, { label: 'Calls it', file, line: tok.line, quote: fl.name, rule: `${simple(t.name)}.${m.name}() uses ${fl.name}` }] });
          }
        }
      }
      if (users.length) {
        for (const u of users) { ctx.affected?.push({ at: u.at, hop: changed }); for (const r of reachFrom(fh, u.at)) reached += entry(r, [changed, ...u.lead, ...r.hops], id, why); }
      } else if (/^(spring|server|management|logging)\./.test(key)) {
        // framework settings: every request of the service goes through them
        const note: Hop = { label: 'Read by the framework', file: cf.path, line: lines[0]!, quote: snippet(atHead ? now : before), rule: `${key.split('.').slice(0, 2).join('.')} configures ${service ?? 'the service'} as a whole`, ...(atHead ? {} : { side: 'base' as const }) };
        for (const e of fh.endpoints.filter((x) => x.module === module)) reached += consumers(e, [changed, note], id, why);
      } else {
        for (const rd of configReaders(fh, key)) {
          const hop: Hop = { label: 'Reads it', file: rd.file, line: rd.line, quote: rd.quote, rule: rd.how };
          ctx.affected?.push({ at: rd.at, hop });
          for (const r of reachFrom(fh, rd.at)) reached += entry(r, [changed, hop, ...r.hops], id, why);
        }
      }
      if (!reached) continue;
      for (const n of lines) ctx.follow(cf.path, n, atHead ? undefined : 'base');
      ctx.deltas.push({ id, kind: 'code-changed', title: changed.rule, endpoint: '', rules: [], causes: [changed] });
    }
  }

  /* ---------- database migrations: Liquibase changeSets and Flyway scripts, to the entity and its writers ---------- */
  for (const cf of ctx.changes) {
    if (cf.status === 'deleted' || fileKind(cf.path) !== 'data') continue;
    const text = H.read(cf.path) ?? '';
    let ops = migrationOps(cf.path, text).filter((o) => o.lines.some((n) => cf.headLines.includes(n)));
    // a data file a changeSet loads: the rows it holds are the change
    const loadedBy: Hop[] = [];
    if (/\.(csv|tsv)$/i.test(cf.path)) {
      for (const f of H.files.filter((x) => /\.xml$/.test(x) && fileKind(x) === 'data')) {
        const xml = H.read(f) ?? '';
        for (const op of migrationOps(f, xml).filter((o) => o.kind === 'seed')) {
          const file = /from (\S+)$/.exec(op.text)?.[1] ?? '';
          if (!file || !(cf.path === file || cf.path.endsWith(`/${file}`) || cf.path.endsWith(file.replace(/^classpath:/, '')))) continue;
          ops = [...ops, { ...op, file: f, lines: [], text: `${op.text} (${fileName(cf.path)} changed)` }];
          loadedBy.push({ label: 'Loaded by', file: f, line: op.line, quote: op.quote, rule: `${fileName(f)} loads ${fileName(cf.path)} into ${op.table}` });
        }
      }
      if (ops.length) for (const n of cf.headLines) ctx.follow(cf.path, n);
    }
    for (const op of ops) {
      const ent = fh.entities.find((e) => e.table.toLowerCase() === op.table.toLowerCase());
      const opHop: Hop = op.file
        ? { label: 'Rows changed', file: cf.path, line: cf.headLines[0] ?? 1, quote: '', rule: `${fileName(cf.path)} changed, and ${fileName(op.file)} loads it into ${op.table}` }
        : { label: 'Database change', file: cf.path, line: op.line, quote: op.quote, rule: op.text };
      const id = `db:${cf.path}:${op.line}`;
      const did: Hop[] = [];
      const dsid = `data:${op.table}`;
      ctx.surface({ id: dsid, kind: 'data', name: `${op.table} table`, where: op.table, tier: 'test-first' });
      if (op.kind === 'add-not-null') ctx.unseen.push({ what: `rows already in the ${op.table} table in production`, why: `the database change adds ${op.column} NOT NULL with no default, which fails on a table that has rows; the code cannot tell how many there are`, resolve: `run SELECT count(*) FROM ${op.table} on a copy of production, or give ${op.column} a default`, files: [cf.path] });
      if (op.kind === 'index') {
        // an index changes how fast, not what: nothing a user sees, but building it can lock a large table
        ctx.surface({ id: dsid, kind: 'data', name: `${op.table} table`, where: op.table, tier: 'watch' });
        ctx.addCase({ surface: dsid, delta: id, tier: 'watch', field: op.column, do: 'Watch how long the migration takes on production-size data.', expect: 'It finishes without locking the table for long; nothing a user sees changes.', before: 'No index.', after: op.text, proof: 'derived', hops: [opHop] });
        for (const n of op.lines) ctx.follow(cf.path, n);
        ctx.deltas.push({ id, kind: 'code-changed', title: `${op.table}: ${op.text} (speed only)`, endpoint: '', rules: [], causes: [opHop] });
        continue;
      }
      if (op.kind === 'add-not-null') ctx.addCase({ surface: dsid, delta: id, tier: 'test-first', field: op.column, do: `Run the migration on a copy of production data.`, expect: `It succeeds. Risk: it fails if ${op.table} already has rows, because ${op.column} is NOT NULL with no default.`, before: 'No such column.', after: `${op.column} NOT NULL.`, proof: 'derived', hops: [opHop] });
      else ctx.addCase({ surface: dsid, delta: id, tier: 'test-first', field: op.column, do: `Run the migration on a copy of production data, then use the app.`, expect: `It succeeds, and what reads or writes ${op.table} works.`, before: 'As released.', after: op.text, proof: 'derived', hops: [opHop] });
      let reached = 1;
      if (ent) {
        const mapped = ent.columns.find((c) => c.column.toLowerCase() === op.column.toLowerCase());
        const entLine = H.line(ent.file, ent.line) ?? '';
        const entHop: Hop = { label: 'Mapped by', file: ent.file, line: ent.line, quote: entLine.includes(ent.table) ? ent.table : entLine.includes(ent.name) ? ent.name : '', rule: `${ent.name} is stored in ${ent.table}` };
        // which code paths break: writes when the entity cannot fill a new NOT NULL column; everything when it maps a column that is gone
        const breaks = op.kind === 'add-not-null' ? (mapped ? null : 'writes')
          : op.kind === 'drop' || op.kind === 'rename' ? (mapped ? 'all' : null)
          : op.kind === 'unique' || (op.kind === 'retype' && mapped) ? 'writes'
          : op.kind === 'seed' ? 'reads' : null;
        if (breaks === 'reads') {
          // rows the migration writes: what shows that table shows them
          const eps = fh.endpoints.filter((e) => e.verb === 'GET' && ids(e.returns).includes(ent.name));
          for (const e of eps) for (const c of browserCalls(fh, ui, e)) for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
            const sid = `screen:${rt.path}`;
            const title = screenTitle(ui.components.get(rt.component), rt.path);
            ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-next' });
            ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Open ${title} after the migration and check the ${words(ent.name)} rows it ${op.text}.`, expect: 'They show as intended.', before: 'Earlier rows.', after: `Rows from ${fileName(cf.path)}.`, proof: 'derived', hops: [opHop, entHop, { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} returns ${ent.name}` }, { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
            reached++;
          }
        }
        if (breaks === 'writes' || breaks === 'all') {
          const why = op.kind === 'unique' ? `the database now refuses a second ${ent.name} with the same ${op.column}`
            : op.kind === 'retype' ? `${op.table}.${op.column} ${op.text.replace(/^changes \S+ /, 'becomes ')}, so a value that does not fit is refused or cut`
            : breaks === 'writes' ? `${ent.name} has no field for ${op.column}, so the database rejects every new ${ent.name} row` : `${ent.name}.${mapped!.field} still maps ${op.column}, which is ${op.kind === 'drop' ? 'dropped' : 'renamed'}`;
          if (mapped) did.push({ label: 'Still mapped', file: mapped.file, line: mapped.line, quote: mapped.field, rule: `${ent.name}.${mapped.field} → ${op.table}.${op.column}` });
          // a column every query selects: whatever loads the entity, itself or through a relation that brings it along
          const loaded = new Map<Endpoint, string>();
          if (breaks === 'all') for (const e of fh.endpoints) { const v = loadsEntity(fh, e, ent.name); if (v) loaded.set(e, v); }
          const eps = fh.endpoints.filter((e) => breaks === 'all'
            ? loaded.has(e)
            : /^(POST|PUT|PATCH)$/.test(e.verb) && ((!!e.body && ids(e.body.type).includes(ent.name)) || savesEntity(fh, e, ent.name)));
          for (const e of eps) {
            const exp = exposedAs(fh, e);
            const ext = exp ? exp.path : e.path;
            const aid = `api:${e.verb} ${ext}`;
            const v = loaded.get(e);
            const apiHop: Hop = { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} ${breaks === 'writes' ? 'writes' : 'uses'} ${ent.name}${v && v !== ent.name ? `, through ${v}, which loads it with every row` : ''}` };
            ctx.surface({ id: aid, kind: 'api', name: `${e.verb} ${ext}`, where: `${e.service ?? ''} ${e.verb} ${e.path}`.trim(), tier: 'test-first' });
            ctx.touched.add(e);
            ctx.addCase({ surface: aid, delta: id, tier: 'test-first', do: `Call ${e.verb} ${ext} with a valid ${words(ent.name)}.`, expect: `It works. Risk: the database rejects it (500): ${why}.`, before: 'Worked.', after: 'Database error.', proof: 'derived', hops: [opHop, entHop, ...did, apiHop] });
            reached++;
            for (const c of browserCalls(fh, ui, e)) for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
              const sid = `screen:${rt.path}`;
              const title = screenTitle(ui.components.get(rt.component), rt.path);
              ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
              ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: breaks === 'writes' ? `Save a ${words(ent.name)} on ${title}.` : `Open ${title} and use it.`, expect: `It works. Risk: an error, because ${why}.`, before: 'Worked.', after: 'Database error.', proof: 'derived', hops: [opHop, entHop, ...did, apiHop, { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, ...(importChain(ui, rt.component, c.file) ?? []), { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
              reached++;
            }
          }
        }
        // jobs and listeners that write it (or load it, when every query breaks) fail the same way, with no screen to show it
        if (breaks === 'writes' || breaks === 'all') for (const l of fh.listeners) {
          const pseudo = { cls: l.cls, method: l.method, returns: '', body: null } as unknown as Endpoint;
          if (!(breaks === 'all' ? loadsEntity(fh, pseudo, ent.name) : savesEntity(fh, pseudo, ent.name))) continue;
          const sid = `job:${l.cls}.${l.method}`;
          const why = op.kind === 'unique' ? `the database now refuses a second ${ent.name} with the same ${op.column}` : op.kind === 'retype' ? `${op.table}.${op.column} ${op.text.replace(/^changes \S+ /, 'becomes ')}, so a value that does not fit is refused or cut` : `${op.table} changed under ${ent.name}`;
          ctx.surface({ id: sid, kind: 'job', name: `${l.cls}.${l.method}() ${l.kind}`, where: l.file, tier: 'test-first' });
          ctx.affected?.push({ at: `${l.cls}.${l.method}`, hop: opHop });
          ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: `Let ${l.cls}.${l.method}() run (or trigger it) after the migration.`, expect: `It ${breaks === 'writes' ? 'saves' : 'reads and saves'} ${words(ent.name)} rows as before. Risk: a database error, because ${why}.`, before: 'Worked.', after: 'Database error.', proof: 'derived', hops: [opHop, entHop, { label: 'Job', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${l.cls}.${l.method}() ${l.kind} ${breaks === 'writes' ? 'saves' : 'loads'} ${ent.name}` }] });
          reached++;
        }
      } else ctx.unseen.push({ what: `the ${op.table} table (${op.text})`, why: 'no entity in this repository maps it; another service or a report may read it', resolve: `search other repositories and reports for ${op.table}`, files: [cf.path] });
      if (reached) for (const n of op.lines) ctx.follow(cf.path, n);
      ctx.deltas.push({ id, kind: 'code-changed', title: `${op.table}: ${op.text}`, endpoint: '', rules: [], causes: [opHop] });
    }
    // a changeSet whose every operation was read is read whole; the changelog's own wrapper carries no change
    if (ops.length && /\.xml$/.test(cf.path)) {
      const lineOf = (i: number): number => text.slice(0, i).split('\n').length;
      const sets = [...text.matchAll(/<changeSet\b[\s\S]*?<\/changeSet>/g)].map((m) => ({ from: lineOf(m.index!), to: lineOf(m.index! + m[0].length), body: m[0] }));
      for (const n of cf.headLines) {
        const set = sets.find((x) => n >= x.from && n <= x.to);
        if (!set) { if (/^\s*(<\?xml|<\/?databaseChangeLog\b|xmlns|xsi:)/.test(H.line(cf.path, n) ?? '') || !(H.line(cf.path, n) ?? '').trim()) ctx.follow(cf.path, n); continue; }
        const inSet = ops.filter((o) => o.line >= set.from && o.line <= set.to);
        const onlyKnown = !/<(?!\/?(changeSet|addColumn|dropColumn|renameColumn|column|constraints|comment|createIndex|dropIndex|addUniqueConstraint|modifyDataType|loadData|loadUpdateData|insert|update|delete|where)\b)[a-zA-Z]/.test(set.body);
        if (inSet.length && onlyKnown) ctx.follow(cf.path, n);
      }
    }
  }
  // a changelog that only includes a new file is followed when that file is
  for (const cf of ctx.changes) {
    if (cf.status === 'deleted' || fileKind(cf.path) !== 'data') continue;
    for (const n of cf.headLines) {
      const inc = /<include\s+file="([^"]+)"/.exec(H.line(cf.path, n) ?? '');
      if (inc && ctx.deltas.some((d) => d.id.startsWith(`db:`) && d.id.includes(inc[1]!.split('/').pop()!))) ctx.follow(cf.path, n);
    }
  }

  /* ---------- APIs that are gone at head, however they went ---------- */
  // A method can stay while its mapping moves (POST /{id}/cancel → PATCH /{id}/cancellation), or a class-level
  // path can change. Clients still calling the old verb and path break either way, so every (verb, path) of base
  // that head no longer answers is a removed API, and the screens still calling it are tested first.
  for (const eb of fb.endpoints) {
    if (fh.endpoints.some((x) => x.verb === eb.verb && x.path === eb.path && x.service === eb.service)) continue;
    const moved = fh.endpoints.find((x) => x.cls === eb.cls && x.method === eb.method && x.service === eb.service);
    const id = `api-gone:${eb.verb} ${eb.path}`;
    if (ctx.deltas.some((d) => d.id === id)) continue;
    const exp = exposedAs(fb, eb);
    const ext = exp ? exp.path : eb.path;
    const apiHop: Hop = { label: 'API removed', file: eb.file, line: eb.line, quote: 'Mapping', side: 'base', rule: `${eb.verb} ${eb.path} existed at base` };
    const movedHop: Hop[] = moved ? [{ label: 'Now answers', file: moved.file, line: moved.line, quote: 'Mapping', rule: `${eb.cls}.${eb.method}() now answers ${moved.verb} ${moved.path}` }] : [];
    ctx.follow(eb.file, eb.line, 'base');
    ctx.deltas.push({ id, kind: 'code-changed', title: `${eb.verb} ${ext} is gone${moved ? `: now ${moved.verb} ${exposedAs(fh, moved)?.path ?? moved.path}` : ''}`, endpoint: `${eb.verb} ${ext}`, rules: [], causes: [apiHop, ...movedHop] });
    ctx.touched.add(eb);
    const aid = `api:${eb.verb} ${ext}`;
    ctx.surface({ id: aid, kind: 'api', name: `${eb.verb} ${ext} (removed)`, where: `${eb.service ?? ''} ${eb.verb} ${eb.path}`.trim(), tier: 'test-first' });
    ctx.addCase({ surface: aid, delta: id, tier: 'test-first', do: `Call ${eb.verb} ${ext}.`, expect: `It no longer exists (404 or 405)${moved ? `; the same action is now ${moved.verb} ${moved.path}` : ''}. Nothing should still call it.`, before: 'Answered.', after: 'Gone.', proof: 'derived', hops: [apiHop, ...movedHop] });
    for (const c of browserCalls(fb, ui, eb)) {
      for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
        const sid = `screen:${rt.path}`;
        const title = screenTitle(ui.components.get(rt.component), rt.path);
        ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: `Open ${title} and use what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: `It works. Risk: it fails (404 or 405), because the page still calls ${eb.verb} ${ext}${moved ? `, and the API moved to ${moved.verb} ${moved.path}` : ', which is gone'}.`, before: 'Worked.', after: 'Calls an API that is gone.', proof: 'derived', hops: [apiHop, ...movedHop, { label: 'Still calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, ...(importChain(ui, rt.component, c.file) ?? []), { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
      }
    }
  }

  /* ---------- resources: a file is read by the code that names it ---------- */
  for (const cf of ctx.changes) {
    if (!/(^|\/)src\/main\/resources\//.test(cf.path) || /\/(static|public)\//.test(cf.path)) continue;
    const kind = fileKind(cf.path);
    if (kind === 'config' || kind === 'java' || kind === 'i18n') continue;
    const name = fileName(cf.path);
    const stem = name.replace(/\.[^.]+$/, '');
    const rel = cf.path.replace(/^.*?src\/main\/resources\//, '');
    const relStem = rel.replace(/\.[^.]+$/, '');
    let reached = 0;
    const readers: Hop[] = [];
    for (const [file, jf] of fh.javaFiles) for (const t of jf.types) for (const m of t.methods) {
      const tok = m.body.find((x) => /^"/.test(x.t) && (x.t.includes(name) || x.t.slice(1, -1) === stem || x.t.slice(1, -1).endsWith(relStem)));
      if (!tok) continue;
      const hop: Hop = { label: 'Reads it', file, line: tok.line, quote: tok.t.slice(1, -1).slice(0, 24), rule: `${simple(t.name)}.${m.name}() names ${tok.t}` };
      readers.push(hop);
      const changed: Hop = cf.status === 'deleted'
        ? { label: 'Deleted', file: cf.path, line: 1, quote: '', side: 'base', rule: `${name} was deleted` }
        : { label: 'Changed', file: cf.path, line: cf.headLines[0] ?? 1, quote: '', rule: `${rel} changed` };
      for (const r of reachFrom(fh, `${simple(t.name)}.${m.name}`)) reached += entry(r, [changed, hop, ...r.hops], `res:${cf.path}`, `${rel} changed, and ${simple(t.name)}.${m.name}() reads it`);
    }
    if (!reached) continue;
    for (const n of cf.headLines) ctx.follow(cf.path, n);
    for (const n of cf.baseLines) ctx.follow(cf.path, n, 'base');
    ctx.deltas.push({ id: `res:${cf.path}`, kind: 'code-changed', title: `${rel} changed; read by ${readers.slice(0, 2).map((h) => h.rule.split(' names')[0]).join(', ')}`, endpoint: '', rules: [], causes: readers.slice(0, 1) });
  }

  /* ---------- front end: changed files and the screens that run them ---------- */
  const everyScreen = (u: FrontendFacts, S: Snapshot, file: string): boolean =>
    u.globals.some((g) => g.file === file || g.root === file) ||
    !!u.shell?.has(file) ||
    /\bcreateApp\s*\(|\bnew\s+Vue\s*\(|bootstrapApplication\s*\(|\.mount\(\s*['"]#/.test(S.read(file) ?? '') ||
    (u.routes.length > 0 && u.routes.every((r) => {
      const seen = new Set<string>();
      const walk = (f: string, d: number): boolean => { if (f === file) return true; if (seen.has(f) || d > 8) return false; seen.add(f); return (u.components.get(f)?.deps ?? []).some((x) => walk(x, d + 1)); };
      return walk(r.component, 0);
    }));

  for (const cf of ctx.changes) {
    const kind = fileKind(cf.path);
    if (kind !== 'frontend' && kind !== 'style') continue;
    const atHead = cf.status !== 'deleted';
    const u = atHead ? ui : ub;
    const S = atHead ? H : B;
    const lines = atHead ? cf.headLines : cf.baseLines;
    // TypeScript types are erased when the app is built: a line inside an interface or a type alias changes nothing that runs
    const erasedHead = /\.tsx?$/.test(cf.path) && atHead ? typeOnlyLines(H.read(cf.path) ?? '') : new Set<number>();
    const erasedBase = /\.tsx?$/.test(cf.path) ? typeOnlyLines(B.read(cf.path) ?? '') : new Set<number>();
    const erased = atHead ? erasedHead : erasedBase;
    for (const n of lines) if (erased.has(n)) ctx.follow(cf.path, n, atHead ? undefined : 'base');
    if (atHead) for (const n of cf.baseLines) if (erasedBase.has(n)) ctx.follow(cf.path, n, 'base');
    const real = lines.filter((n) => !erased.has(n) && !trivial((S.line(cf.path, n) ?? '').trim()) && !(atHead && ctx.explained(cf.path, n)));
    if (atHead && !real.length && lines.some((n) => erased.has(n)) && cf.baseLines.every((n) => erasedBase.has(n) || trivial((B.line(cf.path, n) ?? '').trim()))) {
      ctx.noEffect(cf.path, 'only TypeScript types changed: they are erased when the app is built, and a mistake fails the build');
      continue;
    }
    // routes this file defined at base that head no longer has: a deletion-only change has no head lines at all.
    // A parent path that moves (path: 'products' → 'catalog') moves every child route its loadChildren file defines
    const stem = (f: string): string => f.replace(/\.[cm]?[jt]sx?$/, '').split('/').slice(-2).join('/');
    const definesUnder = (text: string, r: Route): boolean => r.file === cf.path || (r.file !== cf.path && text.includes(stem(r.file)));
    const baseText = B.read(cf.path) ?? '';
    const headText = atHead ? H.read(cf.path) ?? '' : '';
    const segment = (path: string): string => path.split('/').filter(Boolean)[0] ?? '';
    const movedLines = new Set<number>();
    const parentLines = (r: Route, side: 'base' | 'head'): number[] => cf.hunks.flatMap((h) => (side === 'base' ? h.base : h.head).filter((n) => {
      const seg = segment(r.path);
      return !!seg && new RegExp(`['"\`]${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`/]`).test((side === 'base' ? B : H).line(cf.path, n) ?? '');
    }));
    if (atHead) for (const rt of ui.routes.filter((r: Route) => r.file !== cf.path && definesUnder(headText, r) && !ub.routes.some((x) => x.path === r.path))) {
      const at = parentLines(rt, 'head')[0];
      if (!at) continue;
      const sid = `screen:${rt.path}`;
      const title = screenTitle(ui.components.get(rt.component), rt.path);
      const movedHop: Hop = { label: 'Now at', file: cf.path, line: at, quote: snippet(H.line(cf.path, at)), rule: `${fileName(cf.path)} places ${fileName(rt.file)}'s routes under /${segment(rt.path)}` };
      ctx.surface({ id: sid, kind: 'screen', name: `${title} (new address)`, where: rt.path, tier: 'test-first' });
      ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${rt.path} directly, and from the links that should lead to it.`, expect: 'The page opens at its new address and works as it did.', before: 'Not at this address.', after: `At ${rt.path}.`, proof: 'derived', hops: [movedHop, { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
      for (const n of parentLines(rt, 'head')) { ctx.follow(cf.path, n); movedLines.add(n); }
    }
    if (atHead) for (const rb of ub.routes.filter((r: Route) => definesUnder(baseText, r) && !ui.routes.some((x) => x.path === r.path))) {
      if (rb.file !== cf.path && !parentLines(rb, 'base').length) continue;
      for (const n of rb.file !== cf.path ? parentLines(rb, 'base') : []) ctx.follow(cf.path, n, 'base');
      const sid = `screen:${rb.path}`;
      const title = screenTitle(ub.components.get(rb.component), rb.path);
      ctx.surface({ id: sid, kind: 'screen', name: `${title} (route removed)`, where: rb.path, tier: 'test-first' });
      // what the cited line really says: a template link or a navigation in code
      const linkWord = (file: string, line: number): string => ['routerLink', 'router-link', 'navigateByUrl', 'navigate', 'push', 'to='].find((w) => (H.line(file, line) ?? '').includes(w)) ?? '';
      const linkers = [...ui.components.values()].flatMap((c) => [...c.links, ...c.pushes].filter((l) => targetsRoute(l.target, rb.path) && !ui.routes.some((x) => targetsRoute(l.target, x.path))).map((l) => { const file = 'file' in l && typeof l.file === 'string' ? l.file : c.file; return { comp: c.file, file, line: l.line, quote: linkWord(file, l.line), global: ui.globals.some((g) => g.file === c.file) }; }));
      const removedHop: Hop = { label: 'Route removed', file: rb.file, line: rb.line, quote: routeQuote(rb), side: 'base', rule: `route ${rb.path} existed at base` };
      ctx.follow(rb.file, rb.line, 'base');
      // the whole route object is the change
      for (const h of cf.hunks) if (h.base.includes(rb.line)) for (const n of h.base) ctx.follow(cf.path, n, 'base');
      ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${rb.path} directly${linkers.length ? `, and follow every link to it (${linkers.slice(0, 3).map((l) => `${fileName(l.file)}:${l.line}`).join(', ')})` : ''}.`, expect: linkers.length ? `The links are gone or point elsewhere. Risk: ${linkers.some((l) => l.global) ? 'a link on every screen' : 'a link'} still leads to a page that no longer exists.` : 'The route is gone, as the change intends.', before: 'Opened a screen.', after: 'Route removed.', proof: 'derived', hops: [removedHop, ...linkers.slice(0, 2).map((l): Hop => ({ label: 'Still links to it', file: l.file, line: l.line, quote: l.quote, rule: `${fileName(l.file)} links to ${rb.path}${l.global ? ', on every screen' : ''}` }))] });
      // every screen that still links to it: the link now leads nowhere
      for (const l of linkers) {
        const linkHop: Hop = { label: 'Still links to it', file: l.file, line: l.line, quote: l.quote, rule: `${fileName(l.file)} links to ${rb.path}, which no route answers now` };
        const where = l.global ? [{ sid: 'screen:*', title: 'Every screen', hop: [] as Hop[] }] : ui.routes.filter((r) => r.path !== rb.path && ctx.closure(r.component).has(l.comp)).map((r) => ({ sid: `screen:${r.path}`, title: screenTitle(ui.components.get(r.component), r.path), hop: [{ label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }] as Hop[] }));
        for (const w of where) {
          ctx.surface({ id: w.sid, kind: 'screen', name: w.title, where: w.sid === 'screen:*' ? `${ui.routes.length} screens` : w.sid.slice(7), tier: 'test-first' });
          ctx.addCase({ surface: w.sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `On ${w.title}, follow the link at ${fileName(l.file)}:${l.line} that went to ${rb.path}.`, expect: `It opens the page it opened before. Risk: it leads nowhere, because no route answers ${rb.path} any more.`, before: 'Opened the page.', after: 'Route gone.', proof: 'derived', hops: [removedHop, linkHop, ...w.hop] });
        }
      }
      if (!ctx.deltas.some((d) => d.id === `ui:${cf.path}`)) ctx.deltas.push({ id: `ui:${cf.path}`, kind: 'ui-changed', title: `${fileName(cf.path)}: route ${rb.path} removed`, endpoint: '', rules: [], causes: [removedHop] });
    }
    // a line inside one route's own object (its title, guard, resolver, data): that screen, and no other
    if (atHead && real.length && /\.[cm]?[jt]sx?$/.test(cf.path)) {
      const own = ui.routes.filter((r) => r.file === cf.path);
      const spans = own.length ? objectSpans(H.read(cf.path) ?? '') : [];
      const handled = new Set<number>();
      for (const n of real) {
        const holding = spans.filter((sp) => sp.from <= n && n <= sp.to).sort((a, b) => (a.to - a.from) - (b.to - b.from));
        let hit: Route | undefined;
        for (const sp of holding) {
          const inside = own.filter((r) => sp.from <= r.line && r.line <= sp.to);
          if (inside.length === 1) hit = inside[0];
          if (inside.length) break;
        }
        if (!hit || hit.line === n && !ub.routes.some((x) => x.path === hit!.path)) continue;
        const sid = `screen:${hit.path}`;
        const title = screenTitle(ui.components.get(hit.component), hit.path);
        const text = (H.line(cf.path, n) ?? '').trim();
        ctx.surface({ id: sid, kind: 'screen', name: title, where: hit.path, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${title} (${hit.path}) and check what its route now sets: ${text.slice(0, 80)}`, expect: 'It opens and behaves as the change intends; no other screen changes.', before: 'As released.', after: text.slice(0, 60), proof: 'derived', hops: [{ label: 'Route changed', file: cf.path, line: n, quote: snippet(H.line(cf.path, n)), rule: `a line of the ${hit.path} route changed` }, { label: 'Screen', file: hit.file, line: hit.line, quote: routeQuote(hit), rule: `route ${hit.path}` }] });
        ctx.follow(cf.path, n);
        handled.add(n);
      }
      if (handled.size) {
        if (!ctx.deltas.some((d) => d.id === `ui:${cf.path}`)) ctx.deltas.push({ id: `ui:${cf.path}`, kind: 'ui-changed', title: `${fileName(cf.path)}: ${[...new Set(real.filter((n) => handled.has(n)).map((n) => (H.line(cf.path, n) ?? '').trim()))].slice(0, 2).join('; ')}`, endpoint: '', rules: [], causes: [{ label: 'Route changed', file: cf.path, line: [...handled][0]!, quote: snippet(H.line(cf.path, [...handled][0]!)), rule: `${fileName(cf.path)} changed a route` }] });
        // base lines replaced by these are the same change
        for (const h of cf.hunks) if (h.head.length && h.head.every((n) => handled.has(n) || trivial((H.line(cf.path, n) ?? '').trim()))) for (const n of h.base) ctx.follow(cf.path, n, 'base');
        if (real.every((n) => handled.has(n))) continue;
      }
    }
    // a navigation guard runs on every navigation: the screens whose route meta it tests, or every screen
    const guardLines = { head: [] as number[], base: [] as number[] };
    {
      const inG = (gs: readonly { file: string; line: number; endLine: number }[], n: number): boolean => gs.some((g) => g.file === cf.path && g.line <= n && n <= g.endLine);
      if (atHead) guardLines.head = real.filter((n) => inG(ui.guards ?? [], n));
      guardLines.base = cf.baseLines.filter((n) => inG(ub.guards ?? [], n) && !trivial((B.line(cf.path, n) ?? '').trim()));
      if (guardLines.head.length || guardLines.base.length) {
        const hitG = [...(ui.guards ?? []).filter((g) => g.file === cf.path && guardLines.head.some((n) => g.line <= n && n <= g.endLine)), ...(ub.guards ?? []).filter((g) => g.file === cf.path && guardLines.base.some((n) => g.line <= n && n <= g.endLine))];
        const keys = new Set(hitG.flatMap((g) => g.meta));
        const gHop: Hop = guardLines.head.length
          ? { label: 'Guard changed', file: cf.path, line: guardLines.head[0]!, quote: snippet(H.line(cf.path, guardLines.head[0]!)), rule: `a navigation guard in ${fileName(cf.path)} changed; it runs before every screen opens` }
          : { label: 'Guard changed', file: cf.path, line: guardLines.base[0]!, quote: snippet(B.line(cf.path, guardLines.base[0]!)), side: 'base', rule: `a navigation guard in ${fileName(cf.path)} changed or was removed; it ran before every screen opened` };
        const guarded = [...new Map([...ui.routes, ...ub.routes].filter((r) => r.meta?.some((k) => keys.has(k))).map((r) => [r.path, r])).values()];
        if (guarded.length) for (const r of guarded) {
          const sid = `screen:${r.path}`;
          const title = screenTitle(ui.components.get(r.component) ?? ub.components.get(r.component), r.path);
          ctx.surface({ id: sid, kind: 'screen', name: title, where: r.path, tier: 'test-first' });
          ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${r.path} as a user the guard should stop, and as one it should let through.`, expect: 'Only the users it should let in get in.', before: 'Guarded as released.', after: 'Guard changed.', proof: 'derived', hops: [gHop, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path} has meta ${r.meta!.filter((k) => keys.has(k)).join(', ')}, which the guard tests` }] });
        }
        else {
          ctx.surface({ id: 'screen:*', kind: 'screen', name: 'Every screen', where: `${ui.routes.length} screens`, tier: 'test-next' });
          ctx.addCase({ surface: 'screen:*', delta: `ui:${cf.path}`, tier: 'test-next', do: 'Open each screen, directly and by its links, signed in and signed out.', expect: 'Each opens for the users it should, as before.', before: 'As released.', after: 'Guard changed.', proof: 'derived', hops: [gHop] });
        }
        for (const n of guardLines.head) ctx.follow(cf.path, n);
        for (const n of guardLines.base) ctx.follow(cf.path, n, 'base');
        if (!ctx.deltas.some((d) => d.id === `ui:${cf.path}`)) ctx.deltas.push({ id: `ui:${cf.path}`, kind: 'ui-changed', title: `${fileName(cf.path)}: navigation guard changed`, endpoint: '', rules: [], causes: [gHop] });
      }
    }
    if (atHead && real.length && real.every((n) => movedLines.has(n) || guardLines.head.includes(n))) continue;
    // lines only removed (a link, a column): the screens that run the file lost them
    const removedOnly = atHead && !real.length ? cf.baseLines.filter((n) => !erasedBase.has(n) && !trivial((B.line(cf.path, n) ?? '').trim()) && !guardLines.base.includes(n) && !movedLines.has(n)) : [];
    if (!real.length && !removedOnly.length) continue;
    ctx.touchedUi.add(cf.path);
    const changedHop: Hop = atHead && !real.length
      ? { label: 'Removed', file: cf.path, line: removedOnly[0]!, quote: snippet(B.line(cf.path, removedOnly[0]!)), side: 'base', rule: `${fileName(cf.path)} lost ${removedOnly.length} line${removedOnly.length === 1 ? '' : 's'}` }
      : atHead
      ? { label: 'Changed', file: cf.path, line: real[0]!, quote: snippet(H.line(cf.path, real[0]!)), rule: `${fileName(cf.path)} changed (${real.length} line${real.length === 1 ? '' : 's'})` }
      : { label: 'Deleted', file: cf.path, line: 1, quote: '', side: 'base', rule: `${fileName(cf.path)} was deleted` };
    // styles: whoever imports them by name
    let targets = [cf.path];
    if (kind === 'style') {
      // who pulls this stylesheet in, through other stylesheets if need be
      const pool = S.files.filter((f) => /\.(s?css|sass|less|styl|vue|m?js|ts|html?)$/.test(f) && !/node_modules\//.test(f));
      const importers = (file: string): string[] => {
        const base = fileName(file).replace(/^_/, '').replace(/\.(s?css|sass|less|styl)$/, '');
        const re = new RegExp(`['"(/]_?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.(s?css|sass|less|styl))?['")]`);
        return pool.filter((f) => f !== file && re.test(S.read(f) ?? ''));
      };
      const seen = new Set([cf.path]);
      const queue = [cf.path];
      const found: string[] = [];
      while (queue.length) {
        for (const imp of importers(queue.shift()!)) {
          if (seen.has(imp)) continue;
          seen.add(imp);
          if (/\.(s?css|sass|less|styl)$/.test(imp)) queue.push(imp); else found.push(imp);
        }
      }
      targets = found.filter((f) => !/\.html?$/.test(f));
      // a global stylesheet is named by the build, not imported: angular.json "styles", a Vite or Vue entry
      const global = !found.length && S.files.some((f) => /(^|\/)(angular|project|workspace)\.json$|(^|\/)vite\.config\.[mc]?[jt]s$/.test(f) && (S.read(f) ?? '').includes(cf.path.split('/').slice(-2).join('/')));
      if (global || found.some((f) => /\.html?$/.test(f)) || targets.some((t) => everyScreen(u, S, t))) targets = ['*'];
    }
    // the page shell: index.html loads the app, so it is every screen
    if (kind === 'frontend' && /\.html?$/.test(cf.path) && /<script[^>]+src=|<div[^>]+id=["']app["']|<router-view|ng-app|ng-view|<[a-z]+-root[\s>]/.test(S.read(cf.path) ?? '') && !u.components.has(cf.path) && ![...u.components.values()].some((c) => c.elements.some((e) => e.file === cf.path))) targets = ['*'];
    // a component style that escapes its component (::ng-deep with no :host before it, or no encapsulation)
    // applies to the whole page once the component has been drawn: every screen
    if (atHead && real.some((n) => { const t = H.line(cf.path, n) ?? ''; return (/::ng-deep/.test(t) && !/:host\b[^{,]*::ng-deep/.test(t)) || /ViewEncapsulation\.(None|ShadowDom)/.test(t); })) targets = ['*'];
    const id = `ui:${cf.path}`;
    // an Angular template is its own file: the component that draws it is the one whose elements live there
    const comp = u.components.get(cf.path) ?? [...u.components.values()].find((c) => c.elements.some((e) => e.file === cf.path));
    const changedEls = comp ? comp.elements.filter((e) => (e.file ?? comp.file) === cf.path && real.includes(e.line)).map((e) => describe(e, comp)) : [];
    const changedCalls = u.calls.filter((c) => c.file === cf.path && real.includes(c.line));
    const what = kind === 'style' ? 'how it looks (styles changed)' : changedEls.length ? [...new Set(changedEls)].slice(0, 6).join(', ') : `what ${fileName(cf.path)} draws or does`;
    // every changed line inside named members of a module (an API object's method, a store's getter, a helper): the screens that use those members
    const memberOnly = ((): { owner: string; member: string }[] | null => {
      const mem = u.components.get(cf.path)?.members;
      const memB = ub.components.get(cf.path)?.members;
      if (!mem || kind !== 'frontend' || cf.path.endsWith('.vue')) return null;
      const hit: { owner: string; member: string }[] = [];
      const inMem = (ms: typeof mem, n: number): boolean => { const m = ms.filter((x) => x.start <= n && n <= x.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]; if (!m) return false; if (!hit.some((h) => h.owner === m.owner && h.member === m.member)) hit.push({ owner: m.owner, member: m.member }); return true; };
      if (!real.every((n) => inMem(mem, n))) return null;
      if (!(atHead ? cf.baseLines.filter((n) => !trivial((B.line(cf.path, n) ?? '').trim()) && !erasedBase.has(n)) : []).every((n) => memB && inMem(memB, n))) return null;
      // a member another member of the module uses changes that one too
      const text = S.read(cf.path) ?? '';
      const lines = text.split('\n');
      for (let grew = true; grew;) {
        grew = false;
        for (const mm of mem) {
          if (hit.some((h) => h.owner === mm.owner && h.member === mm.member)) continue;
          const body = lines.slice(mm.start - 1, mm.end).join('\n');
          if (hit.some((h) => new RegExp(`\\b${h.member === '()' ? h.owner : h.member}\\b`).test(body))) { hit.push({ owner: mm.owner, member: mm.member }); grew = true; }
        }
      }
      return hit.length ? hit : null;
    })();
    if (memberOnly) ctx.uiMembers?.set(cf.path, memberOnly.map((m) => ({ ...m, line: (u.components.get(cf.path)?.members ?? []).find((x) => x.owner === m.owner && x.member === m.member)?.start ?? 1 })));
    const usesMember = (files: ReadonlySet<string>): boolean => !memberOnly || usesMembers(u, files, cf.path, memberOnly);
    const screens = targets.includes('*') || everyScreen(u, S, cf.path) ? null : allScreens(u).filter((r) => targets.some((t) => {
      const seen = new Set<string>();
      const walk = (f: string, d: number): boolean => { if (f === t) return true; if (seen.has(f) || d > 8) return false; seen.add(f); return (u.components.get(f)?.deps ?? []).some((x) => walk(x, d + 1)); };
      return walk(r.component, 0);
    }) && (!memberOnly || usesMember(ctx.closure(r.component)) || !ctx.closure(r.component).has(cf.path) ));
    let reached = 0;
    const defined = u.routes.filter((r) => r.file === cf.path && real.some((n) => Math.abs(n - r.line) <= 1));
    for (const r of defined) {
      const sid = `screen:${r.path}`;
      ctx.surface({ id: sid, kind: 'screen', name: screenTitle(u.components.get(r.component), r.path), where: r.path, tier: 'test-first' });
      ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${r.path} directly and by every link to it.`, expect: 'The route and the screen it shows are as the change intends.', before: 'As released.', after: 'Route changed.', proof: 'derived', hops: [{ label: 'Route changed', file: r.file, line: r.line, quote: routeQuote(r), ...(atHead ? {} : { side: 'base' as const }), rule: `route ${r.path} → ${fileName(r.component)}` }] });
      reached++;
    }
    if (screens === null) {
      const sid = 'screen:*';
      ctx.surface({ id: sid, kind: 'screen', name: 'Every screen', where: `${u.routes.length} screens`, tier: 'test-next' });
      const sh = u.shell?.get(cf.path);
      const shellHop: Hop[] = sh && sh.from !== cf.path ? [{ label: 'Part of the app shell', file: sh.from, line: sh.line, quote: '', ...(atHead ? {} : { side: 'base' as const }), rule: `${fileName(sh.from)} loads ${fileName(cf.path)} before any screen, so it runs on all of them` }] : [];
      ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Open each screen (${u.routes.map((r) => r.path).slice(0, 8).join(', ')}${u.routes.length > 8 ? ', …' : ''}) and check ${what}.`, expect: 'As intended by the change, and nothing else moved.', before: 'As released.', after: 'Changed on every screen.', proof: 'derived', hops: [changedHop, ...shellHop] });
      reached = 1;
    } else {
      for (const r of screens) {
        const c = u.components.get(r.component);
        const sid = `screen:${r.path}`;
        const title = screenTitle(c, r.path);
        // the screen's own component changed: look at it first
        const own = targets.includes(r.component) && atHead;
        const tier: Tier = own ? 'test-first' : 'test-next';
        ctx.surface({ id: sid, kind: 'screen', name: title, where: r.path, tier });
        const via = (targets.map((t) => importChain(u, r.component, t)).find((x) => x) ?? []).map((h) => (atHead ? h : { ...h, side: 'base' as const }));
        ctx.addCase({ surface: sid, delta: id, tier, do: `Open ${title} and check ${what}.`, expect: own ? 'Shows and works as the change intends.' : `Works as before: it runs ${fileName(cf.path)}, which changed.`, before: 'As released.', after: own ? 'Changed.' : 'Runs changed code.', proof: 'derived', hops: atHead ? [changedHop, ...via, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }] : [changedHop] });
        reached++;
      }
    }
    // a component drawn on every screen (beside the router outlet) that runs the changed file: its own area
    if (screens !== null) for (const g of u.globals) {
      if (targets.includes(g.file)) continue;
      const seen = new Set<string>();
      const walk = (f: string, d: number): boolean => { if (targets.includes(f)) return true; if (seen.has(f) || d > 8) return false; seen.add(f); return (u.components.get(f)?.deps ?? []).some((x) => walk(x, d + 1)); };
      if (!walk(g.file, 0)) continue;
      const sid = `widget:${g.tag}`;
      ctx.surface({ id: sid, kind: 'widget', name: g.tag.replace(/^[a-z]+-/, (m) => (/^(app|jhi|ng|v)-$/.test(m) ? '' : m)).replace(/-/g, ' ').replace(/^\w/, (x) => x.toUpperCase()), where: `every screen · <${g.tag}>`, tier: 'test-next' });
      const via = (targets.map((t) => importChain(u, g.file, t)).find((x) => x) ?? []).map((h) => (atHead ? h : { ...h, side: 'base' as const }));
      ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Use <${g.tag}> and check ${what}.`, expect: `Works as before: it runs ${fileName(cf.path)}, which changed.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: atHead ? [changedHop, ...via, { label: 'On every screen', file: g.root, line: g.line, quote: g.quote ?? `<${g.tag}`, rule: `<${g.tag}> is ${g.how ?? 'drawn beside <router-view>'}` }] : [changedHop, ...via] });
      reached++;
    }
    // a key the page now sends that no request type of the API has, in place of one it has: a renamed payload field
    if (atHead && screens !== null && /\.(vue|[jt]sx?)$/.test(cf.path)) {
      const fields = new Map<string, { dto: string; file: string; line: number; rules: string }>();
      const seenT = new Set<string>();
      const walkT = (module: string, type: string, depth: number): void => {
        for (const id0 of type.match(/[A-Z]\w*/g) ?? []) {
          const d = fh.dto(module, id0);
          if (!d || seenT.has(`${module}|${id0}`) || depth > 3) continue;
          seenT.add(`${module}|${id0}`);
          for (const fl of d.fields) { if (!fields.has(fl.json)) fields.set(fl.json, { dto: d.name, file: d.file, line: fl.line, rules: fl.constraints.map((x) => x.rule).join(' ') }); walkT(module, fl.type, depth + 1); }
        }
      };
      for (const e of fh.endpoints) if (e.body) walkT(e.module, e.body.type, 0);
      const keys = (S0: Snapshot, ns: readonly number[]): Map<string, number> => { const out = new Map<string, number>(); for (const n of ns) for (const m of (S0.line(cf.path, n) ?? '').matchAll(/[{,]\s*(\w+)\s*:/g)) if (!out.has(m[1]!)) out.set(m[1]!, n); return out; };
      for (const h of cf.hunks) {
        const kb = keys(B, h.base), kh = keys(H, h.head);
        const gone = [...kb.keys()].filter((k) => !kh.has(k) && fields.has(k));
        const added = [...kh.keys()].filter((k) => !kb.has(k) && !fields.has(k));
        if (!gone.length || !added.length) continue;
        const was = gone[0]!, now = added[0]!, fd = fields.get(was)!;
        const did = `payload:${cf.path}:${was}`;
        const keyHop: Hop = { label: 'The page now sends', file: cf.path, line: kh.get(now)!, quote: now, rule: `the payload key ${was} became ${now}` };
        const apiHop: Hop = { label: 'The API reads', file: fd.file, line: fd.line, quote: was, rule: `${fd.dto}.${was}${fd.rules ? ` ${fd.rules}` : ''}; no request type of the API has a field ${now}` };
        for (const r of screens) {
          const sid = `screen:${r.path}`;
          const title = screenTitle(u.components.get(r.component), r.path);
          ctx.surface({ id: sid, kind: 'screen', name: title, where: r.path, tier: 'test-first' });
          ctx.addCase({ surface: sid, delta: did, tier: 'test-first', field: was, do: `On ${title}, submit what sends ${now}.`, expect: `It is saved as before. Risk: the API reads ${was}, not ${now}: the value arrives empty${fd.rules ? `, and ${fd.rules} refuses it` : ''}.`, before: `Sent as ${was}.`, after: `Sent as ${now}.`, proof: 'derived', hops: [keyHop, apiHop, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }] });
        }
        if (!ctx.deltas.some((d) => d.id === did)) ctx.deltas.push({ id: did, kind: 'ui-changed', title: `${fileName(cf.path)} now sends ${now} where the API reads ${was} (${fd.dto})`, endpoint: '', rules: [], causes: [keyHop, apiHop] });
      }
    }
    for (const c of changedCalls) {
      const ep = fh.endpoints.find((e) => browserCalls(fh, { ...u, calls: [c] }, e).length);
      if (ep) { ctx.touched.add(ep); reached++; }
    }
    if (reached) {
      if (atHead) for (const n of real) ctx.follow(cf.path, n);
      // what was removed from the file is part of what changed on those screens
      for (const n of cf.baseLines) ctx.follow(cf.path, n, 'base');
    }
    if (reached) ctx.deltas.push({ id, kind: 'ui-changed', title: `${fileName(cf.path)}: ${what}`, endpoint: '', rules: [], causes: [changedHop] });
    else ctx.unseen.push({ what: `changed front-end file ${cf.path}`, why: 'no screen this build can see imports or draws it', resolve: 'check where it is used', files: [cf.path] });
  }

  /* ---------- gateway routes: a path the browser still calls that no route forwards any more ---------- */
  const routeKey = (r: { service: string; prefix: string }): string => `${r.service}|${r.prefix}`;
  const under = (tpl: string, prefix: string): boolean => tpl === prefix || tpl.startsWith(`${prefix}/`) || tpl.startsWith(`${prefix}{`);
  for (const rb of fb.gateway.filter((r) => !fh.gateway.some((x) => routeKey(x) === routeKey(r)))) {
    const cf = ctx.changes.find((c) => c.path === rb.file);
    if (!cf) continue;
    const now = fh.gateway.find((r) => r.service === rb.service && r.file === rb.file);
    const goneHop: Hop = { label: 'Route changed', file: rb.file, line: rb.line, quote: 'Path=', side: 'base', rule: `the gateway forwarded ${rb.prefix}/** to ${rb.service}` };
    const nowHop: Hop[] = now ? [{ label: 'Now forwards', file: now.file, line: now.line, quote: 'Path=', rule: `${now.prefix}/** to ${now.service}` }] : [];
    const id = `gw:${rb.file}:${rb.prefix}`;
    let reached = 0;
    for (const c of ui.calls.filter((x) => under(x.tpl, rb.prefix) && !fh.gateway.some((r) => under(x.tpl, r.prefix)))) {
      const callHop: Hop = { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` };
      const risk = `Risk: it fails (404), because no gateway route forwards ${rb.prefix} any more${now ? ` (${rb.service} is now under ${now.prefix})` : ''}.`;
      const global = ui.globals.find((g) => callMadeBy(ui, ctx.closure(g.file), c));
      if (global) {
        const sid = `widget:${global.tag}`;
        ctx.surface({ id: sid, kind: 'widget', name: global.tag.replace(/^[a-z]+-/, (m) => (/^(app|jhi|ng|v)-$/.test(m) ? '' : m)).replace(/-/g, ' ').replace(/^\w/, (x) => x.toUpperCase()), where: `every screen · <${global.tag}>`, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: `Use <${global.tag}> for what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: `It works. ${risk}`, before: 'Worked.', after: 'Not forwarded.', proof: 'derived', hops: [goneHop, ...nowHop, callHop] });
        reached++;
      }
      for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), c))) {
        const sid = `screen:${rt.path}`;
        const title = screenTitle(ui.components.get(rt.component), rt.path);
        ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: id, tier: 'test-first', do: `Open ${title} and use what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: `It works. ${risk}`, before: 'Worked.', after: 'Not forwarded.', proof: 'derived', hops: [goneHop, ...nowHop, callHop, { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
        reached++;
      }
    }
    // the route's own lines are the change; nothing else in the file is claimed here
    for (const n of cf.headLines) if (now && Math.abs(n - now.line) <= 2) ctx.follow(cf.path, n);
    for (const n of cf.baseLines) if (Math.abs(n - rb.line) <= 2) ctx.follow(cf.path, n, 'base');
    ctx.deltas.push({ id, kind: 'code-changed', title: `gateway: ${rb.prefix}/** ${now ? `now ${now.prefix}/**` : 'no longer forwarded'} (${rb.service})`, endpoint: '', rules: [], causes: [goneHop] });
    if (!reached) ctx.unseen.push({ what: `callers of ${rb.prefix}/** outside this repository`, why: `the gateway no longer forwards ${rb.prefix} to ${rb.service}`, resolve: 'check the gateway access logs for that path before release' });
  }

  /* ---------- images, fonts and other served files: wherever the app names them ---------- */
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'asset') continue;
    const atHead = cf.status !== 'deleted';
    const u = atHead ? ui : ub;
    const S = atHead ? H : B;
    const name = fileName(cf.path);
    // a reference names this file when the path it writes is the end of this file's path: content/logo.svg, not another logo.svg
    const re = new RegExp(`['"(\\s]([^'"()\\s]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})['")?#\\s]`, 'g');
    const mine = (ref: string): boolean => { const r = ref.replace(/^(\.{1,2}\/)+|^\/+|^~\//, ''); return cf.path === r || cf.path.endsWith(`/${r}`); };
    const users: { file: string; line: number }[] = [];
    for (const f of S.files) {
      if (!/\.(s?css|sass|less|styl|vue|[mc]?[jt]sx?|html?|json)$/.test(f) || /node_modules\//.test(f) || fileKind(f) === 'test') continue;
      const lines = (S.read(f) ?? '').split('\n');
      const i = lines.findIndex((l) => [...` ${l} `.matchAll(re)].some((m) => mine(m[1]!)));
      if (i >= 0) users.push({ file: f, line: i + 1 });
    }
    // named nowhere a screen can be traced from: left unfollowed, so it is said and no screen is skipped
    if (!users.length) continue;
    const changed: Hop = atHead ? { label: 'Changed', file: cf.path, line: 1, quote: '', rule: `${name} changed` } : { label: 'Deleted', file: cf.path, line: 1, quote: '', side: 'base', rule: `${name} was deleted` };
    const comps = users.map((x) => ({ x, comp: u.components.get(x.file) ?? [...u.components.values()].find((c) => c.elements.some((e) => e.file === x.file)) }));
    // named by the page shell, a global stylesheet, a stylesheet we cannot trace, or a component on every screen: every screen
    const every = comps.some(({ x, comp }) => (/\.html?$/.test(x.file) && !comp) || (!comp && /\.(s?css|sass|less|styl)$/.test(x.file)) || (comp && everyScreen(u, S, comp.file)));
    const id = `asset:${cf.path}`;
    const what = `${name} (${/\.(woff2?|ttf|otf|eot)$/i.test(name) ? 'a font' : 'an image'})`;
    let reached = 0;
    if (every) {
      const use = comps.find(({ x, comp }) => (/\.html?$/.test(x.file) && !comp) || !comp || everyScreen(u, S, comp.file))!.x;
      ctx.surface({ id: 'screen:*', kind: 'screen', name: 'Every screen', where: `${u.routes.length} screens`, tier: 'test-next' });
      ctx.addCase({ surface: 'screen:*', delta: id, tier: 'test-next', do: `Open the app and check where ${what} shows.`, expect: 'It shows as intended, at the right size, in light and dark.', before: 'As released.', after: `${name} changed.`, proof: 'derived', hops: [changed, { label: 'Used by', file: use.file, line: use.line, quote: name, rule: `${fileName(use.file)} names ${name}` }] });
      reached = 1;
    } else {
      for (const r of allScreens(u)) {
        const hit = comps.find(({ comp }) => {
          if (!comp) return false;
          const seen = new Set<string>();
          const walk = (f: string, d: number): boolean => { if (f === comp.file) return true; if (seen.has(f) || d > 8) return false; seen.add(f); return (u.components.get(f)?.deps ?? []).some((y) => walk(y, d + 1)); };
          return walk(r.component, 0);
        });
        if (!hit) continue;
        const sid = `screen:${r.path}`;
        const title = screenTitle(u.components.get(r.component), r.path);
        ctx.surface({ id: sid, kind: 'screen', name: title, where: r.path, tier: 'test-next' });
        ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Open ${title} and check ${what}.`, expect: 'It shows as intended, at the right size.', before: 'As released.', after: `${name} changed.`, proof: 'derived', hops: [changed, { label: 'Used by', file: hit.x.file, line: hit.x.line, quote: name, rule: `${fileName(hit.x.file)} names ${name}` }, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }] });
        reached++;
      }
    }
    if (!reached) continue;
    if (!cf.binary && atHead) for (const n of cf.headLines) ctx.follow(cf.path, n);
    if (!cf.binary) for (const n of cf.baseLines) ctx.follow(cf.path, n, 'base');
    ctx.deltas.push({ id, kind: 'ui-changed', title: `${what} changed`, endpoint: '', rules: [], causes: [changed] });
  }

  /* ---------- dependencies: which modules use what moved ---------- */
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'dependencies' || cf.status === 'deleted') continue;
    const name = fileName(cf.path);
    if (name === 'pom.xml') { followCompiler(cf); followPom(ctx, cf, consumersOfModule); }
    else if (name === 'package.json') followPackageJson(ctx, cf);
    else if (/lock/.test(name)) {
      // lockfiles move with their manifest; a lock-only change moves versions with no manifest line
      const manifest = cf.path.replace(/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/, 'package.json');
      if (!ctx.changes.some((c) => c.path === manifest)) ctx.unseen.push({ what: `${cf.path} changed with no change to ${fileName(manifest)}`, why: 'resolved versions moved; which packages moved is not read yet', resolve: 'diff the lockfile for packages the app imports', files: [cf.path] });
      for (const n of cf.headLines) ctx.follow(cf.path, n);
    }
  }

  /**
   * How javac is told to compile: with -parameters off (Spring Boot's parent turns it on), Spring 6.1 can no longer
   * bind a @PathVariable or @RequestParam that has no name of its own. Those endpoints fail; the rest are as before.
   * Any other change to the compiler plugin (the release, annotation processors, arguments) is said, not passed over.
   */
  function followCompiler(cf: ChangedFile): void {
    const head = H.read(cf.path) ?? '', base = B.read(cf.path) ?? '';
    if (compilerBlock(head) === compilerBlock(base) && compilerParams(head) === compilerParams(base)) return;
    const dir = cf.path.includes('/') ? cf.path.slice(0, cf.path.lastIndexOf('/')) : '';
    const root = /<modules>/.test(head);
    const mine = (e: Endpoint): boolean => root || !dir || e.module === dir || e.file.startsWith(`${dir}/`);
    const at = Math.max(1, head.split('\n').findIndex((l) => /maven-compiler-plugin|<parameters>|maven\.compiler\.parameters/.test(l)) + 1);
    const hop: Hop = { label: 'Build changed', file: cf.path, line: at, quote: (H.line(cf.path, at) ?? '').trim().slice(0, 24).trim(), rule: 'how javac compiles the code changed' };
    if (compilerParams(base) !== false && compilerParams(head) === false) {
      const id = `build:${cf.path}:parameters`;
      const why = 'javac no longer keeps parameter names, and this parameter has no name of its own';
      let n = 0;
      for (const e of fh.endpoints.filter(mine)) {
        const t = fh.javaFiles.get(e.file)?.types.find((x) => simple(x.name) === e.cls);
        const unnamed = (t?.methods ?? []).filter((m) => m.name === e.method).flatMap((m) => m.params).find((v) => v.annotations.some((a) => /^(PathVariable|RequestParam|RequestHeader|CookieValue|MatrixVariable|RequestAttribute|SessionAttribute)$/.test(a.name) && !annPairs(a).has('value') && !annPairs(a).has('name') && !(annPairs(a).size === 0 && annStrings(a).length)));
        if (!unnamed) continue;
        const pa = unnamed.annotations.find((a) => /^(PathVariable|RequestParam|RequestHeader|CookieValue|MatrixVariable|RequestAttribute|SessionAttribute)$/.test(a.name))!;
        n += consumers(e, [{ ...hop, rule: '<parameters>false</parameters>: javac no longer keeps parameter names' }, { label: 'Has no name', file: e.file, line: pa.line, quote: pa.name, rule: `@${pa.name} ${unnamed.type} ${unnamed.name} is bound by its parameter name, which is now gone` }], id, why);
      }
      for (const l of cf.headLines) ctx.follow(cf.path, l);
      if (n) ctx.deltas.push({ id, kind: 'code-changed', title: `${cf.path}: parameter names are no longer compiled in`, endpoint: '', rules: [], causes: [hop] });
      return;
    }
    ctx.unseen.push({ what: `the compiler settings in ${cf.path} changed`, why: 'they decide what the code compiles to (the Java release, annotation processors such as MapStruct or Lombok, compiler arguments); what that changes at run time is not read yet', resolve: 'build both commits and compare, or ask the developer what the change is for', files: [cf.path] });
  }

  function consumersOfModule(module: string, chain: Hop[], deltaId: string, why: string): number {
    let n = 0;
    for (const e of fh.endpoints.filter((x) => module === '*' || x.module === module || x.file.startsWith(module + '/'))) n += consumers(e, chain, deltaId, why);
    return n;
  }

  /* ---------- deployment files ---------- */
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'deploy' || cf.status === 'deleted') continue;
    const real = cf.headLines.filter((n) => !trivial((H.line(cf.path, n) ?? '').trim()));
    const removed = cf.hunks.filter((h) => !h.head.some((n) => !trivial((H.line(cf.path, n) ?? '').trim()))).flatMap((h) => h.base).filter((n) => !trivial((B.line(cf.path, n) ?? '').trim()));
    if (!real.length && !removed.length) continue;
    const sid = `deploy:${cf.path}`;
    ctx.surface({ id: sid, kind: 'deploy', name: `Deployment: ${fileName(cf.path)}`, where: cf.path, tier: 'watch' });
    const text = H.read(cf.path) ?? '';
    const lines = text.split('\n');
    const svcAt = (n: number): string | null => {
      for (let i = n - 1; i >= 0; i--) { const m = /^ {2}([\w.-]+):\s*$/.exec(lines[i]!); if (m) return m[1]!; if (/^\S/.test(lines[i]!)) break; }
      return null;
    };
    const items: { n: number; svc: string | null; t: string }[] = real.slice(0, 12).map((n) => ({ n, svc: svcAt(n), t: lines[n - 1]!.trim() }));
    // one check per service the file configures, listing what changed for it
    const bySvc = new Map<string, { n: number; t: string }[]>();
    for (const it of items) { const k = it.svc ?? ''; if (!bySvc.has(k)) bySvc.set(k, []); bySvc.get(k)!.push(it); }
    for (const [svc, its] of bySvc) {
      ctx.addCase({ surface: sid, delta: `deploy:${cf.path}`, tier: 'watch', field: svc || fileName(cf.path), do: `After deploy, check ${svc ? `the ${svc} service` : fileName(cf.path)}: ${its.map((i) => i.t).join(' · ')}`, expect: 'It starts and is reachable as configured.', before: '—', after: '—', proof: 'derived', hops: its.slice(0, 4).map((i) => ({ label: 'Deployment', file: cf.path, line: i.n, quote: snippet(i.t), rule: i.t })) });
    }
    if (removed.length) {
      const ts = removed.slice(0, 8).map((n) => ({ n, t: (B.line(cf.path, n) ?? '').trim() }));
      ctx.addCase({ surface: sid, delta: `deploy:${cf.path}`, tier: 'watch', field: fileName(cf.path), do: `After deploy, check nothing needed what was removed: ${ts.map((x) => x.t).join(' · ')}`, expect: 'The service starts and behaves the same without it.', before: '—', after: '—', proof: 'derived', hops: ts.slice(0, 4).map((x) => ({ label: 'Removed', file: cf.path, line: x.n, quote: snippet(x.t), side: 'base' as const, rule: `removed: ${x.t}` })) });
    }
    for (const n of real) ctx.follow(cf.path, n);
    for (const n of removed) ctx.follow(cf.path, n, 'base');
    ctx.deltas.push({ id: `deploy:${cf.path}`, kind: 'deploy-changed', title: `${fileName(cf.path)}: ${[...new Set(items.map((i) => i.svc).filter(Boolean))].join(', ') || 'deployment'} changed`, endpoint: '', rules: [], causes: real.length ? items.slice(0, 1).map((it) => ({ label: 'Deployment', file: cf.path, line: it.n, quote: snippet(it.t), rule: it.t })) : [{ label: 'Removed', file: cf.path, line: removed[0]!, quote: snippet(B.line(cf.path, removed[0]!)), side: 'base', rule: `removed: ${(B.line(cf.path, removed[0]!) ?? '').trim()}` }] });
    // a deployment that turns a Spring profile on or off turns that profile's settings on or off: follow each of them
    const was = activeProfiles(B.read(cf.path) ?? ''), now = activeProfiles(text);
    const flipped = [...now, ...was].filter((p) => now.has(p) !== was.has(p));
    for (const prof of new Set(flipped)) {
      const on = now.has(prof);
      const at = Math.max(1, lines.findIndex((l) => new RegExp(`\\b${prof}\\b`).test(l)) + 1);
      const pHop: Hop = { label: on ? 'Profile turned on' : 'Profile turned off', file: cf.path, line: on ? at : 1, quote: on ? prof : '', rule: `${fileName(cf.path)} ${on ? 'activates' : 'no longer activates'} the Spring profile "${prof}"` };
      for (const pf of H.files.filter((f) => new RegExp(`(^|/)application-${prof}\\.(ya?ml|properties)$`).test(f))) {
        const pl = (H.read(pf) ?? '').split('\n');
        const module = fh.moduleOf(pf);
        const id = `profile:${cf.path}:${prof}:${pf}`;
        let n = 0;
        for (let i = 1; i <= pl.length; i++) {
          if (!/\S.*[:=]\s*\S/.test(pl[i - 1] ?? '') || /^\s*#/.test(pl[i - 1] ?? '')) continue;
          const key = /\.ya?ml$/.test(pf) ? yamlKey(pl, i) : /^\s*([\w.\-[\]]+)\s*[=:]/.exec(pl[i - 1]!)?.[1] ?? null;
          if (!key) continue;
          const kHop: Hop = { label: 'Its setting', file: pf, line: i, quote: snippet(pl[i - 1]!), rule: `${key} is set in ${fileName(pf)}` };
          const why = `${key} ${on ? 'now takes' : 'no longer takes'} its value from ${fileName(pf)}`;
          const rds = configReaders(fh, key);
          if (rds.length) for (const rd of rds) for (const r of reachFrom(fh, rd.at)) n += entry(r, [pHop, kHop, { label: 'Reads it', file: rd.file, line: rd.line, quote: rd.quote, rule: rd.how }, ...r.hops], id, why);
          else if (/^(spring|server)\./.test(key)) for (const e of fh.endpoints.filter((x) => x.module === module)) n += consumers(e, [pHop, kHop], id, why);
        }
        if (n) ctx.deltas.push({ id, kind: 'code-changed', title: `${fileName(cf.path)} ${on ? 'turns on' : 'turns off'} the "${prof}" profile (${fileName(pf)})`, endpoint: '', rules: [], causes: [pHop] });
        else ctx.unseen.push({ what: `${fileName(cf.path)} ${on ? 'turns on' : 'turns off'} the "${prof}" profile`, why: `the settings of ${pf} ${on ? 'now apply' : 'no longer apply'} where this is deployed, and Teslon found no code that reads them`, resolve: `check what ${fileName(pf)} sets`, files: [cf.path, pf] });
      }
    }
  }

  /* ---------- start-up: a change that stops a service from starting stops every API and job of it ---------- */
  for (const risk of startupRisks(B, H, fb, fh, ctx.changes)) {
    const id = `startup:${risk.module}:${risk.hop.file}:${risk.hop.line}`;
    const why = `${risk.module || 'the service'} may not start: ${risk.reason}`;
    if (!risk.certain) {
      ctx.unseen.push({ what: risk.reason, why: `if it is so, ${risk.module || 'the service'} does not start, and every API and job of it is down`, resolve: 'start the service once on this commit, or ask the developer', files: [risk.hop.file] });
      ctx.holdAll?.push(`${risk.module || 'the service'} may not start (${risk.reason}), so nothing can be ruled out`);
      continue;
    }
    let n = 0;
    for (const e of fh.endpoints.filter((x) => x.module === risk.module)) n += consumers(e, [risk.hop], id, why);
    for (const l of fh.listeners.filter((x) => x.module === risk.module)) n += entry({ kind: 'listener', at: `${l.cls}.${l.method}`, hops: [] }, [risk.hop], id, why);
    ctx.follow(risk.hop.file, risk.hop.line, risk.hop.side === 'base' ? 'base' : undefined);
    ctx.deltas.push({ id, kind: 'code-changed', title: `${risk.module || 'The service'} may not start: ${risk.reason}`, endpoint: '', rules: [], causes: [risk.hop] });
    if (!n) ctx.unseen.push({ what: risk.reason, why: 'the service may not start, and Teslon sees no API or job of it to list', resolve: 'start the service once on this commit', files: [risk.hop.file] });
  }
}

/* ---------- Maven ---------- */

/** The maven-compiler-plugin block, whitespace folded: what javac is told. */
function compilerBlock(text: string): string {
  const m = /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>maven-compiler-plugin<\/artifactId>(?:(?!<\/plugin>)[\s\S])*?<\/plugin>/.exec(text);
  return (m?.[0] ?? '').replace(/\s+/g, ' ');
}
/** Whether javac keeps parameter names: on under Spring Boot's parent, unless the plugin or a property turns it off. */
function compilerParams(text: string): boolean | null {
  const plug = compilerBlock(text);
  if (/-parameters\b/.test(plug)) return true;
  const flag = /<parameters>\s*(true|false)\s*<\/parameters>/.exec(plug)?.[1];
  if (flag) return flag === 'true';
  const prop = /<maven\.compiler\.parameters>\s*(true|false)\s*<\/maven\.compiler\.parameters>/.exec(text)?.[1];
  if (prop) return prop === 'true';
  return /<artifactId>spring-boot-starter-parent<\/artifactId>/.test(text) ? true : null;
}

interface PomDep { readonly key: string; readonly version: string; readonly line: number }

function readPom(text: string): { deps: PomDep[]; props: Map<string, { value: string; line: number }>; parent: PomDep | null; modules: string[]; buildStart: number; buildEnd: number; inert: (line: number) => boolean } {
  const lineAt = (i: number): number => text.slice(0, i).split('\n').length;
  const deps: PomDep[] = [];
  const props = new Map<string, { value: string; line: number }>();
  const propsBlock = /<properties>([\s\S]*?)<\/properties>/.exec(text);
  if (propsBlock) for (const m of propsBlock[1]!.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) props.set(m[1]!, { value: m[2]!.trim(), line: lineAt(propsBlock.index! + propsBlock[0].indexOf(m[0])) });
  const resolve = (v: string): string => v.replace(/\$\{([\w.-]+)\}/g, (_x, k: string) => props.get(k)?.value ?? `\${${k}}`);
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = /<groupId>([^<]+)<\/groupId>/.exec(m[1]!)?.[1]?.trim();
    const a = /<artifactId>([^<]+)<\/artifactId>/.exec(m[1]!)?.[1]?.trim();
    const v = /<version>([^<]+)<\/version>/.exec(m[1]!)?.[1]?.trim() ?? '';
    if (g && a) deps.push({ key: `${g}:${a}`, version: resolve(v), line: lineAt(m.index!) });
  }
  const pm = /<parent>([\s\S]*?)<\/parent>/.exec(text);
  const parent = pm ? { key: `${/<groupId>([^<]+)/.exec(pm[1]!)?.[1] ?? ''}:${/<artifactId>([^<]+)/.exec(pm[1]!)?.[1] ?? ''}`, version: resolve(/<version>([^<]+)/.exec(pm[1]!)?.[1] ?? ''), line: lineAt(pm.index!) } : null;
  const modules = [...text.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1]!.trim());
  const b = /<build>[\s\S]*?<\/build>/.exec(text);
  // build sections (also inside profiles) and project metadata decide how it is built and described, not what runs
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(/<(build|name|description|url|licenses|developers|contributors|scm|issueManagement|ciManagement|organization|inceptionYear|distributionManagement|reporting|pluginRepositories)>[\s\S]*?<\/\1>/g)) ranges.push([lineAt(m.index!), lineAt(m.index! + m[0].length)]);
  const inert = (line: number): boolean => ranges.some(([a, z]) => line >= a && line <= z);
  return { deps, props, parent, modules, buildStart: b ? lineAt(b.index!) : 0, buildEnd: b ? lineAt(b.index! + b[0].length) : 0, inert };
}

function followPom(ctx: WhereCtx, cf: ChangedFile, consumersOfModule: (module: string, chain: Hop[], id: string, why: string) => number): void {
  const head = readPom(ctx.H.read(cf.path) ?? '');
  const base = readPom(ctx.B.read(cf.path) ?? '');
  const dir = cf.path.includes('/') ? cf.path.slice(0, cf.path.lastIndexOf('/')) : '';
  const moved: { key: string; from: string; to: string; line: number }[] = [];
  const bmap = new Map(base.deps.map((d) => [d.key, d]));
  for (const d of head.deps) {
    const b = bmap.get(d.key);
    if (!b) moved.push({ key: d.key, from: '(new)', to: d.version || 'managed', line: d.line });
    else if (b.version !== d.version) moved.push({ key: d.key, from: b.version || 'managed', to: d.version || 'managed', line: d.line });
  }
  for (const b of base.deps) if (!head.deps.some((d) => d.key === b.key)) moved.push({ key: b.key, from: b.version || 'managed', to: '(removed)', line: 0 });
  if (head.parent && base.parent && head.parent.version !== base.parent.version) moved.push({ key: head.parent.key, from: base.parent.version, to: head.parent.version, line: head.parent.line });
  // a version property that moved moves every dependency or BOM that reads it
  for (const [k, p] of head.props) {
    const b = base.props.get(k);
    if (b && b.value !== p.value && /version/i.test(k) && !moved.some((m) => m.line === p.line)) moved.push({ key: k, from: b.value, to: p.value, line: p.line });
  }
  const buildOnly = cf.headLines.filter((n) => head.inert(n));
  for (const n of buildOnly) ctx.follow(cf.path, n);
  if (!moved.length) {
    const headText = ctx.H.read(cf.path) ?? '', baseText = ctx.B.read(cf.path) ?? '';
    const compilerMoved = compilerBlock(headText) !== compilerBlock(baseText) || compilerParams(headText) !== compilerParams(baseText);
    if (!compilerMoved && cf.headLines.every((n) => head.inert(n) || !(ctx.H.line(cf.path, n) ?? '').trim()) && cf.baseLines.every((n) => base.inert(n) || !(ctx.B.line(cf.path, n) ?? '').trim())) {
      ctx.noEffect(cf.path, 'build section or project metadata of pom.xml: it changes how the service is built, not what it runs');
    }
    return;
  }
  const root = !!head.modules.length;
  const modules = root ? '*' : dir;
  const service = root ? 'every module' : (ctx.fh.services.get(dir) ?? dir);
  const id = `deps:${cf.path}`;
  const sid = `module:${modules}`;
  const say = (m: { key: string; from: string; to: string }): string => (m.from === '(new)' ? `${m.key} added${m.to !== 'managed' ? ` (${m.to})` : ''}` : m.to === '(removed)' ? `${m.key} removed` : `${m.key} ${m.from} → ${m.to}`);
  const list = moved.slice(0, 6).map(say).join('; ');
  const web = moved.filter((m) => /^org\.webjars:/.test(m.key));
  const hops: Hop[] = moved.filter((m) => m.line).slice(0, 4).map((m) => ({ label: 'Dependency', file: cf.path, line: m.line, quote: '', rule: say(m) }));
  ctx.surface({ id: sid, kind: 'module', name: root ? 'Every service' : service, where: root ? head.modules.join(', ') : dir, tier: 'test-next' });
  ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Regression on ${service}: its APIs and the screens that use them (listed under each API).`, expect: `Works as before with ${list}. Read the release notes of what moved for breaking changes.`, before: 'As released.', after: 'New library versions.', proof: 'derived', hops });
  const why = `${root ? 'every module' : service} now builds with ${list}`;
  consumersOfModule(modules, hops.slice(0, 1), id, why);
  if (web.length) {
    ctx.surface({ id: 'screen:*', kind: 'screen', name: 'Every screen', where: `${ctx.ui.routes.length} screens`, tier: 'test-next' });
    ctx.addCase({ surface: 'screen:*', delta: id, tier: 'test-next', do: `Open each screen and check how it looks: ${web.map((w) => `${w.key} ${w.from} → ${w.to}`).join('; ')} is served to the browser.`, expect: 'Looks and behaves as before.', before: 'As released.', after: 'New front-end library.', proof: 'derived', hops: hops.filter((h) => /webjars/.test(h.rule)) });
  }
  for (const m of cf.headLines) if (!buildOnly.includes(m)) ctx.follow(cf.path, m);
  for (const m of cf.baseLines) ctx.follow(cf.path, m, 'base');
  ctx.deltas.push({ id, kind: 'dependency-changed', title: `${cf.path}: ${list}${moved.length > 6 ? ` +${moved.length - 6}` : ''}`, endpoint: '', rules: [], causes: hops.slice(0, 1) });
}

/* ---------- npm ---------- */

function followPackageJson(ctx: WhereCtx, cf: ChangedFile): void {
  let head: Record<string, Record<string, string>> = {}, base: Record<string, Record<string, string>> = {};
  try { head = JSON.parse(ctx.H.read(cf.path) ?? '{}'); } catch { /* unreadable */ }
  try { base = JSON.parse(ctx.B.read(cf.path) ?? '{}'); } catch { /* new file */ }
  const text = ctx.H.read(cf.path) ?? '';
  const lineOf = (k: string): number => text.split('\n').findIndex((l) => l.includes(`"${k}"`)) + 1;
  const moved: { name: string; from: string; to: string; dev: boolean }[] = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const h = head[section] ?? {}, b = base[section] ?? {};
    for (const [k, v] of Object.entries(h)) if (b[k] !== v) moved.push({ name: k, from: b[k] ?? '(new)', to: v, dev: section === 'devDependencies' });
    for (const k of Object.keys(b)) if (!(k in h)) moved.push({ name: k, from: b[k]!, to: '(removed)', dev: section === 'devDependencies' });
  }
  // a dev dependency ships nothing, unless it builds what ships: the compiler, the bundler, CSS tooling
  const CHECK_ONLY = /^(eslint|prettier|stylelint|husky|lint-staged|commitlint|jest|jasmine|karma|vitest|cypress|playwright|@playwright\/|@types\/|@testing-library\/|@commitlint\/|@angular-eslint\/|typescript-eslint|@typescript-eslint\/|eslint-|prettier-|jasmine-|karma-|jest-|ts-jest|@vitest\/|cypress-|start-server-and-test|npm-run-all|rimraf|cross-env|concurrently)/;
  const BUILDS = /^(@angular\/build|@angular\/cli|@angular\/compiler-cli|@angular-devkit\/|typescript|vite|@vitejs\/|webpack|@babel\/|babel-|esbuild|rollup|@rollup\/|terser|sass|postcss|autoprefixer|tailwindcss|@tailwindcss\/|less|@vue\/compiler-sfc|vue-loader|@vue\/cli|next|parcel|swc|@swc\/)/;
  const devCheck = moved.filter((m) => m.dev && CHECK_ONLY.test(m.name));
  const devBuild = moved.filter((m) => m.dev && !CHECK_ONLY.test(m.name) && BUILDS.test(m.name));
  const devUnknown = moved.filter((m) => m.dev && !CHECK_ONLY.test(m.name) && !BUILDS.test(m.name));
  const runtime = [...moved.filter((m) => !m.dev), ...devBuild];
  // the lines of an unknown dev tool stay unfollowed, so they are said and nothing is skipped
  const unknownLines = new Set(devUnknown.map((m) => lineOf(m.name)).filter((n) => n > 0));
  for (const n of cf.headLines) if (!unknownLines.has(n)) ctx.follow(cf.path, n);
  if (!runtime.length) {
    if (devCheck.length && !devUnknown.length) ctx.noEffect(cf.path, `only tools that check the code moved (${devCheck.slice(0, 4).map((m) => m.name).join(', ')}): nothing they do ships`);
    return;
  }
  const dir = cf.path.includes('/') ? cf.path.slice(0, cf.path.lastIndexOf('/') + 1) : '';
  const id = `deps:${cf.path}`;
  // the framework, or the tools that build the bundle: every screen
  const framework = runtime.filter((m) => /^(vue|vue-router|react|react-dom|@angular\/core|@angular\/router|svelte|axios|rxjs|zone\.js|tslib)$/.test(m.name) || devBuild.includes(m));
  const hops: Hop[] = runtime.slice(0, 4).map((m) => ({ label: 'Dependency', file: cf.path, line: lineOf(m.name) || 1, quote: lineOf(m.name) ? m.name : '', rule: `${m.name} ${m.from} → ${m.to}` }));
  const list = runtime.slice(0, 6).map((m) => `${m.name} ${m.from} → ${m.to}`).join('; ');
  if (framework.length) {
    ctx.surface({ id: 'screen:*', kind: 'screen', name: 'Every screen', where: `${ctx.ui.routes.length} screens`, tier: 'test-next' });
    ctx.addCase({ surface: 'screen:*', delta: id, tier: 'test-next', do: `Open each screen and use it: ${framework.map((m) => m.name).join(', ')} moved.`, expect: 'Works as before.', before: 'As released.', after: `${list}.`, proof: 'derived', hops });
  }
  for (const m of runtime.filter((x) => !framework.includes(x))) {
    const users = [...ctx.ui.components.values()].filter((c) => c.file.startsWith(dir) && c.packages.includes(m.name));
    for (const r of ctx.ui.routes) {
      const user = users.find((u) => ctx.closure(r.component).has(u.file));
      if (!user) continue;
      const sid = `screen:${r.path}`;
      ctx.surface({ id: sid, kind: 'screen', name: screenTitle(ctx.ui.components.get(r.component), r.path), where: r.path, tier: 'test-next' });
      const importAt = (ctx.H.read(user.file) ?? '').split('\n').findIndex((l) => /^\s*import\b/.test(l) && (l.includes(`'${m.name}`) || l.includes(`"${m.name}`))) + 1;
      ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Use the parts of this screen drawn with ${m.name}.`, expect: 'Works as before.', before: 'As released.', after: `${m.name} ${m.from} → ${m.to}.`, proof: 'derived', hops: [...hops.filter((h) => h.rule.startsWith(m.name)), { label: 'Imports it', file: user.file, line: importAt || 1, quote: importAt ? m.name : '', rule: `${fileName(user.file)} imports ${m.name}` }, { label: 'Screen', file: r.file, line: r.line, quote: routeQuote(r), rule: `route ${r.path}` }] });
    }
  }
  ctx.deltas.push({ id, kind: 'dependency-changed', title: `${cf.path}: ${list}`, endpoint: '', rules: [], causes: hops.slice(0, 1) });
}
