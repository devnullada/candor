---
status: open
area: Tooling
list: Other editors
effort: evening
blocked-by: [e8e196bb, 4d63b50b]
paths:
  - editors/neovim/
  - editors/helix/languages.toml
created: 2026-10-28
---

# Set up Neovim and Helix for Candor

After going public. Both use the tree-sitter grammar and `candor lsp`.
- Neovim: an nvim-treesitter parser entry and highlight queries, an lspconfig entry (`cmd = { "candor", "lsp" }`, filetype `candor`); upstream PRs to both once it works.
- Helix: a `languages.toml` block (language, grammar source, language server) and the queries; upstream PR to helix.

Done when both highlight `.candor` and show diagnostics and hover from `candor lsp`.
