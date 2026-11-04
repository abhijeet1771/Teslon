import { contractProbes } from './catalog-contracts.mjs';
import { hardestProbes } from './catalog-hardest.mjs';
/**
 * The probe catalog: real developer pull requests on OrderDesk, one per kind
 * of change, each tagged with the engine logic it exercises. The truth was
 * written from the app's code before Teslon ran.
 *
 *   base(t)     optional: code the app has before the PR (added to OrderDesk for this probe)
 *   apply(t)    the PR
 *   truth.test      areas that must be listed to test
 *   truth.reach     areas the change reaches: listed to test, or held as unclear; never skipped, never missing
 *   truth.every     the change reaches every screen
 *   truth.notSkip   areas never to call safe ('*' = every screen)
 *   truth.say       what must be said, in "could not see", an area's reason or a case
 *   truth.nothing   no runtime effect: nothing to test
 *   truth.quiet     a change with no effect a user can see: no screen to test (precision, P3)
 *
 * Area ids: screen:/path, screen:* (every screen), api:VERB /path, job:Class.method.
 */

const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';
const L = 'src/main/resources/config/liquibase';

export const SCREENS = ['/', '/customers', '/customers/new', '/customers/:id', '/customers/:id/edit', '/products', '/products/new', '/products/:id/edit', '/orders', '/orders/new', '/orders/:id', '/reports'];

const changelog = (id, body) => `<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="${id}" author="dev">
${body}
  </changeSet>
</databaseChangeLog>
`;
const include = (t, file) => t.edit(`${L}/master.xml`, '</databaseChangeLog>', `  <include file="config/liquibase/changelog/${file}"/>\n</databaseChangeLog>`);

export const probes = [
  /* ---------------- Java: logic followed through callers ---------------- */
  {
    id: 'j01-static-util', logic: ['java.static-call', 'java.callers'],
    title: 'Rounding in a static helper changes',
    base: (t) => {
      t.write(`${J}/service/Totals.java`, 'package com.orderdesk.service;\n\nimport java.math.BigDecimal;\nimport java.math.RoundingMode;\n\npublic final class Totals {\n\n    private Totals() {}\n\n    public static BigDecimal round(BigDecimal v) {\n        return v == null ? null : v.setScale(2, RoundingMode.HALF_UP);\n    }\n}\n');
      t.edit(`${J}/service/OrderService.java`, 'o.getStatus(), o.getTotal(), o.getPlacedAt()', 'o.getStatus(), Totals.round(o.getTotal()), o.getPlacedAt()');
    },
    apply: (t) => t.edit(`${J}/service/Totals.java`, 'RoundingMode.HALF_UP', 'RoundingMode.DOWN'),
    // the order list and the dashboard show totals from GET /api/orders
    truth: { test: ['api:GET /api/orders'], reach: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'j02-constant', logic: ['java.field-constant', 'java.callers'],
    title: 'A limit kept in a constant goes down',
    base: (t) => {
      t.edit(`${J}/service/OrderService.java`, 'public class OrderService {\n', 'public class OrderService {\n\n    private static final int MAX_LINES = 50;\n');
      t.edit(`${J}/service/OrderService.java`, '        Customer customer = customers.findById(request.customerId()).orElseThrow();\n', '        if (request.lines().size() > MAX_LINES) {\n            throw new IllegalArgumentException("Too many lines");\n        }\n        Customer customer = customers.findById(request.customerId()).orElseThrow();\n');
    },
    apply: (t) => t.edit(`${J}/service/OrderService.java`, 'MAX_LINES = 50;', 'MAX_LINES = 20;'),
    truth: { test: ['screen:/orders/new', 'api:POST /api/orders'] },
  },
  {
    id: 'j03-transactional', logic: ['java.annotation', 'java.callers'],
    title: 'Order creation becomes one transaction',
    apply: (t) => t.edit(`${J}/service/OrderService.java`, '    public Order create(CreateOrderRequest request) {', '    @Transactional\n    public Order create(CreateOrderRequest request) {'),
    truth: { test: ['screen:/orders/new'] },
  },
  {
    id: 'j04-jpql', logic: ['java.query-annotation', 'java.repository', 'java.callers'],
    title: 'The open-orders query also drops zero totals',
    base: (t) => {
      t.write(`${J}/repository/OrderRepository.java`, 'package com.orderdesk.repository;\n\nimport com.orderdesk.domain.Order;\nimport java.util.List;\nimport org.springframework.data.jpa.repository.JpaRepository;\nimport org.springframework.data.jpa.repository.Query;\n\npublic interface OrderRepository extends JpaRepository<Order, Long> {\n\n    @Query("select o from Order o where o.status <> com.orderdesk.domain.OrderStatus.CANCELLED")\n    List<Order> findOpen();\n}\n');
      t.edit(`${J}/service/OrderService.java`, '        return orders.findAll().stream()\n            .map(o -> new OrderSummaryDto', '        return orders.findOpen().stream()\n            .map(o -> new OrderSummaryDto');
    },
    apply: (t) => t.edit(`${J}/repository/OrderRepository.java`, 'OrderStatus.CANCELLED")', 'OrderStatus.CANCELLED and o.total > 0")'),
    truth: { test: ['api:GET /api/orders'], reach: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'j05-derived-query', logic: ['java.repository', 'java.jobs'],
    title: 'Stock alert includes products at the threshold',
    apply: (t) => {
      t.edit(`${J}/repository/ProductRepository.java`, 'findByStockLessThan(int threshold)', 'findByStockLessThanEqual(int threshold)');
      t.edit(`${J}/jobs/StockAlertJob.java`, 'products.findByStockLessThan(', 'products.findByStockLessThanEqual(');
    },
    truth: { test: ['job:StockAlertJob.alert'] },
  },
  {
    id: 'j06-entity-default', logic: ['java.entity-code', 'data.writes'],
    title: 'New orders start as PAID',
    apply: (t) => t.edit(`${J}/domain/Order.java`, 'private OrderStatus status = OrderStatus.NEW;', 'private OrderStatus status = OrderStatus.PAID;'),
    // every new order is saved as PAID: the list, the detail and the dashboard show it, and it can no longer be paid
    truth: { reach: ['screen:/orders/new', 'screen:/orders', 'screen:/orders/:id', 'screen:/'] },
  },
  {
    id: 'j07-enum-rename', logic: ['java.enum', 'json.shape', 'data.stored-values'],
    title: 'SHIPPED is renamed DISPATCHED',
    apply: (t) => {
      t.edit(`${J}/domain/OrderStatus.java`, '    SHIPPED,', '    DISPATCHED,');
      t.edit(`${J}/service/OrderService.java`, 'OrderStatus.SHIPPED', 'OrderStatus.DISPATCHED');
    },
    // the JSON now says DISPATCHED where the front end expects SHIPPED, and rows stored as 'SHIPPED' no longer load
    truth: { reach: ['screen:/orders', 'screen:/orders/:id', 'screen:/'], say: [/SHIPPED/] },
  },
  {
    id: 'j08-new-required-field', logic: ['java.request-rules'],
    title: 'Orders need a sales channel',
    apply: (t) => t.edit(`${J}/service/dto/CreateOrderRequest.java`, '    @Size(max = 500) String note\n', '    @Size(max = 500) String note,\n    @NotNull String channel\n'),
    // the order form does not send it: every new order is refused
    truth: { test: ['screen:/orders/new', 'api:POST /api/orders'] },
  },
  {
    id: 'j09-record-field-rename', logic: ['json.shape', 'java.record'],
    title: 'OrderSummaryDto.customerName becomes customer',
    apply: (t) => t.edit(`${J}/service/dto/OrderSummaryDto.java`, 'String customerName', 'String customer'),
    // the order list and the dashboard read customerName
    truth: { test: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'j10-error-message', logic: ['java.callers'],
    title: 'A clearer message when a shipped order is cancelled',
    apply: (t) => t.edit(`${J}/service/OrderService.java`, '"Shipped orders cannot be cancelled"', '"This order has left the warehouse and cannot be cancelled"'),
    truth: { test: ['api:POST /api/orders/{id}/cancel'], reach: ['screen:/orders/:id'] },
  },
  {
    id: 'j11-listener-body', logic: ['java.jobs', 'data.writes'],
    title: 'Invoice numbers get a slash',
    apply: (t) => t.edit(`${J}/service/InvoiceService.java`, '"INV-" + order.getId()', '"INV/" + order.getId()'),
    // truth corrected after a run: the listener is a plain @EventListener, so it runs inside order creation, and its failure fails the order
    truth: { test: ['job:InvoiceService.onOrderPlaced'], reach: ['screen:/orders/new'] },
  },
  {
    id: 'j12-unparseable', logic: ['robust.unreadable'],
    title: 'A half-finished edit that does not compile',
    apply: (t) => t.edit(`${J}/service/PricingService.java`, '    public BigDecimal lineTotal(Product product, int quantity) {\n', '    public BigDecimal lineTotal(Product product, int quantity) {\n        if (quantity < 0 {\n'),
    truth: { notSkip: '*', say: [/PricingService\.java/] },
  },
  {
    id: 'j13-endpoint-added', logic: ['java.endpoints'],
    title: 'A new endpoint: order count',
    apply: (t) => t.edit(`${J}/web/rest/OrderResource.java`, '    @PostMapping("/{id}/cancel")', '    @GetMapping("/count")\n    public long count() {\n        return orders.list().size();\n    }\n\n    @PostMapping("/{id}/cancel")'),
    truth: { test: ['api:GET /api/orders/count'], quiet: SCREENS.map((p) => `screen:${p}`) },
  },
  {
    id: 'j14-error-handler', logic: ['java.config-class'],
    title: 'Not found answers 400 instead of 404',
    base: (t) => t.write(`${J}/web/rest/GlobalErrors.java`, 'package com.orderdesk.web.rest;\n\nimport java.util.NoSuchElementException;\nimport org.springframework.http.HttpStatus;\nimport org.springframework.http.ResponseEntity;\nimport org.springframework.web.bind.annotation.ExceptionHandler;\nimport org.springframework.web.bind.annotation.RestControllerAdvice;\n\n@RestControllerAdvice\npublic class GlobalErrors {\n\n    @ExceptionHandler(NoSuchElementException.class)\n    public ResponseEntity<String> notFound(NoSuchElementException e) {\n        return ResponseEntity.status(HttpStatus.NOT_FOUND).body("not found");\n    }\n}\n'),
    apply: (t) => t.edit(`${J}/web/rest/GlobalErrors.java`, 'HttpStatus.NOT_FOUND', 'HttpStatus.BAD_REQUEST'),
    // every lookup by id that misses now answers 400: the detail and edit screens handle that differently
    truth: { notSkip: ['screen:/orders/:id', 'screen:/customers/:id', 'screen:/customers/:id/edit', 'screen:/products/:id/edit'], reach: ['screen:/orders/:id', 'screen:/customers/:id'] },
  },

  /* ---------------- Java: what runs without being called ---------------- */
  {
    id: 'j15-aspect', logic: ['java.aspects'],
    title: 'The service logging aspect now swallows errors',
    base: (t) => t.write(`${J}/config/ServiceLogging.java`, 'package com.orderdesk.config;\n\nimport org.aspectj.lang.ProceedingJoinPoint;\nimport org.aspectj.lang.annotation.Around;\nimport org.aspectj.lang.annotation.Aspect;\nimport org.springframework.stereotype.Component;\n\n@Aspect\n@Component\npublic class ServiceLogging {\n\n    @Around("execution(* com.orderdesk.service..*(..))")\n    public Object log(ProceedingJoinPoint pjp) throws Throwable {\n        return pjp.proceed();\n    }\n}\n'),
    apply: (t) => t.edit(`${J}/config/ServiceLogging.java`, '        return pjp.proceed();\n', '        try {\n            return pjp.proceed();\n        } catch (RuntimeException e) {\n            return null;\n        }\n'),
    // every method in com.orderdesk.service runs inside it: the order and report APIs and the jobs that use services.
    // truth corrected after a run: the customer and product APIs call repositories directly, so the aspect does not wrap them
    truth: { test: ['api:POST /api/orders', 'api:GET /api/orders', 'api:GET /api/reports/daily-sales'], reach: ['screen:/orders', 'screen:/orders/new', 'screen:/orders/:id', 'screen:/', 'screen:/reports'], notSkip: ['job:StockAlertJob.alert', 'job:InvoiceService.onOrderPlaced'] },
  },
  {
    id: 'j16-jdbc-write', logic: ['java.jdbc', 'data.writes'],
    title: 'A nightly job marks old orders as PAID with plain SQL',
    base: (t) => t.write(`${J}/jobs/SettleJob.java`, 'package com.orderdesk.jobs;\n\nimport org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.scheduling.annotation.Scheduled;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class SettleJob {\n\n    private final JdbcTemplate jdbc;\n\n    public SettleJob(JdbcTemplate jdbc) {\n        this.jdbc = jdbc;\n    }\n\n    @Scheduled(cron = "0 0 2 * * *")\n    public void settle() {\n        jdbc.update("update orders set status = \'PAID\' where status = \'NEW\' and placed_at < now() - interval \'30 days\'");\n    }\n}\n'),
    apply: (t) => t.edit(`${J}/jobs/SettleJob.java`, "interval '30 days'", "interval '7 days'"),
    // the job writes orders: the list, the detail and the dashboard show what it wrote
    truth: { test: ['job:SettleJob.settle'], notSkip: ['screen:/orders', 'screen:/orders/:id', 'screen:/'] },
  },
  {
    id: 'j17-cacheable', logic: ['java.annotation'],
    title: 'Order lookups are cached',
    apply: (t) => {
      t.edit(`${J}/service/OrderService.java`, '    @Transactional(readOnly = true)\n    public Order find(Long id) {', '    @org.springframework.cache.annotation.Cacheable("orders")\n    @Transactional(readOnly = true)\n    public Order find(Long id) {');
    },
    // the detail can now show an order as it was before a cancel
    truth: { test: ['screen:/orders/:id'] },
  },
  {
    id: 'j18-preauthorize', logic: ['java.security'],
    title: 'Only managers may cancel orders',
    apply: (t) => t.edit(`${J}/web/rest/OrderResource.java`, '    @PostMapping("/{id}/cancel")', '    @org.springframework.security.access.prepost.PreAuthorize("hasRole(\'MANAGER\')")\n    @PostMapping("/{id}/cancel")'),
    truth: { test: ['api:POST /api/orders/{id}/cancel'], reach: ['screen:/orders/:id'] },
  },
  {
    id: 'c04-conditional-flag', logic: ['config.flags'],
    title: 'Order e-mails are switched off',
    base: (t) => {
      t.edit(`${J}/service/NotificationService.java`, '@Service\npublic class NotificationService {', '@Service\n@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(prefix = "orderdesk", name = "mail-enabled", havingValue = "true")\npublic class NotificationService {');
      t.edit('src/main/resources/application.yml', '  page-size: 20\n', '  page-size: 20\n  mail-enabled: true\n');
    },
    apply: (t) => t.edit('src/main/resources/application.yml', '  mail-enabled: true\n', '  mail-enabled: false\n'),
    // the bean is gone: no order e-mail, no stock alert e-mail, and the stock alert job cannot start without it
    // truth corrected after a run: the order e-mail listener runs inside order creation, so the order form is reached too
    truth: { notSkip: ['job:NotificationService.onOrderPlaced', 'job:StockAlertJob.alert'], reach: ['job:NotificationService.onOrderPlaced', 'screen:/orders/new'] },
  },

  {
    id: 'j19-mapper', logic: ['java.static-call', 'json.values'],
    title: 'The order summary mapper shows the e-mail instead of the name',
    base: (t) => {
      t.write(`${J}/service/dto/OrderMapper.java`, 'package com.orderdesk.service.dto;\n\nimport com.orderdesk.domain.Order;\n\npublic final class OrderMapper {\n\n    private OrderMapper() {}\n\n    public static OrderSummaryDto toSummary(Order o) {\n        return new OrderSummaryDto(o.getId(), o.getCustomer().getName(), o.getStatus(), o.getTotal(), o.getPlacedAt());\n    }\n}\n');
      t.edit(`${J}/service/OrderService.java`, '            .map(o -> new OrderSummaryDto(o.getId(), o.getCustomer().getName(), o.getStatus(), o.getTotal(), o.getPlacedAt()))', '            .map(com.orderdesk.service.dto.OrderMapper::toSummary)');
    },
    apply: (t) => t.edit(`${J}/service/dto/OrderMapper.java`, 'o.getCustomer().getName()', 'o.getCustomer().getEmail()'),
    // the customer column of the order list and the dashboard show an e-mail
    truth: { test: ['api:GET /api/orders'], reach: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'j20-async', logic: ['java.annotation', 'java.jobs'],
    title: 'Order e-mails are sent in the background',
    apply: (t) => t.edit(`${J}/service/NotificationService.java`, '    @EventListener\n    public void onOrderPlaced', '    @org.springframework.scheduling.annotation.Async\n    @EventListener\n    public void onOrderPlaced'),
    truth: { test: ['job:NotificationService.onOrderPlaced'] },
  },
  {
    id: 'j21-two-implementations', logic: ['java.interfaces'],
    title: 'The default tax rule rounds differently',
    base: (t) => {
      t.write(`${J}/service/TaxPolicy.java`, 'package com.orderdesk.service;\n\nimport java.math.BigDecimal;\n\npublic interface TaxPolicy {\n    BigDecimal apply(BigDecimal net);\n}\n');
      t.write(`${J}/service/StandardTax.java`, 'package com.orderdesk.service;\n\nimport java.math.BigDecimal;\nimport java.math.RoundingMode;\nimport org.springframework.context.annotation.Primary;\nimport org.springframework.stereotype.Component;\n\n@Primary\n@Component\npublic class StandardTax implements TaxPolicy {\n    public BigDecimal apply(BigDecimal net) {\n        return net.multiply(new BigDecimal("1.20")).setScale(2, RoundingMode.HALF_UP);\n    }\n}\n');
      t.write(`${J}/service/ExportTax.java`, 'package com.orderdesk.service;\n\nimport java.math.BigDecimal;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class ExportTax implements TaxPolicy {\n    public BigDecimal apply(BigDecimal net) {\n        return net;\n    }\n}\n');
      t.edit(`${J}/service/OrderService.java`, '        order.setTotal(pricing.orderTotal(customer, order.getItems()));', '        order.setTotal(tax.apply(pricing.orderTotal(customer, order.getItems())));');
      t.edit(`${J}/service/OrderService.java`, '    private final PricingService pricing;', '    private final PricingService pricing;\n    @org.springframework.beans.factory.annotation.Autowired\n    private TaxPolicy tax;');
    },
    apply: (t) => t.edit(`${J}/service/StandardTax.java`, 'RoundingMode.HALF_UP', 'RoundingMode.HALF_EVEN'),
    truth: { test: ['screen:/orders/new'], notSkip: ['screen:/orders', 'screen:/orders/:id', 'job:InvoiceService.onOrderPlaced'] },
  },
  {
    id: 'j22-kafka-listener', logic: ['java.jobs', 'data.writes'],
    title: 'Payment messages mark orders as PAID only when settled',
    base: (t) => t.write(`${J}/service/PaymentListener.java`, 'package com.orderdesk.service;\n\nimport com.orderdesk.domain.Order;\nimport com.orderdesk.domain.OrderStatus;\nimport com.orderdesk.repository.OrderRepository;\nimport org.springframework.kafka.annotation.KafkaListener;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class PaymentListener {\n\n    private final OrderRepository orders;\n\n    public PaymentListener(OrderRepository orders) {\n        this.orders = orders;\n    }\n\n    @KafkaListener(topics = "payments")\n    public void onPayment(String orderId) {\n        Order order = orders.findById(Long.valueOf(orderId)).orElseThrow();\n        order.setStatus(OrderStatus.PAID);\n        orders.save(order);\n    }\n}\n'),
    apply: (t) => t.edit(`${J}/service/PaymentListener.java`, '        order.setStatus(OrderStatus.PAID);\n', '        if (order.getStatus() == OrderStatus.NEW) {\n            order.setStatus(OrderStatus.PAID);\n        }\n'),
    truth: { test: ['job:PaymentListener.onPayment'], notSkip: ['screen:/orders', 'screen:/orders/:id', 'screen:/'] },
  },
  {
    id: 'r01-many-new-classes', logic: ['robust.size'],
    title: '300 generated classes nothing uses yet',
    apply: (t) => { for (let i = 0; i < 300; i++) t.write(`${J}/generated/Gen${i}.java`, `package com.orderdesk.generated;\n\npublic class Gen${i} {\n    public int value() {\n        return ${i};\n    }\n}\n`); },
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },

  /* ---------------- Front end ---------------- */
  {
    id: 'u01-route-renamed', logic: ['ui.routes', 'ui.links'],
    title: 'Order detail moves to /orders/view/:id',
    apply: (t) => t.edit(`${A}/orders/orders.routes.ts`, "path: ':id',", "path: 'view/:id',"),
    // the list, the dashboard and the form after saving still link to /orders/:id
    truth: { test: ['screen:/orders/:id'], reach: ['screen:/orders', 'screen:/', 'screen:/orders/new'] },
  },
  {
    id: 'u02-guard-added', logic: ['ui.routes', 'ui.guards'],
    title: 'Only admins may add products',
    apply: (t) => {
      t.edit(`${A}/products/products.routes.ts`, "import { ProductService } from './product.service';", "import { ProductService } from './product.service';\nimport { adminGuard } from '../core/auth/admin.guard';");
      t.edit(`${A}/products/products.routes.ts`, "    path: 'new',\n", "    path: 'new',\n    canActivate: [adminGuard],\n");
    },
    truth: { test: ['screen:/products/new'] },
  },
  {
    id: 'u03-service-url', logic: ['ui.services', 'contract.urls'],
    title: 'Customer service calls /api/clients',
    apply: (t) => t.edit(`${A}/customers/customer.service.ts`, '`${API}/customers`', '`${API}/clients`'),
    // no endpoint answers /api/clients: every customer screen, and the order form's customer list, break
    truth: { test: ['screen:/customers', 'screen:/customers/:id', 'screen:/customers/new', 'screen:/customers/:id/edit', 'screen:/orders/new'] },
  },
  {
    id: 'u04-form-validator', logic: ['ui.forms'],
    title: 'The order form caps the note at 200',
    apply: (t) => t.edit(`${A}/orders/order-create/order-create.ts`, 'Validators.maxLength(500)', 'Validators.maxLength(200)'),
    truth: { test: ['screen:/orders/new'] },
  },
  {
    id: 'u05-api-base', logic: ['ui.config', 'ui.shell'],
    title: 'API base moves to /api/v2',
    apply: (t) => t.edit(`${A}/core/config/api.ts`, "'/api'", "'/api/v2'"),
    truth: { every: true },
  },
  {
    id: 'u06-session-key', logic: ['ui.shell', 'ui.services'],
    title: 'The session token key is renamed',
    apply: (t) => t.edit(`${A}/core/auth/session.service.ts`, "'orderdesk.token'", "'od.token'"),
    // the auth interceptor reads it on every call: everyone looks logged out
    truth: { every: true },
  },
  {
    id: 'u07-type-only', logic: ['ui.types'],
    title: 'A new optional field on the IOrder type',
    apply: (t) => t.edit(`${A}/orders/order.model.ts`, '  note?: string | null;\n}', '  note?: string | null;\n  channel?: string;\n}'),
    // types are erased when the app is built: nothing a user sees changes
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },
  {
    id: 'u08-template-text', logic: ['ui.templates'],
    title: 'Order list heading wording',
    apply: (t) => t.edit(`${A}/orders/order-list/order-list.html`, '<h2>Orders ', '<h2>All orders '),
    truth: { test: ['screen:/orders'], quiet: SCREENS.filter((p) => p !== '/orders').map((p) => `screen:${p}`) },
  },
  {
    id: 'u09-pipe', logic: ['ui.pipes'],
    title: 'Money shows in dollars',
    apply: (t) => t.edit(`${A}/shared/money.pipe.ts`, "currency = 'EUR'", "currency = 'USD'"),
    // truth corrected after the first run: the dashboard shows {{ o.total | money }} too (dashboard.html:8)
    truth: { test: ['screen:/orders', 'screen:/orders/:id', 'screen:/products', 'screen:/reports', 'screen:/'] },
  },
  {
    id: 'u10-global-style', logic: ['ui.styles', 'ui.shell'],
    title: 'Smaller table text everywhere',
    apply: (t) => t.write('src/main/webapp/styles.scss', `${t.read('src/main/webapp/styles.scss')}\ntable { font-size: 13px; }\n`),
    truth: { every: true },
  },
  {
    id: 'u11-index-html', logic: ['ui.shell'],
    title: 'Page title in index.html',
    apply: (t) => t.edit('src/main/webapp/index.html', '<title>', '<title>OrderDesk · '),
    truth: { every: true },
  },

  /* ---------------- Data ---------------- */
  {
    id: 'd01-modify-type', logic: ['data.migrations'],
    title: 'The order note column shrinks to 100',
    apply: (t) => {
      t.write(`${L}/changelog/0002-note.xml`, changelog('0002-note', '    <modifyDataType tableName="orders" columnName="note" newDataType="varchar(100)"/>'));
      include(t, '0002-note.xml');
    },
    // the API still takes 500 characters: longer notes fail on save
    // truth corrected after a run: cancelling saves the whole order row again, note included (order detail)
    truth: { reach: ['screen:/orders/new', 'screen:/orders/:id'], say: [/note/] },
  },
  {
    id: 'd02-index-only', logic: ['data.migrations'],
    title: 'An index on orders.placed_at',
    apply: (t) => {
      t.write(`${L}/changelog/0002-index.xml`, changelog('0002-index', '    <createIndex tableName="orders" indexName="idx_orders_placed_at">\n      <column name="placed_at"/>\n    </createIndex>'));
      include(t, '0002-index.xml');
    },
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },
  {
    id: 'd03-seed-data', logic: ['data.seed'],
    title: 'A seeded product price changes',
    base: (t) => {
      t.write(`${L}/data/product.csv`, 'id;sku;name;price;stock\n1;SKU-1;Paper;4.50;100\n2;SKU-2;Pens;2.00;250\n');
      t.write(`${L}/changelog/0002-seed.xml`, changelog('0002-seed', '    <loadData tableName="product" file="config/liquibase/data/product.csv" separator=";"/>'));
      include(t, '0002-seed.xml');
    },
    apply: (t) => t.edit(`${L}/data/product.csv`, '1;SKU-1;Paper;4.50;100', '1;SKU-1;Paper;5.00;100'),
    // truth corrected after a run: the dashboard's low-stock list and the product edit form show the seeded rows too
    truth: { notSkip: ['screen:/products', 'screen:/orders/new', 'screen:/', 'screen:/products/:id/edit'], say: [/product\.csv/] },
  },

  /* ---------------- Configuration ---------------- */
  {
    id: 'c01-logging', logic: ['config.framework'],
    title: 'Debug logging for com.orderdesk',
    apply: (t) => t.write('src/main/resources/application.yml', `${t.read('src/main/resources/application.yml')}\nlogging:\n  level:\n    com.orderdesk: DEBUG\n`),
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },
  {
    id: 'c02-context-path', logic: ['config.framework'],
    title: 'The app moves under /desk',
    apply: (t) => t.write('src/main/resources/application.yml', `${t.read('src/main/resources/application.yml')}\nserver:\n  servlet:\n    context-path: /desk\n`),
    truth: { every: true },
  },
  {
    id: 'c03-unused-key', logic: ['config.own-keys'],
    title: 'A flag nothing reads yet',
    apply: (t) => t.edit('src/main/resources/application.yml', '  page-size: 20\n', '  page-size: 20\n  new-checkout: false\n'),
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },

  /* ---------------- Dependencies ---------------- */
  {
    id: 'x01-dev-dependency', logic: ['deps.npm'],
    title: 'ESLint added for developers',
    apply: (t) => t.edit('package.json', '    "typescript": "5.9.3"', '    "typescript": "5.9.3",\n    "eslint": "9.12.0"'),
    truth: { quiet: SCREENS.map((p) => `screen:${p}`) },
  },
  {
    id: 'x02-runtime-dependency', logic: ['deps.npm'],
    title: 'rxjs patch bump',
    apply: (t) => t.edit('package.json', '"rxjs": "7.8.2"', '"rxjs": "7.8.1"'),
    truth: { every: true },
  },
  {
    id: 'x03-spring-boot', logic: ['deps.maven'],
    title: 'Spring Boot minor bump',
    apply: (t) => t.edit('pom.xml', '<version>3.5.6</version>', '<version>3.5.7</version>'),
    // truth corrected after the first run: the framework under every endpoint moves, so every screen is reached
    truth: { every: true },
  },
  ...contractProbes,
  ...hardestProbes,
];
