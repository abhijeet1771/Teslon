#!/usr/bin/env node
/**
 * Runs every OrderDesk scenario the way it runs for real: a PR branch on an
 * "origin" with GitHub's refs (refs/pull/N/head, refs/pull/N/merge), a fresh
 * clone with full history as actions/checkout makes it, then `teslon pr N`
 * with no GitHub token. Each result is scored against the hand-written truth.
 *
 *   node bench/proving-ground/run.mjs [--out file.md] [--json file.json] [scenario-id ...]
 *
 * Exit 1 when any trust failure is found: a silent miss, a wrong skip, a false
 * alarm, noise on a change with no app effect, a wrong commit range, unsafe
 * output, or evidence that does not re-check.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios, SCREENS } from './scenarios.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'fixtures/orderdesk');
const CLI = join(ROOT, 'packages/cli/dist/cli.js');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const outMd = flag('--out');
const outJson = flag('--json');
const only = new Set(args);

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|GH_TOKEN|TESLON_)/.test(k))), GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim();

function originWithApp(dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(APP, dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dev@orderdesk.example'); git(dir, 'config', 'user.name', 'Dev'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'OrderDesk 1.4');
}
function tools(dir) {
  return {
    read: (f) => readFileSync(join(dir, f), 'utf8'),
    write: (f, c) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); },
    rm: (f) => unlinkSync(join(dir, f)),
    files: () => git(dir, 'ls-files').split('\n'),
    edit: (f, from, to) => {
      const t = readFileSync(join(dir, f), 'utf8');
      if (!t.includes(from)) throw new Error(`scenario edit does not apply to ${f}: ${from.slice(0, 60)}`);
      writeFileSync(join(dir, f), t.replace(from, to));
    },
  };
}
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); };

/** Build origin + clone for one scenario and one way of landing it; returns the clone and the PR number. */
function stage(sc, work, how) {
  const origin = join(work, 'origin');
  originWithApp(origin);
  const n = 100 + scenarios.indexOf(sc);
  git(origin, 'checkout', '-qb', `pr/${sc.id}`);
  sc.apply(tools(origin)); commit(origin, `${sc.title}\n\n${sc.says}`);
  if (sc.apply2) { sc.apply2(tools(origin)); commit(origin, `${sc.title} (2)`); }
  git(origin, 'update-ref', `refs/pull/${n}/head`, 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  if (sc.mainMovesWith) { sc.mainMovesWith(tools(origin)); commit(origin, 'Unrelated work merged meanwhile'); }
  if (how === 'open') {
    // what GitHub keeps at refs/pull/N/merge: the PR merged into today's main
    git(origin, 'checkout', '-q', '--detach', 'main');
    git(origin, 'merge', '-q', '--no-ff', '-m', `Merge ${sc.id} into main`, `pr/${sc.id}`);
    git(origin, 'update-ref', `refs/pull/${n}/merge`, 'HEAD');
    git(origin, 'checkout', '-q', 'main');
  } else {
    // landed on main, three ways
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'Someone else\'s change before the merge');
    if (how === 'merge-commit') git(origin, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, `pr/${sc.id}`);
    if (how === 'squash') { git(origin, 'merge', '-q', '--squash', `pr/${sc.id}`); git(origin, 'commit', '-qm', `${sc.title} (#${n})`); }
    if (how === 'rebase') for (const c of git(origin, 'rev-list', '--reverse', `main..pr/${sc.id}`).split('\n')) git(origin, 'cherry-pick', '--allow-empty', c);
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'Work merged after this PR');
  }
  const clone = join(work, 'clone');
  git(work, 'clone', '-q', origin, clone);
  return { clone, n };
}

function run(clone, n, out) {
  const t = Date.now();
  const p = spawnSync('node', [CLI, 'pr', String(n), '--out', out], { cwd: clone, env: ENV, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ms = Date.now() - t;
  if (p.status !== 0 && p.status !== 3) return { error: `exit ${p.status}: ${(p.stderr || p.stdout).slice(-400)}`, ms };
  return { r: JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')), comment: readFileSync(join(out, 'comment.md'), 'utf8'), html: readFileSync(join(out, 'report.html'), 'utf8'), stdout: p.stdout, ms, exit: p.status };
}

const TRUST = new Set(['SILENT MISS', 'WRONG SKIP', 'FALSE ALARM', 'NOISE', 'WRONG RANGE', 'UNSAFE OUTPUT', 'EVIDENCE', 'CRASH', 'NOT SAID']);

function score(sc, res) {
  const out = [];
  const bad = (kind, msg) => out.push({ kind, msg });
  if (res.error) { bad('CRASH', res.error); return out; }
  const { r, comment, html, ms } = res;
  const surf = (id) => r.surfaces.find((s) => s.id === id);
  const cases = (id) => r.cases.filter((c) => c.surface === id);
  const unseenText = r.unseen.map((u) => `${u.what} ${u.why} ${(u.files ?? []).join(' ')}`).join('\n');
  const every = () => r.surfaces.some((s) => s.tier !== 'skip' && (s.id === 'screen:*' || /every screen/i.test(`${s.where} ${s.name}`))) || SCREENS.every((p) => { const s = surf(`screen:${p}`); return s && s.tier !== 'skip'; });
  const req = sc.required ?? {};
  if (r.verification.failed.length) bad('EVIDENCE', `${r.verification.failed.length} cited lines did not re-check: ${r.verification.failed.slice(0, 2).map((h) => `${h.file}:${h.line}`).join(', ')}`);
  for (const f of req.find ?? []) {
    if (f.every) { if (!every()) bad(/every screen|all screens/i.test(unseenText) ? 'WARNED MISS' : 'SILENT MISS', 'every screen should be in the brief'); continue; }
    const s = surf(f.s);
    if (!s) {
      if (f.orUnseen && f.orUnseen.test(unseenText)) continue;
      const route = f.s.replace(/^screen:/, '');
      bad(unseenText.includes(route) ? 'WARNED MISS' : 'SILENT MISS', `${f.s} is not in the brief`);
      continue;
    }
    if (s.tier === 'skip') { bad('WRONG SKIP', `${f.s} was called safe to skip: ${s.reason}`); continue; }
    if (f.tier && s.tier !== f.tier) bad('IMPRECISE', `${f.s} is ${s.tier}, truth says ${f.tier}`);
    if (f.field && !cases(f.s).some((c) => f.field.test(c.field ?? '') || f.field.test(c.do))) bad('IMPRECISE', `${f.s} does not name the field ${f.field}`);
    if (f.expect && !cases(f.s).some((c) => f.expect.test(c.expect))) bad('IMPRECISE', `${f.s} does not say ${f.expect}`);
  }
  // every screen gets exactly one answer when the app changes: listed, skipped with proof, or held as unclear; never dropped
  if (r.triage.appEffect !== 'none') {
    const held = new Set((r.held ?? []).map((h) => h.id));
    for (const p of SCREENS) { const id = `screen:${p}`; if (!surf(id) && !held.has(id)) bad('SILENT MISS', `${id} has no answer: not listed, not skipped, not held`); }
  }
  const notSkip = req.notSkip === '*' ? SCREENS.map((p) => `screen:${p}`) : req.notSkip ?? [];
  for (const id of notSkip) { const s = surf(id); if (s?.tier === 'skip') bad('WRONG SKIP', `${id} was called safe to skip: ${s.reason}`); }
  for (const a of req.noAlarm ?? []) { const c = cases(a.s).find((x) => a.expect.test(`${x.expect} ${x.do}`)); if (c) bad('FALSE ALARM', `${a.s}: "${c.expect.slice(0, 120)}"`); }
  if (req.nothing) { const n = r.cases.filter((c) => c.tier !== 'skip').length; if (r.triage.appEffect !== 'none' || n) bad('NOISE', `nothing changes in the app, but ${n} cases (${r.triage.appEffect}): ${r.triage.summary}`); }
  for (const u of req.unseen ?? []) if (!u.test(unseenText)) bad('NOT SAID', `"could not see" does not mention ${u}`);
  if (req.ledgerOnly) { const files = r.ledger.map((l) => l.file).sort(); if (files.join() !== [...req.ledgerOnly].sort().join()) bad('WRONG RANGE', `files read as this PR: ${files.join(', ')}`); }
  if (req.inert) {
    if (/(^|[^`\w])@everyone/.test(comment)) bad('UNSAFE OUTPUT', 'the comment would ping @everyone');
    // a link needs an unescaped [ … ]: \[click\](javascript:…) is text
    if (/(?<!\\)\[[^\]]*(?<!\\)\]\(\s*javascript:/i.test(comment)) bad('UNSAFE OUTPUT', 'the comment has a javascript: link');
    if (/<img\b|<script\b|<iframe\b/i.test(comment.replace(/`[^`]*`/g, ''))) bad('UNSAFE OUTPUT', 'the comment has raw HTML from the repository');
    if (/<img src=x/i.test(html)) bad('UNSAFE OUTPUT', 'the cockpit has raw HTML from the repository');
  }
  if (comment.length > 60000) bad('UNSAFE OUTPUT', `comment is ${comment.length} characters`);
  if (req.maxMs && ms > req.maxMs) bad('SLOW', `${ms} ms`);
  return out;
}

function ideal(sc, res) {
  if (res.error || !sc.ideal) return [];
  const { r } = res;
  const surf = (id) => r.surfaces.find((s) => s.id === id);
  const cases = (id) => r.cases.filter((c) => c.surface === id);
  return sc.ideal.map((i) => {
    if (i.formattingIsNoEffect) { const f = r.ledger.filter((l) => l.file.endsWith('.java') && !l.file.endsWith('Product.java') && !/(^|\/)src\/test\//.test(l.file)); return { i: 'formatting-only files have no app effect', ok: f.length > 0 && f.every((l) => l.status === 'no-runtime-effect') }; }
    const s = surf(i.s);
    if (i.absent) return { i: `${i.s} not claimed`, ok: !s || s.tier === 'skip' };
    const ok = !!s && (!i.tier || s.tier === i.tier) && (!i.field || cases(i.s).some((c) => i.field.test(c.field ?? '') || i.field.test(c.do))) && (!i.expect || cases(i.s).some((c) => i.expect.test(c.expect)));
    return { i: `${i.s}${i.field ? ` field ${i.field}` : ''}${i.tier ? ` ${i.tier}` : ''}${i.expect ? ` says ${i.expect}` : ''}`, ok };
  });
}

const rows = [];
for (const sc of scenarios) {
  if (only.size && !only.has(sc.id)) continue;
  const ways = sc.flow === 'merged' ? ['merge-commit', 'squash', 'rebase'] : ['open'];
  for (const how of ways) {
    const work = mkdtempSync(join(tmpdir(), `pg-${sc.id}-`));
    let res;
    try {
      const { clone, n } = stage(sc, work, how);
      res = run(clone, n, join(work, 'out'));
    } catch (e) { res = { error: String(e.message ?? e).slice(0, 400), ms: 0 }; }
    const fails = score(sc, res);
    const ideals = ideal(sc, res);
    rows.push({ id: sc.id + (ways.length > 1 ? ` (${how})` : ''), title: sc.title, ms: res.ms, fails, ideals, verdict: res.r ? `${res.r.surfaces.filter((s) => s.tier !== 'skip').length} to test · ${res.r.surfaces.filter((s) => s.tier === 'skip').length} skip · ${res.r.unseen.length} unseen · ${res.r.triage.appEffect}` : 'crashed' });
    const trust = fails.filter((f) => TRUST.has(f.kind));
    console.log(`${trust.length ? '✗' : fails.length ? '~' : '✓'} ${rows.at(-1).id.padEnd(36)} ${String(res.ms).padStart(6)} ms  ${rows.at(-1).verdict}`);
    for (const f of fails) console.log(`     ${TRUST.has(f.kind) ? '✗' : '~'} ${f.kind}: ${f.msg}`);
    for (const i of ideals) if (!i.ok) console.log(`     · ideal not met: ${i.i}`);
    if (!process.env.KEEP) rmSync(work, { recursive: true, force: true }); else console.log(`     kept ${work}`);
  }
}
const trustFails = rows.flatMap((r) => r.fails.filter((f) => TRUST.has(f.kind)));
const other = rows.flatMap((r) => r.fails.filter((f) => !TRUST.has(f.kind)));
const idealAll = rows.flatMap((r) => r.ideals);
const summary = `${rows.length} runs · ${rows.filter((r) => !r.fails.some((f) => TRUST.has(f.kind))).length} trusted · ${trustFails.length} trust failures · ${other.length} imprecise · ideal ${idealAll.filter((i) => i.ok).length}/${idealAll.length}`;
console.log(`\n${summary}`);
if (outJson) writeFileSync(outJson, JSON.stringify(rows, null, 2));
if (outMd) {
  const L = ['# OrderDesk proving ground', '', summary, '', '| scenario | ms | Teslon said | result |', '|---|---|---|---|'];
  for (const r of rows) L.push(`| ${r.id}: ${r.title} | ${r.ms} | ${r.verdict} | ${r.fails.length ? r.fails.map((f) => `${TRUST.has(f.kind) ? '✗' : '~'} ${f.kind}: ${f.msg.replace(/\|/g, '\\|')}`).join('<br>') : '✓'}${r.ideals.filter((i) => !i.ok).map((i) => `<br>· ideal not met: ${i.i.replace(/\|/g, '\\|')}`).join('')} |`);
  writeFileSync(outMd, L.join('\n') + '\n');
}
process.exitCode = trustFails.length ? 1 : 0;
