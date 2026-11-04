#!/usr/bin/env node
/**
 * Publish OrderDesk with every scenario as a branch, so each can be opened as
 * a real pull request on GitHub and checked by the Teslon Action.
 *
 *   node bench/proving-ground/publish.mjs <dir> [remote-url]
 *
 * <dir> gets a git repository: main is the app at fixtures/orderdesk, and
 * pr/<scenario-id> is each scenario's change on top of main. With a remote URL,
 * main and every branch are pushed. pr-list.json in <dir> holds the title and
 * the developer's description for each PR.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const [dir, remote] = process.argv.slice(2);
if (!dir) { console.error('usage: publish.mjs <dir> [remote-url]'); process.exit(2); }
if (existsSync(join(dir, '.git'))) { console.error(`${dir} already has a repository`); process.exit(2); }
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

mkdirSync(dir, { recursive: true });
cpSync(join(ROOT, 'fixtures/orderdesk'), dir, { recursive: true });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'OrderDesk 1.4: customers, products, orders, invoices and daily sales');
const tools = {
  read: (f) => readFileSync(join(dir, f), 'utf8'),
  write: (f, c) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); },
  rm: (f) => unlinkSync(join(dir, f)),
  files: () => git('ls-files').split('\n'),
  edit: (f, from, to) => {
    const t = readFileSync(join(dir, f), 'utf8');
    if (!t.includes(from)) throw new Error(`${f}: edit does not apply`);
    writeFileSync(join(dir, f), t.replace(from, to));
  },
};
const list = [];
for (const sc of scenarios) {
  // process scenarios (behind main, merged three ways) need a moving main: they are run by run.mjs only
  if (sc.flow) continue;
  git('checkout', '-qb', `pr/${sc.id}`, 'main');
  sc.apply(tools);
  git('add', '-A'); git('commit', '-qm', sc.title);
  if (sc.apply2) { sc.apply2(tools); git('add', '-A'); git('commit', '-qm', `${sc.title} (2)`); }
  list.push({ branch: `pr/${sc.id}`, title: sc.title, body: `${sc.says}\n\n_Scenario \`${sc.id}\` of the Teslon proving ground. The expected impact is written in teslon/bench/proving-ground/scenarios.mjs, before Teslon was run._` });
}
git('checkout', '-q', 'main');
writeFileSync(join(dir, 'pr-list.json'), JSON.stringify(list, null, 2));
console.log(`${list.length} scenario branches in ${dir}`);
if (remote) {
  git('remote', 'add', 'origin', remote);
  execFileSync('git', ['push', '-u', 'origin', 'main', ...list.map((p) => p.branch)], { cwd: dir, stdio: 'inherit' });
}
