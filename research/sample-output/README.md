# Sample output

What the rebuilt engine is meant to print for a real PR:
[`pr-559.txt`](pr-559.txt), spring-petclinic-microservices #559.

It was assembled by hand from what the research prototypes already compute
(`page-impact`, `field-chain`, `form-guard`). Every `file:line` in it was
re-read at `1d76b00`, and two cited lines were corrected in that pass. It is
the target for stage 2–6. It is not what the shipped CLI prints today: on the
same PR, the CLI returns 127 files with nothing in Tier 1.

Updated after `research/MECHANISMS.md` attacked it: a rule-holes section, the UTC
boundary, the error banner (config repo read), the JMeter and seed-data checks,
and a corrected expectation for the chat. Claims marked "verified" were run on
the real customers-service.

Shape, top to bottom: what changed in behaviour → test first → rule holes → test next →
watch after deploy → do not test (and why) → could not see → who to ask →
trust. Each item to test is page → section → field → do → expect → why.
Effort is counted in test cases, never in hours.

## The designed report

[`report-mock-pr-559.html`](report-mock-pr-559.html) is the same findings as a
page (open it in a browser):

- **Verdict first.** Test 4, watch 2, skip 6, unseen 0, and every screen of the
  app as one block.
- **The app, X-rayed.** Every screen drawn from its real template, with the
  change flowing into it as a line, rule by rule. Selecting a screen opens its
  evidence line, hop by hop, each hop marked verified or derived.
- **Behaviour diff.** For each test case, what a person got before the merge
  and what they get now: a diff of experience, not of code.
- **Skip with proof**, and a trust ledger.
- **Four lenses:** manager, QA lead (adds told vs reached), QA engineer and
  developer (adds the code at every hop).

Design principles came from research into award-winning explanatory graphics:
NYT's "How the Virus Got Out" (one simple visual language for flow, each scene
building on the last), Harry Beck's tube map (topology over geography), Bret
Victor's explorable explanations (guided, but the reader explores), and the
scrollytelling guidance to use a stepper when states are discrete. Teslon's own
motion rule applies: motion only where it explains cause.

## The cockpit, for large PRs

[`report-cockpit.html`](report-cockpit.html) replaces the scrolling report with
one screen. Real PRs written with AI help carry dozens of behaviour changes,
and a page you scroll through does not survive that.

- **Top:** the verdict: test, watch, skip, conflicts, unseen.
- **Left:** every change, sorted by risk, with how far each one reaches.
- **Middle:** the whole app grouped by module (*App map*); change × surface
  (*Matrix*, where a column several changes meet on shows where they can
  interact); or a checklist (*Test plan*, ticks kept per viewer).
- **Right:** the selected screen's cases as before/after, and the evidence
  for each.
- **New:** *conflicts between changes in the same PR*. In the example, a new
  rule only allows birth dates up to today, while a new shared date picker only
  allows today onwards, so today is the only date a person can pick.

It switches between an **example** large PR (16 changes, 42 surfaces,
invented, labelled as such) and the **real** PR #559 (verified data).
