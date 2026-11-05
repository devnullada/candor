<p align="center"><img src="assets/logo.svg" width="128" alt="Candor logo: a white C in a black circle, its left side broken by a green dot"></p>

# Candor

A backend language designed for AI coders. TypeScript-shaped syntax, Rust's discipline, compiles to Go.

Every function says openly what it does: the effects it may perform are part of its signature.

```
module hello

fn main() uses io {
  io.println("Hello, world")
}
```

New to it? [docs/start.md](docs/start.md) is one page on writing a service, every block of
code checked. See [docs/reference.md](docs/reference.md) for the methods of the built-in types and effects
(also `candor doc`), [docs/design.md](docs/design.md) for the principles and the decisions so
far.

## Why

An AI coder writes code that people review rather than write, and reads code it didn't write.
Candor puts what matters where both can see it:

- **Effects in the signature.** `fn handle(req: http.Request) -> http.Response uses sql` may
  use the database and nothing else; calling `io.println` in it is a compile error.
- **Errors are values.** `Result<T, E>`, `?` to pass one on, and an unused Result is an error.
  No exceptions.
- **Fakes built in.** In a test (in `x_test.candor`, beside `x.candor`) every effect is a fake: SQLite and the file system in
  memory, a virtual clock, seeded randomness, captured output. No mocking library.
- **Errors that carry their fix.** `candor check` reports every error at once, each with a
  stable code and a `help:` line written for the agent that reads it.
- **One Go binary.** Candor compiles to Go: a single native binary, and Go packages through
  bindings (`candor bind`).

## Status

Candor is 0.0.x: the language changes between releases. A change that breaks code comes with a
compiler error whose help line says the fix, and is listed in the release notes.

## Install

Candor builds with [Go](https://go.dev/dl/) 1.22+ (`winget install GoLang.Go`, `brew install go`).
Then one binary, for Windows, macOS and Linux:

```
curl -fsSL https://raw.githubusercontent.com/devnullada/candor/master/install.sh | sh     # macOS, Linux
irm https://raw.githubusercontent.com/devnullada/candor/master/install.ps1 | iex          # Windows
```

The scripts check the binary against the release's `SHA256SUMS` and install nothing if it
differs. Downloading by hand instead: `sha256sum -c SHA256SUMS --ignore-missing`. On macOS a
binary downloaded with a browser is quarantined; `xattr -d com.apple.quarantine candor` clears
it (the script's `curl` doesn't set it).

It writes the standard modules and the Go runtime under `~/.candor/<version>/` on first use
(`CANDOR_HOME` to move them), and removes older versions' folders then. `candor version` shows
the version and the Go it found.

### With an AI coder

Your agent won't know Candor from training; the compiler teaches it. `candor guide` prints the
language on one page for the installed version (`candor guide start` the long guide), `candor doc <name>` a type's methods, and every
error from `candor check` carries its fix. `candor init <dir>` starts a project with an
`AGENTS.md` that tells any coding agent to begin there (and a `CLAUDE.md` importing it).

In Claude Code, the `candor` plugin does the same wherever you are: say "rewrite this app in
Candor" and it reads the guide first.

```
/plugin marketplace add devnullada/candor
/plugin install candor@candor
```

## Usage

```
candor run examples/hello.candor      # compile and run
candor run app.candor -- -v in.txt    # what follows -- is the program's (env.args())
candor build examples/hello.candor    # native binary beside the file, named for its module (-o to name it)
candor build app.candor --target linux-x64   # for another system (no .exe off Windows)
candor debug app.candor               # under Delve: `break app.candor:12`, `continue`, `print total`
candor test examples/sessions.candor  # its tests, in sessions_test.candor beside it (--seed N replays a task order)
candor test file_test.candor:42       # the test holding line 42
candor test file.candor --only "expires" --json   # the tests named; a JSON line per test, then totals
candor test                           # every module with tests under this folder, then a total
candor check examples/hello.candor    # diagnostics only
candor check src                      # every .candor file under src
candor check file.candor --json       # machine-readable diagnostics
candor emit examples/hello.candor     # print the generated Go
candor bind github.com/dustin/go-humanize@latest   # draft a binding for a Go package
candor doc string                     # a built-in type's methods; `candor doc split` by name
candor outline src                    # each file's types and signatures with line ranges, no bodies
candor effects src                    # each pub function's effects, sorted; --json for a tool
candor effects src --check            # fail if they differ from effects.lock (--write updates it)
```

## Issues and contributions

Bug reports and ideas are welcome as [issues](https://github.com/devnullada/candor/issues). For a
bug: `candor version`, the smallest `.candor` file that shows it, and what the compiler or the
program printed (`candor check --json` for a diagnostic).

Pull requests aren't taken yet, while the design settles.
[CONTRIBUTING.md](CONTRIBUTING.md) covers running from a clone, the tests and the layout.

## License

MIT OR Apache-2.0, at your option: [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE).
