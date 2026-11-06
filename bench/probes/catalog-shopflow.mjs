import { superhardShopflowProbes } from './catalog-superhard-shopflow.mjs';
/**
 * Probes on ShopFlow (fixtures/shopflow): four Spring Boot services that talk
 * through Kafka topics and Feign, MapStruct and hand-written mappers, builders,
 * @Async mail, two implementations of one interface, a gateway, and a Vue 3
 * front end (script setup and Options API, Pinia stores, an axios instance with
 * a base URL, a composable, lazy routes).
 *
 * The truth of each probe was written from the code before Teslon ran on it.
 * Run with: node bench/probes/run.mjs --app shopflow
 *
 * Who reads what (the map the truths come from):
 * - /                 Pinia orders store → GET /api/orders: status (open, revenue), total, id, customerName
 * - /orders           orders store → GET /api/orders: id, customerName, status, total, currency, placedAt (formatDate)
 * - /orders/new       GET /api/products (name, price, inStock, sku); POST /api/orders {customerEmail, customerName, lines[sku, quantity]}
 * - /orders/:id       GET /api/orders/{id} (customer*, status, paymentFailureReason, lines[*], total, currency);
 *                     GET /api/invoices/by-order/{id} through useOrderInvoice (id, number, gross, currency, status);
 *                     POST /api/orders/{id}/cancel
 * - /invoices         GET /api/invoices: number, orderId, customerEmail, gross, currency, status, issuedAt (formatDate)
 * - /invoices/:id     GET /api/invoices/{id}: number, orderId, net, tax, gross, currency, status, issuedAt
 * - /products         GET /api/products: name, sku, price, stock, inStock
 * - /products/:sku/edit  GET and PUT /api/products/{sku}: name, description, price, stock
 * - /notifications    GET /api/notifications: sentAt, orderId, recipient, kind, subject, status
 *
 * What runs without a screen:
 * - shop.orders.placed (orders-service) → billing OrderPlacedConsumer (invoice, charge, then shop.payments.result),
 *   catalog StockReservationListener (stock), notification OrderNotificationsListener (mail, Notification row)
 * - shop.orders.cancelled → billing OrderCancelledConsumer (invoice VOID), notification OrderNotificationsListener
 * - shop.payments.result (billing) → orders PaymentResultListener (order PAID or PAYMENT_FAILED),
 *   notification PaymentFailedListener (topic from ${shopflow.topics.payments})
 */
export const APP = 'fixtures/shopflow';

const O = 'orders-service/src/main/java/com/shopflow/orders';
const B = 'billing-service/src/main/java/com/shopflow/billing';
const C = 'catalog-service/src/main/java/com/shopflow/catalog';
const N = 'notification-service/src/main/java/com/shopflow/notifications';
const E = 'shared-events/src/main/java/com/shopflow/events';
const UI = 'frontend/src';

export const SCREENS = ['/', '/orders', '/orders/new', '/orders/:id', '/invoices', '/invoices/:id', '/products', '/products/:sku/edit', '/notifications'];
const S = (...p) => p.map((x) => `screen:${x}`);
const others = (...keep) => S(...SCREENS.filter((x) => !keep.includes(x)));

const BILL = 'job:OrderPlacedConsumer.onOrderPlaced';
const VOID = 'job:OrderCancelledConsumer.onOrderCancelled';
const STOCK = 'job:StockReservationListener.onOrderPlaced';
const MAIL = 'job:OrderNotificationsListener.onOrderEvent';
const PAYFAIL = 'job:PaymentFailedListener.onPaymentResult';
const PAID = 'job:PaymentResultListener.onPaymentResult';

export const probes = [
  // ---------------------------------------------------------------- Kafka
  {
    id: 'k01-topic-constant', logic: ['kafka.topics'],
    title: 'The placed-order topic is renamed for every service',
    apply: (t) => t.edit(`${E}/Topics.java`, '"shop.orders.placed"', '"shop.orders.created"'),
    // every producer and consumer moves together; what runs on the topic is what to test end to end
    // truth corrected after a run: a service on the old topic name leaves orders unpaid (/, /orders, /orders/:id), invoices unmade and stock unreserved
    truth: { reach: [BILL, STOCK, MAIL, ...S('/invoices', '/products', '/notifications', '/', '/orders', '/orders/:id', '/invoices/:id', '/products/:sku/edit')], say: [/ORDER_PLACED|shop\.orders\.created/] },
  },
  {
    id: 'k02-consumer-topic-typo', logic: ['kafka.topics', 'kafka.consumers'],
    title: 'Billing listens on a literal topic name',
    apply: (t) => t.edit(`${B}/messaging/OrderPlacedConsumer.java`, '@KafkaListener(topics = Topics.ORDER_PLACED, groupId = "billing")', '@KafkaListener(topics = "shop.order.placed", groupId = "billing")'),
    // no one publishes shop.order.placed: no invoice, no charge, and the order never leaves PLACED
    // truth corrected after a run: no invoice to open, and no payment result for the payment-failed mail
    truth: { test: [BILL], reach: S('/invoices', '/orders/:id', '/orders', '/', '/invoices/:id', '/notifications'), say: [/shop\.order\.placed/] },
  },
  {
    id: 'k03-producer-topic', logic: ['kafka.topics', 'kafka.producers'],
    title: 'Orders publishes placed orders on a new topic',
    apply: (t) => t.edit(`${O}/messaging/OrderEventsPublisher.java`, 'kafkaTemplate.send(Topics.ORDER_PLACED,', 'kafkaTemplate.send("orders-placed",'),
    // nothing listens on orders-placed: billing, stock and the confirmation mail never run
    // truth corrected after a run: with no billing there is no payment result, so orders stay PLACED; stock shows on the editor too
    truth: { test: [BILL, STOCK, MAIL, ...S('/orders/new')], reach: S('/invoices', '/products', '/notifications', '/orders/:id', '/', '/orders', '/invoices/:id', '/products/:sku/edit') },
  },
  {
    id: 'k04-message-field-renamed', logic: ['kafka.messages', 'mappers.builders'],
    title: 'OrderPlacedMessage.total becomes amount',
    apply: (t) => {
      t.edit(`${E}/OrderPlacedMessage.java`, '    BigDecimal total,', '    BigDecimal amount,');
      t.edit(`${B}/service/InvoiceFactory.java`, 'BigDecimal net = order.total();', 'BigDecimal net = order.amount();');
      t.edit(`${N}/service/Mailer.java`, 'The total is " + order.total()', 'The total is " + order.amount()');
    },
    // the JSON field is now "amount"; a consumer on the old version reads null
    // truth corrected after a run: a billing still on the old version reads no total, makes no invoice and sends no payment result
    truth: { reach: [BILL, MAIL, ...S('/invoices', '/invoices/:id', '/notifications', '/', '/orders', '/orders/:id')], say: [/total|amount/] },
  },
  {
    id: 'k05-message-field-dropped', logic: ['kafka.messages'],
    title: 'The placed-order message no longer carries the customer name',
    apply: (t) => {
      t.edit(`${E}/OrderPlacedMessage.java`, '    String customerName,\n', '');
      t.edit(`${O}/messaging/OrderEventsPublisher.java`, '            order.getCustomerName(),\n', '');
      t.edit(`${N}/service/Mailer.java`, '"Hello " + order.customerName() + ",\\n\\nthank you', '"Hello,\\n\\nthank you');
    },
    truth: { test: [MAIL], say: [/customerName/] },
  },
  {
    id: 'k06-message-field-added', logic: ['kafka.messages'],
    title: 'The placed-order message gains a channel',
    apply: (t) => {
      t.edit(`${E}/OrderPlacedMessage.java`, '    String currency,\n', '    String currency,\n    String channel,\n');
      t.edit(`${O}/messaging/OrderEventsPublisher.java`, '            order.getCurrency(),\n', '            order.getCurrency(),\n            "web",\n');
    },
    // consumers ignore a field they do not read; placing an order runs the changed code
    truth: { test: S('/orders/new') },
  },
  {
    id: 'k07-consumer-group', logic: ['kafka.consumers'],
    title: 'Stock reservation moves to a new consumer group',
    apply: (t) => t.edit(`${C}/messaging/StockReservationListener.java`, 'groupId = "catalog"', 'groupId = "catalog-v2"'),
    // a new group starts from the latest offset: orders placed during the deploy never reserve stock
    // truth corrected after a run: stock also shows on the new-order page (sold out) and in the editor
    truth: { test: [STOCK], reach: S('/products', '/orders/new', '/products/:sku/edit'), say: [/group|offset/i] },
  },
  {
    id: 'k08-listener-removed', logic: ['kafka.consumers', 'jobs.removed'],
    title: 'Billing stops voiding invoices of cancelled orders',
    apply: (t) => t.rm(`${B}/messaging/OrderCancelledConsumer.java`),
    truth: { reach: [VOID, ...S('/invoices', '/invoices/:id', '/orders/:id')] },
  },
  {
    id: 'k09-listener-logic', logic: ['kafka.consumers', 'data.writes'],
    title: 'Only lines of up to ten units reserve stock',
    apply: (t) => t.edit(`${C}/messaging/StockReservationListener.java`, '            productService.reserve(line.sku(), line.quantity());', '            if (line.quantity() <= 10) {\n                productService.reserve(line.sku(), line.quantity());\n            }'),
    truth: { test: [STOCK], reach: S('/products', '/orders/new', '/products/:sku/edit') },
  },
  {
    id: 'k10-payment-listener-guard', logic: ['kafka.consumers', 'data.writes'],
    title: 'Orders only records successful payments',
    apply: (t) => t.edit(`${O}/messaging/PaymentResultListener.java`, '        orderService.paymentResult(result);', '        if (result.paid()) {\n            orderService.paymentResult(result);\n        }'),
    // a failed payment no longer marks the order PAYMENT_FAILED
    truth: { test: [PAID], reach: S('/orders/:id', '/orders', '/') },
  },
  {
    id: 'k11-service-under-listener', logic: ['kafka.consumers', 'data.writes'],
    title: 'A late payment result now overrides a cancellation',
    apply: (t) => t.edit(`${O}/service/OrderService.java`, '        if (order.getStatus() == OrderStatus.CANCELLED) {\n            return;\n        }\n', ''),
    truth: { test: [PAID], reach: S('/orders/:id', '/orders', '/') },
  },
  {
    id: 'k12-topic-property', logic: ['kafka.topics', 'config.placeholders'],
    title: 'The payments topic property gets a typo',
    apply: (t) => t.edit('notification-service/src/main/resources/application.yml', 'payments: shop.payments.result', 'payments: shop.payments.results'),
    // PaymentFailedListener reads ${shopflow.topics.payments}: it now listens where nothing publishes
    truth: { test: [PAYFAIL], reach: S('/notifications'), say: [/shop\.payments\.results/] },
  },
  {
    id: 'k13-topic-constant-split', logic: ['kafka.topics', 'config.placeholders'],
    title: 'The payments topic constant is renamed; the notification property is not',
    apply: (t) => t.edit(`${E}/Topics.java`, '"shop.payments.result"', '"shop.payments.results"'),
    // billing and orders follow the constant; notification-service still listens on shop.payments.result
    // truth corrected after a run: the orders listener's topic moves with the constant, so order status on / and /orders too
    truth: { test: [PAYFAIL], reach: [PAID, ...S('/notifications', '/orders/:id', '/', '/orders')] },
  },
  {
    id: 'k14-listener-topics-list', logic: ['kafka.consumers'],
    title: 'Notifications stop listening for cancellations',
    apply: (t) => t.edit(`${N}/messaging/OrderNotificationsListener.java`, '@KafkaListener(topics = {Topics.ORDER_PLACED, Topics.ORDER_CANCELLED}, groupId = "notifications")', '@KafkaListener(topics = Topics.ORDER_PLACED, groupId = "notifications")'),
    truth: { test: [MAIL], reach: S('/notifications') },
  },
  {
    id: 'k15-async-removed', logic: ['async', 'kafka.consumers'],
    title: 'The confirmation mail is sent on the listener thread',
    apply: (t) => t.edit(`${N}/service/Mailer.java`, '    @Async\n    public void orderConfirmation', '    public void orderConfirmation'),
    truth: { test: [MAIL], quiet: others('/notifications') },
  },
  {
    id: 'k16-producer-key', logic: ['kafka.producers'],
    title: 'Placed orders are keyed by customer email',
    apply: (t) => t.edit(`${O}/messaging/OrderEventsPublisher.java`, 'kafkaTemplate.send(Topics.ORDER_PLACED, String.valueOf(order.getId()), message);', 'kafkaTemplate.send(Topics.ORDER_PLACED, order.getCustomerEmail(), message);'),
    // placed and cancelled for one order may now land on different partitions, out of order
    truth: { test: S('/orders/new'), reach: [BILL, STOCK, MAIL] },
  },
  {
    id: 'k17-result-payload', logic: ['kafka.producers', 'kafka.messages'],
    title: 'Billing sends the payment reference as the failure reason',
    apply: (t) => t.edit(`${B}/service/InvoiceService.java`, 'outcome.success(), outcome.failureReason()));', 'outcome.success(), outcome.reference()));'),
    truth: { test: [BILL], reach: [PAID, PAYFAIL, ...S('/orders/:id', '/notifications')] },
  },
  {
    id: 'k18-producer-serializer', logic: ['kafka.config'],
    title: 'Orders serializes Kafka values as strings',
    apply: (t) => t.edit('orders-service/src/main/resources/application.yml', '      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer', '      value-serializer: org.apache.kafka.common.serialization.StringSerializer'),
    // sending a record object fails: placing and cancelling an order fail
    truth: { test: S('/orders/new', '/orders/:id'), quiet: S('/invoices', '/invoices/:id', '/products', '/products/:sku/edit', '/notifications') },
  },
  {
    id: 'k19-trusted-packages', logic: ['kafka.config'],
    title: 'Billing trusts the wrong package for JSON',
    apply: (t) => t.edit('billing-service/src/main/resources/application.yml', 'spring.json.trusted.packages: com.shopflow.events', 'spring.json.trusted.packages: com.shopflow.event'),
    // truth corrected after a run: billing reads no record, so no payment result: orders stay PLACED, and no payment-failed mail
    truth: { test: [BILL, VOID], reach: S('/invoices', '/invoices/:id', '/', '/orders', '/orders/:id', '/notifications'), quiet: S('/products', '/products/:sku/edit') },
  },
  {
    id: 'k20-retryable-topic', logic: ['kafka.consumers'],
    title: 'Billing retries a failed invoice three times',
    apply: (t) => {
      t.edit(`${B}/messaging/OrderPlacedConsumer.java`, '    @KafkaListener(topics = Topics.ORDER_PLACED, groupId = "billing")', '    @RetryableTopic(attempts = "3")\n    @KafkaListener(topics = Topics.ORDER_PLACED, groupId = "billing")');
      t.edit(`${B}/messaging/OrderPlacedConsumer.java`, 'import org.springframework.kafka.annotation.KafkaListener;', 'import org.springframework.kafka.annotation.KafkaListener;\nimport org.springframework.kafka.annotation.RetryableTopic;');
    },
    truth: { test: [BILL] },
  },
  {
    id: 'k21-new-listener', logic: ['kafka.consumers', 'data.writes'],
    title: 'Catalog puts cancelled orders back in stock',
    apply: (t) => {
      t.write(`${C}/messaging/StockReleaseListener.java`, `package com.shopflow.catalog.messaging;

import com.shopflow.catalog.service.ProductService;
import com.shopflow.events.OrderCancelledMessage;
import com.shopflow.events.Topics;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class StockReleaseListener {

    private final ProductService productService;

    public StockReleaseListener(ProductService productService) {
        this.productService = productService;
    }

    @KafkaListener(topics = Topics.ORDER_CANCELLED, groupId = "catalog")
    public void onOrderCancelled(OrderCancelledMessage message) {
        productService.release(message.orderId());
    }
}
`);
      t.edit(`${C}/service/ProductService.java`, '    public void reserve(String sku, int quantity) {', '    public void release(Long orderId) {\n        productRepository.findAll().forEach(p -> p.setStock(p.getStock() + 1));\n    }\n\n    public void reserve(String sku, int quantity) {');
    },
    // truth corrected after a run: stock also shows on the new-order page and in the editor
    truth: { test: ['job:StockReleaseListener.onOrderCancelled'], reach: S('/products', '/orders/new', '/products/:sku/edit') },
  },

  // ---------------------------------------------------------------- mappers and builders
  {
    id: 'm01-mapstruct-source-removed', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'OrderMapper no longer maps createdAt to placedAt',
    apply: (t) => t.edit(`${O}/mapper/OrderMapper.java`, '    @Mapping(target = "placedAt", source = "createdAt")\n', ''),
    // MapStruct leaves placedAt null: only the orders list shows it
    truth: { test: S('/orders'), say: [/placedAt/], quiet: S('/', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'm02-mapstruct-expression', logic: ['mappers.mapstruct', 'contract.values'],
    title: 'Order status is sent in lower case',
    apply: (t) => t.edit(`${O}/mapper/OrderMapper.java`, 'expression = "java(order.getStatus().name())"', 'expression = "java(order.getStatus().name().toLowerCase())"'),
    // the badge tones, the open count, revenue and the cancel form all compare upper case
    truth: { test: S('/', '/orders', '/orders/:id'), say: [/status/] },
  },
  {
    id: 'm03-mapstruct-line-total', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'Line total is the unit price only',
    apply: (t) => t.edit(`${O}/mapper/OrderMapper.java`, 'expression = "java(line.getUnitPrice().multiply(java.math.BigDecimal.valueOf(line.getQuantity())))"', 'expression = "java(line.getUnitPrice())"'),
    truth: { test: S('/orders/:id'), quiet: S('/', '/orders', '/invoices', '/products') },
  },
  {
    id: 'm04-mapstruct-in-stock', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'A product with five or fewer is shown sold out',
    apply: (t) => t.edit(`${C}/mapper/ProductMapper.java`, 'expression = "java(product.getStock() > 0)"', 'expression = "java(product.getStock() > 5)"'),
    truth: { test: S('/products', '/orders/new'), quiet: S('/products/:sku/edit', '/', '/orders', '/invoices') },
  },
  {
    id: 'm05-mapstruct-update-ignore', logic: ['mappers.mapstruct', 'data.writes'],
    title: 'Editing a product no longer saves its price',
    apply: (t) => t.edit(`${C}/mapper/ProductMapper.java`, '    @Mapping(target = "active", ignore = true)\n', '    @Mapping(target = "active", ignore = true)\n    @Mapping(target = "price", ignore = true)\n'),
    // truth corrected after a run: the new-order page shows product prices too
    truth: { test: S('/products/:sku/edit'), reach: S('/products', '/orders/new'), say: [/price/] },
  },
  {
    id: 'm06-hand-mapper-swap', logic: ['mappers.hand', 'contract.fields'],
    title: 'Invoice net and tax are swapped in the DTO',
    apply: (t) => t.edit(`${B}/web/InvoiceMapper.java`, '            invoice.getNet(),\n            invoice.getTax(),', '            invoice.getTax(),\n            invoice.getNet(),'),
    // only the invoice page shows net and tax
    truth: { test: S('/invoices/:id'), quiet: S('/invoices', '/orders/:id', '/', '/orders') },
  },
  {
    id: 'm07-builder-in-factory', logic: ['mappers.builders', 'kafka.consumers', 'data.writes'],
    title: 'Invoices are issued without tax in gross',
    apply: (t) => t.edit(`${B}/service/InvoiceFactory.java`, '            .gross(net.add(tax))', '            .gross(net)'),
    // the builder's result is saved by the billing listener, and charged
    truth: { test: [BILL], reach: S('/invoices', '/invoices/:id', '/orders/:id') },
  },
  {
    id: 'm08-builder-in-entity', logic: ['mappers.builders', 'data.writes'],
    title: 'The invoice builder drops the issue date',
    apply: (t) => t.edit(`${B}/domain/Invoice.java`, '        public Builder issuedAt(Instant issuedAt) { invoice.issuedAt = issuedAt; return this; }', '        public Builder issuedAt(Instant issuedAt) { return this; }'),
    // issued_at is NOT NULL: the insert fails and no invoice is made
    truth: { reach: [BILL, ...S('/invoices', '/orders/:id')] },
  },
  {
    id: 'm09-lombok-builder-call', logic: ['mappers.builders'],
    title: 'Order lines are built without a unit price',
    apply: (t) => t.edit(`${O}/service/OrderService.java`, '                .unitPrice(product.price())\n', ''),
    // truth corrected after a run: no order is created, so none shows on / or /orders
    truth: { test: S('/orders/new'), reach: S('/orders/:id', '/', '/orders') },
  },
  {
    id: 'm10-dto-rename-by-name', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'OrderDto.customerName becomes customer',
    apply: (t) => t.edit(`${O}/web/dto/OrderDto.java`, '    String customerName,', '    String customer,'),
    // MapStruct maps by name: customer stays null, and the JSON field is renamed
    truth: { test: S('/', '/orders', '/orders/:id'), say: [/customerName/], quiet: S('/invoices', '/products', '/notifications') },
  },
  {
    id: 'm11-mapstruct-ignore-email', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'The order DTO leaves out the email',
    apply: (t) => t.edit(`${O}/mapper/OrderMapper.java`, '    @Mapping(target = "placedAt", source = "createdAt")\n', '    @Mapping(target = "placedAt", source = "createdAt")\n    @Mapping(target = "customerEmail", ignore = true)\n'),
    truth: { test: S('/orders/:id'), quiet: S('/', '/orders') },
  },
  {
    id: 'm12-feign-dto-rename', logic: ['services.feign', 'contract.fields'],
    title: "Orders reads the catalog's price as unitPrice",
    apply: (t) => {
      t.edit(`${O}/client/ProductView.java`, 'BigDecimal price, int stock', 'BigDecimal unitPrice, int stock');
      t.edit(`${O}/service/OrderService.java`, '.unitPrice(product.price())', '.unitPrice(product.unitPrice())');
      t.edit(`${O}/service/OrderService.java`, 'total.add(product.price().multiply', 'total.add(product.unitPrice().multiply');
    },
    // catalog still sends "price": unitPrice is null and placing an order fails
    // truth corrected after a run: no order is created, so none shows on /, /orders or its detail
    truth: { test: S('/orders/new'), reach: S('/orders/:id', '/', '/orders'), say: [/price/] },
  },
  {
    id: 'm13-provider-dto-rename', logic: ['services.feign', 'contract.fields'],
    title: 'Catalog sends price as unitPrice; the front end follows, orders-service does not',
    apply: (t) => {
      t.edit(`${C}/web/ProductDto.java`, 'BigDecimal price, int stock', 'BigDecimal unitPrice, int stock');
      t.edit(`${UI}/types.ts`, 'export interface Product {\n  sku: string;\n  name: string;\n  description: string | null;\n  price: number;', 'export interface Product {\n  sku: string;\n  name: string;\n  description: string | null;\n  unitPrice: number;');
      t.edit(`${UI}/views/ProductsView.vue`, '<MoneyText :amount="p.price" />', '<MoneyText :amount="p.unitPrice" />');
      t.edit(`${UI}/views/NewOrderView.vue`, '<MoneyText :amount="p.price" />', '<MoneyText :amount="p.unitPrice" />');
      t.edit(`${UI}/views/ProductEditView.vue`, 'form.price = p.price;', 'form.price = p.unitPrice;');
      t.edit(`${UI}/stores/cart.ts`, 'price: product.price, quantity: 1', 'price: product.unitPrice, quantity: 1');
    },
    // ProductView in orders-service still reads "price" through Feign: placing an order fails
    truth: { test: S('/orders/new', '/products', '/products/:sku/edit'), say: [/ProductView|orders-service|CatalogClient/] },
  },
  {
    id: 'm14-inline-mapping', logic: ['mappers.hand', 'contract.fields'],
    title: 'Notification recipient and subject are swapped',
    apply: (t) => t.edit(`${N}/web/NotificationController.java`, 'n.getRecipient(), n.getKind(), n.getSubject()', 'n.getSubject(), n.getKind(), n.getRecipient()'),
    truth: { test: S('/notifications'), quiet: others('/notifications') },
  },
  {
    id: 'm15-mapstruct-lines-ignored', logic: ['mappers.mapstruct', 'contract.fields'],
    title: 'The order DTO leaves out its lines',
    apply: (t) => t.edit(`${O}/mapper/OrderMapper.java`, '    @Mapping(target = "status", expression', '    @Mapping(target = "lines", ignore = true)\n    @Mapping(target = "status", expression'),
    truth: { test: S('/orders/:id'), quiet: S('/', '/orders') },
  },

  // ---------------------------------------------------------------- Vue
  {
    id: 'v01-shared-badge', logic: ['vue.components'],
    title: 'A failed payment badge turns amber',
    apply: (t) => t.edit(`${UI}/components/StatusBadge.vue`, "  PAYMENT_FAILED: 'danger',", "  PAYMENT_FAILED: 'warning',"),
    truth: { test: S('/', '/orders', '/orders/:id', '/invoices', '/invoices/:id'), quiet: S('/products', '/notifications', '/orders/new', '/products/:sku/edit') },
  },
  {
    id: 'v02-money-default', logic: ['vue.components'],
    title: 'Money is shown in dollars unless a currency is given',
    apply: (t) => t.edit(`${UI}/components/MoneyText.vue`, "{ currency: 'EUR' }", "{ currency: 'USD' }"),
    truth: { test: S('/', '/orders/:id', '/orders/new', '/products'), quiet: S('/notifications', '/products/:sku/edit') },
  },
  {
    id: 'v03-shared-util', logic: ['vue.utils'],
    title: 'Dates are shown short',
    apply: (t) => t.edit(`${UI}/utils/format.ts`, "{ dateStyle: 'medium', timeStyle: 'short' }", "{ dateStyle: 'short' }"),
    truth: { test: S('/orders', '/invoices', '/invoices/:id', '/notifications'), quiet: S('/', '/orders/:id', '/products', '/orders/new', '/products/:sku/edit') },
  },
  {
    id: 'v04-route-renamed', logic: ['vue.routes', 'vue.links'],
    title: 'Order detail moves to /order/:id',
    apply: (t) => t.edit(`${UI}/router/index.ts`, "{ path: '/orders/:id', name: 'order',", "{ path: '/order/:id', name: 'order',"),
    // links to /orders/{id} on five screens, and the push after placing an order, now go nowhere
    truth: { test: S('/', '/orders', '/invoices', '/invoices/:id', '/notifications', '/orders/new'), say: [/\/orders\//] },
  },
  {
    id: 'v05-guard-removed', logic: ['vue.guards'],
    title: 'Anyone can open the product editor',
    apply: (t) => t.edit(`${UI}/router/index.ts`, "router.beforeEach((to) => {\n  if (to.meta.requiresAdmin && !isAdmin()) {\n    return { name: 'home' };\n  }\n});\n", ''),
    truth: { test: S('/products/:sku/edit') },
  },
  {
    id: 'v06-interceptor-header', logic: ['vue.http', 'ui.shell'],
    title: 'The token is sent in X-Auth-Token',
    apply: (t) => t.edit(`${UI}/api/http.ts`, 'config.headers.Authorization = `Bearer ${t}`;', "config.headers['X-Auth-Token'] = t;"),
    truth: { every: true },
  },
  {
    id: 'v07-base-url', logic: ['vue.http'],
    title: 'The API base moves to /api/v1',
    apply: (t) => t.edit(`${UI}/api/http.ts`, "baseURL: '/api',", "baseURL: '/api/v1',"),
    truth: { every: true },
  },
  {
    id: 'v08-api-module-member', logic: ['vue.http', 'contract.paths'],
    title: 'Cancel posts to /cancellation',
    apply: (t) => t.edit(`${UI}/api/orders.ts`, '`/orders/${id}/cancel`', '`/orders/${id}/cancellation`'),
    truth: { test: S('/orders/:id'), quiet: S('/', '/orders', '/orders/new') },
  },
  {
    id: 'v09-api-by-order', logic: ['vue.http', 'vue.composables', 'contract.paths'],
    title: "An order's invoice is fetched with a query",
    apply: (t) => t.edit(`${UI}/api/invoices.ts`, '`/invoices/by-order/${orderId}`', '`/invoices?orderId=${orderId}`'),
    // GET /invoices ignores the query and returns a list: the invoice box breaks
    truth: { test: S('/orders/:id'), quiet: S('/invoices', '/invoices/:id') },
  },
  {
    id: 'v10-pinia-getter', logic: ['vue.pinia'],
    title: 'Paid orders are no longer counted as open',
    apply: (t) => t.edit(`${UI}/stores/orders.ts`, "open: (state) => state.orders.filter((o) => o.status === 'PLACED' || o.status === 'PAID'),", "open: (state) => state.orders.filter((o) => o.status === 'PLACED'),"),
    truth: { test: S('/'), quiet: S('/orders', '/orders/:id', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'v11-pinia-action', logic: ['vue.pinia'],
    title: 'Cancelled orders are hidden',
    apply: (t) => t.edit(`${UI}/stores/orders.ts`, 'this.orders = await ordersApi.list();', "this.orders = (await ordersApi.list()).filter((o) => o.status !== 'CANCELLED');"),
    truth: { test: S('/', '/orders'), quiet: S('/orders/:id', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'v12-pinia-setup-store', logic: ['vue.pinia'],
    title: 'Add to cart adds two',
    apply: (t) => t.edit(`${UI}/stores/cart.ts`, 'existing.quantity += 1;', 'existing.quantity += 2;'),
    truth: { test: S('/products', '/orders/new'), quiet: S('/invoices', '/invoices/:id', '/notifications') },
  },
  {
    id: 'v13-composable', logic: ['vue.composables'],
    title: "The order's invoice is looked up by invoice id",
    apply: (t) => t.edit(`${UI}/composables/useOrderInvoice.ts`, 'invoicesApi.byOrder(orderId.value)', 'invoicesApi.get(orderId.value)'),
    truth: { test: S('/orders/:id'), quiet: S('/invoices', '/invoices/:id', '/', '/orders') },
  },
  {
    id: 'v14-template-condition', logic: ['vue.templates'],
    title: 'Shipped orders show the cancel form',
    apply: (t) => t.edit(`${UI}/views/OrderDetailView.vue`, `<form v-if="order.status !== 'SHIPPED' && order.status !== 'CANCELLED'"`, `<form v-if="order.status !== 'CANCELLED'"`),
    truth: { test: S('/orders/:id'), quiet: others('/orders/:id') },
  },
  {
    id: 'v15-options-api', logic: ['vue.options-api'],
    title: 'The invoice filter compares in lower case',
    apply: (t) => t.edit(`${UI}/views/InvoicesView.vue`, 'this.invoices.filter((i) => i.status === this.filter)', 'this.invoices.filter((i) => i.status.toLowerCase() === this.filter)'),
    truth: { test: S('/invoices'), quiet: others('/invoices') },
  },
  {
    id: 'v16-prop-renamed', logic: ['vue.components', 'vue.props'],
    title: 'OrderLinesTable takes items, and the order page still passes lines',
    apply: (t) => {
      t.edit(`${UI}/components/OrderLinesTable.vue`, '<tr v-for="line in lines" :key="line.sku">', '<tr v-for="line in items" :key="line.sku">');
      t.edit(`${UI}/components/OrderLinesTable.vue`, 'defineProps<{ lines: OrderLine[] }>();', 'defineProps<{ items: OrderLine[] }>();');
    },
    truth: { test: S('/orders/:id'), quiet: others('/orders/:id') },
  },
  {
    id: 'v17-navbar-link', logic: ['vue.shell', 'vue.links'],
    title: 'The navbar loses its Invoices link',
    apply: (t) => t.edit(`${UI}/components/NavBar.vue`, '    <RouterLink to="/invoices">Invoices</RouterLink>\n', ''),
    truth: { every: true },
  },
  {
    id: 'v19-types-only', logic: ['vue.types'],
    title: 'Order.total is typed as a string',
    apply: (t) => t.edit(`${UI}/types.ts`, '  total: number;\n  currency: string;\n  placedAt: string;', '  total: string;\n  currency: string;\n  placedAt: string;'),
    truth: { nothing: true },
  },
  {
    id: 'v21-axios-bump', logic: ['deps.runtime', 'vue.http'],
    title: 'axios 1.8',
    apply: (t) => t.edit('frontend/package.json', '"axios": "^1.7.9"', '"axios": "^1.8.0"'),
    truth: { every: true },
  },
  {
    id: 'v22-input-limit', logic: ['vue.templates', 'contract.rules'],
    title: 'The price field accepts zero',
    apply: (t) => t.edit(`${UI}/views/ProductEditView.vue`, 'step="0.01" min="0.01"', 'step="0.01" min="0"'),
    // the server still demands at least 0.01
    truth: { test: S('/products/:sku/edit'), quiet: others('/products/:sku/edit') },
  },
  {
    id: 'v23-payload-key', logic: ['vue.payloads', 'contract.fields'],
    title: 'Order lines are sent as qty',
    apply: (t) => t.edit(`${UI}/views/NewOrderView.vue`, 'lines: cart.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),', 'lines: cart.lines.map((l) => ({ sku: l.sku, qty: l.quantity })),'),
    // CreateOrderRequest.Line.quantity is @Min(1): it arrives as 0, and the order is refused
    truth: { test: S('/orders/new'), say: [/quantity|qty/], quiet: others('/orders/new') },
  },
  {
    id: 'v25-template-link', logic: ['vue.templates'],
    title: 'Everyone sees the Edit link on products',
    apply: (t) => t.edit(`${UI}/views/ProductsView.vue`, '<RouterLink v-if="admin" :to="`/products/${p.sku}/edit`">Edit</RouterLink>', '<RouterLink :to="`/products/${p.sku}/edit`">Edit</RouterLink>'),
    truth: { test: S('/products'), quiet: others('/products', '/products/:sku/edit') },
  },

  // ---------------------------------------------------------------- services, Feign, config
  {
    id: 'f01-feign-path', logic: ['services.feign'],
    title: 'Orders asks the catalog on /products/by-sku',
    apply: (t) => t.edit(`${O}/client/CatalogClient.java`, '@GetMapping("/products/{sku}")', '@GetMapping("/products/by-sku/{sku}")'),
    truth: { test: S('/orders/new'), quiet: S('/products', '/products/:sku/edit', '/invoices', '/notifications') },
  },
  {
    id: 'f02-provider-endpoint', logic: ['services.feign', 'services.callers'],
    title: 'Inactive products answer 404',
    apply: (t) => t.edit(`${C}/web/ProductController.java`, '        return productMapper.toDto(productService.bySku(sku));\n    }\n\n    @PutMapping', '        var product = productService.bySku(sku);\n        if (!product.isActive()) {\n            throw new java.util.NoSuchElementException(sku);\n        }\n        return productMapper.toDto(product);\n    }\n\n    @PutMapping'),
    // the editor and orders-service (through Feign) both GET /products/{sku}
    truth: { test: S('/products/:sku/edit', '/orders/new'), quiet: S('/products', '/invoices', '/notifications') },
  },
  {
    id: 'f03-provider-put-path', logic: ['contract.paths'],
    title: 'Product update moves to /products/{sku}/details',
    apply: (t) => t.edit(`${C}/web/ProductController.java`, '@PutMapping("/{sku}")', '@PutMapping("/{sku}/details")'),
    truth: { test: S('/products/:sku/edit'), quiet: S('/products', '/orders/new', '/invoices') },
  },
  {
    id: 'f04-shared-service-method', logic: ['services.callers', 'kafka.consumers'],
    title: 'SKUs are looked up in upper case',
    apply: (t) => t.edit(`${C}/service/ProductService.java`, 'return productRepository.findBySku(sku).orElseThrow', 'return productRepository.findBySku(sku.toUpperCase()).orElseThrow'),
    truth: { test: S('/products/:sku/edit', '/orders/new'), reach: [STOCK], quiet: S('/invoices', '/notifications') },
  },
  {
    id: 'f05-gateway-route', logic: ['services.gateway-routes'],
    title: 'The gateway serves invoices on /api/billing',
    apply: (t) => t.edit('gateway/src/main/resources/application.yml', '- Path=/api/invoices/**', '- Path=/api/billing/**'),
    truth: { test: S('/invoices', '/invoices/:id', '/orders/:id'), quiet: S('/products', '/notifications', '/orders/new') },
  },
  {
    id: 'f06-second-impl', logic: ['impls.conditional'],
    title: 'The fake payment provider declines over 100',
    apply: (t) => t.edit(`${B}/payment/FakePaymentProvider.java`, 'new BigDecimal("1000")', 'new BigDecimal("100")'),
    // only where billing.provider=fake (this repository configures stripe)
    truth: { reach: [BILL], say: [/fake|billing\.provider/i], quiet: S('/products', '/products/:sku/edit', '/notifications') },
  },
  {
    id: 'f07-impl-in-use', logic: ['impls.conditional', 'kafka.consumers'],
    title: 'Stripe is charged in upper-case currency',
    apply: (t) => t.edit(`${B}/payment/StripePaymentProvider.java`, '.setCurrency(currency.toLowerCase())', '.setCurrency(currency)'),
    // truth corrected after a run: invoice detail and the payment-failed mails follow the charge too
    truth: { test: [BILL], reach: S('/invoices', '/orders/:id', '/orders', '/', '/invoices/:id', '/notifications') },
  },
  {
    id: 'f08-impl-switch', logic: ['impls.conditional', 'config.keys'],
    title: 'Billing switches to the fake provider',
    apply: (t) => t.edit('billing-service/src/main/resources/application.yml', '  provider: stripe', '  provider: fake'),
    // truth corrected after a run: a different provider decides paid or failed: order status everywhere, and payment-failed mails
    truth: { test: [BILL], reach: S('/invoices', '/orders/:id', '/', '/orders', '/invoices/:id', '/notifications'), quiet: S('/products', '/products/:sku/edit') },
  },
  {
    id: 'f09-config-value', logic: ['config.keys', 'kafka.consumers'],
    title: 'The tax rate is 20%',
    apply: (t) => t.edit('billing-service/src/main/resources/application.yml', 'tax-rate: 0.19', 'tax-rate: 0.20'),
    truth: { test: [BILL], reach: S('/invoices', '/invoices/:id', '/orders/:id'), quiet: S('/products', '/products/:sku/edit', '/notifications') },
  },
  {
    id: 'f10-exception-handler', logic: ['services.errors'],
    title: 'A refused cancel answers 400',
    apply: (t) => t.edit(`${O}/web/ApiExceptionHandler.java`, '@ResponseStatus(HttpStatus.CONFLICT)', '@ResponseStatus(HttpStatus.BAD_REQUEST)'),
    truth: { reach: S('/orders/:id'), quiet: S('/invoices', '/products', '/notifications') },
  },
  {
    id: 'f11-repository-order', logic: ['data.queries'],
    title: 'Orders are listed oldest first',
    apply: (t) => {
      t.edit(`${O}/repository/OrderRepository.java`, 'findAllByOrderByCreatedAtDesc', 'findAllByOrderByCreatedAtAsc');
      t.edit(`${O}/service/OrderService.java`, 'findAllByOrderByCreatedAtDesc', 'findAllByOrderByCreatedAtAsc');
    },
    truth: { test: S('/', '/orders'), quiet: S('/orders/:id', '/invoices', '/products', '/notifications') },
  },
  {
    id: 'f12-migration-narrow', logic: ['data.migrations', 'kafka.consumers'],
    title: 'Invoice numbers are limited to 10 characters',
    apply: (t) => t.write('billing-service/src/main/resources/db/migration/V2__invoice_number.sql', 'alter table invoices alter column number type varchar(10);\n'),
    // truth corrected after a run: a refused invoice means no payment result, so orders stay PLACED
    truth: { reach: [BILL, ...S('/invoices', '/invoices/:id', '/', '/orders', '/orders/:id')], quiet: S('/products') },
  },
  {
    id: 'f13-column-no-migration', logic: ['data.mapping'],
    title: 'Notification.sentAt is mapped to sent_on',
    apply: (t) => t.edit(`${N}/domain/Notification.java`, '@Column(name = "sent_at")', '@Column(name = "sent_on")'),
    truth: { test: S('/notifications'), reach: [MAIL, PAYFAIL], quiet: others('/notifications') },
  },
  {
    id: 'f14-helper-under-listener', logic: ['kafka.consumers', 'data.reads'],
    title: 'Payment-failed mail goes to the last address used',
    apply: (t) => t.edit(`${N}/service/RecipientDirectory.java`, '            .findFirst()', '            .reduce((a, b) -> b)'),
    truth: { test: [PAYFAIL], reach: S('/notifications'), quiet: others('/notifications') },
  },
  {
    id: 'f15-mail-host', logic: ['config.clients', 'async'],
    title: 'Mail goes through a new SMTP host',
    apply: (t) => t.edit('notification-service/src/main/resources/application.yml', 'host: smtp.shopflow.example', 'host: mail.shopflow.example'),
    truth: { reach: [MAIL, PAYFAIL, ...S('/notifications')], quiet: others('/notifications') },
  },
  {
    id: 'f16-own-key', logic: ['config.keys', 'async'],
    title: 'Mail is sent from a new address',
    apply: (t) => t.edit('notification-service/src/main/resources/application.yml', 'from: orders@shopflow.example', 'from: no-reply@shopflow.example'),
    truth: { reach: [MAIL, PAYFAIL], quiet: others('/notifications') },
  },
  {
    id: 'f17-same-class-name', logic: ['services.errors', 'java.names'],
    title: 'Catalog gets its own ApiExceptionHandler',
    apply: (t) => t.write(`${C}/web/ApiExceptionHandler.java`, `package com.shopflow.catalog.web;

import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(NoSuchElementException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Map<String, String> notFound(NoSuchElementException e) {
        return Map.of("message", "No product " + e.getMessage());
    }
}
`),
    // an unknown SKU answered 500 and now answers 404: the editor, and orders-service through Feign
    truth: { reach: S('/products/:sku/edit', '/orders/new'), quiet: S('/', '/orders', '/orders/:id', '/invoices', '/notifications') },
  },
  {
    id: 'f19-unused-constant', logic: ['java.unused'],
    title: 'A topic constant for shipped orders, not used yet',
    apply: (t) => t.edit(`${E}/Topics.java`, '    public static final String PAYMENT_RESULT = "shop.payments.result";\n', '    public static final String PAYMENT_RESULT = "shop.payments.result";\n    public static final String ORDER_SHIPPED = "shop.orders.shipped";\n'),
    truth: { nothing: true },
  },
  {
    id: 'f20-readme', logic: ['files.docs'],
    title: 'README explains the topics',
    apply: (t) => t.write('README.md', `${t.read('README.md')}\nTopics are created by the broker on first use.\n`),
    truth: { nothing: true },
  },
  {
    id: 'a01-async-write', logic: ['async', 'data.writes'],
    title: 'Sent mails are logged as DELIVERED',
    apply: (t) => t.edit(`${N}/service/Mailer.java`, 'n.setStatus("SENT");', 'n.setStatus("DELIVERED");'),
    truth: { test: S('/notifications'), reach: [MAIL, PAYFAIL], quiet: others('/notifications') },
  },
  {
    id: 'a02-enable-async-removed', logic: ['async'],
    title: 'Mail is no longer sent asynchronously',
    apply: (t) => t.edit(`${N}/config/AsyncConfig.java`, '@EnableAsync\n', ''),
    truth: { reach: [MAIL, PAYFAIL], quiet: others('/notifications') },
  },
  ...superhardShopflowProbes,
];
