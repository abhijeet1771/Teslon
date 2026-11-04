/**
 * The hardest real-life PRs on OrderDesk: the change names no page, often no
 * API, and what breaks is two or three hops away (a security rule, an
 * interceptor, a listener that runs inside the request, a repository query
 * many services share, a Jackson setting, a migration the entity disagrees
 * with). The truth for each was written by reading the app before Teslon ran.
 */

const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';
const L = 'src/main/resources/config/liquibase';
const YML = 'src/main/resources/application.yml';
const changelog = (id, body) => `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="${id}" author="dev">
${body}
  </changeSet>
</databaseChangeLog>
`;
const include = (t, file) => t.edit(`${L}/master.xml`, '</databaseChangeLog>', `  <include file="config/liquibase/changelog/${file}"/>\n</databaseChangeLog>`);
const yml = (t, from, to) => t.edit(YML, from, to);

// screens that show any order total, status or date
const ORDER_SCREENS = ['screen:/orders', 'screen:/', 'screen:/orders/:id'];
// every page that loads products from the API
const PRODUCT_LOADERS = ['screen:/products', 'screen:/products/:id/edit', 'screen:/orders/new', 'screen:/'];
const WRITERS = ['screen:/customers/new', 'screen:/customers/:id/edit', 'screen:/products/new', 'screen:/products/:id/edit', 'screen:/orders/new', 'screen:/orders/:id'];

export const hardestProbes = [
  /* ---------- the JSON contract, changed from far away ---------- */
  {
    id: 'z01-getter-strict-json', logic: ['contract.computed', 'config.framework'], title: 'A computed displayName, and the API refuses unknown fields',
    base: (t) => yml(t, 'spring:\n', 'spring:\n  jackson:\n    deserialization:\n      fail-on-unknown-properties: true\n'),
    apply: (t) => t.edit(`${J}/domain/Product.java`, '    public Long getId()', '    public String getDisplayName() { return sku + " " + name; }\n\n    public Long getId()'),
    // the edit form spreads the loaded product into its PUT: displayName goes back, and is refused
    truth: { test: ['screen:/products/:id/edit'], quiet: ['screen:/customers', 'screen:/reports'] },
  },
  {
    id: 'z02-getter-may-throw', logic: ['contract.computed'], title: 'A computed label that calls a method on a field',
    apply: (t) => t.edit(`${J}/domain/Product.java`, '    public Long getId()', '    public String getLabel() { return name.toUpperCase() + " (" + sku + ")"; }\n\n    public Long getId()'),
    // Jackson calls it for every product in every response; if it throws, those calls fail
    truth: { reach: ['screen:/products', 'screen:/orders/:id', 'screen:/products/:id/edit'] },
  },
  {
    id: 'z03-total-as-string', logic: ['contract.types'], title: 'Order totals are sent as strings',
    apply: (t) => t.edit(`${J}/domain/Order.java`, '    @Column(name = "total")', '    @com.fasterxml.jackson.annotation.JsonFormat(shape = com.fasterxml.jackson.annotation.JsonFormat.Shape.STRING)\n    @Column(name = "total")'),
    // only the Order entity: the order list and the dashboard read OrderSummaryDto.total
    truth: { reach: ['screen:/orders/:id'], quiet: ['screen:/customers', 'screen:/products'] },
  },
  {
    id: 'z04-dates-as-numbers', logic: ['contract.dates', 'config.framework'], title: 'Jackson writes dates as timestamps',
    apply: (t) => yml(t, 'spring:\n', 'spring:\n  jackson:\n    serialization:\n      write-dates-as-timestamps: true\n'),
    // placedAt arrives as seconds with nanos; the date pipe reads milliseconds: 1970
    truth: { reach: ORDER_SCREENS },
  },
  {
    id: 'z05-not-found-is-empty', logic: ['contract.status'], title: 'An unknown product answers 200 with no body',
    apply: (t) => t.edit(`${J}/web/rest/ProductResource.java`, 'return ResponseEntity.of(products.findById(id));', 'return ResponseEntity.ok(products.findById(id).orElse(null));'),
    // the edit page's resolver gets null instead of an error, and opens an empty form for a product that does not exist
    truth: { reach: ['screen:/products/:id/edit'], quiet: ['screen:/customers', 'screen:/orders'] },
  },
  {
    id: 'z06-summary-rounds', logic: ['java.records'], title: 'Order summaries round the total to whole euros',
    apply: (t) => t.write(`${J}/service/dto/OrderSummaryDto.java`, t.read(`${J}/service/dto/OrderSummaryDto.java`).replace(/\) \{\}\s*$/, ') {\n    public OrderSummaryDto {\n        total = total == null ? null : total.setScale(0, java.math.RoundingMode.HALF_UP);\n    }\n}\n')),
    truth: { reach: ['screen:/orders', 'screen:/'], quiet: ['screen:/orders/:id', 'screen:/customers'] },
  },
  {
    id: 'z07-customer-name-trimmed', logic: ['java.accessors'], title: 'Customer names are trimmed when read',
    apply: (t) => t.edit(`${J}/domain/Customer.java`, 'public String getName() { return name; }', 'public String getName() { return name == null ? null : name.trim(); }'),
    // Jackson calls the getter (every customer JSON), and OrderService.list copies it into the order summaries
    truth: { reach: ['screen:/customers', 'screen:/customers/:id', 'screen:/orders'] },
  },

  /* ---------- security, in Java and in the browser ---------- */
  {
    id: 'z08-reports-admin-only', logic: ['security.http'], title: 'Only admins may call the report API',
    apply: (t) => t.edit(`${J}/config/SecurityConfig.java`, '.hasAnyRole("MANAGER", "ADMIN")', '.hasRole("ADMIN")'),
    // the guard and the navbar still let managers in: the page opens and its call is refused (403)
    truth: { test: ['screen:/reports'] },
  },
  {
    id: 'z09-csrf-on', logic: ['security.http'], title: 'CSRF protection is switched on',
    apply: (t) => t.edit(`${J}/config/SecurityConfig.java`, '            .csrf(csrf -> csrf.disable())\n', ''),
    // the front end sends no CSRF token: every POST and PUT is refused
    truth: { test: WRITERS },
  },
  {
    id: 'z10-products-public', logic: ['security.http'], title: 'The product API is opened to everyone',
    apply: (t) => t.edit(`${J}/config/SecurityConfig.java`, '.requestMatchers("/api/**").authenticated()', '.requestMatchers("/api/products/**").permitAll()\n                .requestMatchers("/api/**").authenticated()'),
    // nothing changes for a signed-in user; anyone can now read and write products, so every page that calls the product API is where to check it
    truth: { say: [/products/], reach: ['screen:/products', 'screen:/products/new', 'screen:/products/:id/edit', 'screen:/orders/new', 'screen:/'] },
  },
  {
    id: 'z11-bearer-token', logic: ['ui.http'], title: 'The token is sent as Bearer, not Basic',
    apply: (t) => t.edit(`${A}/core/http/auth.interceptor.ts`, 'Basic ${token}', 'Bearer ${token}'),
    // the back end only reads Basic: every API call is 401
    truth: { every: true },
  },
  {
    id: 'z12-error-interceptor-dropped', logic: ['ui.http'], title: 'The error interceptor is no longer registered',
    apply: (t) => t.edit(`${A}/app.config.ts`, 'withInterceptors([authInterceptor, errorInterceptor])', 'withInterceptors([authInterceptor])'),
    // a 401 no longer sends anyone home, on any page that calls the API (all of them)
    truth: { every: true },
  },
  {
    id: 'z13-guard-admin-only', logic: ['ui.guards'], title: 'Managers can no longer open the report page',
    apply: (t) => t.edit(`${A}/core/auth/admin.guard.ts`, "session.hasRole('MANAGER') || session.hasRole('ADMIN')", "session.hasRole('ADMIN')"),
    truth: { test: ['screen:/reports'], quiet: ['screen:/orders', 'screen:/customers'] },
  },
  {
    id: 'z14-role-case', logic: ['ui.services'], title: 'Role checks ignore case',
    apply: (t) => t.edit(`${A}/core/auth/session.service.ts`, 'return this.session()?.roles.includes(role) ?? false;', 'return this.session()?.roles.some((r) => r.toUpperCase() === role.toUpperCase()) ?? false;'),
    // the guard on /reports and the Reports link in the navbar, drawn on every page
    truth: { every: true },
  },

  /* ---------- business rules deep in services ---------- */
  {
    id: 'z15-gold-discount', logic: ['java.services'], title: 'Gold customers get 10% off, not 5%',
    apply: (t) => t.edit(`${J}/service/PricingService.java`, 'new BigDecimal("0.95")', 'new BigDecimal("0.90")'),
    // new orders and their invoices; existing orders keep their saved total
    truth: { test: ['screen:/orders/new'], quiet: ['screen:/reports', 'screen:/customers'] },
  },
  {
    id: 'z16-line-total', logic: ['java.services'], title: 'Line totals round to cents',
    apply: (t) => t.edit(`${J}/service/PricingService.java`, 'return product.getPrice().multiply(BigDecimal.valueOf(quantity));', 'return product.getPrice().multiply(BigDecimal.valueOf(quantity)).setScale(2, RoundingMode.HALF_UP);'),
    // lineTotal is used by the daily sales report only; order creation uses orderTotal
    truth: { test: ['screen:/reports'], quiet: ['screen:/orders/new', 'screen:/orders'] },
  },
  {
    id: 'z17-last-unit', logic: ['java.services'], title: 'The last unit in stock can no longer be ordered',
    apply: (t) => t.edit(`${J}/service/InventoryService.java`, 'if (product.getStock() < quantity)', 'if (product.getStock() <= quantity)'),
    truth: { test: ['screen:/orders/new'], quiet: ['screen:/customers', 'screen:/reports'] },
  },
  {
    id: 'z18-release-no-save', logic: ['java.services', 'data.writes'], title: 'Releasing stock no longer saves the product',
    apply: (t) => t.edit(`${J}/service/InventoryService.java`, '        product.setStock(product.getStock() + quantity);\n        products.save(product);', '        product.setStock(product.getStock() + quantity);'),
    // inside cancel's transaction the product is managed and still flushed, but only a test proves it
    truth: { reach: ['screen:/orders/:id'] },
  },
  {
    id: 'z19-paid-not-cancellable', logic: ['java.services'], title: 'Paid orders can no longer be cancelled',
    apply: (t) => t.edit(`${J}/service/OrderService.java`, 'if (order.getStatus() == OrderStatus.SHIPPED) {', 'if (order.getStatus() == OrderStatus.SHIPPED || order.getStatus() == OrderStatus.PAID) {'),
    // the detail page still shows Cancel for PAID orders, and the API now refuses it
    truth: { test: ['screen:/orders/:id'], quiet: ['screen:/orders/new', 'screen:/customers'] },
  },
  {
    id: 'z20-orders-newest-first', logic: ['java.services'], title: 'Order summaries come newest first',
    apply: (t) => t.edit(`${J}/service/OrderService.java`, '            .map(o -> new OrderSummaryDto(o.getId(), o.getCustomer().getName(), o.getStatus(), o.getTotal(), o.getPlacedAt()))\n            .toList();', '            .map(o -> new OrderSummaryDto(o.getId(), o.getCustomer().getName(), o.getStatus(), o.getTotal(), o.getPlacedAt()))\n            .sorted(java.util.Comparator.comparing(OrderSummaryDto::placedAt).reversed())\n            .toList();'),
    truth: { test: ['screen:/orders', 'screen:/'], quiet: ['screen:/orders/:id', 'screen:/reports'] },
  },
  {
    id: 'z21-report-timezone', logic: ['java.services', 'contract.dates'], title: 'The daily report counts days in Berlin time',
    apply: (t) => t.edit(`${J}/service/ReportService.java`, 'o.getPlacedAt().atZone(ZoneOffset.UTC)', 'o.getPlacedAt().atZone(java.time.ZoneId.of("Europe/Berlin"))'),
    truth: { test: ['screen:/reports'], quiet: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'z22-top-three', logic: ['java.services'], title: 'The report shows the top 3 products, not 5',
    apply: (t) => t.edit(`${J}/service/ReportService.java`, '.limit(5)', '.limit(3)'),
    truth: { test: ['screen:/reports'], quiet: ['screen:/orders', 'screen:/products'] },
  },
  {
    id: 'z23-product-active-forced', logic: ['java.endpoints'], title: 'Saving a product always reactivates it',
    apply: (t) => t.edit(`${J}/web/rest/ProductResource.java`, '        product.setId(id);\n        return products.save(product);', '        product.setId(id);\n        product.setActive(true);\n        return products.save(product);'),
    truth: { test: ['screen:/products/:id/edit'], quiet: ['screen:/customers', 'screen:/reports'] },
  },
  {
    id: 'z24-customer-update-no-id', logic: ['java.endpoints'], title: 'Customer update no longer takes the id from the path',
    apply: (t) => t.edit(`${J}/web/rest/CustomerResource.java`, '        customer.setId(id);\n        return customers.save(customer);', '        return customers.save(customer);'),
    // the edit page sends the id in the body, so it still works; a caller that does not creates a duplicate
    truth: { reach: ['screen:/customers/:id/edit'], quiet: ['screen:/products', 'screen:/reports'] },
  },

  /* ---------- shared data access ---------- */
  {
    id: 'z25-findall-filtered', logic: ['data.queries'], title: 'OrderRepository.findAll skips cancelled orders',
    apply: (t) => t.write(`${J}/repository/OrderRepository.java`, t.read(`${J}/repository/OrderRepository.java`).replace('extends JpaRepository<Order, Long> {}', 'extends JpaRepository<Order, Long> {\n    @org.springframework.data.jpa.repository.Query("select o from Order o where o.status <> com.orderdesk.domain.OrderStatus.CANCELLED")\n    java.util.List<Order> findAll();\n}')),
    // the order list, the dashboard and the daily report all call findAll
    truth: { reach: ['screen:/orders', 'screen:/', 'screen:/reports'] },
  },
  {
    id: 'z26-products-by-sku', logic: ['java.endpoints'], title: 'Products are listed by SKU, not name',
    apply: (t) => t.edit(`${J}/web/rest/ProductResource.java`, 'Sort.by("name")', 'Sort.by("sku")'),
    truth: { test: ['screen:/products'], reach: ['screen:/orders/new'], quiet: ['screen:/customers', 'screen:/reports'] },
  },
  {
    id: 'z27-page-size', logic: ['config.app'], title: 'Pages hold 5 rows, not 20',
    apply: (t) => yml(t, 'page-size: 20', 'page-size: 5'),
    // only the product list pages; the dashboard's low-stock box only sees the first page
    truth: { test: ['screen:/products'], reach: ['screen:/orders/new', 'screen:/'], quiet: ['screen:/customers', 'screen:/reports'] },
  },

  /* ---------- the database disagrees with the code ---------- */
  {
    id: 'z28-drop-column-still-mapped', logic: ['data.migrations'], title: 'The phone column is dropped, the entity still maps it',
    apply: (t) => { t.write(`${L}/changelog/0002-phone.xml`, changelog('0002-phone', '    <dropColumn tableName="customer" columnName="phone"/>')); include(t, '0002-phone.xml'); },
    // every query on customer selects phone: the customer pages, the order form, the order detail
    // truth corrected after a run: Order.customer is an eager @ManyToOne, so every query on orders joins customer too
    // (the order list, the dashboard, the daily report), and creating a customer inserts into phone
    truth: { test: ['screen:/customers', 'screen:/customers/:id'], reach: ['screen:/orders/new', 'screen:/orders/:id', 'screen:/customers/:id/edit', 'screen:/customers/new', 'screen:/orders', 'screen:/', 'screen:/reports'] },
  },
  {
    id: 'z29-rename-column-only-db', logic: ['data.migrations'], title: 'product.name is renamed title in the database only',
    apply: (t) => { t.write(`${L}/changelog/0002-title.xml`, changelog('0002-title', '    <renameColumn tableName="product" oldColumnName="name" newColumnName="title"/>')); include(t, '0002-title.xml'); },
    // truth corrected after a run: creating a product, the dashboard's product list and the daily report (it walks order items to products) too
    truth: { test: ['screen:/products'], reach: ['screen:/orders/:id', 'screen:/orders/new', 'screen:/products/:id/edit', 'screen:/products/new', 'screen:/', 'screen:/reports'], quiet: ['screen:/orders'] },
  },
  {
    id: 'z30-not-null-no-default', logic: ['data.migrations'], title: 'A NOT NULL column with no default on product',
    apply: (t) => { t.write(`${L}/changelog/0002-category.xml`, changelog('0002-category', '    <addColumn tableName="product">\n      <column name="category" type="varchar(40)">\n        <constraints nullable="false"/>\n      </column>\n    </addColumn>')); include(t, '0002-category.xml'); },
    // the entity never fills it: creating a product fails; on a table with rows the migration itself fails
    truth: { test: ['screen:/products/new'], say: [/category/] },
  },

  /* ---------- what runs inside the request without being called ---------- */
  {
    id: 'z31-mail-host', logic: ['config.framework', 'java.events'], title: 'A new mail host',
    apply: (t) => yml(t, 'host: smtp.internal.example', 'host: smtp.mail.example'),
    // the order mail is sent by a plain @EventListener, inside order creation: if mail fails, the order fails
    truth: { reach: ['screen:/orders/new'] },
  },
  {
    id: 'z32-mail-recipient', logic: ['java.events'], title: 'Order mails go to orders@',
    apply: (t) => t.edit(`${J}/service/NotificationService.java`, 'message.setTo("sales@orderdesk.example");', 'message.setTo("orders@orderdesk.example");'),
    truth: { reach: ['screen:/orders/new'], quiet: ['screen:/customers', 'screen:/reports'] },
  },
  {
    id: 'z33-invoice-after-commit', logic: ['java.events'], title: 'Invoices are made after the order commits',
    apply: (t) => t.edit(`${J}/service/InvoiceService.java`, '    @EventListener', '    @org.springframework.transaction.event.TransactionalEventListener'),
    // order creation no longer fails when the invoice does; the invoice may be missing instead
    truth: { reach: ['screen:/orders/new'], say: [/onOrderPlaced|[Ii]nvoice/] },
  },
  {
    id: 'z34-alert-cron', logic: ['config.app', 'java.jobs'], title: 'The stock alert runs at 06:00',
    apply: (t) => yml(t, 'stock-alert-cron: "0 0 7 * * MON-FRI"', 'stock-alert-cron: "0 0 6 * * MON-FRI"'),
    truth: { say: [/StockAlertJob|stock alert|alert/i], quiet: ['screen:/products', 'screen:/', 'screen:/orders'] },
  },
  {
    id: 'z35-threshold', logic: ['config.app', 'java.jobs'], title: 'Low stock means under 10',
    apply: (t) => yml(t, 'low-stock-threshold: 5', 'low-stock-threshold: 10'),
    // the dashboard has its own 5 in the front end: only the alert job changes
    truth: { say: [/StockAlertJob|alert/i], quiet: ['screen:/', 'screen:/products'] },
  },

  /* ---------- the front end, far from the page ---------- */
  {
    id: 'z36-product-url-slash', logic: ['ui.services'], title: 'The product service URL gains a trailing slash',
    apply: (t) => t.edit(`${A}/products/product.service.ts`, 'private readonly url = `${API}/products`;', 'private readonly url = `${API}/products/`;'),
    // /api/products/?page=0 and /api/products//1: Spring no longer matches either
    truth: { test: ['screen:/products'], reach: ['screen:/products/:id/edit', 'screen:/orders/new', 'screen:/'] },
  },
  {
    id: 'z37-line-quantity-ui', logic: ['ui.forms'], title: 'The order form allows at most 20 per line',
    apply: (t) => t.edit(`${A}/orders/order-create/order-create.ts`, 'Validators.max(99)', 'Validators.max(20)'),
    truth: { test: ['screen:/orders/new'], quiet: ['screen:/orders', 'screen:/orders/:id'] },
  },
  {
    id: 'z38-badge-shipped', logic: ['ui.components'], title: 'Shipped orders get their own badge colour',
    apply: (t) => t.edit(`${A}/shared/status-badge/status-badge.ts`, '      .cancelled { background: #fcebe9; }', '      .cancelled { background: #fcebe9; }\n      .shipped { background: #e6eefc; }'),
    truth: { reach: ['screen:/orders/:id', 'screen:/'], quiet: ['screen:/customers', 'screen:/products'] },
  },
  {
    id: 'z39-confirm-words', logic: ['ui.components'], title: 'The confirm dialog says Confirm and Keep',
    apply: (t) => t.edit(`${A}/shared/confirm-dialog/confirm-dialog.ts`, '(click)="confirmed.emit()">Yes</button>', '(click)="confirmed.emit()">Confirm</button>'),
    truth: { test: ['screen:/orders/:id'], quiet: ['screen:/orders', 'screen:/customers'] },
  },
  {
    id: 'z40-customer-resolver', logic: ['ui.routing'], title: 'The customer resolver sends unknown ids back to the list',
    apply: (t) => t.write(`${A}/customers/customer.resolver.ts`, t.read(`${A}/customers/customer.resolver.ts`).replace("import { ActivatedRouteSnapshot, ResolveFn } from '@angular/router';", "import { ActivatedRouteSnapshot, ResolveFn, Router } from '@angular/router';\nimport { EMPTY, catchError } from 'rxjs';").replace('inject(CustomerService).get(Number(route.paramMap.get(\'id\')));', "{\n  const router = inject(Router);\n  return inject(CustomerService).get(Number(route.paramMap.get('id'))).pipe(catchError(() => { router.navigateByUrl('/customers'); return EMPTY; }));\n};")),
    truth: { test: ['screen:/customers/:id', 'screen:/customers/:id/edit'], quiet: ['screen:/customers', 'screen:/orders'] },
  },
  {
    id: 'z41-reports-title', logic: ['ui.routing'], title: 'The report page title reads Sales report',
    apply: (t) => t.edit(`${A}/app.routes.ts`, "title: 'Reports',", "title: 'Sales report',"),
    truth: { reach: ['screen:/reports'], quiet: ['screen:/orders', 'screen:/customers', 'screen:/products'] },
  },
  {
    id: 'z42-products-move', logic: ['ui.routing'], title: 'Products move to /catalog',
    apply: (t) => t.edit(`${A}/app.routes.ts`, "path: 'products',", "path: 'catalog',"),
    // the pages move, and the navbar link on every page still points to /products
    truth: { every: true },
  },
];
