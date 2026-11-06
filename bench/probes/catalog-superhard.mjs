/**
 * Super-hard PRs on OrderDesk: the compiler is happy and the diff looks harmless, but the app breaks at
 * start-up, at build time, in production only, or through a file in a language Teslon does not read.
 * Written from the change atlas (research/CHANGE-ATLAS-2026-11-05.md), truth first, by reading the app.
 *
 * Tiers, in the id: u1 (hard), u2 (harder), u3 (hardest), u4 (super hardest).
 */

const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';
const L = 'src/main/resources/config/liquibase';
const R = 'src/main/resources';
const changelog = (id, body) => `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="${id}" author="dev">
${body}
  </changeSet>
</databaseChangeLog>
`;
const include = (t, file) => t.edit(`${L}/master.xml`, '</databaseChangeLog>', `  <include file="config/liquibase/changelog/${file}"/>\n</databaseChangeLog>`);
const S = (...p) => p.map((x) => `screen:${x}`);
// the screens that draw <app-status-badge>: order detail, order list, dashboard
const BADGE = S('/orders/:id', '/orders', '/');
// the screens whose data comes in through a route resolver bound to a component input
const RESOLVED = S('/customers/:id', '/customers/:id/edit', '/orders/:id', '/products/:id/edit');
const PRODUCT_PAGES = S('/products', '/', '/orders/new');

export const superhardProbes = [
  /* ---------- start-up: the compiler is happy, Spring is not ---------- */
  {
    id: 'u4-01-package-outside-scan', logic: ['spring.component-scan', 'java.packages'], title: 'PricingService moves to com.pricing, outside the component scan',
    apply: (t) => {
      const src = t.read(`${J}/service/PricingService.java`).replace('package com.orderdesk.service;', 'package com.pricing;');
      t.rm(`${J}/service/PricingService.java`);
      t.write('src/main/java/com/pricing/PricingService.java', src);
      t.edit(`${J}/service/OrderService.java`, 'import com.orderdesk.service.dto.CreateOrderRequest;', 'import com.orderdesk.service.dto.CreateOrderRequest;\nimport com.pricing.PricingService;');
      t.edit(`${J}/service/ReportService.java`, 'import com.orderdesk.service.dto.DailySalesDto;', 'import com.orderdesk.service.dto.DailySalesDto;\nimport com.pricing.PricingService;');
    },
    // @SpringBootApplication in com.orderdesk scans com.orderdesk.** only: no PricingService bean, so
    // OrderService and ReportService cannot be made and the app does not start. Every screen fails.
    truth: { notSkip: '*', every: true },
  },
  {
    id: 'u4-02-service-annotation-dropped', logic: ['spring.beans'], title: '@Service is removed from InventoryService',
    apply: (t) => t.edit(`${J}/service/InventoryService.java`, '@Service\n', ''),
    // OrderService takes an InventoryService in its constructor: no bean, no start-up
    truth: { notSkip: '*', every: true },
  },
  {
    id: 'u4-03-dependency-with-no-bean', logic: ['spring.beans', 'java.constructors'], title: 'OrderService asks for a Clock that no bean provides',
    apply: (t) => {
      t.edit(`${J}/service/OrderService.java`, 'ApplicationEventPublisher events) {', 'ApplicationEventPublisher events, java.time.Clock clock) {');
    },
    // there is no Clock bean in the app: OrderService cannot be made, the app does not start
    truth: { notSkip: '*', every: true },
  },
  {
    id: 'u4-04-derived-query-bad-name', logic: ['java.repository', 'spring.startup'], title: 'InvoiceRepository.findByOrderId becomes findByOrderNumber',
    apply: (t) => {
      t.edit(`${J}/repository/InvoiceRepository.java`, 'findByOrderId(Long orderId)', 'findByOrderNumber(Long orderId)');
      t.edit(`${J}/web/rest/InvoiceResource.java`, 'invoices.findByOrderId(orderId)', 'invoices.findByOrderNumber(orderId)');
    },
    // Order has no "number": Spring Data cannot derive the query, the repository bean fails, the app does not start
    truth: { notSkip: '*', every: true },
  },
  {
    id: 'u4-05-applied-changeset-edited', logic: ['data.migrations', 'spring.startup'], title: 'An applied Liquibase changeset is edited in place',
    apply: (t) => t.edit(`${L}/changelog/0001-initial.xml`, '<column name="name" type="varchar(80)">', '<column name="name" type="varchar(100)">'),
    // every database that ran 0001 has its checksum: validation fails and the app does not start there
    truth: { notSkip: '*' },
  },
  /* ---------- the build: what the compiler is told ---------- */
  {
    id: 'u4-06-no-parameter-names', logic: ['build.compiler', 'contract.params'], title: 'The compiler stops keeping parameter names',
    apply: (t) => t.edit('pom.xml', '      <plugin>\n        <groupId>org.springframework.boot</groupId>', '      <plugin>\n        <groupId>org.apache.maven.plugins</groupId>\n        <artifactId>maven-compiler-plugin</artifactId>\n        <configuration>\n          <parameters>false</parameters>\n        </configuration>\n      </plugin>\n      <plugin>\n        <groupId>org.springframework.boot</groupId>'),
    // @PathVariable Long id and @RequestParam with no name need -parameters (Spring 6.1): those endpoints fail
    truth: { reach: [...S('/customers/:id', '/customers/:id/edit', '/orders/:id', '/products/:id/edit'), ...PRODUCT_PAGES, 'screen:/reports'] },
  },
  /* ---------- production only ---------- */
  {
    id: 'u3-07-prod-profile-override', logic: ['config.profiles'], title: 'A production profile sets five products a page',
    apply: (t) => t.write(`${R}/application-prod.yml`, 'orderdesk:\n  page-size: 5\n'),
    // only where the prod profile is active: product pages hold five rows
    truth: { reach: PRODUCT_PAGES, quiet: S('/customers', '/orders/:id', '/reports') },
  },
  {
    id: 'u4-08-k8s-activates-profile', logic: ['deploy.k8s', 'config.profiles'], title: 'The Kubernetes deployment turns on the prod profile',
    base: (t) => {
      t.write(`${R}/application-prod.yml`, 'orderdesk:\n  page-size: 5\n');
      t.write('deploy/k8s/deployment.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: orderdesk\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: orderdesk\n          image: orderdesk:1.4.0\n          env:\n            - name: SPRING_PROFILES_ACTIVE\n              value: default\n');
    },
    apply: (t) => t.edit('deploy/k8s/deployment.yaml', 'value: default', 'value: prod'),
    // the prod profile now applies: product pages hold five rows
    truth: { reach: PRODUCT_PAGES, say: [/deployment\.yaml/] },
  },
  {
    id: 'u1-09-unused-setting', logic: ['config.keys'], title: 'The currency setting takes an environment variable',
    apply: (t) => t.edit(`${R}/application.yml`, '  currency: EUR', '  currency: ${ORDERDESK_CURRENCY:EUR}'),
    // OrderDeskProperties.currency() is never called: nothing a user sees changes
    truth: { quiet: S('/', '/customers', '/products', '/orders', '/orders/:id', '/reports') },
  },
  /* ---------- the database ---------- */
  {
    id: 'u3-10-unique-email', logic: ['data.migrations', 'data.constraints'], title: 'Customer e-mails must be unique in the database',
    apply: (t) => { t.write(`${L}/changelog/0002-unique-email.xml`, changelog('0002-unique-email', '    <addUniqueConstraint tableName="customer" columnNames="email" constraintName="ux_customer_email"/>')); include(t, '0002-unique-email.xml'); },
    // a new customer, or an edit, with an e-mail already used now fails
    truth: { reach: S('/customers/new', '/customers/:id/edit') },
  },
  {
    id: 'u3-11-data-update', logic: ['data.migrations', 'data.values'], title: 'A migration deactivates every product with no stock',
    apply: (t) => { t.write(`${L}/changelog/0002-deactivate.xml`, changelog('0002-deactivate', '    <update tableName="product">\n      <column name="active" valueBoolean="false"/>\n      <where>stock = 0</where>\n    </update>')); include(t, '0002-deactivate.xml'); },
    // the product list greys them out; the edit form shows Active unticked
    truth: { reach: S('/products', '/products/:id/edit') },
  },
  {
    id: 'u4-12-version-no-accessor', logic: ['data.locking', 'contract.persistence'], title: 'Products get optimistic locking, with no getter for the version',
    apply: (t) => {
      t.edit(`${J}/domain/Product.java`, '    @Column(name = "active")', '    @jakarta.persistence.Version\n    private Long version;\n\n    @Column(name = "active")');
      t.write(`${L}/changelog/0002-version.xml`, changelog('0002-version', '    <addColumn tableName="product">\n      <column name="version" type="bigint" defaultValueNumeric="0"/>\n    </addColumn>'));
      include(t, '0002-version.xml');
    },
    // the edit form PUTs the product without a version: Spring Data takes it for new and persist fails
    truth: { reach: S('/products/:id/edit') },
  },
  /* ---------- Angular: the template contract ---------- */
  {
    id: 'u3-13-selector-renamed', logic: ['ui.components', 'ui.templates'], title: 'StatusBadge is now app-status-chip; templates still say app-status-badge',
    apply: (t) => t.edit(`${A}/shared/status-badge/status-badge.ts`, "selector: 'app-status-badge'", "selector: 'app-status-chip'"),
    // the build fails (NG8001); at best the badge is gone where it was drawn
    truth: { reach: BADGE },
  },
  {
    id: 'u3-14-input-renamed', logic: ['ui.components', 'ui.inputs'], title: 'StatusBadge takes value; the templates still bind [status]',
    apply: (t) => t.edit(`${A}/shared/status-badge/status-badge.ts`, 'readonly status = input.required<OrderStatus>();', 'readonly value = input.required<OrderStatus>();\n  readonly status = this.value;'),
    // the required input "value" is never bound: Angular fails on every page that draws the badge
    truth: { reach: BADGE },
  },
  {
    id: 'u4-15-ng-deep-leak', logic: ['ui.styles', 'ui.components'], title: 'StatusBadge styles every table with ::ng-deep',
    apply: (t) => t.edit(`${A}/shared/status-badge/status-badge.ts`, '      .cancelled { background: #fcebe9; }', '      .cancelled { background: #fcebe9; }\n      ::ng-deep table { font-size: 11px; }'),
    // ::ng-deep with no :host is global once the badge has loaded: every table, on every screen, after that
    truth: { reach: [...BADGE, ...S('/customers', '/products', '/reports')] },
  },
  {
    id: 'u3-16-input-binding-off', logic: ['ui.routing', 'ui.config'], title: 'withComponentInputBinding is removed from the router',
    apply: (t) => t.edit(`${A}/app.config.ts`, 'provideRouter(routes, withComponentInputBinding())', 'provideRouter(routes)'),
    // resolved data no longer reaches the component inputs: those pages are empty
    truth: { reach: RESOLVED },
  },
  /* ---------- code Teslon does not read ---------- */
  {
    id: 'u4-17-go-sidecar', logic: ['foreign.go', 'data.writes'], title: 'The Go stock sync sets unknown SKUs to zero stock',
    base: (t) => t.write('tools/stock-sync/main.go', 'package main\n\n// stock-sync runs every minute next to OrderDesk: it reads the warehouse feed and\n// sets each product\'s stock through PUT /api/products/{id}.\n\nimport "fmt"\n\nfunc stockFor(sku string, feed map[string]int) (int, bool) {\n\tv, ok := feed[sku]\n\treturn v, ok\n}\n\nfunc main() { fmt.Println("stock-sync") }\n'),
    apply: (t) => t.edit('tools/stock-sync/main.go', '\tv, ok := feed[sku]\n\treturn v, ok', '\tv, ok := feed[sku]\n\tif !ok {\n\t\treturn 0, true\n\t}\n\treturn v, ok'),
    // product stock on every product page, and the low-stock list, can change
    truth: { say: [/main\.go/], notSkip: S('/products', '/') },
  },
  {
    id: 'u3-18-python-script', logic: ['foreign.python', 'data.writes'], title: 'The nightly invoice reconcile script rounds differently',
    base: (t) => t.write('scripts/reconcile_invoices.py', '"""Runs nightly: recomputes invoice.amount from the order total, in the database."""\n\n\ndef amount(total):\n    return round(total, 2)\n'),
    apply: (t) => t.edit('scripts/reconcile_invoices.py', 'return round(total, 2)', 'return round(total)'),
    // invoice amounts in the database change at night; nothing in the app shows invoices, but it must be said
    truth: { say: [/reconcile_invoices\.py/] },
  },
];
