---
status: open
area: Tooling
list: VS Code extension
effort: weekend
blocked-by: [4d63b50b]
paths:
  - src/diagnostics.ts
  - src/checker.ts
  - editors/vscode/src/server.ts
created: 2026-10-28
---

# Attach structured fixes to diagnostics and offer them as quick fixes

Phase 3, a compiler change that helps `--json` consumers as much as the editor.
- `Diagnostic` gains `fix?: { message: string; edits: { span: Span; replacement: string }[] }`; `help` stays the human line. A fix only when it is mechanical and certain (`.toString()`, a habit name → the Candor name, a missing `uses x`, an unused `let` → `_`); anything needing judgment keeps `help` only.
- `--json` emits it; `formatHuman` can show the replaced line.
- The server turns fixes into quick-fix code actions, `isPreferred` when there is exactly one.
- design.md: which codes have fixes, and the rule for when a fix is allowed.

Done when each diagnostic with an obvious fix carries one, and a test shows applying the edits makes it go away.
