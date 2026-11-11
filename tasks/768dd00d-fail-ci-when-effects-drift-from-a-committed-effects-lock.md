---
status: open
area: Tooling
list: CI and governance
effort: evening
paths:
  - src/effect-listing.ts
  - src/cli.ts
  - test/effects-lock.test.ts
  - docs/design.md
created: 2026-11-02
---

# Fail CI when effects drift from a committed effects.lock

The demo: a PR fails because an AI added `exec`, and adding `net` to a payment function is a one-line diff for the reviewer. Needs no GitHub API or server, only a CLI exit code and a committed file.

Scope: write the lock file; a check mode that exits non-zero on a mismatch and names the function and effect, with a help line saying how to accept the change.

Done when: tests cover a new effect, a removed effect and a clean run, and a sample PR shows the failure.

## Status (2026-11-05)
Committed locally (1d141f9), not pushed. Open only for the sample PR.

- `candor effects --write` saves `effects.lock` in the current directory; `candor effects --check` exits 1 and names each change, e.g. `pay.candor:7 charge: gained net`, with a help line. `--json` gives the changes on stdout.
- Only functions with effects are in the lock, without line numbers. A new function with no effects, a moved function or a private function's effect doesn't fail. A lost effect or a removed function with effects does.
- `--full` is refused with both. A syntax error writes nothing. `--write` and `--check` need the same paths: a check of a subset reports the rest as gone.

Checked: test/effects-lock.test.ts covers the above; full suite 944 pass, 1 skip, 0 fail on Windows, using a separate build cache because of Defender (see #80e2c3a6); typecheck.

Left: the sample PR. Decide where it lives: the workflow only runs on push, so a PR needs a `pull_request` trigger, and a deliberately failing PR on the public repo would be visible.
