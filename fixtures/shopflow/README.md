# ShopFlow

A small shop on four Spring Boot services and a Vue 3 front end.

- `orders-service` takes orders, asks `catalog-service` for prices (Feign) and
  publishes `shop.orders.placed` and `shop.orders.cancelled` on Kafka.
- `billing-service` invoices each placed order, charges it, and publishes
  `shop.payments.result`; orders-service marks the order paid or failed.
- `catalog-service` holds products and reserves stock when an order is placed.
- `notification-service` mails the customer and keeps a log of what it sent.
- `gateway` routes `/api/**` to the services.
- `frontend` is Vue 3, Pinia and axios.
