# Proving ground

There is no team repository to pilot on, so Teslon gets a proving ground
instead: real repositories chosen to be as hard as possible, and ground truth
that does **not** come from Teslon's own rules. A tool graded by its own logic
proves nothing.

## What every piece of R&D so far says, in one table

| # | Finding | Source | Consequence for the build |
|---|---|---|---|
| 1 | Framework rules find what graphs miss: 0/6 → 6/6 on a real PR | `research/page-impact` | The engine is rules over typed constructs, not a file graph |
| 2 | Precision comes from the *kind* of change and its direction | `page-impact/run.mjs` | Deltas are typed before anything propagates |
| 3 | Page → section → field → API → data → dashboard joins on keys the frameworks define | `research/field-chain` | Surfaces are first-class, down to the field |
| 4 | A claim about runtime UI behaviour was false until it was run | `research/form-guard` | A runtime confirmer is part of the system, not an extra |
| 5 | Coverage is safe but imprecise: 100% safety, 26.6% precision | V8 experiment | Runtime evidence confirms; it does not select |
| 6 | Field escapes cluster in contracts, schema, config, deps and shared UI | `FIELD-EVIDENCE.md` | Those rule packs come first |
| 7 | Some impacts cannot be decided before running | `IMPACT-ATLAS.md` (K3) | Honesty is scored: a K3 impact claimed as proven is a failure |
| 8 | The product on a real PR: 127 files, nothing in Tier 1 | co-owner review | Port, and demote heuristic signals |
| 9 | Six of our own wrong claims, each from a shortcut: name join, regex over comments, string literals, a swallowed error, an unrun claim, an ignored range | this repo's history | Every rule ships with a positive **and** a negative fixture from a real repo |

## The repositories, chosen by measurement

`research/corpus/inventory.mjs` measured 30 candidates against the atlas's
channels in 38 seconds. The full matrix is in
[`corpus/inventory-2026-10-14.tsv`](corpus/inventory-2026-10-14.tsv). The
set below exercises every channel, most of them in at least ten repos.

### L1. Controlled twins — the mutation lab

The same domain model behind different frontends and topologies, so one
injected change tests whether a rule generalises or only fits one shape.

| Family | Repos | Why it is hard |
|---|---|---|
| JHipster 9.4 | `jhipster-sample-app` (Angular), `-react`, `-vuejs`, `-gateway`, `-microservice` | One backend, three UI stacks, a gateway topology; Liquibase, Bean Validation, i18n, security, Cypress suites (27–94 files) |
| Spring Petclinic | `spring-petclinic-microservices`, `-rest`, `-angular`, `-reactjs` | **Cross-repository**: the REST API and its two frontends live in different repositories; gateway, discovery, AI tools, Grafana |

### L2. A fault benchmark with documented symptoms

[TrainTicket](https://github.com/FudanSELab/train-ticket) (Zhou et al., IEEE
TSE) replicates 22 faults from an industrial survey on 41 services, one
branch each in
[train-ticket-fault-replicate](https://github.com/FudanSELab/train-ticket-fault-replicate).
They split by what a static tool can honestly claim:

| Must be **found** (K1) | Must be **declared, never claimed** (K3) |
|---|---|
| F18 `getFood` returns null for trains without food → UI · F19 French price format on consign · F20 shared-library enum of order status · F21 aria label in login · F22 wrong column in a SQL select · F15 nginx JSON size limit · F9 LTR→RTL in the login block · F11 two services write the same column | F1 async event order on cancel · F2 reservation results in wrong order · F3 JVM vs Docker memory · F4 SSL latency · F5 thread-pool timeout · F12 lock and pool status · F13 queue · F17 slow nested select |

**The branches are tangled**, which is what the impact-analysis literature
warns about (ALEXANDRIA, FSE 2024). Measured against master, each fault
branch changes 45 to 140 files, mostly logging aspects (`HttpAspect.java`)
added for tracing studies. F19 touches 75 files; the fault itself is a price
format. So a TrainTicket case is the fault's hunks alone, re-applied to
master by hand, with the README's symptom as the truth. Using the raw branch
diff would grade Teslon against noise.

### L3. Real escapes from real products

Revert and regression commits are where a change already broke something
somewhere else. Counted with `git log` on full histories:

| Repo | Commits | Reverts | "regression / caused by" | Stack |
|---|---|---|---|---|
| apache/ofbiz-framework | 30,507 | 484 | 388 | Java, XML-configured screens and entities — the hardest config-as-code case |
| openmrs/openmrs-core | 13,291 | 189 | 71 | Java, Hibernate, modules |
| thingsboard/thingsboard | 28,747 | 183 | 19 | Java + Angular, rule engine, Kafka, 4,800 UI files |
| keycloak/keycloak | 32,568 | 97 | 85 | Java + React admin, themes |
| apache/fineract + openMF/web-app | 11,465 + 2,919 | 52 + 10 | 36 + 15 | Banking API and its Angular UI, **in separate repos** |
| halo-dev/halo | 6,358 | 10 | 116 | Java + Vue |

Examples of what is in there: halo #6153 fixes *style issues caused by
changing the order of CSS imports* in #6152, a pure CSS-order coupling.
Keycloak #51985 is a *regression in the UI* traced to one line in the admin
client's `decode.ts`. Labelling takes a person reading the fix, the issue and
the change that caused it. Budget about 20 minutes a case.

### L4. Scale and noise — no labels, only invariants

`ruoyi-vue-pro` (7,250 files, 818 `@Transactional`, permission guards
everywhere), `JeecgBoot` (forms built at runtime from the database, which must
come out as K2, never as "not affected"), and the `mall` trio (backend, admin
UI and microservices in three repositories). These check speed, the noise
ceiling and never-silent, not recall.

### Later stacks, already measured

`saleor` + `saleor-dashboard` (GraphQL across repos, feature flags), `cal.com`
(Next.js monorepo, flags, analytics), `dotnet/eShop` (integration events),
`microservices-demo` (gRPC, five languages). Feature flags appear in only two
of the Java-set repos, and these fill that gap when their stacks are added.

## Three oracles, none of them Teslon

| Oracle | How truth is produced | Strength | Cost |
|---|---|---|---|
| **History** (L3) | A person labels where a real regression showed up, from the fix, the issue and the inducing change (SZZ) | Real escapes, the strongest evidence there is | About 20 min a case |
| **Documented faults** (L2) | The benchmark's own fault descriptions name the symptom | Independent, published | Fixed set of 22 |
| **Differential runtime** (L1) | Apply a typed mutation, run the app before and after, crawl every route with Playwright, and diff each page's DOM, network calls and status codes. Also run the repo's own e2e suite. | Unlimited cases, independent of Teslon's rules | Machine time only |

**The third has been proven here, not just proposed.** One mutation on the
JHipster twin (`@JsonProperty("title")` on `BankAccount.name`) produced a
6-page truth in 96 seconds, including a cross-entity dropdown and a disabled
Save, with 0 noise. The product found 0 of the 6 pages. Details and the five
things the spike taught the oracle are in [`oracle/README.md`](oracle/README.md).

The third is how the hardest scenarios are generated on demand. Each mutation
template is a codemod with an AST anchor, applied wherever its pattern occurs
across the twins:

| # | Mutation | Channel | Why it is hard |
|---|---|---|---|
| 1 | Tighten a DTO rule (`@Size`, `@Pattern`, `@PastOrPresent`) | 5, 8 | Direction; existing rows lock out; client guards decide reachability |
| 2 | Rename a JSON property (`@JsonProperty`) | 5 | Consumers get `undefined`, not an error |
| 3 | Add an enum value | 5 | Exhaustive switches and `<select>` options elsewhere |
| 4 | Change a response field's type or nullability | 5, 13 | Formatting and pipes in the UI |
| 5 | Change default page size or sort | 4 | Every list silently differs |
| 6 | Remove `@Transactional` | 3, 8 | Partial writes only under failure |
| 7 | Liquibase: nullable, length, new not-null column | 8 | Running code against the new schema |
| 8 | Rename a route path | 13 | Links, redirects, journeys, bookmarks |
| 9 | Change a shared component's default prop | 13 | Every instance, every page |
| 10 | Reorder global CSS imports | 13 | halo #6153, from real life |
| 11 | Rename an i18n key | 13 | Missing text in one locale only |
| 12 | Change a role in `@PreAuthorize` or a route guard | 14 | Visible for one role, gone for another |
| 13 | Rename a config key | 10 | The binding falls back to its default silently |
| 14 | Change a gateway `StripPrefix` or client base URL | 5 | Every call through it |
| 15 | Rename a timed controller method | 15 | A dashboard panel goes flat |
| 16 | Add `required` / `max` to a form input | 13 | A server rule becomes unreachable from the page |
| 17 | Change a fallback's return value | 7 | A failure is masked as empty data |
| 18 | Bump a dependency minor version | 11 | Behaviour moves with no source line |

## Scoring

Per case, per channel, per layer:

- **Recall:** truth items found, by surface.
- **Over-selection:** surfaces claimed that the truth does not contain. This is
  scored, because 127 files is a failure even when the right file is among
  them.
- **Silent misses:** truth items in a channel that was neither propagated nor
  declared. **Target 0, always.**
- **Evidence validity:** every cited line re-read from git.
- **Honesty:** a K3 item claimed as K1 is a failure, even if it is "right".
