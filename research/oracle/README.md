# Differential runtime oracle

Ground truth that does not come from Teslon. Run the app before and after a
change, crawl every page a logged-in person can reach by clicking, and diff
what they would see and what each page asked the server for.

```
research/oracle/run-case.sh <before.jar> <after.jar> <outdir> research/oracle/seed-jhipster.mjs
```

## First case: JSON rename on the JHipster sample (Angular, JHipster 9.4)

Mutation ([`cases/json-rename/mutation.diff`](cases/json-rename/mutation.diff)):
one line, `@JsonProperty("title")` on `BankAccount.name`. Truth
([`cases/json-rename/truth.txt`](cases/json-rename/truth.txt)), produced in
**96 seconds** with no Docker (JDK 21, Maven, Node 24, Playwright Chromium, H2):

| Page | What changed for the user |
|---|---|
| `/bank-account` | Name column empty on every row |
| `/bank-account/{id}/view` | Name gone |
| `/bank-account/{id}/edit` | Name field empty, **Save disabled**: the account can no longer be edited |
| `/operation` | Bank Account column empty |
| `/operation/{id}/view` | Bank Account link text gone |
| `/operation/{id}/edit` | Bank Account dropdown options all blank |

18 other stable pages are unchanged (labels, users, admin, account). One page
(`/admin/metrics`) is volatile and excluded.

**The product on the same change:** 12 files, all Java, Tier 1 =
`BankAccount.java`. **0 of the 6 pages.** It stops where the JSON crosses into
the Angular app, which is exactly the contract channel (5) the roadmap ports
first.

## What the spike taught the oracle, each found by it going wrong

1. **Volatile pages.** Live JVM metrics and logger lists differ between two
   crawls of the same build. A second crawl of the unchanged build measures
   the noise, and pages that differ there are excluded and listed. After this,
   two crawls of the same build differ on 0 of 23 stable pages.
2. **Data coverage.** The first run missed the operation list and view: the
   generated data links no operation to a bank account, so there was nothing
   to see. Seeding makes every relationship observable. The first seed used
   PATCH, which answered **200 and silently dropped the relationship**, so
   seeding now reads back and fails loudly.
3. **The write side is invisible to looking.** A renamed or newly required
   property only shows when something is saved. The crawl now presses Save on
   every edit page without touching anything. That is how "Save disabled"
   appeared.
4. **Saving changes state.** The second crawl of a used app saw the first
   crawl's saves, and two user pages looked "changed". Every crawl now starts
   on a fresh app with the same seed.
5. **The repo's Cypress suite cannot run here.** The Cypress binary download
   is blocked. The crawler is our own, which also keeps it independent of how
   the repo chose to test itself.

## Scoring rule this forces

The oracle's truth is a **lower bound**: it only knows pages it reached with
data that exercises them. When Teslon claims a page the oracle did not
observe, that claim is scored *unobserved*, not wrong, unless the crawl
reached that page with the relevant data present. Otherwise the oracle's blind
spots would be charged to Teslon.
