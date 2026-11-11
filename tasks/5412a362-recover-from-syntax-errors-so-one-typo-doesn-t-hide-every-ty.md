---
status: open
area: Tooling
list: VS Code extension
effort: weekend
paths:
  - src/parser.ts
  - src/compile.ts
created: 2026-10-28
---

# Recover from syntax errors so one typo doesn't hide every type error

`CandorError` aborts on the first syntax error, so a half-typed line drops every type diagnostic in the file. In an editor that is most of the time. Parser recovery: skip to the next statement or `}` and carry on, reporting each syntax error and checking what parsed. Before hover and definitions (they need a tree while typing).

Done when a file with a broken line still gets the type errors in its other functions, from the CLI and the server alike.
