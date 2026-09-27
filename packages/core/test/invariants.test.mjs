import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listFiles,
  buildImportGraph,
  buildNameIndex,
  walk,
  profileFile,
  dataCouplingEdges,
  strongerBand,
  bandRank,
  nameIndexLimitation,
  defaultMaxFiles,
} from '../dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const TORTURE = join(REPO, 'fixtures', 'torture');
const API = join(REPO, 'fixtures', 'api');

/** Combined reverse adjacency from every signal we have so far. */
function reverseAdjacency(root) {
  const files = listFiles(root);
  const graph = buildImportGraph(root, files);
  const names = buildNameIndex(root, files);

  const rev = new Map(files.map((f) => [f, new Set()]));
  for (const e of [...graph.edges, ...names.edges]) {
    rev.get(e.from)?.add(e.to);
  }
  return { files, rev, graph, names };
}

test('I3 · determinism: the same repository analysed twice is byte-identical', () => {
  const once = JSON.stringify(buildNameIndex(TORTURE, listFiles(TORTURE)).edges);
  const twice = JSON.stringify(buildNameIndex(TORTURE, listFiles(TORTURE)).edges);
  assert.equal(once, twice);

  const g1 = JSON.stringify(buildImportGraph(TORTURE, listFiles(TORTURE)).edges);
  const g2 = JSON.stringify(buildImportGraph(TORTURE, listFiles(TORTURE)).edges);
  assert.equal(g1, g2);
});

test('I3 · file listing is sorted and stable', () => {
  const files = listFiles(TORTURE);
  assert.deepEqual(files, [...files].sort());
  assert.deepEqual(files, listFiles(TORTURE));
});

test('I4 · every edge carries a signal and a non-empty reason', () => {
  const { graph, names } = reverseAdjacency(TORTURE);
  for (const e of [...graph.edges, ...names.edges]) {
    assert.ok(e.why.signal, `edge ${e.from} -> ${e.to} has no signal`);
    assert.ok(e.why.detail.length > 0, `edge ${e.from} -> ${e.to} has an empty reason`);
  }
});

test('I1 · an unparseable file widens the radius instead of shrinking it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    cpSync(TORTURE, tmp, { recursive: true });

    const before = walk(reverseAdjacency(tmp).rev, ['src/services/PriceService.ts']).size;

    // A file we cannot parse must never make the answer smaller.
    writeFileSync(join(tmp, 'src/services/broken.ts'), '\u0000\u0001 not valid source {{{');
    const after = walk(reverseAdjacency(tmp).rev, ['src/services/PriceService.ts']).size;

    assert.ok(after >= before, `radius shrank from ${before} to ${after} after adding an unparseable file`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('I1 · band merging only ever moves toward certainty', () => {
  assert.equal(strongerBand('possible', 'certain'), 'certain');
  assert.equal(strongerBand('certain', 'look'), 'certain');
  assert.equal(strongerBand('look', 'likely'), 'likely');
  // A thing we failed to analyse outranks anything we merely inferred, and
  // every band has a distinct rank so merge order can never decide the result.
  assert.ok(bandRank('unknown') > bandRank('likely'));
  assert.equal(new Set(['certain','unknown','likely','possible','look'].map(bandRank)).size, 5);
  assert.equal(strongerBand('possible', 'unknown'), 'unknown');
  assert.equal(strongerBand('unknown', 'possible'), 'unknown');
});

test('the import graph alone is the floor, not the product', () => {
  const files = listFiles(TORTURE);
  const graph = buildImportGraph(TORTURE, files);
  const rev = new Map(files.map((f) => [f, new Set()]));
  for (const e of graph.edges) rev.get(e.from)?.add(e.to);

  const found = walk(rev, ['src/styles/price.css']);
  // A stylesheet has no importers, so imports alone find nothing at all.
  assert.equal(found.size, 1, 'expected only the seed itself');
});

test('the name index recovers dependencies the import graph cannot see', () => {
  const { rev } = reverseAdjacency(TORTURE);

  // The DI container keys the price service by the string 'price'.
  const fromPrice = walk(rev, ['src/services/PriceService.ts']);
  assert.ok(fromPrice.has('src/handlers/InvoiceHandler.ts'), 'DI-container consumer not reached');

  // A CSS class is a dependency even though nothing imports the stylesheet.
  const fromCss = walk(rev, ['src/styles/price.css']);
  assert.ok(fromCss.has('src/components/PriceTag.ts'), 'CSS class consumer not reached');

  // A renamed column reaches the query that selects it.
  const fromMigration = walk(rev, ['src/db/migration_004.sql']);
  assert.ok(fromMigration.has('src/db/queries.ts'), 'SQL column consumer not reached');

  // A translation key reaches the component that asks for it.
  const fromI18n = walk(rev, ['src/i18n/en.json']);
  assert.ok(fromI18n.has('src/components/Total.ts'), 'i18n key consumer not reached');
});

test('capability profiles are extracted, not guessed', () => {
  const summary = profileFile(API, 'api/getOrderSummary.ts');
  assert.ok(summary);
  assert.deepEqual(summary.http, { method: 'GET', path: '/api/orders/:orderId/summary' });
  assert.deepEqual(summary.readsTables, ['order_lines', 'orders']);
  assert.deepEqual(summary.writesTables, []);
  assert.equal(summary.nature, 'read-only');
  assert.deepEqual(summary.flags, ['tax-v2']);
  assert.equal(summary.errorPaths.length, 2);

  const cancel = profileFile(API, 'api/cancelOrder.ts');
  assert.ok(cancel);
  assert.equal(cancel.http?.method, 'POST');
  assert.deepEqual(cancel.writesTables, ['orders', 'refunds']);
  assert.equal(cancel.nature, 'mutating');
  assert.ok(cancel.sideEffects.some((s) => s.includes('email')));
});

test('a file we cannot profile is never assumed innocent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    writeFileSync(join(tmp, 'mystery.ts'), 'export const x = someOpaqueThing();');
    const p = profileFile(tmp, 'mystery.ts');
    assert.ok(p);
    assert.equal(p.nature, 'unknown', 'unrecognised code must not be reported as read-only');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('database coupling finds a dependency with no code edge between the two files', () => {
  const profiles = ['api/cancelOrder.ts', 'api/getOrderSummary.ts']
    .map((f) => profileFile(API, f))
    .filter(Boolean);

  const edges = dataCouplingEdges(profiles);
  const edge = edges.find(
    (e) => e.from === 'api/cancelOrder.ts' && e.to === 'api/getOrderSummary.ts',
  );
  assert.ok(edge, 'expected cancelOrder (writes orders) to couple to getOrderSummary (reads orders)');
  assert.match(edge.why.detail, /orders/);

  // And confirm there really is no import between them, which is the point.
  const graph = buildImportGraph(API, listFiles(API));
  const imports = graph.forward.get('api/getOrderSummary.ts') ?? new Set();
  assert.ok(!imports.has('api/cancelOrder.ts'));
});

test('core makes no network calls', () => {
  const src = join(REPO, 'packages', 'core', 'src');
  const offenders = [];
  const scan = (dir) => {
    for (const f of listFiles(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      if (/from\s+'node:(?:http|https|net|dgram|tls)'|\bfetch\s*\(/.test(text)) offenders.push(f);
    }
  };
  scan(src);
  assert.deepEqual(offenders, [], `core must stay offline, found network use in: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Regressions from the first code review. Each of these was a real defect in
// the initial commit; three of them violated an invariant.
// ---------------------------------------------------------------------------

test('regression · the declared auth guard is reported, not a fixed string', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    writeFileSync(
      join(tmp, 'h.ts'),
      '@UseGuards(requireAdmin)\nexport async function del(r: Req): Promise<Res> { return {} as any; }\n',
    );
    // `a ?? b ? c : d` parses as `(a ?? b) ? c : d`, which reported
    // 'requireAuth' for every guarded handler and hid the real guard.
    assert.equal(profileFile(tmp, 'h.ts')?.auth, 'requireAdmin');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('regression · I1 · prose containing a SQL verb does not fake an analysis', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    writeFileSync(
      join(tmp, 'dialog.ts'),
      "export const copy = { title: 'Delete your account', body: 'This cannot be undone' };\n",
    );
    // Matching a bare SQL keyword set nature to 'read-only' on a file we had
    // learnt nothing about — an assumption of innocence.
    assert.equal(profileFile(tmp, 'dialog.ts')?.nature, 'unknown');

    writeFileSync(join(tmp, 'real.ts'), 'await db.query(`DELETE FROM sessions WHERE expired`);\n');
    const real = profileFile(tmp, 'real.ts');
    assert.equal(real?.nature, 'mutating');
    assert.deepEqual(real?.writesTables, ['sessions']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('regression · I1 · dotfiles are visible, so a changed .env can reach the radius', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    writeFileSync(join(tmp, '.env'), 'PAYMENT_GW=stripe\n');
    writeFileSync(join(tmp, 'app.ts'), 'export const x = 1;\n');
    const files = listFiles(tmp);
    assert.ok(files.includes('.env'), 'a file the lister cannot see can never appear in a radius');
    assert.ok(files.includes('app.ts'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('regression · I1/I2 · a discarded name is reported, never dropped in silence', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-'));
  try {
    // 60 files sharing one token, above the adaptive cap for a repo this size.
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(tmp, `m${i}.ts`), "export const K = 'shared.everywhere';\n");
    }
    const index = buildNameIndex(tmp, listFiles(tmp));
    assert.equal(index.edges.length, 0, 'expected the common token to be excluded');
    assert.ok(index.tooCommon.length > 0, 'the exclusion must be recorded');

    const limitation = nameIndexLimitation(index);
    assert.ok(limitation, 'a cap that removes a signal must produce a limitation');
    assert.match(limitation.what, /shared\.everywhere/);
    assert.match(limitation.mitigation, /not in the radius/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the name index cap scales with the repository instead of being fixed', () => {
  // A fixed cap of 12 disabled this index entirely on a 2,000-file repo.
  assert.equal(defaultMaxFiles(100), 12);
  assert.equal(defaultMaxFiles(2000), 40);
  assert.equal(defaultMaxFiles(1_000_000), 120);
});
