#!/usr/bin/env node
/**
 * Stage 0 bench: score Teslon against truth that did not come from Teslon.
 *
 *   node bench/run.mjs --repo spm=/path/to/clone --repo jhipster-sample-app=/path [case ...]
 *
 * A repo not given with --repo is cloned from the case's URL into a cache
 * directory (TESLON_BENCH_CACHE, default: the OS temp dir). A case with a
 * `mutation` is built as a commit on top of `base` in a throwaway clone, so the
 * repo you pass is never touched.
 *
 * Four numbers per engine, per case:
 *   found         truth items the engine puts in front of a tester
 *   extra         things it asks to test that the truth does not list
 *                 (truth is a lower bound, so these are "unconfirmed", not "wrong")
 *   wrongly-flag  items the truth says to skip that the engine asks to test
 *   silent        truth items missed with no warning: the change behind them is
 *                 neither marked NOT MODELLED in the ledger nor named as not visible
 * plus, for the new engine, how many cited lines survived re-reading at head.
 *
 * The old engine answers in files, so it is scored on the files each truth item
 * lives in (tiers 1-3 count as "asked to test"). That is generous to it: having
 * a page's file in the list is not the same as telling a tester what to do there.
 * It has no ledger, so every miss of the old engine is silent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
const { impact } = await import(join(ROOT, 'packages', 'core', 'dist', 'index.js'));

const args = process.argv.slice(2);
const repos = new Map();
const only = [];
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') { const [k, v] = args[++i].split('='); repos.set(k, resolve(v)); }
  else if (args[i] === '--out') out = args[++i];
  else only.push(args[i]);
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();

function repoFor(c) {
  if (repos.has(c.repo.name)) return repos.get(c.repo.name);
  const cache = join(process.env.TESLON_BENCH_CACHE ?? join(tmpdir(), 'teslon-bench'), c.repo.name);
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true });
    git(cache, 'clone', '-q', '--filter=blob:none', c.repo.url, '.');
  }
  return cache;
}

/** base and head commits, building the head from a mutation when the case has one. */
function prepare(c) {
  const src = repoFor(c);
  if (!c.mutation) return { dir: src, base: c.base, head: c.head, cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), `teslon-bench-${c.id}-`));
  git(dir, 'clone', '-q', '--shared', '--no-checkout', src, '.');
  git(dir, 'checkout', '-q', '--detach', c.base);
  git(dir, 'apply', join(ROOT, c.mutation));
  git(dir, '-c', 'user.email=bench@teslon', '-c', 'user.name=bench', 'commit', '-qam', `mutation: ${c.id}`);
  return { dir, base: git(dir, 'rev-parse', 'HEAD~1'), head: git(dir, 'rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Route and path holes written any way (:id, {id}, *) compare equal. */
const norm = (id) => id.replace(/:\w+|\{[^}]*\}|(?<=\/)\*(?=\/|$)/g, '{}').replace(/\/$/, '');
const same = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function scoreNew(c, r) {
  const claims = new Map(); // surface|field -> case
  for (const k of r.cases) if (k.tier !== 'skip') claims.set(`${norm(k.surface)}|${(k.field ?? '').toLowerCase()}`, k);
  for (const s of r.surfaces) if (s.tier !== 'skip' && !r.cases.some((k) => k.surface === s.id && k.tier !== 'skip')) claims.set(`${norm(s.id)}|`, s);
  const hit = (t) => [...claims.keys()].some((k) => { const [s, f] = k.split('|'); return s === norm(t.id) && (!t.field || same(f, t.field)); });
  const found = c.test.filter(hit);
  const missed = c.test.filter((t) => !hit(t));
  // worse than a miss: the engine says, with evidence, that a truth item needs no test
  const skippedAs = (t) => r.surfaces.some((s) => s.tier === 'skip' && norm(s.id) === norm(t.id))
    || r.cases.some((k) => k.tier === 'skip' && norm(k.surface) === norm(t.id) && t.field && same(k.field, t.field));
  const wrongSkips = missed.filter(skippedAs);
  const flagged = new Set([...r.ledger.filter((l) => l.status === 'not-modelled').map((l) => l.file)]);
  const unseenText = r.unseen.map((u) => `${u.what} ${u.why}`).join('\n');
  const warned = c.cause.some((f) => flagged.has(f) || unseenText.includes(f.split('/').pop()));
  const silent = warned ? [] : missed;
  const truthKeys = (t) => (k) => { const [s, f] = k.split('|'); return s === norm(t.id) && (!t.field || !f || same(f, t.field)); };
  const extra = [...claims.keys()].filter((k) => !c.test.some((t) => truthKeys(t)(k)));
  const wrong = c.skip.filter((t) => [...claims.keys()].some((k) => { const [s, f] = k.split('|'); return s === norm(t.id) && (t.field ? same(f, t.field) : true) && !(t.field === undefined && c.test.some((x) => norm(x.id) === s)); }));
  return {
    found: found.length, total: c.test.length, missed: missed.map(label), extra: extra.map((k) => k.replace('|', ' › ')), claims: claims.size,
    wrong: wrong.map(label), silent: silent.map(label), warned, wrongSkips: wrongSkips.map(label),
    evidence: `${r.verification.hops - r.verification.failed.length}/${r.verification.hops}`,
    ms: r.ms,
  };
}

function scoreOld(c, result) {
  const asked = new Set((result?.priority ?? []).filter((p) => p.tier <= 3).map((p) => p.file));
  const eyes = (result?.priority ?? []).filter((p) => p.tier === 4).length;
  const hit = (t) => (t.files ?? []).some((f) => asked.has(f));
  const found = c.test.filter(hit);
  const truthFiles = new Set(c.test.flatMap((t) => t.files ?? []));
  return {
    found: found.length, total: c.test.length, missed: c.test.filter((t) => !hit(t)).map(label),
    extra: [...asked].filter((f) => !truthFiles.has(f) && !c.cause.includes(f)), claims: asked.size, eyes,
    silent: c.test.filter((t) => !hit(t)).map(label),
  };
}

const label = (t) => `${t.id}${t.field ? ` › ${t.field}` : ''}${t.hole ? ' (hole)' : ''}`;

function runOld(dir, base, head) {
  const p = spawnSync('node', [CLI, 'merged', head, `${base}..${head}`, '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TESLON_ROOT: dir }, maxBuffer: 512 * 1024 * 1024 });
  const i = p.stdout.indexOf('{');
  try { return i >= 0 ? JSON.parse(p.stdout.slice(i)) : null; } catch { return null; }
}

const files = readdirSync(join(HERE, 'cases')).filter((f) => f.endsWith('.json')).sort();
const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };
const totals = { new: { found: 0, total: 0, silent: 0, extra: 0, claims: 0, wrong: 0, wrongSkips: 0 }, old: { found: 0, total: 0, silent: 0, extra: 0, claims: 0 } };

for (const f of files) {
  const c = JSON.parse(readFileSync(join(HERE, 'cases', f), 'utf8'));
  if (only.length && !only.includes(c.id)) continue;
  const p = prepare(c);
  try {
    const r = impact({ repo: p.dir, base: p.base, head: p.head, ...(c.today ? { today: c.today } : {}) });
    const n = scoreNew(c, r);
    const o = scoreOld(c, runOld(p.dir, p.base, p.head));
    for (const [k, v] of Object.entries({ found: n.found, total: n.total, silent: n.silent.length, extra: n.extra.length, claims: n.claims, wrong: n.wrong.length, wrongSkips: n.wrongSkips.length })) totals.new[k] += v;
    for (const [k, v] of Object.entries({ found: o.found, total: o.total, silent: o.silent.length, extra: o.extra.length, claims: o.claims })) totals.old[k] += v;
    log(`## ${c.id}: ${c.title}`);
    log('');
    log('| | found | silent misses | wrongly skipped | extra claims | wrongly flagged | evidence re-read |');
    log('|---|---|---|---|---|---|---|');
    log(`| new engine | ${n.found}/${n.total} | ${n.silent.length} | ${n.wrongSkips.length} | ${n.extra.length} of ${n.claims} | ${n.wrong.length} | ${n.evidence} |`);
    log(`| old engine | ${o.found}/${o.total} | ${o.silent.length} | n/a | ${o.extra.length} of ${o.claims} files (+${o.eyes} "could not rule out") | n/a | n/a |`);
    log('');
    if (n.missed.length) log(`New engine missed${n.warned ? ' (with a warning: the cause is in the ledger as NOT MODELLED)' : ' SILENTLY'}: ${n.missed.join('; ')}`);
    if (n.extra.length) log(`New engine also asks for (not in truth): ${n.extra.join('; ')}`);
    if (n.wrongSkips.length) log(`New engine SKIPPED, with evidence, what truth says to test: ${n.wrongSkips.join('; ')}`);
    if (n.wrong.length) log(`New engine asks to test what truth says to skip: ${n.wrong.join('; ')}`);
    if (o.missed.length) log(`Old engine missed: ${o.missed.join('; ')}`);
    log('');
  } finally {
    p.cleanup();
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
log('## All cases');
log('');
log('| | found | silent misses | wrongly skipped | extra claims |');
log('|---|---|---|---|---|');
log(`| new engine | ${totals.new.found}/${totals.new.total} (${pct(totals.new.found, totals.new.total)}) | ${totals.new.silent} | ${totals.new.wrongSkips} | ${totals.new.extra} of ${totals.new.claims} |`);
log(`| old engine | ${totals.old.found}/${totals.old.total} (${pct(totals.old.found, totals.old.total)}) | ${totals.old.silent} | n/a | ${totals.old.extra} of ${totals.old.claims} files |`);
if (out) writeFileSync(out, lines.join('\n') + '\n');
// a silent miss, or a skip of something that changed, is what the product promises never to give
if (totals.new.silent || totals.new.wrongSkips) process.exitCode = 1;
