// Per commit: triage, how many surfaces to test, and what is left not followed.
import { execFileSync } from 'node:child_process';
import { impact } from '../../packages/core/dist/index.js';
const repo = process.argv[2], n = Number(process.argv[3] ?? 60);
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const shas = git('log', '--first-parent', '--no-merges', `-n${n}`, '--format=%H', 'origin/main').split('\n');
const tally = { none: 0, yes: 0, unknown: 0 };
let withSurfaces = 0, failedEvidence = 0, totalMs = 0;
for (const sha of shas) {
  const subj = git('log', '-1', '--format=%s', sha).slice(0, 55);
  let r;
  try { r = impact({ repo, base: `${sha}~1`, head: sha, today: '2026-10-23' }); } catch (e) { console.log(sha.slice(0, 7), 'ERROR', e.message.slice(0, 100)); continue; }
  totalMs += r.ms;
  tally[r.triage.appEffect]++;
  const active = r.surfaces.filter((s) => s.tier !== 'skip');
  if (active.length) withSurfaces++;
  failedEvidence += r.verification.failed.length;
  const nm = r.ledger.filter((l) => l.status === 'not-modelled').map((l) => l.file.split('/').pop());
  const kinds = [...new Set(active.map((s) => s.kind))].join(',');
  console.log(`${sha.slice(0, 7)} ${r.triage.appEffect.padEnd(7)} test=${String(active.length).padStart(3)} [${kinds}] nm=${nm.length}${nm.length ? ' (' + nm.slice(0, 3).join(',') + ')' : ''} | ${subj}`);
}
console.log(JSON.stringify({ tally, withSurfaces, failedEvidence, avgMs: Math.round(totalMs / shas.length) }));
