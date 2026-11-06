/**
 * Changes that stop a service from starting. The compiler accepts them and no single method's behaviour
 * changes, but Spring refuses the application context, Flyway refuses the database, or a derived query
 * cannot be built. When a service does not start, every API and every job of it is down: each is to test.
 *
 * Read from the Java and migration facts of both commits, with no guess:
 *  - a bean outside the component scan: a @Component, @Service, … whose package is not under the
 *    @SpringBootApplication (or @ComponentScan) packages of its module
 *  - a bean's stereotype annotation removed while another bean's constructor asks for it
 *  - a constructor parameter added whose type no bean provides: not an app bean, a @Bean method's type,
 *    a repository, a @ConfigurationProperties type, or a type Spring Boot provides on its own
 *  - a Spring Data derived query (findByXAndY…) whose property path does not exist on the entity
 *  - a Flyway migration edited after it was applied (its checksum), or numbered below the latest one
 *
 * A risk is `certain` when the facts settle it (an app type with no bean, a property that does not exist),
 * and not certain when it depends on what Teslon cannot read (a library type it does not know).
 */
import type { Snapshot, ChangedFile } from './snapshot.js';
import type { SpringFacts } from './spring.js';
import type { JType, JMethod, JavaFile } from './java.js';
import { annPairs, annStrings } from './java.js';
import type { Hop } from './model.js';

export interface StartupRisk {
  readonly module: string;
  readonly certain: boolean;
  /** One sentence: what Spring or Flyway will refuse, and why. */
  readonly reason: string;
  readonly hop: Hop;
}

const STEREOTYPES = new Set(['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'ControllerAdvice', 'RestControllerAdvice']);
const simple = (n: string): string => n.split('.').pop()!;
const bare = (t: string): string => simple(t.replace(/<.*$/s, '').replace(/\[\]$/, '').replace(/^final\s+/, '').trim());
// types Spring Boot makes on its own, or that need no bean of the app's
const PROVIDED = new Set([
  'ApplicationEventPublisher', 'ApplicationContext', 'ConfigurableApplicationContext', 'Environment', 'ConfigurableEnvironment', 'ResourceLoader', 'BeanFactory', 'ListableBeanFactory',
  'ObjectMapper', 'JsonMapper', 'Jackson2ObjectMapperBuilder', 'JdbcTemplate', 'NamedParameterJdbcTemplate', 'JdbcClient', 'DataSource', 'EntityManager', 'EntityManagerFactory',
  'PlatformTransactionManager', 'TransactionTemplate', 'RestTemplateBuilder', 'RestClient.Builder', 'Builder', 'WebClient.Builder', 'KafkaTemplate', 'JavaMailSender', 'MeterRegistry',
  'ConversionService', 'Validator', 'LocalValidatorFactoryBean', 'MessageSource', 'TaskExecutor', 'ThreadPoolTaskExecutor', 'AsyncTaskExecutor', 'TaskScheduler', 'ThreadPoolTaskScheduler',
  'CacheManager', 'RedisTemplate', 'StringRedisTemplate', 'RabbitTemplate', 'JmsTemplate', 'MongoTemplate', 'ChatClient.Builder', 'ChatModel', 'EmbeddingModel', 'VectorStore',
  'HttpServletRequest', 'HttpServletResponse', 'ServletContext', 'String', 'int', 'long', 'boolean', 'double', 'Integer', 'Long', 'Boolean', 'Double', 'Duration',
  'ObservationRegistry', 'Tracer', 'BuildProperties', 'GitProperties', 'ServerProperties', 'DiscoveryClient', 'LoadBalancerClient', 'CircuitBreakerFactory', 'ReactiveCircuitBreakerFactory',
]);
const JAVA_LANG = new Set(['Object', 'Runnable', 'Thread', 'StringBuilder', 'Number', 'Character', 'Byte', 'Short', 'Float']);
// wrappers that never fail on a missing bean
const LENIENT = /^(Optional|ObjectProvider|ObjectFactory|Provider|List|Set|Collection|Map|Iterable|Stream)\b/;

export function startupRisks(B: Snapshot, H: Snapshot, fb: SpringFacts, fh: SpringFacts, changes: readonly ChangedFile[]): StartupRisk[] {
  const out: StartupRisk[] = [];
  const say = (module: string, certain: boolean, reason: string, file: string, line: number, quote: string, side?: 'base'): void => {
    if (out.some((r) => r.module === module && r.reason === reason)) return;
    out.push({ module, certain, reason, hop: { label: 'Will not start', file, line, quote, rule: reason, ...(side ? { side } : {}) } });
  };
  const changed = new Set(changes.filter((c) => c.status !== 'deleted').map((c) => c.path));
  const filesOf = (f: SpringFacts, module: string): [string, JavaFile][] => [...f.javaFiles].filter(([p]) => f.moduleOf(p) === module);
  const isBean = (t: JType): boolean => t.annotations.some((a) => STEREOTYPES.has(a.name));

  /* ---------- what each module can inject ---------- */
  const modules = new Set([...fh.javaFiles.keys()].map((p) => fh.moduleOf(p)));
  const injectable = (module: string): { beans: Set<string>; appTypes: Set<string>; roots: string[] } => {
    const beans = new Set<string>(), appTypes = new Set<string>(), roots: string[] = [];
    let propsScan = false;
    for (const [, jf] of fh.javaFiles) for (const t of jf.types) appTypes.add(simple(t.name));
    for (const [, jf] of filesOf(fh, module)) for (const t of jf.types) {
      const boot = t.annotations.find((a) => a.name === 'SpringBootApplication');
      if (boot) { roots.push(jf.pkg); const sb = annPairs(boot).get('scanBasePackages'); if (sb) for (const m of sb.matchAll(/"([^"]+)"/g)) roots.push(m[1]!); }
      const cs = t.annotations.find((a) => a.name === 'ComponentScan');
      if (cs) { const p = annPairs(cs); const v = p.get('basePackages') ?? p.get('value') ?? (p.size ? '' : annStrings(cs).map((s) => `"${s}"`).join(',')); for (const m of (v ?? '').matchAll(/"([^"]+)"/g)) roots.push(m[1]!); }
      if (t.annotations.some((a) => a.name === 'ConfigurationPropertiesScan' || a.name === 'EnableConfigurationProperties')) propsScan = true;
    }
    for (const [, jf] of filesOf(fh, module)) for (const t of jf.types) {
      const inScan = !roots.length || roots.some((r) => jf.pkg === r || jf.pkg.startsWith(`${r}.`));
      const name = simple(t.name);
      const repo = t.kind === 'interface' && t.supertypes.some((s) => /Repository\b/.test(bare(s)));
      const mapper = t.annotations.some((a) => a.name === 'Mapper');
      const feign = t.annotations.some((a) => a.name === 'FeignClient');
      const props = t.annotations.some((a) => a.name === 'ConfigurationProperties') && propsScan;
      if ((isBean(t) && inScan) || repo || mapper || feign || props) { beans.add(name); for (const s of t.supertypes) beans.add(bare(s)); }
      for (const m of t.methods) if (m.annotations.some((a) => a.name === 'Bean')) beans.add(bare(m.returnType));
    }
    return { beans, appTypes, roots };
  };
  const cache = new Map<string, ReturnType<typeof injectable>>();
  const inj = (m: string): ReturnType<typeof injectable> => { if (!cache.has(m)) cache.set(m, injectable(m)); return cache.get(m)!; };
  // who asks for a type through a constructor, at head
  const askers = (module: string, type: string): { cls: string; file: string; line: number }[] => {
    const r: { cls: string; file: string; line: number }[] = [];
    for (const [p, jf] of filesOf(fh, module)) for (const t of jf.types) if (isBean(t)) for (const c of ctorsOf(t)) for (const v of c.params) if (bare(v.type) === type) r.push({ cls: simple(t.name), file: p, line: v.line });
    return r;
  };

  for (const module of modules) {
    const { beans, appTypes, roots } = inj(module);
    for (const [p, jf] of filesOf(fh, module)) {
      if (!changed.has(p)) continue;
      for (const t of jf.types) {
        const name = simple(t.name);
        // 1. a bean outside the component scan
        if (isBean(t) && roots.length && !roots.some((r) => jf.pkg === r || jf.pkg.startsWith(`${r}.`))) {
          const need = askers(module, name);
          say(module, need.length > 0, `${name} is in package ${jf.pkg}, outside the component scan (${roots.join(', ')}): Spring does not create it${need.length ? `, and ${need[0]!.cls} needs it in its constructor` : ''}`, p, t.line, name);
        }
        // 2. a stereotype removed
        const was = fb.javaFiles.get(p)?.types.find((x) => x.name === t.name);
        if (was && isBean(was) && !isBean(t)) {
          const need = askers(module, name);
          if (need.length) { const a = was.annotations.find((x) => STEREOTYPES.has(x.name))!; say(module, true, `${name} is no longer a bean (@${a.name} removed), and ${need[0]!.cls} needs it in its constructor`, p, a.line, a.name, 'base'); }
        }
        // 3. a constructor parameter no bean provides
        if (isBean(t)) {
          const now = injectionCtor(t), then = was ? injectionCtor(was) : null;
          for (const v of now?.params ?? []) {
            if (then?.params.some((x) => x.type === v.type)) continue;
            if (v.annotations.some((a) => a.name === 'Value' || a.name === 'Qualifier' || a.name === 'Autowired')) continue;
            const ty = bare(v.type);
            if (LENIENT.test(v.type.trim()) || beans.has(ty) || PROVIDED.has(ty) || PROVIDED.has(v.type.trim())) continue;
            const app = appTypes.has(ty);
            // a JDK type is never a bean unless the app makes one (Spring Boot makes a DataSource and an Executor)
            const qn = v.type.includes('.') ? v.type.replace(/<.*$/s, '').trim() : (jf.imports.find((i) => i.endsWith(`.${ty}`)) ?? (/^[A-Z]/.test(ty) && JAVA_LANG.has(ty) ? `java.lang.${ty}` : ''));
            const jdk = /^javax?\./.test(qn) && !/^(javax\.sql\.DataSource|java\.util\.concurrent\.(Executor|ScheduledExecutorService))$/.test(qn);
            say(module, app || jdk, `${name} now asks for a ${ty} in its constructor, and ${app || jdk ? 'no bean of this app is' : 'Teslon cannot see that a bean is'} a ${ty}${jdk ? ` (${qn} is a JDK type, which Spring Boot does not provide)` : ''}`, p, v.line, ty);
          }
        }
        // 4. a derived query whose property path does not exist
        if (t.kind === 'interface' && t.supertypes.some((s) => /Repository\b/.test(bare(s)))) {
          const sup = t.supertypes.find((s) => /<\s*([\w.]+)/.test(s) && /Repository\b/.test(bare(s)));
          const entity = sup ? simple(/<\s*([\w.]+)/.exec(sup)![1]!) : null;
          const et = entity ? findType(fh, entity, module) : null;
          if (!et) continue;
          const before = new Set((was?.methods ?? []).map((m) => `${m.name}/${m.params.length}`));
          for (const m of t.methods) {
            if (before.has(`${m.name}/${m.params.length}`) || m.annotations.some((a) => /^(Query|Procedure|NativeQuery)$/.test(a.name)) || m.body.length) continue;
            const bad = derivedQueryProblem(m.name, et, fh, module);
            if (bad) say(module, true, `${name}.${m.name}() is a derived query, and ${bad}: Spring Data cannot build the repository`, p, m.line, m.name);
          }
        }
      }
    }
  }

  /* ---------- Flyway: migrations are checked against what the database already ran ---------- */
  const fly = /(^|\/)db\/migration\/V(\d+(?:[._]\d+)*)__[^/]*\.sql$/;
  const ver = (p: string): number[] => fly.exec(p)![2]!.split(/[._]/).map(Number);
  const less = (a: number[], b: number[]): boolean => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x < y; } return false; };
  for (const cf of changes) {
    if (!fly.test(cf.path)) continue;
    const module = fh.moduleOf(cf.path);
    const dir = cf.path.slice(0, cf.path.lastIndexOf('/'));
    const applied = B.files.filter((f) => f.startsWith(`${dir}/`) && fly.test(f));
    const quote = (n: number): string => (H.line(cf.path, n) ?? '').trim().slice(0, 24).trim();
    if (cf.status === 'modified' && applied.includes(cf.path)) {
      const n = cf.headLines.find((x) => quote(x)) ?? 1;
      say(module, true, `${cf.path.split('/').pop()} was already applied: Flyway checks its checksum on start, finds it changed, and refuses`, cf.path, n, quote(n));
    } else if (cf.status === 'added' && applied.some((f) => less(ver(cf.path), ver(f)))) {
      const top = applied.sort((a, b) => (less(ver(a), ver(b)) ? 1 : -1))[0]!;
      const n = cf.headLines.find((x) => quote(x)) ?? 1;
      say(module, true, `${cf.path.split('/').pop()} is numbered below ${top.split('/').pop()}, which databases already ran: Flyway's validation refuses it on start`, cf.path, n, quote(n));
    }
  }
  return out;
}

function ctorsOf(t: JType): JMethod[] { return t.methods.filter((m) => m.name === simple(t.name)); }
function injectionCtor(t: JType): JMethod | null {
  const cs = ctorsOf(t);
  if (cs.length === 1) return cs[0]!;
  return cs.find((c) => c.annotations.some((a) => a.name === 'Autowired')) ?? null;
}
function findType(f: SpringFacts, name: string, module: string): JType | null {
  let any: JType | null = null;
  for (const [p, jf] of f.javaFiles) for (const t of jf.types) if (simple(t.name) === name) { if (f.moduleOf(p) === module) return t; any ??= t; }
  return any;
}

/* ---------- Spring Data derived queries: find…By<path><Op>And… OrderBy<path>Asc ---------- */
const OPS = ['IsNotNull', 'NotNull', 'IsNull', 'Null', 'IsNotEmpty', 'NotEmpty', 'IsEmpty', 'Empty', 'IsTrue', 'True', 'IsFalse', 'False', 'GreaterThanEqual', 'IsGreaterThanEqual', 'GreaterThan', 'IsGreaterThan', 'LessThanEqual', 'IsLessThanEqual', 'LessThan', 'IsLessThan', 'IsBetween', 'Between', 'IsAfter', 'After', 'IsBefore', 'Before', 'IsNotLike', 'NotLike', 'IsLike', 'Like', 'IsStartingWith', 'StartingWith', 'StartsWith', 'IsEndingWith', 'EndingWith', 'EndsWith', 'IsNotContaining', 'NotContaining', 'IsContaining', 'Containing', 'Contains', 'IsNotIn', 'NotIn', 'IsIn', 'In', 'IgnoreCase', 'IgnoringCase', 'AllIgnoreCase', 'AllIgnoringCase', 'Exists', 'Regex', 'MatchesRegex', 'Matches', 'Near', 'IsNear', 'Within', 'IsWithin', 'IsNot', 'Not', 'Is', 'Equals'];
export function derivedQueryProblem(name: string, entity: JType, f: SpringFacts, module: string): string | null {
  const m = /^(find|read|get|query|search|stream|count|exists|delete|remove)(.*?)By(.*)$/.exec(name);
  if (!m) return null;
  let rest = m[3]!;
  const parts: string[] = [];
  const ob = /OrderBy(.+)$/.exec(rest);
  if (ob) { rest = rest.slice(0, ob.index); for (const x of ob[1]!.split(/(?<=[a-z0-9])(?:Asc|Desc)(?=[A-Z]|$)/)) if (x) parts.push(x.replace(/(Asc|Desc)$/, '')); }
  if (rest) for (const x of rest.split(/(?<=[a-z0-9])(?:And|Or)(?=[A-Z])/)) {
    let p = x;
    for (let again = true; again;) { again = false; for (const op of OPS) if (p.length > op.length && p.endsWith(op)) { p = p.slice(0, -op.length); again = true; break; } }
    parts.push(p);
  }
  for (const p of parts) if (!resolves(p, entity, f, module, 0)) return `${entity.name} has no property ${p.charAt(0).toLowerCase()}${p.slice(1)}`;
  return null;
}
function resolves(path: string, t: JType, f: SpringFacts, module: string, depth: number): boolean {
  if (!path || depth > 4) return !path;
  const fields = new Map<string, string>();
  const collect = (x: JType, d: number): void => {
    for (const fl of x.fields) if (!fl.mods?.includes('static')) fields.set(fl.name, fl.type);
    if (x.kind === 'record') for (const m of x.methods) if (!m.params.length) fields.set(m.name, m.returnType);
    if (d < 3) for (const s of x.supertypes) { const st = findType(f, bare(s), module); if (st) collect(st, d + 1); }
  };
  collect(t, 0);
  // the record's components: a record's fields are its constructor's parameters in the reader
  if (t.kind === 'record') for (const c of t.methods.filter((m) => m.name === simple(t.name))) for (const v of c.params) fields.set(v.name, v.type);
  const segs = path.replace(/_/g, '').split(/(?=[A-Z])/);
  for (let i = segs.length; i >= 1; i--) {
    const head = segs.slice(0, i).join('');
    const prop = head.charAt(0).toLowerCase() + head.slice(1);
    if (!fields.has(prop)) continue;
    if (i === segs.length) return true;
    const ty = fields.get(prop)!;
    const inner = /<\s*([\w.]+)\s*>$/.exec(ty.trim())?.[1] ?? ty;
    const nt = findType(f, bare(inner), module);
    if (nt && resolves(segs.slice(i).join(''), nt, f, module, depth + 1)) return true;
  }
  // a type Teslon cannot see (a library type, an embeddable it did not read) is not held against the query
  return !t.fields.length && t.kind !== 'record';
}

/** Spring profiles a deployment file turns on: SPRING_PROFILES_ACTIVE (env, k8s, compose, Dockerfile) or --spring.profiles.active. */
export function activeProfiles(text: string): Set<string> {
  const out = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    let v = /(?:SPRING_PROFILES_ACTIVE|spring\.profiles\.active)["']?\s*[:=]\s*["']?([\w,\s-]+?)["']?\s*$/.exec(l)?.[1];
    if (v == null && /SPRING_PROFILES_ACTIVE/.test(l)) v = /^\s*value:\s*["']?([\w,-]+)["']?\s*$/.exec(lines[i + 1] ?? '')?.[1];
    for (const p of (v ?? '').split(',')) if (p.trim()) out.add(p.trim());
  });
  return out;
}
