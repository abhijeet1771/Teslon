# Everything a QA needs to know after a PR

2026-10-23. The goal is that the person reading Teslon knows **what to
test**: which module, which functionality, which page down to the field,
which API, and everything else the change reaches. They should also know
what they can skip and why, and what Teslon could not see.

This is the full list, with what the engine gives today: ✓ yes, ◐ partly,
✗ no. Each row was grounded in a real repo. The JHipster sample alone has
Cypress tests, i18n files, role checks, Liquibase changesets and email
templates.

## 1. First answer: does this PR need testing at all?

| question | today | how |
|---|---|---|
| Does it touch the running app? (docs, CI, tests only → no) | ✗ | Classify files by path. This clears 17 of 60 real spm commits. |
| What kind of change is it: feature, fix, refactor, dependency, config, deploy? | ✗ | Built from the deltas and file kinds, not from the PR title |
| How risky, and in what order to test? | ◐ (tiers) | Tiers, plus history (co-change and past escapes, from v1) |

## 2. Where it lands

| what the QA needs to know | example | today | facts it needs |
|---|---|---|---|
| **Module / service** | customers-service; the gateway UI; genai-service | ◐ (named inside the APIs) | Maven/Gradle modules, `spring.application.name`, front-end apps |
| **Functionality** (user-level) | "Add a pet", "Edit a pet", "Add a pet through the AI chat" | ✗ (only the delta title) | endpoint operations, screen actions (button labels), E2E test titles, i18n labels |
| **Page → section → field** | Add Pet › Pet › Birth date | ✓ for request rules, Vue only | routes, templates (Vue compiler, Angular compiler), labels |
| **What on the page**: the field, button, link, table column, dropdown option, empty/error/loading state, and the condition it shows under | the Bank Account dropdown options on Operation edit; the ID field shown only when `bankAccount.id` is set | ◐ (fields and buttons) | `v-if` / `@if`, loops, states (from the official parsers) |
| **Shown on every page** (layout, nav, widgets) | `<chat-box>` beside `<router-view>` | ✓ | root components |
| **Journey across pages** | Owner details → Edit Pet → Save → back to owner | ◐ | links, `router.push`, form submit handlers |
| **APIs**: verb, path, request rules, response shape, status codes, error body | `POST /api/customer/owners/{ownerId}/pets` now 400 on a future date | ✓ request rules; ✗ response shape, status, auth | controllers, DTOs, Jackson names, gateway routes |
| **Service-to-service calls** and AI tools | genai → customers-service through discovery, no 4xx handling | ✓ | RestClient, WebClient, Feign, discovery, `@Tool` |
| **Other clients of the API** (mobile app, partners, scripts) | callers outside the repo | ✓ listed as not visible | gateway logs; other repos when linked |
| **Jobs, schedulers, listeners, queues and events** | `@Scheduled`, `@KafkaListener`, topics | ◐ (listeners checked) | annotations, topic names, message types |
| **Data**: tables, columns, migrations, stored rows that now fail, caches, search indexes | `pets.birth_date`, a probe query, seed 0/13 | ✓ stored rows; ✗ migrations, caches | entities, Liquibase/Flyway, seed SQL, cache annotations |
| **Integrations**: payment, email/SMS, LLM, storage, outbound URLs | `MailService` → `templates/mail/*.html` | ✗ | outbound clients, template files |
| **Outputs people receive**: emails, notifications, exports, reports, PDFs | activation email, CSV export | ✗ | template engines, export endpoints |
| **Who can see or do it**: roles and permissions | `@PreAuthorize`, route `authorities: [Authority.ADMIN]` | ✗ | security annotations, route guards. Each case says which role to test with. |
| **Config, flags, environments** | an `application.yml` key, a feature flag, a profile, the external config repo | ◐ (config repo named as not visible) | property keys and readers, flag SDK reads |
| **Text and languages** | an i18n key changed or removed, per language | ✗ | `i18n/*/*.json`, `jhiTranslate`, `$t()` |
| **Dashboards, alerts, logs** | the Grafana latency panel now counts 400s | ✓ dashboards; ✗ alerts and logs | dashboards, alert rules, log statements |
| **Non-functional**: time zones, locales, performance, old clients, browsers | "today" judged in UTC | ◐ (UTC boundary only) | date formats; new queries without an index; CSS changes |
| **Deploy and release**: which services, in what order, migrations first, config to set | migration before code; a new property in prod | ✗ | changed modules, migrations, new property keys, docker/compose |
| **Dependency bumps**: which modules use the library, and its breaking changes | `295fa8d`: a chaos-monkey bump caused 405 on every POST/PUT | ✗ | pom / package.json diff → modules → their APIs and screens, plus the changelog link |

## 3. How to test it

| | today | how |
|---|---|---|
| DO / EXPECT, before vs after | ✓ for request rules | per delta kind |
| The input that exercises the change (boundaries, holes, null) | ✓ | per rule |
| The test data needed (which records, which state) | ◐ (probe SQL) | seed files, probes |
| Which role and which environment | ✗ | security facts, config |
| Existing automated tests to run (unit, integration, E2E) | ✗ (v1 had test mapping) | tests reaching the changed code; Cypress/Playwright specs visiting affected routes |
| Changed code that no test reaches | ✗ | the same mapping, inverted |

## 4. Around it

| | today |
|---|---|
| Skip, with proof | ✓ (only when everything the screen runs was read) |
| Not visible to Teslon, and how to close it | ✓ |
| Changed lines no rule explains (ledger) | ✓ |
| Who to ask: owners per service and page | ✗ in the new engine (v1 has it: port) |
| Effort estimate | ✗ in the new engine (v1 has it: port) |
| A build, not one PR: everything that changed since the last tested build | ✗ (a range works; the brief per build does not exist yet) |
| Overlap: two PRs in one build touching the same page | ✗ |
| Reverse lookup: "bug on `/checkout`, which recent change?" | ✗ (same graph, walked backwards) |

## 5. What you were missing

These were not on the list of page, functionality, module and API:

- **Roles.** The same page tested as the wrong user proves nothing.
- **Emails, notifications, exports.** People receive these outside the app.
- **Jobs and queues.** They change data with nobody on a page.
- **Old data.** Rows saved before the change that the new rules refuse.
- **Text.** A removed i18n key shows a raw key on screen.
- **Other clients.** A mobile app built against the old API.
- **Deploy order.** The migration must run before the code.
- **Dependency bumps.** 23 of the last 60 spm commits, and one of them broke every write.
- **Existing tests to rerun, and the gaps no test covers.**
- **The build, overlaps, and reverse lookup.** This is the QA's real unit of work.

## 6. Build order

Each step is gated on the bench: no silent misses, no wrong skips, and every
line re-read.

1. **Triage, plus "where" for all code.**
   - Docs/CI/tests → no app effect.
   - A changed Java method → endpoints → screens.
   - A changed front-end file → the screens that import it.
   - A dependency bump → its modules.

   After this, every PR gets at least module, API and page, with evidence.
2. **Official parsers and an Angular reader**: Vue compiler, `@angular/compiler`, the TypeScript type checker, lezer-promql.
3. **Response-shape delta.** Java JSON names → typed reads in templates. Target: the independent JHipster case from 0/6 to 6/6.
4. **Functionality names, modules, existing tests, owners and effort** (the last three ported from v1).
5. **Roles, i18n, config keys, Liquibase/Flyway changes**, each as a delta with its own cases.
6. **Jobs and queues, integrations, emails and exports, deploy notes.**
7. **The build brief, overlaps and reverse lookup.**
