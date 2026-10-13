/**
 * The local app's promises, as tests.
 *
 * The page can start analyses that read your code, so the server's posture is
 * part of the product rather than a deployment detail: loopback only, a fixed
 * table of static files, every ref treated as hostile, and a CSP that keeps the
 * page from reaching anything but this server even if escaping ever failed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUi, isSafeRef } from '../dist/server.js';

let server;
let repo;
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(async () => {
  repo = mkdtempSync(join(tmpdir(), 'teslon-ui-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src/b.ts'), "import { a } from './a';\nexport const b = a;\n");
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;\n');
  g('commit', '-qam', 'change');
  g('checkout', '-q', 'main');
  server = await startUi({ root: repo, port: 0 });
});
after(() => server?.close());

test('binds to the loopback interface only', () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('a ref that git would read as an option is refused before git sees it', async () => {
  const marker = join(tmpdir(), `teslon-pwned-${process.pid}`);
  for (const ref of [`--upload-pack=touch ${marker}`, '-c', '--output=/tmp/x', 'a b', 'main;rm', '$(id)']) {
    assert.equal(isSafeRef(ref), false, ref);
    const res = await fetch(new URL('/api/analyze', server.url), { method: 'POST', body: JSON.stringify({ head: ref }) });
    assert.equal(res.status, 400, ref);
  }
  assert.equal(existsSync(marker), false, 'the injected command must not have run');
  for (const ref of ['main', 'feature/x-1', 'origin/main', 'HEAD~2', 'v1.2.3', 'a1b2c3d']) assert.ok(isSafeRef(ref), ref);
});

test('only the fixed table of files is served — there is no path to traverse', async () => {
  for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/package.json', '/fonts/../../package.json', '/src/server.ts']) {
    const res = await fetch(new URL(path, server.url));
    assert.equal(res.status, 404, path);
  }
  const font = await fetch(new URL('/fonts/BarlowCondensed-Black.ttf', server.url));
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/ttf');
});

test('the page is locked to this server by its CSP', async () => {
  const res = await fetch(server.url);
  const csp = res.headers.get('content-security-policy') ?? '';
  for (const rule of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(rule), `missing ${rule}`);
  }
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS: nothing here is for another origin');
  const html = await res.text();
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'the page must not reference any remote resource');
});

test('analyses a branch that is not checked out, and leaves the working tree alone', async () => {
  const res = await fetch(new URL('/api/analyze', server.url), {
    method: 'POST',
    body: JSON.stringify({ base: 'main', head: 'feature' }),
  });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.ok(result.radius.some((r) => r.file === 'src/b.ts'), 'the importer must be found');
  assert.match(result.change.readFrom ?? '', /clean checkout of feature/);
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the user is still on main');
  assert.equal(g('worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');
});

test('a missing merge base is a clear 409, never an empty "all clear"', async () => {
  const res = await fetch(new URL('/api/analyze', server.url), {
    method: 'POST',
    body: JSON.stringify({ base: 'main', head: 'does-not-exist' }),
  });
  assert.ok(res.status >= 400, `got ${res.status}`);
  const body = await res.json();
  assert.ok(body.error);
});
