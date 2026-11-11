---
status: open
area: Tooling
list: Highlighters
effort: weekend
paths:
  - editors/tree-sitter-candor/grammar.js
created: 2026-10-28
---

# Write a tree-sitter grammar for Candor

After going public. What Zed, Neovim and Helix highlight with, and GitHub's code navigation. `editors/tree-sitter-candor/`: `grammar.js`, generated parser, `queries/highlights.scm` (effects in `uses` get their own capture), corpus tests.

A second grammar beside the TextMate one: a drift test parses every `examples/*.candor` with no ERROR nodes, and checks keyword tokens from `src/lexer.ts` get keyword captures.

Done when every example parses clean and highlights in the tree-sitter CLI (`tree-sitter highlight`).
