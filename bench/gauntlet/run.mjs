#!/usr/bin/env node
/**
 * Run Teslon on every compiled mutant and score it against the compiler oracle.
 *
 *   node bench/gauntlet/run.mjs <mutants.json> [--shard i/n] [--json out.json] [--grep re]
 *   node bench/gauntlet/run.mjs --merge out.json part1.json part2.json …  [--md report.md]
 *
 * Each mutant copies the fixture from this repository, commits it as the base, puts the mutant line into
 * its method and commits that as the head, then runs the engine on the two commits.
 *
 *   WRONG SKIP     an area whose flow runs the changed method was called safe            (trust)
 *   SILENT         such an area is not in the brief at all                               (trust)
 *   EVIDENCE       a citation did not re-check                                           (trust)
 *   CRASH          the engine threw                                                      (trust)
 *   NOISE          a comment-only mutant, and areas listed to test                       (trust)
 *   CONTENT SKIP   an area reached only through another thread or a topic was called safe (reported)
 *   extra          an area listed or held that the oracle does not reach                  (precision)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const TRUST = new Set(['WRONG SKIP', 'SILENT', 'EVIDENCE', 'CRASH', 'NOISE']);

if (args[0] === '--merge') {
  args.shift();
  const md = flag('--md');
  const [out, ...parts] = args;
  const all = parts.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')).rows);
  all.sort((a, b) => a.id.localeCompare(b.id));
  const s = summarise(all);
  writeFileSync(out, JSON.stringify({ summary: s, rows: all }, null, 1));
  console.log(s.line);
  if (md) writeFileSync(md, report(all, s));
  process.exit(s.trust ? 1 : 0);
}

const file = args[0];
const shard = flag('--shard');
const outJson = flag('--json');
const grep = flag('--grep');
const data = JSON.parse(readFileSync(file, 'utf8'));
const FIX = join(ROOT, data.app === 'orderdesk' ? 'fixtures/orderdesk' : 'fixtures/shopflow');
const { impact, brief } = await import(join(ROOT, 'packages/core/dist/index.js'));
const ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim();

let list = data.kept;
if (grep) list = list.filter((k) => new RegExp(grep).test(k.id));
if (shard) { const [i, n] = shard.split('/').map(Number); list = list.filter((_, k) => k % n === i); }

const rows = [];
for (const k of list) {
  const d = mkdtempSync(join(tmpdir(), 'gauntlet-'));
  const t0 = Date.now();
  let row;
  try {
    cpSync(FIX, d, { recursive: true });
    git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 'dev@example.com'); git(d, 'config', 'user.name', 'Dev'); git(d, 'config', 'commit.gpgsign', 'false');
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
    const base = git(d, 'rev-parse', 'HEAD');
    const text = readFileSync(join(d, k.file), 'utf8');
    writeFileSync(join(d, k.file), k.edit ? text.replace(k.edit.from, k.edit.to) : text.slice(0, k.at) + (k.raw ? '' : ' ') + (k.insert ?? data.statement) + text.slice(k.at));
    git(d, 'commit', '-qam', `mutant: ${k.id}`);
    const r = impact({ repo: d, base, head: git(d, 'rev-parse', 'HEAD') });
    const b = brief(r);
    const state = new Map(b.areas.map((a) => [a.id, a]));
    const fails = [];
    if (r.verification.failed.length) fails.push({ kind: 'EVIDENCE', msg: `${r.verification.failed.length} citations did not re-check` });
    // an endpoint's own area is named by its path, which a route mutant moves
    const find = (a) => state.get(a) ?? (a.startsWith('api:') ? [...state.values()].find((x) => x.id.startsWith(`${a}/`)) : undefined);
    for (const [a, path] of Object.entries(k.hard)) {
      const s = find(a);
      if (!s) fails.push({ kind: 'SILENT', area: a, msg: `${a} is not in the brief; it runs the method: ${path}` });
      else if (s.state === 'skip') fails.push({ kind: 'WRONG SKIP', area: a, msg: `${a} called safe (${(s.why ?? '').slice(0, 120)}); it runs the method: ${path}` });
    }
    for (const [a, path] of Object.entries(k.content)) {
      const s = state.get(a);
      if (s?.state === 'skip') fails.push({ kind: 'CONTENT SKIP', area: a, msg: `${a} called safe; reached through ${path}` });
    }
    const reached = new Set([...Object.keys(k.hard), ...Object.keys(k.content)]);
    const extra = b.areas.filter((a) => (a.state === 'test' || a.state === 'unclear') && !reached.has(a.id) && /^(screen|job):/.test(a.id)).map((a) => `${a.state}:${a.id}`);
    if (k.kind === 'comment') { const loud = b.areas.filter((a) => a.state === 'test').map((a) => a.id); if (loud.length) fails.push({ kind: 'NOISE', msg: `a comment only, but ${loud.length} areas to test: ${loud.slice(0, 3).join(', ')}` }); }
    const hardTested = Object.keys(k.hard).filter((a) => state.get(a)?.state === 'test').length;
    row = { id: k.id, method: k.method, file: k.file, line: k.line, hard: Object.keys(k.hard).length, content: Object.keys(k.content).length, hardTested, fails, extra, verdict: `T${b.test} S${b.skip} U${b.unclear} · ${b.confidence.title}`, demoted: r.certification?.demoted.length ?? 0, ms: Date.now() - t0 };
  } catch (e) {
    row = { id: k.id, method: k.method, file: k.file, line: k.line, hard: Object.keys(k.hard).length, content: Object.keys(k.content).length, hardTested: 0, fails: [{ kind: 'CRASH', msg: String(e.stack ?? e).split('\n').slice(0, 3).join(' | ') }], extra: [], verdict: 'crashed', demoted: 0, ms: Date.now() - t0 };
  } finally { rmSync(d, { recursive: true, force: true }); }
  rows.push(row);
  const trust = row.fails.filter((f) => TRUST.has(f.kind)).length;
  console.log(`${trust ? '✗' : row.fails.length ? '~' : '✓'} ${row.id.padEnd(58)} ${String(row.ms).padStart(5)} ms  hard ${row.hard} content ${row.content}  ${row.verdict}${row.extra.length ? `  +${row.extra.length} extra` : ''}`);
  for (const f of row.fails) console.log(`     ${f.kind}: ${f.msg}`);
}
if (outJson) writeFileSync(outJson, JSON.stringify({ rows }, null, 1));
const s = summarise(rows);
console.log(`\n${s.line}`);
process.exitCode = s.trust ? 1 : 0;

function summarise(rows) {
  const count = (k) => rows.reduce((n, r) => n + r.fails.filter((f) => f.kind === k).length, 0);
  const trust = rows.filter((r) => r.fails.some((f) => TRUST.has(f.kind))).length;
  const hard = rows.reduce((n, r) => n + r.hard, 0), tested = rows.reduce((n, r) => n + r.hardTested, 0);
  const extra = rows.reduce((n, r) => n + r.extra.length, 0);
  const line = `${rows.length} mutants · ${rows.length - trust} trusted · wrong skips ${count('WRONG SKIP')} · silent ${count('SILENT')} · evidence ${count('EVIDENCE')} · crashes ${count('CRASH')} · noise ${count('NOISE')} · content skips ${count('CONTENT SKIP')} · areas that run the change ${hard}, ${tested} listed to test (${hard ? (100 * tested / hard).toFixed(1) : 0}%) · extra areas ${extra} · skips not proven by the checker ${rows.reduce((n, r) => n + r.demoted, 0)}`;
  return { line, trust, mutants: rows.length };
}
function report(rows, s) {
  const L = ['# Mutation gauntlet', '', s.line, '', '| mutant | areas that run it | Teslon said | result |', '|---|---|---|---|'];
  for (const r of rows) L.push(`| \`${r.id}\` (${r.file}:${r.line}) | ${r.hard}${r.content ? ` + ${r.content} through a topic or thread` : ''} | ${r.verdict}${r.extra.length ? ` · +${r.extra.length} extra` : ''} | ${r.fails.length ? r.fails.map((f) => `**${f.kind}** ${f.msg.replace(/\|/g, '\\|')}`).join('<br>') : '✓'} |`);
  return L.join('\n') + '\n';
}
