// Ticket gap report: what QA was told to test vs what the merged code reaches.
//
//   node gap.mjs <repo> <ticket.json> [base] [head]
//
// The told scope is mapped to surfaces by rules only (paths, handler names,
// field names, component names) — never by guessing. Anything a rule cannot
// map is printed as UNMAPPED for a person to confirm, not silently dropped.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { impact } from '../page-impact/run.mjs';

const [repo, ticketPath, baseArg, headArg] = process.argv.slice(2);
const T = JSON.parse(readFileSync(ticketPath, 'utf8'));
const base = baseArg ?? T.merged.base, head = headArg ?? T.merged.head;
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const R = impact(repo, base, head, () => {});

// ── 1. which commits are this ticket ────────────────────────────────────────
const key = T.ticket.replace('#', '');
const commits = git('log', '--format=%h%x09%s%x09%b%x1e', `${base}..${head}`).split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => s.split('\t'));
const keyed = commits.filter(([, s, b]) => new RegExp(`(#|[A-Z]+-)${key}\\b`).test(`${s} ${b}`));
const link = keyed.length === commits.length
  ? `every commit carries ${T.ticket}`
  : `${keyed.length}/${commits.length} commits carry ${T.ticket} (${T.merged.how}); the rest are linked through ${T.pr} as given — a merge without the key in it is the commonest way a ticket loses code`;

// ── 2. told scope → surfaces, by rule ───────────────────────────────────────
const norm = (p) => p.replace(/\{[^}]+\}|\*/g, '*').replace(/\/$/, '');
const camelWords = (s) => s.replace(/\.\w+$/, '').replace(/Page$/, '').split(/(?=[A-Z])/).map((w) => w.toLowerCase());
const eps = R.items.filter((i) => i.kind === 'endpoint');
const epByHandler = new Map(eps.map((e) => [e.evidence[0].split(' ')[0].split('.').pop(), e]));
const told = [], unmapped = [];
const fieldOf = (rule) => rule.split(' ')[0];
for (const sentence of T.told) {
  const low = sentence.toLowerCase();
  const hits = [];
  for (const m of sentence.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/g)) {
    const e = eps.find((x) => x.endpoint.split(' ')[1] === m[1] && norm(x.internal) === norm(m[2]));
    if (e) hits.push({ ep: e, how: `path ${m[1]} ${m[2]}` });
    else unmapped.push(`${m[1]} ${m[2]} — told, but no endpoint changed by this merge serves it`);
  }
  for (const [h, e] of epByHandler) if (sentence.includes(h)) hits.push({ ep: e, how: `handler ${h}()` });
  // a rule is told when its field is named in the same sentence as its endpoint,
  // or the sentence names a field and the endpoints come from the sentence before
  const fields = new Set(eps.flatMap((e) => e.rules.map(fieldOf)).filter((f) => low.includes(f.toLowerCase()) || low.includes(f.replace(/([A-Z])/g, ' $1').toLowerCase())));
  const scope = hits.length ? hits : (told.at(-1)?.hits ?? []);
  for (const h of scope) for (const r of h.ep.rules) if (fields.has(fieldOf(r))) told.push({ kind: 'rule', id: `${h.ep.id}  ${r}`, how: h.how, hits });
  for (const h of hits) told.push({ kind: 'endpoint', id: h.ep.id, how: h.how, hits });
  // UI: a page is told when its component's name appears as a phrase ("pet form"
  // names PetFormPage). Paths are removed first: "{ownerId} … form" once named
  // OwnerFormPage from two unrelated words, which made an untold page "told".
  const prose = low.replace(/\/\S+/g, ' ');
  for (const [file, routes] of R.frontend.pages) {
    const words = camelWords(file.split('/').pop());
    if (words.length > 1 && new RegExp(`\\b${words.join('\\s+')}\\b`).test(prose)) for (const r of routes) told.push({ kind: 'page', id: r, how: `"${words.join(' ')}" names ${file.split('/').pop()}`, hits });
  }
  const tracked = [...sentence.matchAll(/#(\d+)/g)].map((m) => '#' + m[1]).filter((t) => t !== T.ticket && t !== T.pr);
  if (tracked.length) told.push({ kind: 'known-gap', id: tracked.join(', '), how: sentence, hits });
}

// ── 3. true impact, from the merged code ────────────────────────────────────
const truth = [];
for (const e of eps) for (const r of e.rules) truth.push({ kind: 'rule', id: `${e.id}  ${r}`, ev: [...e.evidence, e.validAdded ? '@Valid added in this merge, so every rule on the body is newly enforced — not just the one the ticket is about' : `rule added in this merge`] });
for (const e of eps) truth.push({ kind: 'endpoint', id: e.id, ev: e.evidence });
const pageIds = new Set();
for (const i of R.items.filter((i) => i.kind === 'page' || i.kind === 'global')) {
  if (pageIds.has(i.id + i.endpoint)) continue; pageIds.add(i.id + i.endpoint);
  const old = truth.find((t) => t.kind === i.kind && t.id === i.id);
  if (old) { old.ev.push('— and via ' + i.endpoint); continue; }
  truth.push({ kind: i.kind, id: i.id, ev: [...i.evidence], check: i.handles4xx === 'throws' ? `${i.caller.cls}.${i.caller.method}() uses .retrieve() with no onStatus/catch: a 400 now becomes an exception inside the chat — ask it to add a pet born next year and check the reply is a sentence, not an error` : null });
}
for (const d of R.items.filter((i) => i.kind === 'data')) truth.push({ kind: 'data', id: d.id, ev: d.evidence, check: `rows already breaking "${d.rule}" can no longer be saved from Edit Pet. Run on a prod copy: ${d.sql}` });

const toldIds = new Set(told.map((t) => t.kind + t.id));
const confirmed = truth.filter((t) => toldIds.has(t.kind + t.id));
const missed = truth.filter((t) => !toldIds.has(t.kind + t.id));
const truthIds = new Set(truth.map((t) => t.kind + t.id));
const notReached = told.filter((t) => t.kind !== 'known-gap' && !truthIds.has(t.kind + t.id));
const affectedPages = new Set(truth.filter((t) => t.kind === 'page').map((t) => t.id));
const quiet = [...R.frontend.pages].flatMap(([f, rs]) => rs.map((r) => [r, f])).filter(([r]) => !affectedPages.has(r));

// ── 4. report ───────────────────────────────────────────────────────────────
const out = console.log;
out(`TICKET GAP  ${T.ticket} → ${T.pr}  (${T.repo}, ${base}..${head})`);
out(`linked: ${link}\n`);
out(`TOLD AND CONFIRMED BY CODE (${confirmed.length})`);
for (const t of confirmed) out(`  ✓ ${t.kind.padEnd(8)} ${t.id}   ← told as ${told.find((x) => x.kind + x.id === t.kind + t.id).how}`);
out(`\nMISSED — the merge reaches these, nobody told QA (${missed.length})`);
for (const t of missed) {
  out(`  ✗ ${t.kind.toUpperCase().padEnd(8)} ${t.id}`);
  for (const e of t.ev) out(`      · ${e}`);
  if (t.check) out(`      → verify: ${t.check}`);
}
out(`\nTOLD BUT NOT IN THIS MERGE (${notReached.length + unmapped.length})${notReached.length + unmapped.length ? '  ← red flag: a PR or repo is missing from the ticket' : '  — every told item is backed by code in the merge'}`);
for (const t of notReached) out(`  ? ${t.kind} ${t.id}`);
for (const u of unmapped) out(`  ? ${u}`);
const gaps = told.filter((t) => t.kind === 'known-gap');
if (gaps.length) {
  out(`\nKNOWN GAPS NAMED IN THE TICKET`);
  for (const g of gaps) out(`  ! ${g.id}: ${g.how}\n      the pages above now receive 400s and hand them to reportError(); what the user actually sees is ${g.id}'s territory — record it, don't fail this ticket on it`);
}
out(`\nNO PATH FOUND (${quiet.length} pages)  — no changed contract reaches them; reads of a pet are excluded because a request rule cannot change a response`);
out('  ' + quiet.map(([r]) => r).join('   '));
out(`\nverdict: QA was told ${confirmed.length}/${truth.length} of what this merge changes. At least these, never only these.`);
