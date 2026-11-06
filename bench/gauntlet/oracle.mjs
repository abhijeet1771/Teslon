/**
 * The compiler oracle: which areas of an app run a given method, worked out from the compiled classes and a
 * hand-written map of what each screen calls. It shares no code and no rules with Teslon.
 *
 * Facts come from javap (javap.mjs). On top of the call graph (class hierarchy analysis for virtual and
 * interface calls, lambdas and method references through their bootstrap handles), it adds the edges the
 * framework makes at run time, each with its kind:
 *
 *   call, lambda, callback, clinit      plain code
 *   json-out / json-in                  Jackson writes a response (getters) or reads a body (setters, constructors)
 *   validate                            a custom constraint's validator, under @Valid
 *   error                               an @ExceptionHandler, for the flows that can throw what it handles
 *   event                               a synchronous Spring event listener
 *   http                                a Feign call to another service's endpoint
 *   jpa                                 an entity's lifecycle callbacks, on save and load
 *   framework                           a bean every request of the service passes through
 *   async, kafka                        another thread, or another service through a topic: what the change does
 *                                       there is content for the area that started it, not code it runs
 *   inactive                            an implementation the settings here switch off
 *
 * An area is reached HARD when some path from it to the method uses only run-time kinds, and reached as
 * CONTENT when every path goes through async, kafka or inactive.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readModule, parseMethodSig, parseFieldSig, strings, classes as annClasses, enums } from './javap.mjs';

export const HARD = new Set(['call', 'lambda', 'callback', 'clinit', 'json-out', 'json-in', 'validate', 'error', 'event', 'http', 'jpa', 'framework', 'aop', 'route']);

/* ---------- a small YAML reader: nested keys and scalars, enough for application.yml ---------- */
export function flatYaml(text) {
  const out = {};
  const stack = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const ind = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t.startsWith('- ')) continue;
    const m = /^([^:]+):\s*(.*)$/.exec(t);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    const key = [...stack.map((s) => s.key), m[1].trim()].join('.');
    if (m[2] === '') stack.push({ ind, key: m[1].trim() });
    else out[key] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const resolve = (s, props) => s.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_, k, d) => props[k] ?? props[k.replace(/-/g, '')] ?? d ?? `\${${k}}`);

const LIB_SUPERS = {
  'java.lang.IllegalStateException': 'java.lang.RuntimeException', 'java.lang.IllegalArgumentException': 'java.lang.RuntimeException',
  'java.lang.NumberFormatException': 'java.lang.IllegalArgumentException', 'java.util.NoSuchElementException': 'java.lang.RuntimeException',
  'java.lang.UnsupportedOperationException': 'java.lang.RuntimeException', 'java.lang.NullPointerException': 'java.lang.RuntimeException',
  'org.springframework.web.server.ResponseStatusException': 'java.lang.RuntimeException', 'jakarta.persistence.EntityNotFoundException': 'java.lang.RuntimeException',
  'jakarta.validation.ConstraintViolationException': 'java.lang.RuntimeException', 'org.springframework.dao.DataIntegrityViolationException': 'java.lang.RuntimeException',
  'org.springframework.web.bind.MethodArgumentNotValidException': 'java.lang.Exception', 'org.springframework.http.converter.HttpMessageNotReadableException': 'java.lang.RuntimeException',
  'java.lang.RuntimeException': 'java.lang.Exception', 'java.lang.Exception': 'java.lang.Throwable',
};
const CONTAINERS = new Set(['org.springframework.http.ResponseEntity', 'java.util.List', 'java.util.Set', 'java.util.Collection', 'java.util.Optional', 'org.springframework.data.domain.Page', 'org.springframework.data.domain.Slice', 'java.lang.Iterable', 'java.util.stream.Stream', 'java.util.concurrent.CompletableFuture', 'array', 'org.springframework.http.HttpEntity']);
const REPO_BASES = /^org\.springframework\.data\.(jpa\.repository\.JpaRepository|repository\.(CrudRepository|ListCrudRepository|PagingAndSortingRepository|ListPagingAndSortingRepository|Repository))$/;
const WEB_ANN = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: null };
const FRAMEWORK_BEANS = /(SecurityFilterChain|WebSecurityCustomizer|WebMvcConfigurer|ObjectMapper|Jackson2ObjectMapperBuilderCustomizer|CorsConfigurationSource|HandlerInterceptor|Filter|FilterRegistrationBean|HttpMessageConverter|LocaleResolver|MessageSource)$/;

const simple = (n) => n.split('.').pop();
const short = (n) => simple(n).replace(/^.*\$/, '');
export const mid = (cls, name, desc) => `${cls}.${name}${desc}`;
const descTypes = (desc) => {
  const out = [];
  for (const m of desc.matchAll(/L([\w/$]+);/g)) out.push(m[1].replace(/\//g, '.'));
  return out;
};
const retOf = (desc) => { const r = desc.slice(desc.indexOf(')') + 1); const m = /^\[*L([\w/$]+);/.exec(r); return m ? m[1].replace(/\//g, '.') : null; };
const paramTypes = (desc) => { const p = desc.slice(1, desc.indexOf(')')); const out = []; let i = 0; while (i < p.length) { let a = ''; while (p[i] === '[') a += p[i++]; if (p[i] === 'L') { const e = p.indexOf(';', i); out.push(p.slice(i + 1, e).replace(/\//g, '.')); i = e + 1; } else { out.push(p[i]); i++; } } return out; };
const typeNames = (t, acc = []) => { if (!t) return acc; acc.push(t.name); for (const a of t.args ?? []) typeNames(a, acc); return acc; };

export function buildOracle(cfg) {
  const classes = [];
  const props = {};
  for (const mod of cfg.modules) {
    const cs = readModule(mod.classDir, mod.name);
    const yml = mod.yml && existsSync(mod.yml) ? flatYaml(readFileSync(mod.yml, 'utf8')) : {};
    props[mod.name] = yml;
    mod.appName = yml['spring.application.name'] ?? mod.name;
    for (const c of cs) { c.srcRoot = mod.srcRoot; classes.push(c); }
  }
  const byName = new Map(classes.map((c) => [c.name, c]));
  const app = (n) => byName.has(n);
  const kids = new Map();
  for (const c of classes) for (const s of [c.super, ...c.ifaces]) if (s) { if (!kids.has(s)) kids.set(s, []); kids.get(s).push(c.name); }
  const subtypes = (n) => { const out = new Set([n]); const q = [n]; while (q.length) for (const k of kids.get(q.shift()) ?? []) if (!out.has(k)) { out.add(k); q.push(k); } return out; };
  const supersOf = (n) => { const out = []; const q = [n]; const seen = new Set(); while (q.length) { const x = q.shift(); if (seen.has(x)) continue; seen.add(x); out.push(x); const c = byName.get(x); if (c) q.push(...[c.super, ...c.ifaces].filter(Boolean)); else if (LIB_SUPERS[x]) q.push(LIB_SUPERS[x]); } return out; };
  const isA = (n, s) => supersOf(n).includes(s);
  const methods = new Map();
  for (const c of classes) for (const m of c.methods) { m.cls = c; m.id = mid(c.name, m.name, m.desc); methods.set(m.id, m); }
  const declared = (cls, name, desc) => byName.get(cls)?.methods.find((m) => m.name === name && m.desc === desc);
  const concrete = (m) => m && !/ACC_ABSTRACT/.test(m.flags);
  const ann = (list, t) => list.find((a) => a.type.endsWith(`.${t}`) || a.type === t);
  const hasAnn = (list, t) => !!ann(list, t);

  // resolve a call to the app methods it can run
  function resolveCall(op, owner, name, desc) {
    const out = new Set();
    if (!app(owner)) {
      if (op === 'invokestatic' || op === 'invokespecial' || owner === 'java.lang.Object' || owner === 'java.lang.Record' || owner === 'java.lang.Enum') return out;
      for (const s of subtypes(owner)) { const d = declared(s, name, desc); if (concrete(d)) out.add(d.id); }
      return out;
    }
    if (op === 'invokestatic' || op === 'invokespecial') {
      for (const s of supersOf(owner)) { const d = declared(s, name, desc); if (d) { if (concrete(d)) out.add(d.id); break; } }
      return out;
    }
    // inherited implementation
    for (const s of supersOf(owner)) {
      const d = declared(s, name, desc);
      if (d) { if (concrete(d)) out.add(d.id); else for (const k of subtypes(s)) { const dk = declared(k, name, desc); if (concrete(dk)) out.add(dk.id); } break; }
    }
    for (const s of subtypes(owner)) { const d = declared(s, name, desc); if (concrete(d)) out.add(d.id); }
    return out;
  }

  /* ---------- edges ---------- */
  const edges = new Map(); // from → [{ to, kind, at }]
  const add = (from, to, kind, at) => { if (!edges.has(from)) edges.set(from, []); edges.get(from).push({ to, kind, at }); };
  const asyncM = (m) => hasAnn(m.ann, 'Async') || hasAnn(m.cls.ann, 'Async');
  const repoEntity = new Map();
  for (const c of classes) {
    if (c.kind !== 'interface') continue;
    for (const s of supersOf(c.name)) {
      const sc = byName.get(s) ?? c;
      const sup = (sc.supers ?? []).find((x) => REPO_BASES.test(x.name));
      if (sup && sup.args[0]) { repoEntity.set(c.name, sup.args[0].name); break; }
    }
  }
  for (const m of methods.values()) {
    for (const k of m.calls) {
      for (const t of resolveCall(k.op, k.owner, k.name, k.desc)) {
        const tm = methods.get(t);
        add(m.id, t, asyncM(tm) && tm.cls !== m.cls ? 'async' : inactive(tm.cls) ? 'inactive' : 'call', k);
      }
      if (app(k.owner) && byName.get(k.owner).methods.some((x) => x.name === '<clinit>') && k.op === 'invokestatic') add(m.id, mid(k.owner, '<clinit>', '()V'), 'clinit');
    }
    for (const f of m.fieldsRead) if (f.static && app(f.owner) && f.owner !== m.cls.name) { const cl = declared(f.owner, '<clinit>', '()V'); if (cl) add(m.id, cl.id, 'clinit'); }
    for (const y of m.indy) {
      const b = m.cls.bootstrap[y.bsm];
      if (!b || !/LambdaMetafactory/.test(b.factory)) continue;
      for (const h of b.handles) {
        const op = { invokeStatic: 'invokestatic', invokeSpecial: 'invokespecial', invokeVirtual: 'invokevirtual', invokeInterface: 'invokeinterface', newInvokeSpecial: 'invokespecial' }[h.ref];
        if (!op) continue;
        for (const t of resolveCall(op, h.owner, h.name, h.desc)) add(m.id, t, asyncM(methods.get(t)) ? 'async' : 'lambda', h);
      }
    }
    for (const n of m.news) {
      if (n.startsWith('ref:') || !app(n)) continue;
      const c = byName.get(n);
      const lib = [c.super, ...c.ifaces].filter((s) => s && !app(s) && !/^java\.lang\.(Object|Record|Enum|RuntimeException|Exception|Throwable|IllegalStateException|IllegalArgumentException)$/.test(s));
      if (lib.length) for (const x of c.methods) if (!/ACC_STATIC|ACC_ABSTRACT/.test(x.flags) && x.name !== '<init>') add(m.id, x.id, 'callback');
    }
  }
  function inactive(c) {
    const a = ann(c.ann, 'ConditionalOnProperty');
    if (!a) return false;
    const p = props[c.module] ?? {};
    const prefix = strings(a.values.prefix)[0];
    const names = [...strings(a.values.name), ...strings(a.values.value)];
    const want = strings(a.values.havingValue)[0];
    const missing = a.values.matchIfMissing === 'true';
    return !names.every((n) => { const key = prefix ? `${prefix}.${n}` : n; const v = p[key]; if (v == null) return missing; return want == null ? v !== 'false' : v === want; });
  }

  /* ---------- Jackson ---------- */
  const getters = (cn) => {
    const c = byName.get(cn); if (!c) return [];
    const ignored = new Set(c.fields.filter((f) => hasAnn(f.ann, 'JsonIgnore')).map((f) => f.name));
    return c.methods.filter((m) => !/ACC_STATIC|ACC_SYNTHETIC|ACC_BRIDGE/.test(m.flags) && /ACC_PUBLIC/.test(m.flags) && m.desc.startsWith('()') && !m.desc.endsWith(')V') && !hasAnn(m.ann, 'JsonIgnore')
      && ((/^(get|is)[A-Z]/.test(m.name) && !ignored.has(m.name.replace(/^(get|is)(.)/, (_, __, x) => x.toLowerCase()))) || (c.record.includes(m.name) && !ignored.has(m.name)) || hasAnn(m.ann, 'JsonValue') || hasAnn(m.ann, 'JsonProperty')));
  };
  const setters = (cn) => {
    const c = byName.get(cn); if (!c) return [];
    return c.methods.filter((m) => !/ACC_STATIC|ACC_SYNTHETIC/.test(m.flags) && ((/^set[A-Z]/.test(m.name) && paramTypes(m.desc).length === 1 && /ACC_PUBLIC/.test(m.flags)) || (m.name === '<init>' && (c.record.length ? paramTypes(m.desc).length === c.record.length : paramTypes(m.desc).length === 0 || hasAnn(m.ann, 'JsonCreator'))) || hasAnn(m.ann, 'JsonCreator') || hasAnn(m.ann, 'JsonSetter')));
  };
  const typesIn = (m, which) => {
    const out = new Set();
    if (which === 'ret') { if (m.sig) { try { typeNames(parseMethodSig(m.sig).ret).forEach((x) => out.add(x)); } catch { /* */ } } const r = retOf(m.desc); if (r) out.add(r); }
    else { if (m.sig) { try { const ps = parseMethodSig(m.sig).params; typeNames(ps[which]).forEach((x) => out.add(x)); } catch { /* */ } } const p = paramTypes(m.desc)[which]; if (p) out.add(p); }
    return [...out].filter((x) => app(x));
  };
  // a property's name, from its getter or setter
  const propOf = (m) => (/^(get|is|set)[A-Z]/.test(m.name) ? m.name.replace(/^(get|is|set)(.)/, (_, __, x) => x.toLowerCase()) : m.name);
  // @JsonIgnoreProperties on a property (its field or getter) hides those properties of the value it holds;
  // on a class, it hides that class's own properties
  const ignoredOf = (c, p, dir) => {
    const anns = [...(c.fields.find((f) => f.name === p)?.ann ?? []), ...c.methods.filter((m) => propOf(m) === p).flatMap((m) => m.ann)];
    const a = anns.find((x) => x.type.endsWith('.JsonIgnoreProperties'));
    if (!a || (dir === 'in' && a.values.allowSetters === 'true')) return [];
    return strings(a.values.value);
  };
  function jsonEdges(from, roots, dir, ignore = [], seen = new Set()) {
    for (const r of roots) for (const t of subtypes(r)) {
      const c = byName.get(t); if (!c || c.kind === 'interface') continue;
      const own = ann(c.ann, 'JsonIgnoreProperties');
      const hide = new Set([...ignore, ...(own && !(dir === 'in' && own.values.allowSetters === 'true') ? strings(own.values.value) : [])]);
      const key = `${t}|${[...hide].sort().join(',')}`;
      if (seen.has(key)) continue; seen.add(key);
      if (c.kind === 'enum') { for (const x of c.methods) if (hasAnn(x.ann, 'JsonValue') || hasAnn(x.ann, 'JsonCreator') || (dir === 'out' && x.name === 'toString' && x.desc === '()Ljava/lang/String;')) add(from, x.id, `json-${dir}`); continue; }
      const ms = (dir === 'out' ? getters(t) : setters(t)).filter((x) => x.name === '<init>' || !hide.has(propOf(x)));
      for (const x of ms) add(from, x.id, `json-${dir}`);
      for (const x of ms) {
        const next = dir === 'out' ? typesIn(x, 'ret') : paramTypes(x.desc).map((_, i) => typesIn(x, i)).flat();
        jsonEdges(from, next, dir, x.name === '<init>' ? [] : ignoredOf(c, propOf(x), dir), seen);
      }
      // reading a body: a private field with a getter is set directly (no code runs), but what it holds is built
      if (dir === 'in') for (const f of c.fields) if (!hide.has(f.name) && getters(t).some((g) => propOf(g) === f.name)) {
        const next = new Set(descTypes(f.desc).filter(app));
        if (f.sig) { try { typeNames(parseFieldSig(f.sig)).filter(app).forEach((n) => next.add(n)); } catch { /* */ } }
        jsonEdges(from, next, dir, ignoredOf(c, f.name, dir), seen);
      }
    }
  }
  /* ---------- validation ---------- */
  const constraintValidators = new Map(); // annotation type → validator classes
  for (const c of classes) if (c.kind === 'annotation') { const a = ann(c.ann, 'Constraint'); if (a) constraintValidators.set(c.name, annClasses(a.values.validatedBy)); }
  function validateEdges(from, roots, seen = new Set()) {
    for (const r of roots) {
      if (seen.has(r)) continue; seen.add(r);
      const c = byName.get(r); if (!c) continue;
      const anns = [...c.ann, ...c.fields.flatMap((f) => [...f.ann, ...f.tann]), ...c.methods.flatMap((m) => [...m.ann, ...m.tann])];
      for (const a of anns) for (const v of constraintValidators.get(a.type) ?? []) for (const x of byName.get(v)?.methods ?? []) if (x.name === 'isValid' || x.name === 'initialize') add(from, x.id, 'validate');
      const nested = new Set();
      for (const f of c.fields) if ([...f.ann, ...f.tann].some((a) => a.type === 'jakarta.validation.Valid')) { if (f.sig) typeNames(parseFieldSig(f.sig)).filter(app).forEach((n) => nested.add(n)); descTypes(f.desc).filter(app).forEach((n) => nested.add(n)); }
      validateEdges(from, nested, seen);
    }
  }

  /* ---------- endpoints ---------- */
  const endpoints = [];
  for (const c of classes) {
    if (!c.ann.some((a) => /\.(RestController|Controller)$/.test(a.type))) continue;
    const cm = ann(c.ann, 'RequestMapping');
    const prefixes = cm ? [...strings(cm.values.value), ...strings(cm.values.path)] : [''];
    for (const m of c.methods) for (const [an, verb0] of Object.entries(WEB_ANN)) {
      const a = ann(m.ann, an); if (!a) continue;
      const verbs = verb0 ? [verb0] : enums(a.values.method).length ? enums(a.values.method) : ['GET'];
      const paths = [...strings(a.values.value), ...strings(a.values.path)];
      for (const p of prefixes.length ? prefixes : ['']) for (const q of paths.length ? paths : ['']) for (const v of verbs) {
        const path = (`/${p}/${q}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        const id = `ep:${c.module} ${v} ${path}`;
        endpoints.push({ id, module: c.module, verb: v, path, handler: m.id });
        add(id, m.id, 'route');
        jsonEdges(id, typesIn(m, 'ret'), 'out');
        paramTypes(m.desc).forEach((_, i) => {
          const pa = m.pann[i] ?? [];
          const valid = pa.some((x) => /\.(Valid|Validated)$/.test(x.type)) || m.tann.some((x) => /\.(Valid|Validated)$/.test(x.type) && new RegExp(`param_index=${i}\\b`).test(x.target));
          if (pa.some((x) => /\.RequestBody$/.test(x.type))) { jsonEdges(id, typesIn(m, i), 'in'); if (valid) validateEdges(id, typesIn(m, i)); }
          else if (valid) validateEdges(id, typesIn(m, i));
        });
      }
    }
  }
  const epByKey = new Map(endpoints.map((e) => [`${e.module} ${e.verb} ${e.path.replace(/\{[^}]+\}/g, '{}')}`, e]));

  /* ---------- Feign ---------- */
  const appModule = new Map(cfg.modules.map((m) => [m.appName, m.name]));
  for (const c of classes) {
    const f = ann(c.ann, 'FeignClient'); if (!f) continue;
    const target = appModule.get(strings(f.values.name)[0] ?? strings(f.values.value)[0]);
    for (const m of c.methods) for (const [an, verb] of Object.entries(WEB_ANN)) {
      const a = ann(m.ann, an); if (!a) continue;
      const path = ([...strings(a.values.value), ...strings(a.values.path)][0] ?? '').replace(/\{[^}]+\}/g, '{}');
      const e = epByKey.get(`${target} ${verb ?? 'GET'} ${path}`);
      for (const caller of methods.values()) if (caller.calls.some((k) => k.owner === c.name && k.name === m.name)) add(caller.id, e ? e.id : `unresolved-http:${target} ${path}`, 'http');
    }
  }

  /* ---------- exception handlers ---------- */
  const throwsIn = (m) => {
    const out = new Set(m.news.filter((n) => !n.startsWith('ref:')));
    for (const k of m.calls) {
      if (k.owner === 'java.util.Optional' && (k.name === 'get' || (k.name === 'orElseThrow' && k.desc === '()Ljava/lang/Object;'))) out.add('java.util.NoSuchElementException');
      if (/^java\.lang\.(Long|Integer)$/.test(k.owner) && /^(parse|valueOf)/.test(k.name) && k.desc.startsWith('(Ljava/lang/String;')) out.add('java.lang.NumberFormatException');
      if (repoEntity.has(k.owner) && /^(save|delete|flush)/.test(k.name)) out.add('org.springframework.dao.DataIntegrityViolationException');
      if (repoEntity.has(k.owner) && /^(getReferenceById|getById|getOne)$/.test(k.name)) out.add('jakarta.persistence.EntityNotFoundException');
    }
    return out;
  };
  const handlers = [];
  for (const c of classes) {
    if (!c.ann.some((a) => /\.(RestControllerAdvice|ControllerAdvice)$/.test(a.type))) continue;
    for (const m of c.methods) { const a = ann(m.ann, 'ExceptionHandler'); if (!a) continue; const types = annClasses(a.values.value); handlers.push({ module: c.module, m, types: types.length ? types : paramTypes(m.desc).filter((p) => /Exception|Error|Throwable/.test(p)) }); }
  }

  /* ---------- events, Kafka, JPA callbacks, framework beans ---------- */
  const listeners = [];
  const jobs = [];
  for (const m of methods.values()) {
    const ev = ann(m.ann, 'EventListener') ?? ann(m.ann, 'TransactionalEventListener');
    if (ev) { const types = annClasses(ev.values.classes ?? ev.values.value); listeners.push({ m, types: types.length ? types : paramTypes(m.desc).slice(0, 1) }); jobs.push({ id: `job:${short(m.cls.name)}.${m.name}`, m }); }
    if (hasAnn(m.ann, 'Scheduled')) jobs.push({ id: `job:${short(m.cls.name)}.${m.name}`, m });
    const kl = ann(m.ann, 'KafkaListener');
    if (kl) { m.topics = strings(kl.values.topics).map((t) => resolve(t, props[m.cls.module] ?? {})); jobs.push({ id: `job:${short(m.cls.name)}.${m.name}`, m, kafka: true }); }
  }
  for (const j of jobs) {
    add(j.id, j.m.id, 'route');
    if (j.kafka) jsonEdges(j.id, typesIn(j.m, 0), 'in');
  }
  const kafkaValueTypes = (m) => {
    const out = new Set();
    for (const f of m.fieldsRead) { const fc = byName.get(f.owner)?.fields.find((x) => x.name === f.name); if (fc?.sig && /KafkaTemplate/.test(fc.sig)) { const t = parseFieldSig(fc.sig); const v = t.args[1]; if (v && app(v.name)) out.add(v.name); } }
    if (!out.size) for (const n of m.news) { const x = n.replace(/^ref:/, ''); if (app(x)) out.add(x); }
    return out;
  };
  const kafkaListeners = jobs.filter((j) => j.kafka);
  for (const m of methods.values()) {
    for (const k of m.calls) {
      if (/^org\.springframework\.context\.(ApplicationEventPublisher|ApplicationContext|ConfigurableApplicationContext)$/.test(k.owner) && k.name === 'publishEvent') {
        const made = m.news.filter((n) => !n.startsWith('ref:') && app(n));
        for (const l of listeners) if (made.some((n) => l.types.some((t) => isA(n, t)))) add(m.id, l.m.id, asyncM(l.m) ? 'async' : 'event', k);
      }
      if (k.owner === 'org.springframework.kafka.core.KafkaTemplate' && k.name === 'send') {
        jsonEdges(m.id, kafkaValueTypes(m), 'out');
        const topics = m.ldc.map((t) => resolve(t, props[m.cls.module] ?? {}));
        for (const l of kafkaListeners) if (l.m.topics.some((t) => topics.includes(t))) add(m.id, l.id, 'kafka', k);
      }
      if (repoEntity.has(k.owner)) {
        const e = repoEntity.get(k.owner);
        const write = /^(save|delete|flush)/.test(k.name);
        for (const x of byName.get(e)?.methods ?? []) {
          if (write && (hasAnn(x.ann, 'PrePersist') || hasAnn(x.ann, 'PreUpdate') || hasAnn(x.ann, 'PostPersist') || hasAnn(x.ann, 'PostUpdate') || hasAnn(x.ann, 'PreRemove'))) add(m.id, x.id, 'jpa', k);
          if (hasAnn(x.ann, 'PostLoad')) add(m.id, x.id, 'jpa', k);
        }
      }
    }
  }
  const startup = [];
  for (const m of methods.values()) {
    if (hasAnn(m.ann, 'Bean')) {
      const r = retOf(m.desc);
      startup.push({ m, type: r });
      if (r && FRAMEWORK_BEANS.test(r)) for (const e of endpoints.filter((e) => e.module === m.cls.module)) add(e.id, m.id, 'framework');
      else if (r) for (const u of methods.values()) if (u.cls.module === m.cls.module && u.calls.some((k) => k.owner === r && k.op !== 'invokestatic')) add(u.id, m.id, 'call');
    }
    if (hasAnn(m.ann, 'PostConstruct') || (m.name === 'run' && m.cls.ifaces.some((i) => /(CommandLine|Application)Runner$/.test(i)))) startup.push({ m, type: null });
  }
  for (const c of classes) if (c.ifaces.some((i) => /(WebMvcConfigurer|HandlerInterceptor|jakarta\.servlet\.Filter)$/.test(i)) || /OncePerRequestFilter$/.test(c.super ?? '')) for (const e of endpoints.filter((e) => e.module === c.module)) for (const x of c.methods) if (x.name !== '<init>' && !/ACC_STATIC/.test(x.flags)) add(e.id, x.id, 'framework');

  /* ---------- closure, and exception handlers by what a flow can throw ---------- */
  const closure = (root, kinds) => { const seen = new Set([root]); const q = [root]; while (q.length) { const x = q.shift(); for (const e of edges.get(x) ?? []) if ((!kinds || kinds.has(e.kind)) && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); } } return seen; };
  for (const e of endpoints) {
    const hs = handlers.filter((h) => h.module === e.module);
    if (!hs.length) continue;
    const thrown = new Set();
    const handlerM = methods.get(e.handler);
    for (const n of closure(e.id, HARD)) { const m = methods.get(n); if (m) throwsIn(m).forEach((t) => thrown.add(t)); }
    if (handlerM.pann.some((p) => (p ?? []).some((a) => /\.RequestBody$/.test(a.type)))) thrown.add('org.springframework.http.converter.HttpMessageNotReadableException');
    if (handlerM.pann.some((p) => (p ?? []).some((a) => /\.(Valid|Validated)$/.test(a.type))) || handlerM.tann.some((a) => /\.(Valid|Validated)$/.test(a.type))) thrown.add('org.springframework.web.bind.MethodArgumentNotValidException');
    for (const h of hs) if (h.types.some((t) => /^java\.lang\.(Exception|RuntimeException|Throwable)$/.test(t) || [...thrown].some((x) => isA(x, t)))) add(e.id, h.m.id, 'error');
  }

  /* ---------- areas ---------- */
  const areas = new Map(); // area id → root node ids
  for (const [screen, calls] of Object.entries(cfg.screens)) {
    const roots = [];
    for (const k of calls) {
      const e = epByKey.get(`${k.module} ${k.verb} ${k.path.replace(/\{[^}]+\}/g, '{}')}`);
      if (!e) throw new Error(`front-edge map: no endpoint ${k.module} ${k.verb} ${k.path} for ${screen}`);
      roots.push(e.id);
    }
    areas.set(`screen:${screen}`, roots);
  }
  for (const j of jobs) areas.set(j.id, [j.id]);
  for (const e of endpoints) if (![...areas.values()].some((r) => r.includes(e.id))) areas.set(`api:${e.verb} ${e.path}`, [e.id]);

  // reverse edges, for reach from a method back to the areas
  const rev = new Map();
  for (const [f, es] of edges) for (const e of es) { if (!rev.has(e.to)) rev.set(e.to, []); rev.get(e.to).push({ from: f, kind: e.kind }); }
  function reach(target) {
    // hard: only run-time kinds; all: any kind. Paths are kept for the report.
    const walk = (kinds) => { const prev = new Map([[target, null]]); const q = [target]; while (q.length) { const x = q.shift(); for (const e of rev.get(x) ?? []) if ((!kinds || kinds.has(e.kind)) && !prev.has(e.from)) { prev.set(e.from, { to: x, kind: e.kind }); q.push(e.from); } } return prev; };
    const hard = walk(HARD), all = walk(null);
    const path = (prev, n) => { const out = [n]; let x = n; while (prev.get(x)) { const p = prev.get(x); out.push(`-${p.kind}→`, p.to); x = p.to; } return out.map((s) => s.replace(/\(.*$/, '').replace(/^.*\.([\w$]+\.[\w$<>]+)$/, '$1')).join(' '); };
    const out = { hard: new Map(), content: new Map() };
    for (const [a, roots] of areas) {
      const h = roots.find((r) => hard.has(r));
      if (h) { out.hard.set(a, path(hard, h)); continue; }
      const c = roots.find((r) => all.has(r));
      if (c) out.content.set(a, path(all, c));
    }
    return out;
  }
  return { classes, byName, methods, edges, endpoints, areas, jobs, handlers, startup, listeners, reach, repoEntity, props };
}
