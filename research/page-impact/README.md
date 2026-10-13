# Page-level impact — R&D prototype

**Status: research, not product code.** This folder proves mechanisms on a real
repository before any of them go into `packages/core`.

## The question

A developer opens a pull request. Which **pages, features and APIs** of the
running app does it affect — and can every claim be proven hop by hop, so a
developer can check it in seconds and start relying on it?

## The test bed

[`spring-petclinic/spring-petclinic-microservices`](https://github.com/spring-petclinic/spring-petclinic-microservices):
four Spring services behind a Spring Cloud Gateway that rewrites URLs, a
gateway-side aggregator (BFF), an AI chat service that calls other services
through Spring AI tools, and a frontend that moved from AngularJS to Vue during
the history studied. Every change below is a real commit from that history.

```
git clone https://github.com/spring-petclinic/spring-petclinic-microservices.git spm
node run.mjs  spm 1e7ecb8~1 a3f9d06     # real PR: pet birth dates cannot be in the future
node deps.mjs spm 17cad88~1 17cad88     # real regression: Spring Boot 4 upgrade -> 405s fixed 9 months later in #563
node run.mjs  spm 3858f9c~1 3858f9c     # negative control: test-only change
```

## Results

| Case | Ground truth (hand-derived, with evidence) | Teslon today | Prototype |
|---|---|---|---|
| `1e7ecb8`+`a3f9d06` — `@PastOrPresent` on `PetRequest.birthDate`, `@Valid` added | Add Pet page, Edit Pet page, AI chat "add a pet" tool (genai → customers via discovery), gateway route; *plus* a rule nobody wrote: `name @Size(min=1)` now enforced on update; existing rows with future dates become uneditable | radius = the 3 changed files; **0 of 6** | **6 of 6**, the unmentioned `name` rule, GET reads correctly *excluded*, and a SQL probe for the data risk |
| `17cad88` — Spring Boot 3.4.1 → 4.0.1, chaos-monkey left at 3.1.0 (fixed in #563, *"405 errors from api-gateway"*) | Every page calling customers/vets/visits/genai, including owner details through the BFF to two services | 90 files, **0 pages** (CSS files via shared names) | **9 of 9 pages + AI chat**, from a skew rule: chaos-monkey 3.1.0's own POM on Maven Central pins Spring Boot 3.2.1 |
| `3858f9c`, `1d76b00` — test-only | nothing user-facing | — | nothing |

Two positive cases and two controls are a proof of concept, not a statistic.
A claim of accuracy needs a labelled corpus of real PRs; see *Next*.

## Mechanisms, each a rule a person can check

| Rule | What it reads | Example hop |
|---|---|---|
| Spring MVC | class + method mappings, `@RequestBody`, `@Valid` | `PetResource.java:69 PUT /owners/*/pets/{petId}` |
| Bean Validation | constraints on the body type, before vs after | `@Valid` added → *every* rule on `PetRequest` is new |
| Spring Cloud Gateway | `Path=` predicates, `StripPrefix=` | `/api/customer/**`, strip 2 → `customers-service` |
| Service discovery | `getInstances("x")`, `http://x/`, `lb://x`, constant fields | `AIDataProvider.java:73 → customers-service` |
| Spring AI | `@Tool` methods handed to `.defaultTools(...)` | `PetclinicTools.addPetToOwner → POST /chatclient` |
| Contract match | consumer URL templates unified with provider templates over value classes (id, segment, empty) | `` `/pets${petPath}` `` matches both `/pets` and `/pets/{petId}` |
| Direction | a request-body rule reaches writers only | `GET …/pets/{id}` excluded, with the reason |
| Router | Vue Router `path → component`; AngularJS `state → <tag> → module` | `PetFormPage.js → /owners/:ownerId/new-pet` |
| Global UI | a component rendered beside `<router-view>`, or a script `index.html` loads outside `ui-view` | `<chat-box>` on every page |
| Data | new rule on an update path × `@Table`/`@Column` | `SELECT id FROM pets WHERE birth_date > CURRENT_DATE;` |
| Framework skew | a dependency's own POM vs the app's framework major | chaos-monkey 3.1.0 built on Boot 3.2.1; app on 4.0.1 |

## What the prototype got wrong first (each one is now a requirement)

1. A Spring path `"/owners/*/pets"` contains `/*`; a naive comment stripper
   swallowed the controller after it. Stripping must respect strings.
2. Stripping block comments dropped newlines, so quoted line numbers were wrong.
   Evidence with a wrong line is not evidence; every quoted line is now checked
   against `git show`.
3. A network failure while reading Maven metadata was caught and ignored, and
   the dependency rule silently produced nothing. Every fetch failure surfaces.
4. The frontend changed framework inside the history studied. Adapters are per
   framework *and* per era.
5. URLs built in a variable or held in a constant field were missed until simple
   constant propagation was added.
6. `import … from './ChatBox.js?v=…'` — cache-busting query strings break
   import resolution in `packages/core` today.

## Known residue — things no static rule can settle

- Gateway routes can be overridden by the external config repository the config
  server pulls in the `docker` profile (`spring-petclinic-microservices-config`).
  Until that repo is read, every gateway hop carries that caveat.
- The AI chat calls `addPetToOwner` only when the model chooses to. The impact is
  real but conditional on a conversation.
- `PetFormPage` picks PUT or POST from `petId`, so both pages are attributed to
  both endpoints — safe, but a path-sensitive analysis would split them.
- Consumers outside the repository (mobile apps, partners) are invisible without
  a consumer registry.

## Next

1. A labelled corpus: 30–50 real PRs across 3–5 repositories matching the
   target stack, each with hand-derived ground truth and developer-confirmed
   fixes ("fixes the regression introduced in #…").
2. Promote the rules into `packages/core` as framework adapters with conformance
   tests, on compiler-grade parsing rather than patterns.
3. Report in QA language: pages, features, APIs, data checks, what to try, and
   the residue — every hop with `file:line` and the rule that justified it.
