import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
