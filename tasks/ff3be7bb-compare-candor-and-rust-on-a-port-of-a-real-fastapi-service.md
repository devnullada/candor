---
status: open
area: Candor trials
list: Change trials
effort: bigger
paths:
  - trial-numbers/numbers.json
  - docs/trials.md
created: 2026-11-03
---

# Compare Candor and Rust on a port of a real FastAPI service

Tests the claim that Candor gives a Python backend most of Rust's gain at a lower cost to AI coders, because there's no borrow checker to fight. Hypothesis only; nothing measured yet (Pal, 2026-11-03).

Start it when the 10% budget has room after the side-effect review (#7bf0d715). That is a preference, not a blocker.

Choices:
- One open source FastAPI service with HTTP, SQL and some background work, and a permissive licence. Pick it with Pal.
- A model ports the Python original to both languages, so neither side is written by people. Headless Sonnet, the main agent for the change trials, steered and committed by the Candor session.
- Black-box tests over HTTP, so one set scores Python, Candor and Rust.
- Private, in the sibling `candortests/change` repo, like the other hidden tests. Candor keeps only the figures.

Scope:
- Both ports pass the shared tests, with `rust` added to the runner as a language.
- Port cost: tokens, turns and compiler runs to reach passing.
- Change cost: a few change requests with hidden tests, at least one crossing several modules, and at least one changing who owns or shares data, where Rust's cost should show.
- Runtime: throughput and memory for Python, Candor and Rust under the same load.

Open question for Pal: no benchmarks on this box, since it's shared with other work. Runtime figures need an exception (a quiet window) or another machine.

Done when: the figures are on this card with their sample sizes and any unwelcome result is reported as it stands. Publishing goes through numbers.json and docs/trials.md, and only if Pal wants it.
