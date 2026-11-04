# Changelog

Notable changes to Teslon. Dates are the day work landed, not a release.

## Unreleased

### Changed
- **The report is built around the decision QA makes.** The cockpit, the PR
  comment, the run summary and the terminal all lead with the same brief:
  - Test · Skip · Unclear, counted in areas of the application;
  - how sure Teslon is, in words (High, Partial or Not proven);
  - what the PR changes, each change marked Proven or Followed;
  - what the developer said, and the modules it leaves out;
  - the application map: every screen and job, grouped by module, each with
    exactly one answer.

  The cockpit goes from the map to a module, an area, and its cases or its
  proof. Skips get the same weight as tests. See
  `research/REPORT-CHECKLIST-2026-11-04.md`.
- The engine reports the screens it neither lists nor skips (`held`), each
  with why, so a report can show them as areas.
- Without GitHub, the first commit's subject titles the brief, and the commit
  messages stand in for the PR description.

### Fixed
- **What a change stores, and what it announces, is followed.** Following
  callers found who runs a change, not who later reads what it stored or
  listens for what it published. Now:
  - entity writes (setters, `save`, `delete`, a changed method's result
    written by its caller, the entity's own code) hold every screen and job
    that reads that entity, with the write as evidence;
  - a changed or removed `publishEvent` puts its listeners on the test list,
    first when nothing publishes the event any more.

  Before, both cases could be called safe to skip.
- **Images, fonts and scripts are no longer silent.** Images and fonts
  outside `docs/`, `.github/` and the root are assets: they are followed to
  where the code names them (by path), or said. A binary change is never
  "no app effect" by default. A script is tooling only when a whole word of
  its name says so; start and deploy scripts are deployment.
- A global stylesheet named in `angular.json`, and an `index.html` with an
  app root, reach every screen instead of being left unfollowed.
- Two citations did not re-check on JHipster's history; neither was silent,
  since the report said "Not proven":
  - a call chain written over several lines was cited on the line where the
    statement starts, not where the method is named;
  - a navbar in a named router outlet was cited as a tag;
  - a component drawn in a template was cited in the component's
    TypeScript file, with the template's line number;
  - a deleted front-end file's routes, app shell and imports were cited at
    head instead of at the commit before.
- A job was skipped when some changed lines had not been followed. It is now
  held, like a screen, and confidence says Partial.
- The "not followed by this build" list said that migrations and
  configuration keys were not followed, although both are.
- A job's skip reason could end in "uses none of" with nothing after it.
- Cases on a route's collection read "a saved customers"; they now read "a
  saved customer".

### Added
- Six proving-ground scenarios from a probe of 14 risky changes
  (`research/CHANGE-COVERAGE-2026-11-04.md`):
  - an event no longer published;
  - a total no longer stored;
  - stock no longer reduced;
  - a new logo;
  - a container entrypoint;
  - an image nothing names.

  The scorer also fails a run in which any screen has no answer. s05's truth
  now includes the invoice listener, which copies the order total.
- The OrderDesk proving ground: a Spring Boot + Angular app
  (`fixtures/orderdesk`) and 25 developer PRs whose truth was written before
  Teslon ran (`bench/proving-ground`). Each runs the real flow: GitHub refs,
  a fresh clone, then `teslon pr N`. A silent miss, wrong skip, false alarm,
  noise, wrong range, unsafe output or unchecked evidence fails CI. The
  first run had 14 trust failures; after the fixes below there are none,
  and every ideal is met (16/16). See
  `research/PROVING-GROUND-ORDERDESK-2026-11-03.md`.
- Config keys (application.yml / .properties) are followed to the code that
  reads them: `@ConfigurationProperties` accessors, `${…}` placeholders, and
  `getProperty`. Framework keys (`spring.*`, `server.*`, `management.*`)
  reach the whole service.
- Database migrations (Liquibase XML, Flyway SQL) are followed:
  - adding a NOT NULL column with no default that the entity cannot fill
    breaks every write;
  - dropping or renaming a column that is still mapped breaks every use;
  - row counts in production are said out loud.
- The Angular app shell (what `bootstrapApplication` loads: root component,
  config, interceptors, root-route guards) is on every screen, and so are
  components drawn in the root template.
- A contract check: a front-end read this PR introduces, on a type the page
  gets from a Java API, of a field that type does not send.
- Untyped forms (`FormBuilder`, `patchValue`) are matched to JSON fields by
  `formControlName`.
- An enum is followed into the methods that decide on its values.

- `teslon pr <number | url>`: a pull request in, the QA brief out. The PR is
  checked where it lands on `main`: a merge commit against its first parent,
  a rebase-merge by patch-id, a squash-merge by its whole diff, and an open PR
  as GitHub's test merge (or its own branch, saying how far behind it is).
  `--out` writes `comment.md`, `summary.md`, `report.json` and `report.txt`;
  `--comment` posts one PR comment and updates it on every run; `--summary`
  fills the Actions run summary. Repository text cannot inject markup or
  @mention anyone, and both outputs are cut to GitHub's limits at a line.
- The GitHub Action (`action.yml`) and the workflow to copy
  (`examples/teslon.yml`): on every PR ready for review, and by hand for any
  PR number, merged ones included. It runs on the customer's runner and
  posts nothing but the comment.
- An hours estimate only when the team gives its own minutes per case.
- The cockpit, `report.html`, rendered from the engine's report: verdict,
  "Start here", the test plan grouped by screen with DO / EXPECT / Before and
  a "Why" fold per case linked to each line, regression lists, safe to skip
  with proof, could not see, and every changed file. Pass / Fail per case is
  kept in the browser per commit; "Copy checklist" and "Copy as CSV" take
  the plan elsewhere. One file, complete without its script, with a policy
  that stops it loading anything. Written by `--out`, or alone with
  `--html`.

- The Angular reader, with Angular's own template parser and the TypeScript
  compiler. It reads:
  - routes, including lazy route files (`loadChildren`, `loadComponent`) and
    `tsconfig` path aliases;
  - the resolvers and guards a route runs, so a screen whose data comes from
    a resolver is reached through it;
  - components drawn by selector, and named outlets (a navbar) as on every
    screen;
  - service calls whose URL is built from `this.resourceUrl`, from consts in
    other files, or from an unresolved base taken as the server root (said
    on the hop).
  On the JHipster bench case (a JSON rename on `BankAccount.name`) it finds
  6 of 6 screens, where it found 0 before. The bench is now 18 of 18, with 0
  silent misses and 0 wrong skips.

- Response shape, typed end to end. A Java field whose JSON name changes
  (`@JsonProperty`), or that leaves the JSON (`@JsonIgnore`, `transient`, a
  class-level `@JsonIgnoreProperties`, or deleted), is followed to:
  - the APIs that return or take its type, and those of every type that
    holds it, unless a field-level `@JsonIgnoreProperties` on the path leaves
    it out;
  - the front-end type the page declares for that API (`http.get<IBankAccount>`);
  - each template read of the old name.
  The reads are typed by the TypeScript checker over a type-check block built
  from each Angular template, the way Angular's own compiler checks them. So
  `operation.bankAccount?.name` resolves through
  `Pick<IBankAccount, 'id' | 'name'>`, and `formControlName="name"` through
  `FormControl<IBankAccount['name']>`. Each case names the column, value,
  form field or dropdown, with "Before" and the risk, and a save case when
  the field is required.

  On the JHipster rename it finds:
  - the six places the crawl found;
  - the create screens;
  - the API cases.

  The Labels pages drop out, because `Label.operations` leaves `bankAccount`
  out of its JSON. A screen that loads a changed API with no typed read is
  still listed to check, never dropped.
- Java fields keep their modifiers, so `static` and `transient` fields are
  no longer taken as part of the JSON.

### Fixed
- Proving-ground trust failures, each with a regression scenario:
  - A moved mapping (POST /cancel → PATCH /cancellation) left a screen
    still calling the old path "safe to skip". Every base API missing at
    head is now a removed API.
  - Screens that import a service were said to make all of its calls.
    Claims now use member-level attribution.
  - Renaming a Java field but keeping its JSON name raised false "Rejected
    (400)" alarms. Rules are now keyed by JSON name or Java field.
  - Angular template hops cited the component file with template lines.
  - Lines nothing followed could leave "could not see" empty. Each is now
    named.
  - Deletion-only route removals were not seen.
  - A reindent counted as a change. In whitespace-free languages it is now
    "no app effect".
  - A moved bound produced two contradictory cases.
  - Type holders now follow only what the JSON really carries
    (`@JsonIgnore`, `@JsonIgnoreProperties`).
  - "Callers outside" said 400 for removed APIs.
  - Labels and buttons came from the service, not the screen.

- A route whose component belongs to another framework was listed as a
  screen and could be skipped. It is now that framework's, named under
  "could not see".
- `.jsx` / `.tsx` files were not noticed at all, so a React front end was
  missing from "could not see". JSX needs no React import, so the extension
  is enough.

### Changed
- The cockpit, redesigned on the Human Interface Guidelines' principles
  (clarity, deference, depth). It is now overview plus detail:
  - **One thing at a time.** The overview, one place, what is safe to skip,
    what could not be seen, or the files, each its own view, named in the
    address.
  - **Desktop.** A sidebar lists the places in the order to test them,
    grouped by kind.
  - **Phone.** The list lives in the overview and a place opens with a way
    back.
  - **Summary.** One headline figure, a thin split bar of the places beside
    its figures, and a progress meter.
  - **Each case.** "Expect" and "Risk" on separate lines, Pass / Fail as a
    two-segment control, and "Why" as a path of steps.
  - **Look and feel.** Inset grouped lists, system text styles, light and
    dark semantic colours, 44 pt targets on touch, and motion only where it
    explains a change (none with Reduce Motion).
  - Each place shows its own progress in the list, and links to the
    previous and next place.

- `@angular/compiler` 21.2: it parses arrow functions in templates and still
  runs on Node 20.
- `teslon pr`, `merged`, `analyze`, `profile`, `paths`, `cases`, `changed`,
  `java` and `ui` of the first engine moved under `teslon legacy`. The README
  now describes the current product; the old one is
  `docs/legacy-engine.md`.
- Within each tier, screens come before the APIs behind them.
- `lodash` and `lodash-es` are pinned to 4.18.1 through `overrides`, which
  clears the high-severity advisories that came in through `java-parser`.

- `teslon ui`: the local app. Six views — overview, what to test, prove it,
  coverage, who & how much, trust — over the same `TeslonResult` the CLI
  prints. Loopback only, no network requests of any kind, strict CSP, and a
  bundled OFL display face so the page looks the same on every machine without
  fetching a font. Proof chains that share a road are drawn once as a fan: on
  Teslon's own history, 312 chains read as 5 routes. "Copy test list" produces a
  Markdown checklist a lead can paste into a ticket.
- `teslon merged <sha>`: the pull request is already on the base branch and the
  branch may be gone, which the change-resolution layer has handled since the
  first commit — recovering the base from a merge commit's first parent, a
  squash commit's single parent, or a supplied range for a rebase — with no
  command that reached it. This is the case a reviewer hits most often: asked
  about a change after it landed.
- Git co-change (S5): the mock that has to move whenever its client does, the
  fixture that encodes an endpoint's response shape — coupling that exists in
  nobody's imports because there is nothing there for a parser to see. A
  sweeping commit (a rename, a reformat, a dependency bump) is excluded from
  coupling but still counted toward how often each file changes, so it cannot
  make the pairs that survive look stronger than they are.
- Lockfile diff: a dependency bump has no source diff, so without this a pull
  request that replaced the date library under twelve screens reported an
  empty radius. The lockfile names which packages moved; the bare imports name
  who uses them.
- Ownership. `CODEOWNERS` is a declaration and git history is evidence, so the
  declaration wins where it exists, the evidence fills the gaps, and every
  assignment says which of the two it came from. A manager chasing the wrong
  person because a tool guessed confidently is worse off than one told "nobody
  has declared this; the last commits were Priya's". A Tier 1 file with no
  declared owner is reported as a gap in the repository.
- Effort, counted in **cases** and deliberately never in hours. Converting
  cases to a duration needs the team's velocity, the tester's familiarity and
  how much setup exists — none of which is in the repository, so a tool that
  prints "about 3.5 hours" has invented two thirds of it, and that number gets
  quoted at someone in a planning meeting. Every case traces to something
  counted: branches (two cases each, both sides), boundary values named by the
  validation rules, breaking changes, new component states, surfaces with no
  test.
- `--fail-on tier1-untested,breaking,untested-surface,undeclared-owner`: gates
  on counted facts rather than score thresholds, because a gate that is
  arguable gets switched off within a week. Exit code 5 means the analysis
  succeeded and the policy rejected the change, which a build log has to be
  able to tell from a broken run.
- `--junit <file>`: every CI already reads JUnit, so gaps and untested surfaces
  land beside test failures instead of in a log nobody opens. Limitations are
  emitted as *skipped*, since a limitation rendered as a pass would be a lie
  told in a machine-readable format.
- **The result object is now produced.** `analyze()` assembles a `TeslonResult`
  from the primitives: confidence bands per file, a testing-priority tiering,
  the surface inventory, which existing tests reach which changed file, the
  coverage gaps, the limitations, and a plain-language brief. Before this the
  schema was declared and nothing built it, and the CLI printed its own
  parallel output — two code paths that could disagree, with the weaker one
  being the only one anyone saw.
- Testing priority in four tiers, deliberately a second axis to the confidence
  bands. A `possible` change to an untested payment endpoint has to be tested
  before a `certain` change to a comment in a well-covered helper, so ranking
  work by confidence alone inverts the order a lead needs. Every tier row
  carries the factors that scored it, summing to the score exactly.
- `Completeness`: the run's own account of what it could not see — which of the
  fifteen signals contributed (with a counterfactual measuring what each one
  uniquely found), which are not wired up and why, which files no signal can
  read, and a verdict written to be quoted: *treat this as "at least these",
  never as "only these"*.
- A tests-to-run list, separate from the priority list, with what each test
  covers directly versus only as a side effect.
- Java is wired into the analysis. The front end was built, tested and never
  called: a Java repository got a radius of one, the changed file and nothing
  else. Its readings now join the same map the TypeScript ones do, its package
  graph joins the same adjacency, and `@RestController` routes and `@Column`
  names join the surface inventory as declarations.
- Java test selection by naming convention: `OrderServiceTest` names
  `OrderService` as its subject. That is not a guess about Java — it is how the
  ecosystem declares the link, since Maven Surefire's default include is
  `**/*Test.java` and Gradle's is the same. Ignoring it threw away the one
  coverage signal every Java shop already has.
- `@Transactional` and `@Table` feed the tiering as declaration-strength
  evidence that a file writes, which is stronger than anything the TypeScript
  profiler's pattern matching can offer. Without it a changed Java file could
  not reach Tier 1 at all, so the tiering was quietly worse for the language it
  had just been extended for.
- `readAstSource`, so a file can be read as it was at the merge base — which
  is what turns "this file changed" into "this behaviour changed".
- Core engine: change resolution (merge base with progressive deepening on
  both refs; recovery for merge, squash and rebase merges), forward and
  reverse import graph, shared name index, capability profiles, coupling
  through shared database tables.
- `teslon analyze`, `teslon pr`, `teslon profile`.
- Sixteen tests, including one per invariant and one asserting core never
  imports a network module.
- CI on Node 20 and 22, with a check that every invariant still has a test
  asserting it.

### Fixed
- The fabricated `GET /x` came back a third time, from the test written to
  prevent it: the assertion quotes `"@Get('/x')"` as a string literal, and since
  comment stripping keeps strings (a route lives in one), the decorator pattern
  matched inside it. Route, registration and side-effect patterns now only
  count a match that *starts in code*; the route string inside the parentheses
  is still read.
- Tests that import build output (`../dist/index.js`) resolved to nothing,
  because `dist/` is not in the tree, so every module they exercised reported
  "no test reaches it" — a false claim a lead would act on. An unresolved
  import into `dist/`, `build/`, `out/` or `lib/` now falls back to the source
  it is built from, and only after the real path fails.
- An enterprise edge-case suite — 21 real git repositories driven through the
  real CLI — failed 8 cases on its first run, every one of them silently: the
  analysis ran, printed a confident radius, and the radius was wrong.
  - **tsconfig `paths`** (`@/lib/money`, the default in every Next.js and Vite
    app) were never read, so an aliased import looked like a package and the
    changed file had no dependents. Paths are now discovered from every
    tsconfig/jsconfig, JSONC comments and `extends` chains included.
  - **Workspace packages** (`@acme/utils` in a monorepo) were treated as
    third-party — the one graph a monorepo exists to share. Package names now
    resolve to their source entry, and deep imports into the package directory.
  - **Non-ASCII paths** came back from git octal-quoted (`"src/pr\303\257ce.ts"`),
    matched nothing on disk, and the changed file's radius vanished. git now
    runs with `core.quotepath=off` and the diff is NUL-separated.
  - **The head was read from whatever was checked out.** Asking about a branch
    while on `main` took the changed-file list from the branch and the code
    from `main`; uncommitted edits leaked into a pull request's result. The head
    is now checked out into a temporary detached worktree that shares the
    object store, used, and always removed — the user's working tree is never
    touched. This is what makes "keep one clone, point at any PR" true.
  - **`origin/main` was hard-coded**, failing as "no merge base, are they
    related branches?" on every `master`/`develop` repository and every clone
    without a remote. The base is now the remote's declared HEAD, then the
    conventional names, and the run says which it chose.
  - **Flags were read as positional arguments**: `teslon pr --json` asked git
    for a branch called `--json`, and `--junit out.xml` was analysed as a file.
  - **Spring dispatch**: a controller is written against `OrderService`, Spring
    wires `OrderServiceImpl` in, and a change to the implementation reached
    nobody. Implementation → interface edges now carry it — `likely` when there
    is exactly one implementation, `unknown` when there are several, because
    which bean is injected is decided by configuration Teslon does not read and
    picking one would be a guess. The same for NestJS/Angular abstract classes.
  - **Importers of a deleted file** were invisible: the deleted file is not in
    the tree, so nothing pointed at it. Unresolved imports are now checked
    against deleted paths, and a file still importing one is a breaking change
    floored at Tier 1 — not "may be affected", but "will not compile".
- Two of the three surfaces `teslon` fabricated when run on its own source are
  fixed at the source rather than suppressed at the report. Every profiler
  pattern read raw source text including comments and strings, so a line of
  prose describing a decorator (`// @Get('/x'), @Injectable()`) matched the
  same regex as a real one, and `Set.add('literal')` matched the same regex as
  a job queue. Source is now stripped of comments once, at the point of
  reading (string contents are kept — a route lives inside one), and the job
  pattern now requires a queue-shaped receiver. The endpoint-gating rule added
  for the third fabrication had also suppressed a real endpoint whose file
  read as `types` because TypeScript permits decorators only on classes and
  members, not on the exported function `@Post(...)` actually sat on; the gate
  now checks where the route came from (a decorator versus a registration-
  pattern match) rather than what shape the file classified as.
- `teslon pr` and `teslon merged` had two live callers of the impact engine
  that could disagree, because the CLI's own hand-rolled `combinedReverse` /
  `printRadius` — superseded the day the orchestrator shipped — was still
  wired to `analyze` before `analyze` existed as a command and was never
  removed. `teslon cases` read files through the regex profiler `readCode`
  instead of the AST reader every other command uses, so its case count could
  disagree with the one the brief quotes; it now shares `casesFor` with the
  effort roll-up.
- Clone detection was 87% of the runtime and a quadratic scaling wall: it
  compared every pair of files, which measured 3,673ms of a 4,217ms run on
  5,000 files, for the signal whose measured counterfactual on the torture
  fixture is zero. An inverted index on the structural fragments, with
  candidates drawn from each file's rarest ones, took the same analysis to
  1,274ms with the exact Jaccard still deciding every verdict. 3.3x.
- Build output (`.tsbuildinfo`, `.min.js`, `dist/`) was listed among the files
  no signal can read, turning an honest list of holes into noise a reader
  learns to skip.
- The orchestrator handed the primitives a pre-filtered list of code files.
  Every primitive already filters its own input, so this bought nothing and
  starved every cross-language signal: ground-truth recall fell from 95.7% to
  69.6%, because a `.css` class, a `.sql` column and an i18n `.json` key are
  all evidence and none live in a `.ts` file. Narrowing the input is narrowing
  the answer. (I2)
- `teslon pr` refused to run on any pull request that deleted a file: the
  changed-file list from git includes deletions, and the radius printer exited
  with "not in the repository". A changed path absent from the tree is now a
  reported limitation, and the file stays in the radius — an empty analysis
  that reads as "nothing is affected" is the most dangerous output this tool
  could produce. (I1)
- Running Teslon on its own source fabricated three surfaces: an endpoint
  `GET /x` from a string inside a parser, the events `gt`/`gte`/`min`/`max`/
  `length` from the keys of a lookup table, and "enqueues a job" from a word
  in its own source. Surfaces now require corroboration, because doubt follows
  the opposite rule for a claim than it does for the radius: a fabricated
  endpoint is worse than a missing one. Withheld claims are counted and
  reported rather than dropped silently.
- A priority floor overrode the tier while leaving the score alone, printing a
  Tier 2 row scoring 5 above a Tier 3 row scoring 8 — defensible policy that
  reads as a broken sort, which costs more trust than the policy was worth.
  A floor now lifts the score and shows itself as a factor. (I3)
- Test files appeared in the priority list, telling a lead to "keep an eye on"
  a spec file. A test is something you run, so it has its own list now.
- Two gap entries for one untested file made the brief report "2 coverage
  gaps" about a single file, overstating the problem to exactly the person
  least able to check it.
- The brief printed "every changed file has a test that reaches it directly"
  directly above "2 affected surfaces have no test reaching them at all". Both
  sentences were true and together they read as a contradiction, which costs
  the same trust a false one would.
- The completeness report said `contract` "ran and found nothing" in runs where
  no merge-base readings were supplied, so it could not have run at all.
  Claiming a mechanism ran when it did not is the overstatement the whole
  block exists to prevent.
- Prose containing a SQL verb ("Delete your account") was read as a
  statement, reporting a file as read-only that nothing had been learnt
  about. (I1)
- Dotfiles were excluded from the file listing, so a changed `.env` could
  never appear in a radius. (I1)
- The name index used a fixed cap of 12 files per token; on a 2,000-file
  repository every shared name exceeded it and the signal produced zero
  edges while reporting nothing. The cap now scales with repository size and
  discarded names are reported. (I1, I2)
- `possible` and `unknown` shared a rank, so the resulting band depended on
  which signal merged first. (I3)
- The declared auth guard name was lost to operator precedence, so every
  guarded handler reported the same string.
- git diagnostics leaked to stderr and a missing repository was misdiagnosed
  as unrelated branches.
- An unknown CLI command exited 0, so a typo passed silently in a pipeline.
