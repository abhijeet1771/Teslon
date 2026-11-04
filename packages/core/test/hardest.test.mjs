import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { impact, brief } from '../dist/index.js';

/**
 * The rules the hardest probes needed (bench/probes/catalog-hardest.mjs), each
 * on OrderDesk with the one change that needs it: what breaks is two or three
 * hops from the line that changed, and no page is named.
 */

const APP = fileURLToPath(new URL('../../../fixtures/orderdesk', import.meta.url));
const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (d, f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); assert.ok(t.includes(from), `${f}: ${from}`); writeFileSync(join(d, f), t.replace(from, to)); };

function run(change, prepare) {
  const d = mkdtempSync(join(tmpdir(), 'teslon-hardest-'));
  try {
    cpSync(APP, d, { recursive: true });
    g(d, 'init', '-q', '-b', 'main');
    g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); g(d, 'config', 'commit.gpgsign', 'false');
    prepare?.(d);
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

test('a plain @EventListener runs inside the request that publishes: a change to it reaches the page that sends that request', () => {
  const { state, r } = run((d) => edit(d, `${J}/service/NotificationService.java`, 'message.setTo("sales@orderdesk.example");', 'message.setTo("orders@orderdesk.example");'));
  assert.equal(state('screen:/orders/new'), 'test');
  const c = r.cases.find((x) => x.surface === 'screen:/orders/new');
  assert.ok(c.hops.some((h) => h.label === 'Runs inside' && h.quote === 'publishEvent'), 'the publish line is the evidence');
  assert.equal(state('screen:/customers'), 'skip');
});

test('a dropped column the entity still maps reaches every API that loads the entity, through an eager relation too', () => {
  const { state, r } = run((d) => {
    writeFileSync(join(d, 'src/main/resources/config/liquibase/changelog/0002-phone.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">\n  <changeSet id="0002" author="dev">\n    <dropColumn tableName="customer" columnName="phone"/>\n  </changeSet>\n</databaseChangeLog>\n');
    edit(d, 'src/main/resources/config/liquibase/master.xml', '</databaseChangeLog>', '  <include file="config/liquibase/changelog/0002-phone.xml"/>\n</databaseChangeLog>');
  });
  // Order.customer is an eager @ManyToOne: the order list joins customer, and fails with it
  for (const s of ['/customers', '/orders', '/orders/:id', '/reports']) assert.equal(state(`screen:${s}`), 'test', s);
  assert.ok(r.cases.some((c) => c.hops.some((h) => /through Order, which loads it/.test(h.rule))));
});

test('a getter Jackson calls and no code names adds a JSON field: the APIs are listed, no page is', () => {
  const { state, r } = run((d) => edit(d, `${J}/domain/Product.java`, '    public Long getId()', '    public String getDisplayName() { return sku + " " + name; }\n\n    public Long getId()'));
  assert.ok(r.deltas.some((x) => x.id === 'shape:Product.+displayName'));
  assert.equal(state('api:GET /api/products'), 'test');
  for (const s of ['/products', '/products/:id/edit', '/orders', '/customers']) assert.equal(state(`screen:${s}`), 'skip', s);
  assert.ok(r.unseen.some((u) => /refuses unknown fields/.test(u.why)));
});

test('the same getter, when the API refuses unknown fields: the edit page that sends back what it loaded is test first', () => {
  const { state } = run(
    (d) => edit(d, `${J}/domain/Product.java`, '    public Long getId()', '    public String getDisplayName() { return sku + " " + name; }\n\n    public Long getId()'),
    (d) => edit(d, 'src/main/resources/application.yml', 'spring:\n', 'spring:\n  jackson:\n    deserialization:\n      fail-on-unknown-properties: true\n'),
  );
  assert.equal(state('screen:/products/:id/edit'), 'test');
  assert.equal(state('screen:/customers'), 'skip');
});

test('a security rule for some paths reaches only the endpoints it matches; a CSRF change only the requests that change state', () => {
  const reports = run((d) => edit(d, `${J}/config/SecurityConfig.java`, '.hasAnyRole("MANAGER", "ADMIN")', '.hasRole("ADMIN")'));
  assert.equal(reports.state('screen:/reports'), 'test');
  for (const s of ['/orders', '/customers', '/products']) assert.equal(reports.state(`screen:${s}`), 'skip', s);
  const csrf = run((d) => edit(d, `${J}/config/SecurityConfig.java`, '            .csrf(csrf -> csrf.disable())\n', ''));
  assert.equal(csrf.state('screen:/orders/new'), 'test');
  assert.equal(csrf.state('screen:/reports'), 'skip', 'the report page only reads');
});

test('a route guard or title belongs to its route: changing it reaches that screen, not the app shell', () => {
  const guard = run((d) => edit(d, `${A}/core/auth/admin.guard.ts`, "session.hasRole('MANAGER') || session.hasRole('ADMIN')", "session.hasRole('ADMIN')"));
  assert.equal(guard.state('screen:/reports'), 'test');
  assert.equal(guard.state('screen:/orders'), 'skip');
  const title = run((d) => edit(d, `${A}/app.routes.ts`, "title: 'Reports',", "title: 'Sales report',"));
  assert.equal(title.state('screen:/reports'), 'test');
  assert.equal(title.b.unclear, 0, 'nothing else is held');
});

test('a parent route that moves takes its child screens with it, and the links left behind are found', () => {
  const { state } = run((d) => edit(d, `${A}/app.routes.ts`, "path: 'products',", "path: 'catalog',"));
  for (const s of ['/products', '/products/new', '/products/:id/edit', '/catalog', '/catalog/new']) assert.equal(state(`screen:${s}`), 'test', s);
  assert.equal(state('screen:*'), 'test', 'the navbar link to /products is on every screen');
});

test('rules on a nested @Valid type are the request rules of the API that takes it', () => {
  const { r, state } = run((d) => edit(d, `${J}/service/dto/OrderLineRequest.java`, '@Max(99) int quantity', '@Max(20) int quantity'));
  const d = r.deltas.find((x) => x.kind === 'request-rules-enforced');
  assert.ok(d, 'a rule delta');
  assert.match(d.title, /lines\[\]\.quantity/);
  assert.equal(state('screen:/orders/new'), 'test');
});

test('a field made @Transient reads back empty: the APIs that read it are listed, the ones that do not are not', () => {
  const { state, r } = run((d) => edit(d, `${J}/domain/Order.java`, '    @Column(name = "total")', '    @jakarta.persistence.Transient'));
  for (const s of ['/orders', '/orders/:id']) assert.equal(state(`screen:${s}`), 'test', s);
  assert.notEqual(state('screen:/reports'), 'test', 'the report sums line totals, not Order.total');
  assert.ok(r.unseen.some((u) => /no longer saved or loaded/.test(u.why)));
});

test('a screen that imports a service but never calls the changed member is skipped, and says what it does call', () => {
  const { area } = run((d) => edit(d, 'src/main/resources/application.yml', 'host: smtp.internal.example', 'host: smtp.mail.example'));
  assert.equal(area('screen:/orders/new').state, 'test', 'creating an order sends the mail');
  const list = area('screen:/orders');
  assert.equal(list.state, 'skip');
  assert.match(list.why, /never calls OrderService\.create\(\)/);
});

test('a service handed on whole (an alias, an argument) is not read member by member: that screen is held, never skipped', () => {
  const list = `${A}/orders/order-list/order-list.ts`;
  const { state } = run(
    (d) => edit(d, 'src/main/resources/application.yml', 'host: smtp.internal.example', 'host: smtp.mail.example'),
    (d) => edit(d, list, 'readonly orders = toSignal(this.service.list(), { initialValue: [] });', 'private readonly api = this.service;\n  readonly orders = toSignal(this.api.list(), { initialValue: [] });'),
  );
  assert.notEqual(state('screen:/orders'), 'skip');
  assert.equal(state('screen:/customers'), 'skip');
});
