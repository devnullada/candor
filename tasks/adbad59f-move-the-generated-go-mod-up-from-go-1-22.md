---
status: open
area: Modules
list: Todo
effort: evening
paths:
  - src/go.ts
  - README.md
  - CONTRIBUTING.md
  - test/http-served.test.ts
created: 2026-11-05
---

# Move the generated go.mod up from `go 1.22`

Found by the first CI run (#80e2c3a6, 2026-11-05). src/go.ts writes `go 1.22` into each program's go.mod (line 59, and line 217 for bind), so programs get that era's GODEBUG defaults, whichever Go builds them.

What showed it: Go 1.27.3 adds `httpservecontentmaxranges`, whose old default is 1 for modules below `go 1.26`. A request for several ranges now gets a 200 with the whole file, not a multipart 206. That's valid HTTP. test/http-served.test.ts sets GODEBUG to keep testing the multipart form; remove that once this is done.

Proposed: `go 1.26`. Pal asked for this card; the version hasn't been agreed yet.

Scope:
- List the settings in Go's internal/godebugs/table.go that change between 1.22 and the new line, and say which affect Candor programs. Not checked yet: only the range setting has been looked at.
- Check for language changes too: the go line also sets language version semantics for the generated Go and any local packages.
- Raise the minimum in README and CONTRIBUTING (both say 1.22+) and in the "Go not found" paths if they name a version. Say what someone on an older Go sees: Go may download a newer toolchain, or fail with no network.
- tools/gotypes/go.mod already says `go 1.26.0`, so `candor bind` and extern checks may already need 1.26. Check that, since it may mean the 1.22 promise is already untrue.
- Log it in docs/design.md, with tests.

Done when: generated programs use the new line, the http.served test passes without its GODEBUG, CI is green on all three systems, and the docs state the real minimum.
