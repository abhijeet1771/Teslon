# What a Teslon report must do: the co-owner's checklist

2026-11-04. Teslon is an enterprise tool that every team runs on every PR. The
report has one job:

> **Before release, tell QA which areas of the application to test, which to
> skip, and why each answer can be trusted.**

Everything on the report either serves that decision or is one click away
from it.

Each item is scored twice:
- **Before**: the report as it stood in the morning (cockpit v3, which was a
  list of places by tier, and the PR comment).
- **After**: the redesign the same day.

The marks are:
- ✓ done;
- ◐ partly done;
- ✗ missing.

## A. The decision, in the first ten seconds

| # | The report must… | Before | After |
|---|---|---|---|
| A1 | Give one verdict for the **whole application**: N areas to test, M safe to skip, K Teslon could not judge | ◐ Only touched places were counted | ✓ Test · Skip · Unclear lead every output, as three equal figures |
| A2 | Say **how sure** it is, in words, next to the verdict | ✗ Buried in a note | ✓ High / Partial / Not proven, with the reason in one line, under the verdict |
| A3 | Say **what the PR changes**, in plain lines, before any list | ✗ Hidden in "Changed files" | ✓ "What this PR changes", each change marked Proven or Followed, with the areas it reaches |
| A4 | Put **what the developer said** next to **what Teslon found** | ✗ | ✓ The PR description (or the commit messages), and "Not named in the PR: …" for modules the change reaches that the words leave out |
| A5 | Give effort in the team's own unit and a risk level | ◐ | ◐ Cases, then hours at the team's minutes; risk is "N first", not a separate level |

## B. The application map: coverage, not a list

| # | The report must… | Before | After |
|---|---|---|---|
| B1 | Show **every** screen, API and job, so QA sees what was considered as well as what was hit | ✗ | ◐ Every screen and every job is on the map. APIs appear when the change reaches them; untouched APIs are not listed yet |
| B2 | Group areas the way the team thinks: by module, using page titles and routes | ✗ By tier | ✓ Modules come from routes and paths (Customers, Orders), and the root screen is named as the app names it |
| B3 | Give every area exactly one answer: **Test**, **Skip** or **Unclear** | ◐ | ✓ The engine now emits the screens it holds back (`held`), each with why; nothing is left in a sentence |
| B4 | Let a lead see the shape of the release at a glance | ✗ | ✓ A tile per module, a square per area, coloured and patterned by answer |

## C. What to test, and how

| # | The report must… | Before | After |
|---|---|---|---|
| C1 | Name the place down to page → section → field | ✓ | ✓ |
| C2 | Say DO / EXPECT / BEFORE, with the **risk** stated apart | ✓ | ✓ |
| C3 | Put the riskiest first; "Start here" is the first five | ✓ | ✓ |
| C4 | Show a change that many places run without a wall of text | ✓ Regression lists | ✓ Each place is one area on the map with its one check |
| C5 | Say what data and which role the test needs | ✗ | ✗ Next |

## D. What to skip: half the value, equal billing

| # | The report must… | Before | After |
|---|---|---|---|
| D1 | Show skips **as prominently as** tests | ✗ Under "Also" | ✓ An equal figure in the verdict, a square on every tile, a row in every module |
| D2 | Give each skip a reason in plain words | ✓ | ✓ |
| D3 | Back each skip with the lines that show it | ✓ | ✓ |
| D4 | State the skip rule once, so a lead can defend it | ✗ | ✓ On every skip, in "How sure", and at the end of the summary |

## E. Evidence and confidence

| # | The report must… | Before | After |
|---|---|---|---|
| E1 | Make every claim cite file:line at the exact commit, re-read before printing | ✓ | ✓ Held screens and jobs are re-read too |
| E2 | Mark **how each claim is known**: **Proven** (a typed rule: validation, JSON field, removed endpoint, migration) or **Followed** (the change runs there; what it does is not typed) | ✗ | ✓ On every case and every change |
| E3 | List what it could not see, each with how to close it | ✓ | ✓ Without repeating what the map already shows |
| E4 | Account for every changed file | ✓ | ✓ |
| E5 | Show its measured accuracy | ✗ | ◐ "How sure" states the proving-ground bar that CI holds every build to. The external bench numbers are in the repository, not in the report |

## F. Daily use

| # | The report must… | Before | After |
|---|---|---|---|
| F1 | Give the same verdict in the PR comment, the run summary, the terminal and the cockpit | ◐ | ✓ All four are built from one brief |
| F2 | Let QA mark Pass / Fail, see progress, and export a checklist or CSV | ✓ | ✓ Unclear areas get a "check it once" mark; the exports carry module, area, answer and how it is known, and list the skips |
| F3 | Open on any device, with nothing installed | ✓ | ✓ |
| F4 | Keep a huge PR's first screen as short as a small PR's | ✓ | ✓ The comment shows at most 12 modules |

## G. Enterprise

| # | The report must… | Before | After |
|---|---|---|---|
| G1 | Keep the code on the runner: offline, no external loads | ✓ | ✓ |
| G2 | Carry an audit record: PR, both commits, version, schema, time | ◐ No time | ✓ |
| G3 | Give the same answer for the same input | ✓ | ✓ The time in the audit line is the only difference between two runs |
| G4 | Be accessible (contrast, keyboard, 44 pt targets, reduced motion) | ✓ | ✓ Answers carry an icon and a pattern, not only a colour |

## Trust problems the redesign exposed, and fixed

Laying every area out with one answer showed three things the old list hid:

1. **Jobs were skipped when changed lines had not been followed.** Screens
   were held back in that case, but a job that ran none of the *followed*
   code was still called safe. Now a job is held exactly like a screen: it
   is Unclear, and confidence says Partial.
2. **The "not followed by this build" list was out of date.** It still said
   migrations and configuration keys were not followed, though both have
   been followed since the proving ground. It now matches what the build
   does.
3. **A job's skip reason could read "uses none of" and stop.** That happened
   when the change was not a request rule. It now says "runs none of the
   changed code".

## Still to do

- C5: say the data and the role a case needs.
- B1: list untouched APIs as skips, with the same proof as screens.
- A5: decide whether a release-risk level adds anything beyond "N first".
