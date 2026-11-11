---
status: open
area: Tooling
list: CI and governance
effort: evening
blocked-by: [768dd00d]
paths:
  - src/cli.ts
  - docs/design.md
created: 2026-11-02
---

# Record every extern and Go package in effects.lock

The checker can't see what Go code does: a module-level extern is vouched pure by its author, and Go inside an effect is checked only for types. So the audit surface is the `extern` blocks and the Go packages they name (design.md, "Go bindings"). Say that openly: this is not a sandbox.

Scope: list each extern block with its Go package and version in the lock file; a new or changed one fails the check until accepted.

Done when: adding an extern or bumping a version fails the check, and the failure names it.
