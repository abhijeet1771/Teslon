# Coverage on real history

`node research/coverage/scan.mjs <clone> [n]` runs the engine on the last `n`
first-parent commits of `origin/main`, one commit at a time. For each commit it
prints the triage (`none` = no effect on the running app, `yes` = every changed
line explained or followed, `unknown` = some lines nothing followed), how many
places it asks to test and of what kind, and which files still have lines
nothing followed.

| date | repo | commits | none | yes | unknown | with places to test | evidence failed |
|---|---|---|---|---|---|---|---|
| 2026-10-22 | spring-petclinic-microservices | 60 | — | — | — | 3 | 0 |
| 2026-10-23 | spring-petclinic-microservices | 60 | 20 | 26 | 14 | 36 | 0 |

On 2026-10-22 only typed deltas existed, so 57 commits reported "not
modelled". The where layer (triage, changed code → APIs → screens,
dependencies → modules, deployment files) gives the other places. The 14
`unknown` commits come down to `application.yml` (config keys), `schema.sql`
(migrations), `logback-spring.xml`, the old AngularJS front end, and `wro.xml`.
Each of these is a channel on the roadmap, and each is named in the ledger
rather than skipped.
