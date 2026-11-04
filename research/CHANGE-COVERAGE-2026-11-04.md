# Is every possibility considered when Teslon checks a PR?

2026-11-04. Short answer: **no tool considers every possibility, and Teslon
does not claim to.** What Teslon must never do is be **silent** (say
nothing about a change that matters) or skip **wrongly** (call a place safe
that the change reaches). Everything it cannot follow it must say out loud,
and keep out of "safe to skip".

To find out where that promise broke, we ran a probe. **Before** the fixes
below, 14 risky one-line PRs were run on OrderDesk, the proving-ground app.
The impact of each was written down from the code first.

## What the probe found

| Probe | What really changes | Before the fixes | After the fixes |
|---|---|---|---|
| An image in `public/` changed | what users see | **Silent**: "no app effect" (images were documentation) | Said: no screen skipped, confidence Partial |
| The navbar logo changed | every screen | **Silent** | Every screen, to test |
| An image on the product list changed (binary) | product list | **Silent** | Product list, to test |
| `docker-entrypoint.sh` changed | how the server starts | **Silent**: "no app effect" (scripts were tooling) | Deployment, to watch |
| `publishEvent(OrderPlacedEvent)` removed | no invoice, no notification | **Wrong skip**: both listeners "safe" | Both listeners **test first**: "never runs" |
| Gold discount changed (`PricingService`) | order totals, invoice amount | **Wrong skip**: invoice listener "safe" | Order list, detail, dashboard and invoice listener unclear: "shows Order data; this PR changes what is written to Order.total" |
| `order.setTotal(…)` removed | totals blank on new orders | **Wrong skip**: invoice listener | Same as above |
| Stock no longer reduced | product list stock, stock alert | **Wrong skip**: product list "safe" | Product list and stock alert unclear, with the write |
| Money pipe currency | every price | ✓ | ✓ |
| Global stylesheet (`angular.json` "styles") | every screen | Said, every screen unclear | Every screen, to test |
| `index.html` with `<app-root>` | every screen | Said, every screen unclear | Every screen, to test |
| Jackson naming strategy in `application.yml` | every JSON field | ✓ every screen | ✓ |
| A new translation file | labels | Said, unclear | Said, unclear |
| `angular.json` build option | the production build | Said, unclear | Said, unclear |
| A log line only | nothing a user sees | Two places listed (noise, safe) | Same |

Four classes of change were not handled. All four are fixed and now in the
proving ground as scenarios s26–s31:

1. **Data through the database.** Following callers finds who *runs* a
   change. It does not find who later *reads* what the change stored. Teslon
   now reads both sides of the diff for:
   - entity writes (`x.setField(…)`, `save`, `delete`);
   - a changed method whose result the caller writes straight into a field
     (`order.setTotal(pricing.orderTotal(…))`), even across lines;
   - a value set on the changed line and written later in the method;
   - the entity's own code.

   Every screen that calls an endpoint reading that entity, and every job
   that reads it, is held as **Unclear**, with the write as evidence. None of
   them is skipped.
2. **Events.** A changed or removed `publishEvent(new X(…))`, or a changed
   event class X, puts every listener that takes X on the test list. When
   nothing publishes X any more, the listener is **Test first**, with
   "Risk: it never runs".
3. **Images and fonts.** Images and fonts are documentation only in `docs/`,
   in `.github/` or at the repository root. Anywhere else they are assets:
   - an asset is followed to where the code names it, matching the path and
     not just the file name;
   - if nothing names it, it is said out loud and no screen is skipped;
   - binary files, which have no lines, are never "no app effect" by
     default.
4. **Scripts.** Any script whose name hints at starting, deploying or
   migrating is deployment. A script is tooling only when a whole word of its
   name says so (`lint`, `setup`, `format`). So `reconcile.sh` is not
   tooling. Anything else is not followed, and is said.

Scanning 60 real commits each of spring-petclinic-microservices and
jhipster-sample-app found four more bugs. In each, a cited line did not
re-check:
- a call chain written over several lines was cited on the wrong line;
- a navbar in a named router outlet was cited as a tag;
- a component drawn in a template was cited in its TypeScript file with the
  template's line;
- a deleted front-end file was cited at head.

All four are fixed. The same scan found one crash: removed code was
followed back to a scheduled job that the PR also removed, and the engine
looked for the job at head. The job is now listed, test first, as removed.
The final scans give 0 failed citations and 0 crashes on both repositories.
JHipster's 60 commits re-check every cited line, 8,042 of them on the
biggest commit alone. A failed citation was never silent: the report says
"Not proven" and the run exits 3.

## What each kind of change gets today

| A PR changes… | Teslon | How sure |
|---|---|---|
| A validation rule on a request | each field on each screen that sends it, with the value to try | Proven |
| A JSON field (rename, remove, retype) | the exact column, field or label that goes blank | Proven |
| An endpoint removed or moved | every screen still calling it: 404/405 | Proven |
| A column migration (Liquibase, Flyway) | the writers and the screens behind them | Proven |
| Method logic | followed through callers to APIs, screens, jobs, AI tools and other services | Followed |
| What gets written to the database | every screen and job reading that entity, held | Unclear, with the write |
| Events | the listeners | Followed |
| Config keys | the code that reads them; framework keys reach the whole service | Followed |
| Security config, dependencies | the module or the whole app | Followed |
| Front-end components, templates, pipes, services | the screens that run them, named field by field where typed | Followed |
| The app shell (interceptors, root template, `index.html`, global styles) | every screen | Followed |
| Images and fonts | where they are named | Followed |
| Deployment files and start scripts | watch after release | Followed |
| Docs, CI, lint and editor config, tests only | nothing to test, said with the reason | — |

## What is still not followed: always said, never skipped

When any of these changes, the lines are named under "Could not see", no
screen is skipped, and confidence reads **Partial**:
- translations;
- build configuration (`angular.json`, `tsconfig`, bundler settings);
- React front ends (detected, not read);
- Kotlin and other JVM languages;
- Python and other languages;
- scripts whose role is unknown;
- images nothing names.

Outside the repository, always listed with how to close it:
- other services and repositories;
- mobile apps and partner callers;
- the config server;
- data already in production;
- feature flags in a flag service.

## Where Teslon could still be wrong without knowing it

These are the places where Teslon believes it followed everything, so a
skip could still be wrong. They are next in line:

- **Calls the call graph cannot see:**
  - reflection;
  - Spring AOP aspects (`@Around`);
  - lambdas stored and called later;
  - call chains deeper than eight steps.
- **Writes and reads that skip the repository:**
  - `JdbcTemplate` and native SQL strings;
  - database triggers and views;
  - mappers (MapStruct, `BeanUtils.copyProperties`);
  - builders (`Order.builder().total(…)`).
- **Messages between services** (Kafka, RabbitMQ): listeners in this
  repository are followed; consumers in other repositories are not.
- **Behaviour that is not about where code runs:**
  - performance;
  - concurrency;
  - transactions (a removed `@Transactional` is followed as a change to the
    method, not as "partial writes on failure");
  - time zones beyond the `@JsonFormat` rule.

Each is a probe to write next, with the truth first, the same way.

## Precision still to gain (safe, but more to look at than needed)

- **Data is held at entity level, not field level.** When stock is no
  longer reduced, "Add product" is held too, though it shows no stored
  stock. The next step is the same field-level reading the response-shape
  delta already does, which would turn these into Test or Skip.
- **A screen that only imports a service is held** when another method of
  that service changed. Skips at member level are next.
