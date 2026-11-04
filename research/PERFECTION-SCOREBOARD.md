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
  - member-level skips: a screen that imports a service but does not call
    the changed method is held, not skipped;
  - field-level data holds;
  - exception handlers reach only the endpoints that throw the exception
    they handle.
