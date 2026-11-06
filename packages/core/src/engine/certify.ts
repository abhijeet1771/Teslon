import { createHash } from 'node:crypto';
import type { Snapshot, ChangedFile } from './snapshot.js';
import { templateHits, throughGateway, flattenYaml, type SpringFacts, type Endpoint } from './spring.js';
import type { FrontendFacts, Component } from './vue.js';
import type { JType, JMethod, JAnnotation, Tok } from './java.js';
import { fileKind } from './kinds.js';
import { startupRisks, activeProfiles } from './startup.js';

/**
 * Skip certificates, and the checker that issues them.
 *
 * A SKIP says: nothing this area runs, shows or depends on was changed. This file proves that, or refuses
 * it, without the engine's rules. It shares only what the readers found (and the texts of both commits).
 * From those it builds one dependency graph over base ∪ head, works out on its own what changed (Δ) by
 * comparing definitions, and collects what the facts cannot pin down (unknowns).
 *
 * For each area the engine skips, the certificate is the closure S of what the area depends on. It holds
 * when S ∩ Δ = ∅ and S holds no unknown. Pure logic over facts: no model, no network, no guess.
 */

export interface Cite { readonly file: string; readonly line: number; readonly side?: 'base' }
export interface Blocker {
  readonly kind: 'changed' | 'unknown';
  readonly node: string;
  readonly what: string;
  readonly at: Cite;
  /** The chain of nodes from the area to the blocker, and what each one is, for the nodes that name a place in the code. */
  readonly path: readonly string[];
  readonly chain: readonly string[];
}
export interface Certificate {
  readonly area: string;
  /** No changed definition and no unknown is reached through code the area runs. */
  readonly ok: boolean;
  /** What the closure holds: nodes, and the files they come from. */
  readonly nodes: number;
  readonly files: number;
  /** sha256 over the sorted closure and the sorted Δ: the same inputs give the same proof. */
  readonly digest: string;
  /** What stops the skip: changed code or an unknown the area runs into. Empty when ok. */
  readonly blockers: readonly Blocker[];
  /**
   * Changed definitions the area reaches only as content: a value's shape, a field, rows another method writes,
   * what a producer puts on a topic. The skip relies on the engine's field-level and data-flow analysis for these.
   */
  readonly relies: readonly Blocker[];
}
export interface UnknownEntry {
  readonly id: string;
  readonly kind: string;
  readonly what: string;
  readonly at: Cite;
  /** Areas whose skip this unknown blocks. */
  readonly blocks: readonly string[];
}
export interface Certification {
  readonly proofs: readonly Certificate[];
  readonly unknowns: readonly UnknownEntry[];
  /** How many definitions changed, by kind of node. */
  readonly changed: Readonly<Record<string, number>>;
  /** Calls to app methods whose target the facts do not pin down; each is widened to every method of that name. */
  readonly dangling: { readonly calls: number; readonly widened: number; readonly rate: number; /** Browser calls that match no endpoint here. */ readonly unmatched: number };
  readonly assumptions: readonly { readonly text: string; readonly uses: number }[];
  readonly ms: number;
}

export interface CertifyInput {
  readonly base: Snapshot;
  readonly head: Snapshot;
  readonly fb: SpringFacts;
  readonly fh: SpringFacts;
  readonly ub: FrontendFacts;
  readonly uh: FrontendFacts;
  readonly changes: readonly ChangedFile[];
  /** The areas to certify: `screen:/orders`, `job:Cls.method`. */
  readonly areas: readonly string[];
}

const simple = (n: string): string => n.split('.').pop() ?? n;
const base = (p: string): string => p.split('/').pop() ?? p;
const strip = (t: string): string => t.replace(/<.*$/s, '').replace(/\[\]$/, '');
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'throw', 'super', 'this', 'assert', 'try', 'else', 'do', 'case', 'yield']);
const BEAN = /^(Service|Component|Repository|Controller|RestController|Configuration|ControllerAdvice|RestControllerAdvice|FeignClient|Mapper|Aspect|SpringBootApplication|Named|Singleton|EnableWebSecurity|AutoConfiguration)$/;
const ENTRY = /^(RestController|Controller|SpringBootApplication)$/;
const CONSTRAINT = /^(NotNull|NotBlank|NotEmpty|Size|Min|Max|Past|PastOrPresent|Future|FutureOrPresent|Pattern|Email|Positive|PositiveOrZero|Negative|NegativeOrZero|Digits|DecimalMin|DecimalMax|AssertTrue|AssertFalse|Length|Valid)$/;
const ACCESSOR = /^(get[A-Z]\w*|is[A-Z]\w*|set[A-Z]\w*|toString|equals|hashCode|compareTo|values|valueOf)$/;
const LIFECYCLE = /^(PrePersist|PostPersist|PreUpdate|PostUpdate|PreRemove|PostRemove|PostLoad|JsonValue|JsonCreator|JsonGetter|JsonSetter|JsonProperty|JsonAnyGetter|JsonAnySetter)$/;
const HTTP_CLIENT = /^(RestTemplate|RestOperations|AsyncRestTemplate|RestClient|WebClient|HttpClient|OkHttpClient|CloseableHttpClient|HttpURLConnection)$/;
const WRITE_VERB = /^(save|saveAll|saveAndFlush|saveAllAndFlush|delete\w*|remove\w*|insert\w*|update\w*|persist|merge|flush|executeUpdate|batchUpdate|upsert\w*)$/;
const SQL_TABLES = /\b(?:from|join|into|update|table(?:\s+if\s+(?:not\s+)?exists)?|truncate)\s+["`]?([A-Za-z_][\w.]*)/gi;
const WEB_ANN = /^(ControllerAdvice|RestControllerAdvice|EnableWebSecurity|EnableWebMvc|EnableWebFluxSecurity|EnableMethodSecurity)$/;
const WEB_TYPE = /^(Filter|OncePerRequestFilter|GenericFilterBean|HandlerInterceptor|AsyncHandlerInterceptor|WebMvcConfigurer|WebFluxConfigurer|HandlerMethodArgumentResolver|ResponseBodyAdvice|RequestBodyAdvice|ErrorController|WebSecurityConfigurerAdapter|SecurityFilterChain|SecurityWebFilterChain|CorsConfigurationSource|CorsFilter|FilterRegistrationBean|WebFilter|GlobalFilter|GatewayFilter|RouteLocator|AuthenticationManager|UserDetailsService|PasswordEncoder|JwtDecoder)$/;
/** What Spring Data's own repository methods return: a repository method the app does not declare. */
const SPRING_DATA: Record<string, string> = { findById: 'Optional', findAll: 'List', findAllById: 'List', existsById: 'boolean', count: 'long', getById: 'Object', getReferenceById: 'Object', findOne: 'Optional', findBy: 'Optional' };
/** How far the rows an area reads are followed: to the code that writes them, within its own service. */
const DATA = (process.env['TESLON_CERT_DATA'] ?? 'full') as 'full' | 'hop' | 'service' | 'code';
const HTTP_VERB = /^(get|post|put|patch|delete|head|options|method|retrieve|exchange|exchangeToMono|exchangeToFlux|getForObject|getForEntity|postForObject|postForEntity|postForLocation|patchForObject|execute|send|sendAsync|newCall)$/;
const ADVICE = /^(Around|Before|After|AfterReturning|AfterThrowing|Pointcut)$/;
/** Framework settings that configure one client bean, and the types it is injected as. */
const CLIENT_KEYS: [RegExp, RegExp][] = [
  [/^spring\.mail(\.|$)/, /^(JavaMailSender|MailSender|JavaMailSenderImpl)$/],
  [/^spring\.rabbitmq(\.|$)/, /^(RabbitTemplate|AmqpTemplate|RabbitOperations|RabbitAdmin)$/],
  [/^spring\.(data\.)?redis(\.|$)/, /^(RedisTemplate|StringRedisTemplate|ReactiveRedisTemplate|RedisConnectionFactory)$/],
  [/^spring\.cache(\.|$)/, /^(CacheManager|Cache)$/],
  // Jackson: every JSON response of the service (above), and the code that holds the ObjectMapper itself
  [/^spring\.jackson(\.|$)/, /^(ObjectMapper|JsonMapper|Jackson2ObjectMapperBuilder)$/],
];
/** Settings that change nothing a user sees: logging, the actuator, build info, API docs. */
const INERT_SETTING = /^(logging|management|info|springdoc|spring\.devtools|spring\.output|spring\.main\.banner)/;

/** Lines of a text with what does not change behaviour dropped: blank lines and whole-line comments. */
function norm(lines: readonly string[]): string {
  const out: string[] = [];
  let block = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (block) { if (l.includes('*/')) block = false; continue; }
    if (!l || l.startsWith('//')) continue;
    if (l.startsWith('/*')) { if (!l.includes('*/')) block = true; continue; }
    out.push(l.replace(/\s+/g, ' '));
  }
  return out.join('\n');
}

/** Line ranges of every `{ … }` in a source text, strings and comments skipped. */
function braceSpans(text: string): { from: number; to: number }[] {
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

/** Import statements of a JS/TS text: the names each binds and the lines it spans. */
function importsOf(text: string): { names: string[]; from: number; to: number; src: string }[] {
  const out: { names: string[]; from: number; to: number; src: string }[] = [];
  const re = /^\s*import\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]\s*;?|^\s*import\s*['"]([^'"]+)['"]\s*;?/gm;
  for (const m of text.matchAll(re)) {
    const from = text.slice(0, m.index).split('\n').length;
    const to = from + (m[0].match(/\n/g)?.length ?? 0);
    const names = (m[1] ?? '').replace(/[{}*]/g, ' ').split(/[\s,]+/).filter((x) => x && x !== 'as' && x !== 'type').map((x) => x.trim());
    out.push({ names, from, to, src: m[2] ?? m[3] ?? '' });
  }
  return out;
}

/** The dotted key a line of a YAML file sets or sits under; for a properties file, the key on the line. */
function configKey(lines: readonly string[], n: number, props: boolean): string | null {
  const raw = lines[n - 1];
  if (raw === undefined || !raw.trim() || /^\s*#/.test(raw)) return null;
  if (props) { const m = /^\s*([\w.\-[\]]+)\s*[=:]/.exec(raw); return m ? m[1]! : null; }
  const indent = (s: string): number => s.length - s.trimStart().length;
  const own = /^(\s*)(["']?[\w.\-[\]]+["']?)\s*:/.exec(raw);
  const path: string[] = own && !/^\s*-/.test(raw) ? [own[2]!.replace(/^['"]|['"]$/g, '')] : [];
  let at = indent(raw.replace(/^(\s*)-\s*/, '$1  '));
  if (!own || /^\s*-/.test(raw)) at = indent(raw) + (/^\s*-/.test(raw) ? 0 : 1);
  for (let i = n - 2; i >= 0 && at > 0; i--) {
    const l = lines[i]!;
    if (!l.trim() || /^\s*#/.test(l) || /^\s*-/.test(l)) continue;
    if (/^---/.test(l)) break;
    const m = /^(\s*)(["']?[\w.\-[\]]+["']?)\s*:/.exec(l);
    if (m && m[1]!.length < at) { path.unshift(m[2]!.replace(/^['"]|['"]$/g, '')); at = m[1]!.length; }
  }
  return path.length ? path.join('.') : null;
}

function flattenProps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of text.split('\n')) { const m = /^\s*([\w.\-[\]]+)\s*[=:]\s*(.*)$/.exec(l); if (m && !/^\s*[#!]/.test(l)) out.set(m[1]!, m[2]!.trim()); }
  return out;
}

function flattenJson(v: unknown, prefix: string, out: Map<string, string>): void {
  if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) flattenJson(x, prefix ? `${prefix}.${k}` : k, out); return; }
  out.set(prefix, JSON.stringify(v));
}

/**
 * The names in a type as the reader wrote it. A type-use annotation is glued to the name after it
 * (`List<@ValidOrderLineRequest>`), so each capitalised tail of an annotated word is tried too.
 */
function words(t: string): string[] {
  const out: string[] = [];
  for (const w of t.split(/[^\w@]+/)) {
    if (!w.startsWith('@')) { if (w) out.push(w); continue; }
    for (let i = 2; i < w.length; i++) if (/[A-Z]/.test(w[i]!)) out.push(w.slice(i));
  }
  return out;
}
const relaxed = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');
const keysMeet = (a: string, b: string): boolean => { const x = relaxed(a), y = relaxed(b); return x === y || x.startsWith(`${y}.`) || y.startsWith(`${x}.`); };
const annText = (a: JAnnotation): string => `@${a.name}(${a.args.map((t) => t.t).join(' ')})`;
const toks = (ts: readonly Tok[]): string => ts.map((t) => t.t).join(' ');
const methodDef = (m: JMethod): string => `${m.annotations.map(annText).join(' ')} ${m.returnType} ${m.name}(${m.params.map((p) => `${p.annotations.map(annText).join(' ')} ${p.type} ${p.name}`).join(', ')}) { ${toks(m.body)} }`;
/** `${a.b:x}` and plain dotted strings: the setting keys a piece of code names. */
function keysIn(ts: readonly Tok[]): string[] {
  const out: string[] = [];
  for (const t of ts) {
    if (!/^"/.test(t.t)) continue;
    for (const m of t.t.matchAll(/\$\{([\w.\-[\]]+)(?::[^}]*)?\}/g)) out.push(m[1]!);
    const s = t.t.slice(1, -1);
    if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(s)) out.push(s);
  }
  return out;
}

class Graph {
  readonly edges = new Map<string, Set<string>>();
  readonly cite = new Map<string, Cite & { what: string }>();
  edge(a: string, b: string): void {
    if (a === b) return;
    let s = this.edges.get(a);
    if (!s) this.edges.set(a, (s = new Set()));
    s.add(b);
  }
  at(n: string, c: Cite & { what: string }): void { if (!this.cite.has(n)) this.cite.set(n, c); }
}

export function certify(inp: CertifyInput): Certification {
  const t0 = Date.now();
  const { base: B, head: H, fb, fh, ub, uh } = inp;
  const g = new Graph();
  /** Δ: node → why it changed, with where. */
  const delta = new Map<string, Cite & { what: string }>();
  const unknown = new Map<string, { kind: string; what: string; at: Cite }>();
  const assumed = new Map<string, number>();
  const assume = (text: string): void => { assumed.set(text, (assumed.get(text) ?? 0) + 1); };
  const changed = new Map(inp.changes.map((c) => [c.path, c]));
  const unknownAt = (from: string, kind: string, what: string, at: Cite): void => {
    const id = `unknown:${kind}:${at.file}:${at.line}`;
    if (!unknown.has(id)) unknown.set(id, { kind, what, at });
    g.edge(from, id);
  };
  const lineText = (c: Cite): string => ((c.side === 'base' ? B : H).line(c.file, c.line) ?? '').trim();

  /* ---------------- Java: types, members, and what each method depends on ---------------- */
  // every Java node is named by its module and simple class name: two services may both have an ApiExceptionHandler
  type Side = { f: SpringFacts; snap: Snapshot; side?: 'base' };
  type TypeRec = { t: JType; file: string; side?: 'base'; mod: string; cls: string };
  const sides: Side[] = [{ f: fh, snap: H }, { f: fb, snap: B, side: 'base' }];
  const moduleOf = (file: string): string => fh.moduleOf(file);
  const types = new Map<string, TypeRec[]>();
  const bySimple = new Map<string, Set<string>>();
  for (const s of sides) for (const [file, jf] of s.f.javaFiles) {
    if (s.side && !changed.has(file)) continue;
    for (const t of jf.types) {
      const cls = simple(t.name), mod = moduleOf(file), key = `${mod}/${cls}`;
      if (!types.has(key)) types.set(key, []);
      types.get(key)!.push({ t, file, mod, cls, ...(s.side ? { side: s.side } : {}) });
      if (!bySimple.has(cls)) bySimple.set(cls, new Set());
      bySimple.get(cls)!.add(key);
    }
  }
  const modOf = (key: string): string => key.slice(0, key.lastIndexOf('/'));
  const clsOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1);
  const anns = (t: JType): string[] => t.annotations.map((a) => a.name);
  /** Modules that run on their own (a @SpringBootApplication): one cannot call another's classes except over the network. */
  const deployable = new Set([...types].filter(([, ds]) => ds.some(({ t }) => anns(t).includes('SpringBootApplication'))).map(([k]) => modOf(k)));
  const visible = (from: string, key: string): boolean => modOf(key) === from || !deployable.has(modOf(key));
  const resolve = (cls: string, from: string): string[] => {
    const all = [...(bySimple.get(cls) ?? [])];
    const out = all.filter((k) => visible(from, k));
    if (all.length && !out.length) assume('A service reaches the classes of another service only over the network (HTTP, a broker): a class of the same name there is a different class.');
    return out;
  };
  const isApp = (cls: string, from: string): boolean => resolve(cls, from).length > 0;
  const entityTable = new Map<string, string>();
  for (const e of [...fh.entities, ...fb.entities]) { const k = `${moduleOf(e.file)}/${e.name}`; if (!entityTable.has(k)) entityTable.set(k, e.table.toLowerCase()); }
  const tableEntity = new Map([...entityTable].map(([e, t]) => [`${modOf(e)}/${t}`, e]));
  const entityOf = (cls: string, from: string): string | undefined => resolve(cls, from).find((k) => entityTable.has(k));
  const isRepoType = (t: JType): boolean => t.kind === 'interface' && t.supertypes.some((s) => /Repository$|Executor$/.test(simple(strip(s))));
  const isBean = (key: string): boolean => (types.get(key) ?? []).some(({ t }) => anns(t).some((a) => BEAN.test(a)) || isRepoType(t));
  const subtypes = new Map<string, Set<string>>();
  for (const [key, ds] of types) for (const { t } of ds) for (const s of t.supertypes) { const k = simple(strip(s)); if (!subtypes.has(k)) subtypes.set(k, new Set()); subtypes.get(k)!.add(key); }
  // implementations are beans, and so is what they are injected as
  const beans = new Set([...types.keys()].filter(isBean));
  for (const b of [...beans]) for (const s of (types.get(b) ?? []).flatMap(({ t }) => t.supertypes)) for (const k of resolve(simple(strip(s)), modOf(b))) if ((types.get(k) ?? []).some(({ t }) => t.kind === 'interface')) beans.add(k);
  const repoEntity = new Map<string, string>();
  for (const [key, ds] of types) for (const { t, file, side, cls, mod } of ds) {
    if (!isRepoType(t)) continue;
    const text = (side ? B : H).read(file) ?? '';
    const m = new RegExp(`interface\\s+${cls}\\b[^{]*?\\b\\w*(?:Repository|Executor)\\s*<\\s*([\\w.]+)`).exec(text);
    const e = m ? entityOf(simple(m[1]!), mod) : undefined;
    if (e) repoEntity.set(key, e);
  }
  // @ConditionalOnProperty: a bean the settings switch off on both sides is not run
  const settingOn = (mod: string, key: string): string | undefined => { for (const f of [fh, fb]) { const v = f.settings.get(mod)?.get(key); if (v !== undefined) return v; } return undefined; };
  const inactive = (key: string): boolean => (types.get(key) ?? []).every(({ t, mod }) => {
    const a = t.annotations.find((x) => x.name === 'ConditionalOnProperty');
    if (!a) return false;
    const txt = a.args.map((x) => x.t).join(' ');
    const prefix = /prefix\s*=\s*"([^"]+)"/.exec(txt)?.[1];
    const name = /(?:name|value)\s*=\s*"([^"]+)"/.exec(txt)?.[1] ?? /^"([^"]+)"$/.exec(txt.trim())?.[1];
    const having = /havingValue\s*=\s*"([^"]*)"/.exec(txt)?.[1];
    const ifMissing = /matchIfMissing\s*=\s*true/.test(txt);
    if (!name) return false;
    const k = prefix ? `${prefix}.${name}` : name;
    const vs = [fh, fb].map((f) => f.settings.get(mod)?.get(k));
    if (vs.some((v) => v === undefined)) return vs.every((v) => v === undefined) && !ifMissing;
    const off = (v: string): boolean => (having === undefined ? v === 'false' : v !== having);
    if (vs.every((v) => off(v!))) { assume('A bean whose @ConditionalOnProperty does not match the settings here is relied on as switched off: the deployed settings must be these.'); return true; }
    return false;
  });
  void settingOn;
  /** Field name → the data types that declare it. */
  const fieldIndex = new Map<string, Set<string>>();
  for (const [key, ds] of types) for (const { t } of ds) if (!isBean(key)) for (const fl of t.fields) { if (!fieldIndex.has(fl.name)) fieldIndex.set(fl.name, new Set()); fieldIndex.get(fl.name)!.add(key); }
  const methodsByName = new Map<string, Set<string>>();
  for (const [key, ds] of types) for (const { t, cls } of ds) for (const m of t.methods) if (m.name !== cls) { if (!methodsByName.has(m.name)) methodsByName.set(m.name, new Set()); methodsByName.get(m.name)!.add(key); }
  const declares = (key: string, m: string): boolean => (types.get(key) ?? []).some(({ t }) => t.methods.some((x) => x.name === m));
  /** What a call `key.m` from module `from` runs: the method, inherited, and every override below it that is created. */
  const targets = (key: string, m: string, from: string): string[] => {
    const out = new Set<string>();
    const up = (k: string, depth: number): void => {
      if (depth > 6) return;
      if (declares(k, m)) { out.add(`m:${k}.${m}`); return; }
      for (const { t } of types.get(k) ?? []) for (const s of t.supertypes) for (const sk of resolve(simple(strip(s)), modOf(k))) up(sk, depth + 1);
    };
    up(key, 0);
    const down = (k: string, depth: number): void => { if (depth > 6) return; for (const s of subtypes.get(clsOf(k)) ?? []) { if (!visible(from, s)) continue; if (declares(s, m)) out.add(`m:${s}.${m}`); down(s, depth + 1); } };
    down(key, 0);
    return [...out];
  };
  const callsOut = new Map<string, Set<string>>();
  for (const f of [fh, fb]) for (const e of f.callEdges) { const k = `${moduleOf(e.file)}/${e.from}`; if (!callsOut.has(k)) callsOut.set(k, new Set()); callsOut.get(k)!.add(e.to); }
  const javaCalls = new Map<string, SpringFacts['calls'][number][]>();
  for (const f of [fh, fb]) for (const c of f.calls) { const k = `${moduleOf(c.file)}/${c.cls}.${c.method}`; if (!javaCalls.has(k)) javaCalls.set(k, []); javaCalls.get(k)!.push(c); }
  const endpoints = [...fh.endpoints, ...fb.endpoints];
  const services = new Set(endpoints.map((e) => e.service).filter((s): s is string => !!s));
  const epId = (e: Endpoint): string => `ep:${e.service ?? ''}|${e.verb} ${e.path}`;
  for (const e of endpoints) {
    const mod = moduleOf(e.file);
    g.edge(epId(e), `m:${mod}/${e.cls}.${e.method}`);
    g.edge(epId(e), `web:${mod}`);
    g.edge(`web:${mod}`, `global:java:${mod}`);
    g.at(epId(e), { file: e.file, line: e.line, what: `${e.verb} ${e.path}`, ...(fh.endpoints.includes(e) ? {} : { side: 'base' as const }) });
  }
  const beanMakers = new Map<string, string[]>();
  for (const [key, ds] of types) for (const { t } of ds) for (const m of t.methods) if (m.annotations.some((a) => a.name === 'Bean')) { const r = `${modOf(key)}/${simple(strip(m.returnType))}`; if (!beanMakers.has(r)) beanMakers.set(r, []); beanMakers.get(r)!.push(`m:${key}.${m.name}`); }
  const makersOf = (cls: string, from: string): string[] => [...beanMakers].filter(([k]) => clsOf(k) === cls && (modOf(k) === from || !deployable.has(modOf(k)))).flatMap(([, v]) => v);
  /** Which types name each simple name: a bean no other type of its service names is run by the framework. */
  const namedBy = new Map<string, Set<string>>();
  for (const [key, ds] of types) for (const { t } of ds) {
    const add = (w: string): void => { if (!namedBy.has(w)) namedBy.set(w, new Set()); namedBy.get(w)!.add(key); };
    for (const s of t.supertypes) add(simple(strip(s)));
    for (const fl of t.fields) { for (const w of words(fl.type)) add(w); for (const x of fl.init) add(x.t); }
    for (const m of t.methods) { for (const w of words(m.returnType)) add(w); for (const p of m.params) for (const w of words(p.type)) add(w); for (const x of m.body) add(x.t); for (const a of m.annotations) for (const x of a.args) add(x.t); }
    for (const a of t.annotations) for (const x of a.args) add(x.t);
  }
  const named = (key: string): boolean => [...(namedBy.get(clsOf(key)) ?? [])].some((k) => k !== key && (modOf(k) === modOf(key) || !deployable.has(modOf(key)) || !deployable.has(modOf(k))));
  const hasEntry = (key: string): boolean => endpoints.some((e) => `${moduleOf(e.file)}/${e.cls}` === key) || [...fh.listeners, ...fb.listeners].some((l) => `${moduleOf(l.file)}/${l.cls}` === key) || [...fh.tools, ...fb.tools].some((x) => `${moduleOf(x.file)}/${x.cls}` === key);
  const settingRefs: { node: string; module: string; key: string }[] = [];
  /** Edges that carry a value rather than run code: an event listener on how its event was made. */
  const contentEdges = new Set<string>();
  /** Edges to another class's member that are code all the same: a constant read by name. */
  const codeEdges = new Set<string>();
  let calls = 0, widened = 0, unmatched = 0;

  for (const [key, ds] of types) {
    for (const { t, file, side, mod, cls } of ds) {
      const ann = `ann:${key}`;
      const cite = (line: number, what: string): Cite & { what: string } => ({ file, line, what, ...(side ? { side } : {}) });
      g.at(ann, cite(t.line, `${t.kind} ${cls}`));
      g.edge(ann, `global:java:${mod}`);
      g.edge(`global:java:${mod}`, 'global:java:*');
      for (const s of t.supertypes) for (const sk of resolve(simple(strip(s)), mod)) { g.edge(ann, `ann:${sk}`); g.edge(ann, `init:${sk}`); }
      for (const a of t.annotations) for (const k of keysIn(a.args)) settingRefs.push({ node: ann, module: mod, key: k });
      for (const a of t.annotations) if (a.name === 'ConditionalOnProperty' || a.name === 'ConfigurationProperties') {
        const txt = a.args.map((x) => x.t).join(' ');
        const prefix = /prefix\s*=\s*"([^"]+)"/.exec(txt)?.[1] ?? (a.name === 'ConfigurationProperties' ? /^"([^"]+)"/.exec(txt.trim())?.[1] ?? /value\s*=\s*"([^"]+)"/.exec(txt)?.[1] : undefined);
        const names = [...txt.matchAll(/(?:name|value|havingValue)?\s*=?\s*"([^"]+)"/g)].map((m) => m[1]!);
        if (prefix) settingRefs.push({ node: ann, module: mod, key: prefix });
        for (const n of names) if (n !== prefix) settingRefs.push({ node: ann, module: mod, key: prefix ? `${prefix}.${n}` : n });
      }
      staticRefs(ann, t.annotations.flatMap((a) => a.args), mod);
      // a bean nothing in its service names, and that implements nothing of the app, is run by the framework
      const framework = anns(t).some((a) => BEAN.test(a)) && !named(key) && !hasEntry(key) && !anns(t).some((a) => a === 'FeignClient' || a === 'Mapper') && !t.supertypes.some((s) => isApp(simple(strip(s)), mod)) && !inactive(key);
      if (framework || anns(t).some((a) => a === 'SpringBootApplication' || a === 'Aspect' || a === 'ControllerAdvice' || a === 'RestControllerAdvice')) {
        // what runs around every web request (filters, advice, security, MVC config) is the web's; the rest runs for all
        const web = anns(t).some((a) => WEB_ANN.test(a)) || t.supertypes.some((x) => WEB_TYPE.test(simple(strip(x)))) || t.methods.some((m) => m.annotations.some((a) => a.name === 'Bean') && WEB_TYPE.test(simple(strip(m.returnType))));
        const holder = web ? `web:${mod}` : `global:java:${mod}`;
        // an aspect whose pointcuts all read as packages, classes or annotations runs only around what they match
        const advised = anns(t).includes('Aspect') ? pointcutTargets(t, mod) : null;
        if (advised) {
          for (const tm of advised) for (const m of t.methods) if (m.annotations.some((a) => ADVICE.test(a.name))) g.edge(tm, `m:${key}.${m.name}`);
          for (const m of t.methods) if (m.annotations.some((a) => ADVICE.test(a.name))) { g.edge(`m:${key}.${m.name}`, ann); for (const fl of t.fields) g.edge(`m:${key}.${m.name}`, `f:${key}.${fl.name}`); }
        } else {
        g.edge(holder, ann);
        for (const fl of t.fields) g.edge(holder, `f:${key}.${fl.name}`);
        for (const m of t.methods) {
          // an exception handler for the app's own exceptions runs where they are thrown, on a web request
          const handles = m.annotations.find((a) => a.name === 'ExceptionHandler');
          const thrown = handles ? handles.args.filter((x, i, a) => /^[A-Z]/.test(x.t) && a[i + 1]?.t === '.' && a[i + 2]?.t === 'class').map((x) => x.t) : [];
          if (handles && thrown.length && thrown.every((x) => isApp(x, mod))) for (const x of thrown) for (const xk of resolve(x, mod)) g.edge(`thrown:${xk}`, `m:${key}.${m.name}`);
          else g.edge(holder, `m:${key}.${m.name}`);
        }
        }
      }
      // what a value of a data type is: its fields, accessors, constructors and lifecycle callbacks (Jackson, JPA)
      const shape = `shape:${key}`;
      g.edge(shape, ann);
      g.edge(shape, `rules:${key}`);
      const entity = entityTable.has(key);
      for (const fl of t.fields) {
        const fid = `f:${key}.${fl.name}`;
        g.at(fid, cite(fl.line, `${cls}.${fl.name}`));
        g.edge(shape, fid);
        const ft = simple(strip(fl.type));
        for (const w of words(fl.type)) for (const wk of resolve(w, mod)) if (!beans.has(wk)) { g.edge(fid, `shape:${wk}`); g.edge(`rules:${key}`, `rules:${wk}`); }
        for (const mk of makersOf(ft, mod)) g.edge(fid, mk);
        for (const a of fl.annotations) for (const k of keysIn(a.args)) settingRefs.push({ node: fid, module: mod, key: k });
        staticRefs(fid, [...fl.init, ...fl.annotations.flatMap((a) => a.args)], mod);
        for (const rk of resolve(ft, mod)) if (repoEntity.has(rk)) g.edge(fid, `data:${repoEntity.get(rk)}`);
        // a relation: loading one row loads the other
        if (entity) for (const w of words(fl.type)) { const e = entityOf(w, mod); if (e && e !== key) g.edge(fid, `data:${e}`); }
      }
      for (const m of t.methods) {
        if (m.name === cls || m.annotations.some((a) => a.name === 'PostConstruct')) g.edge(`init:${key}`, `m:${key}.${m.name}`);
        if (m.name === cls || t.kind === 'enum' || t.kind === 'record' || ACCESSOR.test(m.name) || m.annotations.some((a) => LIFECYCLE.test(a.name))) g.edge(shape, `m:${key}.${m.name}`);
      }
      if (entity) { const tb = entityTable.get(key)!; g.edge(`data:${key}`, `table:${mod}/${tb}`); g.edge(`data:${key}`, `table:${mod}/*`); g.edge(`data:${key}`, `data:${mod}/?`); g.edge(`data:${mod}/*`, `data:${key}`); g.edge(`data:${key}`, ann); }

      const fieldType = new Map(t.fields.map((fl) => [fl.name, simple(strip(fl.type))]));
      for (const m of t.methods) {
        const id = `m:${key}.${m.name}`;
        g.at(id, cite(m.line, `${cls}.${m.name}()`));
        g.edge(id, ann);
        g.edge(id, `init:${key}`);
        for (const a of m.annotations) for (const k of keysIn(a.args)) settingRefs.push({ node: id, module: mod, key: k });
        for (const p of m.params) for (const a of p.annotations) for (const k of keysIn(a.args)) settingRefs.push({ node: id, module: mod, key: k });
        for (const k of keysIn(m.body)) settingRefs.push({ node: id, module: mod, key: k });
        staticRefs(id, [...m.annotations.flatMap((a) => a.args), ...m.body], mod);
        const locals = new Map<string, string>(m.params.map((p) => [p.name, simple(strip(p.type))]));
        const body = m.body;
        for (let k = 0; k < body.length; k++) {
          const x = body[k]!;
          if (/^[A-Z]\w*$/.test(x.t) && /^[a-z]\w*$/.test(body[k + 1]?.t ?? '') && /^[=;:,)]$/.test(body[k + 2]?.t ?? '')) locals.set(body[k + 1]!.t, x.t);
        }
        const typeOf = (name: string): string | undefined => locals.get(name) ?? fieldType.get(name);
        /** The declared return type of the call that closes at `close`: `repo.findByOrderId(id)` → Optional. */
        const returnOf = (close: number, depth: number): string | undefined => {
          let d = 0, j = close;
          for (; j >= 0; j--) { const t = body[j]!.t; if (t === ')') d++; else if (t === '(' && --d === 0) break; }
          const name = body[j - 1]?.t;
          if (j <= 0 || !name || depth > 3) return undefined;
          const r = body[j - 2]?.t === '.' ? body[j - 3]?.t : 'this';
          const rt = r === ')' ? returnOf(j - 3, depth + 1) : r === 'this' ? cls : r ? typeOf(r) ?? (/^[A-Z]/.test(r) ? r : undefined) : undefined;
          if (!rt) return undefined;
          for (const rk of resolve(rt, mod)) for (const { t: rtT } of types.get(rk) ?? []) { const mm = rtT.methods.find((x) => x.name === name); if (mm) return simple(strip(mm.returnType)); }
          if (resolve(rt, mod).some((rk) => repoEntity.has(rk))) return SPRING_DATA[name];
          return resolve(rt, mod).length ? undefined : 'Object';
        };
        // the types it names as types (not `Type.member`): their values pass through it
        const mentions = new Set<string>([...words(m.returnType), ...m.params.flatMap((p) => words(p.type)), ...body.filter((x, i) => /^[A-Z]/.test(x.t) && (body[i + 1]?.t !== '.' || body[i + 2]?.t === 'class')).map((x) => x.t)]);
        // a data type it names: its class-level mapping, and its constructors when it makes one
        for (const w of mentions) for (const wk of resolve(w, mod)) if (!beans.has(wk) && wk !== key) { g.edge(id, `ann:${wk}`); g.edge(id, `thrown:${wk}`); }
        for (let k = 0; k + 1 < body.length; k++) if (body[k]!.t === 'new') for (const wk of resolve(body[k + 1]!.t, mod)) if (!beans.has(wk)) g.edge(id, `m:${wk}.${clsOf(wk)}`);
        // the fields it reads or writes by name: getX(), isX(), setX(), x(), .x, and a builder's .x(…)
        for (let k = 1; k < body.length; k++) {
          if (body[k - 1]!.t !== '.' || !/^[a-zA-Z_]\w*$/.test(body[k]!.t)) continue;
          const n = body[k]!.t;
          const fname = /^(get|set|is)[A-Z]/.test(n) && body[k + 1]?.t === '(' ? n.replace(/^(get|set|is)/, '').replace(/^./, (c) => c.toLowerCase()) : n;
          for (const fk of fieldIndex.get(fname) ?? []) if (visible(mod, fk)) g.edge(id, `f:${fk}.${fname}`);
        }
        // where a value crosses a boundary whole, every field counts: JSON in and out of an endpoint, a Feign call,
        // a message, a MapStruct mapping, a copy by reflection
        const whole = endpoints.some((e) => e.cls === cls && e.method === m.name && moduleOf(e.file) === mod) || [...fh.listeners, ...fb.listeners].some((l) => l.cls === cls && l.method === m.name && moduleOf(l.file) === mod) || (t.kind === 'interface' && !m.body.length && anns(t).some((a) => a === 'FeignClient' || a === 'Mapper')) || anns(t).includes('Mapper') || body.some((x) => /^(copyProperties|convertValue|readValue|writeValueAsString|writeValueAsBytes|treeToValue|valueToTree)$/.test(x.t)) || (m.name === 'map' && body.some((x) => x.t === 'ModelMapper'));
        if (whole) for (const w of mentions) for (const wk of resolve(w, mod)) if (!beans.has(wk) && wk !== key) g.edge(id, `shape:${wk}`);
        // a MapStruct update writes into its @MappingTarget: a mapper method on an entity is a writer of its rows
        for (const p of m.params) if (p.annotations.some((a) => a.name === 'MappingTarget')) for (const w of words(p.type)) { const e = entityOf(w, mod); if (e) g.edge(`data:${e}`, id); }
        // Bean Validation runs where a parameter is @Valid / @Validated
        for (const p of m.params) if (p.annotations.some((a) => a.name === 'Valid' || a.name === 'Validated')) for (const w of words(p.type)) for (const wk of resolve(w, mod)) g.edge(id, `rules:${wk}`);
        if (body.some((x) => x.t === 'validate')) for (const w of mentions) for (const wk of resolve(w, mod)) g.edge(id, `rules:${wk}`);
        const out = callsOut.get(`${mod}/${cls}.${m.name}`) ?? new Set<string>();
        const resolved = new Set([...out].map((to) => to.split('.').pop()!));
        for (const to of out) { const [c, mm] = to.split('.') as [string, string]; const ks = resolve(c, mod); const tg = ks.flatMap((k) => targets(k, mm, mod)); for (const x of tg.length ? tg : ks.map((k) => `m:${k}.${mm}`)) g.edge(id, x); }
        const http = new Set<string>();
        for (let k = 0; k < body.length; k++) {
          const x = body[k]!;
          const prev = body[k - 1]?.t;
          // fields it uses
          if ((fieldType.has(x.t) && prev !== '.') || (prev === '.' && body[k - 2]?.t === 'this' && fieldType.has(x.t))) {
            g.edge(id, `f:${key}.${x.t}`);
            for (const rk of resolve(fieldType.get(x.t)!, mod)) if (repoEntity.has(rk)) g.edge(id, `data:${repoEntity.get(rk)}`);
          }
          if (/^[a-z]\w*$/.test(x.t) && HTTP_CLIENT.test(typeOf(x.t) ?? '')) http.add(x.t);
          if (/^(RestClient|WebClient|HttpClient)$/.test(x.t) && body[k + 1]?.t === '.') http.add(x.t);
          if (body[k + 1]?.t !== '(' || !/^[a-z]\w*$/.test(x.t) || KEYWORDS.has(x.t) || prev === 'new') continue;
          const recv = prev === '.' ? body[k - 2]?.t : undefined;
          const rtype = recv === ')' ? returnOf(k - 2, 0) : recv ? (recv === 'this' ? cls : typeOf(recv) ?? (/^[A-Z]/.test(recv) ? recv : undefined)) : cls;
          const rkeys = rtype ? resolve(rtype, mod) : [];
          const store = rtype && /^(EntityManager|JdbcTemplate|NamedParameterJdbcTemplate|JdbcClient|DSLContext|SqlSession|MongoTemplate)$/.test(rtype);
          // writes: a repository's save or delete, a setter on an entity, the entity manager, plain SQL
          if (prev === '.' && WRITE_VERB.test(x.t)) {
            const re = rkeys.map((rk) => repoEntity.get(rk)).find(Boolean);
            if (re) g.edge(`data:${re}`, id);
            else if (store) { const tables = sqlTables(body, mod); if (tables.length) for (const e of tables) g.edge(`data:${e}`, id); else g.edge(`data:${mod}/?`, id); }
          }
          if (prev === '.' && /^set[A-Z]/.test(x.t)) {
            const prop = x.t.slice(3).replace(/^./, (c) => c.toLowerCase());
            const e = rkeys.find((rk) => entityTable.has(rk));
            if (e) g.edge(`data:${e}`, id);
            else if (!rtype) for (const [ek] of entityTable) if (modOf(ek) === mod && (types.get(ek) ?? []).some(({ t: et }) => et.fields.some((fl) => fl.name === prop))) g.edge(`data:${ek}`, id);
          }
          if (prev === '.' && store && !WRITE_VERB.test(x.t)) { const tables = sqlTables(body, mod); if (tables.length) for (const e of tables) g.edge(id, `data:${e}`); else g.edge(id, `data:${mod}/*`); }
          if (/^(forName|getBean|newInstance|getDeclaredMethod|getMethod)$/.test(x.t) && prev === '.') unknownAt(id, 'reflection', `${cls}.${m.name}() calls ${recv ?? ''}.${x.t}(): what it reaches is decided at run time`, cite(x.line, x.t));
          // a call to an app method the facts did not resolve: widen it to every method of that name it can see
          const decl = [...(methodsByName.get(x.t) ?? [])].filter((k2) => visible(mod, k2));
          if (!decl.length) continue;
          calls++;
          if (resolved.has(x.t)) continue;
          if (rtype && !rkeys.length) continue; // a library type: List.add, Optional.map
          const typed = rkeys.flatMap((rk) => targets(rk, x.t, mod));
          for (const tg of typed.length ? typed : decl.flatMap((c) => targets(c, x.t, mod))) g.edge(id, tg);
          widened++;
        }
        // HTTP out of Java: the call facts, or an unknown when a client is used and no call was read
        const jc = javaCalls.get(`${mod}/${cls}.${m.name}`) ?? [];
        for (const c of jc) {
          const hit = endpoints.filter((e) => e.service === c.service && (e.verb === c.verb || e.verb === 'ANY') && templateHits(c.tpl, e.path));
          for (const e of hit) g.edge(id, epId(e));
          if (!hit.length) {
            if (services.has(c.service)) unknownAt(id, 'unmatched-call', `${cls}.${m.name}() calls ${c.verb} ${c.service}${c.tpl}, and no endpoint of ${c.service} here matches it`, cite(c.line, c.how));
            else assume(`Calls to services that are not in this repository are outside it: this PR cannot change them.`);
          }
        }
        // an interface method nothing here implements: what a call to it runs is not in the code read
        if (t.kind === 'interface' && !m.body.length && !subtypes.get(cls)?.size && !isRepoType(t) && !anns(t).some((a) => /^(FeignClient|Mapper|Repository)$/.test(a)) && !jc.length) unknownAt(id, 'no-implementation', `${cls}.${m.name}() is declared, and nothing read implements ${cls}`, cite(m.line, m.name));
        // building or configuring a client is not a call: a call names a request (get, retrieve, exchange, getForObject…)
        if (http.size && !body.some((x, i) => body[i - 1]?.t === '.' && HTTP_VERB.test(x.t))) http.clear();
        if (http.size && !jc.length) {
          const tok = body.find((x) => http.has(x.t))!;
          unknownAt(id, 'http-client', `${cls}.${m.name}() uses ${[...http].join(', ')}, and no call it makes was read`, cite(tok.line, tok.t));
        }
      }
    }
  }
  /**
   * The methods an aspect's advice runs around, when every pointcut it uses is one of: execution(… pkg.Type.m(..)),
   * within(pkg..*), @annotation(A), @within(A), or a named @Pointcut of the aspect made of these. Else null: it runs
   * around anything, as far as this reader knows.
   */
  function pointcutTargets(t: JType, mod: string): string[] | null {
    const named = new Map<string, string>();
    for (const m of t.methods) { const a = m.annotations.find((x) => x.name === 'Pointcut'); if (a) named.set(m.name, a.args.filter((x) => /^"/.test(x.t)).map((x) => x.t.slice(1, -1)).join(' ')); }
    const exprs = t.methods.flatMap((m) => m.annotations.filter((a) => ADVICE.test(a.name) && a.name !== 'Pointcut')).map((a) => a.args.filter((x) => /^"/.test(x.t)).map((x) => x.t.slice(1, -1)).join(' '));
    if (!exprs.length) return [];
    const parts: string[] = [];
    const expand = (e: string, depth: number): boolean => {
      for (const raw of e.split(/\|\||&&/)) {
        const p = raw.trim().replace(/^!/, '').replace(/^\(|\)$/g, '').trim();
        if (!p) continue;
        const ref = /^(\w+)\(\)$/.exec(p);
        if (ref) { const x = named.get(ref[1]!); if (x === undefined || depth > 4 || !expand(x, depth + 1)) return false; continue; }
        if (!/^(execution|within|@annotation|@within)\(/.test(p)) return false;
        parts.push(p);
      }
      return true;
    };
    if (!exprs.every((e) => expand(e, 0))) return null;
    const out: string[] = [];
    for (const [k, ds] of types) {
      if (modOf(k) !== mod && deployable.has(modOf(k))) continue;
      for (const { t: tt, file, side } of ds) {
        const pkg = ((side ? fb : fh).javaFiles.get(file)?.pkg ?? '');
        const fq = `${pkg}.${clsOf(k)}`;
        for (const m of tt.methods) {
          const hit = parts.some((p) => {
            const ann = /^@(annotation|within)\(([\w.]+)\)/.exec(p);
            if (ann) return ann[1] === 'annotation' ? m.annotations.some((a) => a.name === simple(ann[2]!)) : tt.annotations.some((a) => a.name === simple(ann[2]!));
            const w = /^within\(([\w.]+?)(\.\.)?\*?\)/.exec(p);
            if (w) return fq === w[1] || fq.startsWith(`${w[1]}.`);
            const ex = /^execution\(\s*(?:\w+\s+)?[\w.*<>[\]]+\s+([\w.]*?)(?:\.\.|\.\*|\*|\()/.exec(p);
            if (ex) return !ex[1] || fq === ex[1] || fq.startsWith(`${ex[1]}.`) || `${fq}.${m.name}`.startsWith(ex[1]!);
            return true;
          });
          if (hit) out.push(`m:${k}.${m.name}`);
        }
      }
    }
    return out;
  }
  /** `Topics.ORDER_PLACED`: a constant read by name depends on that constant, not on every field of its class. */
  function staticRefs(from: string, ts: readonly Tok[], mod: string): void {
    for (let k = 0; k + 2 < ts.length; k++) {
      if (!/^[A-Z]\w*$/.test(ts[k]!.t) || ts[k + 1]!.t !== '.' || !/^\w+$/.test(ts[k + 2]!.t) || ts[k + 3]?.t === '(') continue;
      for (const tk of resolve(ts[k]!.t, mod)) if ((types.get(tk) ?? []).some(({ t }) => t.fields.some((fl) => fl.name === ts[k + 2]!.t) || t.constants.includes(ts[k + 2]!.t))) { g.edge(from, `f:${tk}.${ts[k + 2]!.t}`); g.edge(from, `ann:${tk}`); codeEdges.add(`${from}>f:${tk}.${ts[k + 2]!.t}`); codeEdges.add(`${from}>ann:${tk}`); }
    }
  }
  const listenerKeys = (cls: string, method: string): string[] => [...fh.listeners, ...fb.listeners].filter((l) => l.cls === cls && l.method === method).map((l) => `m:${moduleOf(l.file)}/${l.cls}.${l.method}`);
  // brokers: a listener depends on what its topic carries, so on every producer of that topic
  const producers = [...fh.producers, ...fb.producers];
  for (const p of producers) {
    const pid = `m:${moduleOf(p.file)}/${p.from}`;
    if (!p.channel || /not resolved/.test(p.channel.how)) unknownAt('topic:*', 'topic', `${p.from}() publishes to ${p.expr}, which could not be worked out`, { file: p.file, line: p.line, ...(fb.producers.includes(p) && !fh.producers.includes(p) ? { side: 'base' as const } : {}) });
    else g.edge(`topic:${p.channel.name}`, pid);
    if (p.channel && p.payload) for (const k of resolve(p.payload, moduleOf(p.file))) g.edge(`topic:${p.channel.name}`, `shape:${k}`);
  }
  for (const l of [...fh.listeners, ...fb.listeners]) {
    const id = `m:${moduleOf(l.file)}/${l.cls}.${l.method}`;
    const side = fh.listeners.includes(l) ? {} : { side: 'base' as const };
    if (/@(KafkaListener|RabbitListener|JmsListener|SqsListener)/.test(l.kind)) {
      if (!l.channels?.length) unknownAt(id, 'topic', `${l.cls}.${l.method}() listens on a topic that was not read`, { file: l.file, line: l.line, ...side });
      for (const c of l.channels ?? []) {
        if (/not resolved/.test(c.how)) { unknownAt(id, 'topic', `${l.cls}.${l.method}() listens on ${c.how}`, { file: l.file, line: l.line, ...side }); continue; }
        if (c.pattern) { const re = new RegExp(`^${c.name}$`); for (const p of producers) if (p.channel && re.test(p.channel.name)) g.edge(id, `topic:${p.channel.name}`); }
        else g.edge(id, `topic:${c.name}`);
        g.edge(id, 'topic:*');
      }
      g.edge(id, `kafka:${moduleOf(l.file)}`);
    }
  }
  // an event listener depends on how the event is made
  for (const f of [fh, fb]) for (const e of f.callEdges) if (e.quote === 'publishEvent') {
    const mod = moduleOf(e.file); const [c, mm] = e.to.split('.') as [string, string];
    for (const k of resolve(c, mod)) {
      g.edge(`m:${k}.${mm}`, `m:${mod}/${e.from}`); contentEdges.add(`m:${k}.${mm}>m:${mod}/${e.from}`);
      // an @Async listener runs on another thread: what it does is not part of the request that published
      if ([...fh.listeners, ...fb.listeners].some((l) => l.async && l.cls === c && l.method === mm)) contentEdges.add(`m:${mod}/${e.from}>m:${k}.${mm}`);
    }
  }

  /* ---------------- the browser: screens, files, members, calls ---------------- */
  // txt:F is the text of a file (outside its members and routes); fe:F is all of it; mem:F#o.m is one member
  const comps = new Map<string, { c: Component; side?: 'base' }[]>();
  for (const [file, c] of uh.components) comps.set(file, [{ c }]);
  for (const [file, c] of ub.components) if (changed.has(file)) { if (!comps.has(file)) comps.set(file, []); comps.get(file)!.push({ c, side: 'base' }); }
  // base routes from changed files, and any base screen whose path is gone at head (a parent route moved it)
  const headPaths = new Set(uh.routes.map((r) => r.path));
  const routes = [...uh.routes.map((r) => ({ r, side: undefined as 'base' | undefined })), ...ub.routes.filter((r) => changed.has(r.file) || !headPaths.has(r.path)).map((r) => ({ r, side: 'base' as const }))];
  const routeFiles = new Set(routes.map(({ r }) => r.file));
  const routeComponents = new Set(routes.map(({ r }) => r.component));
  const feCalls = [...uh.calls.map((c) => ({ c, side: undefined as 'base' | undefined })), ...ub.calls.filter((c) => changed.has(c.file)).map((c) => ({ c, side: 'base' as const }))];
  const membersOf = (file: string): { owner: string; member: string; start: number; end: number }[] => (comps.get(file) ?? []).flatMap(({ c }) => c.members ?? []);
  const virtualOf = (file: string): string[] => [...new Set(feCalls.filter(({ c }) => c.file === file && c.owner && c.member && !c.eager).map(({ c }) => `${c.owner}.${c.member}`))];
  /** A file a screen draws runs whole: a .vue file, or a component with a template. A module is used member by member. */
  const drawn = (file: string): boolean => file.endsWith('.vue') || (comps.get(file) ?? []).some(({ c }) => c.elements.length + c.shows.length + c.links.length > 0) || /@Component\s*\(/.test(H.read(file) ?? B.read(file) ?? '');
  const hasBackend = endpoints.length > 0;
  for (const [file, list] of comps) {
    const fe = `fe:${file}`, txt = `txt:${file}`;
    g.at(fe, { file, line: 1, what: base(file), ...(list[0]?.side ? { side: list[0].side } : {}) });
    g.at(txt, { file, line: 1, what: base(file), ...(list[0]?.side ? { side: list[0].side } : {}) });
    g.edge(fe, txt);
    g.edge(txt, 'global:fe');
    for (const v of virtualOf(file)) { g.edge(fe, `mem:${file}#${v}`); g.edge(`mem:${file}#${v}`, txt); }
    for (const { c, side } of list) {
      const text = (side ? B : H).read(file) ?? '';
      const lines = text.split('\n');
      for (const m of c.members ?? []) {
        const mid = `mem:${file}#${m.owner}.${m.member}`;
        g.at(mid, { file, line: m.start, what: m.member === '()' ? m.owner : `${m.owner}.${m.member}`, ...(side ? { side } : {}) });
        g.edge(fe, mid);
        g.edge(mid, txt);
        // a member that names another member of its file runs it
        for (const o of c.members ?? []) { if (o === m || (o.owner === m.owner && o.member === m.member)) continue;
          // the name on a line that is the other member's own (a shared `return { a, b }`) is its declaration, not a use
          const own = new Set((c.members ?? []).filter((x) => x.owner === o.owner && x.member === o.member).flatMap((x) => Array.from({ length: x.end - x.start + 1 }, (_, i) => x.start + i)));
          const body = lines.slice(m.start - 1, m.end).filter((_, i) => !own.has(m.start + i)).join('\n'); const nm = (o.member === '()' ? o.owner : o.member).replace(/\$/g, '\\$'); if (new RegExp(`(^|[^\\w$.])${nm}(?![\\w$])|\\b(this|${o.owner.replace(/\$/g, '\\$')})\\.${nm}(?![\\w$])`).test(body)) g.edge(mid, `mem:${file}#${o.owner}.${o.member}`); }
      }
      // what it imports: a module member by member when the reader saw which members are used, else all of it
      const ims = routeFiles.has(file) ? importsOf(text) : [];
      for (const d of c.deps) {
        if (routeFiles.has(file) && routeComponents.has(d)) continue; // a route's own screen is that route's, not the router's
        // in a router, what an import brings in belongs to the routes that name it (or to all, through the router's other lines)
        const via = ims.filter((im) => im.src.startsWith('.') && d.replace(/\.(ts|js|vue|tsx|jsx)$/, '').replace(/\/index$/, '') === join(file, im.src).replace(/\.(ts|js|vue|tsx|jsx)$/, '').replace(/\/index$/, ''));
        if (via.length) { for (const im of via) for (const n of im.names) g.edge(`imp:${file}#${n}`, `fe:${d}`); continue; }
        if (c.uses === undefined || drawn(d)) { g.edge(txt, `fe:${d}`); continue; }
        g.edge(txt, `txt:${d}`);
        const known = new Set([...membersOf(d).map((m) => `${m.owner}.${m.member}`), ...virtualOf(d)]);
        const ownersD = new Set([...known].map((k) => k.slice(0, k.indexOf('.'))));
        for (const u of c.uses) if (known.has(u)) g.edge(txt, `mem:${d}#${u}`);
        // a whole-owner use (`api.()`, or an owner handed on) takes every member of that owner
        for (const u of c.uses) if (u.endsWith('.()') && !known.has(u) && !c.uses.some((x) => x !== u && x.startsWith(u.slice(0, -2)))) for (const k of known) if (k.startsWith(u.slice(0, -2))) g.edge(txt, `mem:${d}#${k}`);
        for (const o of c.escapes ?? []) if (ownersD.has(o)) for (const k of known) if (k.startsWith(`${o}.`)) g.edge(txt, `mem:${d}#${k}`);
      }
      // Angular: the template and styles a component names
      for (const m of text.matchAll(/\b(templateUrl|styleUrls?)\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) for (const p of m[2]!.matchAll(/['"]([^'"]+)['"]/g)) g.edge(fe, `txt:${join(file, p[1]!)}`);
      for (const o of c.opaque) unknownAt(txt, 'opaque', `${o.what} at ${base(file)}:${o.line}`, { file, line: o.line, ...(side ? { side } : {}) });
      // a line that makes a network call no fact records
      const callLines = new Set(feCalls.filter(({ c: x, side: s }) => x.file === file && s === side).flatMap(({ c: x }) => [x.line - 2, x.line - 1, x.line, x.line + 1, x.line + 2]));
      const clients = httpNames(text, file, (f) => H.read(f) ?? B.read(f) ?? '');
      // the global fetch is called bare; a client (http, axios, an instance) may be a field: this.http.get(…)
      const named = [...clients].filter((n) => n !== 'fetch' && n !== '$fetch').map((n) => n.replace(/\$/g, '\\$'));
      const re = new RegExp(`(^|[^\\w.$])((?:this\\.)?(?:${named.length ? named.join('|') : '\\b\\B'})(?:\\.(?:get|post|put|patch|delete|request|head))?|\\$?fetch)\\s*(<[^>()]*>)?\\s*\\(`);
      lines.forEach((l, i) => {
        if (callLines.has(i + 1) || /^\s*(\/\/|\*|import\b)/.test(l) || !re.test(l) || /\.(create|interceptors|defaults)\b/.test(l)) return;
        // a wrapper (`request(url)` around a browser call on `url`): the URL is its own parameter, and the calls made through it are recorded where it is called
        const arg = new RegExp(re.source + '\\s*([A-Za-z_$][\\w$]*)\\s*[,)]').exec(l)?.[4];
        const fn = arg ? enclosingFn(lines, i, arg) : null;
        if (fn && feCalls.some(({ c: x }) => x.file !== file && x.code.includes(`${fn}(`))) return;
        const m = (c.members ?? []).find((x) => i + 1 >= x.start && i + 1 <= x.end);
        unknownAt(m ? `mem:${file}#${m.owner}.${m.member}` : txt, 'unread-call', `a network call at ${base(file)}:${i + 1} that no fact records`, { file, line: i + 1, ...(side ? { side } : {}) });
      });
    }
  }
  // memberCalls: a class member that calls another through `this.`
  for (const u of [uh, ub]) for (const [k, vs] of u.memberCalls ?? []) {
    const owner = k.slice(0, k.indexOf('.'));
    for (const f of new Set(feCalls.filter(({ c }) => c.owner === owner).map(({ c }) => c.file))) for (const v of vs) g.edge(`mem:${f}#${k}`, `mem:${f}#${v}`);
  }
  for (const { c, side } of feCalls) {
    const m = (comps.get(c.file) ?? []).flatMap(({ c: x }) => x.members ?? []).find((x) => c.line >= x.start && c.line <= x.end);
    const owner = c.owner ?? m?.owner, member = c.member ?? m?.member;
    const node = owner && member && !c.eager ? `mem:${c.file}#${owner}.${member}` : `txt:${c.file}`;
    const f = side ? fb : fh;
    const hits = endpoints.filter((e) => {
      if (!c.verbs.includes(e.verb) && e.verb !== 'ANY') return false;
      const gw = throughGateway(f, c.tpl);
      if (f.gateway.length && gw.service !== e.service) return false;
      return templateHits(gw.path, e.path);
    });
    for (const e of hits) g.edge(node, epId(e));
    if (!hits.length) {
      unmatched++;
      const last = c.tpl.split('/').filter((x) => x && !x.includes('{') && !x.includes('?')).pop()?.toLowerCase();
      const near = !!last && endpoints.some((e) => e.path.toLowerCase().split('/').includes(last));
      if (/^https?:/.test(c.tpl) || !hasBackend) assume('Calls to other hosts are outside this repository: this PR cannot change them.');
      else if (!near) assume('A call to a path no endpoint here resembles is served outside this repository: this PR cannot change it.');
      else unknownAt(node, 'unmatched-call', `${c.verbs.join('/')} ${c.tpl} at ${base(c.file)}:${c.line} matches no endpoint here`, { file: c.file, line: c.line, ...(side ? { side } : {}) });
    }
  }
  // screens: the route's own entry, the router's other lines, the shell, the components drawn on every screen
  const spansOf = new Map<string, { from: number; to: number }[]>();
  const spanOf = (file: string, line: number, side?: 'base'): { from: number; to: number } => {
    const k = `${side ?? 'head'}:${file}`;
    if (!spansOf.has(k)) spansOf.set(k, braceSpans((side ? B : H).read(file) ?? ''));
    const inner = spansOf.get(k)!.filter((s) => s.from <= line && line <= s.to).sort((a, b) => (a.to - a.from) - (b.to - b.from));
    return inner[0] ?? { from: line, to: line };
  };
  /** The lines of a route's own entry: its object, less the child routes inside it. */
  const routeLines = (file: string, path: string, line: number, side: 'base' | undefined, all: readonly { path: string; line: number }[]): Set<number> => {
    const sp = spanOf(file, line, side);
    const own = new Set<number>();
    for (let i = sp.from; i <= sp.to; i++) own.add(i);
    for (const o of all) if (o.path !== path) { const os = spanOf(file, o.line, side); if (os.from >= sp.from && os.to <= sp.to && (os.from > sp.from || os.to < sp.to)) for (let i = os.from; i <= os.to; i++) own.delete(i); }
    return own;
  };
  /** `router.beforeEach((to) => { if (to.meta.K && …) { … } })`: the meta key a guard's whole body depends on, or null. */
  const guardKey = (x: { file: string; line: number; endLine: number }, side?: 'base'): string | null => {
    const t = ((side ? B : H).read(x.file) ?? '').split('\n').slice(x.line - 1, x.endLine).join(' ').replace(/\s+/g, ' ').trim();
    const m = /^router\.beforeEach\(\s*(?:async\s*)?\(?\s*to\b[^)]*\)?\s*=>\s*\{\s*if\s*\(\s*to\.meta\??\.(\w+)\s*&&[^{};]*\)\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*\}\s*\)\s*;?$/.exec(t);
    return m ? m[1]! : null;
  };
  /** The meta keys a route carries on either side, its own and its parents' (Vue merges them). */
  const metaOf = (path: string): Set<string> => new Set([...uh.routes, ...ub.routes].filter((r) => r.path === path || path.startsWith(r.path === '/' ? '/' : `${r.path}/`)).flatMap((r) => r.meta ?? []));
  const rootRouters = new Set([...routeFiles].filter((f) => /createRouter\s*\(|RouterModule\.forRoot|provideRouter\s*\(/.test(H.read(f) ?? B.read(f) ?? '') || uh.shell?.has(f)));
  for (const { r, side } of routes) {
    const sid = `screen:${r.path}`;
    const rid = `route:${r.file}#${r.path}`;
    g.at(rid, { file: r.file, line: r.line, what: `the route ${r.path}`, ...(side ? { side } : {}) });
    g.edge(sid, rid);
    g.edge(rid, `rdef:${r.file}#${r.path}`);
    g.at(`rdef:${r.file}#${r.path}`, { file: r.file, line: r.line, what: `the route ${r.path}`, ...(side ? { side } : {}) });
    g.edge(sid, 'global:fe');
    g.edge(rid, `fe:${r.component}`);
    g.edge(rid, `txt:${r.file}`);
    for (const f of rootRouters) g.edge(sid, `txt:${f}`);
    const sp = spanOf(r.file, r.line, side);
    // a child route is drawn inside its parent's screen
    for (const o of routes) if (o.r.file === r.file && o.r.path !== r.path && o.side === side) { const os = spanOf(o.r.file, o.r.line, o.side); if (os.from <= sp.from && os.to >= sp.to && (os.from < sp.from || os.to > sp.to)) g.edge(rid, `route:${o.r.file}#${o.r.path}`); }
    const text = ((side ? B : H).read(r.file) ?? '').split('\n').slice(sp.from - 1, sp.to).join('\n');
    for (const im of importsOf((side ? B : H).read(r.file) ?? '')) for (const n of im.names) if (new RegExp(`\\b${n}\\b`).test(text)) g.edge(rid, `imp:${r.file}#${n}`);
    for (const [s] of uh.shell ?? []) g.edge(sid, `fe:${s}`);
    for (const x of uh.globals) { g.edge(sid, `fe:${x.file}`); g.edge(sid, `fe:${x.root}`); }
    for (const x of [...(uh.guards ?? []), ...(ub.guards ?? [])]) {
      if (!routeFiles.has(x.file)) { g.edge(sid, `fe:${x.file}`); continue; }
      const k = guardKey(x, ub.guards?.includes(x) && !uh.guards?.includes(x) ? 'base' : undefined);
      // a guard whose whole body is `if (to.meta.K && …) { … }` does nothing for a route whose meta (or a parent's) has no K
      if (!k || metaOf(r.path).has(k)) g.edge(sid, k ? `guardk:${x.file}#${k}` : `guard:${x.file}`);
    }
  }
  for (const f of routeFiles) for (const [snap, u] of [[H, uh], [B, ub]] as const) {
    const text = snap.read(f);
    if (text === null) continue;
    g.edge(`txt:${f}`, 'global:fe');
    g.at(`txt:${f}`, { file: f, line: 1, what: `the router in ${base(f)}` });
    const taken = new Set<number>();
    const rs = u.routes.filter((x) => x.file === f);
    for (const r of rs) for (const i of routeLines(f, r.path, r.line, snap === B ? 'base' : undefined, rs)) taken.add(i);
    const ims = importsOf(text);
    for (const im of ims) for (let i = im.from; i <= im.to; i++) taken.add(i);
    const rest = text.split('\n').filter((_, i) => !taken.has(i + 1)).join('\n');
    for (const im of ims) for (const n of im.names) if (new RegExp(`\\b${n}\\b`).test(rest)) g.edge(`txt:${f}`, `imp:${f}#${n}`);
  }
  for (const a of inp.areas) if (a.startsWith('job:')) { const [c, mm] = a.slice(4).split('.') as [string, string]; const ks = listenerKeys(c, mm); for (const k of ks.length ? ks : [...(bySimple.get(c) ?? [])].map((x) => `m:${x}.${mm}`)) g.edge(a, k); }

  /* ---------------- Δ: what changed, decided by comparing definitions on both sides ---------------- */
  const defs = new Map<string, { b?: string; h?: string; at?: Cite; what?: string }>();
  const def = (node: string, side: 'base' | 'head', text: string, at: Cite, what: string): void => {
    const d = defs.get(node) ?? {};
    const k = side === 'base' ? 'b' : 'h';
    d[k] = (d[k] ?? '') + '\n' + text;
    if (!d.at || side === 'head') { d.at = at; d.what = what; }
    defs.set(node, d);
  };
  const mark = (node: string, at: Cite, what: string): void => { if (!delta.has(node)) delta.set(node, { ...at, what }); };
  const fileSide = (s: Side): 'base' | 'head' => (s.side ? 'base' : 'head');
  for (const cf of inp.changes) {
    const file = cf.path;
    const kind = fileKind(file);
    if (kind === 'docs' || kind === 'ci' || kind === 'tooling' || kind === 'test') { assume('Tests, docs, CI and tooling are not part of the running app.'); continue; }
    if (kind === 'deploy') {
      // a deployment that turns a Spring profile on or off changes every setting that profile's file sets
      const was = activeProfiles(B.read(file) ?? ''), now = activeProfiles(H.read(file) ?? '');
      const dl = (H.read(file) ?? '').split('\n');
      for (const p of new Set([...now, ...was])) {
        if (now.has(p) === was.has(p)) continue;
        const line = Math.max(1, dl.findIndex((l) => new RegExp(`\\b${p}\\b`).test(l)) + 1);
        for (const pf of H.files.filter((f) => new RegExp(`(^|/)application-${p}\\.(ya?ml|properties)$`).test(f))) {
          const ls = (H.read(pf) ?? '').split('\n');
          for (let n = 1; n <= ls.length; n++) { const k = configKey(ls, n, pf.endsWith('.properties')); if (k && /[:=]\s*\S/.test(ls[n - 1]!)) mark(`set:${moduleOf(pf)}:${k}`, { file, line }, `${base(file)} turns the "${p}" profile ${now.has(p) ? 'on' : 'off'}, and with it ${k} from ${base(pf)}`); }
        }
      }
      assume('Deployment files are their own area to test (DEPLOY); they do not change what the code does, except the Spring profiles they turn on.');
      continue;
    }
    // a component style that escapes its component (::ng-deep with no :host before it, or no encapsulation): every page
    if ((kind === 'frontend' || kind === 'style') && !cf.binary) {
      const leak = cf.headLines.find((n) => { const t = H.line(file, n) ?? ''; return (/::ng-deep/.test(t) && !/:host\b[^{,]*::ng-deep/.test(t)) || /ViewEncapsulation\.(None|ShadowDom)/.test(t); });
      if (leak) mark('global:fe', { file, line: leak }, `${base(file)}:${leak}: a style that escapes its component applies to every page`);
    }
    if (cf.binary && kind !== 'asset') { mark('global:java:*', { file, line: 1 }, `${base(file)}: a binary file changed`); mark('global:fe', { file, line: 1 }, `${base(file)}: a binary file changed`); continue; }
    if (file.endsWith('.java')) {
      for (const s of sides) {
        const jf = s.f.javaFiles.get(file);
        const sd = fileSide(s);
        const text = s.snap.read(file);
        if (text === null) continue;
        if (!jf || !jf.ok) { unknownAt('global:java:*', 'unreadable', `${base(file)} could not be read${jf?.error ? `: ${jf.error}` : ''}`, { file, line: 1, ...(s.side ? { side: s.side } : {}) }); continue; }
        for (const t of jf.types) {
          const cls = simple(t.name);
          const at = (line: number): Cite => ({ file, line, ...(s.side ? { side: s.side } : {}) });
          const key = `${moduleOf(file)}/${cls}`;
          const entity = entityTable.has(key);
          def(`ann:${key}`, sd, `${t.kind} ${t.annotations.map(annText).join(' ')} : ${t.supertypes.join(',')} | ${t.constants.join(',')}`, at(t.line), `${t.kind} ${cls}`);
          for (const fl of t.fields) {
            const keep = fl.annotations.filter((a) => entity || !CONSTRAINT.test(a.name));
            def(`f:${key}.${fl.name}`, sd, `${(fl.mods ?? []).join(' ')} ${keep.map(annText).join(' ')} ${fl.type} ${fl.name} = ${toks(fl.init)}`, at(fl.line), `${cls}.${fl.name}`);
            if (!entity) def(`rules:${key}`, sd, `${fl.name}: ${fl.annotations.filter((a) => CONSTRAINT.test(a.name)).map(annText).join(' ')}`, at(fl.line), `the request rules of ${cls}`);
          }
          for (const m of t.methods) def(`m:${key}.${m.name}`, sd, methodDef(m), at(m.line), `${cls}.${m.name}()`);
        }
        // a changed line outside every method and field (an import, an initializer block) changes the whole type
        const lines = sd === 'base' ? cf.baseLines : cf.headLines;
        const srcLines = text.split('\n');
        for (const n of lines) {
          const l = (srcLines[n - 1] ?? '').trim();
          if (!l || /^(\/\/|\/\*|\*)/.test(l) || l === '}' || l === '{') continue;
          const inMember = jf.types.some((t) => t.methods.some((m) => n >= Math.min(m.line, ...m.annotations.map((a) => a.line)) && n <= m.endLine) || t.fields.some((fl) => n >= Math.min(fl.line, ...fl.annotations.map((a) => a.line)) && n <= Math.max(fl.line, ...fl.init.map((x) => x.line))));
          if (inMember) continue;
          const owner = jf.types.filter((t) => n >= Math.min(t.line, ...t.annotations.map((a) => a.line)) && n <= t.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
          for (const t of owner ? [owner] : jf.types) mark(`ann:${moduleOf(file)}/${simple(t.name)}`, { file, line: n, ...(s.side ? { side: s.side } : {}) }, `${base(file)}:${n} changed outside any method or field of ${simple(t.name)}`);
        }
      }
      continue;
    }
    if (kind === 'frontend' || comps.has(file)) {
      if (!comps.has(file) && !routeFiles.has(file)) {
        // a changed browser file the readers did not read: who runs it is not known
        const ext = file.split('.').pop() ?? '';
        if (/^(html|htm)$/.test(ext) && [...comps.keys()].some((f) => new RegExp(`['"]\\.?/?${base(file).replace(/[.]/g, '\\.')}['"]`).test(H.read(f) ?? ''))) { defWhole(file); continue; }
        unknownAt('global:fe', 'unread-file', `${base(file)} changed, and no reader read it`, { file, line: 1 });
        if (/src\/main\/resources\//.test(file)) unknownAt('global:java:*', 'unread-file', `${base(file)} changed: a page the server renders, which no reader follows`, { file, line: 1 });
        continue;
      }
      for (const s of [{ snap: H, sd: 'head' as const, u: uh }, { snap: B, sd: 'base' as const, u: ub }]) {
        const text = s.snap.read(file);
        if (text === null) continue;
        const lines = text.split('\n');
        const at = (line: number): Cite => ({ file, line, ...(s.sd === 'base' ? { side: 'base' as const } : {}) });
        const taken = new Set<number>();
        if (routeFiles.has(file)) {
          const rs = s.u.routes.filter((x) => x.file === file);
          for (const r of rs) {
            const own = routeLines(file, r.path, r.line, s.sd === 'base' ? 'base' : undefined, rs);
            def(`rdef:${file}#${r.path}`, s.sd, norm(lines.filter((_, i) => own.has(i + 1))), at(r.line), `the route ${r.path}`);
            for (const i of own) taken.add(i);
          }
          for (const im of importsOf(text)) {
            for (const n of im.names) def(`imp:${file}#${n}`, s.sd, norm(lines.slice(im.from - 1, im.to)), at(im.from), `the import of ${n}`);
            for (let i = im.from; i <= im.to; i++) taken.add(i);
          }
        }
        for (const x of (s.u.guards ?? []).filter((y) => y.file === file)) {
          const k = guardKey(x, s.sd === 'base' ? 'base' : undefined);
          def(k ? `guardk:${file}#${k}` : `guard:${file}`, s.sd, norm(lines.slice(x.line - 1, x.endLine)), at(x.line), k ? `the navigation guard on meta.${k}` : 'a navigation guard');
          for (let i = x.line; i <= x.endLine; i++) taken.add(i);
        }
        const members = s.u.components.get(file)?.members ?? [];
        const routeOwned = new Set(taken);
        for (const m of members) {
          // in a router, the route entries inside a member are the routes' own, not the member's
          def(`mem:${file}#${m.owner}.${m.member}`, s.sd, norm(lines.slice(m.start - 1, m.end).filter((_, i) => !routeOwned.has(m.start + i))), at(m.start), m.member === '()' ? m.owner : `${m.owner}.${m.member}`);
          for (let i = m.start; i <= m.end; i++) taken.add(i);
        }
        // TypeScript erases interfaces, type aliases and type-only imports: they run nothing
        if (/\.tsx?$/.test(file)) for (const i of typeOnlyLines(text)) taken.add(i);
        const rest = lines.filter((_, i) => !taken.has(i + 1));
        def(`txt:${file}`, s.sd, norm(rest), at(1), routeFiles.has(file) ? `the router in ${base(file)}` : base(file));
      }
      continue;
    }
    if (kind === 'config' && /\.(ya?ml|properties)$/.test(file)) {
      const mod = moduleOf(file);
      const props = file.endsWith('.properties');
      const read = (snap: Snapshot): Map<string, string> => { const t = snap.read(file); return t === null ? new Map() : props ? flattenProps(t) : flattenYaml(t); };
      const kb = read(B), kh = read(H);
      const keys = new Set<string>();
      for (const k of new Set([...kb.keys(), ...kh.keys()])) if (kb.get(k) !== kh.get(k)) keys.add(k);
      for (const [snap, ns] of [[H, cf.headLines], [B, cf.baseLines]] as const) { const ls = (snap.read(file) ?? '').split('\n'); for (const n of ns) { const k = configKey(ls, n, props); if (k) keys.add(k); } }
      const line = cf.headLines[0] ?? cf.baseLines[0] ?? 1;
      for (const k of keys) mark(`set:${mod}:${k}`, { file, line, ...(cf.headLines.length ? {} : { side: 'base' as const }) }, `the setting ${k}`);
      if (!keys.size && (cf.headLines.length || cf.baseLines.length)) { const ls = (H.read(file) ?? '').split('\n'); if (cf.headLines.some((n) => (ls[n - 1] ?? '').trim() && !/^\s*#/.test(ls[n - 1]!))) mark(`global:java:${mod}`, { file, line }, `${base(file)} changed in a way no setting key names`); }
      continue;
    }
    if (kind === 'i18n') {
      const read = (snap: Snapshot): Map<string, string> => { const t = snap.read(file); const out = new Map<string, string>(); if (t === null) return out; try { flattenJson(JSON.parse(t), '', out); } catch { for (const [k, v] of flattenProps(t)) out.set(k, v); } return out; };
      const kb = read(B), kh = read(H);
      for (const k of new Set([...kb.keys(), ...kh.keys()])) if (kb.get(k) !== kh.get(k)) mark(`i18n:${k}`, { file, line: cf.headLines[0] ?? 1 }, `the text ${k}`);
      continue;
    }
    if (kind === 'data' && /\.csv$/.test(file)) {
      const mod = moduleOf(file), name = base(file);
      const tables = new Set<string>();
      for (const f of H.files) if (/\.(xml|ya?ml|json|sql)$/.test(f)) { const ls = (H.read(f) ?? '').split('\n'); ls.forEach((l, i) => { if (!l.includes(name)) return; const win = ls.slice(Math.max(0, i - 3), i + 4).join(' '); const m = /tableName\s*[=:]\s*["']?([\w.]+)/.exec(win); if (m) tables.add(simple(m[1]!).toLowerCase()); }); }
      const known = [...tables].filter((t) => tableEntity.has(`${mod}/${t}`));
      if (known.length) for (const t of known) mark(`table:${mod}/${t}`, { file, line: cf.headLines[0] ?? 1 }, `the rows loaded into ${t}`);
      else mark(`table:${mod}/*`, { file, line: cf.headLines[0] ?? 1 }, `${name}: rows loaded into a table no entity was matched to`);
      continue;
    }
    if (kind === 'data' && /\.(sql|xml|ya?ml|json)$/.test(file) && /migration|changelog|db\/|flyway|liquibase|schema|\.sql$/i.test(file)) {
      const ls = [...cf.headLines.map((n) => H.line(file, n) ?? ''), ...cf.baseLines.map((n) => B.line(file, n) ?? '')].filter((l) => l.trim() && !/^\s*(<\?xml|<\/?databaseChangeLog|<\/?changeSet\b|<include\b|<includeAll\b|<!--|-->|--|#|\/\/|databaseChangeLog:|- include:|\s*file:|<\/?(preConditions|rollback|comment)\b)/i.test(l)).join('\n');
      if (!ls.trim()) continue;
      const tables = new Set<string>();
      for (const m of ls.matchAll(SQL_TABLES)) tables.add(simple(m[1]!.replace(/["`]/g, '')).toLowerCase());
      for (const m of ls.matchAll(/tableName\s*[=:]\s*["']?([\w.]+)/g)) tables.add(simple(m[1]!).toLowerCase());
      const mod = moduleOf(file);
      const known = [...tables].filter((t) => tableEntity.has(`${mod}/${t}`));
      if (known.length) for (const t of known) mark(`table:${mod}/${t}`, { file, line: cf.headLines[0] ?? 1 }, `the table ${t}`);
      else mark(`table:${mod}/*`, { file, line: cf.headLines[0] ?? 1 }, `${base(file)}: a change to the database no entity's table names`);
      continue;
    }
    if (kind === 'dependencies') {
      if (/(^|\/)package\.json$/.test(file)) { packageJson(cf); continue; }
      if (/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(file)) { lockfile(cf); continue; }
      if (/package(-lock)?\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(file)) mark('global:fe', { file, line: cf.headLines[0] ?? 1 }, `${base(file)}: the browser app's build changed`);
      else mark(file.includes('/') ? `global:java:${moduleOf(file)}` : 'global:java:*', { file, line: cf.headLines[0] ?? 1 }, `${base(file)}: the build changed`);
      continue;
    }
    if (kind === 'style' || kind === 'asset' || /\.env(\.|$)/.test(base(file))) { refFile(cf); continue; }
    // anything else: no fact says who reads it
    unknownAt('global:java:*', 'unread-file', `${base(file)} changed, and no reader follows ${kind} files`, { file, line: cf.headLines[0] ?? 1 });
    unknownAt('global:fe', 'unread-file', `${base(file)} changed, and no reader follows ${kind} files`, { file, line: cf.headLines[0] ?? 1 });
  }
  function defWhole(file: string): void {
    const tb = B.read(file), th = H.read(file);
    if (norm((tb ?? '').split('\n')) !== norm((th ?? '').split('\n'))) mark(`txt:${file}`, { file, line: changed.get(file)?.headLines[0] ?? 1 }, base(file));
  }
  /** A style, an asset or an env file: whoever names it depends on it. */
  function refFile(cf: ChangedFile): void {
    const file = cf.path, name = base(file);
    const at: Cite = { file, line: cf.headLines[0] ?? 1 };
    if (/\.env(\.|$)/.test(name)) {
      const kb = flattenProps(B.read(file) ?? ''), kh = flattenProps(H.read(file) ?? '');
      for (const k of new Set([...kb.keys(), ...kh.keys()])) if (kb.get(k) !== kh.get(k)) {
        const users = [...comps.keys()].filter((f) => (H.read(f) ?? '').includes(k));
        for (const u of users) g.edge(`txt:${u}`, `env:${k}`);
        mark(`env:${k}`, at, `the setting ${k}`);
        if (!users.length) assume('A variable in an .env file that no browser file names is not read by it.');
      }
      return;
    }
    if (cf.binary || defsDiffer(file)) {
      const partial = name.replace(/^_/, '').replace(/\.(scss|sass|less|css)$/, '');
      const users = [...comps.keys()].filter((f) => { const t = H.read(f) ?? B.read(f) ?? ''; return t.includes(name) || new RegExp(`@(use|import|forward)\\s+['"][^'"]*\\b${partial}['"]`).test(t); });
      for (const u of users) g.edge(`txt:${u}`, `file:${file}`);
      mark(`file:${file}`, at, name);
      if (!users.length) {
        const configs = H.files.filter((f) => /(^|\/)(angular\.json|index\.html|vite\.config\.\w+|webpack\.config\.\w+|main\.\w+)$/.test(f) && (H.read(f) ?? '').includes(name));
        if (configs.length) g.edge('global:fe', `file:${file}`);
        else unknownAt('global:fe', 'unreferenced', `${name} changed, and no file of the app was seen naming it`, at);
      }
    }
  }
  /** package.json: a changed runtime dependency reaches the files that import it; any other change, the whole build. */
  function packageJson(cf: ChangedFile): void {
    const at: Cite = { file: cf.path, line: cf.headLines[0] ?? cf.baseLines[0] ?? 1, ...(cf.headLines.length ? {} : { side: 'base' as const }) };
    const read = (snap: Snapshot): Record<string, unknown> | null => { try { return JSON.parse(snap.read(cf.path) ?? '{}') as Record<string, unknown>; } catch { return null; } };
    const b = read(B), h = read(H);
    if (!b || !h) { mark('global:fe', at, `${base(cf.path)}: the browser app's build changed`); return; }
    const runtime = ['dependencies', 'peerDependencies', 'optionalDependencies'];
    const other = new Set([...Object.keys(b), ...Object.keys(h)].filter((k) => !runtime.includes(k) && JSON.stringify(b[k]) !== JSON.stringify(h[k])));
    if (other.size) { mark('global:fe', at, `${base(cf.path)}: ${[...other].join(', ')} changed`); return; }
    for (const sec of runtime) {
      const x = (b[sec] ?? {}) as Record<string, string>, y = (h[sec] ?? {}) as Record<string, string>;
      for (const n of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[n] !== y[n]) { pkgDelta(n, at, `${n} ${x[n] ?? '(none)'} → ${y[n] ?? '(none)'}`); }
    }
  }
  /** A lockfile: the packages whose entries changed. One that no app file imports is a transitive change: the whole build. */
  function lockfile(cf: ChangedFile): void {
    const names = new Set<string>();
    for (const [snap, ns] of [[H, cf.headLines], [B, cf.baseLines]] as const) {
      const ls = (snap.read(cf.path) ?? '').split('\n');
      for (const n of ns) {
        for (let i = n - 1; i >= 0; i--) {
          const l = ls[i]!;
          const m = /"node_modules\/((?:@[^/"]+\/)?[^/"]+)"\s*:/.exec(l) ?? /^"?((?:@[^@/"\s]+\/)?[^@/"\s]+)@[^:]*:\s*$/.exec(l) ?? /^\s{2}\/?((?:@[^@/\s]+\/)?[^@/\s]+)@[^:]+:\s*$/.exec(l);
          if (m) { names.add(m[1]!); break; }
          if (i < n - 400) break;
        }
      }
    }
    const at: Cite = { file: cf.path, line: cf.headLines[0] ?? 1 };
    const imported = new Set([...comps.values()].flatMap((l) => l.flatMap(({ c }) => c.packages)));
    if (!names.size || [...names].some((n) => !imported.has(n))) { mark('global:fe', at, `${base(cf.path)}: ${names.size ? `${[...names].filter((n) => !imported.has(n)).slice(0, 3).join(', ')}, which no app file imports, changed` : 'the locked packages changed'}`); return; }
    for (const n of names) pkgDelta(n, at, `${n} (locked version)`);
  }
  function pkgDelta(name: string, at: Cite, what: string): void {
    mark(`pkg:${name}`, at, what);
    for (const [f, l] of comps) if (l.some(({ c }) => c.packages.some((p) => p === name || p.startsWith(`${name}/`)))) g.edge(`txt:${f}`, `pkg:${name}`);
  }
  /** The paths a security method's changed lines name, or null when a changed line names none (it changes every path). */
  function securityScope(spans: { file: string; side?: 'base'; from: number; to: number }[]): { patterns: string[]; csrf: boolean } | null {
    const patterns = new Set<string>();
    let csrf = false;
    for (const sp of spans) {
      const cf = changed.get(sp.file);
      if (!cf) continue;
      const snap = sp.side ? B : H;
      const ls = (snap.read(sp.file) ?? '').split('\n');
      for (const n of (sp.side ? cf.baseLines : cf.headLines).filter((x) => x >= sp.from && x <= sp.to)) {
        const l = ls[n - 1] ?? '';
        if (!l.trim() || /^\s*(\/\/|\*)/.test(l)) continue;
        if (/csrf/i.test(l)) { csrf = true; continue; }
        // a rule on its own line belongs to the matcher above it in the same chain
        let i = n - 1;
        while (i > 0 && !MATCHER.test(ls[i]!) && /^\s*\./.test(ls[i]!)) i--;
        const m = MATCHER.exec(ls[i]!);
        if (!m) return null;
        const ps = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
        if (!ps.length) return null;
        for (const p of ps) patterns.add(p);
      }
    }
    return { patterns: [...patterns], csrf };
  }
  function ownerKey(node: string): string { const b = node.slice(node.indexOf(':') + 1); return b.slice(0, b.lastIndexOf('.')); }
  function defsDiffer(file: string): boolean { return norm((B.read(file) ?? '').split('\n')) !== norm((H.read(file) ?? '').split('\n')); }
  for (const [node, d] of defs) if ((d.b ?? null) !== (d.h ?? null)) mark(node, d.at ?? { file: '?', line: 1 }, d.b === undefined ? `${d.what} (new)` : d.h === undefined ? `${d.what} (removed)` : d.what ?? node);
  // a security rule changed only for some paths reaches the endpoints those paths match; a CSRF change, the ones that change state
  for (const [n, at] of [...delta]) {
    if (!n.startsWith('m:')) continue;
    const key = ownerKey(n), name = n.slice(n.lastIndexOf('.') + 1), mod = modOf(key);
    const recs = (types.get(key) ?? []).flatMap((r) => r.t.methods.filter((m) => m.name === name).map((m) => ({ r, m })));
    if (!recs.length || !recs.every(({ m }) => /SecurityFilterChain/.test(m.returnType) || m.body.some((x) => /^(authorizeHttpRequests|authorizeRequests)$/.test(x.t)))) continue;
    const scoped: { patterns: string[]; csrf: boolean } | null = securityScope(recs.map(({ r, m }) => ({ file: r.file, ...(r.side ? { side: r.side } : {}), from: Math.min(m.line, ...m.annotations.map((a) => a.line)), to: m.endLine })));
    if (!scoped) continue;
    const eps = endpoints.filter((e) => moduleOf(e.file) === mod);
    if (!eps.length) continue;
    delta.delete(n);
    for (const p of scoped.patterns) { mark(`sec:${mod}:${p}`, at, `the security rule for ${p}`); for (const e of eps) if (antMatch(p, e.path)) g.edge(epId(e), `sec:${mod}:${p}`); }
    if (scoped.csrf) { mark(`csrf:${mod}`, at, 'CSRF protection'); for (const e of eps) if (e.verb !== 'GET') g.edge(epId(e), `csrf:${mod}`); }
  }
  // an entity's mapping changed, and no migration in this PR touches its table: every row of it is read differently
  for (const [n, at] of [...delta]) {
    const m = /^(?:f:(.+)\.[^.]+|ann:(.+))$/.exec(n);
    const key = m ? m[1] ?? m[2]! : '';
    if (!entityTable.has(key)) continue;
    const tb = `table:${modOf(key)}/${entityTable.get(key)}`;
    if (!delta.has(tb)) mark(tb, at, `the mapping of ${clsOf(key)} (${at.what}), with no migration in this change`);
  }

  // a service that may not start (a bean it cannot make, a derived query it cannot build, a migration Flyway refuses):
  // every area of it is down. These are read from both commits' facts by startup.ts.
  for (const r of startupRisks(B, H, fb, fh, inp.changes)) {
    const at: Cite = { file: r.hop.file, line: r.hop.line, ...(r.hop.side === 'base' ? { side: 'base' as const } : {}) };
    if (r.certain) mark(`global:java:${r.module}`, at, `the service may not start: ${r.reason}`);
    else unknownAt(`global:java:${r.module}`, 'startup', `the service may not start: ${r.reason}`, at);
  }

  /* ---------------- settings: who reads a changed key ---------------- */
  for (const [node, at] of [...delta]) {
    if (!node.startsWith('set:')) continue;
    const [, mod, ...rest] = node.split(':');
    const key = rest.join(':');
    const readers = settingRefs.filter((r) => (r.module === mod || !mod) && keysMeet(r.key, key));
    for (const r of readers) g.edge(r.node, node);
    if (readers.length) continue;
    if (INERT_SETTING.test(key)) { assume('Settings under logging, management, info and springdoc change nothing a user sees.'); continue; }
    if (/^spring\.jackson(\.|$)/.test(key)) g.edge(`web:${mod}`, node);
    const client = CLIENT_KEYS.find(([re]) => re.test(key));
    if (client) {
      const users = [...types].filter(([k, ds]) => modOf(k) === mod && ds.some(({ t }) => t.fields.some((fl) => client[1].test(simple(strip(fl.type)))) || t.methods.some((m) => m.params.some((p) => client[1].test(simple(strip(p.type)))))));
      for (const [k, ds] of users) for (const { t } of ds) for (const m of t.methods) g.edge(`m:${k}.${m.name}`, node);
      if (!users.length) assume('A framework setting for a client (mail, a broker, a cache) that no code here uses changes nothing it runs.');
      continue;
    }
    if (/^spring\.kafka(\.|$)/.test(key)) { if (!/^spring\.kafka\.producer\./.test(key)) for (const l of [...fh.listeners, ...fb.listeners]) if (moduleOf(l.file) === mod) g.edge(`kafka:${mod}`, node); if (!/^spring\.kafka\.consumer\./.test(key)) for (const p of producers) if (moduleOf(p.file) === mod) g.edge(`m:${mod}/${p.from}`, node); continue; }
    // read by the framework: it can change any request this module serves
    g.edge(`global:java:${mod}`, node);
    g.at(node, at);
  }
  for (const [node] of delta) if (node.startsWith('i18n:')) {
    const k = node.slice(5);
    const users = [...comps.keys()].filter((f) => (H.read(f) ?? '').includes(k));
    for (const u of users) g.edge(`txt:${u}`, node);
    for (const r of settingRefs) if (r.key === k) g.edge(r.node, node);
    if (!users.length) { const dyn = [...comps.keys()].filter((f) => /\$t\(\s*[^'"\s)]|\btranslate\.(instant|get)\(\s*[^'"\s)]|\|\s*translate\b/.test(H.read(f) ?? '')); for (const u of dyn) g.edge(`txt:${u}`, node); if (!dyn.length && !settingRefs.some((r) => r.key === k)) assume('A text key that no file names, and no file looks up by a computed key, is not shown.'); }
  }
  if ([...delta.keys()].some((n) => n.startsWith('rules:'))) assume('Request rules (Bean Validation) run only where a parameter is @Valid or @Validated, or on JPA entities.');
  if ([...delta.keys()].some((n) => n.startsWith('m:') || n.startsWith('f:'))) assume('Jackson and JPA touch a data type only through its fields, accessors, constructors and lifecycle callbacks.');
  assume('Facts come from Teslon\'s own readers (a tokenizer and parsers, not a compiler). What they could not pin down is widened or counted as unknown.');

  // a screen's links and pushes go to routes: a route that moves or goes breaks them
  const routeHit = (target: string, r: { path: string; file: string }, side?: 'base'): boolean => {
    const named = /name\s*:\s*['"]([\w-]+)['"]/.exec(target)?.[1];
    if (named) { const sp = spanOf(r.file, (side ? ub : uh).routes.find((x) => x.path === r.path && x.file === r.file)?.line ?? 0, side); return new RegExp(`name\\s*:\\s*['"]${named}['"]`).test(((side ? B : H).read(r.file) ?? '').split('\n').slice(sp.from - 1, sp.to).join('\n')); }
    const t = target.trim().replace(/^[`'"]|[`'"]$/g, '').replace(/\$\{[^}]*\}/g, '{*}').replace(/['"`]\s*\+\s*[^+'"`]+(\s*\+\s*['"`])?/g, '{*}').replace(/\?.*$/, '');
    if (!t.startsWith('/')) return false;
    return templateHits(t.replace(/\{\*\}\/?$/, '{*}'), r.path.replace(/:\w+\??/g, '{x}')) || t === r.path;
  };
  // a link that names a route's path exactly goes there: the router ranks a static path above a pattern
  const literal = (target: string): string | null => { const t = target.trim().replace(/^[`'"]|[`'"]$/g, '').replace(/\?.*$/, ''); return /^\/[^${}+'"`]*$/.test(t) ? t : null; };
  for (const [file, list] of comps) for (const { c } of list) for (const l of [...c.links, ...c.pushes]) {
    const lit = literal(l.target);
    const exact = lit ? routes.filter(({ r }) => r.path === lit) : [];
    for (const { r, side } of exact.length ? exact : routes) if (exact.length || routeHit(l.target, r, side)) g.edge(`txt:${file}`, `rpath:${r.path}`);
  }

  // what a write or a message carries is made upstream too: by the method that writes or sends, and by its callers
  const rev = new Map<string, Set<string>>();
  for (const [n, xs] of g.edges) if (n.startsWith('m:')) for (const x of xs) if (x.startsWith('m:')) { if (!rev.has(x)) rev.set(x, new Set()); rev.get(x)!.add(n); }
  for (const [x, ns] of rev) for (const n of ns) { g.edge(`callers:${x}`, n); g.edge(`callers:${x}`, `callers:${n}`); }
  for (const [n, xs] of [...g.edges]) if (n.startsWith('data:') || n.startsWith('topic:')) for (const x of [...xs]) if (x.startsWith('m:')) g.edge(n, `callers:${x}`);

  /* ---------------- the certificates ---------------- */
  // a screen on one side only has moved or gone: that is a change to the screen itself
  const basePaths = new Set(ub.routes.map((r) => r.path));
  for (const a of inp.areas) if (a.startsWith('screen:')) {
    const path = a.slice(7), inB = basePaths.has(path), inH = headPaths.has(path);
    if (inB !== inH) { const r = (inH ? uh : ub).routes.find((x) => x.path === path)!; mark(a, { file: r.file, line: r.line, ...(inH ? {} : { side: 'base' as const }) }, `the screen ${path} (${inH ? 'new' : 'gone or moved'})`); }
  }
  // a link depends on its route's path existing: one on one side only has moved or gone
  for (const { r, side } of routes) { const inB = basePaths.has(r.path), inH = headPaths.has(r.path); if (inB !== inH) mark(`rpath:${r.path}`, { file: r.file, line: r.line, ...(side ? { side } : {}) }, `the route ${r.path} (${inH ? 'new' : 'gone or moved'})`); }
  // an area the facts hold nothing for cannot be proven
  for (const a of inp.areas) if (!g.edges.get(a)?.size) { unknown.set(`unknown:no-area:${a}`, { kind: 'no-area', what: `${a} is not in the facts of either commit`, at: { file: '?', line: 0 } }); g.edge(a, `unknown:no-area:${a}`); }
  const inactiveMemo = new Map<string, boolean>();
  const inactiveKey = (k: string): boolean => { if (!inactiveMemo.has(k)) inactiveMemo.set(k, types.has(k) && inactive(k)); return inactiveMemo.get(k)!; };
  const ownerOf = (node: string): string => { const b = node.slice(node.indexOf(':') + 1); return node.startsWith('ann:') ? b : b.slice(0, b.lastIndexOf('.')); };
  /** Does the edge n → x carry a value (a shape, a field of a data type, rows, a message) rather than run code? */
  const carries = (n: string, x: string): boolean => {
    if (codeEdges.has(`${n}>${x}`)) return false;
    // an implementation the settings here switch off: the skip relies on those settings being the ones deployed
    if (n.startsWith('m:') && x.startsWith('m:') && ownerOf(n) !== ownerOf(x) && inactiveKey(ownerOf(x))) return true;
    if (n.startsWith('shape:') || x.startsWith('shape:') || n.startsWith('data:') || x.startsWith('data:') || n.startsWith('callers:') || x.startsWith('callers:')) return true;
    if (n.startsWith('topic:') && x.startsWith('m:')) return true;
    if (contentEdges.has(`${n}>${x}`)) return true;
    if ((n.startsWith('m:') || n.startsWith('f:')) && (x.startsWith('f:') || x.startsWith('ann:'))) return ownerOf(n) !== ownerOf(x) || !beans.has(ownerOf(x));
    return false;
  };
  const dsorted = [...delta.keys()].sort();
  const proofs: Certificate[] = [];
  const blocks = new Map<string, Set<string>>();
  const debugClosure: string[] = [];
  for (const area of inp.areas) {
    // the graph walked with two marks: inside the code that writes rows the area reads (w), and past an edge that
    // carries a value rather than runs code (s). A node reached with s = 0 is code the area runs.
    const seen = new Map<string, string | null>([[`00|${area}`, null]]);
    const queue = [`00|${area}`];
    while (queue.length) {
      const k = queue.shift()!;
      const w = k[0]!, sf = k[1]!, n = k.slice(3);
      for (const x of g.edges.get(n) ?? []) {
        let nw = w;
        if (n.startsWith('data:') && (x.startsWith('m:') || x.startsWith('callers:'))) { if (DATA === 'code') continue; nw = '1'; }
        if (nw === '1' && DATA !== 'full' && x.startsWith('data:') && !n.startsWith('data:')) continue;
        if (nw === '1' && DATA === 'service' && w === '1' && (x.startsWith('ep:') && n.startsWith('m:') || x.startsWith('topic:'))) continue;
        const ns = sf === '1' || carries(n, x) ? '1' : '0';
        const kx = `${nw}${ns}|${x}`;
        if (!seen.has(kx)) { seen.set(kx, k); queue.push(kx); }
      }
    }
    const runs = new Set<string>(), parent = new Map<string, string | null>();
    for (const [k, v] of seen) { const n = k.slice(3); if (k[1] === '0') runs.add(n); if (!parent.has(n)) parent.set(n, v); }
    const pathTo = (n: string): string[] => { const out: string[] = []; let k: string | null | undefined = [...['00', '10', '01', '11']].map((p) => `${p}|${n}`).find((x) => seen.has(x)); while (k) { out.unshift(k.slice(3)); k = seen.get(k); } return out; };
    const chainOf = (path: readonly string[]): string[] => path.map((x) => g.cite.get(x)?.what ?? (x.startsWith('ep:') ? x.slice(x.indexOf('|') + 1) : x.startsWith('data:') ? `${x.slice(5)} rows` : x.startsWith('topic:') ? `topic ${x.slice(6)}` : x.startsWith('set:') ? `setting ${x.split(':').slice(2).join(':')}` : '')).filter(Boolean).filter((x, i, a) => a[i - 1] !== x);
    const blockers: Blocker[] = [];
    const relies: Blocker[] = [];
    for (const n of parent.keys()) {
      const into = runs.has(n) ? blockers : relies;
      const d = delta.get(n);
      if (d) { const path = pathTo(n); into.push({ kind: 'changed', node: n, what: d.what, at: { file: d.file, line: d.line, ...(d.side ? { side: d.side } : {}) }, path, chain: chainOf(path) }); }
      const u = unknown.get(n);
      if (u) { const path = pathTo(n); into.push({ kind: 'unknown', node: n, what: u.what, at: u.at, path, chain: chainOf(path) }); if (runs.has(n)) { if (!blocks.has(n)) blocks.set(n, new Set()); blocks.get(n)!.add(area); } }
    }
    blockers.sort((a, b) => a.path.length - b.path.length);
    relies.sort((a, b) => a.path.length - b.path.length);
    const files = new Set([...parent.keys()].map((n) => g.cite.get(n)?.file).filter(Boolean));
    const digest = createHash('sha256').update([...parent.keys()].sort().join('\n')).update('\n--\n').update(dsorted.join('\n')).digest('hex');
    proofs.push({ area, ok: !blockers.length, nodes: parent.size, files: files.size, digest, blockers, relies: relies.slice(0, 5) });
    if (process.env['TESLON_CERT_DEBUG']) debugClosure.push(...parent.keys());
  }
  const unknowns: UnknownEntry[] = [...unknown].map(([id, u]) => ({ id, kind: u.kind, what: u.what, at: u.at, blocks: [...(blocks.get(id) ?? [])].sort() })).sort((a, b) => b.blocks.length - a.blocks.length || a.id.localeCompare(b.id));
  const byKind: Record<string, number> = {};
  for (const n of delta.keys()) { const k = n.slice(0, n.indexOf(':')); byKind[k] = (byKind[k] ?? 0) + 1; }
  void lineText;
  return {
    proofs, unknowns, changed: byKind,
    dangling: { calls, widened, rate: calls ? widened / calls : 0, unmatched },
    assumptions: [...assumed].map(([text, uses]) => ({ text, uses })),
    ms: Date.now() - t0,
    ...(process.env['TESLON_CERT_DEBUG'] ? { debug: { delta: [...delta.keys()], closure: debugClosure } } : {}),
  };

  function sqlTables(body: readonly Tok[], mod: string): string[] {
    const out = new Set<string>();
    for (const x of body) if (/^"/.test(x.t)) for (const m of x.t.matchAll(SQL_TABLES)) { const n = simple(m[1]!); const e = tableEntity.get(`${mod}/${n.toLowerCase()}`) ?? entityOf(n, mod); if (e) out.add(e); }
    return [...out];
  }
}

const MATCHER = /(?:request|ant|mvc|path|security|regex)Matchers?\(([^)]*)\)/;
/** Does a Spring path pattern (/api/reports/** or /api/{x}/items) match an endpoint path (/api/reports/{id})? */
function antMatch(pattern: string, path: string): boolean {
  const re = pattern.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '[^/]+').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\/\u0000/g, '(/.*)?').replace(/\u0000/g, '.*');
  return new RegExp(`^${re}/?$`).test(path.replace(/\{[^}]*\}/g, 'x'));
}
/** Lines of a TypeScript text that only declare types: `interface X { … }`, `type X = …;`, `import type …`. */
function typeOnlyLines(text: string): Set<number> {
  const out = new Set<number>();
  const lines = text.split('\n');
  const spans = braceSpans(text);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*import\s+type\b/.test(l)) { for (let k = i; k < lines.length; k++) { out.add(k + 1); if (/;\s*$|from\s+['"][^'"]+['"]/.test(lines[k]!)) break; } continue; }
    if (/^\s*(export\s+)?(declare\s+)?interface\s+\w+/.test(l)) {
      const sp = spans.filter((s) => s.from === i + 1).sort((a, b) => b.to - a.to)[0] ?? spans.filter((s) => s.from > i + 1 && s.from <= i + 3).sort((a, b) => a.from - b.from)[0];
      if (!sp) continue;
      for (let k = i + 1; k <= sp.to; k++) out.add(k);
      continue;
    }
    if (/^\s*(export\s+)?(declare\s+)?type\s+\w+(\s*<[^=]*>)?\s*=/.test(l)) {
      let depth = 0;
      for (let k = i; k < lines.length; k++) {
        const t = lines[k]!.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
        depth += (t.match(/[{(<[]/g)?.length ?? 0) - (t.match(/[})>\]]/g)?.length ?? 0);
        out.add(k + 1);
        if (depth <= 0 && (/;\s*$/.test(t) || !/[|&=,]\s*$/.test(t) && !/^\s*[|&]/.test(lines[k + 1] ?? ''))) break;
      }
    }
  }
  return out;
}
/** The function a line sits in, when `param` is one of its parameters: the name it is called by. */
function enclosingFn(lines: readonly string[], at: number, param: string): string | null {
  // the nearest function above whose block is still open at this line
  let depth = 0;
  for (let i = at - 1; i >= 0 && i > at - 400; i--) {
    const l = lines[i]!.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (depth <= 0) continue;
    const m = /\bfunction\s*([\w$]+)?\s*\(([^)]*)\)/.exec(l) ?? /([\w$]+)\s*[:=]\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(l) ?? /^\s*(?:async\s+)?([\w$]+)\s*\(([^)]*)\)\s*(?::[^{]*)?\{/.exec(l);
    if (m) return m[2]!.split(',').map((x) => x.trim().split(/[\s:=?]/)[0]).includes(param) ? m[1] ?? null : null;
    depth = 0;
  }
  return null;
}

function join(file: string, rel: string): string {
  const parts = file.split('/').slice(0, -1);
  for (const p of rel.split('/')) { if (p === '.' || !p) continue; if (p === '..') parts.pop(); else parts.push(p); }
  return parts.join('/');
}

/** Names in a browser file that make HTTP calls: axios, an Angular HttpClient, an axios instance it imports, fetch. */
function httpNames(text: string, file: string, read: (f: string) => string): Set<string> {
  const out = new Set<string>(['fetch', '$fetch']);
  if (/from\s+['"]axios['"]/.test(text)) { out.add('axios'); for (const m of text.matchAll(/import\s+(\w+)\s+from\s+['"]axios['"]/g)) out.add(m[1]!); }
  for (const m of text.matchAll(/(\w+)\s*[:=]\s*(?:inject\()?HttpClient\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(\w+)\s*=\s*axios\.create\s*\(/g)) out.add(m[1]!);
  for (const m of text.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = join(file, m[3]!);
    const t = [target, `${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`].map(read).find((x) => x) ?? '';
    if (!/axios\.create\s*\(/.test(t)) continue;
    if (m[1]) out.add(m[1]);
    for (const n of (m[2] ?? '').split(',')) { const b = n.trim().split(/\s+as\s+/).pop(); if (b) out.add(b); }
  }
  return out;
}
