# The Teslon Grand Challenge

2026-11-16. This is a problem statement for the sharpest people we can reach: researchers in programming
languages, verification, testing and human factors, and inventors who solve problems from first principles.
It says what the problem is, why it is hard, what has been tried and where it stops, and what would count as
a solution, with proof. The evidence behind it is in
[LAUNCH-READINESS-2026-11-16.md](LAUNCH-READINESS-2026-11-16.md).

## The problem in one sentence

Given an application at commit **B** and a pull request that turns it into **H**, tell a tester, for every
place a user or another system can touch the app (a screen, a button, an API, a scheduled job, a message
handler), one of three things:
- **affected**, with the exact action to take and what will look different;
- **not affected**, with a proof a stranger can check;
- **cannot decide**, naming the one fact that is missing.

It must do this for any application, in any language and framework, without ever being wrong about
"not affected", and with "cannot decide" rare enough that the answer saves real testing time.

## Why it matters

When developers choose what to retest by hand, they miss needed tests in about a quarter of sessions
(Gligoric et al., ASE 2014). One industrial study found that about half of all changes reached production
untested, with up to five times the defects (Eder et al. 2013). Manual and exploratory testing is still most of
the testing in most companies: over 80% of teams in Katalon's 2025 survey rely heavily on it. Nobody tells
those testers, with proof, where a change can and cannot be felt. Every tool on the market either:
- needs the app instrumented and run first (SeaLights, Teamscale, Parasoft);
- gives a statistical guess (Launchable, Develocity); or
- gives an LLM's opinion (AI reviewers).

## The problem, stated precisely

- **Program:** two versions of the code, P_B and P_H, plus everything that decides behaviour at run time, E:
  configuration, profiles, environment variables, database schema and data, other services, and libraries.
- **Area:** an area A is a set of entry points (UI event handlers, routes, HTTP endpoints, schedules, message
  listeners) together with what an observer of A can see, obs_A. That includes the rendered page, HTTP
  responses, and the side effects A causes in data or messages.
- **Not affected:** A is not affected when, for every reachable state s and every input sequence a user of A
  can produce, obs_A(P_B, E, s) = obs_A(P_H, E, s).
- **Undecidable:** this is observational equivalence restricted to A. By Rice's theorem it is undecidable in
  general, so no tool can be both always right and always decisive.

**What a solution must output, for each area:**
- **NOT AFFECTED** only with a certificate C, such that a small, independently written checker
  K(P_B, P_H, assumptions, C) accepts it, and K is sound under stated assumptions about E;
- **AFFECTED**, ideally with a *witness*: a concrete user action sequence and the observation that differs,
  for example "Add Pet → Birth Date = tomorrow → Save: B saves, H shows an error";
- **CANNOT DECIDE**, with the missing fact named precisely enough that a person or a deploy-time check can
  supply it.

**Hard constraints:**
- **Deterministic.** The same input always gives the same output.
- **No language model in any decision.** Models may phrase text, never decide.
- **Offline.** It runs on the customer's own CI runner; the code never leaves it.
- **Fast and proportional.** Minutes per pull request on a 10-million-line repository, with cost
  proportional to the change, not to the repository.
- **Every claim checkable.** A tester who asks "why?" gets a chain of steps, each pointing at a line of code or
  a fact of the build, that they can verify themselves.

## Why it is hard: the walls we hit

Each of these is measured, not assumed. The reproductions are in the launch-readiness report.

1. **Undecidability.** Perfection in both directions is impossible. Every solution trades decisiveness
   for safety.
2. **Framework magic.** Most of what decides behaviour in a modern app is not visible as a call:
   - dependency injection;
   - routing by convention;
   - annotations read by reflection;
   - templates bound at run time;
   - proxies;
   - generated code.

   Teslon's hand-written readers knew 0 of 33 screens in one real Vue app, and 3 of 16 in one Angular app.
3. **The world outside the repository.** Behaviour depends on things outside the code:
   - configuration from environment variables, Docker Compose, Kubernetes and config servers;
   - database contents;
   - other services and third-party APIs.

   Teslon skipped jobs whose tax rate came from a docker-compose variable.
4. **Shortcuts that look safe.** Deciding "this file has no effect" by its name, folder or first characters
   produced wrong answers that looked sure of themselves:
   - a `requirements.txt` taken for documentation;
   - an `import` line ignored;
   - a `final` keyword not compared;
   - a `\u000a` inside a comment that javac compiles as code.
5. **A checker that shares the producer's eyes.** A second walk over the same facts agreed with every wrong
   answer. Independence must be in the facts, not only in the code.
6. **Polyglot, polyrepo systems.** A real system is several languages, several repositories and several
   services. A change in one can be felt in another that the analysis cannot see.
7. **Scale.** Reading a 35,000-file repository at two commits took more than 20 minutes.
8. **No ground truth.** No public dataset says which screens a given real pull request affected. Without
   one, no tool's accuracy can be measured, and every claim in the field is unverifiable.
9. **From code to the button.** Testers think in buttons, forms and screens; code thinks in functions. Joining
   "this method changed" to "click Save on the Add Pet form" needs a model of the UI itself.
10. **Trust.** People over-trust automation that looks authoritative, and abandon it after one visible miss. A
    proof is only useful if a tester can read it in under a minute.

## The open challenges

Each challenge is worth solving on its own. A solution to any one moves the field.

| # | Challenge | What a breakthrough looks like |
|---|---|---|
| C1 | **Universal, compiler-grade facts** | One way to get call, data, route and binding facts for any language and framework from what its own compiler, build tool or framework emits, without writing a reader per framework. |
| C2 | **Certificates of non-impact** | A proof format for "this area cannot see this change" that a checker of a few hundred lines can verify, independent of how the proof was found. |
| C3 | **"Nothing changed", beyond identical output** | A sound and cheap way to prove two versions behave the same for common edits (renames, reorderings, refactors) when their compiled output differs. |
| C4 | **From code to the button** | Derive, for any front end, the map from UI elements (button, field, link) to the code they run and the data they show, so impact can be stated as user actions. |
| C5 | **Witnesses of impact** | For each affected area, generate a concrete input or action sequence that shows the difference between B and H. That turns "test this page" into "do this, expect that", with proof. |
| C6 | **The world outside the repository** | Model configuration, data, other services and libraries as explicit assumptions. Each assumption is either checked automatically at deploy time or shown to a person as a short question. |
| C7 | **Cost proportional to the change** | Incremental analysis whose time and memory grow with the pull request, not with the repository, and that stays sound. |
| C8 | **Truth at scale** | A method and a public benchmark to measure the wrong-skip rate of any such tool on thousands of real pull requests, across stacks. The method needs no hand-labelling of every case and resists flaky tests and bad bug-tracing. |
| C9 | **Explanations people can check** | The shortest chain of reasoning that convinces a tester, and a way to show uncertainty that changes behaviour without being ignored. |
| C10 | **Learning without guessing** | Use history, runtime traces and past escapes to find what static reading missed (to raise recall), without ever letting a statistic stand in for a proof of "not affected". |

## What counts as a solution

An idea is accepted when it comes with all of these:

1. **A soundness argument.** What exactly is guaranteed, under which stated assumptions, and why: a theorem,
   a mechanised proof, or a reduction to a trusted component such as a compiler.
2. **A falsification attempt.** An adversarial test that would break the idea if it were wrong, and its
   result.
3. **Measured evidence on code its authors did not write.** Real open-source pull requests, with the truth
   written before the tool's answer is read. For a claim of "below 1% wrong skips at 95% confidence", at least
   299 independently checked real pull-request decisions per change category, with none wrong.
4. **A usefulness figure beside the safety figure.** The share of areas it proves "not affected", and the share
   it leaves "cannot decide". A tool that never decides is safe and useless.
5. **A cost bound.** Time and memory on a large repository.
6. **A reproducible artefact.** Code, data and commands that anyone can run.

## What already exists to build on

- **Teslon itself:**
  - readers for Java/Spring with Angular and Vue 3;
  - a skip certificate and checker;
  - a compiler oracle (javac and javap) with 434 mutants;
  - a red-team set of 60 adversarial pull requests;
  - field-test drivers for seven real repositories.

  See [GAUNTLET-2026-11-05.md](GAUNTLET-2026-11-05.md) and [CERTIFICATE-2026-11-05.md](CERTIFICATE-2026-11-05.md).
- **Fact sources:**
  - SCIP indexers (Java, Kotlin, TypeScript, Python, .NET);
  - the TypeScript type checker;
  - vue-tsc;
  - the Angular template type-checker;
  - Spring AOT bean definitions;
  - the Spring Tools index.
- **Ideas from research:**
  - safe regression test selection (Rothermel and Harrold; Ekstazi; STARTS);
  - reflection-aware selection (Shi et al. 2019);
  - framework modelling (JackEE, PLDI 2020);
  - trivial compiler equivalence (Papadakis et al. 2015);
  - change-kind catalogues (Liu et al. ISSTA 2023);
  - co-change vetoes (Rex, NSDI 2020);
  - configuration-aware selection (uRTS, ICSE 2023);
  - translation validation and the de Bruijn criterion.
- **Truth sources:**
  - per-request coverage (JaCoCo agents) while Playwright drives each screen;
  - Spring Actuator mappings;
  - mutation with a compiler oracle;
  - bug-fix commits traced back by hand.
