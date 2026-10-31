# Trials

An agent writes an app from a spec, alone; hidden acceptance tests then check what it built.
The same specs and tests work for any language, so Candor can be compared with others later.

```
bun trials/run.ts bookings                 # one run: Candor, Claude Code (sonnet)
bun trials/run.ts jobs --lang go --runs 3 --agent claude --model opus --budget 20
bun trials/run.ts accept jobs trials/apps/jobs/reference   # just the acceptance tests on a program's directory
bun trials/run.ts refs                     # every reference against its tests: after a compiler or std change
bun trials/run.ts rescore jobs             # after a test changes: score every kept run again
bun trials/run.ts report                   # every run so far
```

## Apps

| App        | Tests                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| `bookings` | CRUD over SQLite, a transaction under 20 parallel requests, error mapping |
| `jobs`     | a worker pool, retries with backoff, timeouts, cancellation, shutdown   |
| `gateway`  | a rate limiter: sliding windows per key, 50 concurrent checks on one key |
| `logs`     | a command: an access log on stdin, a report on stdout, usage errors on stderr with a status |
| `pricing`  | rules applied in order with rounding, an order state machine            |
| `blobs`    | SHA-256 ids and base64 (a Go binding in Candor), SQLite across a restart, three or more files |

Each has `apps/<app>/spec.md` (what the agent gets), `acceptance.test.ts` (what it doesn't:
it starts the program and talks HTTP to it, or runs it with arguments and input, through
`harness.ts`) and `reference/`, a Candor build that passes them all, to check the tests
themselves. Folders the agent makes (a binding's `native/` Go) are kept with the run.

## Languages

| `--lang`  | Writes                          | Stack                                              |
| --------- | ------------------------------- | -------------------------------------------------- |
| `candor`  | `app.candor`, `app_test.candor` | the repo's docs, std and examples are copied in    |
| `go`      | `main.go`, `main_test.go`, `go.mod` | the standard library, modernc.org/sqlite (no cgo here) |
| `ts`      | `app.ts`, `app.test.ts`         | Bun's built-ins: `Bun.serve`, `bun:sqlite`          |
| `python`  | `app.py`, `test_app.py`         | the standard library                               |

The languages the model knows get the spec and the stack, nothing else. Compiler runs are the
agent's Bash commands that build, test or run the program (`compiler` in `run.ts`).

## A run

- A fresh directory under the system temp directory's `candor-trials` (`CANDOR_TRIALS_TMP` moves it) gets the spec
  and, for Candor, `README.md`, `docs/agent.md` (where the prompt starts it),
  `docs/agent-more.md`, `docs/agent-service.md`, `docs/start.md`, `docs/reference.md`, `docs/design.md`, `std/`,
  `examples/`, and `candor.cmd`. Not `src/` or `test/`. Once the run is kept and scored the directory goes, and anything still running from
  it is stopped; `--keep` leaves it.
- The agent runs there headless with the same prompt for every language (`run.ts`,
  `prompt()`) and the tools Read, Write, Edit, Glob, Grep and Bash. It writes the app, its own
  tests and `log.md` (what it tripped on).
- `--agent claude` (`agent.ts`): `claude -p` with none of the user's settings or MCP servers,
  and `--budget` in dollars. `--agent agy` (#1653f322): Antigravity's `agy -p`, Google's models,
  with its file and shell tools allowed (any path: its rules take an exact path or `*`), its
  sandbox and a 45-minute limit; no budget, and it reports no cost. Each agent reads its own
  transcript: tools, compiler runs, tokens, `reading`. Kimi Code ran card 093's trials and was
  dropped on 2026-10-28.
- Then the app is built and the acceptance tests run. `trials/runs/<app>/<lang>/<stamp>/` keeps
  the sources, `log.md`, `result.json` (time, cost, tokens, turns, tool and compiler calls,
  `reading`: the context the first file was written in, lines, tests passed and which failed) and `transcript.jsonl`. Runs stay on the machine that made them (`.gitignore`).

Runs are kept locally, not in the repo; `trial-numbers/numbers.json` keeps the figures computed from them.

## Changing an existing app

The change trial (an agent changes an app in its Go original and in its Candor port; method and
figures in [docs/trials.md](../docs/trials.md)) is kept out of this repo: its codebases are
third-party Go and model-written ports, and its hidden tests would leak into training data. Its
runner uses `harness.ts` and `agent.ts` from here. It started as `ntfy/` here (card 049).

