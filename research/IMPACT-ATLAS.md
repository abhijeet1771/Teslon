# Impact atlas

Every way a change in one place can break something somewhere else, what
Teslon does about each today, and the honest boundary of "100%".

Written as a review of [`ROADMAP.md`](../ROADMAP.md). The roadmap's direction
holds — typed deltas, framework rules, direction-aware propagation, evidence
that checks itself. But it models **where** an impact lands and very little
of **when, for whom, and how you would notice**. That is where escaped bugs
live.

## The review started with our own output

The ticket report for spring-petclinic #558 listed `/owners/details/:ownerId`
under *no path found*. On the data, that is right: a request rule cannot
change what a read returns. On the journey, it is wrong. A successful save
on the pet form navigates there (`PetFormPage.js:62`,
`router.push('/owners/details/…')`), and a save that now gets a 400 never
arrives. The page itself did not change, but a QA engineer walking the flow
will find it. A page list without journeys is not the whole answer.

Four more couplings from the **same repository** that no part of the plan
models:

| # | Coupling | Evidence | What breaks, and where |
|---|---|---|---|
| 1 | **Failure masked by a fallback** | `ApiGatewayController.java:60-61`: `cb.run(it, throwable -> emptyVisitsForPets())` | Any change that makes visits-service fail or exceed the 10 s limit (`ApiGatewayApplication.java:88`) does not error. `/owners/details/:ownerId` loads and shows **no visits**. The break is real, and every check that looks for errors misses it. |
| 2 | **Cache between a change and its page** | `VetResource.java:45`: `@Cacheable("vets")` | A change to vet data or to the vet shape appears on `/vets` only after the cache is evicted or the service restarts. Test it straight after a deploy and you test the old behaviour. |
| 3 | **A dashboard keyed on a method name** | `PetResource.java:37` `@Timed("petclinic.pet")` + `MetricConfig.java:19` `TimedAspect` → `grafana-petclinic-dashboard.json:449` `petclinic_pet_seconds_count{method="processCreationForm"}` (panel *Pets Created*) | Renaming `processCreationForm` is a refactor the compiler approves. The *Pets Created* panel silently drops to zero. |
| 4 | **Configuration in another repository** | config-server `application.yml:6-7`: `git: uri: https://github.com/spring-petclinic/spring-petclinic-microservices-config` | Every service's runtime properties live in a repo this analysis never reads. A PR in either repo can change behaviour the other one depends on. |

And one that shows the granularity QA actually needs. It also caught this
review out.

The first draft of this section read: "Add Pet, Name = three spaces: it
passes the browser's `required` check, reaches the server as `""`, and now
gets a 400." That claim was **run in a real browser** before keeping it,
using the page's own bindings on the Vue version the app ships (3.5.17,
`research/form-guard/`). It is false:

| Input on the Add Pet form | Reaches the server? | Why |
|---|---|---|
| Name = three spaces | **No**, whether you click Submit or press Enter | `v-model.trim` (`PetFormPage.js:99`) rewrites the field to `""` on `change`, and `required` plus `reportValidity()` (line 45) then block the submit |
| Birth date = 2030-01-01 | **Yes** | `type="date"` with no `max` (line 105). The new 400 is reachable from the form. |

So the empty-name rule that #559 newly enforces on create is **unreachable
from the form** and **reachable from the API and from the AI chat**. Its
`addPetToOwner` tool takes a `PetRequest` filled in by the model
(`PetclinicTools.java:71`). The checks QA needs:

- Add Pet form: birth date in the future → expect rejection where it used to
  save.
- AI chat: "add a pet with no name" → expect a refusal sentence, not an
  exception.
- Do not test the empty name on the form. The browser stops it before the
  change matters.

That is entry point → field → input class → expected result, and **client-side
guards are a channel of their own**. They decide which of a rule's entry
points can actually reach it. The plan stops at "page", and the draft that
skipped running the claim would have sent QA to test the wrong entry point.

## The channels

Fifteen channels, grouped by how the coupling travels. Status: **have** (in
`packages/core`), **proto** (proven in `research/`), **plan** (named in the
roadmap), **missing** (in neither).

### Inside one program

| Channel | Ways it breaks elsewhere | Rule that finds it | Status |
|---|---|---|---|
| **1. Code** | Callers of a changed function, overrides, interface dispatch, default methods, generics, shared constants, base classes | Compiler-grade references, method level (SCIP / javac / tsc), not imports | have (file-level imports, dispatch); method level **plan** |
| **2. Framework wiring** | DI by type/name, `@Primary`, `@Conditional*`, `@Profile`; **AOP pointcuts matched by pattern**, so renaming a method can switch an aspect on or off; filters and interceptors by path; `@ControllerAdvice`; global Jackson config; React context and providers; Angular DI | Per-framework adapters that evaluate the framework's own rules | proto (Spring MVC, validation, AI tools); AOP, filters and advice **missing** |
| **3. Cross-cutting annotations** | `@Transactional` boundaries, `@Cacheable`/`@CacheEvict`, `@Async`, `@Retryable`, `@Scheduled`, `@EventListener`, `@PreAuthorize`, `@Timed` | Annotation semantics as typed edges | have (`@Transactional` as a factor only); rest **missing** |
| **4. Observable behaviour** | Same signature, different behaviour: ordering, rounding, time zone, null vs empty, exception type, error text, status code, default page size, idempotency | Semantic delta from AST diff (the delta *is* the change kind) | proto (status code via validation); rest **plan** |

### Between programs

| Channel | Ways it breaks elsewhere | Rule that finds it | Status |
|---|---|---|---|
| **5. Synchronous contracts** | REST, GraphQL, gRPC; gateway rewrites; discovery; generated clients; **a new enum value breaks an exhaustive consumer**; headers; error bodies | Provider ↔ consumer unification, direction-aware | proto |
| **6. Async contracts** | Kafka, RabbitMQ, SQS topics; event schemas; consumers in other services; **messages already in flight when the new code deploys**; retries and DLQs; cron jobs | Topic and schema matching; schema-registry compatibility rules | **missing** |
| **7. Resilience** | Fallbacks, circuit breakers, timeouts, catch-and-default: **a break turns into empty data instead of an error** | Find every fallback on the path and attach "verify the data, not the absence of an error" | **missing** (finding 1) |

### Data and state

| Channel | Ways it breaks elsewhere | Rule that finds it | Status |
|---|---|---|---|
| **8. Data** | Migrations; ORM mapping; lazy vs eager loading; cascades; **existing rows against new rules**; tables shared across services; views, triggers, procedures; search-index mappings; ETL and BI reading a column | Migration ↔ entity ↔ query graph; constraint × existing data → SQL probe | proto (constraint → SQL); rest **plan** |
| **9. Caches and client state** | Server caches (finding 2); CDN; service workers; `localStorage` keys and cookies read by old code; **browser tabs still running yesterday's bundle** | Cache annotations and keys; storage-key matching across versions | **missing** |

### Configuration, build and runtime

| Channel | Ways it breaks elsewhere | Rule that finds it | Status |
|---|---|---|---|
| **10. Config and flags** | Property keys and profiles; env vars; **config in another repo** (finding 4); flag defaults and flag combinations; build-time env | Key ↔ reader graph; flag ↔ branch graph | **plan**, without the external repo |
| **11. Dependencies and runtime** | Direct and transitive versions; framework skew; JDK/Node version; base image; polyfills and browser targets; CDN scripts | Lockfile and registry metadata; runtime-version matrix | have (lockfile); proto (skew) |
| **12. Build and deploy** | Bundler config, code splitting, tree-shaking side effects; Dockerfile, compose and k8s health checks; **deploy order, mixed versions during rollout, migration before code, rollback safety**; old mobile app versions in the field | Deployable graph; compatibility check of N against N-1 | deploy order **plan**; mixed versions and old clients **missing** |

### What people see, and who else is watching

| Channel | Ways it breaks elsewhere | Rule that finds it | Status |
|---|---|---|---|
| **13. UI composition** | **Client-side guards** (`required`, `max`, `.trim`, disabled buttons) that decide whether a server rule is reachable from the page; shared components (every instance); **global CSS and cascade**; design tokens; layouts and slots; store shape and selectors; router guards and redirects; **navigation journeys** (finding 0); i18n keys and text length; accessibility | Component instance tree, CSS selector ↔ template matching, navigation edges | proto (routes, global widgets); CSS, journeys and store **missing** |
| **14. Security and access** | Auth rules; roles per page; CORS; CSP; cookie flags; rate limits | Security-config adapters; role × route matrix | **missing** |
| **15. Watchers outside the code path** | Dashboards and alerts on metric names (finding 3); log formats parsed by alerts; analytics events; SEO tags and sitemaps; emails, PDFs and CSV exports whose shape customers depend on; webhooks to partners; **other repositories** consuming the API or package | Name rules (Micrometer, log patterns) plus connectors to other repos and registries | **missing** |

## "Where" has four dimensions, not one

The plan answers *which surface*. A QA engineer needs all four:

1. **Surface, down to the field:** app → page → section/component instance →
   control (field, button) → API → job → data → artifact (email, export) →
   dashboard. Template bindings (`v-model="pet.birthDate"` → *Birth date*,
   `PetFormPage.js:105`) give the field by rule.
2. **Condition:** role, flag state, tenant, locale, device or browser, data
   state ("pets whose birth date is in the future"), time (month end, DST),
   environment profile. An impact that appears only for admins with flag X on
   will not be found by someone logged in as a normal user.
3. **Time:** during the rollout (mixed versions), right after deploy (caches),
   on the next cron run, for clients that never update.
4. **Who notices:** the page user, another service, a partner, a dashboard
   or alert, a data team.

Each check also needs an **entry point that can actually reach it** (the form
blocks an empty name, the API and the chat do not) and an **expected result**, derived from the delta (before:
saved; after: 400). "Test the Add Pet page" is a hint. "Add Pet, birth date
2030-01-01, expect rejection where it used to save" is a test.

## Can it be 100%?

Not for every change, from code alone. That is a theorem (Rice), not a
limitation of effort. Any non-trivial question about what a program *does* is
undecidable in general, and some impacts depend on facts that are not in the
repository at all. A tool that promises 100% unconditionally is lying, and
QA will learn that on the day it matters.

What *can* be guaranteed is a three-way split:

| Class | What it covers | Guarantee |
|---|---|---|
| **K1. Provable from the repository by rule** | Channels 1–5, 8, 10–11, 13 in-repo, most of 14 | Every claim carries a proof chain re-verified against git. Recall is **measured** on a corpus of real bug-introducing changes, with a target of no misses per channel. |
| **K2. Provable with facts from outside** | Other repos, the config repo, flag-service state, production rows, production traces, deployed app versions, live dashboards | With a connector it becomes K1. Without one, it is listed as **"unchecked — connect X"**, scoped to the exact constructs that need it. |
| **K3. Undecidable before running** | Performance under load, races, timing, third-party behaviour, `eval` and reflection over runtime strings | Never claimed. Declared with a targeted watch ("a failure here is masked by the fallback at `ApiGatewayController.java:61` — check the visits list is not empty"). |

The promise this supports, and the only honest form of "100%":

> **No silent miss.** Every changed construct, crossed with every channel it
> takes part in, is either propagated by a named rule or listed as unknown,
> with what would resolve it. Every claim has evidence that checks itself.
> "Not affected" is said only with a reason as strong as an "affected".

Two engineering consequences:

- **Channel inventory per repository.** Before analysing any PR, detect which
  channels the repository actually uses (Kafka? Feign? a config repo? Grafana
  dashboards? AOP?). A changed construct in a channel with no rule becomes
  K2/K3 automatically, so missing coverage can never read as "no impact".
- **Precision, or the whole thing is useless.** "Changed a date utility, test
  everything" is technically complete and practically worthless. The lever is
  **delta slicing**: carry *what* changed (only the `de` locale branch, only
  inputs below zero) along each edge, and keep only callers whose inputs can
  reach the changed branch. Directed incremental symbolic execution (DiSE) and
  differential symbolic execution do this inside one program. Doing it across
  services, frameworks and the UI is the invention.

## Changes to the plan

1. **Primary unit:** any PR, merged commit or range. The ticket view is one
   output, not the engine.
2. **Phase A corpus by channel:** at least three real cases for each of the
   fifteen channels, seeded by SZZ (bug-introducing change → where the bug
   showed up). Recall is reported per channel, and channels with no cases yet
   are reported as untested.
3. **Phase B adds** a channel inventory, journeys (navigation edges), field
   granularity (template bindings), expected results from the delta, and
   resilience masking (channel 7).
4. **New phase, K2 connectors:** other repos and the config repo first (both
   are git, so no new trust needed), then flag service, schema registry,
   OpenTelemetry traces, and a read-only production replica for data probes.
5. **Conditions** (role, flag, locale, data state) become part of every
   surface claim, starting with roles (`@PreAuthorize`, route guards) and flags.
6. **Time:** an N vs N−1 compatibility check for contracts, messages and
   schemas, covering mixed versions during rollout, in-flight messages and old
   clients.
7. **Cross-PR:** two PRs that are each fine can break together. Run overlap
   on deltas, not files.
