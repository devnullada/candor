---
status: open
area: Tooling
list: Highlighters
effort: evening
blocked-by: [4986323e]
created: 2026-10-28
---

# Get Candor into GitHub Linguist

After going public, and only once enough public repos use `.candor` (Linguist wants wide use, in the hundreds of repos, before it adds a language). Until then: a `.gitattributes` line in the public repo and in `candor init`'s output so `.candor` files show as code, not text.

The PR: languages.yml entry (extensions, colour: the logo's green, tm_scope), the TextMate grammar (or tree-sitter) as a grammar source, samples from `examples/`.

Done when GitHub shows Candor in the language bar and highlights `.candor` files.
