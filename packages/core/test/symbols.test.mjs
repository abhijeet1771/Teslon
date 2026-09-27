import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listFiles,
  buildSymbolEdges,
  proofPaths,
  shortestPathPerDestination,
  exportedSymbols,
} from '../dist/index.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const CHAIN = join(REPO, 'fixtures', 'chain');

const dest = (p) => p.steps.at(-1).file;

test('two symbols in one file have different blast radii', () => {
  const edges = buildSymbolEdges(CHAIN, listFiles(CHAIN));

  const fromFormat = shortestPathPerDestination(
    proofPaths(edges, 'src/utils/money.ts', 'formatMoney'),
  ).map(dest);
  const fromDiscount = shortestPathPerDestination(
    proofPaths(edges, 'src/utils/money.ts', 'applyDiscount'),
  ).map(dest);

  // This is the whole point of symbol-level edges: a file-level graph would
  // report all three pages for either change.
  assert.ok(fromFormat.includes('src/pages/CheckoutPage.tsx'));
  assert.ok(fromFormat.includes('src/pages/AdminBillingPage.tsx'));
  assert.ok(!fromFormat.includes('src/pages/PromoPage.tsx'));

  assert.deepEqual(fromDiscount, ['src/pages/PromoPage.tsx']);
});

test('a proof path is a complete chain, not just a destination', () => {
  const edges = buildSymbolEdges(CHAIN, listFiles(CHAIN));
  const path = shortestPathPerDestination(proofPaths(edges, 'src/utils/money.ts', 'formatMoney')).find(
    (p) => dest(p) === 'src/pages/CheckoutPage.tsx',
  );

  assert.ok(path);
  assert.deepEqual(
    path.steps.map((s) => s.file),
    ['src/components/PriceTag.tsx', 'src/components/CartSummary.tsx', 'src/pages/CheckoutPage.tsx'],
  );
  assert.equal(path.exact, true, 'every hop named a symbol, so the proof is exact');
  assert.equal(path.origin.symbol, 'formatMoney');
});

test('a default or namespace import widens instead of vanishing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-sym-'));
  try {
    writeFileSync(join(tmp, 'lib.ts'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(join(tmp, 'named.ts'), "import { a } from './lib';\nexport const x = a;\n");
    writeFileSync(join(tmp, 'star.ts'), "import * as lib from './lib';\nexport const y = lib;\n");

    const edges = buildSymbolEdges(tmp, listFiles(tmp));

    // The named import is attributable; the namespace import is not, so it
    // binds the whole module rather than disappearing from the graph.
    assert.ok(edges.some((e) => e.to === 'named.ts' && e.symbol === 'a' && e.kind === 'named'));
    assert.ok(edges.some((e) => e.to === 'star.ts' && e.symbol === '*' && e.kind === 'namespace'));

    // Changing `b` must still reach star.ts, which never named it.
    const reached = proofPaths(edges, 'lib.ts', 'b').map(dest);
    assert.ok(reached.includes('star.ts'), 'a namespace importer must stay in the radius');

    const widened = proofPaths(edges, 'lib.ts', 'b').find((p) => dest(p) === 'star.ts');
    assert.equal(widened.exact, false, 'a widened path must not claim to be exact');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('re-exports through a barrel file carry the dependency onward', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-sym-'));
  try {
    mkdirSync(join(tmp, 'utils'));
    writeFileSync(join(tmp, 'utils', 'money.ts'), 'export const fmt = (n: number) => n;\n');
    writeFileSync(join(tmp, 'utils', 'index.ts'), "export { fmt } from './money';\n");
    writeFileSync(join(tmp, 'page.ts'), "import { fmt } from './utils';\nexport const p = fmt;\n");

    const edges = buildSymbolEdges(tmp, listFiles(tmp));
    const reached = proofPaths(edges, 'utils/money.ts', 'fmt').map(dest);
    assert.ok(reached.includes('page.ts'), 'a barrel must not break the chain');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a cycle terminates instead of hanging', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-sym-'));
  try {
    writeFileSync(join(tmp, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
    writeFileSync(join(tmp, 'b.ts'), "import { a } from './a';\nexport const b = a;\n");
    const edges = buildSymbolEdges(tmp, listFiles(tmp));
    const paths = proofPaths(edges, 'a.ts', 'a', { maxPaths: 50 });
    assert.ok(paths.length > 0 && paths.length <= 50);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('symbol extraction and edges are deterministic', () => {
  const files = listFiles(CHAIN);
  assert.equal(JSON.stringify(buildSymbolEdges(CHAIN, files)), JSON.stringify(buildSymbolEdges(CHAIN, files)));
  assert.deepEqual(exportedSymbols(CHAIN, 'src/utils/money.ts'), ['applyDiscount', 'formatMoney']);
});
