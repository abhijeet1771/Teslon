# Change atlas: every kind of change a developer makes, and what Teslon does with it

2026-11-05. This is the R&D map behind the gauntlet
([GAUNTLET-2026-11-05.md](GAUNTLET-2026-11-05.md)). It sorts the changes
developers make into 17 families, with 150 kinds between them. For each
kind it records:
- how the change reaches a user;
- what QA has to test;
- what Teslon does with it today.

Every status is backed by a probe whose truth was written before Teslon ran,
or by the compiler-proven mutants.

**Status:**
- **✓ precise:** Teslon follows the change to the exact screens, APIs and
  jobs, and skips the rest with a checked proof.
- **◐ said and held:** Teslon names the change but cannot follow it. It holds
  every area it cannot rule out as unclear, and it is never silent.
- **✗ gap:** a known way Teslon can still be wrong. Each gap is listed with
  its plan.

Probe ids are given in brackets. Their catalogs are:
- OrderDesk: `j`, `u0…`, `d`, `c`, `x` in `catalog.mjs`; `k-rule`, `h` in
  `catalog-contracts.mjs`; `z` in `catalog-hardest.mjs`; `u1…u4` in
  `catalog-superhard.mjs`.
- ShopFlow: `k`, `m`, `v0…`, `f`, `a` in `catalog-shopflow.mjs`; `v1…v4` in
  `catalog-superhard-shopflow.mjs`.
- Proving ground: `s` in `bench/proving-ground/scenarios.mjs`.
- Real app: `spm` (spring-petclinic-microservices).
- Gauntlet: `G-behaviour`, `G-route` and `G-comment` are the mutation
  families, one mutant per method or endpoint.

## 1. Java code

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A method's body changes | Every screen, API and job whose request runs the method, through calls, interfaces, lambdas and events | ✓ G-behaviour: all 200 methods compiled and checked against the bytecode call graph |
| A static helper or a constant | Every method that calls or reads it | ✓ [j01, j02] |
| An enum constant renamed or added | The stored values, the JSON, and every switch | ✓ [j07, s18] |
| A record or DTO field renamed | The JSON field: what each screen reads | ✓ [j09, s02, s15–s17] |
| A getter added (a computed property) | Jackson writes it into every response that holds the type; a strict reader refuses it | ✓ [h24, z01, z02] |
| equals, hashCode or toString | Sets, maps, deduplication, logs | ◐ followed as accessors, to where the type travels |
| A new class nothing uses | Nothing yet | ✓ [r01] "nothing uses it yet" |
| Code that does not compile | The build fails: nothing ships | ✓ [j12] held, "Not proven" |
| A comment or layout inside a method | Nothing | ✓ G-comment: the code is compared token for token (fixed in this round) |
| A whole-file reformat with one real change hidden in it | The hidden change | ✓ [s19] |
| An overload, or an override in a subclass | Calls by the static type | ✓ through the class hierarchy (gauntlet) |

## 2. Spring wiring and start-up

These are new this round. The compiler accepts each change, and no method
behaves differently, yet the service does not start.

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A bean moved outside the component scan | Spring does not create it; whoever needs it fails, so the service does not start | ✓ [u4-01] (was a wrong skip) |
| @Service / @Component removed from a needed class | The service does not start | ✓ [u4-02] (was held) |
| A constructor asks for a type no bean provides | The service does not start | ✓ [u4-03] (was a wrong skip) |
| A Spring Data derived query whose property does not exist | The repository cannot be built; the service does not start | ✓ [u4-04] (was a wrong skip) |
| A Flyway migration edited after it ran | Its checksum is refused; the service does not start | ✓ [v4-01] |
| A Flyway migration numbered below the latest one | Validation refuses it; the service does not start | ✓ [v4-02] (was a wrong skip) |
| A Liquibase changeset edited in place | Its checksum is refused | ◐ [u4-05] every screen held |
| A @Bean method or a @Configuration class | Everything that uses the bean, or the whole service | ✓ [j14, c04] |
| @ConditionalOnProperty, two implementations of an interface | The one the settings switch on | ✓ [j21, c04, billing provider probes] |
| @EnableAsync, @EnableScheduling, @EnableCaching | How every method they govern runs | ✓ [ShopFlow @EnableAsync probe] |
| @Value with a key that no setting defines | Start-up fails | ✗ not checked yet (plan: the same start-up reader) |

## 3. The API contract

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A path or a verb changes | Every caller now gets a 404 or a 405 | ✓ G-route: 34 of 34; [h06, s13] |
| A controller prefix changes | Every endpoint of the controller | ✓ G-route (prefix mutants) |
| A query parameter is renamed, added or made required | The calls that do not send it | ✓ [h04, h05, h13] |
| A body field renamed, removed or retyped | The screens that send or read it, at field level | ✓ [h11, z03, s02–s04] |
| Dates, enums, numbers, nulls | Formatting and parsing on each screen | ✓ [h01, h02, h14, h15, h19, z03, z04] |
| A status code, an error body or an empty answer | Error paths on the calling screens | ✓ [h21, z05, j10] |
| Media type, or the page envelope | Every caller of that endpoint | ✓ [h03, h07] |
| Request rules (Bean Validation) tightened | The forms that send that body, with the inputs to try | ✓ [k-rule-*, j08, s01] |
| A nested @Valid removed | Rules on the nested list no longer run | ✓ [h18] |
| Parameter names no longer compiled in | Endpoints whose @PathVariable or @RequestParam has no name | ✓ [u4-06] (was silent) |

## 4. Data and persistence

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A column renamed in the entity only, or in the database only | Every read and write of that entity | ✓ [h10, z28, z29] |
| A NOT NULL column with no default | Every insert of that entity | ✓ [z30, s12] |
| A unique constraint | Creating or editing a row that clashes | ✓ [u3-10] |
| A migration that updates rows | Every screen that shows those rows | ✓ [u3-11] |
| A seed changes | The screens that show the seeded rows | ✓ [d03] |
| An index only | Speed, nothing visible | ✓ [d02] |
| Optimistic locking (@Version) with no accessor | Edits through the API are taken for new rows and refused | ✓ [u4-12] |
| A lazy relation, or open-in-view | Serialisation of what is not loaded | ✓ [h08, h20] |
| JPQL, native SQL, JDBC writes | The readers of what is written | ✓ [j04, j16, z25] |
| What a write stores (data read elsewhere) | Every screen and job that reads the rows | ✓ [s27, s28, z15–z18] |
| Transactions (propagation, read-only) | Whether writes commit | ✓ [j03] |

## 5. Messaging and events

| Kind | How it reaches a user | Teslon |
|---|---|---|
| Topic names, constants, properties | Producers and consumers no longer meet | ✓ [k01–k03, k12–k14] |
| A message field renamed, dropped or added | Each consumer of the topic | ✓ [k04–k06, k17] |
| A key or partition, serializers, trusted packages | Ordering, and whether consumers can read at all | ✓ [k16, k18, k19] |
| A consumer group, retries, a dead-letter topic | Re-reading and duplicates | ✓ [k07, k20] |
| Listener concurrency | Races between records | ✓ [v3-09] |
| Spring events: a publisher dropped, a listener changed | The listeners, or none at all ("never runs") | ✓ [s26, j11, j22] |
| @Async on or off | What the request sees, and when | ✓ [j20, k15] |

## 6. Service to service

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A Feign client's path or DTO | The screens whose request crosses into the other service | ✓ [m12, ShopFlow catalog-path probe] |
| A Feign client's service name | Discovery fails | ◐ [v3-03] held, not listed to test |
| Gateway routes (paths, strip prefix, a catch-all) | The screens whose calls the route forwards | ◐ [v3-04, v4-05] held; precise for path routes [ShopFlow /api/billing probe] |
| Gateway default filters | Every request | ◐ [v4-06] held (here a trap: nothing reads the header) |
| Another service's API used with its own type | A field it no longer sends arrives empty there | ✓ |

## 7. Configuration

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A key the app binds (@ConfigurationProperties, @Value) | The code that reads it | ✓ [s11, z27, z35] |
| A framework key (jackson, server, jpa, mail, kafka) | The whole service, or the one client bean it configures | ✓ [z04, z31, c02] |
| A placeholder or an environment default | The code that reads it, or nothing | ✓ [u1-09] held, not listed |
| A profile file (application-prod.yml) | Only where the profile is on | ✓ [u3-07] |
| A deployment that turns a profile on | Every setting of that profile | ✓ [u4-08] (was a wrong skip) |
| Logging, management, info | Nothing a user sees | ✓ [c01] |
| A key nothing reads | Nothing | ✓ [c03] |

## 8. Security

| Kind | How it reaches a user | Teslon |
|---|---|---|
| requestMatchers rules and roles | The endpoints the patterns match | ✓ [z08, z10, z14, s14] |
| CSRF on or off | Every state-changing request | ✓ [z09] |
| Method security (@PreAuthorize) | That method's callers | ✓ [j18] |
| The token's header or scheme, the session key | Every call that needs it | ✓ [z11, u06] |
| Front-end guards and role checks | The guarded screens | ✓ [u02, z13, v05] |
| CORS | Calls from other origins | ✗ not modelled; said as a framework setting |

## 9. Front end (Angular and Vue read; React, Svelte and AngularJS detected, not read)

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A route path, a moved route, a removed route | The screen, and every link to it | ✓ [u01, f-route probes, z42] |
| A component's template or logic | The screens that draw it | ✓ [s06, z38, v01] |
| A selector or input renamed | The parent templates break (the build fails) | ✓ [u3-13, u3-14] |
| A Vue prop renamed and the parent not updated | The screens that pass it | ✓ [ShopFlow OrderLinesTable probe] |
| A service, an API module, a store, a composable | The screens that use those members, at member level | ✓ [u03, v03] |
| An interceptor | Every call | ✓ [s07, z12] |
| A pipe, a filter, a formatter | Every value it formats | ✓ [u09, v02] |
| Router input binding switched off | The screens fed by resolvers | ✓ [u3-16] |
| index.html, the mount point, the bundler base | Every screen | ✓ [u11, v4-10, v4-11] |
| A global stylesheet | Every screen | ✓ [u10] |
| A component style that escapes (::ng-deep, no encapsulation) | Every screen, once the component has been drawn | ✓ [u4-15] (was a wrong skip) |
| A shell component (toasts, navbar) | The screens that use it | ✓ [v3-12, s08] |
| Images and fonts | Wherever the code names them | ✓ [s29, s31] |
| Types only (interfaces, `import type`) | Nothing at run time | ✓ [u07] |
| A React, Svelte or AngularJS file | Not read | ◐ said, every screen held |

## 10. Build and dependencies

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A Spring Boot or parent bump | Every module | ✓ [x03] |
| A runtime dependency added or removed | The module that uses it | ✓ [x02] |
| A dev dependency | Nothing, unless it builds the bundle | ✓ [x01] |
| npm packages and lockfiles | The files that import the package | ✓ [s21, ShopFlow axios probe] |
| Compiler flags (-parameters, release, processors) | What the code compiles to | ✓ [u4-06]; other compiler changes are said and held (fixed in this round: was "no effect") |
| lombok.config | The generated accessors | ◐ [v4-07] held |
| tsconfig only | Type checking only | ✓ [v1-13] held, not listed |

## 11. Deployment and infrastructure

| Kind | How it reaches a user | Teslon |
|---|---|---|
| Dockerfile, the entrypoint, start-up scripts | Whether the service starts, its time zone and memory | ✓ [s30] as DEPLOY |
| Kubernetes, Compose, Helm | The service as configured | ✓ DEPLOY; a profile they turn on is followed [u4-08] |
| Terraform, nginx, other proxies | Not read | ◐ said |

## 12. Time, money and locale

| Kind | How it reaches a user | Teslon |
|---|---|---|
| Time zones, day boundaries | Reports, date filters | ✓ [z21] |
| Rounding, discounts, currency | Every total | ✓ [z06, z15, z16, s05] |
| Date and number formats in the front end | Every value shown | ✓ [v02, f probes] |

## 13. Concurrency and performance

| Kind | How it reaches a user | Teslon |
|---|---|---|
| Caching added or changed | Stale reads after writes | ✓ [j17] |
| Thread pools, @Async, listener concurrency | Ordering, and races | ✓ [j20, v3-09] |
| Index, pagination size | Speed, and how many rows | ✓ [d02, z27] |
| An N+1 query, a slow loop | Speed only | ✗ not modelled (Teslon is not a profiler) |

## 14. Observability

| Kind | How it reaches a user | Teslon |
|---|---|---|
| Log levels and format | Nothing a user sees | ✓ [c01] |
| A metric name a dashboard reads | The dashboard panel | ◐ [spm dashboard coupling, IMPACT-ATLAS] |

## 15. Code Teslon does not read

| Kind | How it reaches a user | Teslon |
|---|---|---|
| A Go or Python tool that writes through the API | The data on the screens it writes | ◐ [u4-17, u3-18, v4-14] said, every screen held |
| A Kotlin file in a Java service | Whatever calls it | ◐ [v3-15] said, held |
| GraphQL, protobuf, OpenAPI files | Generated clients and servers | ◐ said as unread files |

## 16. Changes with no effect (Teslon must say "nothing to test")

| Kind | Teslon |
|---|---|
| Docs, CI, tests only | ✓ [s09, s10, s23] |
| Comments and layout, even inside a method | ✓ G-comment (fixed in this round: it was listing areas to test) |
| Types only, unused constants and classes | ✓ [u07, r01] |
| A trap that looks big but changes nothing (a header no service reads) | ✓ [v4-06] held, nothing listed to test |

## 17. The shape of the PR

| Kind | Teslon |
|---|---|
| An old base, a merge commit, a squash, a rebase | ✓ [s24, s25] |
| Hostile text in the diff | ✓ [s22] escaped |
| Huge generated PRs | ✓ [r01] |

## The gaps that remain

1. **@Value with a missing key, and CORS.** Both are start-up and framework
   rules for the same reader. Plan: the next round of `startup.ts`.
2. **Code in languages Teslon does not read** (Go, Python, Kotlin, React).
   Teslon is never silent about it: every area is held, so the skip list
   shrinks. Plan: readers by demand, starting with React and Kotlin, the two
   most used in the surveys
   ([TECH-LANDSCAPE-2026-11-05.md](TECH-LANDSCAPE-2026-11-05.md)).
3. **Performance-only changes.** These are out of scope by design: Teslon
   finds what to test, not how fast it is.
4. **Rules as wide as the service.** A gateway filter or a Feign name is held
   for every screen, not only the ones whose calls cross that route. Plan:
   follow the route to its callers, as the path rules already do.
