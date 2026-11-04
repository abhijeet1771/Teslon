/**
 * API contract scenarios on OrderDesk: a back-end type changes what it sends or
 * takes, and no page is named in the PR. The truth is a hand-written map of
 * which page reads, and which page sends, every JSON field of every API, made
 * by reading each template and form (below). Teslon never sees this map.
 *
 * From the map, each field gets two PRs: its JSON name renamed, and the field
 * dropped from the JSON. Every page that reads it must be listed to test;
 * every page that sends it (the type is also a request body) must be reached.
 * Then come request rules, and hand-written hard and hardest cases.
 */

const J = 'src/main/java/com/orderdesk';
const A = 'src/main/webapp/app';

/* ---------- the map: who reads and who sends each JSON field (from the templates and forms) ---------- */
const CUSTOMER_SENDERS = ['/customers/new', '/customers/:id/edit'];
const PRODUCT_SENDERS = ['/products/new', '/products/:id/edit'];
export const CONTRACT = [
  // GET /api/customers (list, order form), GET /api/customers/{id} (detail, edit), inside Order.customer minus orders and phone (order detail)
  { type: 'Customer', file: `${J}/domain/Customer.java`, kind: 'class', field: 'name', readers: ['/customers', '/orders/new', '/customers/:id', '/customers/:id/edit', '/orders/:id'], senders: CUSTOMER_SENDERS },
  { type: 'Customer', file: `${J}/domain/Customer.java`, kind: 'class', field: 'email', readers: ['/customers', '/orders/new', '/customers/:id', '/customers/:id/edit', '/orders/:id'], senders: CUSTOMER_SENDERS },
  { type: 'Customer', file: `${J}/domain/Customer.java`, kind: 'class', field: 'phone', readers: ['/customers/:id', '/customers/:id/edit'], senders: CUSTOMER_SENDERS },
  { type: 'Customer', file: `${J}/domain/Customer.java`, kind: 'class', field: 'tier', readers: ['/customers', '/customers/:id', '/customers/:id/edit'], senders: CUSTOMER_SENDERS },
  // GET /api/products (list, order form, dashboard low stock), GET /api/products/{id} (edit), inside OrderItem.product minus stock and active (order detail)
  { type: 'Product', file: `${J}/domain/Product.java`, kind: 'class', field: 'sku', readers: ['/products', '/orders/new', '/products/:id/edit', '/orders/:id'], senders: PRODUCT_SENDERS },
  { type: 'Product', file: `${J}/domain/Product.java`, kind: 'class', field: 'name', readers: ['/products', '/orders/new', '/', '/products/:id/edit', '/orders/:id'], senders: PRODUCT_SENDERS },
  { type: 'Product', file: `${J}/domain/Product.java`, kind: 'class', field: 'price', readers: ['/products', '/products/:id/edit'], senders: PRODUCT_SENDERS },
  { type: 'Product', file: `${J}/domain/Product.java`, kind: 'class', field: 'stock', readers: ['/products', '/', '/products/:id/edit'], senders: PRODUCT_SENDERS },
  { type: 'Product', file: `${J}/domain/Product.java`, kind: 'class', field: 'active', readers: ['/products', '/products/:id/edit'], senders: PRODUCT_SENDERS },
  // GET /api/orders/{id} and the cancel answer (detail); POST /api/orders answer (the form navigates by id)
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'id', readers: ['/orders/:id', '/orders/new'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'customer', readers: ['/orders/:id'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'status', readers: ['/orders/:id'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'placedAt', readers: ['/orders/:id'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'items', readers: ['/orders/:id'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'total', readers: ['/orders/:id'], senders: [] },
  { type: 'Order', file: `${J}/domain/Order.java`, kind: 'class', field: 'note', readers: ['/orders/:id'], senders: [] },
  { type: 'OrderItem', file: `${J}/domain/OrderItem.java`, kind: 'class', field: 'product', readers: ['/orders/:id'], senders: [] },
  { type: 'OrderItem', file: `${J}/domain/OrderItem.java`, kind: 'class', field: 'quantity', readers: ['/orders/:id'], senders: [] },
  { type: 'OrderItem', file: `${J}/domain/OrderItem.java`, kind: 'class', field: 'unitPrice', readers: ['/orders/:id'], senders: [] },
  // GET /api/orders (order list; dashboard recent orders, which shows no date)
  { type: 'OrderSummaryDto', file: `${J}/service/dto/OrderSummaryDto.java`, kind: 'record', jtype: 'Long', field: 'id', readers: ['/orders', '/'], senders: [] },
  { type: 'OrderSummaryDto', file: `${J}/service/dto/OrderSummaryDto.java`, kind: 'record', jtype: 'String', field: 'customerName', readers: ['/orders', '/'], senders: [] },
  { type: 'OrderSummaryDto', file: `${J}/service/dto/OrderSummaryDto.java`, kind: 'record', jtype: 'OrderStatus', field: 'status', readers: ['/orders', '/'], senders: [] },
  { type: 'OrderSummaryDto', file: `${J}/service/dto/OrderSummaryDto.java`, kind: 'record', jtype: 'BigDecimal', field: 'total', readers: ['/orders', '/'], senders: [] },
  { type: 'OrderSummaryDto', file: `${J}/service/dto/OrderSummaryDto.java`, kind: 'record', jtype: 'Instant', field: 'placedAt', readers: ['/orders'], senders: [] },
  // GET /api/reports/daily-sales (reports); the page keeps its own day, so "day" is read by nobody
  { type: 'DailySalesDto', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'int', field: 'orders', readers: ['/reports'], senders: [] },
  { type: 'DailySalesDto', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'BigDecimal', field: 'revenue', readers: ['/reports'], senders: [] },
  { type: 'DailySalesDto', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'List<TopProduct>', field: 'top', readers: ['/reports'], senders: [] },
  { type: 'DailySalesDto', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'LocalDate', field: 'day', readers: [], senders: [] },
  { type: 'TopProduct', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'String', field: 'sku', readers: ['/reports'], senders: [], nested: true },
  { type: 'TopProduct', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'String', field: 'name', readers: ['/reports'], senders: [], nested: true },
  { type: 'TopProduct', file: `${J}/service/dto/DailySalesDto.java`, kind: 'record', jtype: 'int', field: 'quantity', readers: ['/reports'], senders: [], nested: true },
];

/** Put an annotation on a field: above a class field, or before a record component. */
function annotate(t, c, ann) {
  const text = t.read(c.file);
  if (c.kind === 'class') {
    const re = new RegExp(`^(\\s+)(private\\s+[\\w<>, .]+\\s+${c.field}\\b)`, 'm');
    if (!re.test(text)) throw new Error(`${c.file}: no field ${c.field}`);
    t.write(c.file, text.replace(re, `$1${ann}\n$1$2`));
  } else {
    // the record header that holds the component: TopProduct is the nested one
    const header = c.nested ? /record TopProduct\(([^)]*)\)/ : new RegExp(`record ${c.type}\\(([^)]*)\\)`);
    const m = header.exec(text);
    if (!m) throw new Error(`${c.file}: no record ${c.type}`);
    const comp = new RegExp(`(^|,\\s*)(${c.jtype.replace(/[<>]/g, '\\$&')}\\s+${c.field})\\b`);
    if (!comp.test(m[1])) throw new Error(`${c.file}: no component ${c.field}`);
    t.write(c.file, text.replace(m[0], m[0].replace(m[1], m[1].replace(comp, `$1${ann} $2`))));
  }
}

const generated = CONTRACT.flatMap((c) => {
  const id = `${c.type}.${c.field}`.replace(/[^\w.]/g, '');
  const reach = [...new Set([...c.readers, ...c.senders])].map((p) => `screen:${p}`);
  const truth = c.readers.length || c.senders.length
    ? { test: c.readers.map((p) => `screen:${p}`), reach }
    // nobody reads it: no page changes
    : { quiet: ['/', '/customers', '/products', '/orders', '/orders/:id', '/reports'].map((p) => `screen:${p}`) };
  return [
    { id: `k-rename-${id}`, logic: ['contract.rename'], title: `JSON name of ${c.type}.${c.field} changes`, apply: (t) => annotate(t, c, `@com.fasterxml.jackson.annotation.JsonProperty("${c.field}V2")`), truth },
    { id: `k-drop-${id}`, logic: ['contract.drop'], title: `${c.type}.${c.field} no longer in the JSON`, apply: (t) => annotate(t, c, '@com.fasterxml.jackson.annotation.JsonIgnore'), truth },
  ];
});

/* ---------- request rules: what a form sends is now refused ---------- */
const rules = [
  { id: 'k-rule-customer-name-size', title: 'Customer names at most 10 characters', file: `${J}/domain/Customer.java`, from: '@Size(max = 80)\n    @Column(name = "name"', to: '@Size(max = 10)\n    @Column(name = "name"', senders: CUSTOMER_SENDERS },
  { id: 'k-rule-customer-phone-required', title: 'Phone becomes required', file: `${J}/domain/Customer.java`, from: '    @Size(max = 32)\n    @Column(name = "phone")', to: '    @jakarta.validation.constraints.NotBlank\n    @Size(max = 32)\n    @Column(name = "phone")', senders: CUSTOMER_SENDERS },
  { id: 'k-rule-product-sku-pattern', title: 'SKUs must look like ABC-123', file: `${J}/domain/Product.java`, from: '    @Size(max = 32)\n    @Column(name = "sku"', to: '    @Size(max = 32)\n    @jakarta.validation.constraints.Pattern(regexp = "[A-Z]+-\\\\d+")\n    @Column(name = "sku"', senders: PRODUCT_SENDERS },
  { id: 'k-rule-product-stock-max', title: 'Stock at most 1000', file: `${J}/domain/Product.java`, from: '    @Min(0)\n    @Column(name = "stock")', to: '    @Min(0)\n    @jakarta.validation.constraints.Max(1000)\n    @Column(name = "stock")', senders: PRODUCT_SENDERS },
  { id: 'k-rule-order-note-100', title: 'Order notes at most 100', file: `${J}/service/dto/CreateOrderRequest.java`, from: '@Size(max = 500) String note', to: '@Size(max = 100) String note', senders: ['/orders/new'] },
  { id: 'k-rule-line-quantity-20', title: 'At most 20 of a product per line', file: `${J}/service/dto/OrderLineRequest.java`, from: '@Max(99) int quantity', to: '@Max(20) int quantity', senders: ['/orders/new'] },
].map((r) => ({ id: r.id, logic: ['contract.request-rules'], title: r.title, apply: (t) => t.edit(r.file, r.from, r.to), truth: { test: r.senders.map((p) => `screen:${p}`) } }));

/* ---------- hard and hardest: contracts that change without a field being renamed ---------- */
const ORDER_READERS = ['screen:/orders', 'screen:/', 'screen:/orders/:id'];
const hard = [
  {
    id: 'h01-enum-json-value', logic: ['contract.enum-values'], title: 'SHIPPED is sent as "shipped"',
    apply: (t) => t.edit(`${J}/domain/OrderStatus.java`, '    SHIPPED,', '    @com.fasterxml.jackson.annotation.JsonProperty("shipped")\n    SHIPPED,'),
    // every page that compares or styles the status by its value
    truth: { reach: ORDER_READERS },
  },
  {
    id: 'h02-date-format', logic: ['contract.formats'], title: 'Order dates are sent as dd/MM/yyyy',
    apply: (t) => t.edit(`${J}/domain/Order.java`, '    private Instant placedAt;', '    @com.fasterxml.jackson.annotation.JsonFormat(pattern = "dd/MM/yyyy HH:mm", timezone = "UTC")\n    private Instant placedAt;'),
    // the detail pipes it through Angular's date pipe, which cannot read that
    truth: { test: ['screen:/orders/:id'] },
  },
  {
    id: 'h03-page-not-list', logic: ['contract.envelope'], title: 'Products come back as a Page',
    apply: (t) => {
      t.edit(`${J}/web/rest/ProductResource.java`, '    public List<Product> list(@RequestParam(defaultValue = "0") int page) {\n        return products.findAll(PageRequest.of(page, properties.pageSize(), Sort.by("name"))).getContent();', '    public org.springframework.data.domain.Page<Product> list(@RequestParam(defaultValue = "0") int page) {\n        return products.findAll(PageRequest.of(page, properties.pageSize(), Sort.by("name")));');
    },
    // the list, the order form and the dashboard expect an array
    truth: { test: ['screen:/products', 'screen:/orders/new', 'screen:/'] },
  },
  {
    id: 'h04-query-param-renamed', logic: ['contract.params'], title: 'The page parameter is now p',
    apply: (t) => t.edit(`${J}/web/rest/ProductResource.java`, '@RequestParam(defaultValue = "0") int page', '@RequestParam(name = "p", defaultValue = "0") int page'),
    // the front end still sends ?page=: "Next page" never leaves the first page
    truth: { test: ['screen:/products'] },
  },
  {
    id: 'h05-required-param-added', logic: ['contract.params'], title: 'Product list requires a sort',
    apply: (t) => t.edit(`${J}/web/rest/ProductResource.java`, '@RequestParam(defaultValue = "0") int page) {', '@RequestParam(defaultValue = "0") int page, @RequestParam String sort) {'),
    truth: { test: ['screen:/products', 'screen:/orders/new', 'screen:/'] },
  },
  {
    id: 'h06-verb-changed', logic: ['contract.verbs'], title: 'Customer update becomes PATCH',
    apply: (t) => t.edit(`${J}/web/rest/CustomerResource.java`, '    @PutMapping("/{id}")', '    @PatchMapping("/{id}")'),
    truth: { test: ['screen:/customers/:id/edit'] },
  },
  {
    id: 'h07-produces-xml', logic: ['contract.media-types'], title: 'Order list answers XML',
    apply: (t) => t.edit(`${J}/web/rest/OrderResource.java`, '    @GetMapping\n    public List<OrderSummaryDto> list()', '    @GetMapping(produces = "application/xml")\n    public List<OrderSummaryDto> list()'),
    truth: { test: ['screen:/orders', 'screen:/'] },
  },
  {
    id: 'h08-lazy-relation', logic: ['contract.serialization'], title: 'Order customer loads lazily',
    apply: (t) => t.edit(`${J}/domain/Order.java`, '    @ManyToOne\n    @JsonIgnoreProperties(value = { "orders", "phone" }', '    @ManyToOne(fetch = jakarta.persistence.FetchType.LAZY)\n    @JsonIgnoreProperties(value = { "orders", "phone" }'),
    // with open-in-view off, the detail serializes a proxy outside the transaction
    truth: { reach: ['screen:/orders/:id'] },
  },
  {
    id: 'h09-transient-total', logic: ['contract.persistence'], title: 'Order total is no longer stored',
    apply: (t) => t.edit(`${J}/domain/Order.java`, '    @Column(name = "total")', '    @jakarta.persistence.Transient'),
    truth: { reach: ORDER_READERS },
  },
  {
    id: 'h10-column-renamed-no-migration', logic: ['contract.persistence', 'data.migrations'], title: 'Order total column renamed in the entity only',
    apply: (t) => t.edit(`${J}/domain/Order.java`, '    @Column(name = "total")', '    @Column(name = "order_total")'),
    // no migration renames the column: every read and write of orders fails
    truth: { reach: [...ORDER_READERS, 'screen:/orders/new', 'screen:/reports'] },
  },
  {
    id: 'h11-frontend-payload-renamed', logic: ['contract.payloads'], title: 'The customer form sends fullName',
    apply: (t) => t.edit(`${A}/customers/customer-edit/customer-edit.ts`, '    const value = this.form.getRawValue();', '    const { name, ...rest } = this.form.getRawValue();\n    const value = { ...rest, fullName: name };'),
    // the API requires name: every save is refused
    truth: { test: ['screen:/customers/new', 'screen:/customers/:id/edit'] },
  },
  {
    id: 'h12-trailing-slash', logic: ['contract.urls'], title: 'Customer URLs end with a slash',
    apply: (t) => t.edit(`${A}/customers/customer.service.ts`, '`${API}/customers`', '`${API}/customers/`'),
    // Spring Boot 3 does not match /api/customers/ to /api/customers
    truth: { test: ['screen:/customers', 'screen:/customers/new', 'screen:/customers/:id', 'screen:/customers/:id/edit', 'screen:/orders/new'] },
  },
  {
    id: 'h13-frontend-query-param', logic: ['contract.params'], title: 'The front end sends ?p= for the page',
    apply: (t) => t.edit(`${A}/products/product.service.ts`, '?page=${this.page()}', '?p=${this.page()}'),
    truth: { test: ['screen:/products'] },
  },
  {
    id: 'h14-frontend-date-format', logic: ['contract.formats'], title: 'The report sends the day as dd/MM/yyyy',
    apply: (t) => t.edit(`${A}/reports/report.service.ts`, ".set('day', day)", ".set('day', day.split('-').reverse().join('/'))"),
    // the API reads an ISO date: every report request is refused
    truth: { test: ['screen:/reports'] },
  },
  {
    id: 'h15-include-non-null', logic: ['contract.nulls'], title: 'Customers omit empty fields',
    apply: (t) => t.edit(`${J}/domain/Customer.java`, '@Entity', '@com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)\n@Entity'),
    // only phone can be empty, and the pages that read it show "—" for it either way
    truth: { reach: ['screen:/customers/:id'] },
  },
  {
    id: 'h16-embedded-ignore-email', logic: ['contract.holders'], title: 'The order no longer carries the customer e-mail',
    apply: (t) => t.edit(`${J}/domain/Order.java`, 'value = { "orders", "phone" }', 'value = { "orders", "phone", "email" }'),
    truth: { test: ['screen:/orders/:id'] },
  },
  {
    id: 'h17-embedded-ignore-sku', logic: ['contract.holders'], title: 'Order lines no longer carry the product SKU',
    apply: (t) => t.edit(`${J}/domain/OrderItem.java`, 'value = { "stock", "active" }', 'value = { "stock", "active", "sku" }'),
    truth: { test: ['screen:/orders/:id'] },
  },
  {
    id: 'h18-nested-valid-removed', logic: ['contract.request-rules'], title: 'Order lines are no longer validated',
    apply: (t) => t.edit(`${J}/service/dto/CreateOrderRequest.java`, 'List<@Valid OrderLineRequest> lines', 'List<OrderLineRequest> lines'),
    truth: { reach: ['screen:/orders/new'] },
  },
  {
    id: 'h19-global-non-null', logic: ['contract.nulls', 'config.framework'], title: 'Every API omits nulls',
    apply: (t) => t.write('src/main/resources/application.yml', t.read('src/main/resources/application.yml').replace('spring:\n', 'spring:\n  jackson:\n    default-property-inclusion: non_null\n')),
    truth: { every: true },
  },
  {
    id: 'h20-expose-lazy-orders', logic: ['contract.serialization'], title: 'Customers now include their orders',
    apply: (t) => t.edit(`${J}/domain/Customer.java`, '    @JsonIgnore\n    @OneToMany(mappedBy = "customer")', '    @OneToMany(mappedBy = "customer")'),
    // a lazy collection serialized outside the transaction: every customer answer can fail
    truth: { reach: ['screen:/customers', 'screen:/customers/:id', 'screen:/customers/:id/edit', 'screen:/orders/new'] },
  },
  {
    id: 'h21-response-status', logic: ['contract.status'], title: 'A missing customer answers 204 instead of 404',
    apply: (t) => t.edit(`${J}/web/rest/CustomerResource.java`, '    public ResponseEntity<Customer> get(@PathVariable Long id) {', '    public ResponseEntity<Customer> get(@PathVariable Long id) {\n        if (id < 0) return ResponseEntity.noContent().build();'),
    truth: { reach: ['screen:/customers/:id', 'screen:/customers/:id/edit'] },
  },
  {
    id: 'h22-path-variable-type', logic: ['contract.params'], title: 'Order ids in the path become strings',
    apply: (t) => {
      t.edit(`${J}/web/rest/OrderResource.java`, '    public Order get(@PathVariable Long id) {\n        return orders.find(id);', '    public Order get(@PathVariable String id) {\n        return orders.find(Long.valueOf(id));');
    },
    // same URL, same answer: the detail is checked, nothing breaks
    truth: { reach: ['screen:/orders/:id'] },
  },
  {
    id: 'h23-request-body-optional-field', logic: ['contract.request-rules'], title: 'A note is now required on every order',
    apply: (t) => t.edit(`${J}/service/dto/CreateOrderRequest.java`, '@Size(max = 500) String note', '@jakarta.validation.constraints.NotBlank @Size(max = 500) String note'),
    // the form sends an empty note when none is typed
    truth: { test: ['screen:/orders/new'] },
  },
  {
    id: 'h24-getter-added', logic: ['contract.computed'], title: 'Products send a computed displayName',
    apply: (t) => t.edit(`${J}/domain/Product.java`, '    public Long getId()', '    public String getDisplayName() { return sku + " " + name; }\n\n    public Long getId()'),
    // a new field nobody reads yet: no page changes
    truth: { quiet: ['screen:/customers', 'screen:/orders', 'screen:/reports'] },
  },
];

export const contractProbes = [...generated, ...rules, ...hard];
