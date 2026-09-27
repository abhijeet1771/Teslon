# Teslon

**What a change can actually break.**

A developer changes one helper and tells QA to "just test the checkout page".
The real reach is four screens, an invoice PDF and an emailed receipt. Nobody
is hiding anything — nothing in the workflow walks the dependency graph
backwards, so nobody knows.

Teslon walks it backwards, and then keeps going where the graph runs out.

## Status

Early. The engine is being built against measurements taken first; see
`fixtures/torture` for the repository those measurements came from.

## Why it is not just an import graph

A reverse import graph — what "impact analysis" usually means — was measured
against a fixture containing eighteen ways a dependency can exist without an
import statement. It found **34.8%** of them. Adding layers for names,
templates, configs, generated code, widening and clones took that to **95.7%**,
and pushing to 100% nearly tripled the over-selection.

Those numbers are from a 32-file fixture. The recall findings transfer,
because a missed class of edge is missed at any scale. The selection figures
do not, and have to be re-measured on a real repository.

What the extra layers catch that imports cannot:

| Hidden by | Example |
|---|---|
| Dependency injection | `register('price', …)` / `resolve('price')` |
| String registries | `handlers['invoice.render']` read as `handlers[name]` |
| Event buses | `emit('order.paid')` / `on('order.paid')` |
| CSS | `.price-tag` in a stylesheet, `class="price-tag"` in a component |
| Database columns | a migration renames it, a raw query selects it |
| Translations | `t('cart.total')` against a JSON bundle |
| Generated code | a client built from `openapi.yaml` |
| Shared tables | one endpoint writes `orders`, another reads it — no code edge exists |
| Lockfiles | a transitive major bump with zero source files changed |

## Four invariants

Enforced by tests that fail the build, not by intent.

- **I1 — Unknown widens, never narrows.** A file no parser understood, an
  unresolved import, a missing adapter: all treated as affected.
- **I2 — Narrowing needs confirmed evidence.** Only an import edge confirmed
  by runtime coverage can remove anything from a test run.
- **I3 — Determinism.** Same repository, same commit pair, byte-identical
  result.
- **I4 — Every edge carries its reason.** No edge exists without the signal
  and evidence that produced it, at every hop.

A fifth rule has no test but governs the design: Teslon never guesses a change
set. If the merge base cannot be resolved it fails loudly rather than
reporting a confident wrong answer.

## Try it

```bash
npm install
npx tsc -b packages/core packages/cli

TESLON_ROOT=fixtures/torture node packages/cli/dist/cli.js analyze src/services/PriceService.ts
```

```
changed: src/services/PriceService.ts
radius:  10 file(s) reached of 33

  hop 1  src/pages/CheckoutPage.ts        import: imports ../services/PriceService
  hop 2  src/handlers/InvoiceHandler.ts   name: shares the name "price"       (through bootstrap.ts)
  hop 2  src/handlers/PaymentHandler.ts   name: shares the name "order.paid"  (through ReceiptEmail.ts)
  hop 4  src/services/jobRunner.ts        import: imports ../handlers/registry (through registry.ts)
```

The two `name:` rows are a dependency-injection key and an event topic. No
import graph can reach either.

```bash
TESLON_ROOT=fixtures/api node packages/cli/dist/cli.js profile api/cancelOrder.ts
```

```
┌─ api/cancelOrder.ts
│ endpoint     POST /api/orders/:orderId/cancel
│ nature       mutating  ← treated as state-changing
│ writes       orders, refunds
│ effects      sends email, emits event order.cancelled, touches payments
│ auth         none declared
└─ errors      —
```

Extracted, not guessed — every field comes from something the code declares.
No model is involved.

## Commands

| Command | Does |
|---|---|
| `teslon pr [base] [head]` | Analyse a branch against its merge base |
| `teslon analyze <file…>` | Blast radius for specific files |
| `teslon profile <file…>` | What a file does: endpoint, reads, writes, effects, auth, flags |

## Layout

```
packages/core   the engine — deterministic, offline, no globals
packages/cli    the commands
fixtures/       the repositories the measurements were taken on
```

`core` making a network call fails the test suite. Your code stays on your
machine.

## Tests

```bash
npm run build && npm test
```

## What is coming

The local app (`teslon ui`) for people who do not run CI: keep a clone of
main, paste a pull request link, get a brief in plain words. Then the CI
check, then the coverage oracle that grades Teslon's own accuracy on every
build.

## Honest limits

Teslon is built to be **safe**, not **minimal**. It aims never to call an
affected area unaffected. It cannot promise the smallest possible list, and
any tool claiming otherwise is not measuring itself.
