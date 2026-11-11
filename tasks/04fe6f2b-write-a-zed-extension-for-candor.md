---
status: open
area: Tooling
list: Other editors
effort: evening
blocked-by: [e8e196bb, 4d63b50b]
paths:
  - editors/zed/extension.toml
created: 2026-10-28
---

# Write a Zed extension for Candor

After going public. `editors/zed/`: `extension.toml` pointing at the tree-sitter grammar, its highlight queries, and `candor lsp` as the language server. Publish to Zed's extension registry (a PR to zed-industries/extensions).

Done when Zed highlights `.candor` and shows `candor lsp`'s diagnostics and hover.
