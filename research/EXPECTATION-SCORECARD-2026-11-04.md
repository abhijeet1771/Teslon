# How far Teslon is from what we expect of it

2026-11-04, after iteration 8 (ShopFlow: Kafka, mappers, Vue).

> **Update 2026-11-05, after Phase A step 1** (skip certificates and an
> independent checker; see
> [CERTIFICATE-2026-11-05.md](CERTIFICATE-2026-11-05.md)).
>
> The score stays at **66%**: 83% on the stacks Teslon reads. That is on
> purpose. Step 1 adds no stack and no precision. It changes how far part 1
> (trust) can be believed beyond the probes:
> - Every skip is now re-derived by a checker that shares facts but none of
>   the engine's rules. A skip it cannot prove is held.
> - On 748 areas the truth says are reached, the checker would certify none
>   if the engine had skipped them.
> - Precision held: OrderDesk 2.6% and ShopFlow 5.3% held screens, as before.
>   spm went from 0% to 2.5%, for a real unknown it now names.
>
> Part 4 (first answer on an app it has not seen) is where this should show
> next. A new app's blind spots are listed as unknowns before any skip
> stands on them. The next new app is the test of that.

## The expectation

A lead or a manager opens a pull request and asks: *which functionality must
we test, on which pages, and what can we skip?* The PR may name no page at
all. It may change only an API contract, a Kafka topic, a mapper or a
setting. We expect Teslon to answer that question for the PRs of a typical
enterprise web product:
- every area to test, every area safe to skip with proof, and every area it
  cannot rule out;
- every claim with file and line, offline, never silent.

The perfection rules ([PERFECTION-RULES-2026-11-04.md](PERFECTION-RULES-2026-11-04.md))
say what a good answer is. This page says how much of the expectation is met
today, and what is left.

## The score

The score has ten parts. Each is scored from a measurement where one exists,
and from the list of what is and is not read where none does.

| # | Part | Weight | Today | Score | How it is measured |
|---|---|---|---|---|---|
| 1 | Trust on the stacks it reads: never silent, never a wrong skip, every citation re-checks, no crash, same answer twice | 25 | 0 failures in 266 probes on 3 apps, 33 proving-ground PRs, 18 bench cases, 120 real commits | 25 | probe catalogs, proving ground, bench, history scans |
| 2 | Precision: few extra screens, few held | 10 | extra 4.4% / 3.9%, held 2.6% / 5.3% (OrderDesk / ShopFlow); targets ≤ 5% and ≤ 10% | 9 | probe catalogs. Not 10: 7 ShopFlow probes still list a screen that does not show the change |
| 3 | Depth: the section and field on the page | 10 | Angular: the field, the column, the select. Vue: the screen, and the field only for renamed JSON fields | 7 | proving-ground ideals; ShopFlow mapper probes |
| 4 | First answer on an app it has not seen | 10 | first runs on apps in its stacks: 91%, 99%, 88% trusted (OrderDesk catalogs). On ShopFlow, a new mix of Vue and Kafka: **2.5%** | 5 | the first run of each new catalog, before any fix |
| 5 | Java back ends | 15 | see the list below: 12 of 21 patterns read, 2 in part | 9 | list |
| 6 | Front ends | 10 | Angular and Vue read; React, Next.js, Svelte, mobile not read (said out loud) | 4 | list |
| 7 | Back ends that are not Java (Node, Python, .NET, Go) | 5 | not read | 0 | — |
| 8 | Several repositories: a consumer or a page in another repository | 5 | not followed; said as "outside this repository" | 1 | — |
| 9 | Proven on real teams' PRs | 5 | 2 real apps scanned (120 commits, citations and crashes only); 9 probes with truth on one real app; no live PR run yet | 2 | — |
| 10 | The report a lead reads | 5 | one brief everywhere, the decision in ten seconds | 4 | report checklist |
| | **Total** | **100** | | **66** | |

**Against the whole expectation, Teslon is at about 66%.**

On the stacks it reads (Spring, JPA, Kafka, Feign, Angular, Vue), parts 1–4
and 10 count. On those it is at **about 83%** (50 of 60). The gap there is
precision on Vue fields, and how often a new app's first run fails before
its patterns are taught.

### Why part 4 is only half

ShopFlow is the best measure of how Teslon does on code it has not seen. Its
first run trusted 2 of 79 probes:
- Vue routes written as `() => import(...)` were not read, so 8 of 9 screens
  had no answer;
- calls through an `axios.create({ baseURL })` instance were missed;
- nothing joined a Kafka producer to its consumers.

After this iteration's fixes it trusts all 79. The next new stack will find
new gaps in the same way: a new app is the test, not a fixture already taught.

## Part 5: Java back ends, pattern by pattern

| Pattern | Read | Since |
|---|---|---|
| Spring MVC controllers, request rules (`@Valid`, nested) | yes | before |
| JPA entities, repositories, relations (eager, lazy) | yes | before |
| Liquibase, Flyway | yes | before |
| Spring events, `@TransactionalEventListener` | yes | before |
| Kafka: producers, listeners, topics through constants and `${…}`, groups, consumer settings | yes | iteration 8 |
| Feign, WebClient, RestClient between services | yes; a field another service reads, iteration 8 | before |
| Spring Cloud Gateway | yes | before |
| MapStruct (`@Mapping`, `@MappingTarget`, nested mappers) | yes | iteration 8 |
| Builders (Lombok and hand-written), factories whose result is saved | yes | iteration 8 |
| `@Async`, `@Scheduled`, `@Enable…` switches | yes | iteration 8 for the switches |
| Spring Security rules, CSRF | yes | before |
| `@ConditionalOnProperty` implementations, and which one the settings switch on | yes | iteration 8 for the switch |
| RabbitMQ, JMS, SQS | in part: listeners and their queues; which exchange routes to which queue is not read | — |
| Spring Cloud Stream (`StreamBridge`, bindings) | no | — |
| Plain SQL in strings | in part: tables read and written | before |
| MyBatis, jOOQ | no | — |
| WebFlux functional routes | no | — |
| Spring GraphQL | no | — |
| gRPC | no | — |
| Spring Batch | no | — |
| Kotlin | no | — |

## What was fixed this round (iteration 8)

ShopFlow: 4 services, Kafka, MapStruct, builders, Feign, a gateway, Vue 3 with
Pinia. 79 PRs, truth written first.
- **Vue:**
  - lazy routes;
  - an axios instance and its base URL;
  - template-literal URLs;
  - `<RouterLink>` in PascalCase;
  - navigation guards and route `meta`;
  - components the root draws beside `<RouterView>`;
  - Pinia stores in the app are read, not opaque;
  - an API module's or store's member is what a screen uses: a screen that
    uses none of the changed members is skipped, with them as proof;
  - a page that sends a payload key the API does not have.
- **Kafka:** who publishes to which topic and who listens is worked out
  through constants and settings. The engine now follows:
  - a topic, group or consumer setting that changed;
  - a message type whose fields changed (only the consumers that read those
    fields);
  - what a producer puts on the topic;
  - a listener removed.

  It names a topic nothing publishes any more, and one nothing here
  consumes. It follows the chain across services: billing's charge reaches
  the order status.
- **Data:**
  - a removed guard before a write, or any line before one, changes the
    write;
  - a value passed on to a call that writes;
  - a factory's or builder's result saved by its caller;
  - a setter writes the entity its receiver is typed as;
  - a migration reaches the jobs that write the table;
  - a column renamed in the entity reaches the jobs as well as the APIs.
- **Contracts:**
  - a field the provider no longer sends is named where another service
    reads it through Feign;
  - a MapStruct `@Mapping` change names its field;
  - Java code that reads an accessor (`o.getCustomer().getName()`) is
    followed.
- **Settings:**
  - an implementation the settings switch off is said, and its data is not
    held;
  - `@EnableAsync` and the other switches reach every method they govern;
  - a new constant nothing names changes nothing.

## What is pending, most valuable first

The research behind each item, and the plan for it, is in
[RND-PLAN-2026-11-04.md](RND-PLAN-2026-11-04.md).

1. **React and Next.js.** This is the most used front end, and today Teslon
   only says it cannot read it.
2. **Several repositories.** A Kafka consumer, a Feign client or a page in
   another repository. Today Teslon says "outside this repository"; it
   should read a set of repositories together.
3. **A live run on real PRs** (task 6: it needs the `abhijeet1771/orderdesk`
   repository created). After that, real teams' PRs with their QA's truth.
4. **Vue field-level reads**, so a mapper or DTO field change lists only the
   screens that show that field. 7 ShopFlow probes are imprecise for this.
5. **RabbitMQ exchange-to-queue routing, Spring Cloud Stream bindings, JMS
   producers.**
6. **GraphQL, gRPC, WebFlux functional routes, Spring Batch.**
7. **Kotlin**, then back ends that are not Java (NestJS and Express, Django
   and FastAPI, ASP.NET, Go).
8. **ModelMapper, MyBatis, jOOQ.**
9. **Mobile clients** of the same APIs.
