---
name: candor
description: Write, port, test and fix code in Candor, a backend language that compiles to Go. Use when the user mentions Candor or `.candor` files, asks for a service, API or tool in Candor, or asks to rewrite or port an app to Candor.
allowed-tools: Bash(candor *)
---

# Candor

Candor is new: you won't know it from training. Its compiler carries everything you need, for
the version installed. Don't guess the language from other languages; read the guide.

## Before writing any Candor

1. `candor version`. If it isn't found, tell the user to install it
   (`curl -fsSL https://raw.githubusercontent.com/devnullada/candor/master/install.sh | sh`, or
   `install.ps1` on Windows) and stop. It also needs Go, which `candor version` checks.
2. `candor guide`: the language on one page for an agent. Read all of it once. `candor guide service`
   has a whole service to start a new one from; `candor guide more` concurrency, tests and the
   standard modules (http, json, sql, fs, net, exec, time, flags, bytes, xml): read the part
   your work needs.
3. `candor doc <name>` when you need a type's or effect's methods (`candor doc string`,
   `candor doc List`, `candor doc tasks`), or every method of a name (`candor doc split`). The
   standard modules are documented at the top of their files; the guide gives their paths.
4. In existing code, `candor outline [file or dir]` first: each type, the pub signatures and every
   function's line range, tests counted. Read the ranges you need, not whole files.

## The loop

- After every edit: `candor check <file>`. Every error has a `help` line with the fix. Follow
  it rather than working around it.
- Tests are `test "name" { ... }` blocks in `x_test.candor` beside `x.candor` (same `module x`
  line; it sees x's private names), never in `x.candor` itself. Every effect (io, clock, http, sql,
  fs, net, exec, ...) is a fake there, set up from the test. `candor test <file>`;
  `candor test` alone runs every file's tests under the folder, with a total. Fixture files:
  `embed("testdata/a.xml")` (or `embed<Bytes>(...)`) builds them in; the test's fs is empty.
- `candor run <file> [-- args]` to run, `candor build <file>` for a binary.
- A new project: `candor init <dir>` writes `main.candor` and an `AGENTS.md` for other agents.

## Porting an app to Candor

1. Read the original first and list what it does from the outside: routes, inputs, outputs,
   status codes, files, environment, what it stores. That list is the spec.
2. Write the Candor version next to it (its own folder), keeping the original as it is.
3. Turn the list into `test` blocks: same requests, same answers.
4. Where Candor has no way to do something the original does, say so plainly to the user,
   rather than faking it.

## Gaps

Whenever Candor lacks something you need or gets in your way (porting or not), work around it
and tell the user what was missing or awkward and what you did instead. If the project says
where Candor gaps go (its CLAUDE.md or AGENTS.md: a task board, an issue tracker), put them
there as well. Never write into a clone of the Candor compiler or any folder outside the
project.
