# Candor for an agent: more

The rest of [`docs/agent.md`](agent.md): effects in function types, concurrency, tests, the
standard modules. A whole service is [`docs/agent-service.md`](agent-service.md). Read the part
your change needs. Every block here compiles (`test/start.test.ts`).

## Effects in function types

A function type names its effects, `fn(string) -> string? uses sql`. A function that only calls
a function it was given writes `uses f` for that parameter, so it stays pure:

```candor
fn keyOf(id: string, lookup: fn(string) -> string?) -> string uses lookup {
  return lookup(id) ?? id
}

fn main() uses io, env {
  io.println(keyOf(env.get("USER") ?? "you", (_) => none))
}
```

A reader is `fn(int) -> Result<Bytes?, string>` (up to n bytes, `none` at the end), a writer
`fn(Bytes) -> Result<void, string>`; a function taking one writes `uses r`:
`fs.writing(path, (w) => save(db, w))?`, `bytes.collect((w) => save(db, w))` in a test. http
bodies too: `http.reading(req, (r) => ...)`, `http.writing(status, headers, (w) => ...)`; programs:
`exec.reading(cmd, (r) => ...)`, `exec.piping(cmd, (w) => feed(w), (r) => ...)`; a large XML
document: `xml.elements(r, ["item"], start, each)`.

A time is an `int` of milliseconds (`clock.now()`); `import "time"` formats and parses them.
`env.zone()` is the machine's zone (Go's `time.Local`); `clock.nanos()` times finer than a ms.

## Concurrency

Tasks live in a scope and end before it does: `tasks.scope((s) => { ... })`. They share only what
the scope makes:

- `s.mutex(v)`: `m.get()`, `m.update((v) => new)`, `m.updateWith((v) => (new, result))`. Check
  and change in one `updateWith`, never `get` then `update`. Its functions only compute (no
  effects, no other Mutex).
- `s.lock()`: `lock.hold(() => { ... })` for work under a lock that uses effects.
- `s.atomic(v)`, `s.channel(n)` (`send`, `recv() -> T?`, `close`, `for x in ch`).
- `s.spawn(f)` gives a `Task` (`join()`); `tasks.race([f, g])` (the first to finish cancels the
  rest; an `Err` doesn't finish it, the first `Ok` does, or the last `Err` once all failed), `tasks.timeout(ms, f)`.
- `s.background(f)`: a server, watcher or manager loop beside the work, cancelled once the
  scope's function has returned and its other tasks have ended (its `Err` still cancels the
  scope). No race or never-sent channel to keep one alive.
- `env.signals(s, [.Interrupt, .Terminate])`: a `Channel<Signal>` until the scope ends; read it
  in `s.background`. Tests send one with `env.sendSignal(.Interrupt)`.
- No handles that outlive a call: `lock.hold(f)` and `sql.transaction(f, ...)` are Candor's
  Begin/Commit/Rollback, ended when `f` returns.
- `defer { ... }` at the top of a function body runs however it ends, a cancel included: give
  back a slot taken from shared state there.

```candor
// limits.candor
// A limit on how many run at once: the place is taken and given back in one step each.
fn tryTake(running: Mutex<int>, limit: int) -> bool {
  return running.updateWith((n) => if n < limit { (n + 1, true) } else { (n, false) })
}

fn work(running: Mutex<int>) uses clock {
  defer {
    running.update((n) => n - 1)
  }
  clock.sleep(10)
}
```

```candor
// limits_test.candor
test "a third is refused while two run" {
  tasks.scope((s) => {
    let running = s.mutex(0)
    assert tryTake(running, 2) && tryTake(running, 2)
    assert !tryTake(running, 2)
    s.spawn(() => work(running)).join()
    assert running.get() == 1
  })
}
```

## Tests

A module's tests go in their own file beside it: `x.candor`'s in `x_test.candor`, which starts
with the same `module x` line and sees x's private names and imports. Never in `x.candor` itself
(CAN0063). `candor build` and `run` leave the test file out; `candor test x.candor` (or
`x_test.candor`, or `x_test.candor:42` for one test) runs it.

`test "name" { ... }` blocks hold `assert`s (on a failure it shows each part's value); `assert`
is for tests only. A `test fn` holds setup and checks several tests share; a `pub test fn` in a
module's own file is for other modules' tests.

In a test every effect is a fake: `io.output()` is what was printed; the clock is virtual and
starts at 0 (`sleep` takes no time); `random` is seeded; `sql` is SQLite in memory; `fs` is in
memory and empty; `http.respond(url, status, body)` answers the client; `exec.script(program,
lines, code)` says what a program prints; `env.set`, `env.setArgs`. Tasks run one at a time, in
seeded orders; `--seed N` replays one a failure printed. `embed("testdata/x.json")` builds a
fixture file in.

```candor
// greet.candor
fn greet(name: string) uses io {
  io.println("hi ${name}")
}
```

```candor
// greet_test.candor
test "greets" {
  greet("Ada")
  assert io.output() == "hi Ada\n"
}
```

Test a handler by calling it with an `http.Request { method, path, query: [:], headers: [:],
body }` rather than starting a server.

## The standard modules

`import "name"`, then `name.f(...)`. Each is documented at the top of `std/<name>.candor`.

| Module | For |
|---|---|
| `http` | `serve`, `route(req, "GET /items/{id}")`, responses, the client, `reading`/`writing` for large bodies, forms, SSE, WebSockets |
| `json` | `impl Json for T` derives it; `json.encode`, `json.decode<T>`, `json.Value` for any shape |
| `sql` | SQLite: `exec`, `insert`, `query<T>`, `queryOne<T>`, `transaction`; queries checked at compile time |
| `fs` | files: `read`, `write`, `append`, `sync`, `truncate`, `list`, `info`, `rename`, `watch`, `within` for paths from requests; `reading`/`writing` give a reader/writer |
| `exec` | run programs: `command`, `run` (a line at a time), `output`; `reading`/`piping` for stdout/stdin as a reader/writer; `withStop`, `withOwnGroup` for a gentle cancel |
| `time` | UTC and zones: `format`, `parse`, `parts`, `zone`, Go layouts; `Duration` (`"1m30s"`) |
| `flags` | `flags.parse(env.args(), Options { ... })?`: Go-style flags into a struct's fields; usage from its comments |
| `regex` | RE2: `compile`, `matches`, `find`, `replace`, `split` |
| `bytes` | `fromHex`, `fromBase64`, charsets, gzip, unzip; readers/writers in memory (`collect`, `reading`), `readLines`, `readAll`, `copy` |
| `hash` | `sha256`, `sha1`, `md5`, `hmacSha256`, `equal` |
| `crypto` | `deriveKey` (argon2id), `seal`/`open` (AES-GCM) |
| `url` | `parse`, `resolve`, `query`, `encode` |
| `xml`, `html` | parse to an `xml.Node` and write back; `html.toText`; `xml.elements` folds over a reader's `<item>`s |
| `net` | DNS lookups, `reachable` |
| `mime`, `imap`, `smtp` | mail: parse and compose, read a mailbox, send |

Built-in types (`string`, `List`, `Map`, `T?`, `Result`, `Bytes`) and effects (`io`, `clock`,
`env`, `random`, `tasks`) need no import: `candor doc <name>`.
