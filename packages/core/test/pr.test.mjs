import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { prRange, impact, renderComment, renderSummary, renderHtml, COMMENT_MARKER } from '../dist/index.js';
import { esc, code } from '../dist/engine/markdown.js';

/**
 * A pull request is checked where it lands on the base branch, however it was
 * merged, and an open one as GitHub's test merge would land it. Then the two
 * markdown outputs: the short PR comment and the full summary page.
 */

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };
const commit = (d, name, files) => { put(d, files); g(d, 'add', '-A'); g(d, 'commit', '-qm', name); return g(d, 'rev-parse', 'HEAD'); };
const init = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  g(d, 'init', '-q', '-b', 'main'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 'T'); g(d, 'config', 'commit.gpgsign', 'false');
  commit(d, 'base', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
  return d;
};

test('a PR merged with a merge commit is checked as that merge against its first parent', () => {
  const d = init('teslon-pr-merge-');
  try {
    g(d, 'checkout', '-qb', 'f1'); commit(d, 'f1', { 'a.txt': 'a1\n' });
    g(d, 'checkout', '-q', 'main'); commit(d, 'other', { 'b.txt': 'b1\n' });
    const before = g(d, 'rev-parse', 'HEAD');
    g(d, 'merge', '-q', '--no-ff', '-m', 'merge f1', 'f1');
    const m = g(d, 'rev-parse', 'HEAD');
    commit(d, 'later', { 'c.txt': 'c1\n' });

    const r = prRange(d, 'f1', 'main');
    assert.equal(r.state, 'merged');
    assert.equal(r.context, 'landed');
    assert.equal(r.base, before);
    assert.equal(r.head, m);
    assert.match(r.how, /merged by/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a rebase-merged PR is found by patch-id and checked as the commits it landed as', () => {
  const d = init('teslon-pr-rebase-');
  try {
    g(d, 'checkout', '-qb', 'f2'); const b1 = commit(d, 'b1', { 'a.txt': 'a2\n' }); const b2 = commit(d, 'b2', { 'b.txt': 'b2\n' });
    g(d, 'checkout', '-q', 'main'); commit(d, 'other', { 'c.txt': 'c2\n' });
    const parent = g(d, 'rev-parse', 'HEAD');
    g(d, 'cherry-pick', b1, b2);
    const last = g(d, 'rev-parse', 'HEAD');
    commit(d, 'later', { 'd.txt': 'd2\n' });

    const r = prRange(d, 'f2', 'main');
    assert.equal(r.state, 'merged');
    assert.equal(r.base, parent, 'from just before the first landed commit');
    assert.equal(r.head, last, 'to the last landed commit, not the tip of main');
    assert.match(r.how, /rebase-merged/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a squash-merged PR is found as the one commit carrying its whole diff', () => {
  const d = init('teslon-pr-squash-');
  try {
    g(d, 'checkout', '-qb', 'f3'); commit(d, 'c1', { 'a.txt': 'a3\n' }); commit(d, 'c2', { 'b.txt': 'b3\n' });
    g(d, 'checkout', '-q', 'main'); commit(d, 'other', { 'c.txt': 'c3\n' });
    g(d, 'merge', '-q', '--squash', 'f3'); g(d, 'commit', '-qm', 'f3 (#3)');
    const s = g(d, 'rev-parse', 'HEAD');
    commit(d, 'later', { 'd.txt': 'd3\n' });

    const r = prRange(d, 'f3', 'main');
    assert.equal(r.state, 'merged');
    assert.equal(r.head, s);
    assert.equal(r.base, g(d, 'rev-parse', `${s}^`));
    assert.match(r.how, /squash-merged/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an open PR is checked as GitHub\'s test merge; without one, on its branch with how far behind it is', () => {
  const d = init('teslon-pr-open-');
  try {
    g(d, 'checkout', '-qb', 'f4'); const head = commit(d, 'd', { 'a.txt': 'a4\n' });
    g(d, 'checkout', '-q', 'main'); const tip = commit(d, 'other', { 'b.txt': 'b4\n' });
    // what GitHub keeps at refs/pull/N/merge
    g(d, 'checkout', '-q', '--detach', 'main'); g(d, 'merge', '-q', '--no-ff', '-m', 'test merge', 'f4');
    g(d, 'update-ref', 'refs/pull/4/merge', 'HEAD'); g(d, 'checkout', '-q', 'main');

    const r = prRange(d, 'f4', 'main', { mergeRef: 'refs/pull/4/merge' });
    assert.equal(r.state, 'open');
    assert.equal(r.context, 'test-merge');
    assert.equal(r.base, tip, 'measured from today\'s base branch');
    assert.equal(r.head, g(d, 'rev-parse', 'refs/pull/4/merge'));

    const b = prRange(d, 'f4', 'main');
    assert.equal(b.context, 'pr-branch');
    assert.equal(b.head, head);
    assert.equal(b.base, g(d, 'merge-base', 'main', 'f4'));
    assert.match(b.how, /1 commit behind main/);

    // a test merge of some other PR is not taken for this one
    g(d, 'checkout', '-qb', 'f5', 'main~1'); commit(d, 'e', { 'c.txt': 'c5\n' }); g(d, 'checkout', '-q', 'main');
    assert.equal(prRange(d, 'f5', 'main', { mergeRef: 'refs/pull/4/merge' }).context, 'pr-branch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a fast-forward cannot be placed from git alone: it says so and takes --base-sha', () => {
  const d = init('teslon-pr-ff-');
  try {
    const start = g(d, 'rev-parse', 'HEAD');
    g(d, 'checkout', '-qb', 'f6'); const head = commit(d, 'f', { 'a.txt': 'a6\n' });
    g(d, 'checkout', '-q', 'main'); g(d, 'merge', '-q', '--ff-only', 'f6');
    assert.throws(() => prRange(d, 'f6', 'main'), /fast-forward.*--base-sha/s);
    const r = prRange(d, 'f6', 'main', { baseSha: start });
    assert.deepEqual([r.base, r.head, r.context], [start, head, 'given']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const ctl = (valid) => `package a;

import org.springframework.web.bind.annotation.*;

@RestController
public class C {
  @PostMapping("/things")
  public void add(${valid ? '@jakarta.validation.Valid ' : ''}@RequestBody Thing t) {}
}
`;

test('the PR comment: marker first, verdict, start here, link to the full report, and no @mentions', () => {
  const d = init('teslon-pr-md-');
  try {
    put(d, {
      'src/main/resources/application.yml': 'spring:\n  application:\n    name: things\n',
      'src/main/java/a/Thing.java': 'package a;\n\npublic class Thing {\n  @jakarta.validation.constraints.NotBlank\n  private String name;\n}\n',
      'src/main/java/a/C.java': ctl(false),
    });
    const base = commit(d, 'app', {});
    const head = commit(d, 'valid', { 'src/main/java/a/C.java': ctl(true) });
    const r = impact({ repo: d, base, head });
    const meta = { number: 7, title: 'Validate things', baseRef: 'main', state: 'open', how: 'open; test merge', repoUrl: 'https://github.com/acme/things', runUrl: 'https://github.com/acme/things/actions/runs/1', version: '0.0.0-test' };

    const c = renderComment(r, meta);
    assert.ok(c.startsWith(COMMENT_MARKER), 'the marker lets the next run update this comment instead of adding one');
    assert.match(c, /\| Test first \| Test next \| Watch after release \| Safe to skip \| Teslon could not see \|/);
    assert.match(c, /\*\*Start here\*\*\n1\. API `POST \/things`/);
    assert.match(c, /\[Full report\]\(https:\/\/github\.com\/acme\/things\/actions\/runs\/1\)/);
    assert.match(c, /cited lines re-checked/);
    assert.doesNotMatch(c, /\bh at\b/, 'no hours unless the team gave its minutes per case');
    assert.match(renderComment(r, { ...meta, minutesPerCase: 10 }), /about [\d.]+ h at 10 min a case/);

    const s = renderSummary(r, meta);
    assert.match(s, /## Test first/);
    assert.match(s, /- \[ \] /, 'cases are a checklist');
    assert.match(s, new RegExp(`\\(https://github\\.com/acme/things/blob/${head}/src/main/java/a/C\\.java#L\\d+\\)`), 'evidence links to the line at the commit it was read from');
    assert.match(s, /Every changed file, accounted for/);
    assert.doesNotMatch(c + s, /(^|[^`\w])@(NotBlank|Valid)\b/, 'an annotation must not ping a GitHub user');
    assert.match(s, /`@(NotBlank|Valid|jakarta[\w.]*)`/);
    assert.match(c, /\*\*1 place\*\* · 1 case \|/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a change with no app effect says so in one line', () => {
  const d = init('teslon-pr-docs-');
  try {
    const base = g(d, 'rev-parse', 'HEAD');
    const head = commit(d, 'docs', { 'README.md': '# hi\n' });
    const r = impact({ repo: d, base, head });
    const c = renderComment(r, { baseRef: 'main', state: 'open', how: 'x', version: 't' });
    assert.match(c, /Nothing to test in the app/);
    assert.doesNotMatch(c, /Start here/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('repository text cannot inject markup, and a huge report is cut at a line with its <details> closed', () => {
  assert.equal(esc('a|b <img> *x* [l](u)'), 'a\\|b &lt;img&gt; \\*x\\* \\[l\\](u)');
  assert.equal(esc('mail a@b.c, use @Valid'), 'mail a@b.c, use `@Valid`');
  assert.equal(code('a`b'), '`` a`b ``');

  const d = init('teslon-pr-huge-');
  try {
    put(d, {
      'src/main/resources/application.yml': 'spring:\n  application:\n    name: things\n',
      'src/main/java/a/Thing.java': 'package a;\n\npublic class Thing {\n  @jakarta.validation.constraints.NotBlank\n  private String name;\n}\n',
      'src/main/java/a/C.java': ctl(false),
    });
    const base = commit(d, 'app', {});
    const head = commit(d, 'valid', { 'src/main/java/a/C.java': ctl(true) });
    const r = impact({ repo: d, base, head });
    const c0 = r.cases.find((c) => c.tier !== 'skip');
    const s0 = r.surfaces.find((s) => s.id === c0.surface);
    const many = 4000;
    const big = {
      ...r,
      surfaces: [...r.surfaces, ...Array.from({ length: many }, (_, i) => ({ ...s0, id: `api:x${i}`, name: `POST /x${i} ${'ü'.repeat(120)}` }))],
      cases: [...r.cases, ...Array.from({ length: many }, (_, i) => ({ ...c0, surface: `api:x${i}`, delta: `d${i}` }))],
    };
    const meta = { baseRef: 'main', state: 'open', how: 'x', version: 't' };
    const s = renderSummary(big, meta);
    assert.ok(Buffer.byteLength(s, 'utf8') <= 1_000_000, 'the summary page takes 1 MiB, counted in bytes');
    assert.match(s, /cut to fit the summary page/);
    assert.equal((s.match(/<details>/g) ?? []).length, (s.match(/<\/details>/g) ?? []).length);
    assert.ok(renderComment(big, meta).length < 60_000);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the cockpit is one offline file: complete without its script, nothing loaded from anywhere, repository text inert', () => {
  const d = init('teslon-pr-html-');
  try {
    put(d, {
      'src/main/resources/application.yml': 'spring:\n  application:\n    name: things\n',
      'src/main/java/a/Thing.java': 'package a;\n\npublic class Thing {\n  @jakarta.validation.constraints.NotBlank\n  private String name;\n}\n',
      'src/main/java/a/C.java': ctl(false),
    });
    const base = commit(d, 'app', {});
    const head = commit(d, 'valid', { 'src/main/java/a/C.java': ctl(true) });
    const r = impact({ repo: d, base, head });
    const meta = { number: 7, title: 'Validate </script><script>alert(1)</script> things', baseRef: 'main', state: 'open', how: 'open', repoUrl: 'https://github.com/acme/things', version: 't' };
    const h = renderHtml(r, meta);

    assert.match(h, /^<!doctype html>\n<html lang="en">/);
    assert.match(h, /Content-Security-Policy" content="default-src 'none'/);
    // nothing fetched: the only URLs are links a person clicks, to their own repository
    assert.doesNotMatch(h, /<(script|link|img|iframe)[^>]+(src|href)="https?:/i);
    assert.doesNotMatch(h, /@import|url\(/);
    for (const m of h.matchAll(/href="(https?:[^"]+)"/g)) assert.ok(m[1].startsWith('https://github.com/acme/things/'), m[1]);
    // the title is escaped in markup, and the data block cannot be closed from inside
    assert.equal((h.match(/<script>alert\(1\)/g) ?? []).length, 0);
    const data = /<script type="application\/json" id="teslon-data">(.*?)<\/script>/s.exec(h);
    assert.ok(data, 'data block present');
    assert.doesNotMatch(data[1], /</);
    const parsed = JSON.parse(data[1]);
    assert.equal(parsed.head, head);
    assert.ok(parsed.cases.length >= 1);
    // static and complete: the case, its proof, and a Pass/Fail per case are in the markup
    assert.match(h, /id="test-first"/);
    assert.match(h, /<span class="lbl">Do<\/span>Send POST \/things/);
    assert.equal((h.match(/<button type="button" data-v="pass"/g) ?? []).length, parsed.cases.length);
    assert.match(h, new RegExp(`href="https://github\\.com/acme/things/blob/${head}/src/main/java/a/C\\.java#L\\d+"`));
    assert.match(h, /id="ledger"/);

    const frag = renderHtml(r, meta, { fragment: true });
    assert.doesNotMatch(frag, /<!doctype|<html|<body/i);
    assert.match(frag, /^<title>PR #7 test brief<\/title>/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
