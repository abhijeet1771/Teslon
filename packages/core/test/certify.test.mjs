import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { certify } from '../dist/engine/certify.js';
import { snapshot, changedFiles } from '../dist/engine/snapshot.js';
import { readSpring } from '../dist/engine/spring.js';
import { readFrontend } from '../dist/engine/frontend.js';

/**
 * The skip certificate and its checker (src/engine/certify.ts). It shares facts with the engine, not rules:
 * for an area, it rebuilds what the area depends on over both commits, works out on its own what changed,
 * and holds only when nothing the area runs changed and nothing it runs is unknown. Each test is one PR on
 * the ShopFlow fixture, with areas the checker must refuse and areas it must certify.
 */

const APP = fileURLToPath(new URL('../../../fixtures/shopflow', import.meta.url));
const B = 'billing-service/src/main/java/com/shopflow/billing';
const C = 'catalog-service/src/main/java/com/shopflow/catalog';
const UI = 'frontend/src';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (d, f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); assert.ok(t.includes(from), `${f}: ${from}`); writeFileSync(join(d, f), t.replace(from, to)); };

function check(change, areas) {
  const d = mkdtempSync(join(tmpdir(), 'teslon-certify-'));
  try {
    cpSync(APP, d, { recursive: true });
    g(d, 'init', '-q', '-b', 'main');
    g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); g(d, 'config', 'commit.gpgsign', 'false');
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'app');
    const base = g(d, 'rev-parse', 'HEAD');
    change(d);
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'change');
    const head = g(d, 'rev-parse', 'HEAD');
    const Bs = snapshot(d, base), Hs = snapshot(d, head);
    const c = certify({ base: Bs, head: Hs, fb: readSpring(Bs), fh: readSpring(Hs), ub: readFrontend(Bs), uh: readFrontend(Hs), changes: changedFiles(d, base, head), areas });
    return { c, byArea: new Map(c.proofs.map((p) => [p.area, p])) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test('a changed service method: screens that run it are refused, with the path; screens that do not are certified', () => {
  const { byArea } = check((d) => edit(d, `${C}/service/ProductService.java`, 'findByActiveTrueOrderByName()', 'findByActiveTrueOrderByName().stream().limit(50).toList()'), ['screen:/products', 'screen:/invoices']);
  const p = byArea.get('screen:/products');
  assert.equal(p.ok, false);
  assert.equal(p.blockers[0].kind, 'changed');
  assert.match(p.blockers[0].node, /ProductService\.active/);
  assert.ok(p.blockers[0].chain.some((x) => /GET \/products/.test(x)), p.blockers[0].chain.join(' → '));
  assert.equal(byArea.get('screen:/invoices').ok, true);
});

test('the same inputs give the same certificate digest', () => {
  const change = (d) => edit(d, `${C}/service/ProductService.java`, 'findByActiveTrueOrderByName()', 'findByActiveTrueOrderByName().stream().limit(50).toList()');
  const a = check(change, ['screen:/invoices']).byArea.get('screen:/invoices');
  const b = check(change, ['screen:/invoices']).byArea.get('screen:/invoices');
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
});

test('a comment-only change to a method changes no definition', () => {
  const { c, byArea } = check((d) => edit(d, `${C}/service/ProductService.java`, 'findByActiveTrueOrderByName()', 'findByActiveTrueOrderByName() /* sorted by name */'), ['screen:/products']);
  assert.deepEqual(c.changed, {});
  assert.equal(byArea.get('screen:/products').ok, true);
});

test('a route that moves breaks the links to it on other screens', () => {
  const { byArea } = check((d) => edit(d, `${UI}/router/index.ts`, "{ path: '/orders/:id', name: 'order',", "{ path: '/order/:id', name: 'order',"), ['screen:/orders', 'screen:/products']);
  const p = byArea.get('screen:/orders');
  assert.equal(p.ok, false);
  assert.ok(p.blockers.some((b) => /^(rdef|route|rpath):/.test(b.node)), p.blockers.map((b) => b.node).join(', '));
  assert.equal(byArea.get('screen:/products').ok, true);
});

test('a network call no fact records is an unknown that blocks the skip of the screen that runs it', () => {
  const { c, byArea } = check((d) => {
    const f = `${UI}/views/InvoicesView.vue`;
    edit(d, f, '</script>', "const target = location.hash.slice(1);\nfetch(target);\n</script>");
  }, ['screen:/invoices', 'screen:/products']);
  const p = byArea.get('screen:/invoices');
  assert.equal(p.ok, false);
  assert.ok(p.blockers.some((b) => b.kind === 'unknown' || b.kind === 'changed'));
  assert.ok(c.unknowns.some((u) => ['unread-call', 'unmatched-call', 'opaque'].includes(u.kind) && u.blocks.includes('screen:/invoices')), c.unknowns.map((u) => u.kind).join(', '));
  assert.equal(byArea.get('screen:/products').ok, true);
});

test('a Kafka listener depends on its topic and so on what the producer sends', () => {
  const { byArea } = check((d) => edit(d, `${B}/service/InvoiceService.java`, 'outcome.success(), outcome.failureReason()', 'outcome.success(), null'), ['job:PaymentResultListener.onPaymentResult']);
  const p = byArea.get('job:PaymentResultListener.onPaymentResult');
  // the payload is made by the producer's caller: a content dependence, recorded as relied on
  assert.ok(!p.ok || p.relies.length, 'the listener is refused or relies on the changed producer');
  assert.ok([...p.blockers, ...p.relies].some((b) => /invoiceAndCharge/.test(b.node)), [...p.blockers, ...p.relies].map((b) => b.node).join(', '));
});

test('docs, tests and CI change nothing: every area is certified, with the assumption printed', () => {
  const { c } = check((d) => writeFileSync(join(d, 'README.md'), readFileSync(join(d, 'README.md'), 'utf8') + '\nMore words.\n'), ['screen:/products', 'screen:/orders']);
  assert.ok(c.proofs.every((p) => p.ok));
  assert.ok(c.assumptions.some((a) => /docs/i.test(a.text)));
});

test('a framework setting no code reads reaches every request of its service, not of other services', () => {
  const { byArea } = check((d) => edit(d, 'catalog-service/src/main/resources/application.yml', 'server:', 'server.tomcat.threads.max: 50\nserver:'), ['screen:/products', 'screen:/invoices']);
  assert.equal(byArea.get('screen:/products').ok, false);
  assert.equal(byArea.get('screen:/invoices').ok, true);
});
