# Candor for an agent

Candor is a backend language that compiles to Go. It is new, so you won't know it from training;
this page is the least you need to read and change Candor code. Every block here compiles
(`test/start.test.ts`). More when your change needs it:

- [`docs/agent-service.md`](agent-service.md): writing a new service. A whole one (HTTP, JSON,
  SQLite) with its test, the http/json/sql calls it reaches for, shared state and a shutdown.
- [`docs/agent-more.md`](agent-more.md): concurrency (tasks, Mutex, limits), tests and their
  fakes, the standard modules.
- [`docs/reference.md`](reference.md): methods of the built-in types and effects. Search it:
  `candor doc string` prints one section, `candor doc split` every method of that name.
- `std/<name>.candor` documents a standard module at its top.

In a codebase you're changing, the code around you is the best example, and modules are long:
`candor outline` first (types, pub signatures, every function's line range), then read only
the ranges you need.

## The loop

```
candor outline               # every file under this folder: types, signatures, line ranges
candor check app.candor      # every error at once, each with a `help:` line: the fix
candor test app.candor       # its tests, in app_test.candor beside it; app_test.candor:42 runs one
candor build app.candor      # a binary
```

Write the change, `check`, do what the help lines say, check again. On Windows the CLI may be
`./candor.cmd`. Every error has a stable code and a `help` line with the fix: follow it rather
than working around it.

## Coming from Go

| Go | Candor |
|---|---|
| `func f(a int) (string, error)` | `fn f(a: int) -> Result<string, MyError>` |
| `x := 1`, `var x int` | `let x = 1`; `let mut x = 0` to reassign or change in place |
| `if err != nil { return err }` | `let v = f()?` (same error type; `.mapErr(...)` converts) |
| `nil`, `*T` for "maybe" | `T?` with `none`; no pointers |
| `type T struct{...}`, methods on `T` | `struct T { ... }` and plain functions: `area(s)`, not `s.area()` |
| `const ( A = iota ... )` | `enum State { Queued Done }`, written `State.Queued` |
| package-level `var days = []string{...}` | `const days = ["sun", "mon"]`: lists, maps, records of constants, function names; never changed |
| interface with variants, type switch | `enum` with fields, `match` (must cover every case) |
| `for k, v := range m` | `for (k, v) in m` (insertion order); `for i in 0..n` |
| `go f()`, `sync.Mutex` | tasks in a scope: `s.spawn(f)`, `s.mutex(v)` (agent-more.md) |
| `fmt.Sprintf("%d", n)` | `"${n}"`; `"""raw ${x}"""` for JSON and regexes |
| `x_test.go`, `func TestX(t *testing.T)` | `x_test.candor` (same `module x` line), `test "x" { assert ... }` |

```candor
enum Shape {
  Circle { r: int }
  Rect { w: int, h: int }
  Dot
}

fn area(s: Shape) -> int {
  return match s {
    Shape.Circle { r } => 3 * r * r,
    .Rect { w, h } => w * h,
    .Dot => 0,
  }
}
```

What trips a Go reader:

- **Values, not references.** A function can't change its caller's list or struct: it returns a
  new one, `Point { ...p, x: 1 }`. Shared, changing state is a `Mutex` from a task scope.
- **No shadowing.** A `let` can't reuse a name in scope, functions and modules included.
- **Enum variants carry their enum**: `State.Done`; `.Done` where the type is known, patterns
  too (`Err(.NotFound)`). A pattern names the fields it needs: `.Bad { why }`, `.Bad { _ }`.
- **Structs give every field**, except `T?` ones, `none` when left out.
- **`pub`** marks what a module shares, fields one by one. `import "cron/parse"` reads
  `cron/parse.candor` beside the importing file, used as `parse.f(...)`.
- **Newlines end statements**, except after an operator, `,`, `=` or an open bracket, and before
  a line starting with `.method`.
- **Indexing gives an optional**: `xs[5]` and `m["k"]` are `T?`. `m[k] = (m[k] ?? 0) + 1`, no
  `+=` on a map item. An empty literal needs a type: `let m: Map<string, int> = [:]`.
- **`int` and `float` never mix**: `n.toFloat()`, `f.round()`.
- **Lambdas**: `(x) => x * 2` or `(x) => { ... return y }`; can't assign a captured `let mut`.

```candor
let xs = [3, -1, 2]
assert xs.filter((x) => x > 0).map((x) => "#${x}") == ["#3", "#2"]
let mut counts: Map<string, int> = [:]
counts["a"] = (counts["a"] ?? 0) + 1
assert xs[5] == none && counts["a"] == 1
```

## Optionals, Results and `?`

Absence is `T?` with `none`; after `if x == none { return ... }`, `x` is a `T`. No `!`, no `?.`:
`x ?? fallback`, `x.map((v) => ...)`, or `match`. Errors are `Result<T, E>`: `?` returns the
`Err` (same error type; `.mapErr(f)` converts). A Result you don't use is a compile error.

```candor
enum ParseError {
  Empty
  NotANumber { text: string }
}

fn parse(s: string) -> Result<int, ParseError> {
  if s.isEmpty() {
    return Err(.Empty)
  }
  return match s.toInt() {
    none => Err(.NotANumber { text: s }),
    n => Ok(n),
  }
}

fn sum(a: string, b: string) -> Result<int, ParseError> {
  return Ok(parse(a)? + parse(b)?)
}
```

## Effects

Every function says what it may do with `uses` (`io`, `clock`, `env`, `random`, `tasks`, `http`,
`sql`, `fs`, `net`, `exec`, ...), and its callers need the same. When your change makes a
function do something new, add the effect to its `uses`; `candor check` names each caller that
needs it too. In tests every effect is a fake (agent-more.md, "Tests").

## Common changes

- **A new setting or field**: make it `T?`, so every existing `Config { ... }` still builds, and
  read it with `??` and a default.
- **A new enum variant**: add it, then `candor check` lists every `match` that must handle it.
- **A new route**: `http.route(req, "GET /items/{id}")` gives the path's parameters, or `none`.
- **A refactor to a new type**: change the type first, then fix what `candor check` lists.
- **Shared, changing state** (counters, limits, caches): agent-more.md, "Concurrency".

```candor
// items.candor
import "http"

struct Config {
  name: string
  timeoutMs: int?
}

enum Kind {
  Plain
  Urgent
  Quiet
}

fn label(k: Kind) -> string {
  return match k {
    .Plain => "plain",
    .Urgent => "urgent",
    .Quiet => "quiet",
  }
}

fn handle(req: http.Request, c: Config) -> http.Response {
  let params = http.route(req, "GET /items/{id}")
  if params == none {
    return http.textResponse(404, "no route ${req.method} ${req.path}")
  }
  return http.textResponse(200, "${params["id"] ?? ""} in ${c.timeoutMs ?? 5000}ms")
}
```

```candor
// items_test.candor
test "an item, and a path with no route" {
  let c = Config { name: "x" }
  let get = (path: string) => handle(http.Request { method: "GET", path, query: [:], headers: [:], body: "" }, c)
  assert get("/items/7").body == "7 in 5000ms"
  assert get("/nope").status == 404
}
```
