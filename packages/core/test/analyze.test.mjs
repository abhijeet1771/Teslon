import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  listFiles,
  isTestFile,
  readAst,
  profileFile,
  stripComments,
  coChangeEdges,
  lockfileVersions,
  TIER_LABEL,
} from '../dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const TORTURE = join(REPO, 'fixtures', 'torture');
const TRUTH = JSON.parse(readFileSync(join(REPO, 'fixtures', 'torture-expected', 'torture.json'), 'utf8'));

const run = (root, files, extra = {}) =>
  analyze({
    root,
    allFiles: listFiles(root),
    repo: root,
    change: { baseSha: 'b', headSha: 'h', mergeBase: 'm', files },
    ...extra,
  });

/**
 * The regression that matters most.
 *
 * The orchestrator's first draft handed the primitives a pre-filtered list of
 * code files, which starved every cross-language signal and dropped recall
 * from 95.7% to 69.6% — a .css class, a .sql column and an i18n .json key are
 * all evidence, and none of them live in a .ts file. The primitives were never
 * wrong; the assembly was. Nothing but a whole-fixture recall number catches
 * that, so this test owns the number.
 */
test('I2 · the assembled result loses no recall the primitives had', () => {
  let hit = 0;
  let total = 0;
  const missed = [];
  for (const [seed, spec] of Object.entries(TRUTH)) {
    const found = new Set(run(TORTURE, [seed]).result.radius.map((r) => r.file));
    for (const expected of spec.expect) {
      total++;
      if (found.has(expected)) hit++;
      else missed.push(`${seed} -> ${expected}`);
    }
  }
  // 22 of 23. The one miss is the deliberate five-line clone, documented in
  // widening.ts: catching it needs a threshold low enough to couple unrelated
  // files, which trades a real miss for many false ones.
  assert.equal(total, 23, 'the ground truth changed size — update this test on purpose, not by accident');
  assert.ok(hit >= 22, `recall fell to ${hit}/${total}: ${missed.join(', ')}`);
});

test('I3 · analyze is byte-identical regardless of input file order', () => {
  const files = listFiles(TORTURE);
  const change = { baseSha: 'b', headSha: 'h', mergeBase: 'm', files: ['src/services/PriceService.ts'] };
  const forward = analyze({ root: TORTURE, allFiles: files, repo: TORTURE, change });
  const reversed = analyze({ root: TORTURE, allFiles: [...files].reverse(), repo: TORTURE, change });
  assert.equal(JSON.stringify(forward.result), JSON.stringify(reversed.result));
});

test('I1 · a changed path absent from the tree is never silent', () => {
  const { result } = run(TORTURE, ['src/does-not-exist.ts', 'src/services/PriceService.ts']);
  const said = result.limitations.filter((l) => /not present in the tree/.test(l.what));
  assert.equal(said.length, 1, 'a deleted file or a wrong root must produce a limitation');
  assert.deepEqual(said[0].files, ['src/does-not-exist.ts']);
  // And it stays in the radius: an empty answer that reads as "nothing is
  // affected" is the most dangerous output this tool could produce.
  assert.ok(result.radius.some((r) => r.file === 'src/does-not-exist.ts'));
});

test('I1 · nothing in the radius is dropped from the reader-facing lists', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const accounted = new Set([...result.priority.map((p) => p.file), ...result.tests.map((t) => t.file)]);
  const unaccounted = result.radius.filter((r) => !accounted.has(r.file) && !isTestFile(r.file));
  assert.deepEqual(unaccounted, [], 'every non-test radius file must appear in the priority list');
});

test('I4 · every priority score is fully explained by its own factors', () => {
  for (const seed of Object.keys(TRUTH)) {
    for (const item of run(TORTURE, [seed]).result.priority) {
      const sum = item.because.reduce((n, f) => n + f.points, 0);
      assert.equal(sum, item.score, `${item.file}: factors sum to ${sum} but score is ${item.score}`);
      assert.ok(item.because.length > 0, `${item.file} has a score with no reason`);
      for (const f of item.because) assert.ok(f.detail.length > 0, `${item.file}: a factor with no detail`);
    }
  }
});

/**
 * A defensible policy that reads as a broken sort costs more trust than the
 * policy is worth. The first draft let a floor override the tier while leaving
 * the score alone, and printed a Tier 2 row scoring 5 above a Tier 3 row
 * scoring 8.
 */
test('I3 · tiers are monotonic in score, so the order is readable', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const worstOf = (t) => Math.min(...result.priority.filter((p) => p.tier === t).map((p) => p.score));
  const bestOf = (t) => Math.max(...result.priority.filter((p) => p.tier === t).map((p) => p.score));
  for (const t of [1, 2, 3]) {
    const higher = result.priority.filter((p) => p.tier === t);
    const lower = result.priority.filter((p) => p.tier === t + 1);
    if (higher.length === 0 || lower.length === 0) continue;
    assert.ok(worstOf(t) >= bestOf(t + 1), `tier ${t} scores dip below tier ${t + 1}`);
  }
});

test('I2 · a file we could not analyse is never deprioritised below Tier 2', () => {
  for (const seed of Object.keys(TRUTH)) {
    for (const item of run(TORTURE, [seed]).result.priority) {
      if (item.band === 'unknown') {
        assert.ok(item.tier <= 2, `${item.file} is unknown but sits in Tier ${item.tier}`);
      }
    }
  }
});

test('a test file is something you run, so it never appears as something to test', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  assert.deepEqual(result.priority.filter((p) => isTestFile(p.file)), []);
  assert.ok(result.tests.length >= 2, 'the fixture has two e2e specs downstream of the change');
  for (const t of result.tests) assert.ok(isTestFile(t.file));
});

test('coverage attribution agrees with the gaps it is derived from', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const covered = new Set(result.tests.flatMap((t) => t.coversDirectly));
  for (const gap of result.gaps) {
    if (/no test in this repository reaches/.test(gap.reason)) {
      assert.ok(!covered.has(gap.file), `${gap.file} is called both covered and uncovered`);
    }
  }
  // The fixture's specs reach the change only through a config route, so the
  // honest reading is "indirect", and the gap must say so rather than claiming
  // the change is tested.
  const priceGap = result.gaps.find((g) => g.file === 'src/services/PriceService.ts');
  assert.ok(/only indirectly/.test(priceGap.reason), priceGap.reason);
});

test('I4 · gaps are one entry per file, so a gap count is a file count', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts', 'src/services/flags.ts']);
  const files = result.gaps.map((g) => g.file);
  assert.equal(new Set(files).size, files.length);
});

/**
 * The failure this tool has to avoid is not being wrong — it is being
 * confidently incomplete. A radius with no caveat reads as "the impact is
 * exactly this", and a lead who believes that ships untested code.
 */
test('I1 · the result states its own incompleteness', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const { completeness } = result;
  assert.ok(/at least these/.test(completeness.verdict), completeness.verdict);
  assert.ok(completeness.signalsAbsent.length > 0, 'signals that did not contribute must be named');
  for (const s of completeness.signalsAbsent) assert.ok(s.why.length > 0);
  // Never claim a mechanism ran when this run could not run it.
  const contract = completeness.signalsAbsent.find((s) => s.signal === 'contract');
  assert.ok(/not read at the merge base/.test(contract.why), contract.why);
  assert.ok(!/nothing in this change triggered it/.test(contract.why));
  // Tier 4's label must not read as permission to skip.
  assert.ok(!/unaffected|safe|no impact/i.test(TIER_LABEL[4]), TIER_LABEL[4]);
  assert.ok(result.brief.some((l) => /could not rule/.test(l)));
});

test('the per-signal counterfactual reports what each signal is worth', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const byName = new Map(result.completeness.signalsRun.map((s) => [s.signal, s]));
  // The name index is the signal that earns its keep on this fixture: css
  // classes, i18n keys and a DI key are all it. If it ever reports zero, the
  // cross-language coupling has been lost again.
  assert.ok(byName.get('name').filesAdded > 0, 'the name signal found nothing unique');
  assert.ok(byName.get('import').edges > 0);
  for (const s of result.completeness.signalsRun) {
    assert.ok(s.filesAdded >= 0 || s.filesAdded === -1, `${s.signal}: nonsense counterfactual`);
  }
});

test('a semantic diff turns a changed file into a breaking one, and Tier 1', () => {
  const before = readAst(TORTURE, 'src/services/PriceService.ts');
  assert.ok(before, 'the fixture file must be readable');
  // Pretend the merge-base version exported one more symbol: removing an
  // export is the textbook breaking change.
  const withExtra = { ...before, exports: [...before.exports, 'formatLegacyPrice'] };
  const { result, diffs } = run(TORTURE, ['src/services/PriceService.ts'], {
    baseReadings: new Map([['src/services/PriceService.ts', withExtra]]),
  });
  const breaking = diffs.flatMap((d) => d.changes).filter((c) => c.severity === 'breaking');
  assert.ok(
    breaking.some((c) => /export removed: formatLegacyPrice/.test(c.what)),
    JSON.stringify(breaking),
  );
  const item = result.priority.find((p) => p.file === 'src/services/PriceService.ts');
  assert.equal(item.tier, 1, 'a breaking change is never below Tier 1');
  assert.ok(item.because.some((f) => f.factor === 'breaking change'));
  assert.ok(result.brief.some((l) => /breaking/.test(l)));
  // And with base readings supplied, contract is no longer excused.
  const contract = result.completeness.signalsAbsent.find((s) => s.signal === 'contract');
  if (contract) assert.ok(!/not read at the merge base/.test(contract.why));
});

const JAVA = join(REPO, 'fixtures', 'java');

/**
 * Java was added for enterprise reach, and for one commit the front end was
 * built, tested, and never called by the orchestrator: a Java repository got a
 * radius of one — the changed file and nothing else. The front end passing its
 * own unit tests said nothing about that, because the hole was in the wiring.
 */
test('a Java repository is analysed, not just parsed', () => {
  const { result } = run(JAVA, ['src/main/java/com/acme/orders/OrderService.java']);
  assert.ok(result.radius.length > 1, 'a Java change must reach something downstream of it');
  assert.ok(
    result.radius.some((r) => r.file.endsWith('OrderController.java')),
    'the controller depends on the service and must be in the radius',
  );
  // The routes come from annotations, so they are declarations and belong in
  // the surface inventory as they are written.
  const routes = result.surfaces.filter((s) => s.kind === 'endpoint').map((s) => s.id);
  assert.deepEqual(routes, ['GET /api/orders/{id}', 'POST /api/orders/{id}/cancel']);
});

test('the Java test naming convention is a coverage signal, not a guess', () => {
  const { result } = run(JAVA, ['src/main/java/com/acme/orders/OrderService.java']);
  const test_ = result.tests.find((t) => t.file.endsWith('OrderServiceTest.java'));
  assert.ok(test_, 'OrderServiceTest names OrderService as its subject');
  assert.deepEqual(test_.coversDirectly, ['src/main/java/com/acme/orders/OrderService.java']);
  // The edge must say it came from the convention, so nobody mistakes it for
  // evidence that a line was executed.
  const item = result.radius.find((r) => r.file.endsWith('OrderServiceTest.java'));
  assert.ok(
    item.why.some((w) => w.signal === 'name' && /names OrderService as its subject/.test(w.detail)),
    JSON.stringify(item.why),
  );
});

test('@Transactional is declaration-strength evidence that a Java file writes', () => {
  const { result } = run(JAVA, ['src/main/java/com/acme/orders/OrderService.java']);
  const item = result.priority.find((p) => p.file.endsWith('OrderService.java'));
  const mutation = item.because.find((f) => f.factor === 'mutation');
  assert.ok(mutation, 'a @Transactional method writes, and the tiering must know it');
  assert.match(mutation.detail, /@Transactional/);
});

/**
 * Two true sentences that read as one contradiction cost the same trust as a
 * false one. "Every changed file has a test" printed above "2 surfaces have no
 * test" was both accurate and unbelievable.
 */
test('the brief never claims coverage it contradicts elsewhere', () => {
  for (const [root, seed] of [
    [JAVA, 'src/main/java/com/acme/orders/OrderService.java'],
    [TORTURE, 'src/services/PriceService.ts'],
  ]) {
    const { result } = run(root, [seed]);
    const untested = result.surfaces.filter((s) => s.directTests.length === 0 && s.indirectTests.length === 0);
    const claimsAllCovered = result.brief.some((l) => /every affected surface has one too/.test(l));
    if (untested.length > 0) {
      assert.equal(claimsAllCovered, false, `${root}: claims full coverage with ${untested.length} untested surfaces`);
    }
  }
});

// ---- what a manager needs, which the engine already had the data for -----

test('ownership prefers the declaration and labels the evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teslon-owners-'));
  try {
    cpSync(TORTURE, dir, { recursive: true });
    writeFileSync(
      join(dir, 'CODEOWNERS'),
      [
        '# comment line, ignored',
        '*                       @platform',
        'src/services/           @payments @platform',
        '/src/services/flags.ts  @growth',
      ].join('\n'),
    );
    const { result } = run(dir, ['src/services/PriceService.ts']);
    const service = result.priority.find((p) => p.file === 'src/services/PriceService.ts');
    // Last matching rule wins — CODEOWNERS' own precedence, not gitignore's.
    assert.deepEqual(service.owners, ['@payments', '@platform']);
    assert.equal(service.ownerSource, 'CODEOWNERS');

    const flags = result.priority.find((p) => p.file === 'src/services/flags.ts');
    if (flags) assert.deepEqual(flags.owners, ['@growth'], 'the anchored, more specific rule comes last and wins');

    // A pattern with no slash matches at any depth; one with a slash is
    // anchored. Getting that backwards assigns the whole tree to one team and
    // still looks like a working feature.
    const json = result.priority.find((p) => p.file === 'src/config/routes.json');
    if (json) assert.deepEqual(json.owners, ['@platform']);

    assert.ok(result.ownership.length > 0);
    assert.ok(result.brief.some((l) => /^Ask /.test(l)), JSON.stringify(result.brief));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an undeclared owner on a Tier 1 file is reported as a gap in the repository', () => {
  const { result } = run(TORTURE, ['src/services/PriceService.ts']);
  const tier1Undeclared = result.priority.filter((p) => p.tier === 1 && p.ownerSource === 'none');
  if (tier1Undeclared.length > 0) {
    assert.ok(
      result.limitations.some((l) => /no declared owner/.test(l.what)),
      'a Tier 1 file nobody owns must be said out loud',
    );
  }
});

/**
 * Effort is counted in cases and never converted to hours. Velocity and
 * familiarity are not in the repository, so a duration would be two thirds
 * invented — and it would be the number quoted in a planning meeting.
 */
test('effort is counted, attributable, and never expressed as time', () => {
  const before = readAst(TORTURE, 'src/services/PriceService.ts');
  const withExtra = { ...before, exports: [...before.exports, 'formatLegacyPrice'] };
  const { result } = run(TORTURE, ['src/services/PriceService.ts'], {
    baseReadings: new Map([['src/services/PriceService.ts', withExtra]]),
  });
  const { effort } = result;
  assert.equal(
    effort.minimumCases,
    effort.lines.reduce((n, l) => n + l.cases, 0),
    'the total must be the sum of its named lines',
  );
  assert.ok(effort.lines.some((l) => /breaking changes/.test(l.reason)), JSON.stringify(effort.lines));
  for (const l of effort.lines) assert.ok(l.cases > 0 && l.examples.length > 0, `${l.reason} has no examples`);
  assert.doesNotMatch(JSON.stringify(effort), /\bhours?\b(?!,)/i);
  assert.match(effort.note, /will not turn this into hours/);
});

test('build output is not reported as a language nobody reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teslon-artifacts-'));
  try {
    cpSync(TORTURE, dir, { recursive: true });
    writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{"program":{}}');
    writeFileSync(join(dir, 'app.min.js'), 'var a=1;');
    const { result } = run(dir, ['src/services/PriceService.ts']);
    for (const f of result.completeness.unreadable) {
      assert.doesNotMatch(f, /tsbuildinfo|min\.js/, `${f} is build output, not a hole in the analysis`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- history: what the repository did, not what the code says ------------

test('co-change links files that move together and refuses to link sweeps', () => {
  // client and its mock move together; unrelated.ts just happens to be busy.
  const commits = [
    ['src/client.ts', 'test/client.mock.ts'],
    ['src/client.ts', 'test/client.mock.ts'],
    ['src/client.ts', 'test/client.mock.ts'],
    ['src/unrelated.ts'],
    ['src/unrelated.ts'],
    ['src/unrelated.ts'],
    ['src/unrelated.ts', 'src/client.ts'],
  ];
  const { edges, commitsRead } = coChangeEdges(commits);
  assert.equal(commitsRead, 4);
  const pairs = new Set(edges.map((e) => [e.from, e.to].sort().join(' ~ ')));
  assert.ok(pairs.has('src/client.ts ~ test/client.mock.ts'), [...pairs].join(', '));
  // One shared commit out of four is coincidence, not coupling.
  assert.ok(!pairs.has('src/client.ts ~ src/unrelated.ts'), [...pairs].join(', '));
  // History does not say which one leads, so both directions exist.
  assert.equal(edges.filter((e) => e.from === 'src/client.ts').length, 1);
  assert.equal(edges.filter((e) => e.to === 'src/client.ts').length, 1);
  for (const e of edges) assert.equal(e.why.signal, 'cochange');
});

/**
 * A commit that moves 200 files is a rename or a reformat. Reading it as
 * coupling links every pair in it — 19,900 false edges from one commit — and
 * the files must still count toward how often each one changes, or the
 * surviving pairs are made to look stronger than they are.
 */
test('a sweeping commit is excluded from coupling but still counted as change', () => {
  const sweep = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
  const commits = [sweep, sweep, sweep, ['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']];
  const { edges, commitsRead, commitsSkipped, limitations } = coChangeEdges(commits);
  assert.equal(commitsSkipped, 3);
  assert.equal(commitsRead, 3);
  assert.ok(!edges.some((e) => /f0|f1\b/.test(e.from)), 'the sweep must not couple its files');
  assert.ok(edges.some((e) => e.from === 'src/a.ts' && e.to === 'src/b.ts'));
  assert.ok(limitations.some((l) => /more than 40 files/.test(l.what)));
  assert.doesNotMatch(limitations[0].what, /commit touched.*were not/, 'singular commit, singular verb');
});

test('I3 · co-change is deterministic regardless of commit order within a set', () => {
  const commits = [
    ['b.ts', 'a.ts'],
    ['a.ts', 'b.ts'],
    ['b.ts', 'a.ts'],
  ];
  const one = coChangeEdges(commits);
  const two = coChangeEdges([...commits].reverse());
  assert.equal(JSON.stringify(one.edges), JSON.stringify(two.edges));
});

test('a dependency bump with no source diff is not an empty radius', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teslon-lock-'));
  try {
    cpSync(TORTURE, dir, { recursive: true });
    writeFileSync(
      join(dir, 'src/uses-dates.ts'),
      "import { format } from 'date-fns';\nimport _ from 'lodash/fp';\nexport const f = () => format(new Date(), 'x') + _.identity(1);\n",
    );
    const before = JSON.stringify({
      packages: { 'node_modules/date-fns': { version: '2.30.0' }, 'node_modules/lodash': { version: '4.17.21' } },
    });
    const after = JSON.stringify({
      packages: { 'node_modules/date-fns': { version: '3.0.0' }, 'node_modules/lodash': { version: '4.17.21' } },
    });
    writeFileSync(join(dir, 'package-lock.json'), after);

    const { result } = run(dir, ['package-lock.json'], {
      lockfile: { file: 'package-lock.json', before, after },
    });

    const reached = result.radius.find((r) => r.file === 'src/uses-dates.ts');
    assert.ok(reached, 'the file importing the bumped package must be in the radius');
    const why = reached.why.find((w) => w.signal === 'lockfile');
    assert.ok(why, JSON.stringify(reached.why));
    assert.match(why.detail, /date-fns, which moved 2\.30\.0 → 3\.0\.0/);
    // lodash did not move, so importing it is not a reason.
    assert.doesNotMatch(JSON.stringify(reached.why), /lodash/);
    assert.ok(result.limitations.some((l) => /moved with no change to their own source/.test(l.what)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lockfile versions are read from all three formats', () => {
  const npm = lockfileVersions(
    JSON.stringify({ packages: { 'node_modules/@scope/pkg': { version: '1.2.3' }, 'node_modules/plain': { version: '4.5.6' } } }),
    'package-lock.json',
  );
  assert.equal(npm.get('@scope/pkg'), '1.2.3');
  assert.equal(npm.get('plain'), '4.5.6');

  const yarn = lockfileVersions('lodash@^4.17.0:\n  version "4.17.21"\n\n"@scope/x@^1.0.0":\n  version "1.4.0"\n', 'yarn.lock');
  assert.equal(yarn.get('lodash'), '4.17.21');
  assert.equal(yarn.get('@scope/x'), '1.4.0');

  const pnpm = lockfileVersions("packages:\n  /lodash@4.17.21:\n    resolution: {}\n  /@scope/y@2.0.1:\n    resolution: {}\n", 'pnpm-lock.yaml');
  assert.equal(pnpm.get('lodash'), '4.17.21');
  assert.equal(pnpm.get('@scope/y'), '2.0.1');
});

// ---- the fabrications, fixed at the source rather than suppressed --------

/**
 * All three fabricated surfaces came from the profiler reading prose. The
 * endpoint `GET /x` was matched in a line documenting decorator syntax; the
 * background job was matched on `Set.add('literal')`.
 */
test('the profiler reads code, never the prose around it', () => {
  const selfRead = join(REPO, 'packages', 'core', 'src', 'profile', 'ast.ts');
  assert.ok(readFileSync(selfRead, 'utf8').includes("@Get('/x')"), 'the comment this test guards must still exist');

  const p = profileFile(REPO, 'packages/core/src/profile/ast.ts');
  assert.equal(p.http, undefined, 'a decorator inside a comment is not a route');
  assert.deepEqual(p.sideEffects, [], 'Set.add() is not a job queue');

  // And the real thing still reads.
  const real = profileFile(join(REPO, 'fixtures', 'api'), 'api/cancelOrder.ts');
  assert.deepEqual(real.http, { method: 'POST', path: '/api/orders/:orderId/cancel' });
  assert.equal(real.httpFrom, 'decorator');
  assert.ok(real.sideEffects.includes('sends email'));
});

test('stripComments keeps the strings a route lives in', () => {
  assert.equal(stripComments("const a = 'http://x/y'; // gone"), "const a = 'http://x/y'; ");
  assert.equal(stripComments('const a = `a//b`;'), 'const a = `a//b`;');
  assert.equal(stripComments("const a = 1; /* gone */ const b = 2;"), 'const a = 1;   const b = 2;');
  // An escaped quote does not close the string, so the whole thing — comment
  // text included — is inside it and stripComments must leave it alone.
  assert.equal(stripComments("const s = '\\'; // real'"), "const s = '\\'; // real'");
});
