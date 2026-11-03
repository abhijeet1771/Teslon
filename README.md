# Teslon

**What a pull request changes for QA: what to test, how, and what is safe to skip, with proof.**

A developer says "I changed this page, test it". Three other places break and
nobody looks at them. Near a release there is no time to test everything.

Teslon reads the pull request against `main`, before anyone starts testing,
and says:

- **what it impacts**: page → section → field, API, data, jobs, the AI chat,
  dashboards, services and deployment;
- **how to test each one**: DO this, EXPECT that, and what happened before;
- **what it leaves untouched**, each with the reason and the line that proves
  it, so it is safe to skip;
- **what Teslon could not see**, said out loud with how to close it. It never
  stays silent.

Every claim cites `file:line`, and every cited line is read again at the
commit before anything is printed.

## What QA sees on the PR

One comment, updated in place on every push. This one is for a real PR
([spring-petclinic-microservices #559](https://github.com/spring-petclinic/spring-petclinic-microservices/pull/559)):

> ### Teslon · what PR #559 changes for QA
>
> | Test first | Test next | Watch after release | Safe to skip | Teslon could not see |
> |---|---|---|---|---|
> | **5 places** · 16 cases | 2 places · 2 cases | 1 place | 8 places, each with proof | 2 things |
>
> **Start here**
> 1. **Add Pet** `/owners/:ownerId/new-pet`: **Pet › Birth date**: Enter a date after today, press Submit. → **Expect** Rejected (400). _Before: Saved._
> 2. **Edit Pet** `/owners/:ownerId/pets/:petId`: **Pet › Birth date**: Enter a date after today, press Update Pet. → **Expect** Rejected (400). _Before: Saved._
> 3. **AI chat** (on every screen): Ask the chat to add a pet with a future birth date. → **Expect** A sentence saying it could not. Risk: an error, because the 400 is not handled. _Before: Done._
> 4. API `POST /api/customer/owners/{ownerId}/pets`: …
>
> **Safe to skip** (8): Welcome to Petclinic `/` · Owners `/owners` · Owner `/owners/:ownerId/edit` · Visits … · Veterinarians `/vets` · …
>
> **Teslon could not see** (2): callers outside this repository of POST /api/customer/owners/{ownerId}/pets … · runtime configuration in the config repository
>
> every claim cites the code: 70/70 cited lines re-checked at `1d76b00`

The run's **summary page** has the full brief:
- a checklist per screen;
- a "Why" fold on every case, with each step linked to the exact line;
- the safe-to-skip table with proof;
- every changed file, accounted for.

The run artifact holds **`report.html`**, the cockpit, as one offline file.
It has:
- "Start here" and the verdict;
- the test plan grouped by screen;
- Pass / Fail on every case, kept in that browser for that commit;
- an estimate from your minutes per case;
- "Copy checklist" and "Copy as CSV".

It loads nothing from the network.

## Set it up (GitHub Actions)

Copy [`examples/teslon.yml`](examples/teslon.yml) to
`.github/workflows/teslon.yml` in the repository you test. That is all.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr: { description: Pull request number (open or merged), required: true }

permissions:
  contents: read
  pull-requests: write

jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: abhijeet1771/teslon@main   # pin a commit SHA in production
        with:
          pr: ${{ github.event.pull_request.number || inputs.pr }}
```

- **Every PR** gets the comment when it is opened, updated or marked ready for
  review.
- **Any PR, by hand, including merged ones**: Actions → Teslon → *Run
  workflow* → type the number.
- **Fork PRs**: GitHub gives them a read-only token, so there is no comment;
  the summary page and artifact still have everything.
- **GitHub Enterprise Server** works as is (`GITHUB_API_URL`).

| Input | Default | |
|---|---|---|
| `pr` | the triggering PR | PR number |
| `base` | the PR's base branch | |
| `comment` | `true` | post or update the PR comment |
| `minutes-per-case` | — | your team's average; adds an hours estimate. Teslon never invents one |
| `working-directory` | `.` | where the repository is checked out |

The Action's outputs are `to-test`, `skipped`, `not-visible` and `dir`, so a
later step can gate on them.

## Run it locally

```bash
git clone https://github.com/abhijeet1771/teslon && cd teslon
npm ci && npm run build

cd ~/code/your-app                     # a clone with history
node ~/teslon/packages/cli/dist/cli.js pr 559              # or a PR URL
node ~/teslon/packages/cli/dist/cli.js pr 559 --out ./teslon-559   # open teslon-559/report.html
```

With `GITHUB_TOKEN` set, it reads the PR's title and base branch, and
`--comment` posts the comment. Without a token it works from git alone.

| Command | |
|---|---|
| `teslon pr [<number \| url \| branch>]` | a PR, open or merged, against its base branch |
| `teslon impact <base>..<head>` | the same for any two commits |

| Flag | |
|---|---|
| `--out <dir>` | write `report.html` (the cockpit), `comment.md`, `summary.md`, `report.json`, `report.txt` |
| `--html <file>` | write just the cockpit |
| `--comment` | post or update the one Teslon comment on the PR |
| `--summary` | append the brief to the GitHub Actions run summary |
| `--base <branch>`, `--base-sha <sha>` | when the base cannot be read from the PR or from git |
| `--evidence` | print every step of every chain |
| `--json` | the report (`teslon.impact/1`) |

Exit codes:
- **0**: done.
- **2**: Teslon could not run (it says why).
- **3**: some evidence did not re-check. The report names the lines. Please
  report it, because it is a Teslon bug.

## Which commits it compares

QA tests `main`, not the developer's branch, so a PR is checked where it
lands:

| The PR | Compared |
|---|---|
| merged with a merge commit | that merge against its first parent |
| rebase-merged | the commits it landed as, found by patch-id |
| squash-merged | the one commit that carries its whole diff |
| open | GitHub's test merge: the PR merged into today's `main` |
| open, with conflicts | its own branch; the report says how far behind `main` it is |

The first line of every report says which case it was.

## How it decides

- **Each changed line ends up in one of three places**:
  - **explained**: a typed change such as "now refuses future dates";
  - **followed**: traced to the APIs, jobs and screens that run it;
  - **named**: a status saying why it has no app effect, or that it was not
    followed.
  The ledger lists every changed file.
- **A renamed or removed JSON field is followed to each place that reads it.**
  A rename in Java is invisible to the Java build and to its tests: every
  screen that reads the old name just goes blank. For example,
  `@JsonProperty("title")` on `BankAccount.name` leads to:
  - the APIs that send or take it, including types that hold it, unless a
    `@JsonIgnoreProperties` on the way leaves it out;
  - the front-end type the page declares for that API;
  - each template read of `name`, typed by the TypeScript checker.
  Each case names the exact place: "Bank Accounts › Name column: blank",
  "Edit › Name field: empty, and Save is rejected because the name is
  required".
- **"Safe to skip" is strict.** A place is only skipped when:
  - every changed line was followed;
  - its screen's code was read completely;
  - nothing reaches it through data Teslon cannot read.
  Otherwise it is "could not be ruled out", never "safe".
- **Not visible is a result, not a silence.** Other repositories, production
  data, flags in a flag service, mobile clients and partner callers are listed
  with how to check them.
- **Your code stays on your runner.** No Teslon server, no model, no upload.
  The engine package makes no network calls; a test fails the build if it
  ever does. The only call out is to your own GitHub, to read the PR and post
  the comment.

## What it reads today

| | |
|---|---|
| Back end | Java / Spring: controllers, validation rules, services, records, `@ConfigurationProperties`, Spring AI tools, Maven. The JSON each type sends and reads, as Jackson writes it (`@JsonProperty`, `@JsonIgnore`, `transient`, `@JsonIgnoreProperties`) |
| Front end | **Vue**: routes, templates, forms, fields, components, the calls each screen makes. **Angular**: routes (lazy route files included), resolvers and guards, templates, components drawn by selector, service calls, and every template read typed by the TypeScript checker (the column, the value, the form field, the dropdown). React and AngularJS code is detected and named under "could not see" until its reader ships |
| Around the code | dashboards (PromQL panels), JMeter plans, Docker Compose and Kubernetes files, `pom.xml`, `package.json`, resources under `src/main/resources` |

The next stacks, in order, are React / Next.js, Node (Express, NestJS), .NET
and Python. A stack Teslon does not read yet is reported under
"could not see", so it is never silently skipped. See
[research/DECISIONS-2026-11-03.md](research/DECISIONS-2026-11-03.md) and
[ROADMAP.md](ROADMAP.md).

## Measured

- **Real history.** On 60 real commits of spring-petclinic-microservices:
  - 36 got places to test;
  - 20 were correctly "nothing to test in the app";
  - 0 cited lines failed to re-check
  ([research/coverage](research/coverage)).
- **Bench.** On the labelled bench ([bench/results](bench/results)), Spring +
  Vue and Spring + Angular:
  - 18 of 18 places found;
  - 0 silent misses;
  - 0 wrong skips;
  - every cited line re-checked.

## Layout

```
packages/core   the engine: deterministic, offline
packages/cli    teslon pr / impact, and the GitHub comment
action.yml      the GitHub Action
examples/       the workflow to copy
bench/          labelled cases the engine is scored on
research/       decisions, reviews, measurements
```

```bash
npm run build && npm test
```

The first engine (file radius, bands and tiers) is still available as
`teslon legacy <command>`; see [docs/legacy-engine.md](docs/legacy-engine.md).

## Honest limits

Teslon is built to be **safe**, not minimal. It aims never to call an
affected place unaffected. When it cannot tell, it says so instead of
guessing.
