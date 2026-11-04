# What "perfect" means for Teslon

2026-11-04. Teslon tells a QA team, for one pull request:
- which areas of the application to **test**;
- which to **skip**, with proof;
- which it **cannot rule out**.

It is perfect when a team can act on every answer without checking it, and
never regret it. That breaks into rules that can be measured. Each rule has a
gate: a check that runs, and the number it must hit. A rule without a gate is
a wish, so it is not on this list.

## 1. Trust: hard gates (any miss blocks a release)

| # | Rule | Gate | Must be |
|---|---|---|---|
| T1 | **Never silent.** A change that alters what the app does always gets an area to test, an area held as unclear, or a named "could not see" | proving ground + probe catalog: SILENT | 0 |
| T2 | **Never a wrong skip.** No area the change reaches is called safe | proving ground + probes + bench: WRONG SKIP | 0 |
| T3 | **Every citation re-checks**: file, line and text at the exact commit | all suites + 60-commit history scans of every bench repository | 0 failures |
| T4 | **A Proven claim is true.** No false alarm stated as certain | proving ground: FALSE ALARM | 0 |
| T5 | **Never crash.** A file it cannot read becomes "could not see" | history scans + broken-input probes | 0 crashes |
| T6 | **Same input, same answer** | two runs, compared | identical, but for the time |
| T7 | **Confidence tells the truth.** High only when every changed line is followed and every front end is read; otherwise Partial, and the reason | tests | always |
| T8 | **Output is inert.** Repository text cannot inject markup, mentions or scripts; the cockpit loads nothing | tests | always |

## 2. Completeness: hard gates

| # | Rule | Gate | Must be |
|---|---|---|---|
| C1 | Every changed file is accounted for, with what was done with it | ledger tests | always |
| C2 | Every screen and job of the app gets exactly one answer: test, skip or unclear | scorer check on every run | always |
| C3 | The PR is exactly its own commits: open, behind main, merged three ways | proving-ground flows | always |
| C4 | Every kind of change a developer makes has a probe with truth written first | probe catalog, by logic tag | every logic unit in the engine has at least one probe |

## 3. Precision: tracked, with targets

A cautious answer is safe, but it costs testing time. These numbers are
measured on every run of the probe catalog and the proving ground.

| # | Rule | Measure | Target |
|---|---|---|---|
| P1 | Few screens to test that the change does not reach | extra screens marked test ÷ screens in the app | ≤ 5% |
| P2 | Few screens held as unclear that the change does not reach | held screens the truth calls unaffected ÷ screens | ≤ 10% |
| P3 | No noise on changes with no runtime effect (types only, dev tooling, an index) | probes marked quiet | 0 screens to test |
| P4 | The exact place: page → section → field, where the code types it | proving-ground ideals | every ideal met |

## 4. Usefulness

| # | Rule | Gate |
|---|---|---|
| U1 | Every case says what to do, what to expect, what it did before, and the risk | tests |
| U2 | What may break comes first | "Start here" ordering test |
| U3 | A lead can read the decision in ten seconds, in every output | report checklist (research/REPORT-CHECKLIST-2026-11-04.md) |

## 5. Robustness and speed

| # | Rule | Gate | Must be |
|---|---|---|---|
| R1 | A normal PR on a large app is fast | the slowest proving-ground run, and history-scan time per commit | ≤ 10 s typical, ≤ 2 min for a 1,500-file PR |
| R2 | Works on what real repositories hold: renames, binary files, submodules, unicode paths, monorepos, shallow clones | probes and legacy edge tests | pass |

## How the loop runs

1. Write a real developer PR, with its truth written from the code **before**
   Teslon runs (`bench/probes/catalog.mjs`, `bench/proving-ground/scenarios.mjs`).
2. Run everything:
   - `node bench/probes/run.mjs`;
   - the proving ground;
   - the bench;
   - the history scans.
3. Any trust or completeness miss is fixed in the engine, generally. A fix
   that only passes the one probe is not a fix.
4. Precision misses are fixed when the fix cannot cost trust.
5. Every rule's number goes in the scoreboard below. "Perfect" means every
   hard gate is met on every suite, C4 covers every logic unit, and every
   precision number is on target.

The scoreboard is kept in `research/PERFECTION-SCOREBOARD.md`, one row per
iteration.
