---
status: open
area: Modules
list: Todo
effort: bigger
paths:
  - std/sql.candor
  - src/checker.ts
  - runtime/go
created: 2026-10-28
---

# Support Postgres in sql

`$1` placeholders, a driver chosen from what `sql.open` is given, and tests that run on Postgres itself, since SQLite in tests would hide dialect differences. The SQL checker reads SQLite (affinity types, SQLite's functions); Postgres would need its own schema reader and function list beside it. (Raised 2026-10-25, card 039.)
