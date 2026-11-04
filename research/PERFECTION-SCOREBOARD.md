# Perfection scoreboard

The rules and gates are in
[PERFECTION-RULES-2026-11-04.md](PERFECTION-RULES-2026-11-04.md). There is
one row per iteration. A cell is ✓ when the gate holds on every suite that
measures it.

## The rows

| Iteration | T1 silent | T2 wrong skip | T3 citations | T5 crash | C2 one answer each | Probes trusted | P1 extra | P2 held | Logic units probed |
|---|---|---|---|---|---|---|---|---|---|
| 0 (before the catalog) | ✓ proving ground | ✓ proving ground | 0 on spm, **failures on JHipster** | **1 crash on JHipster** | ✓ | — | — | — | — |
| 1 (catalog written) | ✓ | **3 wrong skips** | ✓ | ✓ | **1 miss** | 31 / 34 | 10.0% | 15.0% | 35 |
| 2 | ✓ | ✓ | ✓ | ✓ | ✓ | 34 / 34 | 6.1% | 12.0% | 35 |
| 3 | ✓ | ✓ | **failures on JHipster** (multi-line Liquibase tags) | ✓ | ✓ | 34 / 34 | **3.4%** ✓ | **4.4%** ✓ | 35 |
| 4 | ✓ | ✓ (2 wrong skips found, fixed) | ✓ | ✓ | ✓ | 39 / 39 | **2.4%** ✓ | **6.2%** ✓ | 39 |
| 5 | ✓ | ✓ (2 wrong skips found, fixed) | ✓ (1 citation bug found on each history, fixed) | ✓ | ✓ | 44 / 44 | 2.1% ✓ | 6.6% ✓ | 42 |
| 6: a real microservices app | ✓ | ✓ (1 found, fixed) | ✓ | ✓ | ✓ | 9 / 9 on spring-petclinic-microservices | 1.2% ✓ | 0.0% ✓ | 10 |
| 7a: 92 API-contract probes written | ✓ | **1 wrong skip** (h10) | ✓ | ✓ | ✓ | 91 / 92 | 7.2% | 10.3% | 19 |
| 7b: 42 hardest probes written | ✓ | **5 wrong skips** (z28, z29, z32, z33, z42 silent) | ✓ | ✓ | **3 misses** (z42) | 37 / 42 | 21.4% | 16.3% | 22 |
| 7c: all fixed | ✓ | ✓ (3 more found by the new skip rule, fixed) | ✓ | ✓ | ✓ | **178 / 178** | **4.4%** ✓ | **2.9%** ✓ | 70 |

## What each iteration found and fixed

### Iteration 1: 34 real PRs on OrderDesk, truth first (`bench/probes/catalog.mjs`)

Trust and completeness misses:
- **A route moved, and its links were "safe".** `/orders/:id` became
  `/orders/view/:id`, and three screens still linking to the old path were
  skipped. Two causes:
  - screens that link to a removed route were named in a sentence, not
    listed;
  - the Angular reader did not read `router.navigate([...])` or
    `navigateByUrl(...)` at all.

  Both are fixed. Each screen that still links is listed test first, with
  the link's line.
- **An enum rename said nothing about rows already stored.** Renaming
  `SHIPPED` to `DISPATCHED`, stored by name, breaks every stored `SHIPPED`
  row. Now an enum change on an entity field is followed:
  - stored by name, a removed value is named, and the rows holding it are
    called out;
  - stored by position (JPA's default), a reorder is named the same way;
  - every screen showing the entity is held.
- **A dev-only dependency left screens with no answer.** Two fixes:
  - Check-only tools (ESLint, Prettier, Jest, `@types/*`) are now
    "no app effect".
  - Build tools (the Angular builder, TypeScript, Vite, Sass) reach every
    screen, because they build what ships.
  - Unknown tools are said out loud.

  Generally, when the running app changes, every screen now gets an answer.

### Iteration 2: precision

- **Log settings** (`logging.level`, …) reach no screen. They were every
  screen.
- **An unbound own key.** A key under the app's own
  `@ConfigurationProperties` prefix that no component binds is said to be
  read by nothing.
- **TypeScript types.** Lines inside `interface`, `type`, `import type` and
  `declare` are erased at build time, so they reach no screen.

### Iteration 3: migrations, and a reader bug under them

- **Migrations Teslon now reads:**
  - indexes (speed only, a watch on the table);
  - unique indexes and constraints (writers can be refused);
  - column type changes (writers whose values may not fit);
  - seed data: `loadData`, `insert`, `update`, and the CSV a changeSet
    loads (the screens showing that table).
- **The Java reader dropped type arguments.** `extends JpaRepository<Order,
  Long>` was read as `JpaRepository`. That meant "which endpoints save
  Order" never worked for an endpoint that takes a DTO. It works now.

### Iteration 4: what runs without being called

Five more real PRs:
- an `@Around` aspect;
- a `JdbcTemplate` job;
- `@Cacheable`;
- `@PreAuthorize`;
- an `@ConditionalOnProperty` flag.

What they found:
- **Plain SQL writes were not data writes.** A job running `update orders
  set status = …` left the order screens "safe". SQL in a method's string
  literals is now read: `update`, `insert into` and `delete from` write the
  table; `from`, `join` and `into` read it. Those screens are held with the
  write as evidence.
- **"Nothing reads it" was wrong for a flag.** Iteration 2's rule called a
  key nobody binds unread. But `@ConditionalOnProperty(prefix = "orderdesk",
  name = "mail-enabled")` reads it: the whole bean exists or not by it. Now:
  - conditional annotations are key readers;
  - the bean's listeners and its callers' jobs are listed;
  - "nothing reads it" is claimed only when no Java string anywhere names
    the key.
- **Aspects.** An `@Aspect`'s pointcuts are read (`execution(* pkg..*(..))`,
  `within`, `@annotation`). Every method they wrap is followed as if it
  changed. A pointcut that cannot be read stays unfollowed, and is said.
- **Precision: a changed constant** reaches only the methods that use it,
  not every method of the class.
- **Citations on multi-line migration tags.** The JHipster history scan
  found Liquibase tags written over several lines, cited on the wrong line
  after iteration 3. Each migration citation is now on the line its quoted
  word is on.

### Iteration 5

- **An implementation called through its interface.** `tax.apply(…)` calls
  `StandardTax.apply`, and its result was written into `Order.total`
  without being followed.
- **A changed condition decides the writes after it.** Java diffs ignore
  whitespace, so a setter moved inside a new `if` is not a changed line. The
  `if` is, and it now counts as deciding the writes below it.
- **A new class nothing names**, with no annotation the framework acts on,
  is "added; nothing uses it yet". 300 of them take 4 seconds.
- **A citation of a changed constant** quoted one field on another field's
  line. It now quotes its own token.

### Iteration 6: spring-petclinic-microservices, a real app (`bench/probes/catalog-spm.mjs`)

Nine PRs across:
- the services;
- the gateway's routes and its WebClient calls;
- the Spring AI tools;
- the Vue front end.

What they found:
- **A gateway route whose path changes** is followed to every page that
  still calls the old path (404).
- **A shared front-end file**, the HTTP client, reaches the chat box drawn
  on every screen as an area of its own.

### Iteration 7: API contracts, and the hardest PRs (`catalog-contracts.mjs`, `catalog-hardest.mjs`)

These 134 probes ask the lead's question: "which functionality, on which
page?" The PR names no page, and often no API.
- **The contract map** is written by hand from every template and form. It
  records who reads and who sends each JSON field of Customer, Product,
  Order, OrderItem, OrderSummaryDto, DailySalesDto and TopProduct.
- **From the map:** 62 rename and drop probes, and 6 request-rule probes.
- **24 hard contract probes:**
  - an enum's JSON value;
  - date formats;
  - `Page` instead of `List`;
  - renamed and required query parameters;
  - PUT → PATCH;
  - XML;
  - lazy relations;
  - `@Transient`;
  - a column renamed without a migration;
  - front-end payloads;
  - a trailing slash;
  - `NON_NULL`;
  - `@JsonIgnoreProperties` on an embedded type;
  - a removed nested `@Valid`;
  - a 204;
  - a path variable's type;
  - a computed getter.
- **42 hardest probes:**
  - security rules, CSRF, a Bearer token, a dropped interceptor;
  - guards and role checks;
  - a discount, a line total, the last unit in stock, a cancel rule, sort
    order, the report's time zone;
  - a shared `findAll` with a filter;
  - page size;
  - a dropped column the entity still maps;
  - a NOT NULL column with no default;
  - mail settings and listeners inside the request;
  - an after-commit listener;
  - cron and thresholds;
  - a service URL;
  - form limits;
  - shared widgets;
  - resolvers;
  - a route title;
  - a parent route that moves.

**Wrong skips and silences, all fixed:**
- **h10.** An entity `@Column(name)` changed with no migration. The report
  page was safe; now every user of the entity is test first.
- **z32 and z33.** A plain `@EventListener` runs inside the request that
  publishes its event, and the order form was safe. A publish is now a call.
- **z28 and z29.** A dropped or renamed column reached only the APIs
  returning the entity. The order detail joins customer eagerly and was
  safe. Now every API that loads the entity is reached, through eager
  relations, and through lazy ones where serialized or walked.
- **z42.** A parent route moving left Teslon silent. Every child screen,
  old and new, is now listed, with the links left behind.
- **Found by the new member-level skip (3).**
  - A route's inline resolver calls the service for the edit page. The
    route file is now counted.
  - `@Transient` dropped a stored field, and the order list was safe. A
    field no longer stored now reaches the APIs that read it back.

**Precision:**
- a screen that imports a service but never calls the changed member is
  skipped with proof;
- security path rules and CSRF are scoped;
- `spring.mail.*` and the other client settings reach their client's code;
- a guard or a title belongs to its route, not the app shell;
- a new getter is a JSON field, not a code change on every screen;
- nested `@Valid` rules are request rules.

Extra screens went from 21.4% to 4.4%, and held screens from 16.3% to 2.9%.

The other suites are unchanged:

| Suite | Result |
|---|---|
| Unit tests | 189 pass (11 new, one per rule above) |
| spring-petclinic-microservices probes | 9 / 9 |
| Proving ground | 33 / 33, ideal 16 / 16 |
| Bench | 18 / 18, no silent misses, no wrong skips |
| 60-commit history scans, spm and JHipster | 0 citation failures, 0 crashes |

On JHipster, held areas went from 445 to 435.

**Truth corrections (Teslon was right):**
- a plain listener runs inside order creation (j11, c04);
- an eager `@ManyToOne` means the order list and the report break when a
  customer column is dropped (z28, z29);
- an interceptor and a navbar role check are on every screen (z12, z14);
- the navbar link to a moved route is on every screen (z42);
- an open product API is reached from every page that calls it (z10).

### Truth corrections

All are marked in the catalog. In each case Teslon was right, and the truth
written first had missed something:
- the dashboard uses the money pipe;
- a Spring Boot bump reaches every screen;
- cancelling an order saves its note again;
- the dashboard and the product edit form show seeded products;
- the customer and product APIs call repositories directly, so a service
  aspect does not wrap them.

## Not yet perfect

- **C4 coverage of every logic unit.** The catalog covers the Spring +
  Angular logic on OrderDesk (35 tags). The Vue reader, gateways, Feign
  clients, AI tools, dashboards and JMeter plans are covered by the bench
  (spring-petclinic-microservices) and the unit tests, not by catalog probes
  with written truth.
- **Next probes:**
  - mappers and builders;
  - Kafka listeners;
  - `@Async`;
  - a second implementation of an interface;
  - Feign clients and the gateway on a microservice app;
  - Vue screens.
- **Precision still to gain:**
  - framework JSON settings (`spring.jackson.*`) still reach every screen,
    not only the screens that read dates or nulls;
  - a changed getter on an entity reaches every screen of that entity, not
    only those that read the field;
  - field-level data holds;
  - exception handlers reach only the endpoints that throw the exception
    they handle.
