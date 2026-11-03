# Product decisions, 2026-11-03

These are the owner's answers, and the co-owner's calls where the owner said
"you decide".

## Who and what

- **Users:** QA engineers, QA leads, QA managers.
- **Unit of work:** one pull request, checked against `main`. It may be open
  or already merged.
- **The pain it removes:** a developer says "I changed this page, test it",
  and other places break unseen. Near a release there is no time to test
  everything. Teslon says, before testing starts:
  - what the PR impacts and how to test it;
  - what it does not touch, with proof, so it is safe to skip.
- **Not now:** Jira, TestRail and automation links. No pricing.

## Where it runs

- **In the customer's own GitHub Actions**, on the checkout the runner
  already has.
  - It runs on its own when a PR opens or updates, and by hand
    (`workflow_dispatch` with a PR number), for example on a merged PR.
- **Locally the same way**: `teslon pr 123` in a clone.
- **No Teslon server.** The code never leaves the customer's runner. The
  only network call is to the customer's own GitHub API, to post the
  comment. GitHub Enterprise Server works through `GITHUB_API_URL`.

## Where QA reads it

1. **The PR comment**, updated in place on every run:
   - the verdict;
   - "Start here" (the top cases);
   - a link to the full report.
2. **The run's summary page**: the full brief, grouped by screen. No
   download, and anyone with read access to the repo can open it.
3. **The HTML cockpit** as a run artifact, for the rich view.

## Co-owner's calls

**Stacks, in order.** Enterprise is mostly Java/Spring with an Angular, React
or Vue front end.

1. Spring + Vue (done).
2. Spring + Angular (screens, routes, resolvers, service calls, and typed field-level reads: done).
3. React / Next.js.
4. Node (Express, NestJS).
5. .NET.
6. Python.

Mobile comes after that.

**Success, measured.** Before rollout, run Teslon on the team's last 3 months
of merged PRs, next to their list of escaped bugs.

| measure | target |
|---|---|
| escaped bugs in places Teslon did not flag (silent misses) | 0 |
| what the developer said to test vs what Teslon found, per PR | gap shown on every PR |
| places skipped with proof, × minutes per place | time saved per release |
| report ready when QA opens the PR | before QA starts |

**Several repositories.**
- **v1:** one repository per run. Every other repository the code points to
  (a config repo, another service, a gateway) is named under "not visible",
  with how to close it.
- **v2:** `.teslon.yml` lists the linked repositories. The Action checks them
  out read-only and the engine follows contracts across them.

**Changes outside the code.**
- Everything in the PR diff is a change, and is followed: code, config, SQL,
  migrations, flags in files, deployment files.
- Anything outside the PR is listed as not visible, with a way to check it.
  This covers data in production, a flag flipped in a flag service, and a
  config server repository. For data, that means a query to run on a copy
  of production.

**A huge (AI-written) PR**, first screen:
- **One line:** how many places to test, how many skipped with proof, how
  many not visible, and an estimate in hours.
- **"Start here":** the 5 riskiest cases.
- **Modules,** with counts. Broad changes appear as one regression list each.
- **Everything else** one click away. The PR comment has a hard length cap.
  Detail lives in the summary page and the cockpit.

**Sign-off and audit.**
- **v1:** each run is the record. The PR comment history, the summary page
  and the artifact carry both commit SHAs, the Teslon version and the schema.
- **v2:** a QA lead comments `/teslon signoff`. GitHub records who signed
  off and when, so no database is needed.
