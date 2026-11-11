# Candor

A backend language for AI coders. The compiler is TypeScript, runs on Bun, and emits Go. See
`README.md` for usage, `CONTRIBUTING.md` for commands and layout. GitHub: devnullada/candor, branch `master`.

## Read first

- `docs/design.md`: every design decision, and "Open questions" at the end.
  A change that decides something (syntax, semantics, scope) gets logged there with its tests.

## Environment

- Repo is LF-only (`.gitattributes`). Edit with the Edit tool, not scripts in bash heredocs
  (backslashes get mangled).

## Commands

```
bun test             # compiler tests, examples with .out files, example test blocks, Go runtime
bun run typecheck    # tsc --noEmit
bun run numbers      # trial-numbers/numbers.json's measured figures (and the README's Numbers block, if it has one)
candor.cmd run|check|emit|test file.candor
```

## Pipeline

`src/lexer.ts` → `src/parser.ts` (AST in `src/ast.ts`) → `src/checker.ts` → `src/emit-go.ts`.

- Diagnostics have stable codes (`src/diagnostics.ts`) and a `help` line with the fix. New
  errors get help that fits the case, written for an AI reader.
- Emitter: `operands()` keeps left-to-right evaluation by hoisting earlier calls into temps.
  New expression kinds also need `callsSomething` and the assert-diagram walker.
- Go names are prefixed (`m__f`), so tests matching emitted Go must allow for it.
- A new built-in method or effect operation goes in `src/reference.ts` too (signature, line,
  example that runs), then `bun run reference`; `test/reference.test.ts` checks both.
- Tests go in `test/*.test.ts`; update an example if the feature shows off well.
