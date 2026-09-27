# Changelog

Notable changes to Teslon. Dates are the day work landed, not a release.

## Unreleased

### Added
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
