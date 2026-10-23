import type { Snapshot, ChangedFile } from './snapshot.js';
import { exposedAs, templateHits, type SpringFacts, type Endpoint } from './spring.js';
import { targetsRoute, type FrontendFacts, type Route, type Component, type ApiCall } from './vue.js';
import type { JType, JMethod } from './java.js';
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
}

const fileName = (p: string): string => p.split('/').pop() ?? p;
const simple = (n: string): string => n.split('.').pop()!;
const snippet = (t: string | null): string => (t ?? '').trim().slice(0, 24).trim();
const trivial = (t: string): boolean => t === '' || t === '}' || t === '{' || t === ');' || /^(\/\/|\*|\/\*|\*\/)/.test(t) || /^(import|package)\s/.test(t);

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
        walk(e.from, [...hops, { label: 'Called by', file: e.file, line: e.line, quote: method, rule: `${e.from}() calls ${name}()` }], depth + 1);
      }
    }
  };
  walk(start, [], 0);
  return out;
}

/** Browser calls that land on an endpoint, through the gateway when there is one. */
function browserCalls(f: SpringFacts, ui: FrontendFacts, e: Endpoint): ApiCall[] {
  return ui.calls.filter((c) => {
    if (!c.verbs.includes(e.verb)) return false;
    const route = f.gateway.find((r) => c.tpl === r.prefix || c.tpl.startsWith(r.prefix + '/') || c.tpl.startsWith(r.prefix + '{'));
    if (f.gateway.length && (route ? route.service : f.gatewayService) !== e.service) return false;
    const internal = route ? '/' + c.tpl.split('/').filter(Boolean).slice(route.strip).join('/') : c.tpl;
    return templateHits(internal, e.path);
  });
}

/** The import chain from a screen's component to a file it runs, as hops. */
function importChain(ui: FrontendFacts, from: string, to: string): Hop[] | null {
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
          const line = ui.components.get(p)?.depLines[cur] ?? 1;
          hops.unshift({ label: 'Uses', file: p, line, quote: '', rule: `${fileName(p)} uses ${fileName(cur)}` });
          cur = p;
        }
        return hops;
      }
      queue.push(d);
    }
  }
  return null;
}

function screenTitle(comp: Component | undefined, route: string): string {
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
      const callHop: Hop = { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` };
      const global = ui.globals.find((g) => g.file === c.file || ctx.closure(g.file).has(c.file));
      if (global) {
        const sid = `widget:${global.tag}`;
        ctx.surface({ id: sid, kind: 'widget', name: `<${global.tag}>`, where: 'every screen', tier: 'test-next' });
        ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-next', do: `Use <${global.tag}> for what calls ${e.verb} ${ext}.`, expect: `Works as before: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: [...chain, apiHop, ...gwHop, callHop, { label: 'On every screen', file: global.root, line: global.line, quote: `<${global.tag}`, rule: `<${global.tag}> is drawn beside <router-view>` }] });
        n++;
      }
      for (const r of ui.routes.filter((x) => ctx.closure(x.component).has(c.file))) {
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
          hops: [...chain, apiHop, ...gwHop, callHop, ...chainUi, { label: 'Screen', file: r.file, line: r.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${r.path}` }],
        });
        n++;
      }
    }
    if (depth < 2) {
      // another service calls this endpoint: what reaches that call reaches this change
      for (const jc of fh.calls.filter((x) => x.service === e.service && x.verb === e.verb && templateHits(x.tpl, e.path))) {
        const hop: Hop = { label: 'Another service calls it', file: jc.file, line: jc.line, quote: 'uri', rule: `${jc.cls}.${jc.method}() · ${jc.how}` };
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
      const l = fh.listeners.find((x) => x.cls === cls && x.method === method)!;
      const sid = `job:${cls}.${method}`;
      ctx.surface({ id: sid, kind: 'job', name: `${cls}.${method}() ${l.kind}`, where: l.file, tier: 'test-next' });
      ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-next', do: `Let ${cls}.${method}() run (or trigger it) and check what it does.`, expect: `Same effect unless the change means otherwise: ${why}.`, before: 'As released.', after: 'Runs changed code.', proof: 'derived', hops: [...chain, { label: 'Job', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${cls}.${method}() ${l.kind}` }] });
      return 1;
    }
    // an AI tool: the chat that is given it
    let n = 0;
    const tool = fh.tools.find((t) => t.cls === cls && t.method === method)!;
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

  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java') continue;
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
      if (wide) {
        // configuration and beans: every request of the service goes through them
        const note: Hop = { label: 'Applies to the whole service', file: cf.path, line: g.type.line, quote: simple(g.type.name), rule: `${cls} configures ${fh.serviceOf(cf.path) ?? 'the service'}${g.method ? `: ${g.method.name}() is a @Bean` : ''}`, ...(g.gone ? { side: 'base' as const } : {}) };
        for (const e of fh.endpoints.filter((x) => x.module === module)) reached += consumers(e, [changed, note], id, why);
      } else if (bean && (ctor || !g.method)) {
        // a bean's constructor or a class-level change (annotation, field, injected client): every method runs on it
        for (const m of g.type.methods) if (m.name !== cls) starts.push({ at: `${cls}.${m.name}`, lead: [] });
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
        for (const st of late) for (const r of reachFrom(fh, st.at)) reached += entry(r, [changed, ...st.lead, ...r.hops], id, why);
        dataType = true;
      }
      if (reached) {
        for (const n of g.lines) ctx.follow(cf.path, n);
        for (const n of g.baseLines) ctx.follow(cf.path, n, 'base');
        ctx.deltas.push({ id, kind: 'code-changed', title: why, endpoint: '', rules: [], causes: [changed] });
      } else {
        ctx.unseen.push({ what: `${g.gone ? 'removed' : 'changed'} code in ${g.method ? `${cls}.${g.method.name}()` : cls} (${fileName(cf.path)}:${at})`, why: 'it reaches no API, job, AI tool or screen this build can see: it may be called through reflection, events, an unresolved interface, or only from tests', resolve: 'ask the developer where it runs', files: [cf.path] });
      }
    }
  }

  /** Who uses a type: endpoints that take or return it (or a type that holds it), and methods that do. */
  function followType(cls: string, fullName: string, lead: Hop[], id: string, why: string, starts: { at: string; lead: Hop[] }[]): number {
    let reached = 0;
    const declared = [...fh.javaFiles.values()].flatMap((jf) => jf.types).find((t) => t.name === fullName);
    const controller = declared?.annotations.some((a) => /^(RestController|Controller)$/.test(a.name)) ?? false;
    // a type held by another type travels inside it: Operation.bankAccount is a BankAccount
    const holders = new Map<string, Hop[]>([[cls, []]]);
    for (let round = 0; round < 3; round++) {
      for (const [, jf] of fh.javaFiles) for (const t of jf.types) {
        const tn = simple(t.name);
        if (holders.has(tn)) continue;
        for (const fl of t.fields) {
          const held = [...holders.keys()].find((h) => new RegExp(`\\b${h}\\b`).test(fl.type));
          if (held) { holders.set(tn, [...holders.get(held)!, { label: 'Held by', file: jf.path, line: fl.line, quote: fl.name, rule: `${tn}.${fl.name} is ${fl.type}` }]); break; }
        }
      }
    }
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
        const held = usesType(`${m.returnType} ${m.params.map((p) => p.type).join(' ')}`);
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
        for (const rt of ui.routes.filter((x) => ctx.closure(x.component).has(c.file))) {
          const sid = `screen:${rt.path}`;
          const title = screenTitle(ui.components.get(rt.component), rt.path);
          ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
          ctx.addCase({ surface: sid, delta: deltaId, tier: 'test-first', do: `Open ${title} and use what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: `It still calls ${eb.verb} ${ext}, which was removed: it now fails.`, before: 'Worked.', after: 'Calls an API that is gone.', proof: 'derived', hops: [...chain, apiHop, { label: 'Still calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, { label: 'Screen', file: rt.file, line: rt.line, quote: rt.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${rt.path}` }] });
          n++;
        }
      }
    }
    return n;
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
    const real = lines.filter((n) => !trivial((S.line(cf.path, n) ?? '').trim()) && !(atHead && ctx.explained(cf.path, n)));
    if (!real.length) continue;
    ctx.touchedUi.add(cf.path);
    const changedHop: Hop = atHead
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
      if (found.some((f) => /\.html?$/.test(f)) || targets.some((t) => everyScreen(u, S, t))) targets = ['*'];
    }
    // the page shell: index.html loads the app, so it is every screen
    if (kind === 'frontend' && /\.html?$/.test(cf.path) && /<script[^>]+src=|<div[^>]+id=["']app["']|<router-view|ng-app|ng-view/.test(S.read(cf.path) ?? '')) targets = ['*'];
    const id = `ui:${cf.path}`;
    const comp = u.components.get(cf.path);
    const changedEls = comp ? comp.elements.filter((e) => real.includes(e.line)).map((e) => describe(e, comp)) : [];
    const changedCalls = u.calls.filter((c) => c.file === cf.path && real.includes(c.line));
    const what = kind === 'style' ? 'how it looks (styles changed)' : changedEls.length ? [...new Set(changedEls)].slice(0, 6).join(', ') : `what ${fileName(cf.path)} draws or does`;
    const screens = targets.includes('*') || everyScreen(u, S, cf.path) ? null : allScreens(u).filter((r) => targets.some((t) => {
      const seen = new Set<string>();
      const walk = (f: string, d: number): boolean => { if (f === t) return true; if (seen.has(f) || d > 8) return false; seen.add(f); return (u.components.get(f)?.deps ?? []).some((x) => walk(x, d + 1)); };
      return walk(r.component, 0);
    }));
    let reached = 0;
    const defined = u.routes.filter((r) => r.file === cf.path && real.some((n) => Math.abs(n - r.line) <= 1));
    for (const r of defined) {
      const sid = `screen:${r.path}`;
      ctx.surface({ id: sid, kind: 'screen', name: screenTitle(u.components.get(r.component), r.path), where: r.path, tier: 'test-first' });
      ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${r.path} directly and by every link to it.`, expect: 'The route and the screen it shows are as the change intends.', before: 'As released.', after: 'Route changed.', proof: 'derived', hops: [{ label: 'Route changed', file: r.file, line: r.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${r.path} → ${fileName(r.component)}` }] });
      reached++;
    }
    if (atHead) for (const rb of ub.routes.filter((r: Route) => r.file === cf.path && !ui.routes.some((x) => x.path === r.path))) {
      const sid = `screen:${rb.path}`;
      ctx.surface({ id: sid, kind: 'screen', name: `${rb.path} (route removed)`, where: rb.path, tier: 'test-first' });
      const linkers = [...ui.components.values()].flatMap((c) => [...c.links, ...c.pushes].filter((l) => targetsRoute(l.target, rb.path)).map((l) => ({ c, line: l.line })));
      ctx.addCase({ surface: sid, delta: `ui:${cf.path}`, tier: 'test-first', do: `Open ${rb.path} and follow every link that led to it${linkers.length ? ` (${linkers.slice(0, 3).map((l) => `${fileName(l.c.file)}:${l.line}`).join(', ')})` : ''}.`, expect: 'The route is gone: links to it must be gone or point elsewhere.', before: 'Opened a screen.', after: 'Route removed.', proof: 'derived', hops: [{ label: 'Route removed', file: rb.file, line: rb.line, quote: rb.path.split('/').filter(Boolean)[0] ?? "'/'", side: 'base', rule: `route ${rb.path} existed at base` }] });
      reached++;
    }
    if (screens === null) {
      const sid = 'screen:*';
      ctx.surface({ id: sid, kind: 'screen', name: 'Every screen', where: `${u.routes.length} screens`, tier: 'test-next' });
      ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Open each screen (${u.routes.map((r) => r.path).slice(0, 8).join(', ')}${u.routes.length > 8 ? ', …' : ''}) and check ${what}.`, expect: 'As intended by the change, and nothing else moved.', before: 'As released.', after: 'Changed on every screen.', proof: 'derived', hops: [changedHop] });
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
        const via = targets.map((t) => importChain(u, r.component, t)).find((x) => x) ?? [];
        ctx.addCase({ surface: sid, delta: id, tier, do: `Open ${title} and check ${what}.`, expect: own ? 'Shows and works as the change intends.' : `Works as before: it runs ${fileName(cf.path)}, which changed.`, before: 'As released.', after: own ? 'Changed.' : 'Runs changed code.', proof: 'derived', hops: atHead ? [changedHop, ...via, { label: 'Screen', file: r.file, line: r.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${r.path}` }] : [changedHop] });
        reached++;
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

  /* ---------- dependencies: which modules use what moved ---------- */
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'dependencies' || cf.status === 'deleted') continue;
    const name = fileName(cf.path);
    if (name === 'pom.xml') followPom(ctx, cf, consumersOfModule);
    else if (name === 'package.json') followPackageJson(ctx, cf);
    else if (/lock/.test(name)) {
      // lockfiles move with their manifest; a lock-only change moves versions with no manifest line
      const manifest = cf.path.replace(/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/, 'package.json');
      if (!ctx.changes.some((c) => c.path === manifest)) ctx.unseen.push({ what: `${cf.path} changed with no change to ${fileName(manifest)}`, why: 'resolved versions moved; which packages moved is not read yet', resolve: 'diff the lockfile for packages the app imports', files: [cf.path] });
      for (const n of cf.headLines) ctx.follow(cf.path, n);
    }
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
  }
}

/* ---------- Maven ---------- */

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
    if (cf.headLines.every((n) => head.inert(n) || !(ctx.H.line(cf.path, n) ?? '').trim()) && cf.baseLines.every((n) => base.inert(n) || !(ctx.B.line(cf.path, n) ?? '').trim())) {
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
  for (const n of cf.headLines) ctx.follow(cf.path, n);
  const runtime = moved.filter((m) => !m.dev);
  if (!runtime.length) return;
  const dir = cf.path.includes('/') ? cf.path.slice(0, cf.path.lastIndexOf('/') + 1) : '';
  const id = `deps:${cf.path}`;
  const framework = runtime.filter((m) => /^(vue|vue-router|react|react-dom|@angular\/core|@angular\/router|svelte|axios)$/.test(m.name));
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
      ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Use the parts of this screen drawn with ${m.name}.`, expect: 'Works as before.', before: 'As released.', after: `${m.name} ${m.from} → ${m.to}.`, proof: 'derived', hops: [...hops.filter((h) => h.rule.startsWith(m.name)), { label: 'Imports it', file: user.file, line: importAt || 1, quote: importAt ? m.name : '', rule: `${fileName(user.file)} imports ${m.name}` }, { label: 'Screen', file: r.file, line: r.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${r.path}` }] });
    }
  }
  ctx.deltas.push({ id, kind: 'dependency-changed', title: `${cf.path}: ${list}`, endpoint: '', rules: [], causes: hops.slice(0, 1) });
}
