---
status: open
area: Tooling
list: Agents
effort: evening
paths:
  - plugins/
  - AGENTS.md
created: 2026-10-28
---

# Give GitHub Copilot the Candor instructions and MCP

Pal (2026-10-28): adoption through the agents developers already use. Copilot is Microsoft's.

Scope:
- A Copilot instructions file a Candor project can drop in (`.github/copilot-instructions.md`), from the same source as the Claude skill (plugins/), so the two don't drift. `candor init` writes it.
- VS Code agent mode speaks MCP: if the skill has tools worth exposing (check, test --json, doc), an MCP config for them.
- Submit to github/awesome-copilot once it works.

After going public (the instructions point at the public repo and docs).

Done when: Copilot agent mode in VS Code, given only the instructions file, writes a Candor program that passes `candor check` and `candor test`.
