# Stage 0 bench

Scores Teslon against truth that Teslon did not produce.

```
npm run build
node bench/run.mjs --repo spm=<clone of spring-petclinic-microservices> \
                   --repo jhipster-sample-app=<clone of jhipster-sample-app> \
                   [--out bench/results/<date>.md] [case-id ...]
```

A repo not given with `--repo` is cloned from the case's URL. A case with a
`mutation` is built as a commit on top of `base` in a throwaway clone.

## What is measured

| | meaning |
|---|---|
| found | truth items the engine puts in front of a tester (screen, and the field when the truth names one) |
| silent misses | truth items missed where the change behind them is neither in the ledger as NOT MODELLED nor named as not visible. **The product's promise is that this is 0.** The run exits 1 if it is not. |
| wrongly skipped | truth items the engine marks as skip, with evidence. Worse than a miss, because the reader is told not to look. Also must be 0; the run exits 1 if it is not. |
| extra claims | things the engine asks to test that the truth does not list. Truth is a lower bound, so these are unconfirmed, not wrong. |
| wrongly flagged | items the truth says to skip that the engine asks to test |
| evidence re-read | cited lines that still say what the report claims at head |

The old engine answers in files. It is scored on the files each truth item
lives in, with tiers 1–3 counted as "asked to test". That is generous: a
page's file being on a list does not tell a tester what to do on that page.
The old engine has no ledger, so each of its misses counts as silent.

## Cases

| case | truth from | independent of the engine? |
|---|---|---|
| `spm-559` | hand-traced before the engine existed; form guard checked in a browser; 400s, rule holes and the UTC boundary checked with curl on the running service | **No.** The engine was built against this case, so 12/12 here is a regression baseline, not a recall measurement. One hand claim was wrong and is recorded in the case as a correction. |
| `jhipster-json-rename` | the differential runtime oracle (`research/oracle`): both builds run, every page crawled with seeded data, Save pressed on every edit page, noise removed with a third crawl | **Yes.** |

## First result (2026-10-22)

See [`results/2026-10-22.md`](results/2026-10-22.md).

| | found | silent misses | wrongly skipped |
|---|---|---|---|
| new engine | 12/18 | 0 | 0 |
| old engine | 5/18 | 13 | n/a |

On the independent case the new engine finds **0 of 6** pages: a renamed
response field reaching an Angular app is not modelled yet. It does not miss
them silently. The ledger marks `BankAccount.java` line 34 as NOT MODELLED,
so a reader is told that this change was not followed. Closing that case
needs two things: a response-shape delta (JSON names that a reader of the
response depends on) and an Angular reader. They are next on the roadmap.

The first run of the independent case found a worse failure than a miss. The
Vue reader picked up Angular route files and listed six Angular screens as
"skip: calls no API". In Angular the calls sit in services that the reader did
not follow, so the claim was false. Since then:

- Files of another framework are not read as Vue. They are named as an unread
  front end under NOT VISIBLE.
- A screen is skipped only when everything it imports was read and no data
  reaches it through a path the reader does not follow: stores, injected
  services, or URLs it cannot resolve. Any other screen is listed as "could
  not be ruled out".
- A function that passes its own parameter to `fetch` or `axios` is treated
  as a wrapper, and its call sites are the API calls. This is how spm's
  `request()` is found, with no names hard-coded.
- With no modelled change, nothing is ruled out.

The bench needs more independent cases before any recall number means
anything. The plan for them is in `research/PROVING-GROUND.md`.
