# Ticket gap report

The unit QA actually receives is not a diff. It is a **ticket**: the work is
done, its PR is merged to `main`, and QA is told "test X, Y and Z" — by the
ticket, the PR's testing notes, or a message from the developer. That list is
written from memory by the person who made the change. It is a floor, never a
ceiling, and nobody checks it against the code that actually merged.

This report does: **told scope vs true impact**, after the merge.

```
node research/ticket-gap/gap.mjs <repo> research/ticket-gap/ticket-558.json
```

## On a real ticket

[spring-petclinic-microservices #558](https://github.com/spring-petclinic/spring-petclinic-microservices/issues/558)
("Backend accepts pet birth dates in the future"), fixed by
[#559](https://github.com/spring-petclinic/spring-petclinic-microservices/pull/559),
rebase-merged as three commits (`dc9ca15..1d76b00`). Full output:
[`sample-558.txt`](sample-558.txt).

| | |
|---|---|
| Told and confirmed by code | 7 — both endpoints, the date rule on each, the name rule on update, both pet-form pages |
| **Missed** | **4** — below |
| Told but not in the merge | 0 |
| No path found | 7 pages, each with the reason |

What the merge reaches that nobody told QA:

1. **Name can no longer be empty on *create*.** The ticket says `@Size` on
   name was unenforced on *update*. The merge added `@Valid` to *create* too,
   so every rule on the create body is newly enforced — a behaviour change the
   ticket never mentions.
2. **The AI chat on every page can add pets** — `genai-service` calls the same
   create endpoint through service discovery, behind a Spring AI `@Tool`, wired
   into the chat client, exposed through the gateway and rendered by a
   component beside `<router-view>`. Its client calls `.retrieve()` with no
   4xx handling, so a rejected date now becomes an exception inside the chat.
3. **Existing pets with a future birth date can no longer be edited**, and
4. **existing pets with an empty name can no longer be edited** — with the SQL
   to count them on a copy of production.

The ticket also names an open issue (#557, the form shows no error on a
failed save); the report links it to the pages that will now receive 400s
instead of letting it be read as a pass or a fail of this ticket.

## The rules

- **Linking.** Commits in the range carrying the ticket key (`#558`, `ABC-558`)
  are counted. Here **0 of 3** do — a rebase merge dropped it — which is the
  commonest way a ticket loses code. The report says how it was linked.
- **Told → surfaces, by rule only.** Method + path matches an endpoint changed
  by the merge (path variables normalised); a handler name maps to its
  endpoint; a field name in the same sentence tells that field's rule; a
  component's name as a phrase (`pet form` → `PetFormPage`) tells its routes.
  URL paths are removed before the phrase match — `{ownerId}` and "form" once
  named the owner form from two unrelated words.
- **Told but not in the merge** is a red flag, not a footnote: either another
  PR or repository belongs to this ticket, or the instructions are wrong.
  [`control-told-not-merged.json`](control-told-not-merged.json) adds an owner
  endpoint the merge never touched; the report flags it
  ([`sample-control.txt`](sample-control.txt)).
- **Anything a rule cannot map is printed**, never dropped.

## What this is not yet

- The told scope is the ticket and PR text, restated; a real run reads them
  from Jira / GitHub. Free-text like "check the pet screens" maps only if a
  component or route is named — otherwise it is listed for a person to confirm.
- One stack (Spring + Vue/AngularJS) and one real ticket. Phase A of the
  roadmap turns this into a scored corpus.
