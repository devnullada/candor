---
status: open
area: Tooling
list: Highlighters
effort: evening
paths:
  - editors/highlightjs/candor.js
created: 2026-10-28
---

# Write a highlight.js language definition for Candor

After going public. One small JS file, so Candor snippets colour in the many Markdown renderers, forums and doc tools built on highlight.js. Keywords from `src/lexer.ts`, `uses` effects, strings with `${}` and `"""`, numbers with `_`, comments. Publish as a third-party grammar package and list it in highlight.js's SUPPORTED_LANGUAGES.

Done when every `examples/*.candor` highlights without obvious misses, and the package installs from npm.
