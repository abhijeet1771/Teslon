import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };

const ctl = (valid) => `package a;

import org.springframework.web.bind.annotation.*;

@RestController
public class C {
  @PostMapping("/things")
  public void add(${valid ? '@jakarta.validation.Valid ' : ''}@RequestBody Thing t) {}
}
`;

test('teslon impact <base>..<head> prints the report, --json the schema, and a bad range fails loudly', () => {
  const d = mkdtempSync(join(tmpdir(), 'teslon-impact-cli-'));
  try {
    g(d, 'init', '-q', '-b', 'main'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 'T');
    put(d, {
      'src/main/resources/application.yml': 'spring:\n  application:\n    name: things\n',
      'src/main/java/a/Thing.java': 'package a;\n\npublic class Thing {\n  @jakarta.validation.constraints.NotBlank\n  private String name;\n}\n',
      'src/main/java/a/C.java': ctl(false),
    });
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base');
    put(d, { 'src/main/java/a/C.java': ctl(true) }); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'valid');
    const env = { ...process.env, TESLON_ROOT: d };

    const text = spawnSync('node', [CLI, 'impact', 'HEAD~1..HEAD'], { cwd: d, env, encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Create thing: now refuses name @NotBlank/);
    assert.match(text.stdout, /POST \/things/);

    const json = spawnSync('node', [CLI, 'impact', 'HEAD~1..HEAD', '--json'], { cwd: d, env, encoding: 'utf8' });
    const r = JSON.parse(json.stdout);
    assert.equal(r.schema, 'teslon.impact/1');
    assert.equal(r.verification.failed.length, 0);

    const bad = spawnSync('node', [CLI, 'impact', 'nope..HEAD'], { cwd: d, env, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('teslon pr <n>: fetches the PR from origin, checks it where it lands, and writes the comment and summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'teslon-pr-cli-'));
  const o = join(root, 'origin'), c = join(root, 'clone'), out = join(root, 'out'), summary = join(root, 'summary.md');
  try {
    mkdirSync(o);
    g(o, 'init', '-q', '-b', 'main'); g(o, 'config', 'user.email', 't@t'); g(o, 'config', 'user.name', 'T'); g(o, 'config', 'commit.gpgsign', 'false');
    put(o, {
      'src/main/resources/application.yml': 'spring:\n  application:\n    name: things\n',
      'src/main/java/a/Thing.java': 'package a;\n\npublic class Thing {\n  @jakarta.validation.constraints.NotBlank\n  private String name;\n}\n',
      'src/main/java/a/C.java': ctl(false),
      'README.md': '# things\n',
    });
    g(o, 'add', '-A'); g(o, 'commit', '-qm', 'base');
    // PR 7: open, and main has moved on since it branched
    g(o, 'checkout', '-qb', 'feat'); put(o, { 'src/main/java/a/C.java': ctl(true) }); g(o, 'add', '-A'); g(o, 'commit', '-qm', 'valid');
    g(o, 'update-ref', 'refs/pull/7/head', 'feat');
    g(o, 'checkout', '-q', 'main'); put(o, { 'README.md': '# things\n\nmore\n' }); g(o, 'add', '-A'); g(o, 'commit', '-qm', 'docs');
    g(o, 'checkout', '-q', '--detach', 'main'); g(o, 'merge', '-q', '--no-ff', '-m', 'test merge', 'feat'); g(o, 'update-ref', 'refs/pull/7/merge', 'HEAD');
    // PR 8: merged with a merge commit
    g(o, 'checkout', '-q', 'main'); g(o, 'checkout', '-qb', 'f8'); put(o, { 'README.md': '# things\n\nmore\nand more\n' }); g(o, 'add', '-A'); g(o, 'commit', '-qm', 'f8');
    g(o, 'update-ref', 'refs/pull/8/head', 'f8');
    g(o, 'checkout', '-q', 'main'); g(o, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #8', 'f8');
    execFileSync('git', ['clone', '-q', o, c]);

    // no GitHub here: no token, no repository, so it runs on git alone
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|GH_TOKEN|TESLON_)/.test(k)));
    const run = (...a) => spawnSync('node', [CLI, 'pr', ...a], { cwd: c, env: { ...env, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });

    const open = run('7', '--out', out, '--summary', '--comment');
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /PR #7 · open; checked as if merged into main today/);
    assert.match(open.stdout, /POST \/things/);
    assert.match(open.stderr, /could not post the comment/, 'no token or repository: it says so and carries on');
    const comment = readFileSync(join(out, 'comment.md'), 'utf8');
    assert.ok(comment.startsWith('<!-- teslon:impact -->'));
    assert.match(comment, /API `POST \/things`/);
    assert.match(readFileSync(summary, 'utf8'), /## Test first/);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.meta.number, 7);
    assert.equal(report.verification.failed.length, 0);
    assert.ok(existsSync(join(out, 'report.txt')));
    assert.match(readFileSync(join(out, 'report.html'), 'utf8'), /^<!doctype html>[\s\S]*POST \/things/);

    const merged = run('8');
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stdout, /PR #8 · merged by [0-9a-f]{7}; checked as it landed on main/);
    assert.match(merged.stdout, /no app effect|Nothing to test/i);

    const missing = run('9');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /could not fetch PR #9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
