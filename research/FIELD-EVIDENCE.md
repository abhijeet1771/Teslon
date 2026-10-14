# Field evidence: how wrong blast radius ships bugs

What public postmortems, practitioner communities and empirical studies say
about bugs that reached production because nobody knew — or someone guessed
wrongly — what a change would affect. Each pattern ends in what Teslon must do
about it. Sources are linked inline; where only secondary write-ups were
reachable, that is said.

Reddit, Hacker News's search API and Cloudflare's blog were not reachable from
the research environment, so community material here comes through search
results rather than direct reading.

---

## The ten patterns

### 1. Two sides of a contract stop agreeing
- Azure: of 112 high-severity incidents caused by software bugs over six months,
  **data-format bugs** were among the largest categories
  ([Liu et al., HotOS 2019](https://blog.acolyer.org/2019/06/21/what-bugs-cause-cloud-production-incidents/)).
- Renaming a JSON field breaks every client that reads it; mobile clients lag
  because users update late ([HN discussion](https://news.ycombinator.com/item?id=20226269), [HN on Facebook API changes](https://news.ycombinator.com/item?id=45843440)).
- Our own test bed: adding `@Valid` to a pet-update endpoint silently enforced a
  `name` rule nobody wrote in the PR (`research/page-impact`).

**Teslon must:** build the contract graph (providers ↔ every consumer, across
gateways), propagate by direction (request rules reach writers, response
changes reach readers), and list consumers it cannot see.

### 2. The schema changes while running code still reads the old shape
- GitHub, Aug 2025: a dropped column the ORM still referenced raised errors
  across pushes, webhooks and pull requests
  ([GitHub availability report](https://github.blog/news-insights/company-news/github-availability-report-august-2025/)).
- Deno 2021, Buildkite, Val Town 2025, Buttondown: the same shape — migration and
  code out of step ([Deno](https://deno.land/blog/2021-07-27-outage-post-mortem),
  [Buildkite](https://www.buildkitestatus.com/incidents/8nd3cm8kqlnn),
  [Val Town](https://blog.val.town/post-mortem-db-migration),
  [Buttondown](https://buttondown.com/blog/incident-0034)).

**Teslon must:** map migrations to entities, ORM mappings and raw SQL; flag a
migration that the *previous* release's code cannot survive (expand/contract);
and, for a new constraint, emit the query that finds rows already breaking it.

### 3. Data or config wakes up a code path nobody tested
- CrowdStrike, Jul 2024: a content update used the 21st input of a template the
  sensor fed only 20; tests had used wildcards, so the path never ran
  ([CrowdStrike RCA](https://crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf)).
- Google Cloud, Jun 2025: a May code change without error handling or a feature
  flag sat dormant until a policy with blank fields reached it, then crashed
  globally ([Google incident report](https://status.cloud.google.com/incidents/ow5i3PPK96RduMcb1SsW),
  [Simon Willison's notes](https://www.simonwillison.net/2025/Jun/14/google-cloud-outage-incident-report)).
- Cloudflare, Nov 2025: a database permission change doubled a generated file
  past a hard limit in the proxy (secondary sources:
  [ilert](https://www.ilert.com/postmortems/cloudflare-global-outage-nov-2025),
  [HN thread](https://news.ycombinator.com/item?id=45973709)).

**Teslon must:** treat config and generated data as first-class nodes with
producers and consumers; flag new code paths reachable only through data the
tests do not contain; and flag new reads of new fields without handling for
absence.

### 4. A dependency moves and no source line does
- Spring Boot 3 → 4 with chaos-monkey left on a Boot-3 build; fixed nine months
  later as "405 errors" (our test bed, PR #563 in
  [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices)).
- 20.1% of non-major Maven releases contain breaking changes
  ([Ochoa et al., EMSE 2021](https://arxiv.org/pdf/2110.07889)).
- A routine payment-SDK bump blanked checkout on some Safari versions
  ([dev.to](https://dev.to/smilegupta/i-thought-it-was-a-safe-deploy-until-checkout-disappeared-cmd));
  a bundling change hid a checkout button ([Bolt](https://status.bolt.com/incidents/zy492y3p1kpb)).

**Teslon must:** diff build files and lockfiles, read each moved dependency's own
metadata for framework skew, and project to every page served by a module that
contains it.

### 5. Flags and dead code
- Knight Capital, 2012: a reused flag bit reactivated code retired in 2003 on the
  one server that missed the deploy (secondary:
  [Wikipedia](https://en.wikipedia.org/wiki/Knight_Capital_Group),
  [SEC order commentary](https://www.jrvarma.in/blog/Y2013/Knight-Capital.html)).
- Flag cleanup fails when the fallback value is wrong or old clients still
  evaluate the flag ([FlipperCloud](https://blog.flippercloud.io/feature-flag-fails-guardrails/),
  [Tggl](https://tggl.io/blog/how-to-remove-old-feature-flags-without-breaking-your-code)).

**Teslon must:** inventory flags a change adds, removes, renames or reuses, and
the code each one guards.

### 6. Parts deploy at different times
- Knight (eighth server), Deno (old instances), Buildkite (migration before code),
  mobile apps on old versions.

**Teslon must:** say when a PR spans several deployables, in what order they
must ship, and whether the change is compatible with the release before it.

### 7. Shared UI is everyone's UI
- Upgrading shared components across a site
  ([Khan Academy](https://blog.khanacademy.org/?p=382));
  design systems grade breaking changes by impact
  ([GitLab](https://design.gitlab.com/get-started/uik-breaking-changes)).
- Our test bed: a chat widget rendered beside the router is on every page.

**Teslon must:** resolve global components, layouts and shared styles to "every
page", and name it so.

### 8. Somebody depends on a behaviour you never promised
- Hyrum's Law: with enough users, every observable behaviour is depended on —
  ordering, status codes, error text
  ([Laws of Software Engineering](https://lawsofsoftwareengineering.com/laws/hyrums-law/)).
- Our test bed: an AI chat tool calls the pets endpoint only when the model
  chooses to.

**Teslon must:** flag observable-behaviour changes (status codes, ordering,
error messages) even when the signature is unchanged, and list runtime-decided
consumers as conditional.

### 9. The human channel is the weakest link
- Reviewers' central difficulty is understanding the change and its context;
  tools mostly show diffs ([Bacchelli & Bird, ICSE 2013](https://microsoft.com/en-us/research/?p=164195)).
- Developers' own test selection was unsafe 74% of the time
  ([Gligoric, 2015](https://users.ece.utexas.edu/~gligoric/papers/Gligoric15PhD.pdf)).
- Testers often never hear about changes; one developer does not know another's
  module ([softwaretestinghelp](https://www.softwaretestinghelp.com/impact-analysis-in-software-testing/));
  impact is settled in hand-offs and PR review
  ([Ministry of Testing club](https://club.ministryoftesting.com/t/for-regression-testing-purposes-what-is-an-effective-way-of-tracking-what-functionalities-are-changed-impacted-by-recent-dev-changes/73798)).

**Teslon must:** replace the hand-off — a plain-language brief on the PR, in the
ticket, and for the build QA is about to test.

### 10. The path existed, but nothing ever ran it
- CrowdStrike's wildcard tests; Google's path never exercised during rollout.
- Changes no test executed were about five times likelier to ship field bugs
  ([Eder et al., AST 2013](https://wwwbroy.in.tum.de/publ/papers/AST13Hauptmann.pdf)).

**Teslon must:** mark new branches and new data paths that nothing exercises,
and (later) prove execution with runtime coverage.

---

## What a QA engineer needs from Teslon — from their side of the desk

1. **A test brief, not a file list.** Pages, features and APIs to verify, in
   order, each with what to try and a one-line *why* that expands to proof.
2. **"Not affected — and why."** Permission to skip, with a reason. Time is the
   scarcest thing at release.
3. **The build, not just the PR.** QA tests an environment that bundles many
   merged PRs. "What changed on staging since the build I last tested" is the
   unit of work.
4. **Overlap.** Two PRs in one build touching the same page is where integration
   bugs live.
5. **Data checks.** Ready-to-run queries for rows a change will reject or break.
6. **Deploy notes.** Which services, in which order, which flags.
7. **Reverse lookup for triage.** "I found a bug on `/checkout` — which recent
   change could have caused it?" The same graph, walked backwards.
8. **Who to ask.** Owners per page and per service.
9. **What Teslon could not see,** said plainly per PR, never hidden.
10. **Where it lands.** PR comment, Jira ticket, the local app, and CI — no new
    place to remember to look.
11. **A loop that learns.** When a bug escapes, QA marks it; Teslon checks whether
    it was in the radius, and if not, which rule missed. Every escape becomes a
    test case.
12. **Evidence that verifies itself.** Every `file:line` re-read from git when the
    report is built, so a cited line can never be stale.
