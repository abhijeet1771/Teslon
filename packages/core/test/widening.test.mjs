import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFiles, buildImportGraph, buildNameIndex, walkWithParents, profileFile, dataCouplingEdges,
  wideningEdges, configEdgesDetailed, dynamicImportEdges, templateEdges, generatedEdges, runtimeStringEdges,
} from '../dist/index.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const TORTURE = join(REPO, 'fixtures', 'torture');
const TRUTH = JSON.parse(readFileSync(join(REPO, 'fixtures', 'torture-expected', 'torture.json'), 'utf8'));

function measure(root, useWidening) {
  const files = listFiles(root);
  const profiles = files
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
    .map((f) => profileFile(root, f))
    .filter(Boolean);

  const edges = [
    ...buildImportGraph(root, files).edges,
    ...buildNameIndex(root, files).edges,
    ...dataCouplingEdges(profiles),
    ...(useWidening ? wideningEdges(root, files) : []),
  ];
  const rev = new Map(files.map((f) => [f, new Set()]));
  for (const e of edges) rev.get(e.from)?.add(e.to);

  let found = 0, missed = 0, extra = 0;
  for (const [changed, t] of Object.entries(TRUTH)) {
    const reached = new Set([...walkWithParents(rev, [changed]).dist.keys()].filter((f) => f !== changed));
    found += t.expect.filter((e) => reached.has(e)).length;
    missed += t.expect.filter((e) => !reached.has(e)).length;
    extra += [...reached].filter((f) => !t.expect.includes(f)).length;
  }
  return { recall: (found / (found + missed)) * 100, missed, extra };
}

test('the widening layers are what carry recall from two thirds to almost all', () => {
  const without = measure(TORTURE, false);
  const with_ = measure(TORTURE, true);

  // Measured before these layers were written: the shipped engine sat at
  // 69.6% while the nine-layer prototype reached 95.7%. The gap was this.
  assert.ok(without.recall < 75, `expected the base to be around 70%, got ${without.recall.toFixed(1)}%`);
  assert.ok(with_.recall > 94, `expected widening to reach ~95%, got ${with_.recall.toFixed(1)}%`);

  // Safety may cost precision, but not without limit. A tenth of the fixture
  // across seven scenarios is the budget this passes at today.
  assert.ok(with_.extra <= 10, `over-selection regressed to ${with_.extra}`);
});

test('the one remaining miss is the one known to be unreachable', () => {
  const { missed } = measure(TORTURE, true);
  // A five-line copy-pasted function produces too few shingles to tell from
  // coincidence, and lowering the threshold far enough couples unrelated
  // files. It is left uncaught deliberately.
  assert.equal(missed, 1);
});

test('a manifest is not treated as a route table', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-cfg-'));
  try {
    mkdirSync(join(tmp, 'src'));
    for (let i = 0; i < 30; i++) writeFileSync(join(tmp, 'src', `m${i}.ts`), 'export const a = 1;\n');

    // A real mapping: a handful of entries.
    writeFileSync(join(tmp, 'routes.json'), JSON.stringify({ '/a': 'src/m0.ts', '/b': 'src/m1.ts' }));
    // A manifest: mentions everything, means nothing.
    writeFileSync(
      join(tmp, 'tsconfig.json'),
      JSON.stringify({ files: Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`) }),
    );

    const { edges, skipped } = configEdgesDetailed(tmp, listFiles(tmp));
    assert.ok(edges.every((e) => e.to === 'routes.json'), 'only the mapping should produce edges');
    assert.equal(edges.length, 2);
    // tsconfig is excluded by name, so it never even reaches the budget check.
    assert.ok(!skipped.some((s) => s.file === 'routes.json'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a config that references most of the repository is skipped, and says so', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-cfg2-'));
  try {
    mkdirSync(join(tmp, 'src'));
    for (let i = 0; i < 20; i++) writeFileSync(join(tmp, 'src', `m${i}.ts`), 'export const a = 1;\n');
    writeFileSync(
      join(tmp, 'everything.json'),
      JSON.stringify(Array.from({ length: 20 }, (_, i) => `src/m${i}.ts`)),
    );

    const { edges, skipped } = configEdgesDetailed(tmp, listFiles(tmp));
    assert.equal(edges.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].file, 'everything.json');
    assert.ok(skipped[0].references > 10);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unresolvable dynamic import widens to its directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-dyn-'));
  try {
    mkdirSync(join(tmp, 'pages'));
    writeFileSync(join(tmp, 'pages', 'Home.ts'), 'export const h = 1;\n');
    writeFileSync(join(tmp, 'pages', 'About.ts'), 'export const a = 1;\n');
    writeFileSync(join(tmp, 'pages', 'router.ts'), 'export const load = (n: string) => import(`./${n}`);\n');

    const edges = dynamicImportEdges(tmp, listFiles(tmp));
    const targets = edges.filter((e) => e.to === 'pages/router.ts').map((e) => e.from).sort();
    assert.deepEqual(targets, ['pages/About.ts', 'pages/Home.ts']);
    assert.match(edges[0].why.detail, /widened/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('template partials, generated-from headers and runtime strings are edges', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-w-'));
  try {
    writeFileSync(join(tmp, 'invoice.hbs'), '<h1>x</h1>{{> priceRow }}\n');
    writeFileSync(join(tmp, 'priceRow.hbs'), '<div class="price-tag">1</div>\n');
    assert.ok(templateEdges(tmp, listFiles(tmp)).some((e) => e.from === 'priceRow.hbs'));

    writeFileSync(join(tmp, 'openapi.yaml'), 'paths: {}\n');
    writeFileSync(join(tmp, 'client.ts'), '// AUTO-GENERATED from openapi.yaml\nexport const c = 1;\n');
    assert.ok(generatedEdges(tmp, listFiles(tmp)).some((e) => e.from === 'openapi.yaml' && e.to === 'client.ts'));

    writeFileSync(join(tmp, 'style.css'), '.price-tag { color: red; }\n');
    writeFileSync(join(tmp, 'Styled.ts'), 'const v = "tag"; export const cls = `price-${v}`;\n');
    assert.ok(runtimeStringEdges(tmp, listFiles(tmp)).some((e) => e.to === 'Styled.ts'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('widening is deterministic', () => {
  const files = listFiles(TORTURE);
  assert.equal(
    JSON.stringify(wideningEdges(TORTURE, files)),
    JSON.stringify(wideningEdges(TORTURE, files)),
  );
});
