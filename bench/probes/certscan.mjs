// The skip checker on a probe catalog (packages/core/src/engine/certify.ts).
//   node bench/probes/certscan.mjs --app=shopflow [-v] [-p] [--grep=re]
//     why skips were refused: each demoted area and its first blocker (-v), with the node path (-p)
//   node bench/probes/certscan.mjs --app=shopflow --truth
//     soundness: every area the truth says is reached is handed to the checker as if it had been skipped;
//     the run fails if the checker certifies any of them with nothing to show for it
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { impact } from '../../packages/core/dist/index.js';
import { certify } from '../../packages/core/dist/engine/certify.js';
import { snapshot, changedFiles } from '../../packages/core/dist/engine/snapshot.js';
import { readSpring } from '../../packages/core/dist/engine/spring.js';
import { readFrontend } from '../../packages/core/dist/engine/frontend.js';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const appName = (args.find((a) => a.startsWith('--app=')) ?? '--app=orderdesk').slice(6);
const grep = args.find((a) => a.startsWith('--grep='))?.slice(7);
const cat = appName === 'orderdesk' ? await import('./catalog.mjs') : await import(`./catalog-${appName}.mjs`);
const APP_DIR = join(ROOT, cat.APP ?? 'fixtures/orderdesk');
const ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim();
const tools = (d) => ({
  read: (f) => readFileSync(join(d, f), 'utf8'),
  write: (f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); },
  rm: (f) => unlinkSync(join(d, f)),
  edit: (f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); if (!t.includes(from)) throw new Error(`${f}: edit does not apply`); writeFileSync(join(d, f), t.replace(from, to)); },
});
const hist = new Map();
let skips = 0, demoted = 0;
// --truth: ask the checker to certify every area the truth says is reached, as if the engine had skipped it.
// A sound checker refuses all of them: through code it runs (hard), or at least as content it relies on.
const truthMode = args.includes('--truth');
let tAreas = 0, tHard = 0, tRelies = 0;
const tMissed = [];
for (const p of cat.probes) {
  if (grep && !new RegExp(grep).test(p.id)) continue;
  const d = mkdtempSync(join(tmpdir(), `cs-${p.id}-`));
  try {
    cpSync(APP_DIR, d, { recursive: true }); git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 'dev@x'); git(d, 'config', 'user.name', 'Dev'); git(d, 'config', 'commit.gpgsign', 'false');
    p.base?.(tools(d)); git(d, 'add', '-A'); if (git(d, 'status', '--porcelain')) git(d, 'commit', '-qm', 'base'); const base = git(d, 'rev-parse', 'HEAD');
    p.apply(tools(d)); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'x'); const head = git(d, 'rev-parse', 'HEAD');
    if (truthMode) {
      const t = p.truth;
      const ids = new Set([...(t.test ?? []), ...(t.reach ?? []), ...(t.notSkip === '*' || t.every ? cat.SCREENS.map((x) => `screen:${x}`) : t.notSkip ?? [])].filter((x) => /^(screen|job):/.test(x) && x !== 'screen:*'));
      if (!ids.size) continue;
      const B = snapshot(d, base), H = snapshot(d, head);
      const c = certify({ base: B, head: H, fb: readSpring(B), fh: readSpring(H), ub: readFrontend(B), uh: readFrontend(H), changes: changedFiles(d, base, head), areas: [...ids] });
      for (const pr of c.proofs) { tAreas++; if (!pr.ok) tHard++; else if (pr.relies.length) tRelies++; else tMissed.push(`${p.id} ${pr.area} (${pr.nodes} nodes)`); }
      continue;
    }
    const r = impact({ repo: d, base, head });
    const c = r.certification;
    skips += c.proofs.length; demoted += c.demoted.length;
    const lines = [];
    for (const pr of c.proofs.filter((x) => !x.ok)) {
      const b = pr.blockers[0];
      const k = `${b.kind} ${b.node.replace(/^(\w+:).*$/, '$1')} ${b.kind === 'unknown' ? b.node.split(':')[1] : ''}`;
      hist.set(k, (hist.get(k) ?? 0) + 1);
      lines.push(`   ${pr.area.padEnd(28)} ${b.kind} ${b.node.slice(0, 70)} | ${b.chain.slice(0, 7).join(' → ')}${args.includes('-p') ? '\n      ' + b.path.join('  >  ') : ''}`);
    }
    console.log(`${p.id.padEnd(28)} skips ${c.proofs.length} demoted ${c.demoted.length} Δ ${JSON.stringify(c.changed)} dangling ${(100 * c.dangling.rate).toFixed(1)}% ${c.ms}ms`);
    if (args.includes('-v')) for (const l of lines.slice(0, 6)) console.log(l);
  } catch (e) { console.log(`${p.id} CRASH ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); }
  finally { rmSync(d, { recursive: true, force: true }); }
}
if (truthMode) { console.log(`\ntruth-reached areas ${tAreas}: refused through code ${tHard} (${(100 * tHard / Math.max(1, tAreas)).toFixed(1)}%), relied on as content ${tRelies}, certified anyway ${tMissed.length}`); for (const m of tMissed) console.log('  MISSED ' + m); process.exit(tMissed.length ? 1 : 0); }
console.log(`\n${skips} skips, ${demoted} demoted (${(100 * demoted / Math.max(1, skips)).toFixed(1)}%)`);
for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
