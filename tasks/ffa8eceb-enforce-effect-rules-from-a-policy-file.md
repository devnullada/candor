---
status: open
area: Tooling
list: CI and governance
effort: weekend
paths:
  - src/cli.ts
  - src/diagnostics.ts
  - docs/design.md
created: 2026-11-02
---

# Enforce effect rules from a policy file

Rules like "`payments` may not use `exec`", reported like any other diagnostic: a stable code and a help line that fits the case.

Open question for Pal: the file's format and name, and whether rules can also limit Go packages.

Done when: a violating module fails with its own code and the line that breaks the rule, with tests; design.md logs the decision.
