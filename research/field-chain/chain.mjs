// Field-level impact chain: page → section → field → API → data → job → dashboard.
//
//   node research/field-chain/chain.mjs <repo> <base> <head>
//
// Every layer is joined by a key the framework itself defines: a route path,
// a v-model binding, a JSON property, a setter, a @Column name, a metric name.
// Nothing is joined by similarity. Each line printed carries file:line, and a
// hop that is only a name join (not yet a type-checked one) says so.
import { at } from '../page-impact/mech.mjs';
import { impact } from '../page-impact/run.mjs';

const [repo, base, head] = process.argv.slice(2);
const R = impact(repo, base, head, () => {});
const H = at(repo, head);

const src = (f) => H.read(f) ?? '';
const L = (f) => src(f).split('\n');
const short = (f) => f.split('/').pop();
const at_ = (f, n) => `${short(f)}:${n}`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
function find(f, re, from = 0, to = Infinity) {
  const ls = L(f);
  for (let i = Math.max(0, from); i < Math.min(ls.length, to); i++) { const m = re.exec(ls[i]); if (m) return { n: i + 1, m, text: ls[i].trim() }; }
  return null;
}
function findBack(f, re, before) {
  const ls = L(f);
  for (let i = before - 2; i >= 0; i--) { const m = re.exec(ls[i]); if (m) return { n: i + 1, m, text: ls[i].trim() }; }
  return null;
}
const routeLine = (route) => {
  for (const f of H.list.filter((x) => /\.(m?js|ts)$/.test(x))) { const h = find(f, new RegExp(`path:\\s*['"]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)); if (h) return at_(f, h.n); }
  return '?';
};
const routeRe = (route) => new RegExp('^' + route.replace(/:\w+/g, '[^/]+') + '$');
// '/owners/' + owner.id + '/pets/' + pet.id   or   `/owners/details/${ownerId}`  →  /owners/*/pets/*
const linkPattern = (expr) => expr.includes('`') ? expr.replace(/`/g, '').replace(/\$\{[^}]+\}/g, '*')
  : expr.split('+').map((p) => p.trim()).map((p) => (/^'.*'$/.test(p) ? p.slice(1, -1) : '*')).join('');
const pageOfLink = (pat) => [...R.frontend.pages.values()].flat().find((r) => routeRe(r).test(pat.replace(/\*/g, 'x1')));

// ── what changed: field-level rules, grouped by field ───────────────────────
const byField = new Map();
for (const t of R.tightened) for (const r of t.added) {
  const field = r.split(' ')[0], rule = r.slice(field.length + 1);
  const g = byField.get(field) ?? { field, rule, eps: [] };
  g.eps.push(t.ep); byField.set(field, g);
}

const out = console.log;
out(`FIELD-LEVEL IMPACT  ${base}..${head}\n`);

// Never silent: every changed file is claimed by a rule, or said to be
// outside what this prototype models. "Nothing printed" must never be
// readable as "nothing affected".
{
  const { execFileSync } = await import('node:child_process');
  const changed = execFileSync('git', ['-C', repo, 'diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const claimed = new Set(R.tightened.flatMap((t) => [t.ep.file, H.list.find((f) => f.startsWith(t.ep.svcDir + '/') && f.endsWith(`/${t.ep.body.type}.java`))]));
  for (const f of changed) {
    const why = claimed.has(f) ? 'claimed: request rule changed (below)' : /\/src\/test\//.test(f) ? 'test code — no runtime surface' : 'NOT MODELLED by this prototype — check by hand';
    out(`   changed  ${f}  — ${why}`);
  }
  out('');
}
for (const { field, rule, eps } of byField.values()) {
  const e0 = eps[0];
  out(`━━ ${field} ${rule}  — newly enforced on ${eps.map((e) => `${e.verb} ${e.path}`).join(' and ')}`);

  // API + DTO
  for (const e of eps) {
    const ext = R.items.find((i) => i.kind === 'endpoint' && i.endpoint === `${e.service} ${e.verb} ${e.path}`);
    out(`   API      ${ext?.id ?? e.verb + ' ' + e.path}  → ${e.handler}  ${at_(e.file, e.line)}${ext?.validAdded ? '   (@Valid added in this change)' : ''}`);
  }
  const dto = H.list.find((f) => f.startsWith(e0.svcDir + '/') && f.endsWith(`/${e0.body.type}.java`));
  const fl = find(dto, new RegExp(`\\b${field}\\s*[,;)]`));
  const json = findBack(dto, /@JsonProperty\(\s*"(\w+)"/, fl.n)?.m[1] ?? field;
  const ann = findBack(dto, new RegExp(rule.split('(')[0].replace('@', '@')), fl.n + 1) ?? fl;
  out(`   DTO      ${e0.body.type}.${field}  JSON key "${json}"  ${at_(dto, fl.n)}  rule ${at_(dto, ann.n)}`);

  // DATA: setter in the handler (or the method it delegates to) → entity → column
  const set = find(e0.file, new RegExp(`(\\w+)\\.set${cap(field)}\\(\\s*\\w+\\.${field}\\(\\)\\s*\\)`));
  const entity = e0.body.type.replace(/(Request|DTO|Dto|Form)$/, '');
  const ent = H.list.find((f) => f.startsWith(e0.svcDir + '/') && f.endsWith(`/${entity}.java`));
  const fieldDecl = ent && find(ent, new RegExp(`\\b${field}\\s*;`));
  const col = fieldDecl && findBack(ent, /@Column\s*\(\s*name\s*=\s*"(\w+)"/, fieldDecl.n);
  const table = ent && find(ent, /@Table\s*\(\s*name\s*=\s*"(\w+)"/);
  const colName = col && col.n >= fieldDecl.n - 2 ? col.m[1] : field.replace(/([A-Z])/g, '_$1').toLowerCase();
  const data = R.items.find((i) => i.kind === 'data' && i.rule === `${field} ${rule}`);
  if (set && ent) out(`   DATA     ${table?.m[1] ?? '?'}.${colName}  ← ${set.text}  ${at_(e0.file, set.n)} → ${entity}.${field} ${at_(ent, fieldDecl.n)}${col && col.n >= fieldDecl.n - 2 ? ` @Column ${at_(ent, col.n)}` : ' (column by naming strategy)'}`);

  // ENTRY POINTS: every place that sends this field
  out(`   ENTRY POINTS — where a person can send ${json}`);
  const callers = new Map();
  for (const i of R.items.filter((i) => i.kind === 'page' && i.rules?.includes(`${field} ${rule}`))) callers.set(i.caller.file + ':' + i.caller.line, i.caller);
  for (const c of callers.values()) {
    const f = c.file;
    const pay = find(f, new RegExp(`^\\s*${json}\\s*:\\s*([\\w.]+(?:\\(\\))?)\\s*,?\\s*$`), c.line - 20, c.line);
    if (!pay) { out(`     ? ${at_(f, c.line)} calls the API but no "${json}:" key was found in its payload — listed, not assumed`); continue; }
    const value = pay.m[1], model = value.replace(/\.trim\(\)$/, ''), payloadTrims = /\.trim\(\)$/.test(value);
    const el = find(f, new RegExp(`v-model((?:\\.\\w+)*)="${model.replace('.', '\\.')}"`));
    const tag = el?.text ?? '';
    const attr = (a) => new RegExp(`\\s${a}(?:="([^"]*)")?[\\s>]`).exec(tag + ' ');
    const id = attr('id')?.[1], type = attr('type')?.[1] ?? 'text', required = !!attr('required'), max = attr(':?max')?.[1], trims = (el?.m[1] ?? '').includes('.trim');
    const label = id && find(f, new RegExp(`<label[^>]*for="${id}"[^>]*>([^<]+)<`));
    const section = el && findBack(f, /<h[1-6][^>]*>([^<]+)<\/h[1-6]>/, el.n);
    const verbPick = find(f, /(\w+)\s*\?\s*'(GET|POST|PUT|PATCH|DELETE)'\s*:\s*'(GET|POST|PUT|PATCH|DELETE)'/, c.line - 5, c.line + 5);
    const routes = R.frontend.pages.get(f) ?? [];
    // which route sends which verb: the ternary's condition is a route param
    const verbOf = (r) => (verbPick ? (r.includes(':' + verbPick.m[1]) ? verbPick.m[2] : verbPick.m[3]) : c.verbs.join('/'));
    for (const r of routes) {
      const verb = verbOf(r);
      if (!eps.some((e) => e.verb === verb)) continue;
      // client guard algebra: can a violating value leave this field?
      let reach;
      if (/Past/.test(rule)) reach = type === 'date' && !max ? ['yes', `type="${type}" with no max — a date after today can be picked`] : max ? ['check', `max=${max} — compare with today`] : ['yes', 'free text'];
      else if (/@Size\(min\s*=\s*1\)|@NotBlank|@NotEmpty/.test(rule)) reach = !required ? ['yes', 'not required — an empty value can be sent']
        : trims ? ['no', `required + v-model.trim — the field is rewritten to "" on change and the browser blocks submit (research/form-guard)`]
        : payloadTrims ? ['yes', `required passes "   ", then the payload trims it to "" (${at_(f, pay.n)})`] : ['no', 'required, and whitespace is sent as-is, which satisfies the rule'];
      else reach = ['check', 'no guard rule for this constraint yet — listed, not assumed'];
      out(`     PAGE     ${r}  ${routeLine(r)}   sends ${verb} (${verbPick ? `${verbPick.m[1]} ? '${verbPick.m[2]}' : '${verbPick.m[3]}' ${at_(f, verbPick.n)}` : 'call'})`);
      if (section) out(`       SECTION  "${section.m[1].trim()}"  ${at_(f, section.n)}`);
      out(`       FIELD    "${label?.m[1].trim() ?? id ?? model}"  <${type}${required ? ' required' : ''}${trims ? ' .trim' : ''}>  ${at_(f, el.n)} → payload ${pay.text}  ${at_(f, pay.n)} → request ${at_(f, c.line)}`);
      out(`       REACH    ${reach[0].toUpperCase()} — ${reach[1]}`);
      if (reach[0] === 'yes') out(`       TEST     ${/Past/.test(rule) ? 'pick a date after today' : 'leave it empty / spaces only'}, save → expect rejection (before this change: saved)`);
      if (reach[0] === 'no') out(`       TEST     none on this field — the browser stops the value before the rule can matter`);
      const after = find(f, /router\.push\(\s*(`[^`]+`|'[^']+')\s*\)/, c.line, c.line + 6);
      if (after) { const to = pageOfLink(linkPattern(after.m[1])); if (to) out(`       JOURNEY  on success → ${to}  ${at_(f, after.n)}; a rejected save never gets there`); }
    }
  }
  for (const i of R.items.filter((i) => i.kind === 'global' && i.rules?.includes(`${field} ${rule}`))) {
    const c = i.caller;
    // the DTO is the type of whatever the caller passes to .body(…)
    const bodyArg = find(c.file, /\.body\(\s*(\w+)\s*\)/, c.line - 1, c.line + 6);
    const argType = bodyArg && findBack(c.file, new RegExp(`(\\w+)\\s+${bodyArg.m[1]}\\s*[,)]`), bodyArg.n + 1)?.m[1];
    const svcRoot = c.file.split('/src/')[0];
    const cdto = argType && H.list.find((f) => f.startsWith(svcRoot + '/') && f.endsWith(`/${argType}.java`));
    const has = cdto && find(cdto, new RegExp(`\\b${json}\\s*[,;)]`));
    out(`     GLOBAL   ${i.id}  → ${c.cls}.${c.method}()  ${at_(c.file, c.line)}`);
    out(`       FIELD    ${cdto ? `${argType}.${json} ${has ? at_(cdto, has.n) : '— absent, so this entry point cannot send it'}  (sent by .body(${bodyArg.m[1]}) ${at_(c.file, bodyArg.n)}; filled in by the model from the conversation)` : '? the type sent by this caller was not found — listed, not assumed'}`);
    if (has) {
      out(`       REACH    YES — no client guard between the model and the API`);
      out(`       TEST     ask the chat to add a pet ${/Past/.test(rule) ? 'born next year' : 'with no name'} → expect a refusal sentence${i.handles4xx === 'throws' ? `, not an error: ${c.method}() has no 4xx handling` : ''}`);
    }
  }

  // READERS: pages that display this field from stored rows
  out(`   READERS — pages that show ${json} from rows already stored`);
  for (const [f, routes] of R.frontend.pages) {
    // The object holding the key must be the entity itself: `pet.name`, not
    // `pet.type.name` or `type.name`. A bare-key join once listed the pet-type
    // dropdown and the Type row as readers of the pet's name.
    const own = entity[0].toLowerCase() + entity.slice(1);
    const shows = L(f).map((t, k) => [t, k + 1]).filter(([t]) => new RegExp(`\\{\\{[^}]*(?<![\\w.])${own}\\.${json}\\b[^}]*\\}\\}`).test(t));
    for (const [t, n] of shows) {
      const label = findBack(f, /<dt[^>]*>([^<]+)<\/dt>|<th[^>]*>([^<]+)<\/th>/, n);
      const section = findBack(f, /<h[1-6][^>]*>([^<]+)<\/h[1-6]>/, n);
      const get = R.frontend.calls.find((x) => x.file === f && x.verbs.includes('GET'));
      out(`     PAGE     ${routes.join(', ')}  ${routeLine(routes[0])}`);
      out(`       SECTION  "${section?.m[1].trim()}"  ${section ? at_(f, section.n) : ''}   FIELD "${(label?.m[1] ?? label?.m[2] ?? json).trim()}"  ${at_(f, n)}  ← GET ${get?.tpl}  ${get ? at_(f, get.line) : ''}  (join on ${own}.${json}: name-level, type proof is Phase B)`);
      if (data) out(`       DATA     rows breaking the rule still display here, but cannot be saved again. Count them: ${data.sql}`);
      for (const k of L(f).map((t2, k2) => [t2, k2 + 1]).filter(([t2]) => /<router-link[^>]*:to="([^"]+)"/.test(t2))) {
        const to = pageOfLink(linkPattern(/:to="([^"]+)"/.exec(k[0])[1]));
        if (!to || !callers.size || ![...callers.values()].some((c) => (R.frontend.pages.get(c.file) ?? []).includes(to))) continue;
        const text = L(f)[k[1]]?.trim();
        out(`       JOURNEY  "${text && !text.startsWith('<') ? text : 'link'}" ${at_(f, k[1])} → ${to}, the form above`);
      }
    }
  }

  out('');
}

// ── once per change: jobs and dashboards ─────────────────────────────────────
if (R.tightened.length) {
const ALL = R.tightened.map((t) => t.ep), E0 = ALL[0];
const ENTITY = E0.body.type.replace(/(Request|DTO|Dto|Form)$/, '');
const ENT = H.list.find((f) => f.startsWith(E0.svcDir + '/') && f.endsWith(`/${ENTITY}.java`));
const TABLE = ENT && find(ENT, /@Table\s*\(\s*name\s*=\s*"(\w+)"/)?.m[1];
out(`━━ across every field above`);
  // JOBS: inventory, then the ones on this path
  const JOB = /@(Scheduled|EventListener|KafkaListener|RabbitListener|JmsListener|SqsListener|TransactionalEventListener)\b/;
  const jobs = H.list.filter((f) => f.endsWith('.java') && !f.includes('/test/')).flatMap((f) => L(f).map((t, k) => [f, t, k + 1]).filter(([, t]) => JOB.test(t)));
  const onPath = jobs.filter(([f]) => new RegExp(`\\b(${ENTITY}|${TABLE ?? '\\0'}|${E0.body.type})\\b`).test(src(f)));
  out(`   JOBS     ${onPath.length ? onPath.map(([f, , n]) => at_(f, n)).join(', ') : 'none on this path'} — inventory: ${jobs.length ? jobs.map(([f, t, n]) => `${JOB.exec(t)[0]} ${at_(f, n)}`).join(', ') : 'no scheduled, listener or queue methods'}; none of them mentions ${ENTITY}, ${TABLE} or ${E0.body.type}`);

  // DASHBOARDS: metric emitters on this path → dashboards that query them
  const boards = H.list.filter((f) => f.endsWith('.json') && /"expr"\s*:/.test(src(f)));
  const timed = find(E0.file, /@Timed\(\s*"([\w.]+)"/);
  const aspect = H.list.find((f) => f.startsWith(E0.svcDir + '/') && /new TimedAspect\(/.test(src(f)));
  const samples = ALL.map((e) => ({ status: '400', uri: e.path, method: e.verb, outcome: 'CLIENT_ERROR' }));
  const matches = (expr) => samples.some((sample) => [...expr.matchAll(/(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].every(([, k, op, v]) => {
    if (!(k in sample)) return true;
    const hit = op.includes('~') ? new RegExp(`^(?:${v})$`).test(sample[k]) : sample[k] === v;
    return op.startsWith('!') ? !hit : hit;
  }));
  for (const b of boards) {
    const doc = JSON.parse(src(b));
    const lines = L(b); let cursor = 0;
    const walk = (ps) => { for (const p of ps ?? []) { for (const t of p.targets ?? []) if (t.expr) {
      const needle = JSON.stringify(t.expr).slice(1, -1);
      const k = lines.findIndex((x, i) => i >= cursor && x.includes(needle)); if (k >= 0) cursor = k + 1;
      const where = `"${p.title}"  ${at_(b, k + 1)}`;
      if (/http_server_requests/.test(t.expr)) {
        out(matches(t.expr)
          ? `   DASHBOARD CHANGES   ${where}  ${t.expr}  — counts the new 400s on ${ALL.map((e) => `${e.verb} ${e.path}`).join(' and ')} (Spring records every request in http.server.requests)`
          : `   DASHBOARD unchanged ${where}  — its filter excludes status 400`);
      } else if (timed && t.expr.includes(timed.m[1].replace(/\./g, '_') + '_seconds')) {
        const m = /method="(\w+)"/.exec(t.expr)?.[1];
        const ours = ALL.find((e) => e.handler.endsWith('.' + m));
        if (ours) out(`   DASHBOARD unchanged ${where}  — @Timed("${timed.m[1]}") ${at_(E0.file, timed.n)} via TimedAspect ${aspect ? at_(aspect, find(aspect, /new TimedAspect\(/).n) : '?'} times ${m}() only when it runs; @Valid rejects before it runs. Name-coupled: renaming ${m}() empties this panel`);
      }
    } walk(p.panels); } };
    walk(doc.panels);
  }
}
