---
status: open
area: Tooling
list: Other editors
effort: weekend
blocked-by: [4d63b50b, 4986323e]
created: 2026-10-28
---

# Support JetBrains IDEs through LSP4IJ

After going public. GoLand and the other JetBrains IDEs, where Go developers live. Cheapest route: the free LSP4IJ plugin (Red Hat) runs `candor lsp` and takes the TextMate grammar for highlighting; document the setup, or ship a small plugin that bundles both. A native plugin (PSI, own parser) is much more and not planned.

Done when GoLand highlights `.candor` and shows `candor lsp`'s diagnostics and hover, with the setup in the README.
