import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { impact, brief } from '../dist/index.js';

/**
 * Changes the compiler accepts and Spring refuses (src/engine/startup.ts), and a comment inside a method.
 * Each test is one PR on OrderDesk: a service that may not start has every screen to test; a comment has none.
 */

const APP = fileURLToPath(new URL('../../../fixtures/orderdesk', import.meta.url));
const J = 'src/main/java/com/orderdesk';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (d, f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); assert.ok(t.includes(from), `${f}: ${from}`); writeFileSync(join(d, f), t.replace(from, to)); };

function run(change) {
  const d = mkdtempSync(join(tmpdir(), 'teslon-startup-'));
  try {
    cpSync(APP, d, { recursive: true });
    g(d, 'init', '-q', '-b', 'main');
    g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); g(d, 'config', 'commit.gpgsign', 'false');
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'app');
    const base = g(d, 'rev-parse', 'HEAD');
    change(d);
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'change');
    const r = impact({ repo: d, base, head: g(d, 'rev-parse', 'HEAD') });
    return { r, b: brief(r) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const screens = (b, state) => b.areas.filter((a) => a.id.startsWith('screen:') && a.state === state).map((a) => a.id);

test('a bean moved outside the component scan: the app does not start, every screen is to test', () => {
  const { r, b } = run((d) => {
    const src = readFileSync(join(d, `${J}/service/PricingService.java`), 'utf8').replace('package com.orderdesk.service;', 'package com.pricing;');
    unlinkSync(join(d, `${J}/service/PricingService.java`));
    mkdirSync(join(d, 'src/main/java/com/pricing'), { recursive: true });
    writeFileSync(join(d, 'src/main/java/com/pricing/PricingService.java'), src);
    edit(d, `${J}/service/OrderService.java`, 'import com.orderdesk.service.dto.CreateOrderRequest;', 'import com.orderdesk.service.dto.CreateOrderRequest;\nimport com.pricing.PricingService;');
    edit(d, `${J}/service/ReportService.java`, 'import com.orderdesk.service.dto.DailySalesDto;', 'import com.orderdesk.service.dto.DailySalesDto;\nimport com.pricing.PricingService;');
  });
  assert.deepEqual(screens(b, 'skip'), []);
  assert.ok(r.deltas.some((x) => /may not start: PricingService is in package com\.pricing, outside the component scan/.test(x.title)), r.deltas.map((x) => x.title).join(' | '));
  assert.equal(r.verification.failed.length, 0);
});

test('a derived query on a property the entity does not have: the repository cannot be built', () => {
  const { r, b } = run((d) => {
    edit(d, `${J}/repository/InvoiceRepository.java`, 'findByOrderId(Long orderId)', 'findByOrderNumber(Long orderId)');
    edit(d, `${J}/web/rest/InvoiceResource.java`, 'invoices.findByOrderId(orderId)', 'invoices.findByOrderNumber(orderId)');
  });
  assert.deepEqual(screens(b, 'skip'), []);
  assert.ok(r.deltas.some((x) => /findByOrderNumber\(\) is a derived query, and Invoice has no property orderNumber/.test(x.title)), r.deltas.map((x) => x.title).join(' | '));
});

test('a valid derived query added is no start-up risk', () => {
  const { r } = run((d) => edit(d, `${J}/repository/InvoiceRepository.java`, 'findByOrderId(Long orderId);', 'findByOrderId(Long orderId);\n\n    java.util.List<Invoice> findByOrderCustomerNameOrderByIssuedAtDesc(String name);'));
  assert.ok(!r.deltas.some((x) => /may not start/.test(x.title)), r.deltas.map((x) => x.title).join(' | '));
});

test('a constructor parameter no bean provides: the app does not start', () => {
  const { r, b } = run((d) => edit(d, `${J}/service/OrderService.java`, 'ApplicationEventPublisher events) {', 'ApplicationEventPublisher events, java.time.Clock clock) {'));
  assert.deepEqual(screens(b, 'skip'), []);
  assert.ok(r.deltas.some((x) => /asks for a Clock in its constructor/.test(x.title)));
});

test('a comment inside a method changes nothing: nothing to test', () => {
  const { r, b } = run((d) => edit(d, `${J}/service/PricingService.java`, 'public class PricingService {', 'public class PricingService { /* rounding is HALF_UP, see the tax rules */'));
  assert.equal(b.test, 0, b.areas.filter((a) => a.state === 'test').map((a) => a.id).join(', '));
  void r;
});

test('a comment on a method\'s own line changes nothing either', () => {
  const t = readFileSync(join(APP, `${J}/service/InventoryService.java`), 'utf8');
  const m = /public void \w+\([^)]*\)\s*\{/.exec(t);
  assert.ok(m, 'InventoryService has a void method');
  const { b } = run((d) => edit(d, `${J}/service/InventoryService.java`, m[0], `${m[0]} /* stock moves here */`));
  assert.equal(b.test, 0, b.areas.filter((a) => a.state === 'test').map((a) => a.id).join(', '));
});
