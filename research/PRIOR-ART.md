# Is the engine enough for QA, and what can we reuse?

2026-10-23. Two questions: does the engine cover what a QA lead meets every
day, and what existing tech, papers and repos should it borrow from or use.

## 1. Measured: what real PRs look like

The engine was run on the last 60 commits of spring-petclinic-microservices
`main`, one commit at a time.

| kind of change (by the most runtime-relevant file it touches) | commits | engine today |
|---|---|---|
| docs (README, badges, images) | 7 | NOT MODELLED |
| CI and dev tooling (`.github/`, devcontainer, Maven wrapper) | 8 | NOT MODELLED |
| tests only | 2 | test-only ✓ |
| dependency and platform bumps (`pom.xml`, Spring Boot / Cloud) | 23 | NOT MODELLED |
| deployment, config and database (docker-compose, scripts, `application.yml`, MySQL version) | 8 | NOT MODELLED |
| Java code | 10 | **2 modelled** (the #559 commits), 8 NOT MODELLED |
| front end | 2 | NOT MODELLED |

**3 of 60 commits** produced a behaviour change. All the others were reported
honestly as NOT MODELLED, so nothing was missed silently. But a QA lead would
get "not modelled" on 19 PRs out of 20.

What a QA lead needs from every PR, in order:

1. **Does it touch the running app at all?** 17 of 60 do not (docs, CI,
   tests). Today these show as NOT MODELLED, which is noise.
2. **Where should I look?** This is the screens, APIs and jobs that the
   changed code reaches, with the path as evidence. Today this is missing for
   43 of 60.
3. **What exactly do I do there?** This is the field, the value and the
   expected result. Today it exists for one kind of change only (request
   rules). It is deep, but it is narrow.

One commit in the list is the strongest argument for (2):
`295fa8d Fix 405 errors from api-gateway by upgrading chaos-monkey`. A
dependency bump broke every POST and PUT through the gateway, and the fix was
another bump. Dependency bumps are 23 of 60, and they are not safe to skip.

## 2. What already exists

| need | existing tech | what it gives | use it how |
|---|---|---|---|
| changed code → routes / APIs | [naeemdadi/impact-analysis](https://github.com/naeemdadi/impact-analysis) (MIT, JS/TS, early) | The import graph decides reachability, with adapters for Next.js, React Router, Remix, Express and tRPC. A role policy keeps shared UI and config from flagging every flow. AI only phrases scenarios, which must cite hunk ids. | Same philosophy as ours: confirms the design. Borrow its role policy and adapter list. |
| | [Easlkad/impact](https://github.com/Easlkad/impact) (Go) | Changed packages → net/http endpoints, workers, tests | Reference only |
| | [Joern](https://docs.joern.io/) (Apache-2.0) | Code property graph and data flow. Java "very high", JavaScript "high"; TypeScript not confirmed | Candidate backbone if our own call edges stop scaling. Heavy (JVM). |
| | [SCIP](https://sourcegraph.com/docs/code-navigation/writing-an-indexer) (scip-java, scip-typescript) | Precise references, including across repos | For multi-repo microservices later |
| API contract change types | [oasdiff](https://github.com/oasdiff/oasdiff) (Apache-2.0) | 250+ breaking-change checks between two OpenAPI specs (request field became required, response field removed, enum changed…) | **Adopt its taxonomy as our delta vocabulary.** If a repo has a spec, run it and map each finding to our evidence chain. |
| | [smart-doc](https://github.com/smart-doc-group/smart-doc) (Apache-2.0) | OpenAPI from Java source and Javadoc, no running app (as described; not yet verified by us) | Try it as a spec source for repos without a checked-in spec |
| | [Pact](https://docs.pact.io/) contracts | Consumer-declared response shapes; a provider field rename fails verification | If a repo has pacts, read them as consumers |
| | JHipster `.jhipster/*.json` | Entities, fields and relationships. `Operation.json` says `bankAccount` is shown by `otherEntityField: "name"`, which is exactly why the oracle saw Operation pages go blank | A free, exact source for JHipster apps |
| framework models | [CodeQL](https://codeql.github.com/codeql-standard-libraries/javascript/semmle/javascript/frameworks/ClientRequests.qll/module.ClientRequests.html) | Models for axios, fetch, Angular `HttpClient` and Spring, with data flow | **Reference only.** The CLI's terms do not allow commercial use on private code without GitHub Advanced Security. Use its model list as a checklist of APIs to support. |
| templates | `@vue/compiler-sfc` / `@vue/compiler-core`, `@angular/compiler` `parseTemplate` (used by angular-eslint), TypeScript for JSX | Official parsers | **Replace our regex template reader.** Add the Angular reader on `parseTemplate`. |
| rules teams can extend | [ast-grep](https://ast-grep.github.io/) (tree-sitter, YAML rules) | Structural patterns in 20+ languages | Ship our "HTTP wrapper", "store" and "feature flag" patterns as rule files that teams can add to |
| dashboards | [`@prometheus-io/lezer-promql`](https://www.npmjs.com/package/@prometheus-io/lezer-promql) (Apache-2.0, official grammar), [`mimirtool analyze grafana`](https://grafana.com/docs/mimir/latest/manage/tools/mimirtool/) | A real PromQL parser; metrics used per dashboard | Replace our regex label matcher |
| schema changes | [Atlas lint](https://atlasgo.io/lint/analyzers) (destructive analyzer), [Squawk](https://pypi.org/project/squawk-cli/) (Postgres locks) | A dropped or renamed column, and migrations that lock | Source for a schema delta → readers of that column |
| feature flags | [ld-find-code-refs](https://launchdarkly.com/docs/home/flags/code-references) (Apache-2.0) | Where each flag is read in code | Pattern for a flag delta |
| coverage-based impact | [Teamscale Test Gap Analysis](https://teamscale.com/test-gap-analysis), [SeaLights](https://docs.sealights.io/knowledgebase/test-optimization/getting-started) (Tricentis), Launchable (CloudBees) | Records which code each test touched, manual tests included, and selects or finds gaps | Not our product: it needs a running, instrumented app. Use it in the bench: a per-page coverage map is another independent oracle. |
| existing E2E tests | [Playwright `--only-changed`](https://www.checklyhq.com/blog/five-playwright-cli-features-you-should-know) | Specs that import changed files. Its own docs call it a heuristic that can miss tests. | Output: list the repo's existing E2E specs that visit the affected screens |
| PR-level research | [Springer EMSE 2024, PR-based change impact analysis](https://link.springer.com/10.1007/s10664-024-10600-2) | Call graph plus history gives a risk score; reviewers rated it 3.66/5 | History is a priority signal, which our co-change already is |

Nothing found does what Teslon aims for, which is screen → field → value →
expected result, with every hop re-read at head. The closest projects stop at
"these routes are reachable" and let an LLM write the steps.

## 3. Decisions

1. **Triage every PR first.** Classify by path: docs, CI, tooling and tests
   get "no effect on the running app", with a reason. That clears 17 of 60
   PRs honestly.
2. **Add the "where" layer for all code.**
   - A changed Java method → the endpoints whose handlers reach it (our own
     call edges) → the screens that call them.
   - A changed front-end file → the screens whose import closure contains it.
   - A dependency bump → the modules that declare it → their endpoints and
     screens, plus the changelog link.

   Each of these is a "test next: look here" with the path as evidence. It is
   not a step-by-step case.
3. **Deepen with typed deltas, using oasdiff's vocabulary.** The next one is
   the response shape (this closes the independent JHipster case), with an
   Angular reader built on `@angular/compiler`.
4. **Swap hand parsers for official ones**: Vue compiler, Angular compiler and
   lezer-promql.
5. **The LLM writes words, never edges.** Every sentence it writes must cite a
   verified hop, as in naeemdadi/impact-analysis and our own verifier.
6. **Bench:** add `295fa8d` (the dependency bump that caused 405s) as a real
   escape case, and a per-page coverage map as a second oracle.
