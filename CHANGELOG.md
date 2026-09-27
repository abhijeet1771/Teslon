# Changelog

Notable changes to Teslon. Dates are the day work landed, not a release.

## Unreleased

### Added
- Core engine: change resolution (merge base with progressive deepening on
  both refs; recovery for merge, squash and rebase merges), forward and
  reverse import graph, shared name index, capability profiles, coupling
  through shared database tables.
- `teslon analyze`, `teslon pr`, `teslon profile`.
- Sixteen tests, including one per invariant and one asserting core never
  imports a network module.
- CI on Node 20 and 22, with a check that every invariant still has a test
  asserting it.

### Fixed
- Prose containing a SQL verb ("Delete your account") was read as a
  statement, reporting a file as read-only that nothing had been learnt
  about. (I1)
- Dotfiles were excluded from the file listing, so a changed `.env` could
  never appear in a radius. (I1)
- The name index used a fixed cap of 12 files per token; on a 2,000-file
  repository every shared name exceeded it and the signal produced zero
  edges while reporting nothing. The cap now scales with repository size and
  discarded names are reported. (I1, I2)
- `possible` and `unknown` shared a rank, so the resulting band depended on
  which signal merged first. (I3)
- The declared auth guard name was lost to operator precedence, so every
  guarded handler reported the same string.
- git diagnostics leaked to stderr and a missing repository was misdiagnosed
  as unrelated branches.
- An unknown CLI command exited 0, so a typo passed silently in a pipeline.
