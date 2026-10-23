import { snapshot, changedFiles } from './snapshot.js';
import { readSpring, exposedAs, templateHits, type SpringFacts, type Endpoint, type DtoField } from './spring.js';
import { readVue, targetsRoute, type Component } from './vue.js';
import { readDashboards, promKeeps, readRequestPlans, readSeedRows, breaks, probe } from './outside.js';
import type { ImpactReport, Delta, Surface, Case, Hop, Unseen, LedgerEntry, Tier } from './model.js';

/**
 * The engine. Given two commits, it works out which behaviour changed (typed
 * deltas, not lines), follows each change through the rules that carry it to
 * the places a person meets it, says what was checked and ruled out, and
 * re-reads every cited line at head before anything is reported.
 *
 * This build models request rules (Bean Validation, switched on by @Valid) end
 * to end. Every other changed construct is listed as NOT MODELLED in the
 * ledger, never left out.
 */

export interface ImpactOptions {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  /** Other repositories already on disk, by the URL the code refers to them with. */
  readonly linked?: Readonly<Record<string, string>>;
  /** For time-based rules; defaults to today, UTC. */
  readonly today?: string;
}

const RANK: Record<Tier, number> = { 'test-first': 3, 'test-next': 2, watch: 1, skip: 0 };
const fileName = (p: string): string => p.split('/').pop() ?? p;
const ruleKey = (field: string, rule: string): string => `${field} ${rule}`;

function enforced(f: SpringFacts, e: Endpoint): { field: DtoField; rule: string; name: string; line: number; file: string }[] {
  if (!e.body?.valid) return [];
  const d = f.dto(e.module, e.body.type);
  if (!d) return [];
  return d.fields.flatMap((fl) => fl.constraints.map((c) => ({ field: fl, rule: c.rule, name: c.name, line: c.line, file: c.file })));
}

/** The model expression a payload value reads: `pet.name.trim()` → `pet.name`. */
function modelPath(value: string): string {
  let v = value.trim().replace(/^this\./, '').replace(/\.value\b/, '');
  v = v.replace(/\s*\|\|.*$/, '').replace(/\.trim\(\)$/, '').replace(/^(?:Number|String|Boolean|parseInt|parseFloat)\((.*)\)$/, '$1');
  return v.trim();
}

/** Can a value that breaks this rule leave this field? */
function guard(rule: string, el: { attrs: Readonly<Record<string, string>> } | undefined, payloadTrims: boolean): { reach: 'yes' | 'no' | 'unknown'; why: string } {
  if (!el) return { reach: 'unknown', why: 'no form field found for it' };
  const a = el.attrs;
  const type = a['type'] ?? 'text';
  const required = 'required' in a || ':required' in a;
  const trims = Object.keys(a).some((k) => k.startsWith('v-model') && k.includes('.trim'));
  const name = /^@(\w+)/.exec(rule)?.[1] ?? '';
  if (/^(Past|PastOrPresent)$/.test(name)) return 'max' in a || ':max' in a ? { reach: 'unknown', why: `max=${a['max'] ?? a[':max']}: compare with today` } : { reach: 'yes', why: `type="${type}" with no max: a date after today can be picked` };
  if (/^(Future|FutureOrPresent)$/.test(name)) return 'min' in a || ':min' in a ? { reach: 'unknown', why: `min set: compare with today` } : { reach: 'yes', why: `no min: a date before today can be picked` };
  if (/^(Size|Length|NotBlank|NotEmpty)$/.test(name) && /min\s*=\s*[1-9]|NotBlank|NotEmpty/.test(rule)) {
    if (!required) return { reach: 'yes', why: 'not required: an empty value can be sent' };
    if (trims) return { reach: 'no', why: 'required + v-model.trim: the field is emptied on change and the browser blocks submit' };
    if (payloadTrims) return { reach: 'yes', why: 'required passes spaces, then the payload trims them to ""' };
    return { reach: 'no', why: 'required, and spaces are sent as they are' };
  }
  if (/^(Size|Length)$/.test(name) && /max\s*=/.test(rule)) return 'maxlength' in a ? { reach: 'unknown', why: 'maxlength set on the field' } : { reach: 'yes', why: 'no maxlength on the field' };
  return { reach: 'unknown', why: 'no guard rule for this constraint yet' };
}

function tryValue(rule: string): { input: string; plain: string } {
  const name = /^@(\w+)/.exec(rule)?.[1] ?? '';
  const min = /min\s*=\s*(\d+)/.exec(rule)?.[1];
  const max = /max\s*=\s*(\d+)/.exec(rule)?.[1];
  switch (name) {
    case 'PastOrPresent': case 'Past': return { input: 'a date after today', plain: 'a future date' };
    case 'FutureOrPresent': case 'Future': return { input: 'a date before today', plain: 'a past date' };
    case 'NotBlank': case 'NotEmpty': return { input: 'nothing (empty)', plain: 'an empty value' };
    case 'NotNull': return { input: 'nothing', plain: 'no value' };
    case 'Size': case 'Length': return min && Number(min) > 0 ? { input: Number(min) === 1 ? 'an empty value ""' : `${Number(min) - 1} characters`, plain: 'too short a value' } : { input: `${Number(max ?? 0) + 1} characters`, plain: 'too long a value' };
    case 'Min': return { input: 'a value below the minimum', plain: 'too small a value' };
    case 'Max': return { input: 'a value above the maximum', plain: 'too large a value' };
    case 'Pattern': case 'Email': return { input: 'a value that does not match the format', plain: 'a badly formatted value' };
    default: return { input: 'a value that breaks the rule', plain: 'an invalid value' };
  }
}

export function impact(opts: ImpactOptions): ImpactReport {
  const t0 = Date.now();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const B = snapshot(opts.repo, opts.base);
  const H = snapshot(opts.repo, opts.head);
  const fb = readSpring(B);
  const fh = readSpring(H);
  const ui = readVue(H);
  const changes = changedFiles(opts.repo, B.ref, H.ref);

  const deltas: Delta[] = [];
  const surfaces = new Map<string, Surface>();
  const cases: Case[] = [];
  const unseen: Unseen[] = [];
  const explainedLines = new Map<string, Set<number>>();
  const explain = (file: string, line: number): void => { if (!explainedLines.has(file)) explainedLines.set(file, new Set()); explainedLines.get(file)!.add(line); };
  const surface = (s: Omit<Surface, 'tier'> & { tier: Tier }): Surface => {
    const cur = surfaces.get(s.id);
    if (!cur) { surfaces.set(s.id, s); return s; }
    if (RANK[s.tier] > RANK[cur.tier]) cur.tier = s.tier;
    return cur;
  };
  /** Screens that only read a changed API, with the read as evidence. */
  const readsOnly = new Map<string, Hop>();
  /** Per delta and field: can a value that breaks the rule leave any screen? */
  const reachable = new Map<string, Set<'yes' | 'no' | 'unknown'>>();
  /** Everything a screen runs: its component and, transitively, what it imports. */
  const closures = new Map<string, Set<string>>();
  const closure = (file: string): Set<string> => {
    if (closures.has(file)) return closures.get(file)!;
    const seen = new Set<string>();
    const walk = (f: string, depth: number): void => {
      if (seen.has(f) || depth > 8) return;
      seen.add(f);
      for (const d of ui.components.get(f)?.deps ?? []) walk(d, depth + 1);
    };
    walk(file, 0);
    closures.set(file, seen);
    return seen;
  };
  const screensUsing = (file: string) => ui.routes.filter((r) => closure(r.component).has(file));
  const addCase = (c: Case): void => {
    if (cases.some((x) => x.surface === c.surface && x.do === c.do)) return;
    cases.push(c);
  };

  /* ---------- 1. deltas: rules enforced at head that were not at base ---------- */
  for (const e of fh.endpoints) {
    const before = fb.endpoints.find((x) => x.service === e.service && x.verb === e.verb && x.path === e.path) ?? fb.endpoints.find((x) => x.cls === e.cls && x.method === e.method && x.verb === e.verb);
    const now = enforced(fh, e);
    const was = before ? enforced(fb, before) : [];
    const wasKeys = new Set(was.map((r) => ruleKey(r.field.name, r.rule)));
    const added = now.filter((r) => !wasKeys.has(ruleKey(r.field.name, r.rule)));
    const nowKeys = new Set(now.map((r) => ruleKey(r.field.name, r.rule)));
    const removed = was.filter((r) => !nowKeys.has(ruleKey(r.field.name, r.rule)));
    for (const [kind, list] of [['request-rules-enforced', added], ['request-rules-relaxed', removed]] as const) {
      if (!list.length) continue;
      const exp = exposedAs(fh, e);
      const action = e.verb === 'POST' ? 'Create' : e.verb === 'PUT' || e.verb === 'PATCH' ? 'Update' : e.verb;
      const noun = e.body!.type.replace(/(Request|DTO|Dto|Form|Command)$/, '').toLowerCase();
      const causes: Hop[] = [];
      for (const r of list) causes.push({ label: kind === 'request-rules-enforced' ? 'Rule' : 'Rule removed', file: r.file, line: r.line, quote: r.name, rule: `${r.field.name}: ${r.rule}` });
      const validChanged = !before?.body?.valid && e.body!.valid;
      if (e.body!.valid) causes.push({ label: validChanged ? '@Valid added' : 'Enforced by', file: e.file, line: e.body!.line, quote: 'Valid', rule: validChanged ? '@Valid now enforces every rule on the body, not only the new one' : '@Valid on the request body' });
      causes.push({ label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} in ${e.service}` });
      if (exp) causes.push({ label: 'Gateway', file: exp.route.file, line: exp.route.line, quote: `Path=${exp.route.prefix}`, rule: `exposed as ${e.verb} ${exp.path} (StripPrefix=${exp.route.strip})` });
      const d: Delta = {
        id: `${kind === 'request-rules-enforced' ? 'enf' : 'rel'}:${e.verb} ${e.path}`,
        kind,
        title: `${action} ${noun}: ${kind === 'request-rules-enforced' ? 'now refuses' : 'now accepts'} ${list.map((r) => `${r.field.json} ${r.rule}`).join(', ')}`,
        endpoint: `${e.verb} ${exp ? exp.path : e.path}`,
        rules: list.map((r) => ({ field: r.field.name, json: r.field.json, rule: r.rule, name: r.name, file: r.file, line: r.line })),
        causes,
      };
      deltas.push(d);
      for (const c of causes) explain(c.file, c.line);
      // the field declaration and the @Valid parameter lines are part of the change
      for (const r of list) explain(r.file, r.field.line);
      const aid = `api:${d.endpoint}`;
      surface({ id: aid, kind: 'api', name: d.endpoint, where: `${e.service} ${e.verb} ${e.path}`, tier: 'test-first' });
      for (const r of d.rules) {
        const v = tryValue(r.rule);
        const refuses = kind === 'request-rules-enforced';
        addCase({ surface: aid, delta: d.id, tier: 'test-first', field: r.json, do: `Send ${d.endpoint} with ${v.plain} for ${r.json}.`, expect: refuses ? 'HTTP 400.' : 'Accepted (2xx).', before: refuses ? 'Accepted (2xx).' : 'HTTP 400.', after: refuses ? 'HTTP 400.' : 'Accepted (2xx).', proof: 'derived', hops: causes });
        const hole = refuses ? holeOf(r, d.rules) : null;
        if (hole) addCase({ surface: aid, delta: d.id, tier: 'test-first', field: r.json, hole: true, do: `Send ${d.endpoint} with ${hole.input}.`, expect: `Still accepted: ${hole.why}.`, before: 'Accepted.', after: 'Still accepted.', proof: 'derived', hops: [...causes, { label: 'Rule hole', file: r.file, line: r.line, quote: r.name, rule: hole.why }] });
      }
      if (kind === 'request-rules-enforced') propagate(d, e);
    }
  }

  function propagate(d: Delta, e: Endpoint): void {
    const writerScreens = new Set<string>();
    /* --- 2a. browser callers --- */
    for (const c of ui.calls) {
      const route = fh.gateway.find((r) => c.tpl === r.prefix || c.tpl.startsWith(r.prefix + '/') || c.tpl.startsWith(r.prefix + '{'));
      // no gateway: the page and the API are served together, so the path alone decides
      if (fh.gateway.length && (route ? route.service : fh.gatewayService) !== e.service) continue;
      const internal = route ? '/' + c.tpl.split('/').filter(Boolean).slice(route.strip).join('/') : c.tpl;
      if (!templateHits(internal, e.path)) continue;
      const comp = ui.components.get(c.file);
      const routes = screensUsing(c.file);
      if (!c.verbs.includes(e.verb)) {
        // direction: a rule on the request body cannot change what a read returns
        for (const r of routes) if (!readsOnly.has(r.path)) readsOnly.set(r.path, { label: 'Reads only', file: c.file, line: c.line, quote: callText(c), rule: `${c.verbs.join('/')} ${c.tpl}: a rule on what is sent cannot change what is read back` });
        continue;
      }
      for (const r of routes) {
        const verb = c.verbChoice ? (new RegExp(`:${c.verbChoice.param}\\b`).test(r.path) ? c.verbChoice.ifTrue : c.verbChoice.ifFalse) : e.verb;
        if (verb !== e.verb) continue;
        writerScreens.add(r.path);
        const sid = `screen:${r.path}`;
        surface({ id: sid, kind: 'screen', name: screenName(comp, r.path, verb), where: r.path, tier: 'test-first' });
        for (const rule of d.rules) {
          const prop = c.payload?.props.find((p) => p.key === rule.json);
          const model = prop ? modelPath(prop.value) : c.payload?.whole ? `${c.payload.whole}.${rule.json}` : undefined;
          const el = model && comp ? comp.elements.find((x) => Object.entries(x.attrs).some(([k, v]) => k.startsWith('v-model') && v === model)) : undefined;
          const label = el && comp ? labelFor(comp, el) : undefined;
          const section = el && comp ? sectionAbove(comp, el.line) : undefined;
          const g = guard(rule.rule, el, !!prop && /\.trim\(\)/.test(prop.value));
          const rk = `${d.id}|${rule.json}`;
          if (!reachable.has(rk)) reachable.set(rk, new Set());
          reachable.get(rk)!.add(g.reach);
          const hops: Hop[] = [...d.causes];
          hops.push({ label: 'The page sends it', file: c.file, line: c.line, quote: callText(c), rule: c.verbChoice ? `${c.verbChoice.param} ? '${c.verbChoice.ifTrue}' : '${c.verbChoice.ifFalse}': this route ${new RegExp(`:${c.verbChoice.param}\\b`).test(r.path) ? 'has' : 'has no'} :${c.verbChoice.param}, so it sends ${verb}` : `${verb} ${c.tpl}` });
          if (prop) hops.push({ label: 'Which field', file: c.file, line: prop.line, quote: rule.json, rule: `payload key ${rule.json} ← ${prop.value}` });
          else if (c.payload?.whole && c.payload.line) hops.push({ label: 'Which field', file: c.file, line: c.payload.line, quote: c.payload.whole.split('.')[0]!, rule: `the whole ${c.payload.whole} is sent, so ${rule.json} is ${c.payload.whole}.${rule.json}` });
          if (el) hops.push({ label: 'The field', file: c.file, line: el.line, quote: model ?? '', rule: g.why });
          const rr = ui.routes.find((x) => x.path === r.path)!;
          hops.push({ label: 'Screen', file: rr.file, line: rr.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `route ${r.path} → ${fileName(c.file)}` });
          const v = tryValue(rule.rule);
          const button = comp ? submitLabel(comp, verb) : 'save';
          if (g.reach === 'no') {
            addCase({ surface: sid, delta: d.id, tier: 'skip', ...(section ? { section } : {}), field: label ?? rule.json, do: `Not reachable from this screen`, expect: g.why, before: '—', after: '—', proof: 'derived', hops });
            continue;
          }
          addCase({ surface: sid, delta: d.id, tier: 'test-first', ...(section ? { section } : {}), field: label ?? rule.json, do: `Enter ${v.input}, press ${button}.`, expect: `Rejected (400).`, before: 'Saved.', after: 'Rejected (400).', proof: 'derived', hops });
          const tz = timeBoundary(rule);
          if (tz) addCase({ surface: sid, delta: d.id, tier: 'test-first', ...(section ? { section } : {}), field: label ?? rule.json, do: `On a machine in a time zone ahead of UTC (India before 05:30 IST), pick today's date, press ${button}.`, expect: 'Rejected: "today" is judged in UTC.', before: 'Saved.', after: 'Rejected (400).', proof: 'derived', hops: [...hops, tz] });
        }
        // journey: where a successful save goes
        const push = comp?.pushes.find((p) => p.line >= c.line && p.line <= c.line + 6);
        if (push) {
          const to = ui.routes.find((x) => targetsRoute(push.target, x.path));
          if (to) for (const cs of cases.filter((x) => x.surface === sid)) (cs.hops as Hop[]).push({ label: 'Then', file: c.file, line: push.line, quote: 'push', rule: `on success the screen goes to ${to.path}; a rejected save stays on the form` });
        }
      }
    }
    /* --- 2b. Java callers in other services, and what calls them --- */
    for (const jc of fh.calls) {
      if (jc.service !== e.service || jc.verb !== e.verb || !templateHits(jc.tpl, e.path)) continue;
      const sentDto = jc.bodyType ? fh.dto(jc.module, jc.bodyType) : undefined;
      const callHop: Hop = { label: 'Another service calls it', file: jc.file, line: jc.line, quote: 'uri', rule: `${jc.cls}.${jc.method}() · ${jc.how}` };
      const handling: Hop | null = jc.handles4xx ? null : { label: 'No error handling', file: jc.file, line: jc.line, quote: 'uri', rule: 'no onStatus or catch on this call: a 400 becomes an exception' };
      // which tools or endpoints reach this method
      const chains = upstream(`${jc.cls}.${jc.method}`);
      for (const ch of chains) {
        if (ch.kind === 'tool') {
          const tool = fh.tools.find((t) => `${t.cls}.${t.method}` === ch.at)!;
          for (const w of fh.wiring.filter((x) => x.toolsClass === tool.cls)) {
            for (const ep of fh.endpoints.filter((x) => x.cls === w.holder)) {
              const exp = exposedAs(fh, ep);
              const front = ui.calls.filter((c) => exp && (c.tpl === exp.path || templateHits(c.tpl, exp.path)) && c.verbs.includes(ep.verb));
              for (const fc of front) {
                const g = ui.globals.find((x) => x.file === fc.file);
                const hops: Hop[] = [...d.causes, callHop, ...(handling ? [handling] : []),
                  { label: 'Exposed to an AI model', file: tool.file, line: tool.line, quote: 'Tool', rule: `${tool.cls}.${tool.method}() is a tool the model can call` },
                  ...ch.hops,
                  { label: 'Wired into the chat', file: w.file, line: w.line, quote: w.expr.split('(')[0]!.replace('.', ''), rule: `${w.holder}${w.expr}` },
                  { label: 'The chat calls it', file: fc.file, line: fc.line, quote: callText(fc), rule: `${fc.verbs.join('/')} ${fc.tpl}` }];
                if (g) {
                  hops.push({ label: 'On every screen', file: g.root, line: g.line, quote: `<${g.tag}`, rule: `<${g.tag}> is drawn beside <router-view>` });
                  const sid = `widget:${g.tag}`;
                  surface({ id: sid, kind: 'widget', name: `AI chat (<${g.tag}>)`, where: 'every screen', tier: 'test-first' });
                  for (const rule of d.rules) {
                    const has = sentDto?.fields.some((f) => f.json === rule.json);
                    if (sentDto && !has) continue;
                    const rk = `${d.id}|${rule.json}`;
                    if (!reachable.has(rk)) reachable.set(rk, new Set());
                    reachable.get(rk)!.add('yes');
                    const v = tryValue(rule.rule);
                    const ask = tool.method.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
                    addCase({ surface: sid, delta: d.id, tier: 'test-first', field: rule.json, do: `Ask the chat to ${ask} with ${v.plain} for ${rule.json}.`, expect: handling ? 'A sentence saying it could not. Risk: an error, because the 400 is not handled.' : 'A sentence saying it could not.', before: 'Done.', after: 'Rejected by the API.', proof: 'derived', hops });
                    const hole = holeOf(rule, d.rules);
                    if (hole) addCase({ surface: sid, delta: d.id, tier: 'test-first', field: rule.json, hole: true, do: `Ask the chat to ${ask} with ${hole.input}.`, expect: `Still accepted: ${hole.why}.`, before: 'Accepted.', after: 'Still accepted.', proof: 'derived', hops: [...hops, { label: 'Rule hole', file: rule.file, line: rule.line, quote: rule.name, rule: hole.why }] });
                  }
                }
              }
            }
          }
        }
      }
    }
    /* --- 2c. data: rows already stored that the rule now refuses --- */
    if (e.verb === 'PUT' || e.verb === 'PATCH') {
      const entityName = e.body!.type.replace(/(Request|DTO|Dto|Form|Command)$/, '');
      const ent = fh.entities.find((x) => x.name === entityName);
      if (ent) {
        for (const rule of d.rules) {
          const col = ent.columns.find((c) => c.field === rule.field);
          if (!col) continue;
          const q = probe(rule.rule, ent.table, col.column);
          const seed = readSeedRows(H, ent.table);
          const seedText = seed.files.map((f) => {
            const rows = seed.rows.filter((row) => row.file === f);
            return `${rows.filter((row) => breaks(rule.rule, row.values.get(col.column) ?? null, today)).length} of ${rows.length} rows in ${f.split('/').slice(-3).join('/')}`;
          }).join('; ');
          const sid = `data:${ent.table}`;
          surface({ id: sid, kind: 'data', name: `${ent.table} table`, where: ent.table, tier: 'test-next' });
          const hops: Hop[] = [...d.causes, { label: 'Stored as', file: col.file, line: col.line, quote: col.explicit ? col.column : col.field, rule: `${ent.name}.${col.field} → ${ent.table}.${col.column}${col.explicit ? '' : ' (named by convention)'}: rows already stored keep their values` }];
          const reach0 = reachable.get(`${d.id}|${rule.json}`);
          if (reach0 && !reach0.has('yes') && !reach0.has('unknown')) {
            addCase({ surface: sid, delta: d.id, tier: 'skip', field: col.column, do: 'No probe needed', expect: 'the only screen that sends this blocked such values before this change too; callers outside the repo are under NOT VISIBLE', before: '—', after: '—', proof: 'derived', hops });
            continue;
          }
          addCase({ surface: sid, delta: d.id, tier: 'test-next', field: col.column, do: q ? `Before release, on a read-only copy of production: ${q}` : `Before release, count rows in ${ent.table} that break ${rule.rule}.`, expect: `Every row returned is a record that can no longer be saved until it is fixed.${seedText ? ` Seed data breaking it: ${seedText}.` : ''}`, before: 'Old rows could be saved.', after: 'Rows that break the rule are locked.', proof: 'derived', hops });
          // screens that show this field from stored rows, and the way back into the form
          const own = ent.name[0]!.toLowerCase() + ent.name.slice(1);
          for (const [file, comp] of ui.components) {
            const shows = comp.shows.filter((s) => new RegExp(`(?<![\\w.])${own}\\.${rule.json}\\b`).test(s.expr));
            if (!shows.length) continue;
            for (const r of ui.routes.filter((x) => x.component === file)) {
              const links = comp.links.filter((l) => [...writerScreens].some((w) => targetsRoute(l.target, w)));
              const link = links.find((l) => !l.text.includes('{{')) ?? links[0];
              const rsid = `screen:${r.path}`;
              const show = shows[0]!;
              const reach = reachable.get(`${d.id}|${rule.json}`);
              if (reach && !reach.has('yes') && !reach.has('unknown')) {
                // the form that edits it already blocked such a value before this change
                const sec0 = sectionAbove(comp, show.line);
                addCase({ surface: rsid, delta: d.id, tier: 'skip', ...(sec0 ? { section: sec0 } : {}), field: show.label || rule.json, do: `Do not test stored rows with ${tryValue(rule.rule).plain} in ${show.label || rule.json}`, expect: 'The edit form blocked such a value before this change too, so nothing changes here.', before: '—', after: '—', proof: 'derived', hops: [...hops, { label: 'Shown here', file, line: show.line, quote: rule.json, rule: `${show.label || rule.json}: ${show.expr}` }] });
                continue;
              }
              surface({ id: rsid, kind: 'screen', name: screenName(comp, r.path), where: r.path, tier: 'test-next' });
              const rh: Hop[] = [...hops, { label: 'Shown here', file, line: show.line, quote: rule.json, rule: `${show.label || rule.json}: ${show.expr}` }];
              if (link) rh.push({ label: 'The way to edit it', file, line: link.line, quote: 'router-link', rule: `"${link.text}" opens the form that now refuses such rows` });
              const sec = sectionAbove(comp, show.line);
              addCase({ surface: rsid, delta: d.id, tier: 'test-next', ...(sec ? { section: sec } : {}), field: show.label || rule.json, do: `Open a record whose ${show.label || rule.json} already breaks ${rule.rule}${link ? `, press ${link.text}` : ''}, save without changing anything.`, expect: 'Rejected until the value is fixed.', before: 'Saved.', after: 'Rejected (400).', proof: 'derived', hops: rh });
            }
          }
        }
      }
    }
    /* --- 2e. load-test plans and saved requests --- */
    const exp = exposedAs(fh, e);
    for (const pr of readRequestPlans(H)) {
      if (pr.method.toUpperCase() !== e.verb) continue;
      const hit = templateHits(pr.path, e.path) || (exp && templateHits(pr.path, exp.path));
      if (!hit) continue;
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(pr.body.replace(/"\$\{[^}]*\}"/g, '"0"').replace(/\$\{[^}]*\}/g, '0')) as Record<string, unknown>; } catch { body = null; }
      const fails = body ? d.rules.filter((r) => breaks(r.rule, body![r.json] === undefined || body![r.json] === null ? null : String(body![r.json]), today)) : [];
      const sid = `plan:${pr.file}`;
      // point at the line that carries the field in question, in JSON or XML-escaped JSON
      const keyLine = (key: string): number => {
        const lines = (H.read(pr.file) ?? '').split('\n');
        for (let i = Math.max(0, (pr.bodyLine || pr.line) - 1); i < Math.min(lines.length, (pr.bodyLine || pr.line) + 40); i++) {
          if (lines[i]!.includes(`"${key}"`) || lines[i]!.includes(`&quot;${key}&quot;`)) return i + 1;
        }
        return 0;
      };
      const focus = fails[0]?.json ?? d.rules[0]?.json ?? '';
      const fl = focus && body && focus in body ? keyLine(focus) : 0;
      const ev: Hop = { label: 'Request plan', file: pr.file, line: fl || pr.line, quote: fl ? focus : pr.path.split('/').filter(Boolean)[0] ?? '', rule: `${pr.method} ${pr.path}${body ? ` with ${JSON.stringify(body).slice(0, 80)}` : ''}` };
      if (!body) { unseen.push({ what: `${fileName(pr.file)}:${pr.line}`, why: 'calls this API with a body Teslon could not read', resolve: 'check the body by hand' }); continue; }
      if (fails.length) {
        surface({ id: sid, kind: 'test-plan', name: fileName(pr.file), where: pr.file, tier: 'test-first' });
        addCase({ surface: sid, delta: d.id, tier: 'test-first', do: `Run ${fileName(pr.file)}.`, expect: `It now fails: it sends ${fails.map((f) => f.json).join(', ')} that the API refuses.`, before: 'Passed.', after: 'Fails with 400.', proof: 'derived', hops: [...d.causes, ev] });
      } else skipReason(sid, 'test-plan', fileName(pr.file), `sends values the new rules accept`, ev);
    }
  }

  /** From a method, walk callers up to @Tool methods and endpoints. */
  function upstream(start: string): { kind: 'tool' | 'endpoint'; at: string; hops: Hop[] }[] {
    const out: { kind: 'tool' | 'endpoint'; at: string; hops: Hop[] }[] = [];
    const seen = new Set<string>();
    const walk = (at: string, hops: Hop[], depth: number): void => {
      if (seen.has(at) || depth > 6) return;
      seen.add(at);
      const [cls, method] = at.split('.');
      if (fh.tools.some((t) => t.cls === cls && t.method === method)) out.push({ kind: 'tool', at, hops });
      if (fh.endpoints.some((x) => x.cls === cls && x.method === method)) out.push({ kind: 'endpoint', at, hops });
      for (const e of fh.callEdges.filter((x) => x.to === at)) walk(e.from, [...hops, { label: 'Called by', file: e.file, line: e.line, quote: method ?? '', rule: `${e.from}() calls ${at}()` }], depth + 1);
    };
    walk(start, [], 0);
    return out;
  }

  function holeOf(rule: Delta['rules'][number], rules: Delta['rules']): { input: string; why: string } | null {
    const others = rules.filter((r) => r.field === rule.field).map((r) => r.name);
    if (others.includes('NotNull') || others.includes('NotBlank')) return null;
    if (rule.name === 'Size' && /min\s*=\s*[1-9]/.test(rule.rule)) return { input: `${rule.json} left out, or only spaces`, why: `${rule.rule} accepts a missing value and counts spaces` };
    if (/^(Past|PastOrPresent|Future|FutureOrPresent|Pattern|Email|Min|Max)$/.test(rule.name)) return { input: `${rule.json} left out`, why: `${rule.rule} accepts a missing value` };
    return null;
  }

  function timeBoundary(rule: Delta['rules'][number]): Hop | null {
    if (!/^(Past|PastOrPresent|Future|FutureOrPresent)$/.test(rule.name)) return null;
    for (const d of fh.dtos.values()) {
      const f = d.fields.find((x) => x.name === rule.field && x.file === rule.file);
      if (f?.jsonFormat && /^y{2,4}-MM-dd$/.test(f.jsonFormat.pattern) && /^(Date|java\.util\.Date)$/.test(f.type)) {
        return { label: 'Read as UTC', file: f.jsonFormat.file, line: f.jsonFormat.line, quote: 'JsonFormat', rule: `@JsonFormat("${f.jsonFormat.pattern}") on java.util.Date reads the day as 00:00 UTC, so "today" is UTC's today` };
      }
    }
    return null;
  }

  function skipReason(id: string, kind: Surface['kind'], name: string, reason: string, ev: Hop): void {
    if (!surfaces.has(id)) surfaces.set(id, { id, kind, name, where: ev.file, tier: 'skip', reason, evidence: [ev] });
  }

  /* ---------- 2d. dashboards: which panels count the requests that now fail ---------- */
  const enforcedDeltas = deltas.filter((d) => d.kind === 'request-rules-enforced');
  if (enforcedDeltas.length) {
    const eps = enforcedDeltas.map((d) => fh.endpoints.find((e) => `enf:${e.verb} ${e.path}` === d.id)!).filter(Boolean);
    const causes = enforcedDeltas.flatMap((d) => d.causes.filter((c) => c.label !== 'Gateway' && c.label !== 'API'));
    const uniq = [...new Map(causes.map((c) => [`${c.file}:${c.line}`, c])).values()];
    const byPanel = new Map<string, ReturnType<typeof readDashboards>>();
    for (const p of readDashboards(H)) {
      const k = `${p.file}\u0000${p.title}`;
      if (!byPanel.has(k)) byPanel.set(k, []);
      byPanel.get(k)!.push(p);
    }
    for (const targets of byPanel.values()) {
      const p0 = targets[0]!;
      const sid = `dashboard:${p0.file}`;
      const counts: Hop[] = [];
      const ignores: Hop[] = [];
      for (const p of targets) {
        if (/http_server_requests/.test(p.expr)) {
          const answers = eps.map((e) => promKeeps(p.expr, { status: '400', uri: e.path, method: e.verb, outcome: 'CLIENT_ERROR' }, 'http_server_requests'));
          if (answers.some((a) => a === undefined)) { unseen.push({ what: `the query of "${p.title}" (${fileName(p.file)}:${p.line})`, why: 'it does not parse as PromQL, so whether it counts the new 400s is unknown', resolve: 'read the panel by hand' }); continue; }
          const keeps = answers.some(Boolean);
          (keeps ? counts : ignores).push({ label: 'Query', file: p.file, line: p.line, quote: 'http_server_requests', rule: `${p.expr}: ${keeps ? 'its filter keeps status 400' : 'its filter drops status 400'}` });
          continue;
        }
        for (const e of eps) for (const t of fh.timed.filter((x) => x.cls === e.cls && (!x.method || x.method === e.method))) {
          const prom = t.metric.replace(/\./g, '_') + '_seconds';
          if (!p.expr.includes(prom)) continue;
          const named = /method\s*=\s*"(\w+)"/.exec(p.expr)?.[1];
          if (named && named !== e.method) continue;
          ignores.push({ label: 'Query', file: p.file, line: p.line, quote: prom, rule: `@Timed("${t.metric}") on ${t.cls} records ${e.method}() only when it runs; @Valid rejects before it runs` });
        }
      }
      if (!counts.length && !ignores.length) continue;
      surface({ id: sid, kind: 'dashboard', name: fileName(p0.file).replace(/\.json$/, ''), where: p0.file, tier: counts.length ? 'watch' : 'skip' });
      const unchanged = ignores.length ? ` Its other query (${ignores.map((h) => `line ${h.line}`).join(', ')}) drops 400s and does not change.` : '';
      if (counts.length) addCase({ surface: sid, delta: enforcedDeltas[0]!.id, tier: 'watch', field: p0.title, do: `After deploy, watch "${p0.title}".`, expect: `It now includes the 400s from ${eps.map((e) => `${e.verb} ${exposedAs(fh, e)?.path ?? e.path}`).join(' and ')}.${unchanged}`, before: 'No 400s from these requests.', after: 'New 400s counted.', proof: 'derived', hops: [...uniq, ...counts, ...ignores] });
      else addCase({ surface: sid, delta: enforcedDeltas[0]!.id, tier: 'skip', field: p0.title, do: `"${p0.title}" does not change`, expect: ignores[0]!.rule.split(': ').pop()!, before: '—', after: '—', proof: 'derived', hops: ignores });
    }
  }

  /* ---------- 2f. jobs and listeners ---------- */
  for (const l of deltas.length ? fh.listeners : []) {
    const types = new Set<string>();
    for (const d of deltas) {
      const e = fh.endpoints.find((x) => `${d.kind === 'request-rules-enforced' ? 'enf' : 'rel'}:${x.verb} ${x.path}` === d.id);
      if (e?.body) { types.add(e.body.type); types.add(e.body.type.replace(/(Request|DTO|Dto|Form|Command)$/, '')); }
    }
    const used = l.mentions.filter((m) => types.has(m));
    const ev: Hop = { label: 'Listener', file: l.file, line: l.line, quote: l.kind, rule: `${l.cls}.${l.method}() ${l.kind}` };
    if (!used.length) skipReason(`job:${l.cls}.${l.method}`, 'job', `${l.cls}.${l.method}()`, `${l.kind}: uses none of ${[...types].join(', ')}`, ev);
    else unseen.push({ what: `${l.cls}.${l.method}() (${fileName(l.file)}:${l.line})`, why: `a ${l.kind} job uses ${used.join(', ')} without going through the API, so @Valid does not check what it saves; whether it saves values the new rules refuse is not modelled`, resolve: 'read this job by hand' });
  }

  /* ---------- 3. screens not reached: a skip only when all of their code was read ---------- */
  const notRuledOut: string[] = [];
  for (const r of deltas.length ? ui.routes : []) {
    const id = `screen:${r.path}`;
    if (surfaces.has(id)) continue;
    const comp = ui.components.get(r.component);
    const files = closure(r.component);
    const own = ui.calls.filter((c) => files.has(c.file));
    const opaque = [...files].flatMap((f) => (ui.components.get(f)?.opaque ?? []).map((o) => `${o.what} at ${fileName(f)}:${o.line}`));
    if (opaque.length) { notRuledOut.push(`${r.path} (${opaque.slice(0, 2).join('; ')}${opaque.length > 2 ? ` +${opaque.length - 2}` : ''})`); continue; }
    const ro = readsOnly.get(r.path);
    const vc = own.find((c) => c.verbChoice)?.verbChoice;
    const verb = vc ? (new RegExp(`:${vc.param}\\b`).test(r.path) ? vc.ifTrue : vc.ifFalse) : undefined;
    if (ro) { surfaces.set(id, { id, kind: 'screen', name: screenName(comp, r.path, verb), where: r.path, tier: 'skip', reason: 'only reads the changed API', evidence: [ro] }); continue; }
    const read = files.size > 1 ? ` (read ${files.size} files: the screen and what it imports)` : '';
    surfaces.set(id, {
      id, kind: 'screen', name: screenName(comp, r.path, verb), where: r.path, tier: 'skip',
      reason: own.length ? `calls no changed API: ${own.map((c) => `${c.verbs.join('/')} ${c.tpl}`).join(', ')}${read}` : `calls no API${read}`,
      evidence: own.length ? own.map((c) => ({ label: 'Calls', file: c.file, line: c.line, quote: callText(c), rule: `${c.verbs.join('/')} ${c.tpl}` })) : [{ label: 'Screen', file: r.file, line: r.line, quote: r.path.split('/').filter(Boolean)[0] ?? "'/'", rule: `${r.path} → ${fileName(r.component)}` }],
    });
  }
  if (notRuledOut.length) unseen.push({ what: `${notRuledOut.length} screen${notRuledOut.length === 1 ? '' : 's'} that could not be ruled out: ${notRuledOut.join(', ')}`, why: 'their data goes through code this build does not follow (stores, injected services, URLs built elsewhere)', resolve: 'check these screens by hand' });
  for (const u of ui.unread) unseen.push({ what: `the ${u.framework} front end (${u.files} file${u.files === 1 ? '' : 's'}, e.g. ${u.example})`, why: `this build reads Vue only, so these screens are neither listed nor ruled out`, resolve: `test the ${u.framework} screens that use the changed APIs by hand` });

  /* ---------- 4. what could not be seen ---------- */
  if (deltas.length) unseen.push({ what: `callers outside this repository of ${[...new Set(deltas.map((d) => d.endpoint))].join(', ')}`, why: 'mobile apps, partner systems and scripts are not in the code; they now get 400 for the values listed above', resolve: 'check gateway access logs for other callers of these paths' });
  for (const c of fh.configRepos) {
    const local = opts.linked?.[c.uri];
    if (!local) unseen.push({ what: `runtime configuration in ${c.uri}`, why: `the config server serves properties from another repository (${fileName(c.file)}:${c.line}); error bodies, time zones and flags may be set there`, resolve: `pass that repository with --link ${c.uri}=<path>` });
  }
  for (const u of fh.unreadable) unseen.push({ what: u.file, why: `could not be parsed: ${u.error}`, resolve: 'check this file by hand' });

  /* ---------- 5. ledger: every changed line accounted for ---------- */
  const ledger: LedgerEntry[] = [];
  for (const cf of changes) {
    if (cf.status === 'deleted') { ledger.push({ file: cf.path, status: 'deleted', by: [], lines: [] }); continue; }
    if (/(^|\/)src\/test\/|(^|\/)(test|tests|__tests__|e2e|cypress)\/|\.(spec|test)\.\w+$/.test(cf.path)) { ledger.push({ file: cf.path, status: 'test-only', by: [], lines: [] }); continue; }
    const ex = explainedLines.get(cf.path) ?? new Set<number>();
    const left = cf.headLines.filter((n) => {
      if (ex.has(n)) return false;
      const t = (H.line(cf.path, n) ?? '').trim();
      return !(t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /^import\s/.test(t) || t === '}' || t === '{');
    });
    const by = deltas.filter((d) => d.causes.some((c) => c.file === cf.path)).map((d) => d.id);
    if (!left.length) ledger.push({ file: cf.path, status: by.length ? 'explained' : 'no-runtime-effect', by, lines: [] });
    else ledger.push({ file: cf.path, status: 'not-modelled', by, lines: left });
  }

  /* ---------- 6. verification: every hop re-read at head ---------- */
  const failed: Hop[] = [];
  let count = 0;
  const allHops = [...deltas.flatMap((d) => d.causes), ...cases.flatMap((c) => c.hops), ...[...surfaces.values()].flatMap((s) => s.evidence ?? [])];
  for (const h of new Set(allHops)) {
    count++;
    const text = H.line(h.file, h.line);
    h.verified = text !== null && (h.quote === '' || text.includes(h.quote));
    if (!h.verified) failed.push(h);
  }

  const notModelled = [
    'response shape changes (fields renamed, removed or retyped in what an API returns)',
    'database schema and migrations',
    'messages and events between services',
    'configuration and feature flags',
    'permissions and security rules',
  ];

  return {
    schema: 'teslon.impact/1', repo: opts.repo, base: B.ref, head: H.ref,
    deltas, surfaces: [...surfaces.values()].sort((a, b) => RANK[b.tier] - RANK[a.tier] || a.id.localeCompare(b.id)),
    cases, unseen, ledger, verification: { hops: count, failed }, notModelled, ms: Date.now() - t0,
  };
}

/** The start of the line a call is on: always on that line, whatever the call is named. */
const callText = (c: { code: string }): string => c.code.slice(0, 24).trim();

function screenName(comp: Component | undefined, route: string, verb?: string): string {
  const h = comp?.elements.find((e) => /^h[1-3]$/.test(e.tag) && e.text && !e.text.includes('{{'));
  const base = h?.text ?? route;
  if (/^(Add|New|Edit|Update|Create)\b/i.test(base)) return base;
  // one form for both: the verb it sends on this route names it
  if (verb === 'PUT' || verb === 'PATCH') return `Edit ${base}`;
  if (verb === 'POST' || /\/new(-\w+)?$/.test(route)) return `Add ${base}`;
  return base;
}

function labelFor(comp: Component, el: { attrs: Readonly<Record<string, string>> }): string | undefined {
  const id = el.attrs['id'];
  return id ? comp.elements.find((x) => x.tag === 'label' && x.attrs['for'] === id)?.text : undefined;
}

function sectionAbove(comp: Component, line: number): string | undefined {
  return [...comp.elements].filter((x) => /^h[1-6]$/.test(x.tag) && x.line <= line && x.text && !x.text.includes('{{')).pop()?.text;
}

function submitLabel(comp: Component, verb: string): string {
  const b = comp.elements.find((x) => x.tag === 'button' && (x.attrs['type'] === 'submit' || /submit|save|update/i.test(x.text)));
  if (!b) return 'save';
  const m = /isEdit\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/.exec(b.text);
  if (m) return verb === 'PUT' || verb === 'PATCH' ? m[1]! : m[2]!;
  return b.text.replace(/\{\{.*?\}\}/g, '').trim() || 'save';
}

