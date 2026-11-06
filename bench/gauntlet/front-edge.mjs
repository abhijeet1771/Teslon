/**
 * What each screen calls, written by reading the front-end code (not from Teslon). Each entry is the endpoint
 * as the backend service sees it: the module, the verb and the path. For ShopFlow, the gateway's routes
 * (gateway/src/main/resources/application.yml) send /api/<x>/** to the service, with the /api prefix stripped.
 */
export const orderdesk = {
  // OrderDesk: src/main/webapp/app. One Spring module.
  '/': [ // dashboard.ts: ProductService.products (httpResource on /api/products?page=), OrderService.list()
    ['GET', '/api/products'], ['GET', '/api/orders']],
  '/customers': [['GET', '/api/customers']], // customer-list.ts: service.list()
  '/customers/new': [['POST', '/api/customers']], // customer-edit.ts: service.create(value)
  '/customers/:id': [['GET', '/api/customers/{id}']], // customers.routes.ts: customerResolver
  '/customers/:id/edit': [['GET', '/api/customers/{id}'], ['PUT', '/api/customers/{id}']], // resolver, then service.update
  '/products': [['GET', '/api/products']], // product-list.ts: service.products
  '/products/new': [['POST', '/api/products']], // product-edit.ts: save() with no id posts
  '/products/:id/edit': [['GET', '/api/products/{id}'], ['PUT', '/api/products/{id}']], // route resolver, then save() puts
  '/orders': [['GET', '/api/orders']], // order-list.ts: service.list()
  '/orders/new': [['GET', '/api/products'], ['GET', '/api/customers'], ['POST', '/api/orders']], // order-create.ts
  '/orders/:id': [['GET', '/api/orders/{id}'], ['POST', '/api/orders/{id}/cancel']], // orderResolver, then service.cancel
  '/reports': [['GET', '/api/reports/daily-sales']], // daily-sales.ts: reports.dailySales(day)
};
export const shopflow = {
  // ShopFlow: frontend/src. api/*.ts call /api/... through the gateway.
  '/': [['orders-service', 'GET', '/orders']], // HomeView: orders store load() → ordersApi.list()
  '/orders': [['orders-service', 'GET', '/orders']], // OrdersView: store.load()
  '/orders/new': [['catalog-service', 'GET', '/products'], ['orders-service', 'POST', '/orders']], // NewOrderView
  '/orders/:id': [['orders-service', 'GET', '/orders/{id}'], ['orders-service', 'POST', '/orders/{id}/cancel'], ['billing-service', 'GET', '/invoices/by-order/{orderId}']], // OrderDetailView + useOrderInvoice
  '/invoices': [['billing-service', 'GET', '/invoices']], // InvoicesView
  '/invoices/:id': [['billing-service', 'GET', '/invoices/{id}']], // InvoiceDetailView
  '/products': [['catalog-service', 'GET', '/products']], // ProductsView
  '/products/:sku/edit': [['catalog-service', 'GET', '/products/{sku}'], ['catalog-service', 'PUT', '/products/{sku}']], // ProductEditView
  '/notifications': [['notification-service', 'GET', '/notifications']], // NotificationsView: fetchNotifications()
};
export const screensFor = (app) => Object.fromEntries(Object.entries(app === 'orderdesk' ? orderdesk : shopflow).map(([s, calls]) => [s, calls.map((c) => (c.length === 2 ? { module: 'orderdesk', verb: c[0], path: c[1] } : { module: c[0], verb: c[1], path: c[2] }))]));
