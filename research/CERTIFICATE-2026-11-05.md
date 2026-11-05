# Skip certificates and the independent checker (Phase A, step 1)

2026-11-05. Code: [packages/core/src/engine/certify.ts](../packages/core/src/engine/certify.ts).
Tests: [packages/core/test/certify.test.mjs](../packages/core/test/certify.test.mjs).
Tools: [bench/probes/certscan.mjs](../bench/probes/certscan.mjs).

## The decision, as a co-owner

A SKIP is the one answer Teslon gives that a QA lead acts on without looking.
Every wrong skip so far had the same cause: the engine did not see a path.
- ShopFlow's first run had lazy routes it did not read, calls through an axios
  instance it missed, and Kafka producers it did not join to their consumers.
- OrderDesk's 7b round had routes moved by a parent route and columns renamed
  in the database only.

More rules fix the case in front of us. They do not stop the next one.

So the first step of Phase A is not another rule. It is a second opinion that
does not share the engine's rules:
- Every SKIP gets a **certificate**.
- An **independent checker** recomputes the certificate from the facts of both
  commits.
- A skip it cannot prove is held as **UNCLEAR**.

This moves Teslon towards **100% trust**: never a wrong skip, and every skip
re-derived. It does not move precision. Precision can only get worse by the
skips the checker refuses, so that cost is measured below.

There is no model and no guess anywhere in this. The checker is a graph walk
over facts the readers produced, with a printed list of the assumptions it
used.

## What the checker does

1. **One dependency graph over base ∪ head.**
   - Nodes:
     - screens and their routes;
     - browser files and their members;
     - API calls and endpoints;
     - Java methods, fields and class headers, all named by module, so two
       services' `ApiExceptionHandler` are two classes;
     - settings;
     - topics;
     - entity rows and tables.
   - Edges: what each node depends on, read forward from the area. The
     engine walks backward from the change, so the two walks are different
     algorithms over the same facts.
2. **Δ, worked out on its own.** The checker compares definitions on both
   sides; it does not use the engine's "followed lines":
   - Java: the tokens of each method, field and class header. A comment-only
     change is not a change.
   - Browser files: the text of each member and of each route entry.
   - Configuration: each setting key, so list items in YAML are not lost.
   - Migrations: the tables they name. For seed CSV files, the table the
     changelog loads them into.
   - Other files: by kind. Tests, docs, CI and tooling are not part of the
     app. Deployment files are their own area.
3. **Unknowns are facts.** The checker records an unknown wherever the facts
   cannot pin something down:
   - a network call no fact records;
   - an API call that matches no endpoint here;
   - a Java HTTP client with no call read;
   - reflection;
   - an interface nothing implements;
   - a topic not resolved;
   - a changed file no reader read;
   - an area that is in neither commit's facts.

   Unknowns are ranked by how many skips each one blocks.
4. **The certificate** for an area is the closure S of what it depends on.
   - It holds when no changed definition and no unknown is reached through
     code the area runs.
   - It carries a sha256 digest of S and Δ: the same commits give the same
     proof.
5. **Run versus content.** The walk marks every edge that carries a value
   instead of running code:
   - a type's shape;
   - a data type's field;
   - rows another method writes, and that method's callers;
   - what a producer and its callers put on a topic;
   - an implementation the settings here switch off.

   A changed definition reached only that way is listed under `relies`. It
   does not refuse the skip: the engine's field-level and data-flow analysis
   is what decides there. Why this split:
   - The engine's truth on these is finer than any whole-type walk. For
     example, a screen reads `customer.name`, not the whole `Customer`.
   - Enforcing them put 33–52% of all skips on UNCLEAR. That is useless to a
     lead.
   - Every wrong skip in history was a missed path, which is the hard part.
6. **Dangling-edge rate.** A call to an app method the facts did not resolve
   (a lambda's parameter, a chained call) is widened to every method of that
   name the caller can see. The share of such calls is printed per run.

The integration is in `impact.ts`, step 3b. Every screen and job SKIP is
certified. A refused one moves to `held` with the first blocker, its path,
and a citation that re-checks. The report gains `certification`: proofs,
unknowns, Δ by kind, the dangling rate and the assumptions used. It is the
same, byte for byte, for the same two commits.

## Measured

The runs went one after another, with no rebuild during a run.
- OrderDesk, ShopFlow, the proving ground, both soundness tests and the unit
  tests are on the final build.
- spm, the two histories and the bench are on the build one step before. The
  last step was TypeScript type erasure, store members, `@Async` listeners
  and `spring.jackson`; none of these is in those apps' refusals.

**Soundness.** Every area a probe's truth says is reached was handed to the
checker as if the engine had skipped it
(`node bench/probes/certscan.mjs --app=… --truth`). A sound checker refuses
each one.

| App | Areas the truth says are reached | Refused through code the area runs | Found as content the skip relies on | Certified with nothing to show |
|---|---|---|---|---|
| ShopFlow (79 probes) | 255 | 142 (55.7%) | 113 | **0** |
| OrderDesk (178 probes) | 493 | 283 (57.4%) | 210 | **0** |

The first run of this test certified 61 of ShopFlow's 255. Each miss was a
hole in the checker, and is listed below.

The split says something on its own: **about 43% of real impact is
content.** That is rows, fields and messages, not code the area runs. That
is where the engine's typed analysis carries the skip, and it is the next
thing to make provable (Phase B facts, and automatic truth).

**Precision.** These are the skips the engine reached that the checker would
not prove. Each is held as UNCLEAR with its blocker.

| Suite | Trusted | Skips checked | Certified | Not proven (held) | Held screens before → after | Dangling calls |
|---|---|---|---|---|---|---|
| OrderDesk probes | 178 / 178 | 1950 | 1947 (1287 rely on content) | 3 | 2.6% → 2.6% | 18.0% |
| ShopFlow probes | 79 / 79 | 766 | 765 (354 rely on content) | 1 | 5.3% → 5.3% | 12.7% |
| spring-petclinic-microservices probes | 9 / 9 | 55 | 44 | 11 (a `WebClient` call no fact records) | 0% → 2.5% | 7.3% |
| spm history, 60 real commits | 0 citation failures, 0 crashes | 23 | 13 | 10 (the same unknown) | — | — |
| JHipster history, 60 real commits | 0 citation failures, 0 crashes | 20 | 20 | 0 | — | — |

Other suites:
- Proving ground: 33 / 33.
- Bench: 18 / 18, with no silent miss and no wrong skip.
- Unit tests: 215 / 215, 8 of them for the checker.

**The refusals that remain:**
- OrderDesk (3): the three jobs, on a Spring Boot version bump in the root
  `pom.xml`. That reaches everything. It is safe, and right.
- ShopFlow (1): a job that publishes to a topic whose constant changed. The
  job's own behaviour changed.
- spm (11 in probes, 10 in history): `VectorStoreController` sends with a
  `WebClient` the reader does not read. That is a real blind spot, now named.

**Cost.** The checker takes about 0.5 s on JHipster (29 screens) and under
0.1 s on spm.

## What the first runs found (and what was fixed in the checker)

The first full run held 57% of ShopFlow's screens (it was 5.3%). Each cause
was a place where the checker was coarser than the code:
- `JpaRepository<Product, Long>` was not seen as a repository because of the
  generics, so every repository method was an unknown.
- An exception handler and every other advice were made global to all code,
  not to web requests.
- Two services' classes were merged because they shared a simple name.
- A constant (`Topics.X`) pulled in every field of its class.
- A member of a Vue module "named" another member through `.get(`.
- `repo.findByX(..).get()` was widened to every `get` method in the service,
  because the return type was not read.
- A link to a route pulled in the whole target screen, not the route entry.
  `/orders/new` matched `/orders/:id`.
- A router's member spans held the route entries.

A second set came from the truth test (below). These were real soundness
holes, now closed:
- A route that moves broke the links to it on other screens.
- What a writer or a producer's caller computes was not followed.
- A screen that a parent route moved had no node at all, and an empty area
  was certified.
- Nested request rules (`List<@Valid OrderLineRequest>`) were not reached,
  because the reader glues the annotation to the type name.
- An implementation switched off by the settings was dropped. Deployed
  settings can differ, so it is now relied on, not dropped.
- A MapStruct update writes into its `@MappingTarget` without a setter in
  the service, so the mapper method is now a writer of that entity's rows.

A third set came from the unit tests and the real histories. Here the
checker was coarse where a finer argument can be checked from the facts
alone:
- **Security rules.** When every changed line of a security filter chain
  names a `requestMatchers("…")` pattern, only the endpoints those patterns
  match are reached. A CSRF line reaches only the requests that change state.
- **Navigation guards.** A guard whose whole body is `if (to.meta.K && …) { … }`
  does nothing for a route whose meta, or a parent's, has no `K`. This holds
  on both commits, so those routes are not reached.
- **Links** depend on the target route's path existing, not on its title or
  guard.
- **package.json.** A changed runtime dependency reaches the files that
  import that package. Any other change is the whole build. A lockfile entry
  that no app file imports is the whole build too.
- **A call to a path no endpoint here resembles** is outside the repository,
  and is counted in the dangling ledger. A near miss (the same last segment)
  is still an unknown.
- **A wrapper** (`request(url)` around a browser call on `url`) is accounted
  for when its callers' calls are recorded. A class's own `this.fetch()` is
  not the browser's `fetch`.
- **TypeScript types are erased.** Changed lines inside `interface`, `type X =`
  and `import type` run nothing, so a changed `types.ts` reaches no screen.
- **A store's `return { a, b }` line** is each member's declaration, not one
  member calling another.
- **A reader bug, fixed in the Vue reader (`vue.ts`).** A static attribute
  (`class="cart"`) was taken as the template handing the `cart` store on
  whole, so every screen that draws the NavBar "used" every store member.
  Only `{{ … }}` and bound attributes name script values now.
- **An `@Async` listener** runs on another thread. The request that
  published its event does not run it, so its changes are content for that
  screen, not code it runs.
- **`spring.jackson`** set as a parent key reaches every JSON response of
  its service, and the code that holds an `ObjectMapper`. It does not reach
  jobs.
- **Building a client is not a call.** A Java method that only builds a
  `WebClient` or a `RestClient` is not an unknown. One that sends a request
  with no call read still is (spring-petclinic-microservices:
  `VectorStoreController`).

## Assumptions the checker prints

Each run lists the assumptions it used, with counts:
- Tests, docs, CI and tooling are not part of the running app.
- Deployment files are their own area to test (DEPLOY). They do not change
  what the code does.
- Calls to hosts and services not in this repository are outside it: this
  PR cannot change them.
- A service reaches another service's classes only over the network.
- Jackson and JPA touch a data type only through its fields, accessors,
  constructors and lifecycle callbacks.
- Request rules run only where a parameter is `@Valid` or `@Validated`, or on
  JPA entities.
- Settings under logging, management, info and springdoc change nothing a
  user sees.
- A bean switched off by `@ConditionalOnProperty` here is relied on as off.
- Facts come from Teslon's own readers: a tokenizer and parsers, not a
  compiler.

## Honest limits

- **The facts are level L3** (the tokenizer and parsers). The council's rule
  is that a SKIP needs an L0/L1 path. The checker checks that the engine's
  answer agrees with the facts, but the facts can still miss something. That
  is what Phase B is for: SCIP for Java, and the TypeScript checker
  everywhere.
- **Content claims are relied on, not proven.** The truth test shows how big
  this part is. A skip that relies on content shows what it relies on, but
  nothing outside the engine re-derives it.
- **A guard change** in the router refuses every screen. So does a security
  configuration change: every web request. Both are safe and coarse.
- **The NavBar uses a store "whole"** because the reader marks a template
  binding as an escape. A finer reader would certify more screens.

## Next in Phase A

1. A co-change guard and a rule-gap miner from git history.
2. Claim against reach.
3. Automatic truth on RealWorld.
4. External truth sets.

The certificate is where each of these lands. A new unknown kind, or a new
"relies" kind, is one line in `certify.ts`, not a new rule in the engine.
