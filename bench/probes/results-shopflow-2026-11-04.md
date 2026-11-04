# Probe catalog: shopflow

79 probes · 79 trusted · 0 trust failures · 7 imprecise · extra screens 3.9% (P1 ≤ 5%) · held screens 5.3% (P2 ≤ 10%) · 46 logic units covered · slowest 2011 ms

| probe | logic | Teslon said | result |
|---|---|---|---|
| k01-topic-constant: The placed-order topic is renamed for every service | kafka.topics | T5 S0 U10 · High · 1 held | ✓ |
| k02-consumer-topic-typo: Billing listens on a literal topic name | kafka.topics, kafka.consumers | T3 S3 U9 · High · 1 held | ✓ |
| k03-producer-topic: Orders publishes placed orders on a new topic | kafka.topics, kafka.producers | T7 S0 U9 · High | ✓ |
| k04-message-field-renamed: OrderPlacedMessage.total becomes amount | kafka.messages, mappers.builders | T5 S2 U8 · High · 1 held | ✓ |
| k05-message-field-dropped: The placed-order message no longer carries the customer name | kafka.messages | T7 S0 U9 · High · +1 extra · 8 held | ✓ |
| k06-message-field-added: The placed-order message gains a channel | kafka.messages | T7 S0 U9 · High · 8 held | ✓ |
| k07-consumer-group: Stock reservation moves to a new consumer group | kafka.consumers | T1 S11 U3 · High | ✓ |
| k08-listener-removed: Billing stops voiding invoices of cancelled orders | kafka.consumers, jobs.removed | T1 S10 U4 · High | ✓ |
| k09-listener-logic: Only lines of up to ten units reserve stock | kafka.consumers, data.writes | T1 S11 U3 · High | ✓ |
| k10-payment-listener-guard: Orders only records successful payments | kafka.consumers, data.writes | T1 S10 U4 · High · 1 held | ✓ |
| k11-service-under-listener: A late payment result now overrides a cancellation | kafka.consumers, data.writes | T1 S10 U4 · High · 1 held | ✓ |
| k12-topic-property: The payments topic property gets a typo | kafka.topics, config.placeholders | T1 S12 U2 · High | ✓ |
| k13-topic-constant-split: The payments topic constant is renamed; the notification property is not | kafka.topics, config.placeholders | T2 S7 U6 · High · 1 held | ✓ |
| k14-listener-topics-list: Notifications stop listening for cancellations | kafka.consumers | T1 S12 U2 · High | ✓ |
| k15-async-removed: The confirmation mail is sent on the listener thread | async, kafka.consumers | T1 S14 U0 · High | ✓ |
| k16-producer-key: Placed orders are keyed by customer email | kafka.producers | T7 S0 U9 · High · 8 held | ✓ |
| k17-result-payload: Billing sends the payment reference as the failure reason | kafka.producers, kafka.messages | T3 S6 U6 · High · 3 held | ✓ |
| k18-producer-serializer: Orders serializes Kafka values as strings | kafka.config | T4 S13 U0 · High | ✓ |
| k19-trusted-packages: Billing trusts the wrong package for JSON | kafka.config | T4 S3 U8 · High · 1 held | ✓ |
| k20-retryable-topic: Billing retries a failed invoice three times | kafka.consumers | T1 S14 U0 · High | ✓ |
| k21-new-listener: Catalog puts cancelled orders back in stock | kafka.consumers, data.writes | T1 S11 U4 · High | ✓ |
| m01-mapstruct-source-removed: OrderMapper no longer maps createdAt to placedAt | mappers.mapstruct, contract.fields | T8 S11 U0 · High · +3 extra | **LOUD** screen:/ is listed to test, but nothing a user sees changes there |
| m02-mapstruct-expression: Order status is sent in lower case | mappers.mapstruct, contract.values | T8 S11 U0 · High · +1 extra | ✓ |
| m03-mapstruct-line-total: Line total is the unit price only | mappers.mapstruct, contract.fields | T8 S11 U0 · High · +3 extra | **LOUD** screen:/ is listed to test, but nothing a user sees changes there<br>**LOUD** screen:/orders is listed to test, but nothing a user sees changes there |
| m04-mapstruct-in-stock: A product with five or fewer is shown sold out | mappers.mapstruct, contract.fields | T7 S12 U0 · High · +1 extra | **LOUD** screen:/products/:sku/edit is listed to test, but nothing a user sees changes there |
| m05-mapstruct-update-ignore: Editing a product no longer saves its price | mappers.mapstruct, data.writes | T2 S11 U3 · High | ✓ |
| m06-hand-mapper-swap: Invoice net and tax are swapped in the DTO | mappers.hand, contract.fields | T6 S12 U0 · High · +2 extra | **LOUD** screen:/invoices is listed to test, but nothing a user sees changes there<br>**LOUD** screen:/orders/:id is listed to test, but nothing a user sees changes there |
| m07-builder-in-factory: Invoices are issued without tax in gross | mappers.builders, kafka.consumers, data.writes | T1 S10 U4 · High | ✓ |
| m08-builder-in-entity: The invoice builder drops the issue date | mappers.builders, data.writes | T8 S10 U0 · High · +1 extra | ✓ |
| m09-lombok-builder-call: Order lines are built without a unit price | mappers.builders | T2 S10 U4 · High | ✓ |
| m10-dto-rename-by-name: OrderDto.customerName becomes customer | mappers.mapstruct, contract.fields | T8 S11 U0 · High · +1 extra | ✓ |
| m11-mapstruct-ignore-email: The order DTO leaves out the email | mappers.mapstruct, contract.fields | T8 S11 U0 · High · +3 extra | **LOUD** screen:/ is listed to test, but nothing a user sees changes there<br>**LOUD** screen:/orders is listed to test, but nothing a user sees changes there |
| m12-feign-dto-rename: Orders reads the catalog's price as unitPrice | services.feign, contract.fields | T2 S10 U4 · High | ✓ |
| m13-provider-dto-rename: Catalog sends price as unitPrice; the front end follows, orders-service does not | services.feign, contract.fields | T8 S12 U0 · High | ✓ |
| m14-inline-mapping: Notification recipient and subject are swapped | mappers.hand, contract.fields | T2 S14 U0 · High | ✓ |
| m15-mapstruct-lines-ignored: The order DTO leaves out its lines | mappers.mapstruct, contract.fields | T8 S11 U0 · High · +3 extra | **LOUD** screen:/ is listed to test, but nothing a user sees changes there<br>**LOUD** screen:/orders is listed to test, but nothing a user sees changes there |
| v01-shared-badge: A failed payment badge turns amber | vue.components | T5 S10 U0 · High | ✓ |
| v02-money-default: Money is shown in dollars unless a currency is given | vue.components | T7 S8 U0 · High · +3 extra | ✓ |
| v03-shared-util: Dates are shown short | vue.utils | T4 S11 U0 · High | ✓ |
| v04-route-renamed: Order detail moves to /order/:id | vue.routes, vue.links | T8 S8 U0 · High · +1 extra | ✓ |
| v05-guard-removed: Anyone can open the product editor | vue.guards | T1 S14 U0 · High | ✓ |
| v06-interceptor-header: The token is sent in X-Auth-Token | vue.http, ui.shell | T10 S6 U0 · High | ✓ |
| v07-base-url: The API base moves to /api/v1 | vue.http | T10 S6 U0 · High | ✓ |
| v08-api-module-member: Cancel posts to /cancellation | vue.http, contract.paths | T1 S14 U0 · High | ✓ |
| v09-api-by-order: An order's invoice is fetched with a query | vue.http, vue.composables, contract.paths | T1 S14 U0 · High | ✓ |
| v10-pinia-getter: Paid orders are no longer counted as open | vue.pinia | T1 S14 U0 · High | ✓ |
| v11-pinia-action: Cancelled orders are hidden | vue.pinia | T2 S13 U0 · High | ✓ |
| v12-pinia-setup-store: Add to cart adds two | vue.pinia | T3 S13 U0 · High | ✓ |
| v13-composable: The order's invoice is looked up by invoice id | vue.composables | T1 S14 U0 · High | ✓ |
| v14-template-condition: Shipped orders show the cancel form | vue.templates | T1 S14 U0 · High | ✓ |
| v15-options-api: The invoice filter compares in lower case | vue.options-api | T1 S14 U0 · High | ✓ |
| v16-prop-renamed: OrderLinesTable takes items, and the order page still passes lines | vue.components, vue.props | T1 S14 U0 · High | ✓ |
| v17-navbar-link: The navbar loses its Invoices link | vue.shell, vue.links | T10 S6 U0 · High | ✓ |
| v19-types-only: Order.total is typed as a string | vue.types | T0 S0 U0 · High | ✓ |
| v21-axios-bump: axios 1.8 | deps.runtime, vue.http | T10 S6 U0 · High | ✓ |
| v22-input-limit: The price field accepts zero | vue.templates, contract.rules | T1 S14 U0 · High | ✓ |
| v23-payload-key: Order lines are sent as qty | vue.payloads, contract.fields | T1 S14 U0 · High | ✓ |
| v25-template-link: Everyone sees the Edit link on products | vue.templates | T1 S14 U0 · High | ✓ |
| f01-feign-path: Orders asks the catalog on /products/by-sku | services.feign | T2 S14 U0 · High | ✓ |
| f02-provider-endpoint: Inactive products answer 404 | services.feign, services.callers | T4 S13 U0 · High | ✓ |
| f03-provider-put-path: Product update moves to /products/{sku}/details | contract.paths | T3 S14 U0 · High | ✓ |
| f04-shared-service-method: SKUs are looked up in upper case | services.callers, kafka.consumers | T6 S12 U0 · High | ✓ |
| f05-gateway-route: The gateway serves invoices on /api/billing | services.gateway-routes | T3 S12 U0 · High | ✓ |
| f06-second-impl: The fake payment provider declines over 100 | impls.conditional | T1 S14 U0 · High | ✓ |
| f07-impl-in-use: Stripe is charged in upper-case currency | impls.conditional, kafka.consumers | T1 S3 U11 · High · 1 held | ✓ |
| f08-impl-switch: Billing switches to the fake provider | impls.conditional, config.keys | T1 S3 U11 · High · 1 held | ✓ |
| f09-config-value: The tax rate is 20% | config.keys, kafka.consumers | T1 S10 U4 · High | ✓ |
| f10-exception-handler: A refused cancel answers 400 | services.errors | T8 S11 U0 · High · +3 extra | ✓ |
| f11-repository-order: Orders are listed oldest first | data.queries | T3 S13 U0 · High | ✓ |
| f12-migration-narrow: Invoice numbers are limited to 10 characters | data.migrations, kafka.consumers | T2 S6 U8 · High · 1 held | ✓ |
| f13-column-no-migration: Notification.sentAt is mapped to sent_on | data.mapping | T4 S12 U0 · High | ✓ |
| f14-helper-under-listener: Payment-failed mail goes to the last address used | kafka.consumers, data.reads | T1 S12 U2 · High | ✓ |
| f15-mail-host: Mail goes through a new SMTP host | config.clients, async | T2 S12 U1 · High | ✓ |
| f16-own-key: Mail is sent from a new address | config.keys, async | T2 S12 U1 · High · 1 held | ✓ |
| f17-same-class-name: Catalog gets its own ApiExceptionHandler | services.errors, java.names | T7 S12 U0 · High · +1 extra | ✓ |
| f19-unused-constant: A topic constant for shipped orders, not used yet | java.unused | T0 S0 U0 · High | ✓ |
| f20-readme: README explains the topics | files.docs | T0 S0 U0 · High | ✓ |
| a01-async-write: Sent mails are logged as DELIVERED | async, data.writes | T2 S12 U1 · High | **IMPRECISE** screen:/notifications is unclear, truth says test |
| a02-enable-async-removed: Mail is no longer sent asynchronously | async | T4 S12 U0 · High · +1 extra | ✓ |
