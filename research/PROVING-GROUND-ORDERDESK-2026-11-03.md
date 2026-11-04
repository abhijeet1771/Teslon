# OrderDesk proving ground: 25 developer PRs, truth first

2026-11-03. The goal was to test Teslon the way it will really be used, as
hard as possible. One wrong claim anywhere is a trust failure.

## The setup

**The app: OrderDesk** (`fixtures/orderdesk`, also a GitHub repository with
real PRs). It is an internal order desk, written for this test to look like
an enterprise codebase. Teslon's own rules played no part in writing it.

The back end is Spring Boot 3 / Java 21:
- entities with Jackson and Bean Validation annotations;
- DTO records;
- services for pricing, inventory, invoices, notifications and reports;
- an `@EventListener`, a `@Scheduled` job and `@ConfigurationProperties`;
- a security config and Liquibase.

The front end is Angular 21:
- lazy route files, a resolver and a guard;
- interceptors registered in `app.config.ts`;
- a navbar drawn in the root template;
- signals, `httpResource`, a typed `FormGroup` and an untyped `FormBuilder`
  form;
- a shared status badge, a pipe, and a confirm dialog drawn by selector.

**The PRs.** There are 25 scenarios (`bench/proving-ground/scenarios.mjs`):
easy changes, hard ones, traps and process cases. Their truth was written by
hand from the code before Teslon was run on any of them. Each scenario runs
the real flow:
1. a PR branch on an origin;
2. GitHub's `refs/pull/N/head` and `refs/pull/N/merge` (or a merge commit,
   a squash or a rebase for merged PRs);
3. a fresh clone with full history;
4. `teslon pr N` with no token.

**The scoring** (`bench/proving-ground/run.mjs`). Any of the following is a
**trust failure** and fails CI:
- a silent miss;
- a wrong skip;
- a false alarm;
- noise on a change with no app effect;
- a wrong commit range;
- unsafe output;
- evidence that does not re-check.

## Result

| | runs | trusted | trust failures | imprecise | ideal |
|---|---|---|---|---|---|
| first run ([baseline](../bench/proving-ground/baseline-2026-11-03.md)) | 27 | 19 | 14 | 2 | 7/15 |
| after the fixes ([results](../bench/proving-ground/results-2026-11-03.md)) | 27 | **27** | **0** | 0 | 16/16 |

After the fixes, the external bench gives the following:

| bench | found | silent misses | wrong skips | extra claims | evidence |
|---|---|---|---|---|---|
| spm and JHipster | 18/18 | 0 | 0 | down from 8 to 6 | 144/144 and 70/70 |

The 60-commit spm scan is unchanged.

## What was wrong, why, and the fix

| # | Scenario | What Teslon did | Root cause | Fix |
|---|---|---|---|---|
| 1 | s13 cancel moved to `PATCH /cancellation`, front end unchanged | Called **Order detail safe to skip** | "Removed API" was only handled when the Java method disappeared; here the method stayed and its mapping moved | Every (verb, path) at base that head no longer answers is a removed API, whatever the reason. Screens still calling it are test first, and the old endpoint counts as touched |
| 2 | s13 | "Risk: it fails" on the **dashboard, order list and new order**, which never cancel | A screen that imports a service was assumed to make all of its calls | Member-level attribution: each HTTP call knows its class member, and each file knows which members it uses (`this.svc.m()`, `inject(Svc).m()`, the template, `this.` inside the service). Claims use it. Whether a screen can be skipped stays with the wider file-level answer |
| 3 | s15 Java field renamed, JSON name kept | **False alarm**: "Rejected (400)" on 5 customer screens | Rules were keyed by the Java field name, so a renamed field looked like a new rule | A rule is the same when its JSON name **or** its Java field is the same |
| 4 | s17 | False alarm on stored rows after a JSON rename of a validated field | The same as #3, in the other direction | The same fix |
| 5 | s15, s19 | **Evidence failed**: hops cited `component.ts` with lines from the template | An Angular template is a separate file; shows, links and elements did not carry it | Every template fact carries its file, and every hop uses it |
| 6 | s07 interceptor, s08 navbar | Nothing listed; "unknown" | No notion of the app shell (what `bootstrapApplication` loads before any route) | The Angular reader computes the shell (root component, app config, interceptors, root-route guards). A change there means every screen. Components in the root template are on every screen |
| 7 | s11 `orderdesk.page-size` | **Silent**: 0 to test, 0 could not see | Config files were not followed. When nothing at all was modelled, unfollowed lines produced no "could not see" | (a) Every unfollowed line is named under "could not see", always. (b) Config keys are followed to the code that reads them: `@ConfigurationProperties` accessors (relaxed binding), `${…}` placeholders in `@Value` and `@Scheduled`, and `getProperty("…")` |
| 8 | s12 Liquibase NOT NULL with no default | Silent | Migrations were not read | Liquibase XML and Flyway SQL column operations are read and mapped to the entity. A NOT NULL column with no default that the entity cannot fill makes every write fail; a dropped or renamed column that is still mapped makes every use fail. The cases name the migration, the writers and the screens. "Could not see" says that row counts in production decide whether the migration runs |
| 9 | s20 route removed | Not test first; "unknown" | A deletion-only change has no head lines, so the front-end pass skipped the file | Routes defined at base and gone at head are found from the base snapshot, with every link that still points at them |
| 10 | s19 AI reindent of 24 Java files | **Noise**: 30 places to test | A reindent counted as a change | In languages where whitespace means nothing, the diff ignores changes in the amount of whitespace. Reindented files are "no app effect: only whitespace moved". Python, YAML and Markdown are not treated this way |
| 11 | s01 note limit 500 → 200 | Two **contradictory** cases: "→ 400" and "→ accepted" | A moved bound was read as one rule added and one removed | A moved bound on the same rule is one change, in one direction |
| 12 | s18 new `ON_HOLD` status | 13 noise cases on customer screens, and the daily report **missed** | Type holders ignored Jackson (`Customer.orders` is `@JsonIgnore`). Enums used inside method bodies were not followed | Holders follow only what the JSON really carries (and `@JsonIgnoreProperties` cuts paths). An enum is followed into the methods that decide on its values |
| 13 | s01 | "press save", field label missing | Labels and buttons were taken from the file making the call (the service), not the screen | Labels come from the screen's component, and `formControlName` matches the field |
| 14 | s03 untyped `FormBuilder` form | The Stock field was not named | The form has no types to check | A `formControlName` equal to the changed JSON name is reported. `patchValue` binds by that name, so the field loads its default and saving can reset the stock |
| 15 | s04 rename on the front end only | Screens listed, but the real bug was not said | No check of front-end reads against the Java JSON | Contract check: a read this PR introduces, on a type the page gets from a Java API, of a field that type does not send. Example: "Risk: blank, because the page reads "title" and Product sends no "title" (it sends "name")" |
| 16 | s05, s13, s14 | "Callers outside … now get 400" on every delta | The note was written for request rules only | Request rules say 400; removed APIs say 404/405 |

## Where the truth was wrong, and was corrected

The truth was written first, and three entries in it were wrong. Each is
marked in `scenarios.mjs`.

- **s17 (first version)** assumed a forgotten `item.product.sku` would show
  blank. In a typed Angular app, `Pick<IProduct, 'sku'>` with no `sku`
  **does not compile**, so the build catches it. It was replaced by the
  runtime bug a rename really leaves: renaming a field on a front-end type
  whose API was not renamed (`ITopProduct.sku` → `code`). Teslon now
  catches that with the contract check.
- **s20** required every screen to be kept. A QA lead would test the
  navbar's Reports link once, since it is one component, and skip the other
  screens. The truth was relaxed to that.
- **s18** missed that the daily report counts every status except
  `CANCELLED`, so `ON_HOLD` orders now count as revenue. Reviewing Teslon's
  output found this. It was added to the truth, and Teslon was fixed to find
  it.

The scorer had two bugs of its own:
- it flagged `\[click\](javascript:…)`, which is escaped text and not a link;
- it matched "NotBlank" as "blank".

Both were fixed after reading the actual output.

## 2026-11-04: six more, from a probe

A probe of 14 risky one-line changes found four classes of change that
following callers alone gets wrong:
- data a change stores, read by other screens and jobs;
- events it stops publishing;
- images outside `docs/`;
- start scripts.

They are fixed, and the six scenarios s26–s31 hold them. The scorer also
fails a run in which any screen has no answer. With these, 33 runs give 33
trusted and 0 trust failures
([results](../bench/proving-ground/results-2026-11-04.md)). The probe and
what each kind of change gets are in
[CHANGE-COVERAGE-2026-11-04.md](CHANGE-COVERAGE-2026-11-04.md).

## What is not covered yet

- **React front ends.** They are detected and named under "could not see",
  but not read.
- **Skips at member level.** Claims use it, but whether a screen is skipped
  still uses files. A screen that only imports a service whose other method
  changed is listed under "could not be ruled out", not skipped. This is
  safe, but noisy.
- **Type errors a PR introduces.** The checker's diagnostics are not diffed
  yet. A broken build is found by CI, not by Teslon.
- **Several repositories, permissions, and data already in production.**
  These are still said out loud, not followed.
