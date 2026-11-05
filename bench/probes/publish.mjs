#!/usr/bin/env node
/**
 * Publish a fixture app with probes as branches, so each can be opened as a real pull request on GitHub and
 * checked by the Teslon Action.
 *
 *   node bench/probes/publish.mjs <app> <dir> [remote-url] [--only id,id,…]
 *
 * <app> names a catalog in this folder (shopflow → catalog-shopflow.mjs). <dir> gets a git repository: main is
 * the fixture with the Teslon workflow added, and pr/<probe-id> is each probe's change on top of main. With a
 * remote URL, main and every branch are pushed. pr-list.json in <dir> holds each PR's title and a body that
 * states the truth written before Teslon ran.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const oi = args.indexOf('--only');
const only = oi >= 0 ? new Set(args.splice(oi, 2)[1].split(',')) : null;
const [app, dir, remote] = args;
if (!app || !dir) { console.error('usage: publish.mjs <app> <dir> [remote-url] [--only id,id]'); process.exit(2); }
if (existsSync(join(dir, '.git'))) { console.error(`${dir} already has a repository`); process.exit(2); }
const cat = await import(`./catalog-${app}.mjs`);
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

mkdirSync(dir, { recursive: true });
cpSync(join(ROOT, cat.APP), dir, { recursive: true });
mkdirSync(join(dir, '.github/workflows'), { recursive: true });
cpSync(join(ROOT, 'fixtures/orderdesk/.github/workflows/teslon.yml'), join(dir, '.github/workflows/teslon.yml'));
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', `${app}: the app, with the Teslon workflow`);
const tools = {
  read: (f) => readFileSync(join(dir, f), 'utf8'),
  write: (f, c) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); },
  rm: (f) => unlinkSync(join(dir, f)),
  edit: (f, from, to) => {
    const t = readFileSync(join(dir, f), 'utf8');
    if (!t.includes(from)) throw new Error(`${f}: edit does not apply`);
    writeFileSync(join(dir, f), t.replace(from, to));
  },
};
const said = (t) => [
  t.test?.length ? `- **Test:** ${t.test.join(', ')}` : '',
  t.reach?.length ? `- **Reached (test or unclear, never skip):** ${t.reach.join(', ')}` : '',
  t.notSkip === '*' ? '- **No screen may be skipped**' : t.notSkip?.length ? `- **Never skip:** ${t.notSkip.join(', ')}` : '',
  t.every ? '- **Every screen is reached**' : '',
  t.quiet?.length ? `- **Nothing a user sees changes on:** ${t.quiet.join(', ')}` : '',
  t.nothing ? '- **No runtime effect**' : '',
].filter(Boolean).join('\n');
const list = [];
for (const p of cat.probes) {
  if (only && !only.has(p.id)) continue;
  if (p.base) continue; // a probe that sets up its own base needs a base other than main
  git('checkout', '-qb', `pr/${p.id}`, 'main');
  p.apply(tools);
  git('add', '-A'); git('commit', '-qm', p.title);
  list.push({ branch: `pr/${p.id}`, title: p.title, body: `${p.title}.\n\n**Truth, written before Teslon ran** (\`teslon/bench/probes/catalog-${app}.mjs\`, probe \`${p.id}\`):\n${said(p.truth)}` });
}
git('checkout', '-q', 'main');
writeFileSync(join(dir, 'pr-list.json'), JSON.stringify(list, null, 2));
console.log(`${list.length} probe branches in ${dir}`);
if (remote) {
  git('remote', 'add', 'origin', remote);
  execFileSync('git', ['push', '-u', 'origin', 'main', ...list.map((p) => p.branch)], { cwd: dir, stdio: 'inherit' });
}
