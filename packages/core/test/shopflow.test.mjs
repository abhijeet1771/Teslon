import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { impact, brief } from '../dist/index.js';

/**
 * The rules ShopFlow needed (bench/probes/catalog-shopflow.mjs): services that
 * talk through Kafka and Feign, MapStruct mappers, and a Vue 3 front end on an
 * axios instance, Pinia stores and lazy routes. Each test is one PR on the
 * fixture, with the area the rule must reach and the one it must not.
 */

const APP = fileURLToPath(new URL('../../../fixtures/shopflow', import.meta.url));
const O = 'orders-service/src/main/java/com/shopflow/orders';
const B = 'billing-service/src/main/java/com/shopflow/billing';
const C = 'catalog-service/src/main/java/com/shopflow/catalog';
const N = 'notification-service/src/main/java/com/shopflow/notifications';
const E = 'shared-events/src/main/java/com/shopflow/events';
const UI = 'frontend/src';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (d, f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); assert.ok(t.includes(from), `${f}: ${from}`); writeFileSync(join(d, f), t.replace(from, to)); };

function run(change) {
  const d = mkdtempSync(join(tmpdir(), 'teslon-shopflow-'));
  try {
    cpSync(APP, d, { recursive: true });
    g(d, 'init', '-q', '-b', 'main');
    g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); g(d, 'config', 'commit.gpgsign', 'false');
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'app');
    const base = g(d, 'rev-parse', 'HEAD');
    change(d);
    g(d, 'add', '-A'); g(d, 'commit', '-qm', 'change');
    const r = impact({ repo: d, base, head: g(d, 'rev-parse', 'HEAD') });
    assert.equal(r.verification.failed.length, 0, `citations re-check: ${r.verification.failed.map((h) => `${h.file}:${h.line}`).join(', ')}`);
    const b = brief(r);
    return { r, b, state: (id) => b.areas.find((a) => a.id === id)?.state ?? 'absent', area: (id) => b.areas.find((a) => a.id === id) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const said = (r) => [...r.deltas.map((d) => d.title), ...r.cases.map((c) => `${c.do} ${c.expect}`), ...r.unseen.map((u) => `${u.what} ${u.why}`)].join('\n');

test('Vue: lazy routes are screens, and calls through an axios instance carry its base URL to the gateway', () => {
  const { state } = run((d) => edit(d, `${UI}/api/orders.ts`, '`/orders/${id}/cancel`', '`/orders/${id}/cancellation`'));
  // every route is lazy (() => import(…)): all nine are read, and only the page that cancels is listed
  assert.equal(state('screen:/orders/:id'), 'test');
  for (const s of ['/', '/orders', '/orders/new', '/invoices', '/products']) assert.equal(state(`screen:${s}`), 'skip', s);
});

test('Vue: a screen that imports an API module but uses none of its changed members is skipped, with the members as proof', () => {
  const { area } = run((d) => edit(d, `${UI}/api/invoices.ts`, '`/invoices/by-order/${orderId}`', '`/invoices?orderId=${orderId}`'));
  assert.equal(area('screen:/orders/:id').state, 'test');
  assert.equal(area('screen:/invoices').state, 'skip');
  assert.match(area('screen:/invoices').why, /uses none of what changed in it \(invoicesApi\.byOrder\)/);
});

test('Vue: a Pinia getter reaches only the screens that read it', () => {
  const { state } = run((d) => edit(d, `${UI}/stores/orders.ts`, "o.status === 'PLACED' || o.status === 'PAID'", "o.status === 'PLACED'"));
  assert.equal(state('screen:/'), 'test');
  assert.equal(state('screen:/orders'), 'skip');
});

test('Vue: a navigation guard reaches the routes whose meta it tests', () => {
  const { state } = run((d) => edit(d, `${UI}/router/index.ts`, "router.beforeEach((to) => {\n  if (to.meta.requiresAdmin && !isAdmin()) {\n    return { name: 'home' };\n  }\n});\n", ''));
  assert.equal(state('screen:/products/:sku/edit'), 'test');
  assert.equal(state('screen:/products'), 'skip');
});

test('Vue: a link removed from the navbar the root draws is on every screen', () => {
  const { b } = run((d) => edit(d, `${UI}/components/NavBar.vue`, '    <RouterLink to="/invoices">Invoices</RouterLink>\n', ''));
  assert.ok(b.areas.filter((a) => a.id.startsWith('screen:')).every((a) => a.state === 'test'));
});

test('Kafka: a consumer on a topic nothing publishes is listed first, and what it would have written is held', () => {
  const { state, r } = run((d) => edit(d, `${B}/messaging/OrderPlacedConsumer.java`, '@KafkaListener(topics = Topics.ORDER_PLACED, groupId = "billing")', '@KafkaListener(topics = "shop.order.placed", groupId = "billing")'));
  assert.equal(state('job:OrderPlacedConsumer.onOrderPlaced'), 'test');
  assert.match(said(r), /nothing in this repository publishes shop\.order\.placed/);
  // no invoice, so the invoice pages show the change though they run none of it; the orders listener downstream too
  assert.equal(state('screen:/invoices'), 'unclear');
  assert.equal(state('job:PaymentResultListener.onPaymentResult'), 'test');
});

test('Kafka: a producer that moves to another topic leaves every consumer of the old one without records', () => {
  const { state, r } = run((d) => edit(d, `${O}/messaging/OrderEventsPublisher.java`, 'kafkaTemplate.send(Topics.ORDER_PLACED,', 'kafkaTemplate.send("orders-placed",'));
  for (const j of ['OrderPlacedConsumer.onOrderPlaced', 'StockReservationListener.onOrderPlaced', 'OrderNotificationsListener.onOrderEvent']) assert.equal(state(`job:${j}`), 'test', j);
  assert.ok(r.unseen.some((u) => /who consumes orders-placed/.test(u.what)));
});

test('Kafka: a topic resolved through ${…} settings; a constant renamed on one side splits the services', () => {
  const { state } = run((d) => edit(d, `${E}/Topics.java`, '"shop.payments.result"', '"shop.payments.results"'));
  // notification-service reads the topic from ${shopflow.topics.payments}, which still says shop.payments.result
  assert.equal(state('job:PaymentFailedListener.onPaymentResult'), 'test');
});

test('Kafka: a new consumer group is said, with what it means for offsets', () => {
  const { state, r } = run((d) => edit(d, `${C}/messaging/StockReservationListener.java`, 'groupId = "catalog"', 'groupId = "catalog-v2"'));
  assert.equal(state('job:StockReservationListener.onOrderPlaced'), 'test');
  assert.match(said(r), /consumer group is now catalog-v2 \(was catalog\)/);
  assert.match(said(r), /auto-offset-reset/);
});

test('Kafka: consumer settings reach the service\'s listeners, not its API', () => {
  const { state } = run((d) => edit(d, 'billing-service/src/main/resources/application.yml', 'spring.json.trusted.packages: com.shopflow.events', 'spring.json.trusted.packages: com.shopflow.event'));
  assert.equal(state('job:OrderPlacedConsumer.onOrderPlaced'), 'test');
  assert.equal(state('job:OrderCancelledConsumer.onOrderCancelled'), 'test');
  assert.notEqual(state('screen:/products'), 'test');
});

test('a removed guard before a write, in a method only a listener runs, holds the screens that show what it writes', () => {
  const { state } = run((d) => edit(d, `${O}/service/OrderService.java`, '        if (order.getStatus() == OrderStatus.CANCELLED) {\n            return;\n        }\n', ''));
  assert.equal(state('job:PaymentResultListener.onPaymentResult'), 'test');
  for (const s of ['/', '/orders', '/orders/:id']) assert.notEqual(state(`screen:${s}`), 'skip', s);
});

test('a setter writes the entity its receiver is typed as, not every entity with a field of that name', () => {
  const { state } = run((d) => edit(d, `${N}/service/Mailer.java`, 'n.setStatus("SENT");', 'n.setStatus("DELIVERED");'));
  // Order, Invoice and Notification all have a status: only Notification's is written here
  assert.notEqual(state('screen:/notifications'), 'skip');
  for (const s of ['/', '/orders', '/invoices']) assert.equal(state(`screen:${s}`), 'skip', s);
});

test('MapStruct: a changed @Mapping names the field; into a @MappingTarget entity it is a write', () => {
  const { state, r } = run((d) => edit(d, `${C}/mapper/ProductMapper.java`, '    @Mapping(target = "active", ignore = true)\n', '    @Mapping(target = "active", ignore = true)\n    @Mapping(target = "price", ignore = true)\n'));
  assert.ok(r.deltas.some((x) => /ProductMapper\.update\(\): price is no longer filled/.test(x.title)));
  assert.equal(state('screen:/products/:sku/edit'), 'test');
  assert.notEqual(state('screen:/products'), 'skip');
});

test('Feign: a field the provider no longer sends is said where the other service reads it', () => {
  const { r } = run((d) => edit(d, `${C}/web/ProductDto.java`, 'BigDecimal price, int stock', 'BigDecimal unitPrice, int stock'));
  assert.ok(r.deltas.some((x) => /ProductView\.price is read by orders-service, but ProductDto no longer sends "price"/.test(x.title)));
});

test('an implementation the settings switch off is said, and its data is not held', () => {
  const { r, state } = run((d) => edit(d, `${B}/payment/FakePaymentProvider.java`, 'new BigDecimal("1000")', 'new BigDecimal("100")'));
  assert.ok(r.unseen.some((u) => /billing\.provider=fake/.test(u.what) && /billing\.provider=stripe/.test(u.why)));
  assert.equal(state('screen:/invoices'), 'skip');
});

test('@EnableAsync removed reaches every @Async method\'s callers', () => {
  const { state } = run((d) => edit(d, `${N}/config/AsyncConfig.java`, '@EnableAsync\n', ''));
  assert.equal(state('job:OrderNotificationsListener.onOrderEvent'), 'test');
  assert.equal(state('job:PaymentFailedListener.onPaymentResult'), 'test');
});

test('a new constant nothing names changes nothing', () => {
  const { r } = run((d) => edit(d, `${E}/Topics.java`, '    public static final String PAYMENT_RESULT = "shop.payments.result";\n', '    public static final String PAYMENT_RESULT = "shop.payments.result";\n    public static final String ORDER_SHIPPED = "shop.orders.shipped";\n'));
  assert.equal(r.triage.appEffect, 'none');
});

test('a removed listener: its job is listed and what it wrote is held', () => {
  const { state } = run((d) => unlinkSync(join(d, `${B}/messaging/OrderCancelledConsumer.java`)));
  assert.equal(state('job:OrderCancelledConsumer.onOrderCancelled'), 'test');
  assert.notEqual(state('screen:/invoices'), 'skip');
});
