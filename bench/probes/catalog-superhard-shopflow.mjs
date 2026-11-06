/**
 * Super-hard PRs on ShopFlow: start-up checks in one service, the gateway in front of all of them, build
 * settings, the browser shell, and code Teslon does not read. Truth first, by reading the app.
 * Tiers, in the id: v1 (hard) … v4 (super hardest).
 */
const O = 'orders-service/src/main/java/com/shopflow/orders';
const N = 'notification-service/src/main/java/com/shopflow/notifications';
const C = 'catalog-service/src/main/java/com/shopflow/catalog';
const UI = 'frontend/src';
const GW = 'gateway/src/main/resources/application.yml';
const S = (...p) => p.map((x) => `screen:${x}`);
// everything orders-service serves, and its listener
const ORDERS = [...S('/', '/orders', '/orders/new', '/orders/:id'), 'job:PaymentResultListener.onPaymentResult'];
const INVOICES = S('/invoices', '/invoices/:id', '/orders/:id');

export const superhardShopflowProbes = [
  {
    id: 'v4-01-flyway-edited', logic: ['data.migrations', 'spring.startup'], title: 'The applied orders migration is edited in place',
    apply: (t) => t.edit('orders-service/src/main/resources/db/migration/V1__orders.sql', '    payment_failure_reason varchar(500)', '    payment_failure_reason varchar(500),\n    channel varchar(20)'),
    // Flyway validates checksums on start: every database that ran V1 refuses, and orders-service does not start
    truth: { notSkip: ORDERS },
  },
  {
    id: 'v4-02-flyway-below-applied', logic: ['data.migrations', 'spring.startup'], title: 'A migration numbered below the one already applied',
    apply: (t) => t.write('orders-service/src/main/resources/db/migration/V0_9__channel.sql', 'alter table orders add column channel varchar(20);\n'),
    // V0.9 resolved but not applied, below V1: validation fails, orders-service does not start
    truth: { notSkip: ORDERS },
  },
  {
    id: 'v3-03-feign-name', logic: ['services.feign', 'services.discovery'], title: 'The catalog client asks for "catalog" instead of "catalog-service"',
    apply: (t) => t.edit(`${O}/client/CatalogClient.java`, '@FeignClient(name = "catalog-service")', '@FeignClient(name = "catalog")'),
    // no service is registered as "catalog": placing an order cannot price its lines
    truth: { test: S('/orders/new') },
  },
  {
    id: 'v3-04-gateway-strip-two', logic: ['services.gateway-routes'], title: 'The gateway strips two path parts from invoice calls',
    apply: (t) => {
      const y = t.read(GW);
      const i = y.indexOf('- id: invoices');
      t.write(GW, y.slice(0, i) + y.slice(i).replace('- StripPrefix=1', '- StripPrefix=2'));
    },
    // /api/invoices/by-order/5 reaches billing as /by-order/5: every invoice call is a 404
    truth: { reach: INVOICES, quiet: S('/products', '/notifications') },
  },
  {
    id: 'v4-05-gateway-catch-all-first', logic: ['services.gateway-routes'], title: 'A catch-all route to orders-service goes first',
    apply: (t) => t.edit(GW, '      routes:\n', '      routes:\n        - id: legacy\n          uri: lb://orders-service\n          predicates:\n            - Path=/api/**\n          filters:\n            - StripPrefix=1\n'),
    // the first matching route wins: every call goes to orders-service. Its own screens still work; every
    // screen that calls another service breaks
    truth: { reach: S('/orders/new', '/orders/:id', '/invoices', '/invoices/:id', '/products', '/products/:sku/edit', '/notifications') },
  },
  {
    id: 'v4-06-gateway-drops-auth', logic: ['services.gateway-filters', 'security.http'], title: 'The gateway removes the Authorization header, which no service checks',
    apply: (t) => t.edit(GW, '    gateway:\n      routes:', '    gateway:\n      default-filters:\n        - RemoveRequestHeader=Authorization\n      routes:'),
    // a trap: no ShopFlow service has Spring Security, so nothing reads the header and nothing changes
    truth: { quiet: S('/', '/orders', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'v4-07-lombok-fluent', logic: ['build.lombok', 'java.accessors'], title: 'lombok.config makes accessors fluent in orders-service',
    apply: (t) => t.write('orders-service/lombok.config', 'lombok.accessors.fluent = true\n'),
    // OrderLine.getSku() becomes sku(): OrderEventsPublisher and the mapper no longer compile, orders-service does not build
    truth: { notSkip: ORDERS },
  },
  {
    id: 'v3-09-listener-concurrency', logic: ['kafka.consumers', 'concurrency'], title: 'Stock reservation runs three consumers in parallel',
    apply: (t) => t.edit(`${C}/messaging/StockReservationListener.java`, '@KafkaListener(topics = Topics.ORDER_PLACED, groupId = "catalog")', '@KafkaListener(topics = Topics.ORDER_PLACED, groupId = "catalog", concurrency = "3")'),
    // two orders for the same product can now reserve at the same time
    truth: { reach: ['job:StockReservationListener.onOrderPlaced'] },
  },
  {
    id: 'v4-10-vite-base', logic: ['build.bundler', 'ui.shell'], title: 'The front end is built for /shop/',
    apply: (t) => t.edit('frontend/vite.config.ts', '  plugins: [vue()],', "  base: '/shop/',\n  plugins: [vue()],"),
    // every script and asset URL moves under /shop/: served from /, no screen loads
    truth: { notSkip: '*' },
  },
  {
    id: 'v4-11-mount-point', logic: ['ui.shell', 'ui.html'], title: 'index.html loses the app mount point',
    apply: (t) => t.edit('frontend/index.html', '    <div id="app"></div>\n', '    <main></main>\n'),
    // main.ts mounts on #app: nothing renders, on any screen
    truth: { notSkip: '*', every: true },
  },
  {
    id: 'v3-12-toast-host-removed', logic: ['ui.shell', 'vue.components'], title: 'App.vue stops drawing the toast host',
    apply: (t) => { t.edit(`${UI}/App.vue`, '  <ToastHost />\n', ''); t.edit(`${UI}/App.vue`, "import ToastHost from './components/ToastHost.vue';\n", ''); },
    // toasts are raised on these screens and never shown
    truth: { reach: S('/orders/new', '/orders/:id', '/products/:sku/edit') },
  },
  {
    id: 'v1-13-tsconfig-only', logic: ['build.typescript'], title: 'The front-end tsconfig turns off strict mode',
    apply: (t) => { const j = t.read('frontend/tsconfig.json'); t.write('frontend/tsconfig.json', j.includes('"strict": true') ? j.replace('"strict": true', '"strict": false') : j.replace('{', '{\n  "//": "strict off",')); },
    // type checking only: the built app runs the same
    truth: { quiet: S('/', '/orders', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'v4-14-python-price-sync', logic: ['foreign.python', 'data.writes'], title: 'The nightly price sync rounds prices up',
    base: (t) => t.write('tools/price-sync/sync.py', '"""Nightly: reads the supplier feed and PUTs each price to /api/products/{sku}."""\n\n\ndef price(raw):\n    return round(raw, 2)\n'),
    apply: (t) => t.edit('tools/price-sync/sync.py', 'return round(raw, 2)', 'import math\n    return math.ceil(raw)'),
    // product prices in the catalog change every night: product pages, and new orders priced from them
    truth: { say: [/sync\.py/], notSkip: S('/products', '/orders/new') },
  },
  {
    id: 'v3-15-kotlin-file', logic: ['foreign.kotlin'], title: 'A Kotlin helper lands in catalog-service',
    apply: (t) => t.write('catalog-service/src/main/kotlin/com/shopflow/catalog/Pricing.kt', 'package com.shopflow.catalog\n\nobject Pricing {\n    fun rounded(v: Double) = Math.round(v * 100) / 100.0\n}\n'),
    // no Kotlin plugin in the build, nothing calls it: it must still be said, not passed over
    truth: { say: [/Pricing\.kt/] },
  },
];
