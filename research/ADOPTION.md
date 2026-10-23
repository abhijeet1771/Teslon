# What to adopt, and what not

2026-10-23. Each candidate was run on our own cases where that was possible,
not judged from its README. Spike scripts are in [`spikes/`](spikes/).

## The bar a tool has to clear

1. **Never silent.** A source that can drop a change without saying so may
   only cross-check. It can never be the reason Teslon says "not affected".
2. **No running app.** The input is a PR; nothing is built, deployed or crawled
   (decided 2026-10-15).
3. **Licence allows commercial use on private code.**
4. **Gives a file and line**, so its findings can be re-read like ours.
5. **Light to install.** Teslon core is pure Node and offline. A JVM or a
   native binary is a cost to justify.

## Spikes

| candidate | run on | result |
|---|---|---|
| `@vue/compiler-dom` 3.5 (MIT) | spm `PetFormPage.js`, `OwnerDetailsPage.js`; JHipster Vue `bank-account-…-update.vue`, `operation.vue` | Same `v-model` fields our reader finds, plus modifiers (`.trim`, `.number`). It also gives what ours cannot see: `v-if` conditions (`loading-spinner v-if="loading"`, `div v-if="bankAccount.id"`), event handlers (`form @submit="submit"`, which ties the button to the method that calls the API), loops, child components, and SFCs whose script lives in another file (`<script src="./operation.component.ts">`). No parse errors. |
| `@angular/compiler` 20 `parseTemplate` (MIT) | the JHipster Angular templates behind the 6 pages the runtime oracle found | Reads of `.name`, with lines, on **exactly those 6 pages**: `bankAccount.name` list :69, `bankAccountRef.name` detail :22, form control `name` edit :25, `operation.bankAccount.name` list :81, `operationRef.bankAccount.name` detail :34, `bankAccountOption.name` edit dropdown :92. It also finds `@if` / `@for` blocks and events. 0 parse errors. This is the missing half of the independent case. |
| `@prometheus-io/lezer-promql` 0.315 (Apache-2.0, the official grammar) | all 12 queries on the spm Grafana dashboard | Every metric and label matcher parsed, 0 errors. On these simple queries the result is the same as our regex. It is safer on real ones (`by`, `on()`, `offset`, nested functions). |
| smart-doc 3.1.1 (Apache-2.0) + oasdiff (Apache-2.0) | spm #559, base vs head | smart-doc wrote `PetRequest` (a Java record) as `"type": "integer"`, and put constraints in description text only. oasdiff: **"No changes detected"**. The engine finds 12/12 on the same commits. |
| same | JHipster JSON rename, base vs mutation | With the case's real annotation, `@com.fasterxml.jackson.annotation.JsonProperty("title")`, the two specs came out **byte-identical**: a silent miss. Rewritten as `import … JsonProperty` + `@JsonProperty("title")`, oasdiff reported 37 request-side changes on 7 write APIs (`new-required-request-property title`, `request-property-removed`). It reported nothing on the response side, and nothing about pages. |

## Decisions

### Adopt now

| what | for | why |
|---|---|---|
| `@vue/compiler-dom` / `@vue/compiler-sfc` | replaces the regex template reader | Conditions, handlers, loops, child components and split SFCs, all of which our reader misses. Pure JS. |
| `@angular/compiler` `parseTemplate` | the Angular reader | It found all 6 oracle pages in the spike. Pure JS. |
| TypeScript type checker (`ts.Program`, already a dependency) | knowing *which* `.name`: that `operation.bankAccount` is an `IBankAccount` | Turns "reads something called name" into "reads BankAccount.name", which is what makes the claim sound. |
| `@prometheus-io/lezer-promql` | replaces the regex PromQL matcher | Official grammar, no new risk |

### Adopt as an optional input (used when the repo has it, never required)

| what | when | how |
|---|---|---|
| oasdiff | the repo has a checked-in OpenAPI spec, or CI produces one | A second opinion at the API level, mapped onto our evidence chain. Its check names (`request-property-became-required`, `new-required-request-property`, …) become our delta vocabulary. It cannot see pages, and on generated specs it inherits the generator's misses. |
| Pact files | the repo has pacts | Consumer-declared response fields are exact reads, no inference needed |
| JHipster `.jhipster/*.json` | JHipster apps | `Operation.json` says `bankAccount` is displayed by `otherEntityField: "name"`. That is an exact, declared reason why Operation pages show the bank account's name. |
| Cypress / Playwright specs in the repo | always, when present | "Existing automated tests to run": specs that visit an affected route (`cy.visit(bankAccountPageUrl)` in `bank-account.cy.ts`) |

### Reference only (read their models and checklists, depend on nothing)

| what | why not as a dependency |
|---|---|
| CodeQL (`ClientRequests.qll`: axios, fetch, Angular `HttpClient`, Spring models) | Licence: commercial use on private code needs GitHub Advanced Security. Its list of modelled HTTP APIs is a good checklist for ours. |
| naeemdadi/impact-analysis (MIT) | Small (0 stars), JS/TS only, Next.js-centred. Borrow ideas: its role policy (shared UI does not flag every flow), its adapter list, and its rule that AI may only phrase things and must cite its sources. |
| Atlas lint, Squawk | Their analyzers (destructive change, lock risk) are the checklist for our schema delta. The delta itself is read from Liquibase and Flyway changesets, which is where JHipster keeps its schema (`config/liquibase/changelog/*.xml`). |
| ld-find-code-refs | The pattern for finding flag reads. Each flag SDK gets a reader. |
| Teamscale, SeaLights | They need an instrumented running app and are commercial. Their idea, per-page coverage, becomes a second oracle in the bench, not a product feature. |
| Playwright `--only-changed` | An import-graph heuristic over test files that its own docs say can miss tests. We do the same reachability with evidence and on screens. |

### Not now

| what | why |
|---|---|
| smart-doc as a source of deltas | Silently missed the real annotation, and turned a record into `integer`. That fails bar 1. |
| Joern | JVM and Scala, a heavy install, and TypeScript support is not confirmed. java-parser plus the TypeScript compiler cover what we need today. Revisit if call graphs across very large codebases get too slow. |
| SCIP indexers | They need a build per language. Useful for cross-repo symbols (stage 7), not before. |
| ast-grep | A native binary. Its idea, team-editable YAML rule files for HTTP wrappers, stores and flags, can come later as our own rule format. |
| An LLM in the analysis | It may phrase steps and summaries only, each sentence citing a verified hop. It never decides an edge. |
