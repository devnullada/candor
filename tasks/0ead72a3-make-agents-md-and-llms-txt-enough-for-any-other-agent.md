---
status: open
area: Tooling
list: Agents
effort: evening
paths:
  - AGENTS.md
  - plugins/
created: 2026-10-28
---

# Make AGENTS.md and llms.txt enough for any other agent

For Codex, Cursor and the rest that read AGENTS.md / llms.txt and nothing else.

Scope:
- `candor init` writes an AGENTS.md for the new project: what Candor is, where the docs are, `candor check --json` / `candor test --json` as the loop.
- The repo's own AGENTS.md stays for contributors; the project one is for users.
- Shares its text with the skill, Copilot and Gemini files (one source).

Done when: a project from `candor init` has the file, and an agent with nothing else loaded writes a passing program.
