---
status: open
area: Tooling
list: Agents
effort: evening
paths:
  - plugins/
created: 2026-10-28
---

# Write a Gemini CLI extension for Candor

Pal (2026-10-28): adoption through Google's agent.

Scope:
- `editors/gemini/` (or beside the Claude plugin): `gemini-extension.json` and a `GEMINI.md` context file from the same source as the Claude skill, plus MCP tools if the Copilot card adds them.
- Submit to the Gemini CLI extension gallery.

After going public.

Done when: `gemini extensions install <public repo url>` works on a fresh machine and Gemini CLI writes a Candor program that passes `candor check` and `candor test`.
