---
status: open
area: Tooling
list: VS Code extension
effort: weekend
blocked-by: [4d63b50b]
paths:
  - editors/vscode/src/client.ts
created: 2026-10-28
---

# Run Candor tests from the editor

Phase 5.
- CodeLens on each `test "name"`: "▶ Run" and "Run with seed…", running `candor test file --only "name" --json`; pass/fail inline. A failing `assert` shows its per-part values as a diagnostic on its line.
- VS Code's Testing view (`vscode.tests`): every test in a file in the tree.
- Panics in the output link to Candor lines (they name them since card 020).

Done when a file's tests run and report from both the CodeLens and the Testing view.
