# How Teslon answers "what does this PR affect?"

One input, a PR link, open or already merged. One output: everything QA has to
know, per role, with evidence. This page is the whole pipeline in one place,
and what "100% and no misses" can and cannot mean.

## The input

```
teslon pr https://github.com/acme/shop/pull/559
```

| PR state | How the change is recovered | No API needed? |
|---|---|---|
| Open | `refs/pull/559/head` against the base branch's merge base | yes |
| Merged with a merge commit | the merge commit, diffed against its first parent | yes |
| Squash-merged | the squash commit, diffed against its parent | yes |
| Rebase-merged | the PR's commits matched to main **by patch-id**, which survives rebasing. Proven on #559: 3/3 commits found | yes |

## The pipeline

```
 PR link
   │
 1 RESOLVE         open / merge / squash / rebase → exact base and head trees
   │
 2 WHAT CHANGED    lines → constructs → typed behaviour deltas
   │               "rule @PastOrPresent added to PetRequest.birthDate"
   │               "@Valid added to create → every rule on the body newly enforced"
   │
 3 INVENTORY       which coupling channels this repo uses (15 kinds: contracts,
   │               routers, data, config, async, caches, dashboards…); any channel
   │               without a rule is reported as NOT MODELLED before anything else
   │
 4 PROPAGATE       framework rules, direction-aware, across every repo given:
   │               DTO → endpoint → gateway → frontend call → route → page →
   │               section → field; service → AI tool → chat; entity → table →
   │               seed data; handler → metric → dashboard; config repo
   │
 5 REACH + INPUTS  can a person actually trigger it, and with what? client guards,
   │               rule semantics (null passes @Size), time zones → DO and EXPECT
   │
 6 RULE OUT        "not affected", each with a reason as strong as an "affected"
   │
 7 DECLARE         what code cannot show (production data, runtime-only behaviour,
   │               repos not given), each with what would close it
   │
 8 VERIFY + RANK   every file:line re-read from git; tiers, owners, effort, gate
   │
 report (CLI · JSON · local app · PR comment · JUnit)
```

## What each person gets

| | Gets | Example from #559 |
|---|---|---|
| **QA engineer** | Page → section → field → DO → EXPECT, and why; rule holes; what *not* to test and why | Add Pet › Birth date: pick a date after today → rejected, red "Bad Request" banner; in India 00:00–05:30, today is rejected too |
| **QA lead** | Tiers (test first / next / watch); what was told vs what the merge reaches; which existing tests cover what | Told 7 of 11; missed: the AI chat on every page, a nameless pet still saved through the API |
| **QA manager** | One-line risk; effort in test cases; owners; data to check before release; a CI gate; "could not see" | 8 cases · 2 SQL probes · owners from git history · 0 unexplained files |
| **Developer** | The same report from the code side: each hop as file:line | `ChatBox.js:47 → … → PetResource.java:58` |

The full target report for #559 is in
[`research/sample-output/pr-559.txt`](research/sample-output/pr-559.txt).

## "100%, with evidence, no misses": what is guaranteed and how

Three different promises. Only the first two can be absolute.

**1. 100% evidence: guaranteed by construction.** No claim without a chain of
`file:line` hops, each re-read from git when the report is built. A claim about
runtime behaviour is marked *verified* (it was run) or *derived* (it follows from
a named rule). A line that no longer matches is shown as unverified, never quoted.

**2. No silent misses: guaranteed by accounting.** Two ledgers must balance
before a report is printed:

- **Changed-construct ledger.** Every changed line belongs to a construct, and
  every construct is either claimed by a rule or listed as NOT MODELLED.
- **Channel ledger.** Every coupling channel the repo uses is either covered by
  a rule or listed, with the files that use it.

Unresolved call sites, dynamic strings and repos not given are listed too. So
the report can be incomplete, but it can never be incomplete *quietly*.

**3. Recall, meaning every real impact is found: earned and measured, never
assumed.** No tool can promise this for every possible change from code alone:
Rice's theorem, plus facts that live outside the code. What Teslon does instead:

- **Proving ground.** Real escapes from product histories, a published fault
  benchmark, and a runtime oracle that runs the app before and after injected
  changes.
- **Ratchet.** Every miss found there becomes a new rule *and* a regression
  case, so the same miss cannot happen twice.
- **Published numbers.** Recall is reported per channel. A channel with no
  cases yet is reported as untested, not as 100%.

## What a team gives Teslon for the best result

| Give | Closes |
|---|---|
| Every repo the change can reach (frontend, backend, config repo) | contracts across repos; runtime properties |
| CODEOWNERS | who to ask |
| Optional: a read-only copy of production | runs the data probes ("how many pets have a future birth date?") |

## Where this stands today

The shipped CLI does steps 1, 2 and 8 and a file-level version of 4, and it is
noise on real PRs: on #559 it returns 97 files with the pet form in Tier 4, and on the
oracle's JSON-rename case it finds 0 of the 6 affected pages. The research prototypes do steps
2–7 for one stack and produced the #559 report. The roadmap's stages turn the
prototypes into the engine and measure it on the proving ground:
[`ROADMAP.md`](ROADMAP.md#implementation-order).
