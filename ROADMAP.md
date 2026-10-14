# Teslon roadmap

Settled after four pieces of evidence, not before them:

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

## The goal, in one sentence

When a ticket is done and its PR is merged, QA is told "test X, Y, Z" by
someone who wrote the change from memory. Teslon closes the gap between
**what QA was told and what the merge actually reaches**: confirmed, missed
(with evidence), told-but-not-merged (a missing PR), and not affected (with
the reason).

The ticket is the primary unit; a PR before merge and a build-to-build range
are the same analysis over a different set of commits. Underneath, for any of
them, tell QA which
**pages, features, APIs, data and deployments** it affects — and which it does
not — with every claim backed by evidence that checks itself, and everything
Teslon could not see said out loud.

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

| Phase | What | Done when |
|---|---|---|
| **A. Corpus and harness** | Labelled real cases seeded from the ten patterns; a scorer for recall, precision, evidence correctness and silent failures; a baseline for today's engine | Baseline numbers per pattern are published in the repo |
| **B. Spring + JS SPA slice** | The prototype's rules move into `packages/core` on compiler-grade parsing. Patterns first: contracts (1), schema vs running code (2), dependencies (4), shared UI (7) | No misses on those patterns' corpus cases; evidence self-verified; zero silent failures |
| **C. QA outputs** | **Ticket gap report** (told vs true, linked by issue key in commits, branch and PR, with a stated fallback when the key is missing); test brief per PR and per build, not-affected-and-why, data checks, deploy notes, overlap, reverse lookup, owners; PR comment, Jira, local app | A release on the test bed can be run from Teslon's output alone |
| **D. The harder patterns** | Config and generated data (3), flags and dead code (5), deploy order (6), observable behaviour (8), unexercised paths (10) | No misses on those patterns' corpus cases |
| **E. More stacks** | Next.js, React, Node/Nest, GraphQL; consumers outside the repo through a contract registry | Corpus cases from those stacks pass |
| **F. Runtime proof (optional)** | Coverage for a *proven* band beside the *reachable* one | Opt-in, never required |
