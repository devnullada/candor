---
status: open
area: Tooling
list: VS Code extension
effort: weekend
paths:
  - editors/vscode/src/client.ts
  - editors/vscode/src/server.ts
  - src/cli.ts
created: 2026-10-28
---

# Show diagnostics in VS Code through `candor lsp`

Phase 2. The LSP server (vscode-languageserver) imports `src/` directly; the client starts it as the extension host's child (`TransportKind.ipc`), bundled with esbuild. `candor lsp` (stdio) runs the same server for agents and other editors.
- Check a document on open and on change (debounced ~150 ms), with `compile`'s `read` hook so imports see unsaved edits.
- `CandorError` (syntax) and checker diagnostics map to LSP diagnostics: `code` = `CAN0005`, `source` = `candor`, `help` as related information. Columns are UTF-16 already: a test keeps it so.
- A change in an imported file re-checks its importers (the import graph from the last check).
- `extern` checks shell out to `tools/gotypes`: cache them, or run them on save only.

Done when the server's diagnostics for each `examples/*.candor` equal `candor check --json`'s, tested through the LSP protocol.
