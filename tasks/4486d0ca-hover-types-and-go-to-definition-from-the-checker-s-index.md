---
status: open
area: Tooling
list: VS Code extension
effort: bigger
blocked-by: [4d63b50b, 5412a362]
paths:
  - src/checker.ts
  - editors/vscode/src/server.ts
created: 2026-10-28
---

# Hover types and go to definition from the checker's index

Phase 4.
- Compiler: `CheckResult` exposes a position index: for a `Pos`, the innermost expression or declaration, its type, and where its name was declared (local, fn, field, variant, imported module member). Built after checking from `types` and `refs`; not incremental.
- Hover: the expression's type; on a function, its full signature with `uses` and its doc comment; on an effect, its operations and whether a fake exists. Plain and complete, not truncated: an agent reads it as data.
- Go to definition and find references across imports; on an `extern`, to the binding.
- `editors/claude-code/`: the Claude Code LSP plugin config for `candor lsp` (definitions and hover are where agents gain).
- Speed: if a full check per keystroke is slow, cache each import's `CheckResult` by content hash before anything incremental.

Done when hovering every identifier in `examples/sessions.candor` gives a type and every definition jump lands on the declaring name, tested through the protocol.
