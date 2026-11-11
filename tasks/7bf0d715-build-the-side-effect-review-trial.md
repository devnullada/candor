---
status: open
area: Candor trials
list: Change trials
effort: evening
paths:
  - ../candortests/change
created: 2026-11-02
---

# Build the side-effect review trial

Effects in signatures are Candor's main claim, and nothing measures them yet. An agent gets a diff and the codebase and answers: what side effects does this change add? Scored for correctness against a known answer, plus tokens used, Candor vs Go. The misses show what to improve: the outline, the effect names, the docs.

Scope:
- Diffs with known effects (none, database, network, clock, file system), written in advance for both languages and equivalent. Some must add no effect, or an agent answering "all of them" would score well.
- The change-trial codebases: supercronic, webhook, ntfy (3k lines of Candor, 9k of Go).
- A scorer that needs no judgement: the agent answers in a fixed format.

Done when: the runner scores a dry run on one diff per language.
