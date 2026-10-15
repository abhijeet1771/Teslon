# Teslon roadmap

Settled after five pieces of evidence, not before them:

1. **A real repository.** On real commits from a Spring microservices app,
   today's engine found none of the six things a real PR affected; a prototype
   built on framework rules found all six, plus two its author never mentioned
   (`research/page-impact`).
2. **The field.** Ten ways a wrong or missing blast radius has shipped bugs —
   from GitHub, Google Cloud, CrowdStrike, Cloudflare, Knight Capital and
   practitioner communities (`research/FIELD-EVIDENCE.md`).
3. **The QA desk.** Twelve things a tester needs to finish a release without
   reading code (same file).
4. **A real ticket.** On a real bug ticket and its merged PR, QA was told 7 of
   the 11 things the merge changes. The 4 missed include a behaviour change on
   the create endpoint and an AI chat on every page that calls it
   (`research/ticket-gap`).
5. **A review of the plan itself.** Fifteen channels a change can travel
   through, five of them shown on the same repository with no rule in the
   plan, one draft claim disproved in a real browser before it was kept
   (`research/IMPACT-ATLAS.md`).

## The goal, in one sentence

For any pull request, merged commit or range, tell QA **where the change
lands and why**: pages down to the field, APIs, jobs, data, dashboards and
deployments, each with the conditions under which it shows and the result to
expect, and which it does not reach, with a reason. Every claim carries
evidence that checks itself, and everything Teslon could not see is said out
loud.

Views over the same analysis: a PR before merge, a merged ticket (what QA was
told vs what the merge reaches, `research/ticket-gap`), and a build-to-build
range.

The channels a change can travel through, and the honest boundary of
"100%", are in [`research/IMPACT-ATLAS.md`](research/IMPACT-ATLAS.md). Every
phase below is measured against it.

## Co-owner review, 2026-10-14: right destination, wrong order

**The destination holds.** No one gives QA the scope of a change as pages,
fields, data and dashboards with evidence. Test-selection tools (Launchable,
SeaLights, Datadog TIA) pick automated tests. Code-graph tools (Kythe, Glean,
Nx) list files. Our rules-not-guesses, evidence and never-silent discipline
is the moat, and it has caught three of our own wrong claims so far.

**The order is wrong.** The same real PR (spring-petclinic #559), shipped
product vs research prototype:

| | `packages/core` (what users run) | `research/` prototypes |
|---|---|---|
| Size | 7,060 lines, 120 tests, a UI | 844 lines of regex scripts |
| Radius | 127 files, 34 surfaces including vets and visits | 2 pages, 1 global widget, 2 fields, 1 reader page, 3 dashboard panels, 2 SQL probes |
| Tier 1 | **none**. The pet form is Tier 4, one of 95 | n/a. Each item carries a test and an expected result |
| AI chat path | not in the radius | found, with a 7-hop chain |

The review also found two product bugs on the way. `merged <from>..<to>`
crashed into git's usage text. Worse, a supplied range was **silently
ignored** for rebase merges, so the first run analysed only the last,
test-only commit. Both are fixed, with test E22.

Five problems, in order of risk:

1. **n = 1.** Everything is tuned on one PR in one repository. Phase A, the
   corpus, has been "first" since the roadmap was written and has not
   started.
2. **Two products.** Accuracy lives in research scripts. The product QA would
   run is noise on a real PR. Every week of research widens the gap.
3. **Scope ahead of proof.** Fifteen channels, a ticket view, connectors and
   motion design, before one stack works end to end.
4. **No user has used it.** We do not know whether field-level detail, SQL
   and dashboards are read, or skipped as too long.
5. **The word "100%".** Promised unconditionally, it fails the first time it
   matters. The promise is *no silent miss* plus *measured recall*.

### What replaces the pilot

There is no team repository. Instead there is a proving ground:
[`research/PROVING-GROUND.md`](research/PROVING-GROUND.md). It has 23 real
repositories chosen by measured channel coverage, and three sources of truth
that are not Teslon: real escapes from product histories, a published fault
benchmark, and a differential runtime oracle that runs the app before and
after an injected change.

## Co-owner review 2, 2026-10-15: static proposes, runtime proves

**What we want, in one line:** after a merge, QA gets the pages, sections and
fields to verify, with proof, and nothing that matters left out.

**The data a QA team really has.** The plan was built as if only the
repository exists. A team that tests merged tickets has more:

| Data | Who has it | What it can prove |
|---|---|---|
| The repository | always | why a page is reached; non-UI impact (jobs, data, dashboards); works before merge |
| Ticket and PR text | usually | what QA was told (the gap view) |
| **A running environment before and after the deploy** (staging, QA, preview) | **every team that tests merged tickets — that is where QA tests** | what actually changed on each page, against the real backend |
| Test accounts per role | QA | the same, under each role |

**Where the market already is** (checked, not assumed):

| Tool | What it does | What it cannot do |
|---|---|---|
| [Meticulous](https://meticulous.ai/how-it-works) | Replays recorded sessions on each PR and diffs screenshots and behaviour | By default it answers requests **from recordings**: the backend is mocked. A backend-only change such as #559 or the JSON rename does not reach the replay, unless its schema patching happens to track that API's shape |
| [Chromatic TurboSnap](https://www.chromatic.com/docs/turbosnap/setup) | Re-tests only Storybook stories whose files the bundler graph says changed | Components in isolation; no backend, no pages, no data |
| LLM "affected areas" reports ([example](https://www.index.dev/blog/ai-qa-pull-request-impact-analysis)) | Reads the diff and guesses routes | No evidence, no measured accuracy |
| Launchable, SeaLights, Datadog TIA | Pick automated tests | Not pages, not manual QA |

**The better option.** Our oracle diffs the app against the **real backend**,
before and after. That is the one thing none of them do, and it is exactly the
case where QA gets burned: a backend change that shows up on a page. It
should not stay a test harness. It should become the product's second mode:

| | **Explain** (static) | **Verify** (runtime) |
|---|---|---|
| When | Before merge, or no environment | Around the staging deploy — QA's real moment |
| Answers | Which pages, why, through which rules; jobs, data, dashboards, K2/K3 | Which pages actually changed, shown as before/after |
| Evidence | file:line chains | DOM, field, call and status diffs, screenshots |
| Weak at | Precision on the long tail of frameworks | Pages it did not reach; data that is not there; roles not logged in; anything not on a page |

**Together they cover each other's gaps.** Explain proposes the candidate
pages, the roles, the data to seed and the inputs to try. The inputs come
from the delta: a future date for `@PastOrPresent`, three spaces for
`@Size(min = 1)`. Verify proves or rejects each candidate on the real app.
Anything Verify cannot observe stays in the report as "unverified", with the
reason.

This changes three things:

1. Static precision on pages stops being the bottleneck: over-selection is
   pruned by observation. Static **recall** becomes the thing to protect,
   because a page Explain never proposes is a page Verify is never directed
   to.
2. Rule packs are judged by what they make observable, not only by what they
   claim, so they can be built cheaper and in a different order.
3. The 18-mutation catalogue becomes product input generation, not only test
   data.

**What it costs, said up front:**

- An environment and role accounts: QA has these.
- A snapshot taken before the deploy: one hook, or QA presses a button.
- Write probes are never run on shared staging. Save-unchanged writes, so it
  runs only on an ephemeral or sandbox environment, and is read-only
  everywhere else.
- Crawl time on big apps: directed by Explain, plus a sampled sweep for
  safety.

**What does not change:** the goal, the non-negotiables, no silent misses,
and stage 0. Verify needs a scorer too. It is scored against an *exhaustive*
crawl (every role, rich seed, every route), never against itself.

**On LLMs:** never for claims. They are allowed for things that can be
checked or that are only wording: mapping ticket text to surfaces (confirmed
by the person), wording the brief, and drafting new rule packs offline that
then have to pass the oracle. Code leaves the machine only with a local model
or explicit opt-in.

## Implementation order

Six principles decide the order:

1. Truth before rules, so nothing is tuned to one PR.
   Two modes, one truth: Explain proposes, Verify proves (review 2).
2. An oracle independent of the engine, so grading is never circular.
3. The model before the rules, so precision and never-silent are structural.
4. Rules in the order the scorer says they are missed, not by taste.
5. A rule passes only if it works on all three frontends of the same twin.
6. Outputs and polish last.

| Stage | Build | Why here | Gate |
|---|---|---|---|
| **0. Truth** | Case format, scorer and runner (`packages/bench`); seed with #559, the 22 TrainTicket faults and 10 historical escapes; baseline the product and the prototypes | Every later choice is made by measured misses | Baseline numbers in the repo |
| **1. Oracle → Verify mode** | Build and run the twins at any ref (H2, no Docker), crawl every route per role with Playwright, record DOM, fields, calls, statuses and screenshots; 6 of the 18 mutation codemods first (rule tightening, JSON rename, enum value, route rename, role change, config key rename). The same crawler, pointed at two URLs (staging before and after a deploy), is the product's **Verify** mode: read-only by default, write probes only in a sandbox | The only unlimited source of hard cases, the riskiest assumption, and the one capability no tool on the market has (real backend, before and after) | ≥ 30 auto-labelled cases across ≥ 3 twins. **Spike passed:** 1 case, 6-page truth in 96 s, 0 noise, product 0/6 (`research/oracle`) |
| **2. Engine model** | Construct, Delta, Edge (rule, evidence, strength), Surface (kind, parent, conditions), Claim (affected / not affected with reason / unknown with resolver, K-class); evidence verifier; channel inventory feeding NOT MODELLED; surface-first report; file-graph signals demoted to *look* | Fixes the 127-files failure by construction; every rule plugs into it | #559 reproduces the prototype's result inside `packages/core` |
| **3. Delta extraction** | Java (java-parser CST), TS/Vue/Angular templates (TypeScript, Vue and Angular compilers), YAML/properties keys, Liquibase/Flyway changesets, manifest versions → typed deltas | Precision comes from the kind of change | Every mutation in the catalogue yields the right delta kind |
| **4. Rule packs** (Explain, and the proposer for Verify), each with real positive and negative fixtures; judged by recall first, because a page never proposed is never verified | 4.1 Spring web + contracts (2, 5) → 4.2 UI: routers, sections, fields, client guards, journeys, shared components (13) → 4.3 Data (8) → 4.4 Security and roles as conditions (14) → 4.5 Config and the external config repo (10) → 4.6 Async, resilience, caches (6, 7, 9) → 4.7 Observability, deps, deploy (15, 11, 12) | Starts where field escapes cluster and most repos have the channel; re-ordered weekly by the scorer | After 4.3: K1 recall ≥ 90% on L1 + L2, **0 silent misses**, over-selection ≤ 1.5× the truth, 100% valid evidence, no K3 claimed as proven |
| **5. Directed verification** | Explain drives Verify: candidate pages, roles, seed data and delta-derived inputs (future date for `@PastOrPresent`, spaces for `@Size(min = 1)`); everything not observable stays *unverified* with the reason | Joins the two modes | On L1: Verify(directed) finds ≥ 95% of what an exhaustive crawl finds, in ≤ 20% of its time |
| **6. QA outputs** | Brief per change: page → section → field → test → expected result; not affected with reasons; K2/K3 lists; PR comment; UI v2 | Polish only on top of measured accuracy | A tester can work from the brief alone on 10 L1 cases |
| **7. Across repos** | Contracts across repositories (petclinic-rest ↔ angular/react, fineract ↔ web-app, the mall trio), then the config repo | The second-commonest blind spot in the atlas | L3 cross-repo cases pass |
| **8. More stacks** | GraphQL + Python (saleor), Next.js (cal.com), .NET (eShop), gRPC (microservices-demo) | Already measured; they bring feature flags and analytics | Their cases pass |

**Recall on real history** (L3) is the last gate of each stage after 4: ≥ 80%
on modelled channels, and every miss traced to a channel becomes the next rule.

**Not now:** new stacks before stage 8, connectors before stage 7, UI work
before stage 6, more channels on paper.

## Non-negotiables

1. **Rules, not guesses.** Every hop names the rule that made it — compiler,
   framework, contract, build, data or config — with `file:line`. A heuristic
   hop is labelled as one, and a chain is only as strong as its weakest hop.
2. **Evidence verifies itself.** Every cited line is re-read from git when the
   report is built. A line that no longer matches is shown as unverified, never
   quoted as proof.
3. **Never silent.** Every changed construct is claimed by a rule or listed as
   unmodelled. Every consumer call site resolves or is listed as unresolved.
   Every failed fetch or parse is reported. (The prototype broke this rule once,
   by swallowing a network error; that is how the rule was written.)
4. **Direction-aware.** A request rule reaches writers, a response change reaches
   readers, a behaviour change reaches all callers, a dependency reaches its
   deployable. Precision comes from this, not from dropping things.
5. **QA's language.** Pages, features and what to try — files are the appendix.
6. **Local.** Code never leaves the machine.

## Architecture: a typed impact graph

```
change capture    git: PR · merged commit · build-to-build range
       │          hunks → changed constructs (symbols, annotations, config keys,
       │          migrations, dependencies, flags) on compiler-grade parsers
       ▼
change kinds      request contract · response contract · behaviour · schema ·
       │          constraint · dependency · config · flag · shared UI ·
       │          observable behaviour (status codes, ordering, error text)
       ▼
graph builders    code      compiler-grade references, method level
(adapters, each   framework Spring MVC, Bean Validation, Spring Data JPA,
 with a              Spring Cloud Gateway, Feign/WebClient/RestClient/RestTemplate,
 conformance         Spring AI, @Value/@ConfigurationProperties; Express, NestJS;
 suite)              React Router, Next.js, Angular, AngularJS, Vue Router
                  contract  providers ↔ consumers, template unification,
                            gateway algebra, OpenAPI/GraphQL where present
                  data      Flyway/Liquibase/SQL ↔ entities ↔ queries
                  build     Maven/Gradle/npm, registry metadata, deployables
                  config    keys, profiles, external config repos, flags
       ▼
propagation       by change kind and direction; evidence chain per item;
       │          strength = weakest hop
       ▼
projection        pages · features (global widgets, AI tools, jobs) · APIs ·
       │          data checks · deploy order · owners · residue
       ▼
outputs           test brief per PR and per build · not-affected-and-why ·
                  overlap across PRs in a build · reverse lookup for triage ·
                  PR comment · Jira · local app · CI gate · JSON
```

## What "100%" means here, and how it is earned

- **Evidence: 100%, enforced by machine.** Every quoted line is verified against
  git at report time.
- **Recall: earned per failure pattern, never assumed.** A labelled corpus of
  real cases — at least three per pattern, at least four repositories, plus
  developer-confirmed fixes ("fixes the regression introduced in #…") and
  negative controls. A pattern is called *supported* only when Teslon misses
  nothing in its corpus cases; until then, reports say *partial support*.
- **Silent failures: zero.** Counted by the harness on every run.
- **Escapes feed the corpus.** When a bug escapes, QA marks it; Teslon checks
  whether it was in the radius, and if not, which rule missed. The case becomes
  a regression test.
- **What no static tool can settle is named on every report:** paths decided at
  runtime (an AI choosing a tool, a flag evaluated in production), consumers
  outside the repositories Teslon can read, production data contents (Teslon
  gives the queries, not the answers), and configuration it cannot reach.

## Phases

Superseded by [Implementation order](#implementation-order). The earlier
A–F phases folded into its stages: A → 0, B → 2–4.3, C → 6, D → 4.4–4.7,
D2 → 7, E → 8, F → 5.
