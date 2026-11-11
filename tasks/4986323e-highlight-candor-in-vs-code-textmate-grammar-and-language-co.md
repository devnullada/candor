---
status: open
area: Tooling
list: VS Code extension
effort: weekend
paths:
  - editors/vscode/package.json
  - editors/vscode/language-configuration.json
  - editors/vscode/syntaxes/candor.tmLanguage.json
created: 2026-10-28
---

# Highlight Candor in VS Code: TextMate grammar and language config

Phase 1.
- TextMate grammar: keywords, `uses` clauses (effects get their own scope so themes can color them), strings with `${}` interpolation and `"""` blocks, numbers with `_`, `//` comments, `test "name" { }` blocks, generics, `?`/`??`.
- Language configuration: brackets, `//` comments, auto-close, indentation on braces.
- `.candor` file association and an icon (the mark from `assets/`).
- A drift test: lex `examples/` with `src/lexer.ts` and check the grammar gives every keyword token a keyword scope.
- Build: `bun run vsix` in `editors/vscode/` gives `candor-x.y.z.vsix`; `code --install-extension`.

Done when every file in `examples/` highlights without obvious misses (by eye, then a few snapshots with `vscode-tmgrammar-test`).
