# Mechanisms to add

How this list was made: the sample report for spring-petclinic #559
([`sample-output/pr-559.txt`](sample-output/pr-559.txt)) was attacked
the way a QA lead would. The hunt covered the repository, its separate
config repository, and the real customers-service built at the PR head and
sent boundary inputs. Every finding below was **run or read**, not reasoned
from memory. Each one names the mechanism that would have found it.

## Found on #559

| # | Mechanism | What it found on #559 (verified) | The rule | Where else it pays |
|---|---|---|---|---|
| M1 | **Constraint semantics: holes** | `name` missing → **201, saved with no name**. `name "   "` → 201. `birthDate` missing → 201. Only `""` is rejected. The sample report wrongly expected the chat's "pet with no name" to be refused. | Bean Validation: every constraint except `@NotNull` accepts null. `@Size` counts spaces; `@NotBlank` does not. Emit the inputs that slip through. | Every validation change. "We fixed empty X" is the commonest half-fix. |
| M2 | **Temporal boundaries** | "Today" is judged in UTC: UTC today → 201, UTC tomorrow → 400. In India, from 00:00 to 05:30 IST, picking today is **rejected**. A US user in the evening can pick tomorrow. | `@Past`, `@PastOrPresent` and `@Future` × field type (`Date`, `LocalDate`, `Instant`) × `@JsonFormat` and the Jackson time zone → the boundary instant → which time zones get a window. | Dates, cut-offs, "expires today", report periods. |
| M3 | **What the user sees on an error** | The 400 body is `{timestamp, status, error: "Bad Request", path}` with no field list. Through `client.js:82` → `reportError()` → `RootApp.js:15-17`, the form shows a red "Bad Request" banner with no field marked. | Status → framework error-body defaults (`server.error.*`) → config overrides → the client's error handler → the element that renders it. | Every new 4xx/5xx path. This is how "no validation message" bugs (#557) are predicted rather than found. |
| M4 | **Config repo connector** | Closed the report's only "could not see": the config repo (`@323993c`) sets no `server.error.*` and no `spring.jackson.time-zone`. | Follow `spring.cloud.config.server.git.uri`, read that repo (it is just git), and merge its properties by profile. | Any Spring Cloud Config, Consul or Nacos setup. It turns K2 into K1 with no new trust. |
| M5 | **Non-code consumers** | The JMeter plan POSTs and PUTs pets (`petclinic_test_plan.jmx:249, :300, :343`) with `2018-12-31T23:00:00.000Z` and a name: **still passes**, verified 201. | Find JMeter, Postman, `.http`, k6, Gatling and curl scripts that hit a changed endpoint; evaluate their payloads against the new rules. | Load tests, smoke scripts and partner collections break silently in CI or on release night. |
| M6 | **Seed and fixture data vs new rules** | 0 of 13 pets break the rules, in both `hsqldb` and `mysql` `data.sql`. The MySQL file uses `INSERT IGNORE`, which the first regex missed. | Parse seed SQL, Liquibase CSVs and fixtures, and run the new constraint as a query over them. Needs no production access. | Demo and QA environments that stop working after a deploy. |
| M7 | **Ghost-file guard** | 32 of the product's 127 files did not exist at the PR head: co-change history pointed at deleted and renamed files. **Fixed in the product** (127 → 97, test added). | An edge may only point at a file in the tree at head. Renames are to be followed next (`git log -M`). | Every repo with history: it removes noise for free. |
| M8 | **Framework-version semantics** | Spring Boot 4 / Jackson 3: a payload without `id` → 400 "Cannot map `null` into type `int`". | A catalogue of default changes between framework versions, applied to any dependency-upgrade PR: which payloads, beans and behaviours flip. | The Spring Boot 4 upgrade PR, where the product found 0 pages. |
| M9 | **Client/server rule parity** | The form trims and requires the name. The server only rejects `""`. So the form is stricter than the API: the gaps are reachable through the API and the chat only. | Compare the guard algebra on each entry point with the server rule. Wherever the server is weaker than any client, that client is safe and every other entry point is not. | Mobile apps, partner APIs and AI tools that skip the web form's checks. |
| M10 | **AI-tool input domain** | The chat's `PetRequest` is filled in by a model, which can omit fields. Combined with M1, the chat is the one UI path that can save a nameless pet. | A DTO filled by an LLM tool has no client guard: its domain is any JSON, including missing fields. | Every `@Tool`, function call or agent action. |

## Beyond #559: next by change kind

Ordered by how often the change escapes (field evidence and the oracle
catalogue), then by how many repos in the proving ground have it.

| # | Change kind | Mechanism | Proof we already have |
|---|---|---|---|
| N1 | Response field renamed, retyped or made nullable | Field-level reader join from the JSON property to template bindings, columns, selects and pipes | Oracle case: product 0/6, truth 6 pages incl. a cross-entity dropdown |
| N2 | Enum value added | Exhaustive `switch` statements, `<select>` options and i18n keys for each value, across services | TrainTicket F20 (shared enum lib) |
| N3 | Route renamed or removed | Links, `router.push`, redirects, guards, email templates, sitemap | Journeys in `field-chain` |
| N4 | Role or permission changed | Page × role matrix from `@PreAuthorize`, route guards and `v-permission` | 18 repos in the proving ground use it |
| N5 | Config key renamed or default changed | Key ↔ `@Value` / `@ConfigurationProperties` reader; silent fallback to the default | Atlas channel 10 |
| N6 | Migration vs running code | Column ↔ entity ↔ query, and N−1 compatibility during rollout | Pattern 2 in the field evidence |
| N7 | Shared component, prop default or CSS order | Component instance tree; selector ↔ template matching; import order | Halo #6153 (CSS import order) |
| N8 | i18n key changed | Key ↔ usages per locale; missing text in one locale only | 19 repos use i18n |
| N9 | Fallback or cache changed | Breaker fallbacks that turn failures into empty data; `@Cacheable` keys and TTLs | `ApiGatewayController.java:61`, `VetResource.java:45` |
| N10 | Metric or log name changed | Micrometer and log-pattern name rules → dashboard and alert queries | Grafana `json:449` keyed on a method name |
| N11 | Async message schema changed | Topic and event-class ↔ consumers; messages in flight during deploy | ThingsBoard, TrainTicket F13 |

## What this changes in the plan

- M1, M2, M3 and M9 belong to **stage 5** (inputs from the delta). Their output
  is exactly the DO and EXPECT lines QA needs, and they are what made the
  sample report wrong when it guessed.
- M4 (the config repo) moves **ahead** of the other connectors in stage 7. It
  is plain git and it closed the report's only blind spot.
- M5 and M6 join the **data pack** (4.3): no production access is needed.
- M7 is done. M8 needs a version-defaults catalogue and goes with the
  dependency pack (4.7).
- A claim about runtime behaviour in a report must be marked as either
  *verified* (run) or *derived* (by rule). The sample report now does this.
