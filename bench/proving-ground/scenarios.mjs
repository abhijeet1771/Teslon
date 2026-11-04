/**
 * OrderDesk proving ground: real developer pull requests against a realistic
 * Spring Boot + Angular app (fixtures/orderdesk), each with its truth.
 *
 * The truth was written by hand from the app's code, before Teslon was run on
 * any of them. It is what a careful QA lead would say after reading the code
 * and clicking through the app, not what Teslon's rules produce.
 *
 *   required.find      places that must be put in front of a tester (not skipped,
 *                      not missing). Missing = SILENT MISS unless "could not see"
 *                      names it. A skip = WRONG SKIP.
 *   required.notSkip   places that must never be called safe ('*' = every screen).
 *   required.noAlarm   claims that would be false (crying wolf).
 *   required.nothing   nothing in the app changes: no cases at all.
 *   required.unseen    what must be said out loud as not visible.
 *   ideal              precision beyond trust: the field, the tier, the risk.
 */

const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';

export const SCREENS = ['/', '/customers', '/customers/new', '/customers/:id', '/customers/:id/edit', '/products', '/products/new', '/products/:id/edit', '/orders', '/orders/new', '/orders/:id', '/reports'];

export const scenarios = [
  {
    id: 's01-note-limit',
    title: 'Order note limit 500 → 200',
    says: 'Shortened the order note limit, backend only.',
    apply: ({ edit }) => edit(`${J}/service/dto/CreateOrderRequest.java`, '@Size(max = 500) String note', '@Size(max = 200) String note'),
    required: {
      find: [{ s: 'api:POST /api/orders', field: /note/i }, { s: 'screen:/orders/new' }],
      notSkip: ['screen:/orders/new'],
    },
    ideal: [{ s: 'screen:/orders/new', field: /note/i, tier: 'test-first' }],
  },
  {
    id: 's02-customer-name-json',
    title: '@JsonProperty("fullName") on Customer.name',
    says: 'API now uses fullName for customers, for the mobile team.',
    apply: ({ edit }) => edit(`${J}/domain/Customer.java`, '    @Column(name = "name", nullable = false)\n    private String name;', '    @Column(name = "name", nullable = false)\n    @com.fasterxml.jackson.annotation.JsonProperty("fullName")\n    private String name;'),
    required: {
      find: [
        { s: 'screen:/customers', field: /name/i }, { s: 'screen:/customers/:id' }, { s: 'screen:/customers/:id/edit', field: /name/i },
        { s: 'screen:/customers/new' }, { s: 'screen:/orders/:id', field: /customer/i }, { s: 'screen:/orders/new', field: /customer/i },
        { s: 'api:GET /api/customers' }, { s: 'api:GET /api/orders/{id}' },
      ],
      // the order list and dashboard show OrderSummaryDto.customerName, built on the server: not broken
      noAlarm: [{ s: 'screen:/orders', expect: /blank|empty/i }, { s: 'screen:/', expect: /blank|empty/i }, { s: 'api:GET /api/invoices', expect: /./ }],
    },
    ideal: [{ s: 'screen:/customers', field: /name/i, tier: 'test-first' }, { s: 'screen:/orders/:id', field: /customer/i, tier: 'test-first' }],
  },
  {
    id: 's03-product-stock-ignored',
    title: '@JsonIgnore on Product.stock',
    says: 'Stock is internal, hid it from the API.',
    apply: ({ edit }) => edit(`${J}/domain/Product.java`, '    @Min(0)\n    @Column(name = "stock")', '    @Min(0)\n    @com.fasterxml.jackson.annotation.JsonIgnore\n    @Column(name = "stock")'),
    required: {
      find: [{ s: 'screen:/products', field: /stock/i }, { s: 'screen:/' }, { s: 'screen:/products/:id/edit' }, { s: 'api:GET /api/products' }],
      // order items already leave stock out (@JsonIgnoreProperties): the order screens are not affected by this
      noAlarm: [{ s: 'screen:/orders/:id', expect: /stock/i }],
    },
    ideal: [{ s: 'screen:/products/:id/edit', field: /stock/i }, { s: 'screen:/', field: /stock|low/i, tier: 'test-first' }],
  },
  {
    id: 's04-frontend-only-rename',
    title: 'IProduct.name → title in the UI only',
    says: 'Renamed product name to title in the Angular model.',
    apply: ({ edit }) => {
      edit(`${A}/products/product.model.ts`, '  name: string;', '  title: string;');
      edit(`${A}/products/product-list/product-list.html`, '{{ product.name }}', '{{ product.title }}');
      edit(`${A}/dashboard/dashboard.html`, '{{ p.name }}: {{ p.stock }} left', '{{ p.title }}: {{ p.stock }} left');
      edit(`${A}/orders/order-create/order-create.html`, '{{ p.name }} ({{ p.sku }})', '{{ p.title }} ({{ p.sku }})');
      edit(`${A}/orders/order.model.ts`, "Pick<IProduct, 'id' | 'sku' | 'name' | 'price'>", "Pick<IProduct, 'id' | 'sku' | 'title' | 'price'>");
      edit(`${A}/orders/order-detail/order-detail.html`, '{{ item.product.name }}', '{{ item.product.title }}');
    },
    required: {
      find: [{ s: 'screen:/products' }, { s: 'screen:/' }, { s: 'screen:/orders/new' }, { s: 'screen:/orders/:id' }],
      notSkip: ['screen:/products', 'screen:/', 'screen:/orders/new', 'screen:/orders/:id'],
    },
    // the API still sends "name": every one of these now shows nothing
    ideal: [{ s: 'screen:/products', expect: /title/i, tier: 'test-first' }, { s: 'screen:/orders/:id', expect: /title/i, tier: 'test-first' }],
  },
  {
    id: 's05-gold-discount',
    title: 'Gold discount 5% → 10%',
    says: 'Gold customers now get 10% off.',
    apply: ({ edit }) => edit(`${J}/service/PricingService.java`, 'new BigDecimal("0.95")', 'new BigDecimal("0.90")'),
    required: {
      find: [{ s: 'api:POST /api/orders' }, { s: 'screen:/orders/new' }],
      notSkip: ['screen:/orders/new', 'job:InvoiceService.onOrderPlaced'],
    },
    // the report uses lineTotal, not orderTotal
    ideal: [{ s: 'screen:/reports', absent: true }],
    // truth corrected 2026-11-04: the invoice listener copies order.getTotal() into the invoice amount, so invoices change too
  },
  {
    id: 's06-status-badge',
    title: 'Paid badge text and colour',
    says: 'Small UI tweak on the status badge.',
    apply: ({ edit }) => {
      edit(`${A}/shared/status-badge/status-badge.ts`, "@case ('PAID') { <span class=\"badge paid\">Paid</span> }", "@case ('PAID') { <span class=\"badge paid\">Payment received</span> }");
      edit(`${A}/shared/status-badge/status-badge.ts`, '.paid { background: #e3f1e5; }', '.paid { background: #c8e6c9; font-weight: 600; }');
    },
    required: {
      find: [{ s: 'screen:/orders' }, { s: 'screen:/orders/:id' }, { s: 'screen:/' }],
      notSkip: ['screen:/orders', 'screen:/orders/:id', 'screen:/'],
    },
    ideal: [{ s: 'screen:/customers', tier: 'skip' }, { s: 'screen:/products', tier: 'skip' }],
  },
  {
    id: 's07-error-interceptor',
    title: 'Error interceptor: 403 sends the user home',
    says: 'Handle forbidden in the interceptor.',
    apply: ({ edit }) => edit(`${A}/core/http/error.interceptor.ts`, '      if (err.status === 401) {', '      if (err.status === 401 || err.status === 403) {'),
    required: { notSkip: '*', find: [{ every: true }] },
  },
  {
    id: 's08-navbar-reports-link',
    title: 'Navbar: Reports link only for ADMIN',
    says: 'Only admins see the reports link.',
    apply: ({ edit }) => edit(`${A}/layout/navbar/navbar.html`, "session.hasRole('MANAGER')", "session.hasRole('ADMIN')"),
    required: { notSkip: '*', find: [{ every: true }] },
  },
  {
    id: 's09-docs-only',
    title: 'Docs only',
    says: 'Docs.',
    apply: ({ edit }) => {
      edit('README.md', 'Internal order management:', 'Internal order management for the sales team:');
      edit('docs/ARCHITECTURE.md', '- `jobs`: the morning stock alert.', '- `jobs`: the morning stock alert, weekdays at 07:00.');
    },
    required: { nothing: true },
  },
  {
    id: 's10-ci-only',
    title: 'CI only',
    says: 'CI cache.',
    apply: ({ edit }) => edit('.github/workflows/ci.yml', "          java-version: '21'", "          java-version: '21'\n          cache: maven"),
    required: { nothing: true },
  },
  {
    id: 's11-page-size',
    title: 'orderdesk.page-size 20 → 50',
    says: 'Bigger pages for products.',
    apply: ({ edit }) => edit('src/main/resources/application.yml', '  page-size: 20', '  page-size: 50'),
    required: {
      find: [{ s: 'screen:/products' }],
      notSkip: ['screen:/products', 'screen:/', 'screen:/orders/new'],
    },
    ideal: [{ s: 'api:GET /api/products' }],
  },
  {
    id: 's12-liquibase-not-null',
    title: 'New NOT NULL column on customer, no default',
    says: 'Added credit limit column.',
    apply: ({ write, edit }) => {
      write('src/main/resources/config/liquibase/changelog/0002-credit-limit.xml', `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-latest.xsd">
  <changeSet id="0002-credit-limit" author="orderdesk">
    <addColumn tableName="customer">
      <column name="credit_limit" type="decimal(12,2)"><constraints nullable="false"/></column>
    </addColumn>
  </changeSet>
</databaseChangeLog>
`);
      edit('src/main/resources/config/liquibase/master.xml', '  <include file="config/liquibase/changelog/0001-initial.xml"/>', '  <include file="config/liquibase/changelog/0001-initial.xml"/>\n  <include file="config/liquibase/changelog/0002-credit-limit.xml"/>');
    },
    // creating a customer now fails in the database: nothing in the code says so
    required: { notSkip: ['screen:/customers/new', 'screen:/customers/:id/edit'], unseen: [/liquibase|changelog|schema|database|credit/i] },
    ideal: [{ s: 'screen:/customers/new' }],
  },
  {
    id: 's13-cancel-endpoint-moved',
    title: 'Cancel moved to PATCH /cancellation, front end not updated',
    says: 'REST cleanup: cancellation is a PATCH now.',
    apply: ({ edit }) => edit(`${J}/web/rest/OrderResource.java`, '@PostMapping("/{id}/cancel")', '@PatchMapping("/{id}/cancellation")'),
    required: { find: [{ s: 'screen:/orders/:id', tier: 'test-first' }], notSkip: ['screen:/orders/:id'] },
  },
  {
    id: 's14-reports-admin-only',
    title: 'Security: reports for ADMIN only',
    says: 'Tighten report access.',
    apply: ({ edit }) => edit(`${J}/config/SecurityConfig.java`, '.hasAnyRole("MANAGER", "ADMIN")', '.hasRole("ADMIN")'),
    // the front-end guard still lets MANAGER in: the page now gets 403
    required: { notSkip: ['screen:/reports'], find: [{ s: 'screen:/reports', orUnseen: /security|permission|role/i }] },
  },
  {
    id: 's15-java-rename-same-json',
    title: 'Customer.name → fullName in Java, JSON kept as "name"',
    says: 'Refactor: field rename, API unchanged.',
    apply: ({ edit }) => {
      edit(`${J}/domain/Customer.java`, '    @Column(name = "name", nullable = false)\n    private String name;', '    @Column(name = "name", nullable = false)\n    @com.fasterxml.jackson.annotation.JsonProperty("name")\n    private String fullName;');
      edit(`${J}/domain/Customer.java`, '    public String getName() { return name; }\n    public void setName(String name) { this.name = name; }', '    public String getFullName() { return fullName; }\n    public void setFullName(String fullName) { this.fullName = fullName; }');
      edit(`${J}/service/OrderService.java`, 'o.getCustomer().getName()', 'o.getCustomer().getFullName()');
    },
    // nothing a client sees changed: any "blank" claim is false
    required: { noAlarm: SCREENS.map((s) => ({ s: `screen:${s}`, expect: /blank|empty|is now "/i })) },
  },
  {
    id: 's16-sku-rename-done-right',
    title: 'Product.sku → "code", front end updated everywhere',
    says: 'Renamed sku to code across API and UI.',
    apply: ({ edit }) => {
      edit(`${J}/domain/Product.java`, '    @Column(name = "sku", nullable = false, unique = true)\n    private String sku;', '    @Column(name = "sku", nullable = false, unique = true)\n    @com.fasterxml.jackson.annotation.JsonProperty("code")\n    private String sku;');
      edit(`${A}/products/product.model.ts`, '  sku: string;', '  code: string;');
      edit(`${A}/products/product-list/product-list.html`, '{{ product.sku }}', '{{ product.code }}');
      edit(`${A}/products/product-edit/product-edit.ts`, "    sku: ['', [Validators.required, Validators.maxLength(32)]],", "    code: ['', [Validators.required, Validators.maxLength(32)]],");
      edit(`${A}/products/product-edit/product-edit.html`, 'formControlName="sku"', 'formControlName="code"');
      edit(`${A}/orders/order.model.ts`, "Pick<IProduct, 'id' | 'sku' | 'name' | 'price'>", "Pick<IProduct, 'id' | 'code' | 'name' | 'price'>");
      edit(`${A}/orders/order-detail/order-detail.html`, '{{ item.product.sku }}', '{{ item.product.code }}');
      edit(`${A}/orders/order-create/order-create.html`, '{{ p.name }} ({{ p.sku }})', '{{ p.name }} ({{ p.code }})');
    },
    required: {
      find: [{ s: 'screen:/products' }, { s: 'screen:/orders/:id' }],
      // the report's sku is DailySalesDto.TopProduct.sku, a different field: untouched
      noAlarm: [...SCREENS.map((s) => ({ s: `screen:${s}`, expect: /reads "sku"/i })), { s: 'screen:/reports', expect: /blank|empty/i }],
    },
  },
  {
    // First version of this scenario forgot order-detail; in a typed Angular app that is a compile error
    // (Pick<IProduct, 'sku'> with no sku), which the build catches, not a runtime blank. Replaced by the
    // runtime bug a rename really leaves: one rename too many, on a type the API never renamed.
    id: 's17-sku-rename-one-too-many',
    title: 'Product.sku → "code", and the report\'s sku renamed too (its API was not)',
    says: 'Renamed sku to code everywhere.',
    apply: ({ edit }) => {
      edit(`${J}/domain/Product.java`, '    @Column(name = "sku", nullable = false, unique = true)\n    private String sku;', '    @Column(name = "sku", nullable = false, unique = true)\n    @com.fasterxml.jackson.annotation.JsonProperty("code")\n    private String sku;');
      edit(`${A}/products/product.model.ts`, '  sku: string;', '  code: string;');
      edit(`${A}/products/product-list/product-list.html`, '{{ product.sku }}', '{{ product.code }}');
      edit(`${A}/products/product-edit/product-edit.ts`, "    sku: ['', [Validators.required, Validators.maxLength(32)]],", "    code: ['', [Validators.required, Validators.maxLength(32)]],");
      edit(`${A}/products/product-edit/product-edit.html`, 'formControlName="sku"', 'formControlName="code"');
      edit(`${A}/orders/order.model.ts`, "Pick<IProduct, 'id' | 'sku' | 'name' | 'price'>", "Pick<IProduct, 'id' | 'code' | 'name' | 'price'>");
      edit(`${A}/orders/order-detail/order-detail.html`, '{{ item.product.sku }}', '{{ item.product.code }}');
      edit(`${A}/orders/order-create/order-create.html`, '{{ p.name }} ({{ p.sku }})', '{{ p.name }} ({{ p.code }})');
      // DailySalesDto.TopProduct still sends "sku"
      edit(`${A}/reports/report.model.ts`, '  sku: string;', '  code: string;');
      edit(`${A}/reports/daily-sales/daily-sales.html`, '<td>{{ t.sku }}</td>', '<td>{{ t.code }}</td>');
      edit(`${A}/reports/daily-sales/daily-sales.html`, 'track t.sku', 'track t.code');
    },
    required: {
      find: [{ s: 'screen:/reports', expect: /Risk: blank/ }, { s: 'screen:/products' }, { s: 'screen:/orders/:id' }],
      noAlarm: [{ s: 'screen:/products', expect: /Risk: blank|Rejected/ }, { s: 'screen:/orders/:id', expect: /Risk: blank/ }, { s: 'screen:/orders/new', expect: /Risk: blank/ }],
    },
    ideal: [{ s: 'screen:/reports', field: /sku|code/i, tier: 'test-first' }],
  },
  {
    id: 's18-status-on-hold',
    title: 'New order status ON_HOLD',
    says: 'Added ON_HOLD status for fraud review.',
    apply: ({ edit }) => edit(`${J}/domain/OrderStatus.java`, '    PAID,\n', '    PAID,\n    ON_HOLD,\n'),
    required: {
      find: [{ s: 'screen:/orders' }, { s: 'screen:/orders/:id' }, { s: 'screen:/' }],
      notSkip: ['screen:/orders', 'screen:/orders/:id', 'screen:/'],
      // Customer.orders is @JsonIgnore: customers carry no status
      noAlarm: [{ s: 'api:GET /api/customers', expect: /./ }, { s: 'screen:/customers', expect: /OrderStatus/ }],
    },
    // added after reviewing the first run: the report counts every status but CANCELLED, so ON_HOLD orders
    // now count as revenue. Missed by the first truth and by Teslon.
    ideal: [{ s: 'screen:/reports' }],
  },
  {
    id: 's19-big-reformat-hides-rule',
    title: 'AI PR: reindent every Java file, and price minimum 0.01 → 1.00',
    says: 'Formatting cleanup (Google Java style).',
    apply: ({ files, read, write, edit }) => {
      for (const f of files().filter((x) => x.endsWith('.java'))) write(f, read(f).replace(/^( {4})+/gm, (m) => '  '.repeat(m.length / 4)));
      edit(`${J}/domain/Product.java`, '@DecimalMin("0.01")', '@DecimalMin("1.00")');
    },
    required: {
      find: [{ s: 'api:POST /api/products', field: /price/i }, { s: 'api:PUT /api/products/{id}', field: /price/i }, { s: 'screen:/products/new' }, { s: 'screen:/products/:id/edit' }],
      maxMs: 60000,
    },
    ideal: [{ formattingIsNoEffect: true }],
  },
  {
    id: 's20-reports-removed',
    title: 'Reports feature removed from the front end',
    says: 'Removed the reports page, nobody used it.',
    apply: ({ edit, rm }) => {
      edit(`${A}/app.routes.ts`, `  {
    path: 'reports',
    canActivate: [adminGuard],
    loadComponent: () => import('./reports/daily-sales/daily-sales').then((m) => m.DailySales),
    title: 'Reports',
  },
`, '');
      edit(`${A}/app.routes.ts`, "import { adminGuard } from './core/auth/admin.guard';\n", '');
      for (const f of ['reports/daily-sales/daily-sales.ts', 'reports/daily-sales/daily-sales.html', 'reports/report.service.ts', 'reports/report.model.ts']) rm(`${A}/${f}`);
    },
    // the navbar (one component, on every screen) still links to /reports, which now redirects to the
    // dashboard. Truth revised after the first run: one check of that link covers every screen, so the
    // other screens are safe to skip; requiring all of them was stricter than a QA lead would be.
    required: { find: [{ s: 'screen:/reports', tier: 'test-first' }] },
    ideal: [{ s: 'screen:/reports', expect: /link/i }],
  },
  {
    id: 's21-angular-patch-bump',
    title: '@angular/* 21.2.4 → 21.2.6',
    says: 'Dependency bump.',
    apply: ({ read, write }) => write('package.json', read('package.json').replace(/"21\.2\.4"/g, '"21.2.6"')),
    required: { notSkip: '*', find: [{ every: true }] },
  },
  {
    id: 's22-hostile-text',
    title: 'Heading text with markdown, a mention and HTML',
    says: 'Copy change on the customers page.',
    apply: ({ edit }) => edit(`${A}/customers/customer-list/customer-list.html`, '<h2>Customers <a routerLink', '<h2>Customers @everyone [click](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt; <a routerLink'),
    required: { find: [{ s: 'screen:/customers' }], inert: true },
  },
  {
    id: 's23-test-only',
    title: 'Only a unit test changes',
    says: 'More pricing tests.',
    apply: ({ edit }) => edit('src/test/java/com/orderdesk/service/PricingServiceTest.java', 'isEqualByComparingTo("19.00")', 'isEqualByComparingTo(new BigDecimal("19.00"))'),
    required: { nothing: true },
  },
  {
    id: 's24-behind-main',
    title: 'Open PR on an old main (badge change), main has moved on (docs, CI)',
    says: 'Status badge tweak.',
    flow: 'behind',
    apply: ({ edit }) => edit(`${A}/shared/status-badge/status-badge.ts`, '.cancelled { background: #fcebe9; }', '.cancelled { background: #f9d6d2; text-decoration: line-through; }'),
    mainMovesWith: ({ edit }) => {
      edit('README.md', '## Run', '## Run locally');
      edit('.github/workflows/ci.yml', 'echo "build and test would run here (mvn verify, npm test)"', 'echo "mvn verify and npm test"');
    },
    // only the PR's own change is in it: main's later commits are not this PR's
    required: { find: [{ s: 'screen:/orders' }], ledgerOnly: [`${A}/shared/status-badge/status-badge.ts`] },
  },
  {
    id: 's25-merged-three-ways',
    title: 'The same PR merged with a merge commit, a squash and a rebase',
    says: 'Gold discount 10%.',
    flow: 'merged',
    // two commits, so a rebase-merge lands as two
    apply: ({ edit }) => edit(`${J}/service/PricingService.java`, 'new BigDecimal("0.95")', 'new BigDecimal("0.90")'),
    apply2: ({ edit }) => edit(`${J}/service/PricingService.java`, 'sum.setScale(2, RoundingMode.HALF_UP)', 'sum.setScale(2, RoundingMode.HALF_EVEN)'),
    required: { find: [{ s: 'screen:/orders/new' }], ledgerOnly: [`${J}/service/PricingService.java`] },
  },
  // ---- added 2026-11-04, from probing what following callers alone misses: events, data, images, scripts
  {
    id: 's26-event-dropped',
    title: 'OrderService cleanup drops the OrderPlacedEvent',
    says: 'Small cleanup in OrderService.create().',
    apply: ({ edit }) => edit(`${J}/service/OrderService.java`, '        events.publishEvent(new OrderPlacedEvent(saved.getId()));\n', ''),
    // nothing publishes OrderPlacedEvent any more: no invoice and no notification for new orders
    required: {
      find: [{ s: 'job:InvoiceService.onOrderPlaced', expect: /never runs/ }, { s: 'job:NotificationService.onOrderPlaced', expect: /never runs/ }, { s: 'screen:/orders/new' }],
      notSkip: ['job:InvoiceService.onOrderPlaced', 'job:NotificationService.onOrderPlaced'],
    },
  },
  {
    id: 's27-total-not-saved',
    title: 'Order total no longer stored when the order is created',
    says: 'The total is computed when it is read now.',
    apply: ({ edit }) => edit(`${J}/service/OrderService.java`, '        order.setTotal(pricing.orderTotal(customer, order.getItems()));\n', ''),
    // new orders are saved with no total: the list, the detail and the invoice amount show it; the daily report uses line totals
    required: {
      find: [{ s: 'screen:/orders/new' }],
      notSkip: ['screen:/orders', 'screen:/orders/:id', 'job:InvoiceService.onOrderPlaced'],
      unseen: [/write.*differently[\s\S]*\/orders\/:id|\/orders\/:id[\s\S]*write/i],
    },
  },
  {
    id: 's28-stock-not-reserved',
    title: 'Inventory: reserve keeps the stock as it is',
    says: 'Refactor in InventoryService.',
    apply: ({ edit }) => edit(`${J}/service/InventoryService.java`, 'product.setStock(product.getStock() - quantity);', 'product.setStock(product.getStock());'),
    // stock never goes down: the product list shows it, and the stock alert job reads it
    required: {
      find: [{ s: 'screen:/orders/new' }],
      notSkip: ['screen:/products', 'job:StockAlertJob.alert'],
      unseen: [/\/products/],
    },
  },
  {
    id: 's29-logo',
    title: 'New brand logo',
    says: 'Logo refresh from design.',
    apply: ({ write }) => write('src/main/webapp/content/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#5856d6"/></svg>\n'),
    // the navbar draws it on every screen
    required: { find: [{ every: true }] },
  },
  {
    id: 's30-entrypoint',
    title: 'Container entrypoint sets the time zone',
    says: 'Ops: run the JVM in UTC.',
    apply: ({ edit }) => edit('docker-entrypoint.sh', 'exec java -jar', 'exec java -Duser.timezone=UTC -jar'),
    // how the server starts in production: dates and "today" can move
    required: { find: [{ s: 'deploy:docker-entrypoint.sh' }] },
  },
  {
    id: 's31-image-named-nowhere',
    title: 'New empty-cart illustration',
    says: 'Design asset update.',
    apply: ({ write }) => write('src/main/webapp/content/empty-cart.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])),
    // nothing in the code names it, so where it shows is not known: it must be said, and no screen skipped
    required: { notSkip: '*', unseen: [/empty-cart\.png/] },
  },
];
