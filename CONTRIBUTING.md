# Contributing to Candor

Pull requests aren't taken yet, while the design settles; bug reports and ideas are welcome as
[issues](https://github.com/devnullada/candor/issues). What follows is for reading and running
the compiler from a clone.

The compiler is TypeScript, runs on [Bun](https://bun.sh), and emits Go; building programs needs
[Go](https://go.dev/dl/) 1.22+. Every design decision is logged in
[docs/design.md](docs/design.md), with the open questions at the end.

## Running from a clone

No build step: `candor.cmd` on Windows, `./candor` elsewhere. Both run
`bun --no-env-file run src/cli.ts`; without the flag Bun would load a `.env` into the program's
environment itself.

```
bun test                 # compiler tests, every examples/*.candor with a .out file built and run,
                         # every example's test blocks, and the Go runtime's tests
bun run typecheck        # tsc --noEmit
bun run reference        # regenerate docs/reference.md from src/reference.ts
bun run release          # the release binaries, into dist/
bun run numbers          # trial-numbers/numbers.json's measured figures
bun trials/run.ts refs   # the same-spec trial's references against their acceptance tests:
                         # after a change to std, JSON or the runtime
```

## Layout

```
src/lexer.ts        source → tokens (newlines end statements, except inside ( ) and [ ])
src/parser.ts       tokens → AST (src/ast.ts)
src/checker.ts      names, types, effects → diagnostics (codes in src/diagnostics.ts)
src/sqlcheck.ts     SQL queries checked against the tables the program's migrations make
src/exhaustive.ts   match exhaustiveness and unreachable arms (Maranget's usefulness)
src/emit-go.ts      checked AST → Go package main
src/effects.ts      the built-in effects and their Go runtime types
src/methods.ts      methods on built-in types (`n.toString()`, `s.split(",")`) and their Go translations
src/reference.ts    the reference: every built-in method's signature, doc and example (docs/reference.md)
src/compile.ts      reads a file and its imports, checks each module, emits one Go program
src/bind.ts         bindings checked against Go's types; drafts of new bindings
src/go.ts           runs Go: the build's module, `go get`, the type-reading helper
src/cli.ts          run / build / debug / test / check / emit / bind / doc / outline / guide / init / version
src/outline.ts      `candor outline`: types, signatures and line ranges, no bodies
src/home.ts         where std/, runtime/ and tools/ are: the clone, or written out by a release binary
src/guide.ts        `candor guide` (docs/agent.md; `more`: agent-more.md; `service`: agent-service.md; `start`: start.md; embedded), `candor init`
std/                standard modules, written in Candor: `import "json"` reads std/json.candor
runtime/go/         Go runtime: one interface per effect, real and fake implementations; tasks and
                    cancellation; the test scheduler and runner (go test ./... there)
examples/           .candor programs; examples/bindings/ has hand-written Go bindings
tools/release.ts    the release binaries (bun build --compile, std and runtime embedded)
tools/gotypes/      the helper: Go's type information as JSON (golang.org/x/tools/go/packages)
plugins/candor/     the Claude Code plugin: a `candor` skill (marketplace in .claude-plugin/)
trials/             agents given app specs or change requests, scored by hidden acceptance tests
                    (trials/README.md)
trial-numbers/      the trials' figures, for promotion
site/               candorlanguage.org: one Astro page (`bun run build`, `bun run deploy` in site/);
                    its example is checked by test/site.test.ts
```
