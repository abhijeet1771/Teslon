#!/usr/bin/env node
/**
 * Run the probe catalog and score it against the perfection rules
 * (research/PERFECTION-RULES-2026-11-04.md).
 *
 *   node bench/probes/run.mjs [--json out.json] [--md out.md] [probe-id ...]
 *
 * Each probe copies OrderDesk, commits its base, applies the PR and runs the
 * engine on the two commits. Trust and completeness misses exit 1; precision
 * is reported, not failed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { impact, brief } from '../../packages/core/dist/index.js';
import * as orderdesk from './catalog.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'fixtures/orderdesk');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const outJson = flag('--json');
const outMd = flag('--md');
// --app spm=<clone>: probes on a real app, from its own catalog, with the clone's HEAD as the base
const app = flag('--app');
const [appName, appPath] = app ? [app.split('=')[0], app.split('=')[1] ?? null] : ['orderdesk', null];
const { probes, SCREENS, APP: appDir } = appName === 'orderdesk' ? orderdesk : await import(`./catalog-${appName}.mjs`);
// a catalog on another fixture in this repository names it: --app shopflow
const APP_DIR = appDir ? join(ROOT, appDir) : APP;
const grep = flag('--grep');
const only = new Set(args);
const ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim();
const tools = (d) => ({
  read: (f) => readFileSync(join(d, f), 'utf8'),
  write: (f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); },
  rm: (f) => unlinkSync(join(d, f)),
  edit: (f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); if (!t.includes(from)) throw new Error(`${f}: edit does not apply: ${from.slice(0, 60)}`); writeFileSync(join(d, f), t.replace(from, to)); },
});

const TRUST = new Set(['SILENT', 'WRONG SKIP', 'NOT SAID', 'EVIDENCE', 'CRASH', 'NO ANSWER', 'NOISE']);

function score(p, r) {
  const out = [];
  const bad = (kind, msg) => out.push({ kind, msg });
  const b = brief(r);
  const state = (id) => b.areas.find((a) => a.id === id)?.state ?? 'absent';
  const said = [...r.unseen.map((u) => `${u.what} ${u.why}`), ...b.areas.map((a) => `${a.name} ${a.why ?? ''}`), ...r.cases.map((c) => `${c.do} ${c.expect}`), ...r.deltas.map((d) => d.title)].join('\n');
  const t = p.truth;
  if (r.verification.failed.length) bad('EVIDENCE', `${r.verification.failed.length} citations did not re-check: ${r.verification.failed.slice(0, 2).map((h) => `${h.file}:${h.line}`).join(', ')}`);
  // C2: every screen has one answer whenever the app changes
  if (r.triage.appEffect !== 'none') for (const s of SCREENS) if (state(`screen:${s}`) === 'absent') bad('NO ANSWER', `screen:${s} is neither listed, skipped nor held`);
  const reached = (id, mustTest) => {
    const s = state(id);
    if (s === 'absent') { bad('SILENT', `${id} is not in the brief`); return; }
    if (s === 'skip') { bad('WRONG SKIP', `${id} was called safe: ${b.areas.find((a) => a.id === id)?.why ?? ''}`); return; }
    if (mustTest && s !== 'test') bad('IMPRECISE', `${id} is ${s}, truth says test`);
  };
  for (const id of t.test ?? []) reached(id, true);
  for (const id of t.reach ?? []) reached(id, false);
  if (t.every) {
    const all = state('screen:*') === 'test' || SCREENS.every((s) => state(`screen:${s}`) === 'test');
    if (!all) { if (SCREENS.some((s) => state(`screen:${s}`) === 'skip')) bad('WRONG SKIP', `every screen is reached, but ${SCREENS.filter((s) => state(`screen:${s}`) === 'skip').join(', ')} were called safe`); else if (SCREENS.every((s) => ['test', 'unclear'].includes(state(`screen:${s}`)))) bad('IMPRECISE', 'every screen is reached; they are held as unclear, not listed to test'); else bad('SILENT', 'every screen is reached'); }
  }
  for (const id of t.notSkip === '*' ? SCREENS.map((s) => `screen:${s}`) : t.notSkip ?? []) if (state(id) === 'skip') bad('WRONG SKIP', `${id} was called safe`);
  for (const re of t.say ?? []) if (!re.test(said)) bad('NOT SAID', `nothing says ${re}`);
  if (t.nothing && (r.triage.appEffect !== 'none' || b.test)) bad('NOISE', `no runtime effect, but ${b.test} areas to test (${r.triage.summary})`);
  // precision: screens to test or held that the truth does not name
  const named = new Set([...(t.test ?? []), ...(t.reach ?? []), ...(t.notSkip === '*' ? [] : t.notSkip ?? [])]);
  const screensOf = (st) => SCREENS.filter((s) => state(`screen:${s}`) === st && !named.has(`screen:${s}`) && !t.every);
  const extra = screensOf('test');
  const held = t.notSkip === '*' ? [] : screensOf('unclear');
  for (const id of t.quiet ?? []) if (state(id) === 'test') bad('LOUD', `${id} is listed to test, but nothing a user sees changes there`);
  return { fails: out, extra, held, verdict: `T${b.test} S${b.skip} U${b.unclear} · ${b.confidence.title}` };
}

const rows = [];
for (const p of probes) {
  if (only.size && !only.has(p.id)) continue;
  if (grep && !new RegExp(grep).test(p.id)) continue;
  const d = mkdtempSync(join(tmpdir(), `probe-${p.id}-`));
  const t0 = Date.now();
  let res;
  try {
    if (appPath) { rmSync(d, { recursive: true, force: true }); git(tmpdir(), 'clone', '-q', '--shared', appPath, d); }
    else { cpSync(APP_DIR, d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); }
    git(d, 'config', 'user.email', 'dev@orderdesk.example'); git(d, 'config', 'user.name', 'Dev'); git(d, 'config', 'commit.gpgsign', 'false');
    p.base?.(tools(d));
    git(d, 'add', '-A'); if (git(d, 'status', '--porcelain')) git(d, 'commit', '-qm', 'base'); const base = git(d, 'rev-parse', 'HEAD');
    p.apply(tools(d));
    git(d, 'add', '-A'); git(d, 'commit', '-qm', p.title); const head = git(d, 'rev-parse', 'HEAD');
    const r = impact({ repo: d, base, head });
    res = { ...score(p, r), ms: Date.now() - t0 };
  } catch (e) {
    res = { fails: [{ kind: 'CRASH', msg: String(e.stack ?? e).split('\n').slice(0, 3).join(' | ') }], extra: [], held: [], verdict: 'crashed', ms: Date.now() - t0 };
  } finally { rmSync(d, { recursive: true, force: true }); }
  const trust = res.fails.filter((f) => TRUST.has(f.kind));
  rows.push({ id: p.id, logic: p.logic, title: p.title, ...res, trust: trust.length });
  console.log(`${trust.length ? '✗' : res.fails.length ? '~' : '✓'} ${p.id.padEnd(26)} ${String(res.ms).padStart(5)} ms  ${res.verdict}${res.extra.length ? `  +${res.extra.length} extra` : ''}${res.held.length ? `  ${res.held.length} held` : ''}`);
  for (const f of res.fails) console.log(`     ${f.kind}: ${f.msg}`);
}

const trustFails = rows.reduce((n, r) => n + r.trust, 0);
const imprecise = rows.filter((r) => r.fails.some((f) => !TRUST.has(f.kind))).length;
const screens = rows.length * SCREENS.length;
const extra = rows.reduce((n, r) => n + r.extra.length, 0);
const held = rows.reduce((n, r) => n + r.held.length, 0);
const logic = [...new Set(rows.flatMap((r) => r.logic))].sort();
const summary = `${rows.length} probes · ${rows.filter((r) => !r.trust).length} trusted · ${trustFails} trust failures · ${imprecise} imprecise · extra screens ${(100 * extra / screens).toFixed(1)}% (P1 ≤ 5%) · held screens ${(100 * held / screens).toFixed(1)}% (P2 ≤ 10%) · ${logic.length} logic units covered · slowest ${Math.max(...rows.map((r) => r.ms))} ms`;
console.log(`\n${summary}`);
if (outJson) writeFileSync(outJson, JSON.stringify({ summary, rows }, null, 2));
if (outMd) {
  const L = [`# Probe catalog: ${appName}`, '', summary, '', '| probe | logic | Teslon said | result |', '|---|---|---|---|'];
  for (const r of rows) L.push(`| ${r.id}: ${r.title} | ${r.logic.join(', ')} | ${r.verdict}${r.extra.length ? ` · +${r.extra.length} extra` : ''}${r.held.length ? ` · ${r.held.length} held` : ''} | ${r.fails.length ? r.fails.map((f) => `**${f.kind}** ${f.msg.replace(/\|/g, '\\|')}`).join('<br>') : '✓'} |`);
  writeFileSync(outMd, L.join('\n') + '\n');
}
process.exitCode = trustFails ? 1 : 0;
