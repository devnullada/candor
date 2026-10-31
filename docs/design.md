# Candor: design

## The premise

An AI coder reads fast but has no memory between sessions, and edits code it can only see in
pieces. Every design choice should help it understand a piece of code without much surrounding
context, and get quick, reliable feedback from the compiler.

## Principles

1. **A function is understandable from its own code.** No macros, monkeypatching, implicit
   conversions, operator overloading, reflection, decorators, or globals. Anything a function
   touches is an argument or in its signature. "Where does this value actually come from?" should
   never need a search.

2. **Side effects appear in the type signature.** `uses db, net, clock`. You can tell what a
   function might break without reading what it calls. Tests swap in fakes for any effect, no
   mocking framework. Time and randomness are effects, so tests are deterministic.

3. **The compiler is the main feedback loop, so it is strict and fast.** Algebraic data types, no
   null, exhaustive `match`, errors as values. Sub-second incremental builds. Diagnostics with
   stable codes, spans, and suggested fixes, available as JSON. Typed holes (`?`) that report
   what fits and what is in scope.

4. **Specs live next to the code.** `requires`/`ensures` contracts, doc examples that run as
   tests, inline property tests. "Did I understand the intent?" becomes something the machine
   checks.

5. **Syntax that is familiar and easy to edit.** TypeScript/Rust-shaped: a new language has zero
   training data, so borrow priors. Braces, not indentation: string-replace edits and diffs
   survive braces. One formatter, one way to do each thing. Not terse: repeating a type name costs
   tokens; misreading code costs a debugging loop.

6. **The compiler is a query server.** "Who calls this", "what breaks if I change this
   signature", "which modules touch `db`", answered from the semantic graph. Tree-level edits
   (rename, add parameter) applied to every site.

7. **Backend essentials built in.** SQL checked against the schema, routes and serialization
   derived from types, structured logging and tracing as language features.

8. **Safe to run.** Capabilities double as a sandbox: a program without `fs` or `net` cannot
   touch them. Safe to hand an agent the run button.

## Decisions

### Surface: TypeScript-shaped, Rust's constructs

TypeScript over Rust as the base because its corpus is roughly an order of magnitude larger, and
because the borrow checker is the worst possible feature for an AI coder: its errors are
non-local and fixing one often means restructuring ownership elsewhere. GC is right for backends.

Imported from Rust: `Result`/`Option` with `?`, exhaustive `match` as an expression, integer
types, immutable by default, traits over classes.

Cut from TypeScript: `any`, `as`, `!`, `throw` (outside foreign bindings), class inheritance,
`this`, prototypes, decorators, getters/setters, both `null` and `undefined`, conditional and
mapped types, `enum`, `==`, `var`, `eval`, `Proxy`.

### Target: Go

Native speed without a borrow checker. Go's stdlib already covers most of the backend list
(`net/http`, `database/sql`, `encoding/json`, `crypto`, `log/slog`); the module ecosystem comes
in through foreign bindings. Go builds small projects in under a second. Borgo showed the pairing
works. The generated Go is a target, not something humans read: Candor's checker enforces the
guarantees, Go only has to build.

### Effects are capability passing

`fn f() uses io` means `f` takes an `io` capability as a hidden first parameter. `main` receives
the real ones from the runtime; tests pass fakes. A caller must declare every effect its callee
declares. No resumable effect handlers: they do not map to Go, and a backend rarely needs them.

Syntax: `uses a, b` after the parameter list and return type, no braces, may sit on its own line
in a multi-line signature:

```
fn charge(id: OrderId, amount: Money) -> Result<Receipt, ChargeError>
  uses db, net.payments, clock
  requires amount > Money.zero
{
```

### Statements end at newlines

No semicolons. Inside `( )` and `[ ]` newlines are whitespace, so calls and parameter lists can
span lines. Inside `{ }` they terminate statements.

### Diagnostics

Every diagnostic has a stable code (`CAN0001`...), a span, a message, and where there is an
obvious fix, a `help` line stating it. Codes are for tools and prompts to match on; messages may
change. `--json` emits the same structure for machines.

### Operators

TypeScript's set and precedence: `|| && == != < <= > >= + - * / %`, unary `-` and `!`.

- No implicit conversion, ever. `+` is string + string or int + int; `"n = " + 1` is an error
  whose fix is `.toString()`, a method on `int` and `bool`.
- Only `==` and `!=`, and they are strict. `===` and `!==` get a targeted error, because models
  will type them out of habit.
- `==` compares any two values of the same type by value (see "Equality"); `<` and friends
  work on int and string.
- Comparisons do not chain: `a < b < c` is a syntax error suggesting `a < b && b < c`.
- A line ending in an operator, `,`, `.`, `=` or `:` continues on the next. Leading operators
  (`\n + b`) do not, as in Go; a leading `.name` does (card 135).
- Constant int expressions are folded at compile time. Overflow and division by a constant zero
  are errors (`CAN0017`, `CAN0018`), so Go never sees a constant it would reject.
- Go output is fully parenthesized, since Go's precedence levels differ from TypeScript's.

### `if` is an expression

`let x = if a { 1 } else { 2 }`. There's no ternary operator; `match` will be an expression too.

- **Block values follow Kotlin's rule.** An `if` branch used as a value yields its last
  expression. A function body does not: it needs `return`. If a function ends in a matching
  expression, the error says "add `return`" rather than "unused value".
- Used as a value, `else` is required and the branches must have the same type. A branch that
  returns doesn't count towards the type. An `if` where every branch returns has no value.
- The condition must be `bool`. There's no truthiness; the error suggests `n != 0`.
- `else` may start the line after `}`. It can't begin a statement, so this is unambiguous, and
  it's a common way for models to format it.
- A function ends correctly if every path ends in `return`, through `if`/`else` chains.
- Lowering: Go's `if` is a statement, so a value `if` becomes a temporary declared before the
  containing statement and assigned in each branch. Earlier operands that call something are
  hoisted first, so evaluation stays left to right. The right side of `&&`/`||` is guarded so it
  only runs when it would have. No closures (they'd be slower and break `return`).

### Blocks scope their `let`s; no shadowing

A `let` inside a block isn't visible after it. A name can't be rebound anywhere it is visible:
not by an inner `let`, and not over a function or effect name. One name, one meaning, so code
read in pieces can't be misread.

### `__` is reserved

Candor names can't contain `__`; every name the compiler generates does (`hello__main`, `t__1`,
`string__`). Generated Go therefore can't collide with user code.

### Go is the target, not the surface

Candor gets all of Go's runtime (goroutines, scheduler, GC) and, through foreign bindings, all
of Go's packages. It does not expose the whole Go language.

Not in Candor: bare `go f()`, `panic`/`recover` for errors, user-visible pointers, struct tags,
package-level variables and `init()`, reflection, `unsafe`, cgo, `goto`. Interfaces become
traits, `(T, error)` becomes `Result`, and tags are derived from types. Raw Go is possible in a
`.go` file next to the code with declared Candor signatures: one auditable escape hatch.

### Concurrency (direction)

- No `async`/`await` and no function colouring, as in Go. `await` gets a targeted error.
- Structured concurrency only: tasks live in a scope, can't outlive it, the scope waits for all
  of them, and the first failure cancels the rest. Lowers to `errgroup` + `context`.
- Concurrency is an effect, `uses tasks`. Tests swap in a deterministic scheduler for
  reproducible interleavings (simulation testing).
- `context.Context` is threaded implicitly, like effect capabilities.
- No data races by construction: values are never shared mutably (`let mut` is local, and
  lambdas can't capture it); shared mutable state only exists in
  `Mutex<T>` (the lock owns the data), `Atomic<T>`, and channels.
- High-level helpers (`both`, `all`, `race`, `timeout`) come before raw `Channel<T>`/`select`.

Cards 007–009. As built, see "Structured concurrency" below. Two departures: `both` came with
tuples (card 018, with Mutex, Atomic and Channel), and the runtime has its own cancellation token instead of `errgroup`/`context.Context`
(the test scheduler needs to own blocking and wake-ups).

### Structured concurrency

Pal's calls: a **scope with handles** (`s.spawn` returns a `Task<T>`, `join()` waits for it),
helpers on top; a task **fails if it returns a Result**, and the scope then returns a Result;
a cancelled task **stops at its next check**, never seeing cancellation as a value; tests run
tasks **one at a time in a seeded order**.

```
fn profile(id: int) -> Result<string, string> uses tasks, clock {
  return tasks.scope((s) => {
    let user = s.spawn(() => fetchUser(id, 200))      // Task<Result<User, string>>
    let score = s.spawn(() => fetchScore(id, 200))
    let u = user.join()?
    return Ok(u.name + " scores " + score.join()?.toString())
  })
}
tasks.all(ids, (id) => fetchUser(id, 200))   // Result<List<User>, string>; List<T> if f can't fail
tasks.race([() => a(), () => b()])           // first non-failure wins; all fail → the last failure
tasks.timeout(500, () => slow())             // T?, none if time ran out; bool for () functions
clock.sleep(ms)
```

- `tasks.scope(f)` returns what `f` returns. It waits for every task, even when cancelled: no
  task outlives its scope.
- A task returning `Result<T, E>` can fail. Its first `Err` cancels the others and becomes the
  scope's result, so the scope's function must return `Result<_, E>` with the same `E`. A failing
  body (`return Err(...)`) cancels the tasks too. Tasks that return plain values can't fail, and
  their scope needs no `?`.
- A `Scope` passed to another function (`fn helper(s: Scope)`) can only take tasks that cannot
  fail: the error type belongs to the scope that created it.
- Effects of spawned work are performed by the function that spawns it, so `uses` still tells
  the whole story.
- `Scope` and `Task<T>` are types you can write. They can't be compared and aren't shown by
  `assert`.
- `await`, `async fn` and `go f()` get targeted errors. They stay ordinary names elsewhere.

Small calls:

- Lambda results: `return Ok(x)` with nothing said about the lambda's result now completes it
  to `Result<typeof x, E>` when a `?` or a task that can fail already showed `E`. It removes most
  `(...): Result<T, E> =>` annotations (scope bodies would need one otherwise), and a `?` that
  doesn't fit gets the annotation hint as before.
- `Ok(x)` goes where a `Result<T, E>?` is expected, as `T` does into `T?`.
- `tasks.timeout` takes int ms, like `clock`, and does not need `uses clock`. Its function can't
  return an optional (`none` already means "too late").
- `tasks.race([])` is a runtime error; a literal empty list is a compile error.

Lowering:

- Every generated function and function value takes a hidden first parameter, `ctx__
  *candor.Ctx`: the task it runs in, and its cancellation token. Effect methods take it too.
  Function values are called with the caller's context, so a lambda runs in whichever task
  calls it.
- Every loop iteration calls `ctx__.Check()`, so even a pure loop stops when cancelled (one
  atomic load). Cancellation unwinds with a private panic that the task's group recovers.
  Candor code can't catch it.
- A crash in a task (a Go panic, or a failed `assert` in a test) cancels the scope and is
  re-raised where the scope was called.
- Runtime: `runtime/go/tasks.go` (groups, `RunScope`, `Spawn`, `All`, `Race`, `Timeout`) and
  `ctx.go` (tokens). Generic functions, since Go interface methods can't be generic; the `tasks`
  capability itself carries nothing. A result the runtime must recognise as a failure comes with
  a generated `func(r) bool`.

Test scheduler (`runtime/go/sim.go`):

- Tasks are goroutines, but one runs at a time. The turn passes at every effect call, `spawn`,
  `join`, sleep and task end, to a ready task picked by a seeded RNG.
- Time is virtual. When nothing is ready, the clock jumps to the next timer, so `clock.sleep(1000)`
  in a test takes no real time and parallel sleeps visibly overlap (`clock.now() == 200` after
  three 200 ms lookups).
- `candor test` picks a fresh seed per run, so repeated runs explore different orders. When a
  failing test ran tasks, the report prints the seed, and `candor test f --seed N` replays it.
  Since card 042 a test whose order mattered also runs in 100 orders per run; see "Race tests
  try many orders".
- Pure code doesn't yield: between effect calls a task runs uninterrupted, which is
  indistinguishable for code that can't share mutable state.

Checked by `runtime/go/tasks_test.go`: wall time of parallel sleeps, cancellation of sleeping
and spinning tasks, nested scopes, crashes, and a goroutine count after every test.

### Structs and enums

Pal's calls: structs are **nominal**, and enums are a **dedicated `enum`** declaration.

```
struct Point { x: int, y: int }            // fields separated by commas or newlines
enum Status {
  Pending
  Paid { at: int }
}
let p = Point { x: 1, y: 2 }
let q = Point { ...p, y: 3 }               // copy with changes; `...` comes first
let s = Status.Paid { at: 5 }
let t = Status.Pending
```

- Type and variant names start uppercase (`CAN0030`). That makes `Name {` unambiguously a
  literal and lets a lowercase name in a pattern be a binding.
- Variants are always qualified, `Status.Paid`, in expressions and patterns. One way to write
  it, and readable without knowing the subject's type.
- Payloads have named fields only; there are no tuple variants.
- Every field must be given (`CAN0026`), with no defaults. Shorthand `Point { x, y }` works.
- Enum values have no fields of their own: `s.at` is an error that says to use `match`.
- `==` on structs and enums compares by value (see "Equality").
- A struct literal in an `if` condition or `match` subject needs parentheses, as in Rust.
- Recursion: enums may contain themselves. A struct-only cycle is an error (`CAN0029`), because
  no variant can end it.

### `match`

```
let label = match s {
  Status.Pending => "pending"
  Status.Paid { at } => "paid at " + at.toString()
  _ => "other"
}
```

- An expression with the same block-value rules as `if`. Arm bodies are an expression,
  `return ...`, or a `{ block }`. Arms are separated by newlines or commas.
- Patterns: `_`, a lowercase name (binds), literals (int including negative, string, bool),
  `Type { field: pattern }` and `Enum.Variant { ... }`, nested to any depth. Fields left out
  match anything; `..` gets an error telling you to leave them out.
- Exhaustiveness and unreachable arms use Maranget's usefulness algorithm (`src/exhaustive.ts`),
  so nested patterns are judged exactly. The error lists up to 8 missing cases by name
  (`CAN0027`); an unreachable arm is a warning (`CAN0028`).
- No guards (`if` in arms) yet.

### Enum lowering: tagged struct

An enum is one Go struct: `tag__ uint16` plus every variant's fields (`Paid__at`). Matching is
an `if`/`else if` chain on the tag. Every test is an expression, so `match` lowers with the
same machinery as `if`. A field leading back to its own enum is a pointer (`ptr__(v)`); values
are immutable, so sharing one is invisible.

Measured against an interface with one struct per variant (Go 1.27, 3 runs each):

| | tagged struct | interface |
|---|---|---|
| construct + match | 3.0 ns, 0 B | 8.7 ns, ~10 B (boxing allocates) |
| match pre-built values | 1.4–1.8 ns | 1.2–1.6 ns |

Building values is ~3× faster with the tagged struct, and reading is a tie. The cost is size:
a tagged struct carries every variant's fields. If an enum with one huge variant shows up,
switch that enum to tag + pointer-to-payload.

### Optionals: `T?`

Pal's call: optional types are written **`T?`**. There is no null; absence is `none`, and only a
`T?` can hold it.

```
let email: string? = none
let shown = email ?? "(no email)"          // the default runs only when needed
let label = match email {
  none => "no email"
  e => "email: " + e                      // a name binds the present value, as a string
}
fn managerName(u: User) -> string? {
  let m = u.manager?                       // returns `none` early
  return m.name                            // a string goes where a string? is expected
}
```

- A `T` is accepted wherever a `T?` is expected (let, argument, return, field, branch). That is
  the only implicit step in the language, and it can't lose information.
- `none` takes its type from context; `let x = none` asks for an annotation (`CAN0032`).
- Branches that mix a value and `none` produce a `T?`.
- On a `T?`, every pattern except `none` and `_` matches a present value. A name binds the `T`.
  There's no `Some`: the error for `Some(x)` says to write `x`.
- `x == none` and `x == 5` work on a `x: int?` (since card 007; before, `==` on optionals was
  an error). There's no flow typing ("smart casts"), so `x` stays a `T?` after the test.
- `null`, `undefined`, `nil`, `None`, `Some` and `Option<T>` get targeted errors.
- `T??` is not a type you can write. Built-ins flatten one (card 148, below).

### Results: `Result<T, E>`

```
fn sum(a: string, b: string) -> Result<int, ParseError> {
  let x = parseDigit(a)?                   // returns the error early
  let y = parseDigit(b)?
  return Ok(x + y)
}
match r {
  Ok(n) => ...
  Err(ParseError.Empty) => ...
  Err(ParseError.NotADigit { text }) => ...
}
```

- `Ok(v)` and `Err(e)` as in Rust. Which Result they build comes from where they go
  (`return`, an annotated `let`, an argument, a field, a branch). Without that context, it's an
  error asking for an annotation.
- `?` on a Result needs the function to return a Result with the **same** error type. There's
  no automatic error conversion (no `From`): converting is explicit, with `match` (or, since
  card 039, `r.mapErr(f)`). `?` on a `T?`
  needs the function to return an optional. Mixing them is an error with the fix (`CAN0033`).
- `Result`, `Ok`, `Err`, `Option`, `Some`, `None` are reserved names.
- User-defined generic types are below, in "Generics".

### Lowering `T?` and Result

`T?` is `opt__[T] struct { some bool; value T }` and `Result<T, E>` is
`res__[T, E] struct { ok bool; value T; err E }`: plain Go generic structs, no allocation. `x?`
is a temporary plus an early return; `x ?? d` is an `if` that evaluates `d` only when needed. A
field that leads back to its own type through an enum, `T?` or Result is a pointer
(`next *opt__[Node]`), so `struct Node { next: Node? }` works. A cycle through plain structs
alone is still an error.

### Tests: inline `test` blocks, always with fakes

Decided by Pal:

```
test "a session expires after exactly an hour" {
  clock.set(1000)
  let s = start("Pal")
  clock.advance(60 * 60 * 1000)
  assert expired(s)
}
```

- **Inline**, like Zig and Rust unit tests: the AI reading a function has its tests in the same
  context, and private functions are testable with no extra visibility rule. Every command
  checks tests; only `candor test` compiles them, and then `main` is optional. A `tests/`
  folder for cross-module scenarios comes with modules, as an addition.
- **Always fake.** A test block has every effect in scope and every one is a fake, so a test
  can't touch the real world even by accident. Fakes add methods to steer and inspect them:
  `io.output()`, `clock.set(ms)`, `clock.advance(ms)`. Outside a test those are an error
  (`CAN0035`). Each test builds fresh fakes, so tests can't leak state into each other. This is
  the "fake any effect without a mocking framework" claim, made concrete.
- **`assert cond`**, one keyword, tests only (`CAN0034`). A failure prints the source with the
  value of each part under it (power assert, after Groovy and power-assert-js):

  ```
  FAIL arithmetic (failing.candor:38)

      assert total(a, 22) == 42
             |     |      |
             |     |      false
             |     20
             41
  ```

  Values print as Candor source writes them (`Shape.Circle { r: 3 }`, `none`, `Err("odd")`).
  A part that never ran, like the right side of a short-circuited `&&`, shows nothing.
- `test` is a keyword only at the top of a file before a string, so it stays usable as a name.

Lowering: each test is a Go function that builds its fakes and runs the body; the generated
`main` hands them to `candor.RunTests`. Each shown part of an assert is wrapped in
`candor.Rec[T](values, i, expr)`, which notes the value and returns it unchanged, so
evaluation order and short-circuiting are exactly as without the assert. A failure panics,
and the runner recovers it. In test mode every type also gets a `Show__` method.

### `clock`

`clock.now()` is an `int`: milliseconds since the Unix epoch (Pal's call: smallest thing that
works; proper `Instant`/`Duration` types later). The fake starts at 0 and moves only when told.

### Lambdas and function types

Pal's calls: lambdas are **`(x) => ...` only**, and **effects are part of function types**.

```
fn each(xs: List<Order>, f: fn(Order) uses io) uses io {
  for o in xs {
    f(o)
  }
}
each(orders, (o) => io.println(o.customer))
```

- `fn(A, B) -> R uses e`; `-> R` left out means it returns nothing. Inside `<...>` a function
  type with several effects needs parentheses (`List<(fn() uses io, clock)>`), because the
  comma is ambiguous there.
- Calling a function value performs its effects, so the caller must declare them. A function
  with fewer effects fits where more are allowed; passing one with more is an error whose help
  writes out the type that would allow it.
- A lambda's effects are what its body performs. It captures the capabilities from the
  function around it, so that function must have them. In Go, function values are plain
  closures: a named function with effects becomes a closure that passes the capabilities.
- Parameter types come from the context (`xs.map((x) => x + 1)`), else need annotations. The
  result comes from the context, the expression body, or all its `return`s (card 050). `(x): T => ...`
  annotates it, which `?` needs when nothing else has said. A block body needs `return`, like
  a function: the rule is the same as for `fn`, and TypeScript reads the same way.
- `x => ...` gets a targeted error: one way to write it, and the parenthesised form is what an
  edit that adds a parameter or a type needs anyway.
- Lambdas can't capture `let mut` variables (`CAN0037`). Go closures capture by reference, and
  a lambda handed to another task later must not see a value change under it.
- `break` and `continue` don't cross into a lambda.
- A user function says "uses whatever `f` uses" with `uses f` (see "Generics").

### Lists

`List<T>`, literals `[1, 2, 3]`. Methods: `length`, `isEmpty`, `first`, `last`, `contains`,
`sorted` (for `Ord` items), `join` (on `List<string>`), `concat`, `map`, `filter`, and
`push`/`pop` on a `let mut`. Calls
need parentheses (`xs.length()`), as for every method; `xs.length` says so.

- `xs[i]` is a `T?`: `none` when out of range, never a crash. `xs[i] = v` on a `let mut`
  replaces an item, and does panic out of range (see "`xs[i] = v`" below).
- No `forEach`: `for x in xs` is the one way to do something per item.
- `T[]` and `Array<T>` get targeted errors; `List` is a reserved name.
- An empty `[]` needs a type from the context or an annotation.
- Lowering: a Go slice. `map`/`filter` are small generic Go helpers.

### Mutation: `let mut`, with value semantics

Pal's call: **Swift-style**. `let mut` declares a variable that can change, in place:

```
let mut out: List<int> = []
for x in xs {
  out.push(x * 2)
}
let mut p = Point { x: 1, y: 2 }
p.x = 3
```

- Values stay values: `let mut b = a; b.push(3)` leaves `a` alone. Nothing else can see a
  change, so mutation stays local and race-free.
- Assignable: a `let mut` variable, or a path of struct fields from one (`p.pos.x += 1`), with
  `=`, `+=`, `-=`, `*=`, `/=`, `%=`. Parameters, pattern bindings and plain `let` can't change
  (`CAN0036`, with the fix). An item of a list, `xs[i] = v`, can since card 022 (see "`xs[i] =
  v`" below); a field inside a field that is stored behind a pointer can't (recursive types
  share those).
- `let mut` that never changes is a warning (`CAN0039`), as in Rust.
- `++`/`--`, `const` and `var` get targeted errors.

Lowering. Go slices share their backing array, so `append` on one could overwrite memory a copy
still sees. Rule: a `let mut` list variable owns its spare capacity. Every value stored into
one is clipped (`slices.Clip`: capacity = length), so the first `push` after that copies, and
later pushes append in place, amortized O(1). `pop` clips what's left. A list inside a struct
may share its array with copies of the struct, so `s.items.push(x)` always copies (O(n)).
`test/fixtures/aliasing.candor` pins the cases.

### Loops

Pal's calls: `for x in xs`, and `while` now.

- `for x in xs { }`, `for i in 0..n { }` (half-open; both ends are evaluated once),
  `for _ in ...` to ignore the item. `while cond { }`. `break`, `continue`.
- `for (const x of xs)` and C-style `for` get a targeted error. `for i in 5` says to use a
  range.
- Each iteration gets a fresh loop variable (Go 1.22 semantics), so lambdas capture the value
  of that iteration.
- No `loop`, labels or `do`/`while`.

### Equality

`==` and `!=` compare any two values of the same type by value: structs field by field, enums
by variant and fields, lists item by item, optionals and Results by content. Functions and
effects can't be compared. A `T` and a `T?` compare after wrapping the `T`. `Ok(...)`,
`Err(...)`, `none` and `[]` take their type from the other side.

Lowering: Go's `==` when it means the same (no lists, no fields behind pointers), else a
generated `eq__N` function per type.

### Imports

Minimal, by Pal's call; the full module system (visibility, packages, versions) comes later.

- `import "bindings/strconv"` reads `bindings/strconv.candor`, relative to the importing file.
  The path's last part must be the module's name, so where a name comes from is visible at the
  import. Imports come first, right after `module`.
- Everything a module declares is public for now (until "Visibility: `pub`", below). Its functions and extern values are used
  qualified, `strconv.atoi(s)`, never bare: one name, one meaning, at every use. A module's name
  can't be rebound, and isn't a value.
- An imported function's effects are checked like a local one's. Its types are written with
  the module too, wherever a local type can be (card 011):
  - types: `geo.Point`, `List<geo.Point>`, `Result<string, http.HttpError>`;
  - literals and variants: `geo.Point { x: 0, y: 0 }`, `geo.Shape.Circle { ... }`,
    `geo.Shape.Dot`;
  - patterns: `http.HttpError.Status { code } => ...`.

  Messages write them the same way (`expected geo.Point, found geo.Shape`), and a bare `Point`
  that an import declares gets "write `geo.Point`". Only direct imports' types are writable; a
  type that reaches you through a module you don't import can be held, not named.
- Cycles, a missing file, a name that doesn't match and two files with the same module name are
  errors (CAN0041). Imported modules need no `main`; only the entry's tests run.
- Lowering: one Go `package main` for the whole program. Every Go name carries its module
  (`strconv__atoi`, `geo__Point`), so modules can't collide.

### Go bindings: `extern`

```
extern "strconv" {
  fn Atoi(s: string) -> Result<int, GoError> as atoi
  fn FormatInt(i: int, base: int) -> string as formatInt
  let ErrRange: GoError as errRange
}
```

- Pal's format: a Go import path, then Go symbols with Candor signatures, renamed with `as`.
  `let` binds a Go package variable, read each time it's used.
- `(T, error)` becomes `Result<T, GoError>`. `GoError` is opaque: `.message()`, and
  `.is(known)` (Go's `errors.Is`, so wrapped errors match too). No `==`.
- Types that cross: int, string, bool, `List<string>` (and `Bytes` since card 138; copied both ways, since Go may change a
  slice), `Result<T, GoError>` as a result, `GoError` for `let`. Everything else is CAN0042.
- A Candor `int` reaches any Go integer type. Each extern becomes a Go function with the Candor
  signature that calls Go through a generic adapter, and Go infers the adapter's type parameters
  from the Go function: `int`, `int64` and `uint8` all fit `candor.Integer`. Go's type checker
  is therefore what checks a binding against Go. Its errors carry `//line` directives back to
  the `extern` line, and the CLI rewords them ("the Go function Atoi is `func(s string) (int,
  error)`, which does not fit this binding's Candor signature").
- The escape hatch: `extern "./native"` names a Go package in a folder next to the binding. It is
  copied into the build as a package of its own. Go written for Candor goes there.
- Wrappers live in their own generated file, `bindings.go`.

Who is trusted for what: Candor checks a binding's types (through Go). It cannot check what the
Go code does. An extern at module level has no effects (`uses` on one is an error), so the
binding's author vouches that it is pure: no I/O, no global state, no blocking, no `os.Exit`.
Go that does I/O is bound inside an `effect` (below), where only the effect's operations call
it and tests never reach it. The audit surface is the `extern` blocks and the Go packages they
name, nothing else.

### User effects: `effect` and `fake`

```
module http

effect http {
  extern "./native" {
    fn Get(ctx, url: string) -> Result<string, GoError> as goGet
  }
  pub fn get(url: string) -> Result<string, HttpError> {
    match goGet(url) { ... }
  }
}

fake http {
  let mut requests: List<string> = []
  fn get(url: string) -> Result<string, HttpError> { requests.push(url) ... }
  fn requested() -> List<string> { return requests }   // tests only
}
```

- Pal's calls: an effect's operations are Candor functions, and the `extern`s inside the effect
  are theirs alone to call (CAN0043 elsewhere). (Operations are `pub fn` since card 034, which
  added helpers.) Operations return Candor types, so the binding
  turns Go's world into Candor's once, and the fake speaks Candor only.
- Pal's call: one effect per module, named after it. `uses http` and `http.get(u)` from any
  module that imports it; operations and the module's functions share one namespace. Effect
  names are unique in a program because module names are.
- Every effect has a fake (CAN0043 without one), next to it. A fake implements every operation
  with the same signature, and may add methods for tests to steer and inspect it (CAN0035
  outside a test, as for `io.output()`). Its `let` state is built fresh for every test; its
  functions see and change it like `let mut` variables. A test block has every effect of the
  program in scope, as fakes.
- `ctx` as the first parameter of an extern: the Go function takes a `context.Context`, which
  is cancelled with the task, and the task stops as soon as the call returns. Only an effect's
  externs may take one (CAN0042): a function that needs a context is not pure. An extern
  without `ctx` runs to completion; the task stops at its next check.
- Small calls: operations and fake functions can't `uses` other effects yet (fakes can since
  card 060); extern parameters
  may be `GoError` (Go's `error`), so a binding can ask Go about an error it got.
- Lowering: `effect http` is a Go interface `fx__http`, with `fx__http__real` (the operations'
  bodies) and, in tests, `fx__http__fake` (a struct of the state; `fx__http__newFake` builds it).
  A fake method copies the state into locals and writes the mutable ones back with a `defer`.
  Every operation starts with `ctx__.Op()`: a place to stop when cancelled, and under the test
  scheduler a place where another task may run.

Checked by `test/effects.test.ts`, `examples/pages.candor` (tests against the fake) and a real
build in which a `tasks.timeout` cancels a Go call blocked on its context.

### Compiler in TypeScript, run by Bun

No build step while the language is small. Self-hosting is a far-off possibility, not a goal.

### Versions, drafts and checking bindings against Go

```
extern "github.com/dustin/go-humanize@v1.0.1" {
  unvetted fn Comma(v: int) -> string as comma
}
```

- Pal's calls: a third-party Go package names its module version in the extern path, so what
  there is to audit stays in the extern block. It must be exact (`@v1.0.1`, not `@latest`), and
  one package at two versions in a program is an error. The standard library and Go packages
  next to the binding have none. `candor build` runs `go get` for each, so they land in the
  generated go.mod and go.sum.
- `candor bind <package>[@version]` prints a draft binding (`@latest` resolves to an exact
  version). Every function that fits is `unvetted fn`, which the checker refuses (CAN0044), one
  error per function: whoever finishes the draft decides each one, deleting the word for a pure
  function or moving it into the module's `effect`. Constants and error variables become
  `let`s; other variables are global state and are left out. What can't cross yet is listed at
  the end with the reason, and Go's doc comments come along.
- Every build, check and test reads Go's own types for the packages its bindings name (a
  helper on `golang.org/x/tools/go/packages`, in `tools/gotypes`, cached per build directory),
  and compares each binding with them, by the same rules the generic adapters apply. A mismatch
  is CAN0045 at the binding, with the signature that would fit. The adapters and `//line`
  directives stay, as a backstop.

### Generics

```
struct Page<T> {
  items: List<T>
  next: string?
}

fn first<T>(xs: List<T>) -> T? {
  return xs[0]
}

fn each<T>(xs: List<T>, f: fn(T)) uses f {
  for x in xs {
    f(x)
  }
}
```

Pal's calls:

- **No bounds**, at first. A type parameter can be stored, passed on, and put in a `List`, `T?`,
  Result or generic type. Comparing it or calling methods on it needs a bound (see "Bounds and
  traits", which came next).
- **Type arguments come from the arguments.** At a call, from the arguments; in a struct
  literal or variant, from its fields; from the copied value in `{ ...p }`. Never from where the
  result goes: an annotation doesn't count. (Since card 043, where the result goes fills in what
  the arguments leave open; see "Type arguments from where a result goes".) When nothing says, they are written: `empty<int>()`,
  `Page<int> { ... }`, `Tree<int>.Leaf`. A variant without fields always needs them. The error's
  help is made concrete from where the value goes, when that's known ("write `empty<int>()`"),
  so the place that doesn't decide still tells you what to write.
- **`uses f`** names a parameter that is a function: the function takes on whatever `f` does.
  Inside, `f`'s type allows any effect, and calling it counts as using `f` (unused is a
  warning, like an unused effect). At a call, the function passed may do anything, and the
  caller must allow what it does. It works for non-generic functions too, and passes on:
  `twice(xs, f) uses f` can call `each(xs, f)`. There are no effect variables to declare.

Details:

- Type parameters are named like types (uppercase), can't reuse a type's name, and go after the
  name: `fn first<T>`, `struct Page<T>`, `enum Tree<T>`. A generic type is always written with
  its arguments, inside its own declaration too (`Tree<T>`), and only as itself there: a type
  that holds `W<List<T>>` is refused, since Go can't build it.
- In an expression, `<` after a name starts type arguments when the types are followed by `(`,
  `{` or `.`; otherwise it's a comparison. Comparisons can't chain, so `a < b > (c)` has no other
  meaning. `f(a < b, c > (d))` is read as a generic call, as in TypeScript.
- Values of an unknown type are filled in from the arguments that need no context first; then
  lambdas, `none`, `Ok(...)` and `[]` are checked against what is known. So
  `mapList(xs, (x) => x.toString())` learns `T` from `xs` and `U` from the lambda.
- A type parameter never stands for nothing: a lambda returning nothing where a `U` is expected
  is an error (Go has no value of "nothing" to pass around).
- A generic function, or one with `uses f`, can only be called: as a value it needs type
  arguments, which only a call has. The help wraps it in a lambda.
- Effect operations and fakes can't be generic: they become methods of a Go interface. `main`
  can't be either.
- A recursive call that grows its type arguments (`depth<T>` calling `depth([x])`, with `T`
  becoming `List<T>`) is refused: Go builds one version of a generic function per type and
  would need infinitely many. The checker follows type parameters through calls within a
  module to find the cycle.
- Lowering: Go generics. `type m__Page[T__ any] struct`, `func m__first[T__ any]`, and every
  use writes its type arguments (`m__first[int64](...)`), so Go never infers one. Type
  parameters become `T__`, which no Candor name can hide. `uses f` adds nothing in Go: function
  values are closures that already carry their capabilities. `Show__` and `==` work on
  instances like on any type.
- `List<T>` stays built in: its methods (`push` on a place, `map` taking on its lambda's
  effects) are things a user generic can't express yet, so making it a library type gains
  nothing now.

### Bounds and traits

```
trait Describe {
  fn describe(self) -> string
}

impl Describe for User {
  fn describe(self) -> string {
    return self.name
  }
}

impl Ord for User {
  fn compare(self, other: User) -> int {
    return self.age - other.age
  }
}

fn describeAll<T: Describe>(xs: List<T>) -> string {
  return xs.map((x) => x.describe()).join(", ")
}

fn largest<T: Ord>(xs: List<T>) -> T? { ... }   // `x > best` works on a T
```

Pal's calls:

- **Built-in bounds and user traits, together.** `Eq` and `Ord` are built in; other traits are
  declared with `trait`.
- **Structural for the built-ins, explicit for the rest.** A type is `Eq` when `==` works on it,
  as before: everything but functions, effects, tasks and Go errors, and type parameters
  without `Eq`. `Ord` is int, string, and types with `impl Ord`. A user trait is had only
  through an `impl`, so no type picks one up by accident.
- **`Eq` can't be implemented; `Ord` can.** `==` always means field-by-field equality, so it
  never surprises. `impl Ord for User` gives `compare`, which `<`, `>`, `sorted()` and `T: Ord`
  use.
- **Inline bounds only:** `<T: Eq + Ord>`, `<T: geo.Show>`. No `where`.
- **Methods are called with a dot, and exist only in traits.** `p.describe()`, like the built-in
  methods. There are no inherent methods (`impl User { ... }`): plain functions do that, and a
  dot call always has one place to look.
- **Minimal traits.** A method takes `self` first, may name `Self`, has no default body, is not
  generic, and does no effects. Traits take no type parameters. (Default bodies and effects
  came with card 058, below.)

Details:

- An `impl` is for a struct or enum without type parameters, or int, string or bool, and lives in
  the module of the trait or of the type (the orphan rule). One per trait and type in a program.
  It gives every method, with the trait's signature with `Self` replaced. A method can't share a
  name with a field or a built-in method of the type.
- `x.m()` on a type parameter looks through its bounds; on any other type, through the impls
  the module can see (its own and its imports', transitively) and `Ord` on int and string. Two
  traits with the same method on one type is an error at the call.
- Bounds are checked where a type is picked: at a call (after inference), in a written type
  (`Ranked<P>`), and in an inferred struct literal or variant. A bound on a type
  (`struct Ranked<T: Ord>`) is a requirement on every use, so a generic function holding a
  `Ranked<U>` needs `U: Ord` too, as in Rust. The help names the fix: the bound to add, or the
  `impl` to write.
- A trait is not a type: `x: Describe` is refused, with the type-parameter form as the help.
- `List.sorted()` returns a sorted copy, stable, for `Ord` items.
- Lowering: dictionaries, as Go type parameters. `fn f<T: Ord>` becomes
  `func m__f[T__ any, T__Ord Ord__[T__]]`, and a call writes the dictionary type with the type:
  `m__f[m__User, Ord__for__m__User]`. A dictionary type has no fields and its methods are
  called on its zero value, `(*new(T__Ord)).compare(ctx__, a, b)`, so nothing is passed at run
  time and Go's generics do the rest. A trait is a Go interface over `Self__`; an impl is an
  empty struct with the methods. `Eq` dictionaries are Go's `==` where it compares as Candor
  does, or the generated equality functions, which are now generic over the type parameters
  they hold. Methods take the context like every function.

### Maps

```
let ages = ["ann": 31, "bo": 4]
let mut seen: Map<string, int> = [:]
seen["x"] = (seen["x"] ?? 0) + 1
for (name, age) in ages { ... }
```

Pal's calls:

- **Values, copy on write.** Like lists: `let mut b = a; b[k] = v` leaves `a` alone. A
  `let mut` map changes in place as long as nothing else holds its data.
- **Insertion order.** Loops, `keys()`, `values()` and printing all follow the order keys were
  first set, so output and tests are the same every run. Setting an existing key keeps its place.
- **Swift syntax.** `["a": 1]`, `[:]` for empty (which needs a type from the context, like `[]`).
  `m[k]` is a `V?`, as `xs[i]` is.
- **Any `Eq` key**, lists and structs holding them too.

Details:

- Methods: `length`, `isEmpty`, `has`, `keys`, `values`, and on a `let mut`, `remove(k)`
  (gives the value it had, a `V?`). One way to look up: `m[k]`; `m.get(k)` says so, and
  `contains`, `delete`, `size`, `forEach` point at the Candor name. Writing was `m.set(k, v)`
  until card 046 made it `m[k] = v`.
- `for (k, v) in m`, either name may be `_`. The loop runs over the map as it was when the loop
  started. `for k in m` asks for both names (or `.keys()`); the parentheses come before tuples
  (card 017), which will make them a pattern.
- `==` holds when both have the same keys with equal values, in any order, as in Swift and
  Python. A map is `Eq` when its values are.
- A literal key given twice is an error (CAN0016). Built from values, the last one wins.
- `Map<K, V>` with `K` lacking `Eq` is CAN0047, with the bound to add.
- `x ?? []` and `x ?? [:]` now take their type from `x`.
- Lowering: `candor.Map[K, V]` in runtime/go/maps.go. It is a pointer to entries in a slice (in
  order; removed ones are dead until compaction) and a Go `map[any]int` index. A key Go's `==`
  compares as Candor does is stored as itself. Others (lists, maps, fields behind pointers) are
  stored as a string that encodes the value, built by reflection, so equal keys meet. Copy on
  write: the data records which variable owns it. A write through that variable is in place;
  reading the variable as a whole value (passing, storing, returning, looping) calls `Share`,
  which clears the owner, so the next write through any copy copies first. Lookups and methods
  don't share. A map in a struct field may be shared with copies of the struct, so
  `s.m[k] = v` always copies (as `s.items.push` does). A fake's map state copies once per
  operation that writes it.

### `void` and tuples

```
fn save(x: Item) -> Result<void, DbError> {
  db.put(x.id, x.body)?
  return Ok()
}

fn minMax(xs: List<int>) -> (int, int)? { ... }
let (lo, hi) = minMax(xs) ?? (0, 0)
for (i, x) in xs.enumerated() { ... }
```

Pal's calls:

- **`void`**, TypeScript's word, for "nothing": `Result<void, E>`, with `Ok()` as its value and
  its pattern. It is what a function without `->` returns, and diagnostics print it.
- **Tuples, taken apart by name.** `(int, string)` types and `(1, "a")` values, destructured in
  `let`, `for` and `match`. There is no `.0`: parts get names where they are used.
- **A type parameter can be `void`**: `twice(() => log())` is a `List<void>`, a task of a
  function returning nothing is a `Task<void>`. This lifts card 013's "never for nothing".

Details:

- `void` is written only as a type argument. `-> void` warns (CAN0050), since leaving `->`
  out says it; `()` as a type or a value is a syntax error that names `void` and `Ok()`.
- `Ok()` where the Result holds a value says `Ok(x)`; `Ok(x)` where it holds nothing says
  `Ok()`. `Ok()` as a pattern on a Result that holds a value says `Ok(x)` or `Ok(_)`.
- `save(x)?` on its own line is a statement: the error goes on, and the `void` left is
  dropped. A call whose Result is dropped is a warning (CAN0049), for every Result, so a
  `Result<void, E>` can't fail unnoticed.
- Bindings: a Go function returning only `error` binds as `Result<void, GoError>`, and
  `candor bind` drafts it.
- Tuples have two or more parts; `(T)` is still grouping. `==` and map keys work when the
  parts' do; a failing `assert` shows `(1, "a")`.
- A `let` or `for` pattern must match every value (CAN0027 names one it misses, and says to
  use `match`). In those, a name takes its part whole, a `T?` included; in a `match`, a name on
  a `T?` still matches only a present value. `let mut (a, b)` is not allowed: destructure, then
  copy what changes.
- `for (k, v) in m` is a tuple pattern now, so its parts can be patterns too:
  `for (name, Point { x, y }) in points`. `xs.enumerated()` is a `List<(int, T)>`, and
  `m.entries()` a `List<(K, V)>`.
- `p.0` is a syntax error whose help is `let (a, b) = pair`; members of a tuple likewise.
- Lowering: every Candor function returns a Go value, `struct{}` for `void`. That keeps
  `fn() -> T` with `T` = `void` the same Go type as `fn()`, so generic code, function values
  and tasks need no adapters (the runtime's `...Unit` task variants are gone). A `void` call
  used as a value runs as a statement first, then passes `struct{}{}`. The runtime's own
  methods return nothing, so `io.println` as a value is wrapped. A tuple is an anonymous Go
  struct, `struct{ V0 int64; V1 string }`: no declarations, Go's `==` where it works, and the
  same type in generic code.
- Fixed on the way: `[(a, b): v]` was read as a lambda with a return type; `):` now means one
  only if a type and `=>` follow.

### Go's types, inside effects

```
effect notes {
  extern "modernc.org/sqlite@v1.60.1" {}
  extern "database/sql" {
    type *DB as Db
    type *Rows
    fn Open(driver: string, source: string) -> Result<Db, GoError> as openDb
    fn (db: Db) Exec(query: string, ...(body: string)) -> Result<Written, GoError> as insert
    fn (rows: Rows) Next() -> bool as next
  }
  let mut db: Db? = none
  pub fn open(path: string) -> Result<void, NoteError> { ... db = conn ... }
}
```

Pal's calls:

- **A `type` item, and methods as functions taking the receiver first.** `fn (db: Db) Query(...)
  as query` is called `query(db, ...)`, so expressions need nothing new. `as` renames, as for
  functions; `type Result as Written` because `Result` is Candor's.
- **Nil is `T?`.** Where Go may give nil, the binding says `Db?` and the adapter turns nil into
  `none`. A plain `Db` is never nil: if Go gives one anyway, the adapter panics, naming the
  binding.
- **Only an effect holds Go's values.** A Go value is a reference, so it would break value
  semantics anywhere else. Its name resolves only in the effect's bindings, its state and its
  operations' bodies (CAN0051 elsewhere: in an operation's signature, a fake, another module).
  Operations give Candor values; a generic function may pass a Go value through without naming
  it.
- **An effect has state, written as a fake's.** `let mut db: Db? = none` is set up when `main`
  starts, and an operation (`open`) fills it in. Operations see it as `let mut` variables.
- SQLite is modernc.org/sqlite: pure Go, so no C compiler.

Mine, mentioned at the time:

- `type *DB` with a `*` where the binding holds a pointer, as Go spells it; `type Result` for an
  interface or a value. The emitter needs to know, and only a pointer can be nil.
- **Variadic Go functions bind at the arity they're called with**: `...(body: string)` lists what
  goes into Go's `...`, last. One Go function can have several bindings (`exec`, `insert`). This
  replaces my earlier "variadic stays unbindable": without it, SQL parameters would be strings
  glued into the query.
- `(T, bool)` results are `T?`; `T?` of a pointer type means nil instead.
- An empty `extern` block imports a Go package only for what it does when loaded (a database
  driver registering itself): a blank import, allowed only inside an effect.
- Writers run one at a time. Tasks call a real effect's operations at once, so an operation that
  changes the state holds the effect's lock while it runs, and no change is lost; one that only
  reads takes a copy under a read lock and runs alongside the others. State that never changes
  needs no lock. Fakes need none: the test scheduler runs one task at a time.
- Fixed on the way (card 017's rule): `f()?` on its own line drops what is left, as `f()` does.

Details:

- No `==` on a Go value, or on what holds one (CAN0019 says why). Tests never hold one, so
  there is no `Show`.
- Methods are bound by Go's method expression, `(*sql.DB).Query`; a method's `ctx` goes after
  the receiver. Go's types are aliases in `bindings.go` (`type notes__Db = *go__2.DB`), so the
  rest of the program names them without importing Go.
- What goes into `...` is converted to its Go type by `candor.Arg[V]`: as it is for `...any`.
- Checked against Go (card 012): the type exists, `*` matches Go's method receivers and what
  functions give, an interface isn't held by pointer, a method exists on the type, a binding is
  variadic exactly when Go's function is. Help names the fix ("Go passes a pointer, *sql.Rows:
  declare it as `type *Rows`").
- `candor bind` drafts the types a function takes or gives, with their methods, inside the
  effect; other functions stay at module level. Methods are named after their type
  (`rowsNext`). Variadic functions are listed, not drafted: only the caller knows the arity. The
  whole of database/sql drafts, vets and builds.
- `Scan` takes pointers, which a binding can't pass, so `examples/notes.candor` reads rows with
  ten lines of Go next to it (`extern "./sqlrows"`). A Go package there may take Go types the
  effect declares.

Checked by `test/opaque.test.ts`, `examples/notes.candor` (SQLite for real; its tests against
the fake), and a program where 200 tasks bump a real effect's counter and none is lost.

### What tasks share: Mutex, Atomic, Channel

```
fn countWords(urls: List<string>, workers: int) -> Map<string, int> uses tasks, clock {
  return tasks.scope((s) => {
    let todo: Channel<string> = s.channel(0)
    let tally: Mutex<Map<string, int>> = s.mutex([:])
    let mut crew: List<Task<void>> = []
    for _ in 0..workers {
      crew.push(s.spawn(() => {
        for url in todo {
          let words = strings.words(fetch(url))
          tally.update((counts) => added(counts, words))
        }
      }))
    }
    for url in urls {
      todo.send(url)
    }
    todo.close()
    for w in crew {
      w.join()
    }
    return tally.get()
  })
}
let (a, b) = tasks.both(() => fetchUser(1), () => fetchScore(1))
```

Pal's calls:

- **A scope makes them, and they end with it**: `s.mutex(v)`, `s.atomic(v)`, `s.channel(n)`,
  like `s.spawn`. State shared for the whole program stays in an effect's state, which is
  already locked. They are handles: a copy is the same one, there is no `==`, and a function
  given one needs no `uses`, as for a `Scope`.
- **A Mutex changes by function.** `m.update((n) => n + 1)` runs the function under the lock,
  stores what it returns and gives it back; `m.get()` copies the value out;
  `m.updateWith((n) => (n + 1, n))` stores the first part and gives back the second. There is
  no lock guard, so a lock can't be held by mistake.
- **Channels close.** `ch.send(v)`; `ch.recv()` gives `T?`, `none` once closed and empty;
  `for x in ch` runs until then; `ch.close()`. Sending on a closed channel, or closing one twice,
  panics, as in Go.
- **`select` is card 019.**

Mine, mentioned at the time:

- **The function given to `update` only computes**: no effects (CAN0052), and no Mutex,
  Atomic, Channel or Task (a runtime panic, since a function value can't show it). So a lock is
  never held while waiting for anything, two Mutexes can't deadlock each other, and under the
  test scheduler a held lock is never contended.
- **A scope's function can't return a handle**, or a value holding one; a handle used after its
  scope ended panics (a lambda can carry one out). Tasks are as before: not checked.
- `s.channel(n)` takes what goes through it from where it goes (`let ch: Channel<int> =
  s.channel(8)`), as `[]` does: type arguments are inferred from arguments only, and `n` says
  nothing.
- `Atomic<T>` holds an int or a bool: `get`, `set`, `compareAndSet(old, new)`, and `add(n)` on
  ints, which gives the new value.
- `tasks.both(f, g)` gives `(A, B)`; if either can fail, `Result<(A, B), E>`, the first failure
  cancelling the other. Both must fail with the same `E`, and neither may return `void` (spawn
  those in a scope).
- A deadlock under the test scheduler (every task waiting, no timer left) fails the test with
  what each task waits for, and the seed:

  ```
  panic: candor: deadlock: every task is waiting and nothing can wake them (1 on Task.join, 1 on Channel.recv)
    is a Channel never closed? `ch.close()` ends a `for x in ch` loop
  ```

  On goroutines, Go's own "all goroutines are asleep" catches the same.

Friction, seen in the example: a scope's function ends before its tasks do, so reading a tally
the tasks built meant joining them first (`for w in crew { w.join() }`), as Go's `WaitGroup`.
Card 024 added `s.wait()` (below).

Lowering:

- `*candor.Mutex[T]` (a `sync.Mutex`), `*candor.AtomicInt`/`AtomicBool` (`sync/atomic`),
  `*candor.Channel[T]`, in `runtime/go/shared.go`. Every operation is a turn for the test
  scheduler, and a place where a cancelled task stops; a blocked send or receive wakes on
  cancellation.
- On goroutines a Channel is a Go channel. The test scheduler has its own: a queue where a
  sender waits until its item is taken or fits in the capacity, since a goroutine blocked on a
  Go channel would keep the turn.
- `Ctx.locked` counts the locks a task holds; `Ctx.point`, which every operation goes through,
  panics while it is non-zero.

Checked by `test/shared.test.ts` (100 tasks bumping a Mutex and an Atomic, on goroutines and on
the scheduler; a forgotten `close`, replayed by its seed), `runtime/go/shared_test.go`
(channels of capacity 0, 1 and 8 at five seeds, cancellation, deadlocks, goroutine counts), and
`examples/workers.candor`.

### `select`

```
// Whichever is ready: a reading from either sensor, or nothing for `quiet` ms.
match tasks.select([
  temps.onRecv((got) => event("temp", got)),
  winds.onRecv((got) => event("wind", got)),
  tasks.after(quiet, () => Event.Quiet),
]) {
  Event.Got { sensor, value } => log.push(sensor + " " + value.toString())
  Event.Closed { sensor } => open.remove(sensor)
  Event.Quiet => log.push("quiet")
}
// Offer a reading without waiting: false if nobody is ready to take it.
tasks.select([out.onSend(r, () => true), tasks.otherwise(() => false)])
```

Pal's calls:

- **A library call, not syntax**: `tasks.select(arms)`, where an arm is a value: `ch.onRecv(f)`,
  `ch.onSend(v, f)`, `tasks.after(ms, f)`, `tasks.otherwise(f)`. No new keywords, and arms can
  be built up in a list, so one select can take from however many channels are open, which Go's
  `select` statement can't without `reflect`. The cost is a lambda per arm.
- **`tasks.otherwise(f)` is Go's `default`**: picked at once, and only, when no other arm is
  ready. `tasks.after(0, f)` is not the same: it competes with the ready arms.
- **Among ready arms, the seed picks**, as among ready tasks. Go itself picks uniformly at
  random, so goroutines behave alike, and a failing test replays with its seed.

Mine, mentioned at the time:

- An arm is an `Arm<R>`: what its function gives when it is picked. Every arm of one select gives
  the same `R`, known from the first arm or from where the result goes. A receive arm's function
  gets a `T?`, `none` once the channel is closed, as `recv()` does; a closed channel's arm is
  always ready, so a loop has to drop it (the example keeps a map of the channels still open).
- An arm's function runs in the selecting task once picked, so it may use effects. They are
  captured where the arm is made, as for `s.spawn`: the function making an arm declares them, a
  function handed one needs no `uses`. An Arm holds its channel, so it is a handle: no `==`, and
  it can't leave the scope.
- One `otherwise` arm: a second could never be picked (an error in a literal list, a panic for a
  built one). An empty list panics, as `tasks.race([])` does.
- The deadlock report counts tasks "on tasks.select", with a hint about closing and `after`. The
  seed is now reported whenever it decided anything, a select tie included, not only when the
  failing test spawned a task.

Lowering:

- `*candor.Arm[R]`, in `runtime/go/select.go`. On goroutines, `Select` is `reflect.Select` over
  the arms, with a case for cancellation and a timer per `after`: any number of arms, at the
  cost of reflection. A plain Go `select` for a literal list would be a fast path; not done.
  A send goes through a `reflect.Value` of the arm's `T`, so a nil interface is sent as its type.
- Under the test scheduler a channel keeps the tasks waiting to receive apart from those waiting
  to send, and a sender that finds a receiver claims it. A select waits in every channel its
  arms use at once, as one receiver for all of them, and the sender that pairs with it says
  which channel to take from. Without the claim two senders could count on one receiver, or a
  select could take from another channel and strand a sender's item. Selects waiting to send are
  woken when a receiver arrives, room appears or the channel closes.
- The earliest `after` arm sets one timer, removed when the select ends; `otherwise` counts on
  the first look only.

Checked by `test/select.test.ts` (arm typing, what select refuses, lowering; a tie replayed by its
seed and a select nobody can wake, run through the CLI), `runtime/go/select_test.go` (ready arms,
timeouts, `otherwise`, a send only to a waiting receiver, select pairing with select, the same
winner at the same seed and both winners over 20 seeds, cancellation, closed channels, deadlock)
and `examples/fanin.candor`.

### Panics name Candor lines

```
panic: integer divide by zero
  at crash.candor:4 in div
  at crash.candor:9 in main
in a task of the scope at
  at crash.candor:8 in main
```

Pal's calls (card 020): Candor frames only, Go's and the runtime's hidden; `candor run` prints
the message then the trace and exits 2, as Go would; `candor test` reports a panic the same way,
and a failed `assert` that ran in a lambda or a task shows its frames under the diagram (one in
the test body itself has its line in the heading already).

- The emitter puts `//line <file>:<line>` before every Go line a statement produces. Go's
  directive positions only the line after it, and the lines after that count on from there, so
  each line gets one; a nested statement's lines keep theirs, and an expression-bodied lambda and
  an `else if` condition mark their own. After the Candor code a `//line main.go:N` makes the
  helpers Go's own again. The directives name absolute files (Go joins a relative one onto the
  package directory); the runtime shortens them to the working directory, so a frame names a
  file as the command line did. The generated Go is twice as long and not for reading, which it
  never was.
- A task's stack is gone by the time its scope re-raises the crash, so the runtime takes the
  frames where a panic is first recovered (`runtime.Callers`, keeping frames in `.candor` files)
  and carries them in a `crash`: the value, and one segment of frames per goroutine it crossed.
  A boundary adds a segment unless the frames there are a suffix of the last (re-raised on the
  goroutine it came from); each extra segment prints as `in a task of the scope at`. Go names
  are mapped back: `shop__total` is `total`, a closure in it too, `(*fx__kv__real).Get` is the
  operation `get`, `Ord__for__shop__User.compare` is `compare`, `test__3` is `test "name"`.
- `main` defers `candor.Report()`, which prints the report to stderr and exits 2. Go's runtime
  errors lose their `runtime error: ` prefix. A cancellation is not a crash and passes through.
- Under the test scheduler a deadlock is thrown at the root task's wait, caught as the scope's
  crash, and would be thrown again, bare, when the scope waits for its tasks: the scope's wait
  prefers the recorded crash, which has the frames of where the code got stuck.
- `CANDOR_TRACE=go` leaves the panic to Go, for debugging the compiler: Go's own trace, whose
  positions are Candor's but whose names are Go's.

Checked by `test/panics.test.ts` (directives per line, at column one, reset before the helpers;
a division by zero in a helper run through the CLI, a crash in a task, the same in test reports,
`CANDOR_TRACE=go`), `runtime/go/trace_test.go` (name mapping, messages, segments, `Report`), the
deadlock reports in `test/shared.test.ts` and `test/select.test.ts`, and
`test/fixtures/failing.out`.

### Test reports as data: `--json`, and `--only`

Picked by Claude (Pal: "you choose a task"). An AI coder's loop is run, read, fix, run the one
test again; the report was text only, and every run ran everything.

- **`candor test f.candor --json`** prints the report as one JSON document on stdout.
  Diagnostics stay JSON on stderr, as for every command, so a run that didn't compile and one
  that did are told apart by stream. Exit codes are unchanged: 0 all passed, 1 otherwise.
- **`--only <text>`**, repeatable, runs the tests whose name contains the text. A filter that
  matches nothing is an error (exit 1, the names listed on stderr): a mistyped name must not
  pass quietly. The summary line gains `, N filtered out`.

```json
{
  "file": "test/fixtures/failing.candor", "seed": 7, "passed": 1, "failed": 7, "filtered": 0,
  "tests": [
    { "name": "passes", "status": "pass", "seeded": false },
    { "name": "arithmetic", "status": "fail", "seeded": false,
      "failure": { "kind": "assert", "line": 38, "source": "assert total(a, 22) == 42",
        "parts": [ { "col": 7, "text": "total(a, 22)", "value": "41" },
                   { "col": 13, "text": "a", "value": "20" },
                   { "col": 20, "text": "total(a, 22) == 42", "value": "false" } ],
        "traces": [ [ { "file": "test/fixtures/failing.candor", "line": 38, "fn": "test \"arithmetic\"" } ] ],
        "text": "assert total(a, 22) == 42\n       |     |      |\n..." } },
    { "name": "panics", "status": "fail", "seeded": false,
      "failure": { "kind": "panic", "message": "integer divide by zero",
        "traces": [ [ { "file": "test/fixtures/failing.candor", "line": 68, "fn": "div" },
                      { "file": "test/fixtures/failing.candor", "line": 72, "fn": "test \"panics\"" } ] ],
        "text": "panic: integer divide by zero\n  at test/fixtures/failing.candor:68 in div\n..." } }
  ]
}
```

- `seeded`: the test's task order or select picks drew on the seed, so replaying it needs
  `--seed`. `seed` is `null` when the file has no tests (the CLI prints that document itself,
  without building).
- Per test, `runs` is how many task orders it ran in and `seed` the last one's: for a failure,
  the seed that replays it (card 042).
- `failure` is a discriminated union on `kind`. An assert has `line`, `source` (the statement,
  flattened to one line as the diagram shows it) and `parts`; a panic has `message`. Both have
  `traces` and `text`, the human report body verbatim, for a tool that just shows it.
- `parts` are the recorded sub-expressions, left to right: `col` is the rune offset into
  `source` where the diagram's bar stands (a binary's operator, a call's or member's name),
  `text` the part's own source, `value` as Candor writes it. A part that never ran (the right
  side of a short-circuited `&&`) is left out, as in the diagram.
- `traces` are the Candor frames as the panics card collects them: segments, innermost first,
  each frame `file`, `line`, `fn`; a task boundary starts a new segment. An assert in the test
  body has one frame, the test's, though the text omits it.
- Not HTML-escaped: `a > b` reads as written.

To quote a part, the emitter records each part's source next to its column
(`candor.Fail(line, source, cols, texts, values)`). That showed that a parenthesized expression
had the span of its contents, so `(find("Bob") ?? "?") == x` quoted as `find("Bob") ?? "?") ==
x`. **An expression's span now includes its parentheses**, as rustc's does; diagnostics
underline them too. Diagram bars moved for nothing but `-`, `!` and `?`, which now carry an
operator span of their own, as binary operators did.

Lowering: `RunTests` reads `-seed`, `-only` and `-json` from the test binary's arguments (the
CLI passes them through), filters, and builds the report as data; the human form prints each
result as it comes, the JSON form once at the end.

Checked by: `test/testing.test.ts` ("--json", "--only", "a file without tests", the recorded
part texts) and `runtime/go/testing_test.go` (filtering, parts, the JSON union, the options).

### `xs[i] = v`: items change in place, copies never see it

Picked by Claude (Pal: "pick another task"). Lists were values with `push`/`pop` on a `let mut`,
but an item couldn't be replaced; counting into buckets or filling a table meant rebuilding the
list, or a map.

```
let mut counts = [0, 0, 0]
for x in xs {
  counts[x % 3] += 1
}
let mut fib = [0, 1, 0, 0]
for i in 2..4 {
  fib[i] = (fib[i - 1] ?? 0) + (fib[i - 2] ?? 0)
}
```

- **The same places as `push`**: a `let mut` variable or a list field path from one
  (`s.items[i] = v`), with `=` and the compound operators. The item is a `T`, not a `T?`:
  `xs[0] = none` is a type error.
- **Out of range is a panic** (`index 5 out of range: the list has length 3`, with the Candor
  line), as Swift traps. A read stays `none`: there is a sensible value for "nothing there",
  none for "put this nowhere".
- **`xs[i][j] = v` is refused** (CAN0036) with the way out spelled: `xs[i]` is a `List<T>?`, so
  copy the row out, change it, put it back.

Lowering: copy on write, amortized. A `let mut` list variable that is written by index anywhere
gets a hidden flag, `xs__own`: whether the variable owns its items (true after a list literal,
false otherwise). `set__(&xs, &xs__own, i, v)` copies the list first unless the flag is set,
then sets it and writes in place. Reading the variable as a whole value (passing it, storing it,
returning it, looping over it, assigning it to another variable) clears the flag, so the next
write copies first and the other holder never sees it; a loop sees the list as it was. Reads by
index, `==` and method calls leave it set (no method hands the array on: `concat` and `sorted`
copy). So a loop of writes copies once at most, then writes in place; a list that is handed on
and written again copies once more. A list in a struct field may be shared with copies of the
struct, so `s.items[i] = v` copies every time (`setCopy__`), like `push` there. Effect state
gets a flag per operation call, so an operation's loop of writes copies once. `xs[i] op= v`
evaluates the index once, then reads the item (`get__`, the same panic) and writes.

The checker records which `let mut` lists are written by index (`indexed`) and every read of a
`let mut` list (`mutListReads`); the emitter marks the reads that don't share (`listRef`), as
`mapRef` does for maps. Checked by `test/fixtures/aliasing.candor` ("index writes: ..."),
`test/lists.test.ts` and `test/panics.test.ts` (the bounds panic).

### Digit separators

`60_000`, `1_000_000`: `_` between two digits, as in Rust, Go, TypeScript and Python. `1000_`
and `1__000` are errors naming the rule; `_1000` is a name, as it always was. No grouping rule
(`1_0_0` is fine): the compiler doesn't know which base the reader counts in. The lexer drops
the separators, so the overflow check, patterns and the emitted Go see plain digits; `assert`
quotes the source, so a failure shows what was written. Picked by Pal; checked in
`test/compile.test.ts`, used in `examples/tasks.candor`.

### `s.wait()`

```
fn countWords(urls: List<string>, workers: int) -> Map<string, int> uses tasks, clock {
  return tasks.scope((s) => {
    let todo: Channel<string> = s.channel(0)
    let tally: Mutex<Map<string, int>> = s.mutex([:])
    for _ in 0..workers {
      s.spawn(() => {
        for url in todo {
          tally.update((counts) => added(counts, strings.words(fetch(url))))
        }
      })
    }
    for url in urls {
      todo.send(url)
    }
    todo.close()
    s.wait()
    return tally.get()
  })
}
```

Picked by Pal. A scope's function ends before its tasks do, so reading what they built meant
keeping every handle and joining each (`for w in crew { w.join() }`): Go's `WaitGroup`, by hand.

- **`s.wait()` waits for every task spawned on the scope so far**, then the scope's code goes
  on: more may be spawned after it, and `wait` called again. It gives nothing back and needs no
  `uses`, as `s.spawn` doesn't.
- **Cancellation interrupts it**, as it does `join`: when a task fails or the scope is cancelled
  from outside, the waiting code unwinds at once; the scope still waits for every task before it
  ends, and its result is what it would have been.
- **A task calling `wait` on its own scope panics** instead of hanging (`candor: s.wait()
  inside one of the scope's tasks would wait for itself`): for work of its own, a task opens a
  nested `tasks.scope`. Tasks spawned by other tasks on the same scope are waited for like any
  other.
- A deadlock under the test scheduler reports it as `Scope.wait`.

Lowering: `s.Wait(ctx__)`. The group keeps every task it started, on goroutines too (it kept
them for the test scheduler only); `Wait` takes a snapshot and waits for each on its `done`
channel or the caller's cancellation, or under the scheduler by blocking on it as `join` does.
A task's context carries its own task, through nested scopes, so the self-wait is caught before
anything blocks. Checked by `runtime/go/tasks_test.go` (`TestWait...`, `TestSimWait`),
`test/tasks.test.ts` and `examples/workers.candor`.

### Strings: code points, and the first methods

Claude's call, open to veto: strings are UTF-8, and **`length`, `chars`, `indexOf` and `slice`
count code points**, as Python's `len` does. Go counts bytes, TypeScript UTF-16 units; neither is
what a reader means by "characters", and grapheme clusters (what a terminal shows as one glyph)
would need Unicode tables for a question backend code rarely asks. Bytes are `byteLength()`.

```
let s = "héllo, wörld 👋"
s.length()                   // 14; s.byteLength() is 19
s.chars()                    // ["h", "é", "l", ...]: the list to index or loop over
s.indexOf("wörld")           // 7, an int?: none when absent
s.slice(0, 5)                // "héllo"; both ends clamp, so slice(0, 80) shortens any string
"42".toInt() ?? 0            // an int?: none unless the whole string is a decimal int
```

- Methods: `length`, `byteLength`, `isEmpty`, `chars`, `contains`, `startsWith`, `endsWith`,
  `indexOf`, `slice`, `split`, `trim`, `toUpperCase`, `toLowerCase`, `replaceAll`, `repeat`,
  `toInt`. TypeScript's names, except where lists already have one (`contains`, `isEmpty`);
  `replaceAll` only, since TypeScript's `replace` of the first occurrence is a trap. `+` joins;
  `==` and `<` compare (by code point, which is Go's byte order for UTF-8).
- No `s[i]`: reaching a code point walks the string from its start. A method may cost that
  (`slice`, `indexOf`); index syntax should not. `isEmpty()` is the cheap test; `length()` is a
  pass over the string.
- `indexOf` and `toInt` give an `int?`: no `-1`, no `NaN`. `split` and `trim` behave as in
  TypeScript: `"a,,b".split(",")` keeps the empty part, `trim` removes Unicode white space.
- `slice(start, end)` clamps both ends to the string; a negative index panics, as `xs[i] = v`
  does out of range. `repeat` panics on a negative count.
- Habits get the Candor name in the error (`CAN0008`): `includes`, `toUpper`, `substring`,
  `replace`, `len`, `parseInt`, `charAt`, `join` on a string, and a few more.
- Lowering: Go's `strings` package inline where it matches (`strings.Contains`, `strings.Split`,
  `strings.ReplaceAll`); `candor.Chars`, `IndexOf`, `Slice`, `Repeat` and `ParseInt` in
  `runtime/go/strings.go` for what counts code points or panics Candor's way. A method that
  returns a `T?` gives Go's `(v, ok)` and the emitter wraps it in `optOf__`, which now drops the
  value Go hands back with `ok == false` (`strconv` returns the clamped max on a range error), so
  every `none` is one value and `==` holds. Tests: `test/strings.test.ts`,
  `runtime/go/strings_test.go`, `examples/text.candor`.
- `examples/bindings/strings.candor` lost its `extern "strings"` block; what Go has and Candor
  lacks (`Fields`, `Cut`) can come back through one. `title` (Go next to the binding) and `words`
  stay, and `fanin`, `settings` and `words` call the methods.

### Flow typing for optionals

Pal's calls (card 026): a test narrows the name itself, as in TypeScript and Kotlin.

```
fn greet(p: Person?) -> string {
  if p == none {
    return "nobody"
  }
  return "hi " + p.name          // p: Person here
}
if u.boss != none && u.boss.age != none { ... }   // fields of locals narrow too
```

- What narrows: `x != none`, `x == none` (in the other branch), `x == v` for a plain `v`, `!`,
  `&&` and `||` (the right side sees what the left proved). Inside `if`/`else` branches and
  `while` bodies, and after a branch that returns, breaks or continues. A `while` without
  `break` leaves its condition false behind it.
- What is a path: a local (parameters, `let`, `let mut`, pattern names, effect state) and its
  fields. Not `xs[i]`, calls, or extern `let`s, which may give a different value each time.
- `let mut`: known until assigned. `x = none` or `x = f()` ends it; `x = 5` makes `x` present
  again; `x += 1` keeps it. Assigning `u` ends what was known about `u.boss`. A loop forgets,
  from its first step, every path its body assigns. This is sound because a lambda cannot
  capture a `let mut`, so every change is a statement in plain sight. Effect state is safe too:
  a writing operation holds the lock throughout, a reading one works on a copy.
- After an `if` or `match`, what is known is what every arm that falls through knows.
- A lambda's body may run later or never, so what it learns stays inside it.
- A narrowed list or map is not changed in place (`push`, `xs[i] = v`, `m[k] = v`): it is still a
  field of a `T?` in Go, and copy-on-write tracks variables, not those. The error says to copy
  it out and assign it back. Assigning a narrowed name whole (`x = none`) is fine.
- `x ?? d` on a narrowed `x` is the usual "never `none`" error, saying a test proved it present.
- Fixed on the way: `x == none` now works for any `T?`, Go values included (it reads only
  presence, `!x.some`).
- Lowering: the checker records narrowed reads (`narrowed` in the result); the emitter reads
  `.value` from them.

### String interpolation

Pal's calls (card 027): `${}` in plain strings, only the types that have `.toString()`, any
expression inside.

```
"#${o.id} for ${who}, ${state}"
"email: ${u.email ?? "none"}"     // nested strings are fine
"cost: \${n}"                     // `\$` escapes; a `$` not followed by `{` is text
```

- **Every `"..."` interpolates**, as in Kotlin and Dart; TypeScript's templates without the
  backticks, so there is one string literal. No `$name` shorthand: one way to write it.
- **`string`, `int` and `bool` only** (`CAN0005`). Anything else must say how it reads, and the
  fix fits the type: `?? "..."` or a test for a `T?`, `.join(", ")` (after a `map` for ints) for
  a list, a field for a struct, a `match` for an enum. This keeps "no implicit conversions": no
  `Optional(42)`, no `[object Object]`, and no display format for structs to become a promise.
  A `Show` trait could widen it (it did: "The `Show` trait", below).
- **Any expression** inside, struct literals included (the `}` is unambiguous). A string, and
  what it interpolates, stays on one line.
- `+` with a string and an int or bool now suggests interpolating it (`CAN0019`).
- A string without `${` is still a plain `String`, so imports, `extern`, test names and
  patterns take only those; a `${` there is a syntax error saying the string must be fixed.
- Lexing: a `${` lexes its inside recursively up to the matching `}` (brace depth counted, so
  nested strings and blocks work); the token carries text and token lists, and the parser runs a
  sub-parser on each. Positions are the real source positions, so diagnostics, panics and assert
  diagrams point inside the string.
- Lowering: Go concatenation, `strconv.FormatInt`/`FormatBool` for ints and bools, parts through
  `operands`, so they run left to right even when a later part needs statements first (`${g()?}`).
  An assert diagram shows each part's value and the whole string. Tests:
  `test/interp.test.ts`, `examples/orders.candor`.

### Syntax errors don't stop the check

Pal's calls (card 028): resync at statements and declarations, type-check what parsed, recover
in the lexer too. One typo used to hide every other diagnostic in the file; an AI coder fixed
one line per run, and an editor would lose its squiggles on each half-typed line.

- **A statement resyncs at the next line of its block**, or at the `}` closing it (brackets are
  counted from the statement's start). One bad line, one error, and the function goes on.
- **A declaration resyncs at the next declaration in column 1.** Bodies are indented, so a
  block that meets one (`fn`, `struct`, `test "..."`, `effect Name`, ...) in column 1 reports its
  `{` as never closed, with the line, and the next declaration is read as one. A missing `}`
  costs one error, not the rest of the file.
- **One error per bad line.** An error is left out when the lexer, or a block inside the same
  statement that recovered, already reported one between the statement's start and it.
- **The checker runs on what parsed**, and its diagnostics are dropped where they may only
  follow from a syntax error: anywhere in a declaration with one, and "unknown" errors
  (`CAN0002`, `0003`, `0008`, `0015`, and a missing `main`) for names declared in a dropped
  declaration, across imports too. Nothing is emitted while there is a syntax error.
- **The lexer carries on**: an unterminated string or `${` ends at its line, an unknown
  character (a run of them is one error) or escape is skipped, a name with `__` and a misplaced
  digit separator are kept. Diagnostics of a file come in its order, lexer's and parser's mixed.
- `module name` must parse: without it nothing else is read.
- Known limit: newlines inside `( )` don't end statements, so an unclosed `(` takes the rest of
  its block, as one error. Tests: `test/recovery.test.ts`.

### Contracts: `requires` and `ensures`

A function states what it expects and what it promises in its signature, where a reader sees
it without the body or the callers (principle 4):

```
fn withdraw(a: Account, amount: int) -> Account
  uses io
  requires amount > 0
  requires amount <= a.balance
  ensures result.balance >= 0
{
```

- **Clauses come after `-> T` and `uses`, one per line, before `{`.** `requires` and
  `ensures` are keywords only there, and `result` (the returned value) only inside an
  `ensures`, so all three stay usable as names. Clauses are checked in order, each on its own.
- **Always checked**: in tests, `run` and `build`. A broken contract never goes unnoticed, and
  the cost is small next to a backend's I/O. A flag to drop them can come if profiles ask.
- **A broken contract is a bug, so it panics**, with the diagram a failed `assert` shows and
  the Candor frames. The message says whose bug: "`withdraw` was called with arguments that
  break its `requires`" (the next frame is the call), or "`withdraw` returned a value that
  breaks its `ensures`". In a test it fails the test; `--json` gives it `kind` `requires` or
  `ensures`, with `fn`, `line`, `source` and `parts` as an assert has them.
- **Contracts are pure**: no effects (`CAN0053`), and no `?` or `return` outside a lambda. They
  run on every call, so they must not change anything or leave the function. Functions without
  `uses` can be called.
- **For a `Result`, `result` is the whole `Result`**: `ensures match result { Ok(n) => n >= 0,
  Err(_) => true }`. No special rule until real code wants one.
- `ensures` on a function returning `void` is an error: parameters can't change, so a promise
  about them is a `requires`. A parameter can't be named `result` when there is an `ensures`.
- **Where**: functions and `impl` methods. A trait method or an `extern` with a contract is a
  syntax error; an effect operation or a fake's function is `CAN0053`.

Lowering: each `requires` is an `if` at the top of the body that calls `candor.Broke` with the
recorded parts, as `assert` does with `candor.Fail`. With an `ensures`, the body runs in a
closure of the same signature, `result := func() T { ... }()`, so every `return` and `?` in it
hands its value to the checks; the closure's frame is named after the function. Types get their
`Show__` method whenever the program has a contract, not only in tests.

### Visibility: `pub`

Decided by Pal: private by default, `pub` to offer, per-field `pub`, and a `pub` declaration
can't name what isn't. What a module offers is exactly what it marks, so an AI reader sees the
interface without reading the bodies, and a helper can't leak by accident.

```
pub struct Account {
  pub owner: string
  balance: int
}

pub fn open(owner: string) -> Account { ... }
```

- **`pub` goes before `fn`, `struct`, `enum`, `trait` and `extern`.** Without it, only the
  module itself (its tests included) can use the declaration (`CAN0054`, with help listing what
  the module does offer). `pub` is a keyword only there and before a field, so it stays a name.
- **A struct's fields are `pub` one by one.** A struct with a private field can be named,
  passed and compared from outside, but not built (a literal or a `...` copy), and that field
  can't be read, matched or written. Only its module makes one, so its functions can hold an
  invariant; the error's help names the `pub fn`s that return one. With contracts, that's an
  opaque type with a checked interface.
- **A `pub enum` exposes its variants and their fields.** There are no per-variant marks: a
  `match` from outside must be able to see every case.
- **`pub extern "x" { ... }` makes every item `pub`;** without it, `pub fn` or `pub let` marks
  one item. An item can't repeat its block's `pub`.
- **An effect's operations are always public**, and its fake's functions too: the effect is
  what the module offers. (In the module with `main`, nothing is exposed: card 033. Since card
  034 an operation is written `pub fn`; a plain `fn` is a helper.) `pub` on an effect, a fake, their members, an effect's `extern`, an
  `impl` or its methods, a trait's methods, a variant or its fields, or a test is a syntax error
  that says what it follows instead. It doesn't stop the parse.
- **What is public can't name what isn't** (`CAN0055`): a `pub fn`'s parameters, result and
  bounds, a `pub` field's type, a `pub enum`'s fields, a `pub trait`'s methods, a public type's
  bounds and the effect's operations. Otherwise callers would hold values whose type they can't
  write. This holds in an entry module too, so an effect's error type is `pub` even in a
  program of one file (`examples/dirs.candor`, `examples/notes.candor`).
- **A private trait's methods can't be called from outside**, even on a type that has the impl.
- Private names stay out of the suggestions an error makes. A bare `Ledger` that an import
  keeps private gets "module `bank` declares a `Ledger`, but keeps it private".
- `candor bind` drafts `pub extern`: a binding module exists to be imported.

Lowering: none. Everything is still one Go `package main`; visibility is the checker's alone.

### The `Show` trait

Decided by Pal: a built-in trait, given by hand, whose method is `toString`; interpolation
takes any `Show` type, and containers stay refused.

```
impl Show for Order {
  fn toString(self) -> string {
    return "#${self.id} for ${self.customer.name}, ${self.status}"
  }
}

io.println("${o}")        // or o.toString()
```

- **`Show` is built in**, beside `Eq` and `Ord`: `trait Show { fn toString(self) -> string }`.
  `string`, `int` and `bool` have it already (`impl Show for int` is `CAN0048`), so `Show` is
  "has `.toString()`", and the name is taken.
- **Only by hand** (derived too since card 057, below). No type is `Show` until its module
  writes the impl, so no display format, and no field (a password, say), becomes a promise by
  accident. This keeps card 027's rule.
- **`"${x}"` takes any `Show` type**, a type parameter with the bound included. Without it, the
  error's help writes the impl (`impl Show for U { fn toString(self) -> string { ... } }`) for a
  type of this module, or the bound for a type parameter, beside the old fixes.
- **Lists, optionals and Results are still refused** (they show since card 057), with the same
  help as before: whether `none` shows as `none`, `-` or nothing is the writer's choice, and
  generic impls don't exist yet anyway.
- `<T: Show>` takes `string`, `int` and `bool` as well as types with impls.

Lowering: a `Show` part of a string calls the dictionary, `Show__for__m__Order{}.toString(ctx__,
o)`; in generic code, the bound's. `string`, `int` and `bool` read as before, and passed to a
bound they get `showGo__[T]`.

### What the todo service found

Card 032 wrote a real backend with what exists: `examples/todos.candor`, a JSON-over-HTTP
to-do list in SQLite, with JSON by hand and HTTP over a Go helper. Pal's calls: a pure core with a real loop, JSON by hand
both ways, SQLite, and gaps logged, not fixed. All of it works: `PORT=8080 candor run` serves
every route to curl, and `bun test` replays requests and runs the test blocks.

What worked: `handle(req) -> Response uses todos` is the whole service, and the fake made its
tests a line each. `Result<Response, Response>` with `?` turns every error into an early
answer. Narrowing, `match` on a `(key, value)` tuple with literals and variants, and the
errors' help (CAN0055 named the type to make `pub`; CAN0043 said to move the second effect).

The gaps, costliest first:

1. **JSON** (fixed, card 036: `impl Json`) is 250 lines by hand, plus a `toJson` per type and a field-by-field reader for
   each body. The biggest cost by far. A `json` module with derived encoding and decoding
   needs a decision on deriving.
2. **Effect operations can't share code** (fixed, card 034: helpers). They can't call each other, and a helper outside
   can't take Go's types, so the row-reading loop is written three times. Wants operations
   calling operations, or private helpers inside an effect.
3. **A shadowing error cascades** (fixed, card 033). CAN0016 keeps the old binding, so `let found = ...` where
   `found` is a function gave four follow-on errors about a function type. The new binding
   should win. Also: a pattern can't reuse its subject's name (`t => Ok(t)` on a `t: Todo?`),
   so every unwrap needs a fresh name; narrowing is the way out.
4. **No process environment** (fixed, card 035: `env`). `$PORT` comes from a Go helper inside `server`. An `env`
   effect (arguments and variables, with a fake) is wanted by any service.
5. **SQL through bindings is clumsy** (fixed, card 038: `sql`). One `Exec` binding per shape of arguments (four, plus
   two `Query`s), and rows come back as strings to parse again. A database module, or
   bindings that take a list of SQL values.
6. **Serving HTTP needs Go to turn callbacks into a queue** (fixed, card 037: `http`) (`serve.go`), one request at a
   time, with no headers or query strings. A standard `http` server module, with a task per
   request, once the effects can stand it.
7. Small ones, each a few lines to fix (the first five fixed, card 033):
   - An entry module must `pub` the types its own effect uses, though nothing can import it.
   - `while true` doesn't count as a way out, so the parser ends in a dead `return`.
   - `candor check` wants a `main` in a library module, though `candor test` doesn't.
   - A fake's state shares names with the real effect's externs (`lastId` clashed).
   - No `??` on a Result, so unwrapping one with a default takes a `match` (kept; the help
     now writes the match).
   - One effect per module put `server` in a file of its own. That's probably right.
   - `json.Json.Num { value: t.id }` is long, which is the imported-pattern shorthand
     question again. `\u` escapes need a string made from a code point.

Suggested cards, in this order: the small ones together (and the cascade); operations calling
operations; `env`; JSON with deriving; an `http` server module; SQL.

### Papercuts from the todo service

Card 033 fixed the small gaps card 032 found, and the cascade. Pal's calls: the module with
`main` skips the exposure check, and `??` stays refused on a Result, with better help.

- **A name given twice is bound anyway.** CAN0016 is reported, and what follows means the new
  binding, so `let found = [1, 2]` beside `fn found` gives one error, not one per use.
- **An effect's externs are names only its operations see.** A fake's state, or any local
  outside the operations, may use the same name (`let mut lastId` beside `as lastId`).
- **`while true` without a `break` ends a function**, so nothing dead has to follow it. A
  `break` inside a nested loop is that loop's. Lowering: `for {`, which Go also counts as an
  end (`for true {` it doesn't).
- **`candor check` doesn't want `main`**, as `candor test` doesn't; `run` and `build` still do.
- **The module with `main` skips CAN0055.** Nothing imports a program, so what it exposes
  reaches no one, and its effect's types needn't be `pub`. Imported, it is checked as any
  module is. A module without `main` is always checked.
- **`??` on a Result stays an error**: it would drop the error unread. The help writes the
  `match` that drops it in plain sight (`match r { Ok(v) => v, Err(_) => ... }`), or `?`.

`examples/todos.candor` lost its workarounds.
`test/papercuts.test.ts`, and a case in `test/visibility.test.ts`.

### Helpers inside an effect

```
effect todos {
  extern "database/sql" { ... }
  let mut db: Db? = none

  pub fn get(id: int) -> Result<Todo?, TodoError> {
    return find(connected(db)?, id)
  }

  fn find(conn: Db, id: int) -> Result<Todo?, TodoError> {
    let rows = failed(queryId(conn, "SELECT ... WHERE id = ?", id))?
    return Ok(read(rows)?.first())
  }
}
```

Pal's calls:

- **Helpers, not operations calling operations.** A helper is a function inside the effect: it
  may call the effect's externs and take or give Go's types (`fn read(rows: Rows)`), and only
  the effect's operations and helpers may call it (CAN0043 elsewhere: the rest of the module,
  the fake, another module). Operations still can't call each other, so the lock stays one per
  operation and nothing is re-entered.
- **Helpers don't see the state.** The operation holds it (and the lock), and passes what the
  helper needs: `find(connected(db)?, id)`. Reading it there would see the operation's copy or
  the holder's, depending on whether it had written yet. CAN0002 names the state and says to
  pass it in, once per helper and name.
- **`pub fn` is an operation, `fn` a helper**, as `pub` means public everywhere else (card 030).
  This replaced "an effect's operations are always public, without `pub`": every effect gained
  `pub` on its operations. The fake is unchanged: it implements every `pub fn`.

Mine, mentioned at the time:

- A helper takes no `uses` (like operations) and no contracts (like operations and fakes); it
  may be generic, since it lowers to a plain Go function, not an interface method.
- Code written before this (an operation without `pub`) says what happened: the fake's function
  is "a helper of `effect kv`, not an operation", and `kv.next()` is "a helper inside `effect
  kv`", both with `pub fn` in the help.
- Lowering: a helper is a Go function beside the effect's types (`kv__label(ctx__, n)`).

`examples/todos.candor` reads rows in one place (`read`), finds a todo in one (`find`, for
`get` and `change`), and checks for an open database in one (`connected`).
`test/helpers.test.ts`.

### The `env` effect

```
fn main() uses io, env {
  let port = env.get("PORT") ?? "8080"
  for a in env.args() { ... }
}

test "reads the port" {
  env.set("PORT", "9000")
  env.setArgs(["-v"])
  ...
}
```

Pal's calls:

- **Variables and arguments.** `env.get(name) -> string?` (none when unset; set to "" is "")
  and `env.args() -> List<string>`, the arguments after the program's name. Exiting with a
  status is left for later: it needs rules for running tasks and for tests.
- **Read only.** Setting a variable changes it for every task at once, and Candor starts no
  child processes to hand it to. Only the fake has `set` and `setArgs` (CAN0035 elsewhere), and
  starts with no variables and no arguments in every test.

Mine, mentioned at the time:

- `candor run file.candor -- args...`: what follows `--` is the program's, untouched (`--json`
  there is an argument). `--`, not "everything after the file", because options may follow the
  file. Only `run` takes it; a built binary takes its arguments as any program does.
- The runtime's `Get` gives Go's `(v, ok)`; the call site builds the `T?` (`optOf__`), and
  `env.get` as a value is wrapped the same way.
- `examples/todos.candor` reads `$PORT` with `env.get`; `server`'s `port()` and its Go helper
  are gone.

`test/env.test.ts`, `runtime/go/env.go`.

### JSON, derived: `impl Json`

```
import "json"

struct Todo {
  id: int
  title: string
  done: bool
}
impl Json for Todo

json.encode(todos)                       // [{"id":1,"title":"milk","done":false}]
let t = json.decode<Todo>(body)?         // Result<Todo, json.Error>
```

Pal's calls:

- **A bodyless `impl` derives it.** `impl Json for Todo`, with no braces. No type is `Json`
  otherwise, so a field (a password, say) never goes over the wire by accident: card 027's
  rule, as for `Show`. A body is refused for now (`Json` is derived, not written), and so is a
  bodyless impl of any other trait, with the methods to write in the help. (A form by hand,
  `via`, came with card 059.)
- **One built-in trait, both ways.** `Json` sits beside `Eq`, `Ord` and `Show`. `int`, `string`
  and `bool` have it, and `T?`, `List<T>` and `Map<string, T>` when `T` does, which is how
  `json.encode(todos)` works without generic impls. Every field must be `Json`; the error names
  the field and the fix (`derive it: impl Json for Inner`, `key it by string: Map<string, V>`).
- **Enums:** if no variant has fields, a string (`"Open"`); otherwise an object whose `kind`
  names the variant, `{"kind":"Circle","r":2}`, `{"kind":"Dot"}`. A variant field named `kind`
  is then an error. Adding a field to one variant changes the form of the whole enum.
- **Decoding skips unknown fields**, so a client can be newer than its server (`decodeStrict`
  refuses them, card 059). A missing or
  null `T?` field is `none`; a missing other field is an error. Errors say where:
  `$.items[2].title: expected a string, found 3`, `$.status: expected one of "Open", "Done",
  found "Shut"`, `$: not JSON: it ends too soon`.

Mine, mentioned at the time:

- `json` is a standard module, `std/json.candor`, written in Candor and shipped with the
  compiler: `import "json"` reads it whatever the importing file's directory holds, so where a
  name comes from stays visible at the import. Another module named `json` clashes with it.
  `json.Error { path, message }` is a plain struct with `impl Show` (`"${e}"`).
- `json.decode<Todo>(text)` names its type: type arguments come from the arguments, never from
  where the value goes (card 013), and the error's help writes the call.
- A `none` field encodes as `null` (left out since card 076, below). Field names are as written (renamed since card 059). Integers only
  (Candor has no floats), and one past 64 bits is an error, not a rounding.
- `examples/todos.candor` derives its four types (`Todo`, `NewTodo`, `Change`, `Problem`) and
  reads bodies with `readBody<T: Json>`. A PATCH that changes nothing is a 400, since a typo
  (`{"don": true}`) is now skipped rather than refused.

Lowering: the `Json` bound is `candor.Json[T]`, a Go interface with `Enc(o *JsonOut, v T)` and
`Dec(j any, path string) (T, *JsonErr)`. Dictionaries: `candor.JsonInt`, `JsonString` and
`JsonBool`; `candor.JsonList[T, D]` and `JsonMap[T, D]`; `jsonOpt__[T, D]` in the program
(since `opt__` is); and `Json__for__m__Todo` per impl, whose methods the compiler writes field
by field, with no reflection. Text is parsed into Go values with `encoding/json` (checked
whole first, for its error messages), objects keeping their key order, so a decoded `Map`
keeps the document's. `json.encode` and `json.decode` have stub bodies in `std/json.candor`;
the emitter gives them Go ones (`stdBody`).

`test/json.test.ts`, `runtime/go/json.go`.

### An `http` server module

```
import "http"

fn handle(req: http.Request) -> http.Response uses todos {
  let one = http.route(req, "GET /todos/{id}")
  if one != none {
    return getTodo(one["id"] ?? "")
  }
  ...
  return http.jsonResponse(404, Problem { error: "no route ${req.method} ${req.path}" })
}

fn main() uses io, env, todos, http, tasks {
  match http.serve(":8080", handle) {
    Ok() => {},
    Err(e) => io.println("can't serve: ${e}"),
  }
}
```

Pal's calls:

- **`http.serve(addr, handle)`**, which blocks and runs `handle` in a task per request. It gives
  `Err` when it can't listen; otherwise it serves until its task is cancelled, and then waits
  for every request: no task outlives it. `uses http, tasks, handle`: the network, concurrency,
  and whatever `handle` does (`uses f`, card 013). `handle` is a plain function, so tests call
  it with a Request and never serve.
- **Simple maps.** `Request { method, path, query, headers, body }` with `Map<string, string>`
  for query and headers: header names lowercase, a key given twice keeps the first.
  `Response { status, headers, body }`.
- **A crash answers 500.** A panic in `handle` is printed with its Candor lines and the
  request (`in a request: GET /boom, answered 500`), and the other requests carry on. This
  departs from "a crash cancels the scope", for servers only: one bad request mustn't stop the
  service.
- **Routing by a match helper**: `http.route(req, "GET /todos/{id}") -> Map<string, string>?`
  gives the path's parameters, or none. A pattern without a method matches any, which is how a
  known path with the wrong method becomes a 405. No route table: `handle` stays one function.

Mine, mentioned at the time:

- `http` is a standard module (`std/http.candor`), like `json`, and imports it:
  `http.jsonResponse(201, todo)` encodes and sets `content-type`; also `http.textResponse` and
  `http.emptyResponse(204)`. Not `http.json`: the module imports `json`, and a function can't
  share its name.
- `effect http {}` has no operations yet: having it is the permission, as for `tasks`. Its fake
  is empty, and `http.serve` in a test gives `Err` ("tests don't serve: call the handler").
- A body over 1 MB is a 413 without calling `handle`; a status outside 100–999 is a crash, so a
  500. Headers a Response doesn't set are Go's (it sniffs `content-type`).
- A standard module's warnings aren't shown: `serve`'s stub body uses nothing it declares.
- The todo service matches paths with `http.route` and answers with `http.jsonResponse`, and
  `main` serves in one call.

Lowering: `serve`'s stub body is replaced (`serveBody`) by a call to `candor.Serve` in
`runtime/go/http.go`, with the handler converted to the runtime's `HttpRequest` and
`HttpResponse`. Go's `net/http` runs each request on its own goroutine; the runtime gives it a
context whose token is a child of the server's, cancelled too when the client goes away. The
effects a handler uses were already safe for that: a real effect's operations lock its state.

`test/http.test.ts`, `runtime/go/http.go`.

### SQL

```
import "sql"

struct Todo {
  id: int
  title: string
  done: bool
}
impl Row for Todo

fn add(title: string) -> Result<Todo, sql.Error> uses sql {
  let id = sql.insert("INSERT INTO todos (title) VALUES (${title})")?
  return Ok(Todo { id, title, done: false })
}

fn get(id: int) -> Result<Todo?, sql.Error> uses sql {
  return Ok(sql.query<Todo>("SELECT id, title, done FROM todos WHERE id = ${id}")?.first())
}
```

Pal's calls:

- **A `sql` effect**, one database per program: `sql.open(source)`, then `sql.exec` (rows
  changed), `sql.insert` (the new row's id) and `sql.query<T>`, with `uses sql`. In a test the
  database is SQLite in memory, fresh for every test, so tests run the real SQL instead of a
  fake that agrees with itself. A service no longer needs an effect of its own around the
  database.
- **`${...}` in a query is a parameter.** Where a `sql.Query` is expected, a string literal is
  one: each `${...}` becomes `?`, its value sent apart from the text. Anything else is refused,
  a string variable included, so a query can't be glued together and injection can't be
  written. Parameters are int, string, bool, or an optional of those (none is NULL).
- **`impl Row for T`, derived, by name.** Bodyless, like `Json`; for a struct whose fields are
  int, string, bool or optionals of those. Columns fill fields by name, in any order. A missing,
  extra or repeated column is an error naming it, and NULL goes only into a `T?` field. `int`,
  `string` and `bool` are `Row` for a query of one column: `sql.query<int>("SELECT count(*) ...")`.

Mine, mentioned at the time:

- `sql` is a standard module (`std/sql.candor`). `Row` is built in beside `Json`, as `Json` is,
  so `impl Row for Todo` needs no import in a module that doesn't run queries itself.
- A `${...}` inside quotes (`'${name}'`) is an error: it would be the text `?`. The help shows
  `LIKE ${"%${name}%"}` for patterns. Quotes are counted in the text before it.
- `let q: sql.Query = "..."` works, and `sql.Query` can be passed around; it has no `==`.
- In a test, `sql.open` leaves the in-memory database as it is, so code that opens and then
  migrates runs unchanged. Real: a second `open` is an error, and so is a query before one.
- `sql.Error { message }`, as the database says it, with `impl Show`. The driver's messages
  stand; row errors are Candor's (`no column "tag" for Note: select it`).
- SQLite is modernc.org/sqlite, which `std/sql.candor` imports inside its effect (`extern ... {}`),
  so only programs that import `sql` build it. One connection: SQLite takes one writer at a
  time, and an in-memory database is per connection. Queries run with the task's context, so a
  cancelled task stops waiting.

Lowering: `sql.Query` is an alias of the runtime's `candor.SQLQuery{Text, Args []any}`, built
at the literal (an optional through `sqlArg__`, nil for none). `main` gets `candor.RealSQL()` as
the effect and a test `candor.MemorySQL()`; `sql`'s stub bodies are replaced (`sqlBody`) by calls
on it. `T: Row` is a dictionary, `candor.Row[T]`, with `FromRow(cols, vals)`: the compiler
writes one per impl, a switch on column names, and `candor.RowOfInt` etc. read one column.

`test/sql.test.ts`, `runtime/go/sql.go`.

### Transactions

```
fn transfer(from: int, to: int, n: int) -> Result<void, BankError> uses sql {
  let db = (e: sql.Error) => BankError.Db { error: e }
  return sql.transaction<void, BankError>(() => {
    sql.exec("UPDATE accounts SET balance = balance - ${n} WHERE id = ${from}").mapErr(db)?
    let left = sql.query<int>("SELECT balance FROM accounts WHERE id = ${from}").mapErr(db)?
    if (left.first() ?? 0) < 0 {
      return Err(BankError.Insufficient)
    }
    sql.exec("UPDATE accounts SET balance = balance + ${n} WHERE id = ${to}").mapErr(db)?
    return Ok()
  }, db)
}
```

Pal's calls:

- **`sql.transaction(f, wrap)`, any error type.** `f: fn() -> Result<T, E>` runs in a
  transaction: `Ok` commits, `Err` rolls back and is given back, and a crash or a cancel rolls
  back. A failed BEGIN or COMMIT is a `sql.Error`, given back as `Err(wrap(e))`: the conversion
  is explicit, as `?` has none. When `E` is `sql.Error`, `wrap` is `(e) => e`.
- **Nested is a savepoint.** A transaction inside another rolls back only its own part on
  `Err`; the outer one decides the rest. Helpers that use transactions compose.
- **`r.mapErr(f)`** on any Result: `Result<T, E>` to `Result<T, F>`. Found while designing this:
  inside `f` every query gives a `sql.Error`, and `?` needs the function's own `E`, so without
  it each query would need a `match`.

Mine, mentioned at the time:

- The type arguments are written: `sql.transaction<void, BankError>(...)`. Type arguments come
  from the arguments, and a lambda whose first `return` is `Err(...)` says nothing about `T`;
  the error's help writes them out from where the result goes. Friction, noted below; card 043
  lets where the result goes say them.
- Tasks spawned inside a transaction share it, their queries taking turns on it. Other tasks'
  queries wait for it to end: on goroutines the one connection makes them, and under the test
  scheduler they wait as a reported wait ("on sql (another task's transaction)"), so a deadlock
  is caught rather than hung. A transaction begun in a task spawned inside another panics: the
  savepoints of two tasks would interleave.
- A rollback that fails after `Err` is ignored: the `Err` is what happened. Savepoints are
  undone even when the task is cancelled.
- The todo service's `change` updates and reads back in one transaction.

Lowering: `transaction`'s body (`sqlBody`) calls `candor.SQL.Transaction(ctx, func() bool)`,
keeping `f`'s Result from the closure and committing when it is `ok`. The open transaction is on
the task's `Ctx` (`tx`), copied into scopes and spawned tasks; every query goes through
`SQL.use`, which picks it or the database. Savepoints are `candor_N` by depth. `mapErr` is an
inline Go function on the Result.

`test/sql.test.ts`, `runtime/go/sql.go`.

### What an AI trial found

Card 040 had a fresh agent write a bookings API (rooms, bookings, 409 on overlap inside a
transaction) from the README, this file, `std/` and `examples/` only, keeping a log. Pal's
calls: no guide written for it first, and a bookings API. It stays in the private archive.

It passed: 17 compiler runs, one real error, its first test run green, and a concurrency test
(four equal bookings at once, one wins) it checked by removing the transaction. A caveat: the
todo service was almost a template for it, so this measured the docs for one shape of program.
The std files read as documentation; `Result<Response, Response>` with `?`, narrowing,
`mapErr`, `${...}` as parameters and the assert diagrams all did what it guessed.

What it tripped on, costliest first:

1. **No reference for built-in methods.** Every method came from an example (`filter` from the
   open questions below); the README points at `src/methods.ts`. It tried nothing it hadn't
   seen. Card 041.
2. **A race test passes against broken code most of the time.** Without the transaction the
   test failed one run in three: one seed per run tries one task order. Card 042.
3. **`a ?? 0 > 0` had no help** (fixed here): it reads `a ?? (0 > 0)`, and CAN0005 said only
   "expected int, found bool". Now the help says `??` binds looser and writes the parentheses.
4. **`sql.transaction<Booking, http.Response>(...)`'s type arguments.** Known (open question
   below); the docs warned it. Card 043.
5. **No raw or multi-line strings.** `\"end\"` four times in queries (a SQL keyword as a
   column), a 150-character CREATE TABLE, test bodies walls of `\"`. Card 044: `"""`.

Also fixed here: the README's status is bullets instead of one sentence, and `http.serve`'s doc
names `127.0.0.1:8080` next to `:8080`. Noted: `tasks.all` has no "n times" form (it mapped
over `[1, 2, 3, 4]`, ignoring the item).

### The reference

Trial 040's first friction. Pal's calls: generated from one table rather than written beside
the code; the built-in types and effects (`std/` documents itself and is linked); and
`candor doc` prints it.

- **`src/reference.ts`** has a section per type or effect (`int`, `string`, `List<T>`, `T?`,
  `tasks`, `Mutex<T>`, ...): an intro, and per method a signature, one line and an example.
  Fake-only operations (`io.output()`, `clock.advance`) are marked; the names other languages
  use (`includes`, `size`) are listed, from the same maps the checker's help reads.
- **One source of names.** The checker's lists for List, Map, tasks, Scope and the handles are
  read from it, so a method can't exist without its entry. For `string`, `int`, `bool`,
  `GoError` and the effects, whose types live in `src/methods.ts` and `src/effects.ts`, the
  signature is printed from the real type and a test checks the names match.
- **Examples run.** Each is the body of a test block; `test/reference.test.ts` runs all of
  them. Only `GoError`'s have none (only a binding makes one).
- **`docs/reference.md`** is generated by `bun run reference`; a test fails when it's stale.
- **`candor doc`** lists the sections, `candor doc string` prints one, `candor doc split` prints
  every method of that name, and `candor doc size` says what Candor calls it.

Mine: hand-written signatures use types only, no parameter names (`split(string) ->
List<string>`), matching the ones printed from real types; the one line says what each is.

### Race tests try many orders

Trial 040's second friction: its race test, with the transaction removed, failed one run in
three, since each run tried one task order. Pal's calls: rerun by default, with a flag for the
count, and keep random seeds.

- A test whose seed decided something (a pick among several ready tasks, or select arms) runs
  again on the next seeds, `seed`, `seed+1`, ..., up to 100 orders, stopping at the first
  failure. One whose seed decided nothing would only repeat itself, so it runs once.
- `--runs N` changes the count; `--seed N` alone runs one order (the replay), and with `--runs`
  starts there.
- The report: `PASS name (100 runs)`; a failure's heading adds `, run 37 of 100` when earlier
  orders passed, and the summary prints, per failing test, `seed N: run with --seed N --only
  "name" for the same task order`. Seeds differ per test now, so the one summary seed line went.
- The trial's broken bookings fail 5 runs in 5 (within 10 orders); 100 orders of its passing
  race test add nothing measurable to the run.

Mine: a test that starts tasks but can't race (spawn, then join) still runs 100 times, as the
scheduler can't tell; it's cheap. Smarter schedulers were card 071.

### Type arguments from where a result goes

Every transaction wrote `sql.transaction<Booking, http.Response>(...)`: a lambda whose first
`return` is `Err(...)` says nothing of `T`, and card 013 ruled out where the result goes. Trial
040's fourth friction. Pal's calls: both sources, the arguments win, everywhere. This replaces
card 013's "an annotation doesn't count".

- A lambda without a known result waits: `return Ok(x)`, `Err(e)` and `none` each say part of
  it at most, and the first `return` that says it all (a value, or an `Ok` once an `Err` or a
  `?` said the error type) decides; the ones before are checked against it. At the end, what is
  still open comes from where the lambda's result goes, if anything says. (Card 050 replaced
  "the first that says it all" with all the returns together.)
- Type arguments come first from the arguments, every return of a lambda included; then the
  type expected where the result goes (a `return`, a typed `let`, a parameter, a field, the
  other side of `==`) fills in the rest. `[]`, `none`, `Ok(...)` and `Tree.Leaf` as arguments
  say nothing themselves, so they see that expected type.
- When the two disagree, the error is at the call: "`run(...)` gives Result<int, string>, but
  where it goes expects Result<string, string>", with help naming the source: "`T` is int,
  from the `return` on line 10" (or "from `xs` (line 6)", "from field `items`").
- Generic calls, generic struct literals, variants without fields
  (`let t: Tree<int> = Tree.Leaf`, `t == Tree.Leaf`) and `tasks.scope` all do it.
  `json.decode` learns its type the same way: `return json.decode(text)` in a function
  returning `Result<Todo, json.Error>`.
- With nothing on either side, the call still needs its type arguments written, and the help
  writes them.

Mine, mentioned at the time: a lambda that returns `none` and later `Ok(n)` still can't tell
the error type; the expected type takes `T?` for `T` (`let x: int? = id(none)` gives `T = int?`).

### Raw and multi-line strings: `"""`

Trial 040 wrote `\"end\"` in queries, a 150-character CREATE TABLE and test bodies made of
`\"`. Pal's calls: `"""`; raw, with `${...}` still interpolating; the closing `"""` sets the
margin.

```
sql.exec("""
  CREATE TABLE todos (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL
  )
  """)?
send("POST", "/todos", """{"title": "milk"}""")
```

- **`"""`**, as in Kotlin, Swift and Java, and not backticks: every `"..."` already
  interpolates (card 027), so backticks would be a second way to write it. The result is the
  same `string` or template as `"..."`, so a `"""` query's `${...}` are parameters.
- **Raw**: a backslash is text, so JSON's `\n` and a regex need no doubling. `${...}`
  interpolates; a literal `${` is `${"$"}{`, or the `"..."` form with `\$`. A run of quotes
  ends with its last three, so `"""say "hi""""` ends in a quote.
- **On one line** when text follows the opening `"""`; it ends on that line.
- **Several lines** when the opening `"""` ends its line. The text is the lines after it, up to a
  line holding only the closing `"""`. That line's indent is removed from every line, and the
  newline before it is dropped. A line that starts left of it is an error (CAN0001) whose help
  names the indent; blank lines are fine. The closing `"""` after text on the same line is an
  error too: one rule, not two. A `${` still closes on its own line.
- `examples/todos.candor` and the SQL fixture use them. The trial's files stay as written.

### A trial suite

Card 040's one trial found four cards' worth. Pal's calls: a harness and two apps, Candor only
for now; black-box acceptance tests; headless `claude -p` runs; the large app later.

- **An app is a spec and hidden tests.** `trials/apps/<app>/spec.md` is all the agent gets about
  the app; `acceptance.test.ts` starts the build and talks HTTP to it, so the same tests will
  check Go or TypeScript builds. A Candor reference passes each, and a mutated one fails, so the
  tests are checked too.
- **One prompt, one tool set, for every language.** `trials/run.ts`: a fresh temp directory,
  `claude -p` with Read, Write, Edit, Glob, Grep and Bash, none of the user's settings or MCP
  servers, a budget. Compiler runs are counted by a logging `candor.cmd`.
- **First runs** (sonnet, while the machine was busy compiling, so times are high):

  | App      | Accepted | Cost  | Turns | Compiler runs | Errors               |
  | -------- | -------- | ----- | ----- | ------------- | -------------------- |
  | bookings | 12/12    | $0.21 | 11    | 2             | none                 |
  | jobs     | 18/18    | $0.39 | 18    | 4             | 9× CAN0036, 1× CAN0016 |

- **What they found.** `m[k] = v` on a map: 9 of the jobs agent's 10 errors, and the reference
  hit it too; lists take `xs[i] = v` since card 022 (card 046). No shadowing of a function by a
  parameter (`req`, `attempt`): hit by both, the help fixed it, and it stays. Writing the
  reference: no `?.` (`b.jobs[id]?.state` reads as `?`, early return). Bookings copied
  `examples/todos.candor` and used `"""` from it the same day card 044 landed.
- **Agents' logs aren't the record.** The jobs log says `for _ in 0..n` worked; the code has no
  such loop. `transcript.jsonl` is what happened; `log.md` is what the agent thought.
- **Too easy.** Both passed first time. The next apps are written to need what no example shows
  (card 048).

### `m[k] = v`

```
counts[w] = (counts[w] ?? 0) + 1
s.jobs[id] = job
```

Trial 045's jobs agent wrote `m[k] = v` nine times and was told to use `set` nine times; the
reference, written by Claude, did the same. Lists have taken `xs[i] = v` since card 022, so the
rule was left over from when neither could. Pal's calls:

- **`m[k] = v` is the one way to write a key.** `m.set(k, v)` is now CAN0008 with the help
  `m[key] = value`, as `m.get(k)` points at `m[k]` (`put` too). The receiver of a misnamed
  `set` counts as changed, so a `let mut` isn't also told to drop its `mut`.
- **`m[k] op= v` is refused** (CAN0036): `m[k]` may be missing, so the code says what it starts
  at, `m[k] = (m[k] ?? 0) + 1`. Lists keep `xs[i] += v`, which panics out of range, as reading
  does.
- The value is a `V`, not a `V?`; key and value are checked like `set`'s arguments were, and
  evaluated key first. Through a struct field (`s.jobs[id] = j`) it needs a `let mut` root and
  copies the map first (`SetCopy`), as `s.items[i] = v` does. `m[a][b] = v` is refused like
  `xs[i][j] = v`.
- Lowering is `set`'s: `m.Set(k, v)` on a variable, `SetCopy` through a field.

Checked in `test/maps.test.ts`. `std/http.candor`, `examples/words.candor`,
`examples/workers.candor`, the aliasing fixture and the jobs reference moved over; the trial's
app, moved the same way (nine lines), passes 18/18. Recorded runs stay as written.

### Trials in Go, TypeScript and Python

Card 045's two apps, three sonnet runs each in Candor, Go, TypeScript (Bun) and Python. Pal's
calls: those three, with the stack each would reach for without installing much (Go: net/http,
database/sql, modernc.org/sqlite, as there is no C compiler here; TS: `Bun.serve`,
`bun:sqlite`; Python: the standard library); three runs each; the languages the model knows get
the spec and the stack, nothing else, so Candor's reading is part of its cost.

Medians (the machine was busy compiling throughout, so seconds are high for everyone):

| App      | Lang   | Accepted       | Cost  | Tokens | Output | Turns | Compiler runs | Wall | Lines |
| -------- | ------ | -------------- | ----- | ------ | ------ | ----- | ------------- | ---- | ----- |
| bookings | candor | 12, 12, 12/12  | $0.21 | 228k   | 9.9k   | 11    | 4             | 134s | 217   |
| bookings | go     | 12, 12, 12/12  | $0.22 | 133k   | 13.4k  | 10    | 4             | 83s  | 397   |
| bookings | ts     | 12, 12, 12/12  | $0.09 | 51k    | 4.8k   | 7     | 4             | 41s  | 149   |
| bookings | python | 11, 11, 11/12  | $0.11 | 55k    | 6.1k   | 7     | 1             | 44s  | 256   |
| jobs     | candor | 18, 18, 18/18  | $0.42 | 504k   | 19.7k  | 17    | 5             | 181s | 468   |
| jobs     | go     | 18, 18, 18/18  | $0.21 | 131k   | 12.7k  | 11    | 6             | 83s  | 403   |
| jobs     | ts     | 18, 18, 18/18  | $0.09 | 53k    | 4.7k   | 5     | 2             | 37s  | 175   |
| jobs     | python | 18, 18, 18/18  | $0.17 | 102k   | 10.4k  | 9     | 2             | 71s  | 324   |

Lines are every non-blank line written, tests included.

- **Everyone got it right.** Candor, Go and TS passed every test in every run. Python's bookings
  lost the 20-requests-at-once test all three times, though its locking is right: the standard
  library's `http.server` listens with a backlog of 5 and Windows refuses the rest (with the
  backlog raised, 12/12). Kept as a failure: the server turns clients away.
- **Candor costs what Go costs on bookings and twice Go on jobs; two to four times TS.** The
  extra is reading: Candor agents write their first line after 5 to 14 tool calls of README,
  examples, `std/` and greps in the docs (TS after 2), and the context they carry from it makes
  every later turn dearer (tokens are mostly cached reads). They also write more and fix more:
  2 to 4 times TS's output tokens. Go is long-winded and still never needed docs.
- **Candor programs are short next to Go's, long next to TS's.** Bookings is 217 lines to Go's
  397 and TS's 149. Jobs in Candor (468) is the longest of all: a store under a `Mutex` changed
  through `update` closures, where TS has one event loop and plain variables.
- **What Candor's errors were (the five new runs):** CAN0032 in three runs, all a `return` in an
  unannotated lambda passed to a generic function (`sql.transaction((tx) => ...)`,
  `m.updateWith((st) => ...)`): `return Ok(Err(problem(...)))` or `return (s, none)` has nothing
  to take its type from, though another `return` in the same lambda says it (card 050). Enum
  variants written bare (`Queued` for `State.Queued`), 14 errors in one run, all fixed by the
  help. A `test`-only `assert` in `main`, a type annotation on a lambda's result, CAN0046 on
  `sql.transaction`: once each.
- **One test was wrong.** `PUT /jobs/1` with no job 1 is "an id that names nothing" (404) as much
  as "a known path with the wrong method" (405); two TS runs and a Python one said 404. The test
  now creates the job first; `bun trials/run.ts rescore jobs` ran the tests again on every kept
  run. A run whose language changed since (045's Candor run uses `m.set`, card 046) keeps its
  score.
- **Every language loses a turn to the shell.** Agents write a whole file with `cat > f <<'EOF'`
  in Bash; on this machine that often fails ("unexpected EOF") and they write it again with
  Write. It costs Candor, Go and TS runs alike, so the prompt stays as it is.
- **What this says about Candor.** It gets programs right but pays to learn the language every
  run: a smaller, sharper entry point (one page that answers what the README and examples are
  read for) is the obvious lever, and the jobs runs say concurrency is where the reading goes.
  The apps are still too easy to tell languages apart on correctness (card 048).

### A lambda's result from all its returns

```
sql.transaction((tx) => {
  if taken { return Ok(Err(problem(409, "taken"))) }
  return Ok(Ok(Booking { ... }))          // Result<Result<Booking, Problem>, sql.Error>
})
m.updateWith((st) => {
  if st.closed { return (st, none) }
  return (st, job)                        // (Store, Job?)
})
```

Card 047: three of five Candor runs annotated lambdas like these after a CAN0032, because each
`return` was typed alone and the first complete one decided. Pal's calls: every return says
what it can and they are put together; `return x` and `return none` make a `T?`, as in
TypeScript.

- **Shapes.** While nothing has said a lambda's result, each `return` gives a shape: its type
  with holes where it says nothing. `none` is `_?`, `Ok(x)` is `Result<X, _>`, `Err(e)` is
  `Result<_, E>`, `[]` is `List<_>`, `[:]` is `Map<_, _>`, and a tuple is its items' shapes
  (always, so `(s, j)` and `(s, none)` meet item by item). Anything else is checked as it is and
  is a complete type.
- **Merging, at the end of the body.** A hole takes what the other side says; `T` and `_?` (or
  `T?`) make `T?`; results, lists, maps and tuples merge part by part. Then a `?` or a failing
  task's error type, then the place the result goes, fill what is left. Where two returns
  disagree, the first wins and the other is the error (`expected int, found string`).
- **What is still open** is CAN0032 with the shape, `_` for the unknown, and the annotation:
  "its returns say (int, _?)", help `(...): (int, T?) => ...`.
- **Each return is checked once.** What a return checked to give its shape is kept, and when the
  type is known those parts are coerced to it (`n` into an `int?`), the rest checked against it.
- Messages that name what decided the type ("`T` is int, from the `return` on line 10") name
  the last return that filled a hole.
- Only block bodies have several returns; an expression body still takes its type alone, or
  from where it goes.

Checked in `test/lambda-returns.test.ts` (a program with widened tuples, optionals and nested
Results runs). The first drafts of the trial runs that hit it, as the agents wrote them,
compile: bookings passes 12/12 and jobs 18/18 without an edit; the third has only its bare enum
variants left.

### One page to start from: `docs/start.md`

Card 047: Candor agents spent their extra cost reading README, `examples/todos.candor`, the std
modules, `examples/workers.candor` and slices of the reference and these notes before writing.
Pal's calls: one page, `docs/start.md`, written by hand with every code block checked, no
length cap; the README's top and the trial prompt point at it.

- **What's on it**, from what the transcripts looked for: the build loop; a whole service
  (routing, JSON in and out, error bodies, `PORT`, SQLite, a transaction, tests); the language
  on one screen; effects; HTTP, JSON and SQL in a paragraph each; shared state, workers and
  shutdown as a second whole program; the mistakes agents made most (`State.Queued`,
  `m[k] += 1`, a dropped Result, an empty literal), each shown with the error it gets.
- **Checked by `test/start.test.ts`.** A block starting with `module` is a whole program: no
  diagnostics, and its tests pass. Declarations are a module of their own (and run their tests
  if they have any), statements run as one test each, and ```` ```candor wrong CAN0002 ```` must
  give that code, so a mistake that stops being one fails the test. Both programs were also
  run by hand: the orders server stops on `POST /shutdown`.
- No exit: the page says so, and shows the server raced against a task that waits for the
  shutdown.

Trials, Candor, 3 runs per app (sonnet), against card 047's:

| App      | Median cost   | Median tokens | Calls before writing | Acceptance          |
| -------- | ------------- | ------------- | -------------------- | ------------------- |
| bookings | $0.21 → $0.12 | 228k → 96k    | 2 → 1                | 12/12 ×3, as before |
| jobs     | $0.42 → $0.37 | 504k → 385k   | 5 → 4                | 18/18, 14/18, 18/18 |

Bookings is about what the page shows, and costs as little as Python's ($0.11). Jobs reads
less but still writes and fixes most of its cost. The 14/18 run's retries never came back: it
sorted due jobs by `readyAt * 1_000_000_000 + id`, which overflows with real epoch milliseconds
and wraps silently (its own tests passed, on virtual time from 0). The page then said that
`int` wraps, what `clock.now()` is, and how to sort by two things (a struct with `impl Ord`:
tuples have no order, and there is no `sortBy`).

### Overflow traps; `wrapping*`; `sortedBy` and ordered tuples

```
let due = jobs.sortedBy((j) => (j.readyAt, j.id))   // by readyAt, then id
let h = h.wrappingMul(31).wrappingAdd(c)            // a hash: wrapping asked for
max + 1                                             // panic: integer overflow: ... at app.candor:12
```

Card 051's trial: a sort key `readyAt * 1_000_000_000 + id` wrapped silently, and retried jobs
never came back. Pal's calls:

- **Overflow traps.** `+`, `-`, `*` and `/` on `int` (and `+=` and kin, and `xs[i] op= v`)
  panic when the result doesn't fit, as `/` by zero does: `integer overflow: 9223372036854775807
  + 1 doesn't fit in an int`, with the Candor frames. Unary `-` too, except on a literal, so
  `-9_223_372_036_854_775_808` is still written. `%` can't overflow. Swift's choice; a wrong
  number that carries on is worse than a crash that names the line.
- **Wrapping is asked for by name:** `a.wrappingAdd(b)`, `wrappingSub`, `wrappingMul` (Rust's
  names), for hashes and checksums.
- **Tuples are ordered** when every item is: item by item, the first that differs decides. So
  `<`, `sorted()`, `<T: Ord>` and `sortedBy` take them.
- **`xs.sortedBy((x) => key)`**: a sorted copy by a key that is `Ord`, worked out once per item,
  stable. A comparator was left out: `(a, b) => a.at - b.at` is the subtraction that overflows.

Mine, mentioned at the time:

- The checks are runtime functions (`candor.Add` and kin), which Go inlines; the panic is kept out
  of line (`//go:noinline`), or `Add` goes over Go's inlining budget and a loop of additions runs
  3× slower. With it: a loop doing nothing but two additions and a `%` is 35% slower than
  wrapping (185 against 138 ms for 200M rounds); code that does anything else won't see it.
  `Mul` checks both operands fit in 32 bits first and divides only when not.
- Function calls rather than Go's operators for the wrapping methods too: on constants, Go
  refuses an overflowing expression at compile time.
- An Ord dictionary per tuple type in the emitted Go (`ordd__N`), as for equality.

`test/overflow.test.ts`, `runtime/go/ints_test.go`; reference entries for the methods. The trial
run that wrapped would now panic in the log at its sort key, instead of leaving jobs in
`retrying`.

### Open questions triaged

Pal went through the list. Decided, with a `todo` card each:

- Integers: `/` keeps panicking; `checkedAdd`/`Sub`/`Mul`/`Div` give an `int?`; constant
  overflow is a compile error (053).
- Patterns: narrowing after a diverging `none` arm; an arm may rebind its subject's name;
  `.Variant` in patterns when the type is known (054).
- Exit status: `main` returns `Result`, and an `Err` exits 1. No `env.exit` (055, done in 048).
- `all`/`any`; `lines`, `padStart`/`padEnd`; a `char` type; examples to interpolation (056).
- Traits: generic impls and derived `Show` (057); default bodies and methods with effects (058).
- JSON: renamed fields, omitted `none`, custom impls, strict decoding (059).
- Fakes may `use` other effects (060).
- http: a client (061); signals and repeated headers/query keys (062, done); streaming (063).
- SQL checked against the `migrate` schema (064).
- `candor test file:line` and a streaming `--json` (065).

Decided against or deferred:

- **No `x?.field`.** `?` is early return; a second meaning reads two ways. `match` and
  narrowing cover it.
- **Packages** (several files, versions, `pub(package)`) wait for card 049's large app to show
  whether one file per module hurts.

### Four harder trial apps; stdin, stderr, `main -> Result`

```
fn main() -> Result<void, string> uses io, env {
  let opts = parseOptions(env.args())?     // an Err: printed on stderr, status 1
  while true {
    let line = io.readLine()               // string?, none at the end of input
    if line == none {
      break
    }
    ...
  }
  io.eprintln("warning: ...")
  return Ok()
}
```

Card 048 added `gateway` (a sliding-window rate limiter, 50 concurrent checks on a key),
`logs` (a command: an access log on stdin, a report on stdout, usage errors on stderr with a
status), `pricing` (rules in order with half-up rounding, an order state machine) and `blobs`
(SHA-256 ids and base64, SQLite across a restart, at least three source files). Each has a
spec, black-box acceptance tests and a Candor reference that passes them. Pal's calls:

- **stdin first**, not left for the trial to find: `io.readLine() -> string?` (`none` at the
  end; `\n` or `\r\n` stripped) and `io.readAll()`, one buffered reader for the process. In
  tests the input is what `io.setInput` gave, empty until then. A blocking read isn't
  cancellable.
- **stderr and an exit status**, card 055 pulled in: `io.eprintln`/`eprint` (`io.errorOutput()`
  in tests); `main` may return `Result<void, E>`, and an `Err` is printed on stderr (a string as
  it is, anything else as tests show it) with status 1. `?` in a plain `main` says so in its
  help. Still no `exit`: cleanup in `main` runs.
- **`blobs` stays language-neutral** by asking for what Candor only gets through `extern`
  (SHA-256, base64: bytes don't cross a binding, so a little Go in `./native`).
- One Candor run each, sonnet.

| App     | Cost  | Tokens | Turns | Compiles | Lines | Acceptance |
| ------- | ----- | ------ | ----- | -------- | ----- | ---------- |
| logs    | $0.36 | 679k   | 23    | 8        | 294   | 10/12      |
| gateway | $0.23 | 226k   | 10    | 7        | 251   | 11/11      |
| pricing | $0.27 | 193k   | 9     | 7        | 344   | 12/12      |
| blobs   | $0.39 | 533k   | 20    | 6        | 368   | 11/11      |

- `logs` lost two tests to printing `top statuss:` where the spec writes `top statuses:`: a
  misread, not the language. It found `main -> Result`, `readLine` and `eprintln` in the docs.
- `blobs` found `extern "./native"` in design.md, wrote the Go, and split three modules, all
  first time; its compile errors (private fields across modules, `.upper()`) had helps that
  said the fix.
- What agents tripped on (logs): tuple items by position (`kv.1`); `List + List` (its error now
  says `concat`); a range as a value (`tasks.all(0..n, f)`); `fold` and `all` on lists; a lambda
  capturing a `let mut` (help gave the fix). Two wrote whole programs through a shell heredoc,
  which failed, and fell back to the Write tool.

Found by the references: `if c { none } else { x }` (and a `match` whose first arm is `none`)
didn't type, because `join` compared the first branch with itself and `none` isn't assignable
to `none`. Fixed.

Mine: `runCli(args, stdin)` in the harness and `contentType` on replies; the runner keeps
every source file by extension (not only `app.*`) and any folder the agent makes (`native/`),
and `run.ts recover` scores a run whose agent finished but whose scoring failed (the first
runs tripped on the `.candor` build folder matching `.candor` sources).

### `checked*`; constant errors with help

```candor
let average = total.checkedDiv(count) ?? 0   // none for a zero count
let x = 9_223_372_036_854_775_807 + 1        // CAN0017: ... it is 9223372036854775808
let y = 1 / 0                                // CAN0018: this divisor of `/` is always 0
```

Pal's calls (open questions triage): `/` keeps panicking on zero; code that expects the failure
asks for it by name.

- **`checkedAdd`, `checkedSub`, `checkedMul`, `checkedDiv` give an `int?`**: `none` on overflow,
  a zero divisor, or `min / -1`. No `checkedRem` (only a zero divisor can fail; test it). With
  `wrapping*` that makes three ways to do arithmetic, each named: trap (the operators), wrap,
  or `none`.
- **Constant folding was already there** (card 002: Go refuses constant overflow, so Candor had
  to first). It folds literals, unary `-`, `+ - * / %` and parentheses, never names, so
  `let n = max` then `n + 1` is a run-time trap. New: the help lines. Overflow points at
  `wrapping*` for a deliberate wrap; division by zero at `checkedDiv` (or testing `b != 0` for
  `%`). The message gives the folded value and the span covers the expression.
- `-7.checkedDiv(2)` negates the `int?`: a method call binds tighter than unary `-`, as in Rust.
  Write `(-7)`. The error (CAN0019, `-` on `int?`) is clear enough to leave as it is.

Checked in `test/checked-ints.test.ts`.

### Patterns: narrowing after `match`, rebinding the subject, `.Variant`

```candor
match t {
  none => return Err("no todo")
  _ => {}
}
use(t.title)                  // t: Todo here

return match t {
  none => Err("no todo"),
  t => Ok(t),                 // the arm's own t, a Todo
}

match e {
  .Status { code } => code >= 500,   // http.HttpError.Status
  .Failed => true,
}
```

Pal's calls (open questions triage):

- **A `match` narrows like an `if`.** On a `T?` local (or a path, `u.manager`), an arm proves
  the subject present when its pattern matches only present values (anything but `none` and
  `_`), or when a `none` arm above took absence. Below the `match`, what holds is what holds at
  the end of every arm that falls through, as for `if`. So `none => return` then `_ => {}`
  narrows, and `_ => t.title` after a `none` arm reads `t` as the `T` inside the arm too.
- **An arm may bind its subject's name** (`t => Ok(t)`), the one exception to no shadowing.
  Only the subject's own name, only in the arm's pattern, and only once (`(t, t)` is still
  CAN0016). The arm's `t` hides the subject, which can't change inside the arm, so after the
  `match` the subject is still known present for that arm.
- **`.Variant` in patterns** names a variant of the matched enum, so it needs one: on another
  type it's an error whose help gives the long form, and a wrong name lists every variant
  (not the nearest, as for full paths; the list is short and the type is known). It works on a
  `T?` (the pattern is about the present value) and nested (`Ok(.Paid { at })`). Patterns
  only, as decided: in an expression the type isn't always known.

`examples/pages.candor` and `docs/start.md` show it. Checked in `test/patterns.test.ts`.

### `char`; `t.0`; ranges as values; `all`, `any`, `fold`, `sum`; `lines`, `pad*`

```candor
let digits = s.chars().filter((c) => c.isDigit())   // List<char>
match c { 'a' => ..., '\n' => ..., _ => ... }
let width = rows.fold(0, (w, row) => if row.0.length() > w { row.0.length() } else { w })
let squares = tasks.all(0..n, (i) => i * i)          // 0..n is a List<int> here
"7".padStart(3, "0")                                 // "007"
```

Pal's calls: lists get `all` and `any`, strings `lines`, `padStart`, `padEnd`, and a `char`
type; then, from card 048's trials, `t.0`, `fold`/`sum` and ranges as values. On the choices:
`'a'` literals with `chars()` giving `List<char>`; `t.0`; a range is an eager `List<int>`.

- **`char` is one code point**, a Go `rune`. `'a'`, `'é'`, `'😀'`, and the string escapes plus
  `\'`. `''` and `'ab'` are errors whose help gives the double-quoted string. It is `Eq`, `Ord`
  (by code point), `Show` (interpolates as itself) and `Json` (a one-character string; decoding
  anything else is an error naming the field). Methods: `toString`, `code`, `isDigit` (ASCII
  0-9, what `toInt` reads), `isLetter`, `isWhitespace` (Unicode), `toUpperCase`, `toLowerCase`;
  `n.toChar()` on an int gives a `char?`. No arithmetic: `c + 1` is an error (`c.code() + 1`,
  then `toChar()`). `match` takes char literals, with a `_` arm to cover the rest.
- **`s.chars()` is `List<char>`**, breaking code that treated its items as strings. Two trial
  references did (`allowed.contains(c)` on a string); the mismatch now has help both ways
  (`c.toString()`; single quotes for a char), and `join` works on a `List<char>` too, so
  `s.chars().join("") == s` for valid UTF-8. An invalid byte becomes U+FFFD as a char.
- **`t.0`** reads a tuple item, as in Rust and Swift; `t.0 = v` writes one in a `let mut`. A
  missing item lists the ones there are. (`t.0.1` lexes as `0` `.` `1` now; card 069's float
  literals must keep it that way after a `.`, as Rust does.)
- **A range is a value**: `a..b` binds loosest (`0..n + 1` is `0..(n + 1)`), doesn't chain, and
  is a `List<int>` from `a` to `b - 1`, empty when `b <= a`. As a `for` loop's iterable it still
  counts without building the list. A `Range` type with laziness was the alternative; a list
  works with every list method and function as it is.
- **`fold(start, f)`** takes its type from `start`; `none` as a start is an error (annotate a
  `let`). `sum()` is on `List<int>` only and traps on overflow like `+`; its error points at
  `fold`. `all` and `any` stop early.
- **`lines()`** splits at `\n` and `\r\n`; a final line break doesn't add an empty line.
  **`padStart(n, fill)`/`padEnd`** count code points and cut the last copy of `fill` to fit, as
  JavaScript does.
- Small calls of mine: `padLeft`, `ljust` and the like point to `padStart`/`padEnd`; the
  runtime's `Show` prints an `int32` as a char (only a char is one), so assert diagrams show
  `'a'`, not 97.

`examples/text.candor` shows most of it; the examples moved from `+` to interpolation. Checked
in `test/lists-strings.test.ts`.

### An http client

```candor
let res = http.get("https://prices.example/items/tea").mapErr((e) => "${e}")?
let r = http.send(http.ClientRequest { ...http.request("PUT", url), body: text, timeoutMs: 5_000 })
http.respond("https://prices.example/items/tea", 200, body)   // in a test
http.answer(handle)                                             // or the app's own handler
```

Pal's calls: the client is in the same `http` effect as `serve` (one network capability); a
30 s timeout by default, settable per request; the fake answers from a table and from a
handler, and records what was sent.

- **Written in Candor**, in `std/http.candor`: `effect http` gets `send` over a small Go
  package next to it (`std/httpclient`, an opaque `*Reply` read through accessors, headers as
  flat name/value lists, since bindings pass ints, strings, bools and string lists). `get`,
  `post`, `postJson` and `request` are module functions over `send`. No compiler change: the
  binding features of cards 009-016 were enough, which says something good about them.
- **Any status is an `Ok`**, as in fetch, Go and reqwest: a 404 is an answer, and the caller
  checks `res.status`. `HttpError` is `.Failed { message }` (bad URL, refused, reset, a body
  over 16 MiB) or `.Timeout`; it has `impl Show`. A cancelled task cancels its request.
- **`ClientRequest`** has every field (`method`, `url`, `headers`, `body`, `timeoutMs`), as
  Candor structs do; `http.request(method, url)` fills the defaults and `...` changes some.
  `postJson` sets `content-type: application/json`.
- **Response headers** are lowercase, first value per name, as `serve` gives request headers.
- **The fake** (`fake http`, in Candor): `respond(url, status, body)` matches the URL exactly,
  query included, and comes first; then `answer(handle)`'s handler, which gets the request as a
  server would (path and decoded query split by the Go package's `URLParts`, header names
  lowercase); then a failure that says how to set one up. `sent()` lists every request. Named
  `answer`, not `route`: `http.route` is the router. The handler is a plain
  `fn(Request) -> Response` for now; one with effects waits for card 060 (fakes using effects).
  (Since card 060 it may use `clock`, and runs under the request's `timeoutMs`.)

Checked in `test/http-client.test.ts`: a program serves on 127.0.0.1 and calls itself (JSON
reply, a 404, a JSON POST, a timeout), then a refused connection; and test blocks on the fake.

### Optional fields may be left out; streamed http bodies

```candor
let p = Person { name: "a" }            // boss: Person? and nick: string? are none

return http.streamResponse(200, ["content-type": "text/csv"], (send) => {
  for row in rows { send("${row.id},${row.name}\n") }
})

http.serveWith(addr, http.ServeOptions { largeBodies: ["POST /blobs"] }, handle)
let size = http.readBody(req, 0, (n, piece) => n + piece.byteLength())?
```

Pal's calls: a handler streams a response with a writer function; large request bodies are
opt-in per route; `Response` carries the stream in a field, which needs optional fields to be
omissible (or every `Response { ... }` literal breaks); and `==` on responses keeps working.

- **A `T?` field may be left out of a struct literal** (or a variant's), and is `none`. Every
  other field must still be given. A private optional field may be left out from another
  module too, so a module can add one to a public struct without breaking its users. In Go
  it's the zero value; a boxed (recursive) one gets a pointer to `none`.
- **`http.streamResponse(status, headers, write)`**: `write` gets `send` and runs after the
  handler returns, in the request's task, each piece flushed as it is sent. A gone client
  cancels the task. A crash mid-body is printed and cuts the body short; the status is out.
  `write` usually has effects (`uses sql`) that a field's function type can't record, so
  `streamResponse` has a compiler-written body: its `uses write` makes the handler have them,
  and the Go closure carries them.
- **Large request bodies, opt in**: `serveWith(addr, ServeOptions { largeBodies: [...] },
  handle)` (patterns as for `http.route`; `serve` is `serveWith` with none). Those requests
  arrive with `body` "" and their body unread; **`http.readBody(req, start, f)`** folds over the
  pieces (32 KiB reads), giving `Result<A, string>`. A fold, not a callback, because a lambda
  can't change a `let mut` it captures: what a handler wants from the pieces (a size, a hash,
  rows written) is a value built up. On any other request it is one piece, the whole body.
- **The streams live in a runtime table**, and `Request`/`Response` hold a private `stream: int?`
  id. A function in the struct would have made both incomparable, breaking
  `assert send(...) == http.jsonResponse(...)`, which examples and agents write. Plain responses
  compare as before; two streamed ones never equal. `serve` takes a response's stream to send it
  and drops a request's when its handler returns; a streamed response a handler drops leaks its
  entry (rare, and small). User `impl Eq` was the other way; with map keys encoded structurally
  it needs more design.
- **For tests**: `http.bodyOf(res)` runs a streamed body into a string (a plain one is its
  `body`); `http.streamed(req, pieces)` makes a request a large-body route would get. The client
  fake's `answer(handle)` gives the client a streamed response's body whole.
- Mine: a lambda where a `(fn(...))?` is expected takes its parameter types from the `fn`.

Checked in `test/http-stream.test.ts`: test blocks for both directions; a built server whose
first piece arrives long before the last is written; a 3 MiB upload refused (413) on a plain
route and read in pieces on a large-body one.

### SQL checked against the schema; `queryOne`; `${none}`

```candor
sql.exec("UPDATE todos SET titel = ${t}")      // CAN0056: `todos` has no column `titel`
                                               //   its columns are id, title, done, as the
                                               //   migration at app.candor:49 makes them
let one = sql.queryOne<Todo>("SELECT id, title, done FROM todos WHERE id = ${id}")?   // Todo?
```

The vision's item 7. Pal's calls: queries on one table are checked, anything else is left
unchecked with a note; `queryOne` and `${none}` come in this card.

- **The schema is the program's own migrations**: the DDL in its `sql.exec` calls (`CREATE
  TABLE [IF NOT EXISTS]`, `ALTER TABLE ... ADD/RENAME/DROP COLUMN`, `RENAME TO`, `DROP TABLE`),
  in this module and the modules it imports, in that order. No DDL anywhere, no check: a program
  on someone else's database isn't refused. Types by SQLite's affinity rules (INT → int; CHAR,
  CLOB, TEXT → string; BOOL, Candor's own → bool; anything else unchecked); a column is nullable
  without NOT NULL or PRIMARY KEY; an INSERT must give the NOT NULL ones without a DEFAULT,
  but an INTEGER PRIMARY KEY numbers itself. int and bool go into each other's columns, as
  SQLite stores both as integers (`done INTEGER` read into `done: bool` is the usual case).
- **What is checked**, on SELECT, INSERT, UPDATE and DELETE of one table: the table and every
  column named (in the select list, WHERE, ORDER BY, SET, the INSERT's column list); each `${}`
  next to a column (`col = ${x}`, `col IN (${a}, ${b})`, a VALUES item, a SET) against its
  type, and, when stored, a `T?` or `${none}` into a NOT NULL column; the row type against the
  selected columns (a field with no column, a column with no field, a column twice, the type,
  and a nullable column into a field that isn't `T?`); `query<int>` selecting more than one
  column. These were runtime errors before (`no column "pinned" for Note`); the runtime checks
  stay, for the queries the compiler doesn't check.
- **What isn't**: joins, subqueries, compound queries, `t.col`, aliases and expressions in the
  select list (their columns are still checked, the row isn't). Each is a **note**, a new
  severity: `candor check` shows notes, `run`, `build` and `test` don't. An alias is also how a
  test keeps a deliberately wrong query out of the check (`test/sql.test.ts` does, to test the
  runtime's messages).
- Errors name the query (the span) and the migration (`file:line`). They point at the whole
  literal, not the word: mapping offsets inside raw and interpolated strings back to columns
  was more than the first version needed.
- **`sql.queryOne<T>(q) -> Result<T?, Error>`**: none for no row, the row for one, an `Err` for
  more (`expected at most one row, got 2`); for the first of many, `query` and `.first()`.
- **`${none}` is NULL**, as a none `T?` already was.
- Mine: `char` is no column type (it would be stored as a number), so it is out of `${}` and
  `impl Row` fields, which it had slipped into through `Json`'s list.

Checked in `test/sql-schema.test.ts`; examples/todos, notes and the trial references check
clean (three notes: an upsert with `excluded.id`, two `count(*)`).

### `candor test file:line`; `--json` streams

```
candor test app.candor:42           # the test whose block holds line 42
candor test app.candor --json       # {"type":"test","name":...,"status":"pass",...} per test
                                    # {"type":"summary","file":...,"passed":3,...} last
```

Pal's calls, from the tests open question: run a test by a line in it (what an editor or an
agent reading a failure has), and `--json` a line per test as it ends rather than one
document at the end, so a long run reports as it goes.

- **`file:line`**: the line may be anywhere in the test's block, its `test` line included. The
  CLI finds the test and passes the runtime `-test <name>`, an exact name (`--only` matches a
  part, so `"add"` would also run `"add twice"`). A line in no test is an error listing each
  test as `file:line  "name"`, so the next try can copy one. Only `test` takes `file:line`; a
  path like `C:\x.candor` isn't one, as the line is digits after the last colon.
- **`--json` lines**: `{"type": "test", ...}` with the fields a test had in the old report
  (`name`, `status`, `seeded`, `runs`, `seed`, `failure`), printed as each test ends, then
  `{"type": "summary", file, seed, passed, failed, filtered}`. Compact, one object per line. A
  file without tests prints the summary alone. Nothing outside `test/` read the old form.

Checked in `test/testing.test.ts`.

### `time`: dates on epoch-ms ints

```
import "time"

let due = time.addMonths(clock.now(), 1)
io.println(time.format(due))                   // 2026-11-25T10:00:00.000Z
let t = time.parse(req.query["since"] ?? "")?  // Result<int, string>
if time.parts(t).weekday == 7 { ... }
```

Pal's calls: a time stays the `int` `clock.now()` gives, and `time` is a standard module of
pure functions on it, not an `Instant` type; UTC only.

- **Why ints**: no new type to convert at every edge (`clock`, SQL columns, JSON), and the
  functions need no effect, so tests call them with fixed times. The cost: an `int` doesn't
  say it's a time; a name like `dueAt` does.
- **In**: `format` (RFC 3339, milliseconds, `Z`), `formatDate`, `parse` (RFC 3339 with any
  fraction and an offset, or a date alone; the `Err` names the bad part, "month out of range",
  or shows the forms it takes), `parts` (a `Parts` struct: year to millisecond, ISO weekday,
  yearDay), `utc(y, m, d, h, mi, s)` (an `Err` for Feb 30), `addDays`, `addMonths` (clamped
  to the month's end), `addYears`, `startOfDay`, `daysBetween` (midnights crossed), and
  `seconds`/`minutes`/`hours`/`days(n)` durations.
- **JSON**: a time is a number; a type that wants a string stores `time.format(t)`. No `Date`
  type: `formatDate` and `startOfDay` cover it.
- **Docs**: in `std/time.candor` and `docs/start.md`, like `json`, `http` and `sql`; the
  reference is for built-in types and effects.
- The Go is `std/timego` (pure `extern` functions over Go's `time`).

Checked in `test/time.test.ts`.

### The `random` effect

```
fn newSession() -> Session uses random, clock {
  return Session { id: random.uuid(), token: random.token(32), at: clock.now() }
}
let die = random.int(1, 6)              // both ends included
let order = random.shuffle(players)     // a new list
let first = random.pick(players)        // T?, none from an empty list
```

Pal's calls: always the secure source, no fast PRNG beside it; UUIDs are v7; `shuffle` and
`pick` are in; in a test the values come from a fixed seed.

- **Built in**, beside `clock`: an effect, so a function that draws says so and a test gets
  the fake. Real: Go's `crypto/rand` behind `math/rand/v2` (for unbiased ranges and the
  shuffle), so a token is a secret and nobody picks the wrong call.
- **UUID v7**: 48 bits of milliseconds, then random bits, so ids sort by creation and index
  well as keys. In a test the time is the virtual clock's.
- **`token(n)`**: n bytes as hex. **`int(low, high)`** panics when low is above high.
- **Tests**: each test's fake starts from seed 0, the same values in every run, whatever the
  scheduler's seed, so a test can assert exact values; `random.seed(n)` (fake only) starts
  another sequence. Tying values to the scheduler's seed (property tests for free) was the
  other option; it would make exact values flaky.
- **`shuffle`/`pick` are generic**, which effect operations can't be (they are a Go interface's
  methods), so the checker types them itself, like `tasks`'s, and the emitter calls generic Go
  helpers (`candor.Shuffle`, `candor.Pick`). The reference shows them with written signatures.

Checked in `test/random.test.ts`.

### `fs`: files as text

```
import "fs"

fn save(dir: string, name: string, text: string) -> Result<void, fs.FsError> uses fs {
  fs.makeDir(dir)?
  return fs.write("${dir}/${name}", text)
}
let errors = fs.readLines("app.log", 0, (n, line) => if line.contains("ERROR") { n + 1 } else { n })?
```

Pal's calls: paths go anywhere (`uses fs` is the capability; no root sandbox); text only, whole
files plus `readLines` as a fold for large ones; no bytes type yet.

- **A standard module with an effect**, like `sql`: `effect fs {}` is the permission, the
  functions get their bodies from the compiler (`fsBody`), and the runtime's `candor.FS` does
  the work: the disk for `main`, memory in a test. The generic `readLines` couldn't be an
  effect operation (a Go interface method), and a fake written in Candor couldn't stream.
- **Functions**: `read`, `write` (makes the file, not its directory), `append`, `exists`,
  `remove` (a file or an empty directory), `list` (names, sorted), `makeDir` (with parents;
  one already there is fine), `readLines(path, start, each)`.
- **`FsError`**: `NotFound { path }`, `Denied { path }`, `Failed { path, message }` with the
  operating system's words; `impl Show`.
- **The fake** is a file system in memory, fresh per test, with `.` and `/` as its only
  directories. A test fills it with `fs.write` and looks with `fs.read`, as the code does, so
  it needs no fake-only methods. It refuses what the disk refuses (a file in a missing
  directory, a directory read as a file, removing one that isn't empty); its messages are
  Go's on Unix ("directory not empty"), where Windows words them its own way.
- Docs in `std/fs.candor` and `docs/start.md`, like the other standard modules.

Checked in `test/fs.test.ts`; `test/fixtures/fs-notes.candor` runs on disk and in a test.

### `float`

```
let percent = done.toFloat() / total.toFloat() * 100.0
io.println("${percent.toFixed(1)}%")      // 66.7%
let mean = times.sum() / times.length().toFloat()
let whole = mean.round()                  // an int
```

Pal's calls: no NaN or infinity, so an operation that would make one panics; the API as the
card proposed it.

- **Never NaN or infinite**: `/` by zero, an overflow (`1e308 * 10.0`) and `sqrt` of a negative
  panic with the line, like int overflow. So `float` is honestly `Eq` and `Ord`: `==`, `<`,
  `sorted()`, map keys (-0.0 and 0.0 are one key). Every `+ - * /` on floats is a runtime
  call (`candor.FAdd`...): it checks the result, and keeps Go from folding constants exactly
  (`0.1 + 0.2 != 0.3` holds, as on any float). Literals are emitted `float64(...)`.
- **Literals**: `1.5`, `2.0e-3`, `1e21`, with `_` between digits. Not after a `.`, so
  `pair.0.1` is two tuple items. A literal past 1.8e308 is CAN0017. No float patterns in
  `match` (a computed float rarely equals one): the parser says to compare in an `if`.
- **No mixing**: `int` and `float` never meet in an operator; the help names the conversion
  (`n.toFloat()`, or `2.0` for a literal `2`). `%` is for ints. `+=` and the rest work.
- **Methods**: `toString` (shortest round-trip, `.0` on a whole number, an exponent below 1e-6
  and from 1e21), `toFixed(n)`, `round` (halves away from zero) / `floor` / `ceil` /
  `truncate` giving `int` and panicking out of its range, `abs`, `sqrt`; `int.toFloat()`,
  `string.toFloat() -> float?` (decimal only: no `NaN`, `Inf`, hex); `sum()` on a
  `List<float>`. Mine: `abs` and `sqrt`, for means and deviations.
- **JSON**: a number; a whole one encodes without `.0` (`2`), and an int in the JSON decodes
  into a float field. An `int` field still refuses `1.5`.
- **SQL**: `REAL`, `FLOAT` and `DOUBLE` columns are `float` in the schema check; a REAL column
  takes an int, and an INTEGER column reads into a float. `queryOne<float>("SELECT avg(...)")`.
- Not yet: floats in Go bindings (`float64` parameters), `pow`, `min`/`max`.

Checked in `test/floats.test.ts`; the reference has a `float` section.

### Server-sent events, and reading a response as it comes

```
return http.events([:], (send) => {
  for n in 1..4 {
    send(http.Event { data: "tick ${n}", id: "${n}" })
  }
})
let seen = http.listen("http://127.0.0.1:8080/ticks", 0, (n, event) => n + 1)?
```

Pal's calls: the server on 063's streamed body, and a client too.

- **Server**: `http.events(headers, write)` is a `streamResponse` with `content-type:
  text/event-stream` and `cache-control: no-cache`, written in Candor; `send` takes an `Event
  { data, event?, id? }` (data over several lines becomes several `data:` lines). The runtime
  writes `: keep-alive` every 15 s on a quiet event stream, under the same lock as the events,
  so proxies don't close it. A client that goes away cancels the handler's task (063's rule).
  `Last-Event-ID` is the handler's to read, `req.headers["last-event-id"]`.
- **Tests of a handler**: `http.eventsOf(res)` parses `bodyOf(res)` back into events.
- **Client, low level**: an `http.openStream(req)` operation gives the `Response` as soon as it
  starts, its body unread: the Go client puts the body in the runtime's stream table (063's),
  and `Response.stream` holds the id, as a server's streamed response does. `timeoutMs` bounds
  the wait for the start, not the body. `http.readResponse(res, start, each)` folds over the
  pieces; on a break its `Err` is `BodyBroken<A> { sofar, message }`, so what was read isn't
  lost. On a response read whole there is one piece. The fake's `openStream` gives a handler's
  response unread (a streamed one stays streamed) or a canned one.
- **Client, events**: `http.listen(url, start, each)`, written in Candor over the two: a fold
  over events that ends with the stream. A break resumes with `last-event-id` (when an event
  had an id), at most three times, then `Err`. A status other than 200 is an `Err`. No
  `retry:` delay: resuming is immediate. To stop early, end the task (`tasks.timeout`).
- Mine: `openStream`/`readResponse` are public, since they read any long body (a download, an
  NDJSON feed), not only events.
- Found on the way: `http.answer(handle)` takes `fn(Request) -> Response` with no effects, so a
  handler that sleeps between events can't be the fake's; see the open questions.

Checked in `test/sse.test.ts`: a real server and client on 127.0.0.1 (resuming after a crash cut
a stream), the fake, and a fetch that aborts and stops the handler.

### Task orders: PCT beside uniform

Pal's calls: half the runs PCT, half uniform; keep 100 runs (`--runs` sets it); no exhaustive
mode now.

- **PCT** (Burckhardt et al. 2010): each task gets a random priority; the scheduler always runs
  the ready task of highest priority; at d-1 change points (steps picked by the seed) the task
  about to run drops below every other, the i-th to priority d-i. A run finds a given bug of
  depth d (one needing d-1 particular preemptions) with odds of at least 1/(n k^(d-1)), n tasks
  and k steps. Uniform choice can need luck exponential in the steps a task must wait.
- **Which runs**: the seed decides: seeds 1 and 3 mod 4 are PCT at depth 2 and 3, the others
  uniform. Each PCT run follows the uniform run of its seed, which counts the steps (turns
  handed out) to place the change points in; so `--seed N` replays either kind alone. A test
  whose order never mattered still stops after one run.
- **k is steps, not choices**: counting only turns with several tasks ready came out at 2 or 3
  (a uniform run lets the short task finish early), and the change points never reached the
  step that mattered. Found by the test below missing now and then.
- **Measured**, `test/fixtures/late-reader.candor` (a reader that fails only between a writer's
  20th step and its last): uniform orders alone missed it in 3 × 3,000 runs; with PCT the first
  failure came in 20 to 170 runs. `test/pct.test.ts` runs it with `--runs 1000` and replays the
  seed it prints.
- Priorities are drawn only in PCT runs, so a uniform seed orders tasks as before.

### `candor debug`: Delve by Candor line

Pal's calls: verify Delve, add `candor debug`, keep names a debugger can map back; the VS Code
debug adapter waits for the extension. Delve 1.27.2 is installed here (`go install`).

- **It worked as it was**: card 020's `//line` directives (absolute `.candor` paths) reach the
  DWARF, so `break app.candor:11` stops on the Candor line, `bt` lists Candor lines (then
  `main.go`'s `main` and Go's runtime), `list` shows the Candor source.
- **Names**: locals and parameters are emitted with their Candor names, fields too, so `print
  sum` and `locals` read as written. Functions and types carry the module prefix
  (`main.app__total`, `main.app__Item`): unique across modules, and the rule is one line to
  learn, so no renaming table. The hidden `ctx__` shows among the arguments.
- **`candor debug file.candor [-- args]`**: builds with `-gcflags=all=-N -l` (no optimizing or
  inlining, so every line and local is there) and runs `dlv exec`. dlv is found on the PATH or
  in `$(go env GOPATH)/bin`; missing, the error gives the install command. `--init file` passes
  Delve commands (with `--allow-non-terminal-interactive`, for scripts and tests).
- Not yet: tests under the debugger (`candor debug` runs `main`), the VS Code adapter.

Checked in `test/debug.test.ts` (skipped without dlv): a breakpoint at `app.candor:11`, the
second hit's locals, and the stack's Candor lines.

### WebSockets: `http.upgrade`

```
return http.upgrade(req, (ws) => {
  while true {
    match ws.receive() {
      none => return,
      text => ws.send("echo: ${text}"),
    }
  }
})
```

Pal's calls: `http.upgrade` with `send` and `receive`, on github.com/coder/websocket, text
frames only, server only.

- **`WebSocket`** is a struct of three functions, `send(text) -> bool` (false once closed),
  `receive() -> string?` (none once closed), `close()`: so `ws.send(...)` reads as a method,
  and the value is the capability, given only to `upgrade`'s function. It has no `==`.
- **`upgrade(req, talk)`** gives a 101 Response holding `talk` in the runtime's table (063's
  ids), as `streamResponse` holds `write`; `serve` takes it, accepts the connection and runs
  `talk` in the request's task, with the handler's effects. The connection closes when `talk`
  returns or crashes; stopping the server cancels the task. `Serve` now counts its requests
  and waits for them, since `Shutdown` lets go of a hijacked connection. A request that isn't
  an upgrade gets the library's 426.
- **The dependency stays out of the runtime**: `std/wsgo` (a Go package next to http.candor)
  imports coder/websocket and, when loaded, sets `candor.AcceptSocket`. http.candor binds one
  function of it, so every program importing `http` loads it, and lists the module in an empty
  `extern` inside `effect http` (CAN0042 asks for side-effect imports there), which puts it in
  go.mod. Binary messages are skipped; 1 MiB is the largest message.
- **The fake**: `http.socketOf(s, res)` runs `talk` in a task of `s` with one end of a
  connection in memory (two runtime Channels) and gives the test the other end, so the test
  plays the client under the task scheduler. The scheduler found a race in its first version:
  a send could pass the open check, hand over the turn, and meet a closed channel; such a send
  now gives false, as on a real connection.
- Not yet: a client (`http.connect`), binary frames (no bytes type), ping/pong settings.

Checked in `test/websocket.test.ts` with `test/fixtures/ws-chat.candor` (echo and a chat room):
the fake under 100 orders, real Bun clients (echo, two in a chat, one leaving, the server stopping
closes the last), and a plain GET answered 426.

### `defer`

```
fn subscribe(topics: Mutex<Topics>, id: int, ch: Channel<string>) uses io {
  topics.update((t) => added(t, id, ch))
  defer {
    topics.update((t) => removed(t, id))
  }
  for line in ch {
    io.println(line)
  }
}
```

Found by card 049: a subscriber that registers itself in shared state had no way to leave it
when its task was cancelled, since cancellation unwinds by panicking. Pal's call: a
`defer { ... }` statement that runs on return, on `?`, on a panic and on a cancel, last one
first; it may use effects and is shielded from the cancel; it can't `return`.

- **At the top level of a body only** (a function, a block lambda, a test, an effect
  operation). In an `if` or a loop, `defer` would have to mean either the end of the block or
  the end of the function, and nothing in the syntax would say which. At the top level they
  are the same.
- **The body reads variables as they are when it runs**: it's a block, not a closure. It can't
  assign the function's locals (CAN0058), since the change would be lost. It can write effect
  state, which outlives the operation: the operation's write-back (a Go `defer` of its own,
  registered first) runs after it. What a test proved of a `let mut` optional doesn't reach the
  body, since the variable may change before it runs; proofs about `let` values do.
- **No `return`, no `?`, no `defer` inside** (CAN0058, with help); a lambda inside is its own
  function and may do all three.
- **Emitted** as Go's `defer candor.Deferred(ctx__, func(ctx__ *candor.Ctx) { ... })`. Go
  runs it on return and while a panic unwinds, a cancel's `cancelled{}` too. `Deferred` gives
  the body a copy of the context with a fresh token, so its effect operations and loops don't
  stop at once. A panic in the body replaces the one unwinding, as in Go. A body that blocks
  forever holds up its task's scope; that is the program's to avoid.
- Under the test scheduler a cancel still lands only at effect operations, and virtual time
  moves only when every task waits: a pure busy loop never sees `tasks.timeout` fire there.
  Noted, not changed.

Checked in `test/defer.test.ts` with `test/fixtures/defer.candor`: order on return and `?`, a
cancelled task's cleanup updating a Mutex (in both runtimes), an effect operation's `defer`
writing state, and a panic.

### `http.Request.remote`

Found by card 049: ntfy limits each visitor by IP. Pal's call: `remote: string?` on
`http.Request`, the peer's IP without the port, always set by `serve`, none in tests unless
set. Optional so that the request literals tests write don't need it (an optional field may be
left out). IPv6 comes without brackets (`::1`). No `X-Forwarded-For` handling: which proxies to
trust is the app's to say, and it can read the header. Checked in `test/http.test.ts` (a real
request from 127.0.0.1; a literal's is none).

### JSON leaves out `none` fields

Found by card 049: ntfy's API leaves absent fields out (Go's `omitempty`), and its clients and
tests compare key sets. Pal's call: `json.encode` leaves out a struct field, or an enum
variant's field, that is `none`, with no annotation to ask for it. Decoding already gave `none`
for a missing field or `null`, so a round trip holds.

- Only fields: a `none` in a `List<T?>` or a `Map<string, T?>`, or at the top level, is still
  `null`, since there is no key to drop.
- Generated: `o.Key("\"name\":")` writes the comma unless the object has just opened, and an
  optional field is wrapped in `if v.f.some { ... }`.
- Not done: other zero values (`""`, `0`, `[]`) are written, unlike Go's `omitempty`. A
  required field is always there.

Checked in `test/json.test.ts` (a struct, a variant, a recursive type) and the JSON example
in `docs/start.md`.

### Language follow-ups from the ntfy port

Pal's calls on what card 049's port ran into, before its change requests run:

- **`.Variant` in expressions** wherever an enum type is expected (a return, an argument, an
  annotated `let`, a field, an assignment, an `==` operand), through `T?`, `Result` and
  `List`. With no expected type it's an error whose help gives the long form. This reverses
  card 054's "patterns only": the port wrote `Err(.Forbidden)` about 70 times (card 078).
- **No `?.`**, still: `T?` gets `.map(f)`, so `m.attachment.map((a) => a.size) ?? 0` (card 080).
- **Module constants**: `const name = ...`, may be `pub`, compile-time scalars only (int,
  float, string, bool, char, folded arithmetic), lowered to Go consts. No other module-level
  values (card 079).
- **No shadowing stays**, module function names included.
- Small ones, Claude's call: or-patterns with the same names bound in each alternative,
  `Result.map`, `List.slice` (clamping, like the string one), `(_) =>` (card 080).

### SQL check: one subquery is a subquery

Card 077, a bug from card 049: the check called a statement with two SELECTs a subquery, so
`DELETE ... WHERE token NOT IN (SELECT token ...)` was read as columns named `SELECT`, `FROM`
and the table. Now any SELECT after the first word makes it a subquery (the unchecked note);
`INSERT ... SELECT` keeps its own note. Checked in `test/sql-schema.test.ts`; the port's token
pruning is one DELETE again, as in Go.

### `.Variant` in expressions

Card 078, Pal's call above. `.Paid` and `.Paid { at }` are a struct literal marked `short`,
whose variant comes from the type expected where it goes: the same hint `checkAgainst` already
gives `Ok(...)`, `none` and `[]`. So it works wherever those do: a return, an argument (a
generic function's too, checked after the arguments that say what `T` is), a field, an
annotated `let`, an assignment, a list item, `Ok`/`Err`, a lambda's return, either side of
`==`/`!=`, the right of `??`. A `T?` passes its `T` through; a generic enum takes the expected
type's arguments (`let t: Tree<int> = .Node { value: 7 }`).

- No enum expected is CAN0032 ("cannot tell which enum"), as for an unannotated `Ok(...)`. The
  help writes the long form for every enum the module can name with such a variant
  (`geo.Shape.Circle { ... }`); a non-enum expected is a type mismatch with the same help.
- `.name` in lowercase can't start an expression: the help says a method call goes on its
  object's line. Leading-dot chains stay out (until card 135).
- Emitted like the long form; nothing new in the emitter.
- The port: 127 long forms became short, patterns and values. Two places had nothing expected and got a type: an
  `if` chain bound by `let`, and `tasks.select`'s result (`let wake: Wake = ...`), whose arm
  lambdas then return `.Tick`. Acceptance 49/49.

### Module constants

Card 079, Pal's call above. `const name = value`, optionally `pub` and annotated, at module
level only; read as `name`, or `mod.name` from another module.

- The value is literals (int, float, string, bool, char), other consts (own or imported `pub`),
  and unary and binary operators on them, `??` aside: arithmetic, `+` on strings, comparisons,
  `&&`/`||`. (Lists, maps, records and function names since card #8a5f2239, below.) A call, a list, an interpolated string or a variable is CAN0059, whose help says to
  write a function. A const whose value names itself, directly or through others, is CAN0060.
- The checker types the value as any expression, then folds it to a literal (a bigint for ints,
  so overflow gets the usual message). Consts are checked before functions, each one
  checking those it names first, so order doesn't matter.
- Emitted as a typed Go const with the folded literal: `const m__backlog int64 = 1000`. Uses
  are the Go name. An int const's value joins the checker's folding, because Go folds consts
  too: `n / zero` with `const zero = 0`, and `max + 1`, are errors here, not Go's.
- Lives in the same table as extern `let`s, so name clashes, privacy and `mod.name` work as for
  them. A local named like a const: "is already a const".
- `const` inside a function: "goes at module level", help `let`.
- The port: `hub.backlog`, `tokenLife`, the random-string alphabet and the docs URL became
  consts. Acceptance 49/49.

### Or-patterns, `T?.map`, `Result.map`, `List.slice`, `(_) =>`

Card 080, the rest of the port's gaps (Pal's call on `?.`, Claude's on the others).

- **Or-patterns** `"rw" | "read-write" => ...` at the top of a `match` arm only, which is where
  the port wanted them; not nested inside `Ok(...)` or a variant's fields, and not in `let`. Each
  pattern is checked apart and must bind the same names with the same types (CAN0061 for the
  names, a mismatch for the types); the arm's scope gets the first pattern's bindings, the
  others are twins for the unused warning. Coverage counts each pattern as a row, so one already
  covered warns ("the patterns before it cover it"). Lowered to one Go branch with `||` when no
  pattern binds a name, otherwise one branch per pattern with the arm's body repeated, as each
  binds from its own place. `|` is a new token; a line ending in it continues.
- **`x.map(f)` on a `T?`**: `f` of the value, or `none`. An `f` that gives a `U?` gives it as it
  is (no `U??`), so it reads like the `?.` it replaces: `m.attachment.map((a) => a.url) ?? ""`.
- **`r.map(f)`** beside `mapErr`; refused on a `Result<void, E>`, which holds nothing. Both, and
  the option's, share one table (`wrapMaps`) and one lowering, an inline Go func.
- **`xs.slice(start, end)`**: a copy (the receiver's array is never handed on), with the string
  one's rules: the end is clamped, a negative index panics.
- **`(_) => ...`**: `_` as a lambda parameter binds nothing; reading `_` says it can't be read.
- The port: `parsePerm` is a `match` with or-patterns, the counter history uses `slice`, the
  WebSocket's `gone.onRecv((_) => ...)`, one attachment name via `map`. No place wrote a
  `Result.map` by hand; `let x = f()?` then `Ok(g(x))` was the shape. Acceptance 49/49.

### Agents changing a large app: ntfy in Go and in Candor

Card 049's step 4. Four change requests against the trimmed Go ntfy (9791 lines) and the
Candor port (about 3400 with its tests), one sonnet run each per side, through `trials/ntfy/run.ts`. Each is scored
by its own hidden tests and the 49 shared acceptance tests (the agent has the shared ones).

| Request      | Lang   | Hidden | Base  | Cost  | Tokens | Turns | Builds | Work | Code     | Tests |
| ------------ | ------ | ------ | ----- | ----- | ------ | ----- | ------ | ---- | -------- | ----- |
| expires      | candor | 6/6    | 49/49 | $0.18 | 314k   | 11    | 3      | 79s  | +41/-2   | +22   |
| expires      | go     | 6/6    | 49/49 | $0.12 | 172k   | 11    | 5      | 135s | +33/-0   | +23   |
| acl-bug      | candor | 3/4    | 49/49 | $0.16 | 266k   | 13    | 3      | 185s | +1/-1    | +27   |
| acl-bug      | go     | 4/4    | 49/49 | $0.07 | 98k    | 8     | 6      | 99s  | +1/-1    | +31   |
| user-limits  | candor | 5/5    | 49/49 | $0.19 | 349k   | 12    | 3      | 62s  | +17/-16  | +10   |
| user-limits  | go     | 5/5    | 49/49 | $0.19 | 308k   | 14    | 10     | 208s | +28/-10  | +37   |
| topic-limits | candor | 6/6    | 49/49 | $0.32 | 533k   | 13    | 7      | 99s  | +114/-1  | +40   |
| topic-limits | go     | 6/6    | 49/49 | $0.27 | 557k   | 19    | 15     | 225s | +58/-13  | +32   |

Work is the agent's own time (the Candor acl-bug run's wall time was 746s: a `python3 ||
python` heredoc hung on stdin until the tool's timeout, then it redid the edit by hand). Builds
are compiler, test and acceptance runs. Candor's tests are `test` blocks in its modules, counted
as tests.

- **One run each: no winner can be called from this.** Pal's call (one run per request per
  side); the numbers say where to look, not which language is better.
- **Both get large-code changes right.** 23 of 24 hidden tests, no regressions anywhere. The one
  miss is a judgment call (below).
- **Candor finished sooner with fewer builds; the cost came out even.** Candor's agents read
  more up front (docs, std and examples come with the copy), so tokens are higher on the small
  requests; Go's agents ran `go test ./...` over ntfy's ~440 kept unit tests each time, so their
  turns are slower and broke old tests they then had to fix (user-limits: three tests asserted
  the shared-IP behaviour).
- **The asymmetries in the requests showed, but not as expected.** user-limits was eight lines
  in my Go reference and looked like a refactor in Candor; the Candor agent added a `vk` field
  beside `ip` on `Call` and swapped it in at the visitor map's ten uses (+17/-16). topic-limits
  needed a registry Candor never had (+114 against Go's +58, which only added the limits to an
  existing map); the compiler caught two errors with fixes that worked, and a runtime panic (a
  Mutex `update` that used another Mutex) said what was wrong.
- **acl-bug, 3/4 for Candor (Pal: keep it).** The bug report says "the most specific entry
  wins"; the Candor agent made an exact grant beat every wildcard. Upstream's rule is the
  longest pattern, so `news*` beats `news`, and the hidden test checks it. Both sides state the
  rule in the code: Go's SQL `ORDER BY ... LENGTH(a.topic) DESC` (its agent restored `DESC`),
  and in Candor a comment, "longest pattern first", on `resetAccess`, which its agent didn't
  read. Go also has a disabled cache implementing the same order.
- **The Mutex rule shaped a race.** `update`'s function can't use another Mutex (so Mutexes
  can't deadlock, `shared.go`), so the topic-limits agent read the registry with `get`, charged
  the visitor, then wrote with `update`: two requests at once can both pass the total check.
  Go's version holds `s.mu` across the check and the add. A new open question.
- **Shell flakes are noise, not language.** The hung heredoc cost one run nine minutes of wall
  time; `run.ts` now reports work time beside it, and adds up a run's results when a background
  task wakes the agent after its answer (that run had two).

### `slice` clamps a negative index

Card 081, Pal's call on card 080's open question: a negative index clamps to 0, as the end
already clamps to the length, for strings and lists. `slice` never panics on its bounds, and
"the last ten" is `xs.slice(n - 10, n)`. A wrong computed index now gives a shorter result
instead of a panic; the port's one use wanted exactly the clamp.

### Check then act across Mutexes: one Mutex

Pal's call on the open question from card 049's topic-limits run: no new API. State that is
checked and changed together lives in one Mutex, and the check goes inside `updateWith`. The
docs and the panic message for a Mutex used inside `update` say so (card 082): the start page's
shared-state section, the Mutex reference intro, and the panic's last sentence.

### Generic impls; derived `Show`

```
struct Point {
  x: int
  name: string
}
impl Show for Point                       // derived: Point { x: 1, name: "ann" }

struct Page<T> {
  items: List<T>
  next: string?
}
impl<T: Json> Json for Page<T>
impl<T: Show> Show for Page<T>

"${[1, 2]} ${maybe} ${r}"                 // [1, 2] 3 Err("bad")
```

Card 057. Pal's calls:

- **A bodyless `impl Show` derives it**, as for `Json` and `Row`; a body writes it. No type is
  `Show` until its module says so, so card 027's rule holds.
- **The literal form**, what test failures print: `Point { x: 1, name: "ann" }`,
  `Shape.Circle { r: 2 }`, `Shape.Dot`. Inside a list, optional or Result, strings are quoted
  (`["a", "b"]`, `Err("bad")`); a string on its own still interpolates bare.
- **Every field must be `Show`**, as for `Json`: the error names the field, and the help derives
  the field's type or adds the bound.
- **Generic `Json` in the same card**: `impl<T: Json> Json for Page<T>`, the same machinery.

Mine, mentioned here:

- **An impl for a generic type names its parameters, in order, and covers every instance**:
  `impl<T: Show> Show for Box<T>`. `impl Show for Box<int>` and `Two<B, A>` are refused, with
  the head to write; so there is one impl per trait and type, and two can't overlap. A blanket
  `impl<T> Show for T` is refused as before. `impl Row` stays for plain structs.
- **A use checks the impl's bounds**: `Box<S>` is `Show` when `S` is; the error says so
  ("`Box<S>` is `Show` when `T` is `Show`, and `S` has no `impl Show`") and the help fixes `S`.
- **Lists, optionals and Results are `Show` when what they hold is**: `[1, 2]`, `3` or `none`,
  `Ok(3)`, `Err("bad")`, `Ok()`. Built into the checker as `Json`'s are, rather than written as
  impls in a library module: `List` isn't a library type, and the user sees the same. Maps and
  tuples aren't `Show` yet. `xs.toString()` works too.
- **A container prints its items as literals, even a type with a written `toString`**: a list
  of orders is `[#1, #2]`, but a list of strings is `["a", "b"]`. So a `Show` dictionary has a
  second, hidden method, `literal`: strings and chars quote, everything else is its `toString`.
- The interpolation help for lists and optionals (`join the items`, `say what shows when it is
  none`) is gone: a list or optional is refused now only when what it holds isn't `Show`, and
  the help fixes that.

Lowering: an impl for `Box<T>` is a dictionary type with the impl's type parameters and their
dictionaries, `type Show__for__m__Box[T__ any, T__Show Show__[T__]] struct{}`, and its methods
use them as a generic function does. A use writes them: `Show__for__m__Box[int64,
showGo__[int64]]{}`. Lists, optionals and Results get `showList__`, `showOpt__` and
`showRes__`, built from the item's dictionary. A derived `toString` concatenates each field's
`literal`. Tests: `test/generic-impls.test.ts`; `examples/orders.candor` derives `Show` for
its recursive `Expr`.

### Default method bodies; trait methods with effects

```
trait Describe {
  fn describe(self) -> string
  fn label(self) -> string {              // a default: impls may leave it out
    return "<${self.describe()}>"
  }
  fn announce(self) uses io {             // every caller declares `uses io`
    io.println("announcing ${self.label()}")
  }
}

impl Describe for Role {
  fn describe(self) -> string { ... }
  fn label(self) -> string {              // an override: no marker
    return self.describe().toUpperCase()
  }
}
```

Card 058. Pal's calls:

- **The trait's `uses` is the contract.** An impl's method may declare fewer effects, never more,
  as a function with fewer effects fits a function type that allows more. Every caller declares
  the trait method's effects, through a bound or on a known type: changing an impl never
  changes its callers.
- **An override has no marker.** An impl writes the method and it wins. A misspelt override is
  caught already: an impl's method that isn't in the trait is an error.
- **A default body sees `self` as a `Self` with this trait**: it calls the trait's methods, and
  does only its method's effects. No fields, no supertraits.

Mine, mentioned here:

- `uses f` on a method stays refused: a method names effects, not parameters.
- A default that declares an effect it doesn't use gets no warning: the trait says it for every
  impl. An impl's method that declares one it doesn't use still does.
- A bodyless `impl` still means derived, so a trait whose methods all have defaults is
  `impl Hi for P {}`; the bodyless form's error says so.
- No `Eq` on `Self` in a default: an impl's type may hold functions, which have no `==`.

Lowering: a trait method's effects are hidden parameters after the context, in sorted order, on
the interface and on every impl's method (`_` for those an impl doesn't use). A default body is
a generic function over `Self` and its dictionary, `m__Describe__label__default[Self__ any,
Self__m__Describe m__Describe[Self__]]`, and an impl that leaves the method out gets a method
that calls it with its own type and dictionary. Tests: `test/trait-defaults.test.ts`;
`examples/traits.candor`.

### JSON: renamed fields, forms by hand, strict decoding

```
struct Item {
  itemID: int                             // "item_id"
  createdAt: int                          // "created_at"
  kind_: string as "type"                 // its own name
  price: Money                            // "12.50"
}
impl Json(snake) for Item

impl Json for Money via string {
  fn toJson(self) -> string { ... }
  fn fromJson(s: string) -> Result<Money, string> { ... }   // Err: "$.price: <text>"
}

json.decodeStrict<Item>(body)             // $.extra: unknown field; expected one of "item_id", ...
```

Card 059 (leaving out `none` was card 076). Pal's calls:

- **A case rule on the impl, `as` on one field.** `impl Json(snake) for T` names every field,
  variant and variant field by the rule; `as "name"` after a field or variant overrides it. Most
  APIs keep one style, so one word covers a type; `as` reaches a wire name that is a keyword or
  breaks the rule.
- **Strict per call:** `json.decodeStrict<T>(text)`, for the whole document, nested objects
  included. The endpoint decides, which is where a strict API is chosen anyway.
- **A form by hand goes via another `Json` type**: `impl Json for Money via string` gives
  `toJson(self) -> string` and `fromJson(s: string) -> Result<Money, string>`. No JSON value
  type; `fromJson` is the one method without `self`, allowed only here. An `Err` is a decode
  error at that value's path.

Mine, mentioned here:

- Four rules: `snake`, `kebab`, `camel`, `pascal`. Words break at `_` and capitals, a run of
  capitals staying one word: `userID` is `user_id`, `HTTPServer` is `http_server`. `camel` and
  `pascal` change only first letters, so `userID` stays `userID`. No `UPPER_SNAKE` yet.
- `kind` stays `kind` under any rule; a variant field whose JSON name is `kind` is an error, as
  before. Two fields (or variants) with one JSON name are an error naming both.
- `as` on a type without a derived `impl Json` is an error, so it never sits there doing
  nothing; `as` is for JSON only, not `Row` columns.
- `via` may name any `Json` type but the type itself, a struct or a list included; generic
  impls work (`impl<T: Json> Json for Wrap<T> via T`). `toJson` and `fromJson` take no effects,
  and aren't callable as methods: there is no static method syntax, and a caller encodes with
  `json.encode`.
- Strict checks a struct's or variant's keys before its fields, so `{"don": true}` names `$.don`
  rather than the missing `done`. A `Map` takes any key, strict or not.
- `examples/todos.candor` reads bodies with `decodeStrict`.

Lowering: `Dec(in *candor.JsonIn, j any, path string)`, where `JsonIn` carries the context and
`Strict`; `JsonOut` carries the context too, since `toJson` and `fromJson` are Candor functions
and their loops check for cancellation. A derived `Dec` calls `candor.JsonUnknown(obj, path,
keys...)` when strict. A `via` impl's methods are its dictionary's, beside `Enc` and `Dec`,
which go through the form's dictionary. Tests: `test/json-options.test.ts`.

### Fakes that use other effects; a fake's state in tests

```
fake api {
  let mut calls: List<int> = []
  fn fetch(id: int) -> string uses clock {      // the operation is `pub fn fetch(id: int) -> string`
    calls.push(id)
    clock.sleep(5_000)
    return "fake ${id}"
  }
}

test "slow" {
  assert tasks.timeout(1_000, () => api.fetch(1)) == none    // in virtual time
  assert api.calls == [1]                                    // the fake's state, read-only
}
```

Card 060. Pal's calls:

- **Fakes only.** A fake's functions may declare `uses`, as any function does; an effect's
  operations still can't. For an operation it would raise whether its callers declare `clock`
  too, which is a card of its own.
- **A test reads a fake's state** by name, `http.requests`: read-only (it isn't a place, so no
  assignment or `push`), and only in `test` blocks (CAN0035 elsewhere, naming it the fake's
  state). Methods stay for what is computed.
- **std's fake http** takes a handler that uses `clock` and runs it under the request's
  `timeoutMs` with `tasks.timeout`, so a slow server is a `.Timeout` with no real waiting. `send`
  and `openStream` use `clock` and `tasks`.

Mine, mentioned here:

- A fake may use any effect but its own (CAN0043: it stands in for it). No `uses f` from a
  callback: that would make the function generic, and it is a Go interface method. A
  callback's effects are named in its type instead, as `answer`'s are.
- What the fake uses isn't part of the operation's signature: it still matches the effect's,
  `uses` aside, and callers of `http.send` declare `http` only. Tests have every effect, so
  the effects a fake uses are always there.
- Inside a fake, effects are the real types: `clock.advance` is still the test's to call.
- A fake's state that only tests read still warns as unread by the fake.

Lowering: the fake's struct gets a field per effect it uses (`uses__clock candor.Clock`); each
test sets them from its own fakes after building them all, so two fakes may use each other. A
fake's functions now work on its state in place (`f__.calls = append(f__.calls, id)`) rather
than on copies written back on return: a function that sleeps lets other tasks into the fake,
and a copy would lose their writes. A list written by index keeps its `__own` flag on the
struct; a test reading state as a whole clears it (maps `Share`), as any whole read does. The
real effect's operations keep their copies, under the lock. Tests: `test/fakes.test.ts` (two
tasks in one sleeping fake lose nothing; std's fake http times out).

### http: stop on a signal; repeated query keys and headers

```
match http.serve("127.0.0.1:8080", handle) {     // Ctrl-C: in-flight requests finish, then Ok
  Ok() => io.println("stopped"),                 // main carries on; the program exits 0
  Err(message) => io.println("can't serve: ${message}"),
}

http.queryAll(req, "tag")                        // ?tag=a&tag=b: ["a", "b"]; req.query["tag"] is "a"
http.headerAll(req, "accept")
http.addHeader(http.addHeader(res, "set-cookie", "a=1"), "set-cookie", "b=2")
```

Card 062. Pal's calls:

- **`serve` returns `Ok` on Ctrl-C or SIGTERM.** It stops listening, lets the requests in
  flight finish and returns, so `main` carries on (closing queues, printing) and exits 0. No
  effect operation and nothing to fake: `serve` doesn't run in tests. A program that never
  serves still dies on Ctrl-C.
- **Grace, streams cut.** Requests in flight get `ServeOptions.graceMs` (10 s) and are then
  cancelled; `http.events` streams and WebSockets, which don't end by themselves, are
  cancelled at once (`streamResponse` bodies get the grace).
- **`http.queryAll(req, name)` and `http.headerAll(req, name)`** give every value; `query` and
  `headers` keep the first, as before. Tests make repeats with `http.withQuery(req, name,
  values)` and `http.withHeader`.
- **`http.addHeader(res, name, value)`** sends one more of a header, after any it has.

Mine, mentioned here:

- A second Ctrl-C ends the program at once (Go's default, restored after the first).
- Cancelled rather than signalled, `serve` stays as it was: the requests are cancelled too.
- `addHeader` puts the first value in `headers` (so `res.headers["set-cookie"]` reads it) and
  the rest in a private `more`; `http.responseHeaderAll(res, name)` reads them all, for tests.
  Names are lowercased.
- The repeats live in private optional fields (`queryAll`, `headersAll`), set by `serve` only
  for keys given more than once; a Request a test builds leaves them out and the functions fall
  back to the map.
- The client's side (sending a header twice, reading a response's repeats) stays as it was.

Lowering: `candor.Serve` registers for `os.Interrupt` and `SIGTERM` (a package variable, so Go's
test sends its own), and on the signal stops listening with `Shutdown`, cancels the requests
marked endless (an event stream or a WebSocket, marked as they start), waits for the rest up to
the grace, then cancels them. Tests: `runtime/go/http_test.go` (signal via the swapped notifier,
on every platform), `test/http.test.ts` (repeats both ways; SIGTERM end to end, skipped on
Windows, where Bun's kill doesn't signal).

Card 089: a handler returns before net/http writes its response, so closing once
the handlers had ended cut the last responses short (an `EOF` under load). `Serve` now waits for
`Shutdown`, which waits for idle connections, at most one second past the requests' end.

### http: a WebSocket client; repeated headers on the client

```
http.connect("ws://127.0.0.1:8080/chat", (ws) => {   // closes when the function returns
  ws.send("hi")
  io.println(ws.receive() ?? "closed")
})?

let req = http.addRequestHeader(http.request("GET", url), "x-tag", "a")
http.responseHeaderAll(http.send(http.addRequestHeader(req, "x-tag", "b"))?, "set-cookie")
```

Card 083. Pal's calls:

- **`http.connect(url, talk)`, a callback like `upgrade`**: the connection closes when `talk`
  returns, so none is left open. `http.connectWith(req, talk)` sends headers; `timeoutMs`
  bounds the handshake. `Err` if it couldn't connect, a status other than 101 included
  ("... answered 404, not a WebSocket").
- **The fake goes through `http.answer`**: a handler answering with `http.upgrade` is the
  server, in memory (`socketOf`'s pair), its function in a task while `talk` runs; `connect`
  waits for it too, so a crash in it fails the test with both stacks. Nothing answering, a
  `respond` URL, or a response that isn't an upgrade is an `Err`.
- **Binary frames wait for a `Bytes` type**, which `fs` wants too.
- **Repeats mirror the server**: `http.addRequestHeader(req, name, value)` sends one more;
  client responses fill `Response.more`, so `http.responseHeaderAll` reads them as it does a
  handler's. The fake passes both through: the handler's `http.headerAll` sees the request's
  repeats, and the test sees the handler's `addHeader`s.

Mine, mentioned here:

- `connect` is a function over a new operation, `http.dialSocket(req) -> Result<Dialed,
  HttpError>`: operations are public, so it shows, but `Dialed` has only a private id, so
  there is nothing to do with one but what `connectWith` does. The callback stays out of the
  operation (an operation generic over its callback's effects would be new).
- `addRequestHeader` matches names ignoring case, as Go sends them: the first value keeps the
  caller's spelling in `headers`, the rest go in a private `more` by lowercase name.
- A fake that runs `serve`, and `listen` honouring `retry:`, stay open.

Lowering: `std/wsgo.Dial` (coder/websocket) puts the client's socket in the runtime's table and
gives its id; `candor.Talk` takes it, or for the fake an upgrade id, which it pairs in a scope
of its own. Client headers cross as two flat lists, set then added. Tests:
`test/ws-client.test.ts` with `test/fixtures/ws-client.candor` (the fake under 100 orders, a
crash in the handler, a real client against a real server sending a header twice),
`test/http-client.test.ts` (repeats both ways, real and fake).

### Bytes: a type for bytes; binary files and WebSocket frames

```
import "bytes"

let png = fs.readBytes("logo.png")?
assert png.slice(0, 4) == bytes.fromHex("89504e47")?
io.println(png.toBase64())
ws.sendBytes(png)
match ws.receiveMessage() {
  none => return,
  .Text { text } => ...,
  .Binary { data } => ...,
}
```

Card 084. Pal's calls:

- **`Bytes` is built in**, a Go `[]byte` never changed once made, like a string. No `byte`
  type: a byte is an `int` 0 to 255. Methods: `length`, `isEmpty`, `at(i) -> int?`, `slice`
  (clamped like a string's), `concat`, `indexOf`, `toList`, `toText`, `toHex`, `toBase64`;
  `==`, and they can be map keys.
- **`b.toText()` is a `string?`**: `none` unless the bytes are UTF-8. `s.toBytes()` always
  works.
- **A std module `bytes`** makes them: `bytes.fromList(xs)` panics outside 0 to 255;
  `bytes.fromHex(s)` and `bytes.fromBase64(s)` are `none` if `s` isn't.
- **`fs.readBytes(path)`, `fs.writeBytes(path, data)`**, on disk and in the test's memory.
- **WebSockets: `ws.sendBytes(b)`, `ws.receiveMessage() -> http.Message?`**, an enum
  `Text { text }` or `Binary { data }`. `receive` stays text only and skips binary messages, so
  code written for text is unchanged.
- **In JSON a `Bytes` is a string of standard base64**, as Go's encoding/json writes `[]byte`.

Mine, mentioned here:

- `concat`, not `+`: lists join with `concat` too, and `+` on Bytes says so. No `for x in b`
  and no `b[i]`: the errors point at `b.toList()` and `b.at(i)`. Not `Show` and not `Ord`: an
  interpolated `Bytes` is an error whose help gives `toHex()` and `toText()`.
- `fromBase64` takes the standard and the URL alphabet, padded or not: input comes from
  everywhere. `toBase64` and JSON write the standard one, padded.
- Immutability in Go: whatever makes Bytes makes a fresh slice, and `slice` caps the result's
  capacity at its length (`b[i:j:j]`), so a `concat` on a slice can't write into the bytes it
  was cut from (a test checks it).
- A user module named `bytes` now clashes with the standard one, as `json` and `fs` do.

Lowering: `[]byte`; methods call `runtime/go/bytes.go`; `==` and `Eq` dictionaries go through
`candor.BytesEqual`; map keys encode as their length then the bytes; `candor.JsonBytes`. The
runtime's `Socket` now carries a `SocketMessage` (data, and whether it is binary) both ways:
`candor.ReceiveText` is `receive`, skipping binary ones; the in-memory pair passes them as they
are. Tests: `test/bytes.test.ts` with `test/fixtures/bytes.candor` (a hex dump on disk and in
memory, methods, hex and base64, maps and JSON, the panic, the help lines),
`test/ws-client.test.ts` (binary messages through the fake and between a real client and
server).

### http: binary bodies

```
fn handle(req: http.Request) -> http.Response {
  if req.path == "/logo.png" {
    return http.bytesResponse(200, "image/png", logo)
  }
  let upload = req.body.toBytes()
  ...
}

http.postBytes(url, "image/png", data)?
http.send(http.withBody(http.request("PUT", url), data))?
```

Card 085. Pal's calls:

- **`body` stays a `string`**, so no handler changes; functions send `Bytes`:
  `http.bytesResponse(status, contentType, data)`, `http.postBytes(url, contentType, data)`,
  `http.withBody(req, data)` for a `ClientRequest`.
- **A body is in `body` as it came, UTF-8 or not.** A Go string holds any bytes, so a binary
  body was already arriving whole; `body.toBytes()` reads it exactly. In a string that isn't
  UTF-8, each bad byte is one U+FFFD to `length()`, as before.
- **Streamed writes in bytes too: `http.streamBytes(status, headers, write)`**, `write` given a
  `fn(Bytes)`. A streamed body's pieces are read as strings, and `piece.toBytes()` is exact.

Mine, mentioned here:

- No `http.bodyBytes(r)`: it would need one for a `Request` and one for a `Response`, and
  `r.body.toBytes()` already says it.
- `streamBytes` is `streamResponse` with a converting `send`, written in Candor.

Lowering: a private `http.rawText(data)` is Go's `string(data)`, the one place a Bytes becomes a
string without the UTF-8 check `toText` makes; the functions above are written on it. Nothing in
the runtime changed. Tests: `test/http-bytes.test.ts` (an image served, an upload echoed and a
streamed binary body, between a real client and server and through the fake; bytes that aren't
UTF-8 come through whole).

### `fs` gaps, and static files

```
fn handle(req: http.Request) -> http.Response uses fs {
  if req.path.startsWith("/static/") {
    return http.serveDir("public", req.path.slice(8, req.path.length()))
  }
  ...
}

match fs.within("uploads", name) { none => ..., file => fs.info(file) }
fs.rename("tmp/upload", "uploads/a.png")?
```

Card 086. Pal's calls:

- **Sandbox: `fs.within(root, p) -> string?`**: `root` joined with `p`, or none if `p` is
  absolute, has a `:` (a drive, a Windows stream) or climbs out with `..`; `\` counts as `/`.
  By the text alone, the same on every system and in the fake: a symbolic link under `root`
  that points out is followed (documented). Pure, no `uses fs`.
- **`fs.info(path) -> Result<FileInfo, FsError>`**, `FileInfo { size, modified, isDir }`:
  `modified` in milliseconds like `clock.now()`, a directory's size 0. The fake stamps each
  write and `makeDir` with the test's virtual time.
- **`fs.read` of a file that isn't UTF-8 stays as it was**: its bytes in the string, as http
  bodies (085); `readBytes` says what it means.
- **`fs.rename(from, to)`** (a file or a directory; replaces a file at `to`, not a directory;
  errors name `from`), **`fs.copy(from, to)`** (a file, streamed with `io.Copy`),
  **`fs.removeAll(path)`** (nothing there is fine).
- **Static files**: `http.serveDir(root, rest)` through `within` (a directory serves its
  `index.html`, out of `root` is a 404), `http.serveFile(path)` (404 for no file or a
  directory, 403 when the system says no, 500 otherwise).

Mine, mentioned here:

- `removeAll` refuses a root (`/`, `C:\`), `.` and `..` (and `../..`): an AI wiping the working
  directory by a bad join is the mistake worth a guard.
- `http.mimeType(path)` from a fixed table of about thirty extensions, not Go's `mime`, which
  asks the Windows registry; text types say `charset=utf-8`. Named `mimeType` since
  `contentType` is a parameter name in `bytesResponse` and `postBytes`, and Candor has no
  shadowing.
- The fake's `rename` refuses what the disk does on both systems: onto a directory ("file
  exists"), a directory into itself ("invalid argument").

Lowering: `within`, `info`, `rename`, `copy`, `removeAll` in `fsBody`; the runtime's `FS` and
its memory gained them (`candor.Within` is a plain function). The http functions are Candor.
Tests: `test/fs-gaps.test.ts` (the same steps on disk and in memory; `within`; virtual-time
stamps), `test/http-static.test.ts` (a real server serving a directory, `%2e%2e/` and `..\`
refused; the same handler against the fake).

### `env.load` for .env files, and `slice(start)`

```
fn main() uses io, env, fs {
  env.load(".env")?              // KEY=value lines; the real environment wins
  let port = env.get("PORT") ?? "8080"
  let tag = "#news".slice(1)     // "news": one argument runs to the end
}
```

Card 087, from building candor-manager, a small HTTP service. Pal's calls:

- **`slice(start)`** on strings, lists and Bytes runs to the end, as in TypeScript and Python;
  AI coders write it by habit. Two ways to write "to the end", but the short one is the one
  expected. Lowered as `slice(start, math.MaxInt64)`, which the clamp cuts to the length.
- **`env.load(path) -> Result<void, fs.FsError>`, `uses env, fs`**: a .env file into what
  `env.get` sees. A variable already set keeps its value (dotenv's rule), so the deployment's
  environment beats the file; in a test, `env.set` beats it. `env` stays read only otherwise:
  this sets only what isn't set, once, at start.

Mine, mentioned here:

- The format: `KEY=value`, blank lines and `#` comments skipped, `export ` allowed; a bare value
  is trimmed and ends at ` #`; in `"..."` it takes `\n`, `\t`, `\r`, `\"`, `\\`; in `'...'` it is
  as written. A later line for a key wins. No values over several lines, no `${VAR}`. A bad
  line is `FsError.Failed { path, "line 2: expected KEY=value" }`; nothing is set then.
- `env.load` needs `import "fs"`: its error is an `FsError`, and a missing import is CAN0041
  with that help. The checker sends the call to a private `loadEnv` in std/fs; `env` is a
  built-in effect and can't name a std type itself.
- `candor.cmd` (and `bun run candor`) run Bun with `--no-env-file`. Bun reads a `.env` in the
  working directory into its own environment, by its own rules (it kept `\"` as written), and
  the program inherited it, so `env.load` found every variable set already. A program built with
  `candor build` never had this.

### `min`/`max`, `pow`, float `%`, floats in Go bindings

```
let page = asked.max(1).min(pages)        // int or float, same type in and out
let best = scores.max() ?? 0.0            // a list: T?, none when empty
let area = r.pow(2.0) * 3.14159
let angle = (a + 370.0) % 360.0
```

Card 088, closing card 069's "not yet". Pal's calls:

- **`min`/`max` both ways**: `a.min(b)` and `a.max(b)` on int and float (Rust's shape: Candor
  has no free functions for numbers); `xs.min()`, `xs.max()` -> `T?` on a list of anything
  `Ord`, the first of equal items. `Math`, `math`, and a bare `max`, `min`, `pow`, `abs` that the
  program doesn't define are habits with help naming the methods.
- **`pow` on both**: `x.pow(y: float)` panics on NaN or infinity (`(-8.0).pow(0.5)`,
  `0.0.pow(-1.0)`, `10.0.pow(400.0)`); `n.pow(k: int)` panics on overflow or a negative `k`.
- **Float `%`**: Go's `math.Mod`, the sign of the dividend, as int `%`; `% 0.0` panics, as
  `/` does. `%=` too.

Mine, mentioned here:

- `int.abs()`, since float had it and `Math.abs` points at it; the smallest int panics.
- Bindings: `float` passes to and from any Go float type (`float64`, `float32`, named ones),
  through a `candor.Float` constraint as ints go through `candor.Integer`. A NaN or infinity
  that Go gives panics, naming the Go function: Candor floats are never one.
- The Go type reader's own build time is now in its cache key, so a change to the reader
  (here, a new `float` kind) isn't hidden by an old `gotypes.json`.

Checked in `test/float-gaps.test.ts`; reference entries for each.

### Bytes in `sql`: BLOB columns

```
sql.exec("CREATE TABLE files (name TEXT PRIMARY KEY, data BLOB NOT NULL, thumb BLOB)")?
sql.exec("INSERT INTO files (name, data, thumb) VALUES (${name}, ${data}, ${none})")?
let data = sql.queryOne<Bytes>("SELECT data FROM files WHERE name = ${name}")?
```

Card 090, closing card 084's "`sql` has no BLOB column". `${b}` binds a BLOB; Bytes and `Bytes?`
are columns for `impl Row`, and `sql.query<Bytes>` reads one column.

Pal's call: **strict in the check, lenient at run time.** The schema check reads a column
declared BLOB as Bytes and refuses Bytes into TEXT, a string into BLOB, and either read as the
other, with help naming `toText()` and `toBytes()`. At run time Bytes read a TEXT value as its
UTF-8 bytes (a column with no declared type holds either), and a string reads a BLOB as it did.

Mine: a query of one float column is checked now too (`sql.query<float>` was left out of the
row check). Checked in `test/sql-bytes.test.ts`.

### SQL check: expressions, aliases, joins and upserts

```
sql.query<int>("SELECT coalesce(sum(size), 0) FROM bookings WHERE room = ${id}")
sql.query<Stat>("SELECT r.id AS room, count(b.id) AS n FROM rooms r LEFT JOIN bookings b ON b.room = r.id GROUP BY r.id")
sql.exec("INSERT INTO grants (user, topic, read) VALUES (...) ON CONFLICT (user, topic) DO UPDATE SET read = excluded.read")
```

Card 091. Of the 19 queries in the trials the check skipped, 12 selected an expression or an
alias (9 were `count(*)`), 4 were upserts with `excluded.col`, 2 joins, 1 a subquery. Now only
the subquery is skipped. Pal's calls:

- **All three in one card**: expressions and `AS`, upserts, inner and outer joins with aliases.
- **An expression the check can't type skips that column**, with a note naming `CAST(... AS
  INTEGER)`, the way to tell it; the rest of the query is checked.
- **`sum`, `min`, `max`, `avg` are NULL over no rows**: reading one into a field that isn't `T?`,
  or into `sql.query<int>`, is an error whose help gives `coalesce(sum(x), 0)`. `count` and
  `total` are never NULL.

Mine:

- Expressions typed: columns, `${}` values, literals, `+ - * / %`, `||`, `CAST`, `count`, `sum`,
  `total`, `avg`, `min`/`max` (aggregate and scalar), `coalesce`/`ifnull`, `length`, `abs`,
  `round`, `typeof`, `group_concat` and the text functions. Comparisons and `CASE` aren't typed.
- In a `GROUP BY`, every group has a row, so `max(x)` is NULL only if `x` can be.
- A LEFT JOIN makes the right table's columns nullable (RIGHT and FULL the left's too).
- A bare column two joined tables both have is an error, as the database would say at run time;
  the help names the table. An unknown `x.` is an error naming the tables and aliases.
- `col IS NOT NULL` in a WHERE without OR makes that column non-NULL in what is read.
- A query of one column now checks NULL too: a nullable column read into `sql.query<string>`
  is an error, as the runtime fails on the first NULL row.
- The SELECT's own aliases are names ORDER BY and the rest may use.
- Tests that meet the runtime's own row errors read from a subquery now, as an alias no longer
  hides a query from the check.

Checked in `test/sql-expressions.test.ts`.

### Syntax recovery: items, arms, and the rest of the function

```
enum Outcome {
  Made(Booking)          // error; the variant is left out, `Taken` is kept
  Taken { by: int }
}
fn f(x: string?) -> int {
  if x == none) {        // error; the `if` is left out
    return 0
  }
  return x.length() + nope   // `x` may be none: not said. `nope` is unknown: said.
}
```

Card 092. Card 028 dropped every checker error in a declaration with a syntax error, and a
broken field, variant, arm or method dropped the whole declaration or `match`. Planted one at a
time in the examples and trial apps (1,500 sites), a bad line hid the type errors of its whole
function every time, and the second of two broken fields in 4 cases of 5 (variants, arms and
extern items: every time). The trials hit it: `Made(Booking)` and `Outcome.Made(b) =>`. Pal's
calls:

- **Only what may follow is dropped.** The rest of the function is checked. Left out: what is
  on a broken line or in what it skipped; in its declaration, warnings and whole-body checks
  (missing return, unused names and effects), unknown types (`cannot tell ...`) and optionals
  (`T?` where a dropped `if` narrowed) after it, and names it would have declared.
- **A broken item drops the item**: a field, variant, extern item, member of an `impl`, `trait`,
  `effect` or `fake`, or a match arm. Its name is lost like a dropped declaration's (errors
  quoting it are left out, as are unknown types anywhere in the module). A match with a dropped
  arm has no type and no coverage check.

Mine:

- An item ends at its line (also where the lexer left out the newline, after `List<T>`), at a
  `,`, or, with a `(` left open, at a line starting in its column.
- **A `(` or `[` left open ends** at a line that starts no further in than the line it opened on,
  when the line before ended a value (not `,`, `(` or an operator): the lexer closes it there and
  gives the newline, so the error is "expected `)`, found end of line" where it is missing, and
  the next statement is one. A closing bracket pops back to its own opener. A statement keyword
  starting a line ends a statement too. Before, an unclosed `(` took the rest of its block.
- Checker: indexing an unknown value checks nothing more (it may be a map), indexing a `T?` says
  so before checking the index, and an `if` or `match` with a branch of unknown type has no
  type, instead of the others' (`if c { nope } else { none }` gave two more errors).
- Measured with the same planted errors: every one reported once, the type error in its
  function and in another declaration reported every time, both of two broken items every time,
  and no diagnostic that only follows from the syntax error.

Checked in `test/recovery.test.ts`.

### Trials on Kimi

Card 093. The trials ran Claude only; a second agent tells whether Candor suits AI coders or
one model. Pal's calls: trials run on Kimi Code (`kimi-code/k3`) from now on, with a Go
baseline. Mine: `--agent kimi|claude` on both runners (`trials/agent.ts`), Kimi with the same
tools through an agent file holding its own system prompt, tokens from its session log, no
dollar cost.

12 of 20 runs before Kimi's 5-hour quota ran out; Pal stopped the measuring there. All 12
passed every acceptance test. Candor: fewer compiles and half the lines of Go, but more time
and tokens, mostly reading the docs. Candidate cards: JSON `null`
for a none field, recovery after a bad `"""`, reference gaps.

### Release binaries and a license

Card 094. Pal's calls: one binary per OS from `bun build --compile`, on GitHub Releases with
install scripts; Go stays a prerequisite; open source, MIT OR Apache-2.0, with the repo going
public at launch (source-available was weighed: it guards a business, and there is none).

Mine:

- The binary carries `std/`, `runtime/go/` (no tests) and `tools/gotypes/` as text, set by its
  entry in `globalThis.__candorAssets`; `src/home.ts` writes them once to
  `~/.candor/<version>/` (`CANDOR_HOME`), through a temporary folder renamed into place, since
  Go builds from files and bindings read Go's types. A clone uses the repo's files as before.
- Five targets: windows-x64, linux-x64, linux-arm64, darwin-x64, darwin-arm64; 63–87 MB, nearly
  all of it Bun. `candor version` shows the Go found; the missing-Go message names the install
  for the OS. `./candor` runs a clone on macOS and Linux.
- Checked: the Windows binary alone runs every example with a `.out` and every example's tests;
  the Linux one runs hello and the todos tests under WSL with a Go fetched into `/tmp`. macOS is
  cross-built only.

### Reference gaps from the Kimi trials

Card 095. What Kimi grepped `docs/design.md` for now sits where it looked first. In
`docs/start.md`: the escapes and the `"""` rules (the dropped last newline included) with an
example that runs; the reserved words; JSON field order (the struct's) and a plain `T` for a
`T?` field; and returning `serve`'s `Err` from `main` to exit 1. In the reference: `io.output()`
gives everything since the test started on each call. The gateway's exit 0 with the port taken
was the app's own code (it printed `serve`'s `Err` and returned), not `serve`.

### JSON `null` for a none field: `impl Json(nulls)`

```
struct Quote {
  total: int
  couponCode: string?
}
impl Json(snake, nulls) for Quote   // {"total":9,"coupon_code":null}
```

Card 096. A none field is left out (076), so Kimi's pricing app, whose spec wanted
`"coupon": null`, built its body by hand (card 093). Pal's call: **per type**, next to the
naming rule, since an API's shape belongs to the type and every encode should agree; not per
field or per call. Mine: the options come in either order, one naming rule and one `nulls` at
most; `nulls` covers the type's own fields, struct and variant alike, and not the types inside
it, which say their own; not with `via`, whose `toJson` writes what it likes. Decoding is
unchanged: a missing field and `null` are both none.

### Recovery after a Python-style `"""` string

Card 097. Kimi's logs app wrote `"""requests: 6` ... `top paths:"""`, as in Python: text after
the opening `"""` makes it a one-line string, so each gave "unterminated", its other lines were
lexed as code, and the next `"""` opened a string where one closed. 41 errors. Mine:

- A one-line `"""` string that reaches the end of its line looks ahead to the next `"""`. Unless
  that one opens a string (another `"""` follows it on its line, or nothing does and `=`, `(`,
  `[`, `,` or `{` comes before it), it is taken as the close: one error, whose help gives the
  multi-line form, the lines up to it are the string, and lexing goes on after it.
- Not a `:` before it: text ends in a colon (`top paths:"""`) more often than a field's value
  starts a multi-line string.
- The rule stays as decided (one way to write a multi-line string); only the recovery changed.
- Measured as in card 092: each of the 36 multi-line strings in the examples and trial apps
  rewritten Python-style (close after the last text) and Kotlin-style (close on its own line),
  one at a time. Before, 2 to 32 errors each; after, one, every time.

Checked in `test/raw-recovery.test.ts`.

### `net`: DNS lookups and a TCP probe

```
match net.lookupMx("example.org") {
  Ok(mx) => ...,                          // List<net.Mx>: host, priority, lowest first
  Err(e) => ...,                          // .NotFound { name }, .Timeout, .Refused, .Failed
}
net.reachable("example.org", 443, 3_000)    // Ok(ms) or why not; connects and closes
```

Card 099, for an ops console's infrastructure screen. Pal's calls: one `net` effect; a function per
record type, typed (MX keeps its priority, TXT one string per record); a TCP probe only, no
connection to talk over. Mine: a 5 s limit on lookups; names without trailing dots; Windows'
refused error mapped like the others. The fake resolves nothing and refuses every port until the
test sets them, and a probe takes its time on the fake clock.

### `exec`: running a program

```
let cmd = exec.withStdinFile(exec.command("ssh", ["web1", "./release.sh"]), "site.tar.gz")
let done = exec.run(cmd, 0, (n, line) => {
  send(line.text)                         // each line as it comes, stdout and stderr
  return n + 1
})?                                       // Err only if it can't start
if done.code != 0 { ... }                 // a failing program is its exit code
```

Card 100, for the same console's deploys. Pal's calls: output streamed, as a fold like `http.listen` and
`fs.readLines`, with `exec.output` buffering it on top; stdin from text, `Bytes` or a file; any
program, the `exec` effect being the permission (an allow-list in the signature would need
effects with parameters).

Mine:

- The effect's operations are the steps, `spawn`, `next` and `wait`, over a process id kept in
  a table in the Go package; `run` and `output` are ordinary functions on them, so the fake
  implements three operations and a fold stays a fold.
- Lines without their ending (`\r` dropped too), stdout and stderr interleaved as they come,
  `line.fromStderr` telling them apart. `Bytes` cross to Go as a raw string, as http bodies do.
- A non-zero exit is the `code`, not an `Err`; `.NotFound` is a failed look-up of the program
  only, so a missing directory or stdin file is `.Failed` with Go's message.
- Cancelling the task kills the process (`exec.CommandContext`), with 2 s for its pipes to
  drain; `code` is -1 then.
- The fake: no program runs; `exec.script(program, lines, code)` answers it every time (the
  latest script wins), anything else isn't found, and `exec.ran()` lists the commands.

Checked live on Windows: `go version`, a failing `go`, `sort` fed text and bytes, a missing
program, directory and stdin file, an environment variable, lines arriving one second apart,
and a 5 s `sleep` killed by `tasks.timeout(500, ...)` at 501 ms.

### How an AI coder learns Candor: `candor guide`, `candor init`, a skill

Card 101. The trials gave agents a copy of the docs; a user gives them a binary. Pal's calls:
the binary is the source (`candor guide` prints `docs/start.md`, embedded, behind a short
checklist; `candor doc` was there); `candor init` writes `AGENTS.md`, which most coding agents
read, and a `CLAUDE.md` of `@AGENTS.md`; and a Claude Code plugin with a `candor` skill now,
in this repo (`plugins/candor`, marketplace `.claude-plugin/marketplace.json`). Pal's use: go
to an app's folder, start Claude, say "rewrite this in Candor", with nothing from this repo.

Mine: the skill points at the commands rather than holding the language, so it can't fall
behind the installed compiler; it pre-approves `candor *` in Bash; it has a section on porting
(the original's outside behaviour as the spec and as tests). The guide's links to std point at
the installed copies. Checked: headless Sonnet in an empty folder outside the repo, the release
binary alone on its PATH, the plugin by `--plugin-dir`, asked for a word counter: the skill
fired, it read the guide, used `candor doc` three times, and had a tested program in 7 turns
($0.15).

### http client: `res.url` and `redirects`

Card 102, from the console port (a check that a domain forwards where it should). Pal's
calls: both. `Response.url: string?` is the URL a client response came from, after redirects
(`none` on one a server makes); `ClientRequest.redirects: int?` follows at most that many, `0`
giving the redirect itself with its `location`. Left out, up to 10 and an 11th fails, as Go's
client did. The fake follows through its table and handler, each hop in `http.requests`.

Mine: a negative `redirects` is an error, not "the default"; past an explicit limit the last
3xx comes back (an `Ok`, as any status is), only the default limit fails, since there it means
a loop. Methods change as in Go: 301/302/303 become a GET without a body (a HEAD stays one),
307/308 keep both. `http.respondWith(url, res)` answers with a whole Response, so a test can
give a redirect its `location`. One Go client per limit, so connections stay shared. start.md
now says a Map keeps its keys in order, JSON included: the porting agent assumed Go's maps and
sent its record file through as text to keep the order.

### Gaps go in the app's `candor.log`

Pal's call: an app being written or ported logs what Candor lacked to `candor.log` in its own
root, and apps know nothing of the compiler's repo (the sound library port had written its log
into this one). The guide's checklist, `candor init`'s AGENTS.md and the skill all say so. The
version went to 0.0.2 so installed binaries write out the new std rather than reuse 0.0.1's.

Replaced later (Pal: gaps go to the task board, not a log): no `candor.log`. The
guide, AGENTS.md and the skill say to work around a gap and tell the user; a project that says
where gaps go (in its CLAUDE.md, say) gets them there too.

### `json.Value`: JSON of any shape

Card 103, from the console port's RDAP check (`vcardArray` is arrays of mixed types). Pal's
calls: an enum, `Null`, `Bool`, `Int`, `Float`, `Text`, `List`, `Object`, decoded from any
document, a field of it allowed in typed structs, encoded back; ints and floats apart, so an id
past 2^53 survives.

Mine: payloads are named fields (`.Text { value }`, `.List { items }`, `.Object { fields }`),
as every enum's are. There are no inherent methods, so the reading methods are a trait,
`json.Lookup`, implemented for `Value`. With no `?.`, a chain through `Value?` would be nested
`map`s, so `get` and `at` give `.Null` for what isn't there (as serde_json's index does) and
only the last step is an optional: `v.get("a").at(1).text()`. Missing and `null` read the
same that way; a `match` on `fields()` tells them apart. A number is an `Int` when written
without `.` or exponent and it fits in 64 bits, else a `Float`; so `1.0` comes back as `1`
(JSON doesn't keep the difference). `Show` is the JSON. The compiler writes the impl's body
(`jsonValueImpl`), as it does `encode`'s.

### A name in a pattern takes the whole optional

Card 104, from the console port: `.File { path, bytes, suffix }` with two optional fields
needed four arms, since a name on a `T?` matched only a present value. Pal's call: a name
takes the whole value, `none` included, unless the arms above took `none` in its place; then
it is the present value, as before. `none => ..., t => ...` and `{ x: none }` then `{ x }` read
as they did; `let` and `for` patterns already took names whole, so all three now agree.

Mine: the checker binds each such name whole, and once the arm's pattern is checked asks the
exhaustiveness checker whether the rows above cover the pattern with that name read as `none`
(`settleName`); if so the name becomes the `T` and the emitter tests `.some` and binds `.value`
(`presentBindings`). A name before its `none` arm now covers it: the arm is unreachable (a
warning), with help to move it up. Using such a name as a `T` gets help naming the arm rule;
any other `T?` used as its `T` (`t.id`, `n + 1`) now gets help too (check it, or `??`), where
it had none. Broke one test that read a name before `_ => return` as present.

### `hash`: digests, HMACs, files

Card 105, from the sound library port, which bound Go's `crypto/sha1` for its root ids. Pal's
calls: Bytes in and Bytes out, one function per algorithm (`toHex()`/`toBase64()` already make
text, and a string goes in as `s.toBytes()`); sha1, sha256, sha512, md5, hmacSha256,
hmacSha512 and a constant-time `hash.equal`; and files hashed without reading them whole.

Mine: the files are `sha256File(path)` and so on, one per digest, `uses fs`, an `FsError` as
`fs.readBytes` gives; the real fs streams with `io.Copy`, a test's hashes the file in memory. No
streaming hasher over pieces yet (a fold over `readBody` would want one); no HMAC over a file.
The module doc says md5 and sha1 are for ids and old checksums, and that passwords want a slow
hash this module doesn't have.

### `fs.readRange`, and `Range` requests

Card 106, from the sound library port, which bound Go's `ReadAt` to read WAV headers and served
`Range` by hand for `<audio>` seeking. Pal's calls: Range is the server's job, unseen, with no
API change; `fs.readRange(path, offset, length)` clamps like `slice`, fewer bytes at the end,
none past it, a negative counting as 0.

Mine: on the real fs, `serveFile` (and so `serveDir`) answers with a stream of the file that
the runtime also records as a file (`PutFile`); `serve` sends that with Go's `ServeContent`, so
ranges (206, 416, several as multipart), `If-Modified-Since` and HEAD come from Go, and the file
is never held whole. Anything else reading that body (`http.bodyOf`) reads the stream. In a
test the fs is in memory and the whole file is the body, as before, so a test can't see a 206:
the handler is called directly, and ranges are the server's. A file gone between `fs.info` and
sending is a 404. No ETag.

### `http.readForm`: forms and uploads

Card 107, from the sound library port, which parsed FormData uploads by hand over Bytes (about
70 lines, a boundary split across `readBody` pieces included). Pal's calls: in memory,
`http.readForm(req, maxBytes) -> Result<Form, FormError>` with `Form { fields: Map<string,
List<string>>, files: List<FormFile { field, name, contentType, bytes }> }`; a `maxBytes`
argument on every call, `TooLarge` past it for the handler to answer 413; urlencoded forms
through the same call; `http.formRequest` for tests.

Mine: `FormError` is `NotAForm { contentType }`, `TooLarge { limit }`, `Malformed { message }`,
`Broken { message }`, with `impl Show`. Parsing is Go's `mime/multipart`; a part without a file
name is a field, as Go's own `ParseMultipartForm` has it, so an empty file input comes as a
field with "". A streamed body stops being read once it passes `maxBytes`; a plain one is
already capped at 1 MiB by `serve`. Urlencoded keys keep their order (parsed by hand:
`url.ParseQuery` gives a Go map). A multipart body without its closing boundary is `Malformed`
(Go's reader takes it for an empty form). `formRequest(method, path, form)` writes the body
with a fixed boundary, so `readForm(formRequest(m, p, f), n) == Ok(f)`. Not done: spilling
large files to disk, as Go does past `maxMemory`; a folder-writing variant can come if memory
shows up.

### `import ... as`, `\u{..}`, `lastIndexOf`, `isOk`/`isErr`, quiet serveFile errors

Card 109, from the console and sound library ports. Pal's calls:

- `import "bytes" as b`: the no-shadowing rule stays, so a module's name is still taken in the
  file, but the alias is what's taken. The clash error's help offers `as`; using a module's own
  name after aliasing it says what it is imported as.
- `\u{1b}` is the one escape for any code point: 1 to 6 hex digits; surrogates and past
  10FFFF are errors. No `\x`. (`65.toChar()` already went the other way; the log missed it.)
- `r.isOk()` and `r.isErr()` on a Result: bool, nothing read out.
- `serveFile` and `serveDir`: 404, 403, 416 and 500 have empty bodies.

Mine: an alias names the module only in the file that imports it; types keep their module's own
name, in Go and in messages (`geo.Point` even under `import "geo" as g`). One module imported
twice under two names is an error, as a repeated import was. `lastIndexOf` on string (code
points) and Bytes, like `indexOf`; `rfind`/`rindex` point at it. The 416 is quiet by a writer
wrapped around Go's `ServeContent` that drops what it writes after an error status, and keeps
its sendfile path for the file itself.

### `http.served`: a file's ranges, 304 and HEAD in a test

Card 110, from the sound library port, which checked 206, 416 and 304 from a Node script against
the running server. Pal's calls:

- Go's own `ServeContent` answers in a test too, over the memory file, so the status, headers
  and body are the server's.
- All of it: `Range` (206, 416, multipart), `If-Modified-Since` and `If-None-Match` (304),
  `HEAD`, `Last-Modified` and `Accept-Ranges`.
- The way in is `http.served(req, res)`: what `serve` sends for `res`, the handler's answer to
  `req`. The fake (`http.answer`) can't run a handler that uses `fs`, so the test calls the
  handler directly, as before, and hands the answer to `served`.

Mine: in a test `serveFile`'s response keeps the whole file in `body`, so a direct check of it is
unchanged, and also holds a stream the runtime records as a memory file with its write time
(`PutMemFile`); `served` runs `ServeContent` on that into a small recorder (not `httptest`,
which every server binary would carry), dropping a 416's text as `serve` does. Anything else
is `res` as it is, without its body for `HEAD`, as Go's server sends it. Several ranges' random
multipart boundary becomes zeros of the same length, so a test is the same every run and
`content-length` holds. The test clock starts at 0, 1970, a date a server sends no
`Last-Modified` for: the doc says to `clock.set` first. Outside a test `served` gives `res`
unchanged. A 304 for an `etag` drops `last-modified`, as Go does.

Checked in `test/http-served.test.ts`.

### `mime`: mail messages, parsed and built

Card 112, the first of three (with `imap` and `smtp`, cards 113 and 114) for the console
port, whose mail screen replaces TypeScript on imapflow, mailparser and
nodemailer. Pal's calls:

- Std modules, not Zoho's REST API: IMAP and SMTP stay generic, for any mailbox.
- Parsing in Go (net/mail, mime, mime/multipart, quotedprintable), charsets from
  golang.org/x/text.

Mine:

- `mime.parse(raw: Bytes) -> Result<Message, MimeError>`, pure. Only a broken header block is
  an `Err`; the rest is lenient, as mail readers are: an address list net/mail refuses still
  gives its addresses, broken base64 what decoded before the break, an unknown charset the
  valid UTF-8 with the rest replaced.
- Go hands the message over as JSON, which `impl Json for Message` decodes: bindings pass
  ints, strings and lists, and an attachment's bytes ride in base64, as Bytes do in JSON. A
  std module can't declare a dependency without bindings (CAN0042 asks for an effect), so the
  compiler adds x/text for a program that imports `mime`, as it adds fsnotify for `fs.watch`.
- Ids lose their angle brackets both ways. `from` is the first address, an `Address?`: one
  From is what every client sends. In a multipart/alternative only the first plain and HTML
  alternatives count; inline text parts elsewhere join with "\n", as mailparser does. A part
  with a filename or `Content-Disposition: attachment` is an attachment even if it is text,
  and so is any non-text part; `inline` is true for `inline` or a Content-ID without a
  disposition.
- `mime.compose(draft) -> Composed uses random, clock`: the Message-ID is `<uuid@domain of
  from>` and the Date now, both generated, so the caller has the id to thread on. The body is
  UTF-8 text/plain in quoted-printable; names and subject in RFC 2047 Q words, lines folded at
  78. It gives the envelope's `from` and `recipients` (To and Cc) for `smtp.send`.

Checked in `test/mime.test.ts`.

### `imap`: reading a mailbox

Card 113, for the console port's sync of INBOX and Sent. Pal's calls:

- Its own effect, `uses imap` (and `uses smtp` for sending): a sync's signature says it reads
  mail and a send's that it sends.
- A session callback, `imap.session(account, (s) => ...)`, logging out however the callback
  ends (a `defer`), like `http.connect`'s WebSocket: one connection per sync, and the
  uidValidity read on the same connection as the fetch.
- On github.com/emersion/go-imap v1 (stable), not v2 (beta) or a client of our own.

Mine:

- Implicit TLS only (993), as asked; STARTTLS on 143 when a server needs it. `timeoutMs`
  (60 s left out) bounds the connect, then each command; cancelling the task ends the
  connection (`context.AfterFunc` terminates it).
- The effect's operations are the steps (`open`, `folders`, `select`, `fetch`, `fetchAbove`,
  `close`), so the fake replaces them, and `session` is a plain function over them. A session
  is an id in imapgo's table, as exec's processes are.
- `select` is EXAMINE and fetching is `BODY.PEEK[]`: a sync marks nothing read.
- `fetch(s, from, to)` by sequence number, for the newest N; `fetchAbove(s, uid)` is `UID
  FETCH uid+1:*` with the result filtered, since `n:*` gives the newest message even when its
  UID is lower: the caller never sees an old message again. A message is its `uid`, internal
  `date` and raw `source` (Bytes, for `mime.parse`).
- `ImapError` tells `.Connect` (no connection, or it broke), `.Login`, `.Timeout`,
  `.NoFolder` and `.Failed` apart. go-imap gives a server's NO as a plain error, so the kind
  comes from where it happened unless the error is a network one.
- `folders` gives a `SpecialUse?` (RFC 6154's seven) and the raw attributes.
- The fake: INBOX exists, `addFolder(name, use)`, `addMessage(folder, raw, date)` (UIDs
  counted up), `setUidValidity(folder, n)` (messages and UIDs kept), `refuseLogin(message)`,
  and `openSessions()` to check that every session logged out.
- The std module names the client package in its versioned `extern`
  (`github.com/emersion/go-imap/client@v1.2.1`), not the module: `go get` of the module root
  doesn't bring what the client imports (go-sasl).

Checked in `test/imap.test.ts`: a sync against the fake (the newest N, then only new UIDs,
then a refill after a uidValidity change; the Sent folder by special use; a missing folder; a
refused login), and `std/imapgo/imap_test.go`, run in the built module, against go-imap's own
server over TLS on 127.0.0.1 (a certificate made in the test, trusted through a variable only
the test sets): login, LIST, SELECT, FETCH, a wrong password, a closed port, a silent server
timing out.

### `smtp`: sending mail

Card 114, the last of the three. Pal's call: its own effect, `uses smtp`.

Mine:

- `smtp.send(account, composed)` takes a `mime.Composed`: the envelope (From, then To and
  Cc) comes from what `compose` wrote, so it can't disagree with the headers. `smtp.verify`
  connects and logs in and sends nothing, for an app password that reads but can't send.
- Port 465 is implicit TLS, any other STARTTLS, as nodemailer decides; a server that offers no
  STARTTLS gets nothing, the password never in the clear. AUTH PLAIN, else LOGIN, which Go's
  net/smtp lacks and smtpgo adds.
- A connection per call: a send is rare, a session (as imap has) would buy nothing.
- `SmtpError`: `.Connect`, `.Login`, `.Recipient` (any refused recipient stops the send before
  DATA, so nothing goes to the others), `.Timeout`, `.Failed`.
- The fake keeps `sent()` (envelope and message) and can refuse a login or an address.

Checked in `test/smtp.test.ts` against the fake, and `std/smtpgo/smtp_test.go`, run in the
built module, against a small server it starts on 127.0.0.1: implicit TLS with PLAIN, STARTTLS
with LOGIN only, a wrong password, a refused recipient, no recipients, no STARTTLS, a closed
port, a silent server timing out. `examples/mailcheck.candor` runs the three modules against a
real mailbox (Zoho's by default).

### `fs.watch`, `fs.join`, `b.toRawText()`

Card 108, from the sound library port. Pal's calls:

- `fs.watch(dir, start, each)` is a fold, like `exec.run`, but one that never ends by itself:
  `each` returns `fs.Step`, `.Continue { value }` or `.Stop { value }`, and cancelling the task
  stops it too.
- Debounced and recursive: a burst on a path is one change; a directory made later is watched,
  and what's already in it comes as Created.
- Over fsnotify in `main`; in a test the test's own writes are the changes, each one.
- `fs.join(root, path)` with the root's separator; `within` unchanged.
- `b.toRawText()`: the bytes in a string as they are, the inverse of `text.toBytes()`.

Mine:

- `Change { kind, path }`, `kind` `.Created | .Changed | .Removed` (Show gives `"created"`, an
  SSE event's name), `path` relative to the directory watched with `/`: a key as it is, and
  the same on every system and in the fake. `fs.join(dir, c.path)` gives the full one.
- Debouncing settles by looking: once a burst has been quiet 100 ms (at most 1 s after it
  began), each path named is stat'ed against what the watch knew. Unknown and there: Created;
  known and gone: Removed, children first; a known file still there: Changed; a file made and
  removed in one burst: nothing. A directory's own Changed is noise and left out, as is chmod.
- The watched directory removed is an `Err(NotFound)`; a file given is an `Err` saying to watch
  its directory.
- fsnotify is a requirement only of a program whose own code names `fs.watch`, built in `main`:
  `std/watchgo` is imported by the emitted Go then and only then, so a program that reads files
  doesn't fetch a watcher, and `candor test` never does. A test that waits on a watch nothing
  feeds deadlocks, and the report says how: `.Stop`, or `clock.sleep(1)` before the writes so
  the watch has begun (virtual time moves only when every task waits).
- `join` cleans `.` and `..` (it is `path.Join`). A drive (`D:`) or share (`\\nas\share`) is a
  volume: `..` stops at its root, so `fs.join("D:\\Sounds", "..")` is `D:\`, never `D:` (the
  current directory on D:, as the sound library port's log pointed out).
- On Windows a watch holds one handle, on its root, with one ReadDirectoryChangesW over the
  subtree (x/sys, which fsnotify brings). fsnotify has no recursive watch outside its own
  tests, and its handle on every directory kept a watched folder's subfolders from being moved
  or removed (EPERM), as the sound library port found binning a folder. Elsewhere it stays fsnotify, a
  watch per directory. A root moved or removed isn't an event under it, so a watch looks every
  second whether its root is still the directory it began on (`os.SameFile`).

### `regex`: regular expressions

```
let date = regex.compile("(?P<year>[0-9]{4})-([0-9]{2})")?
regex.matches(date, s)                     // anywhere; ^...$ for all of it
regex.find(date, s)                        // Match? { text, start, end, groups, named }
regex.replace(date, s, "$2/\${year}")      // Go's expansion; \$ since ${ interpolates
```

Card 115, from the port of adnanh/webhook, whose `regex` trigger rule had
no regex to call and got a 16 KB backtracking matcher. Pal's call: a std module over Go's RE2,
`regex.compile` giving a `Result`, functions on the compiled `Regex`.

Mine:

- `Regex` holds its pattern in a private field, so only `compile` makes one, and it is a plain
  value (compared, kept in a struct, nothing to close). The Go side keeps compiled patterns by
  their text, starting over past 1000, so patterns made from data can't grow it without end.
- Positions count code points, as `slice` and `indexOf` do; Go's byte offsets are converted.
- `groups[0]` is the whole match, as in Go and JavaScript. A group that took no part is `""`,
  as Go's `FindStringSubmatch` gives it: `List<string?>` indexes to `string??`, which no one
  wants to write. `named` holds only the named groups that took part.
- `replace` is Go's `ReplaceAllString`, `$1` and `${name}`. `${` interpolates in a Candor
  string, so the doc says `"\${name}"`. `replaceWith(r, s, fn)` is Candor over `findAll`.
- No compile-time check of a literal pattern: the compiler is TypeScript, and JavaScript's
  syntax isn't RE2's. A literal pattern that's wrong fails at its first run, with Go's reason.

Checked in `test/regex.test.ts`.

### Bits on int, `0x` literals, `hash.hmacSha1`

```
h = h.xor(b).wrappingMul(0x0100_0193).and(0xffff_ffff)
let high = word.ushr(32)
```

Card 116, from the webhook port, which had no `hmacSha1` and no XOR and so did HMAC-SHA1 a bit
at a time with `%` and `/`. Pal's call: methods on int, not operators, so no precedence table
grows. Mine: `and`, `or`, `xor`, `not`, `shl`, `shr` (arithmetic), `ushr` (logical, JavaScript's
`>>>`); a count outside 0 to 63 panics with the count, where Go gives 0 or -1; `shl` drops the
bits it shifts out, never an overflow. Literals `0xff`, `0b1010` (and `0X`, `0B`, separators
between digits), turned into decimal digits by the lexer, so nothing after it sees another
base; past the int range it is the decimal literal's error. No octal. `hash.hmacSha1` beside
the SHA-2 ones, its doc steering new signatures to SHA-256.

### `test fn`: helpers for tests

```
test fn ranOnce(program: string) -> exec.Command uses exec {
  let ran = exec.ran()
  assert ran.length() == 1
  ...
}
```

Card 117, from the webhook port, whose tests repeated their setup because `assert` and the
fakes' own functions (`exec.script`, `exec.ran`) work only in `test` blocks. Pal's call: `test
fn`, which may do both, and which only tests and other test fns can call.

Mine: it declares `uses` like any function and is handed the calling test's fakes, so in Go its
effect parameters are the fakes' concrete types and a fake-only call is the same method call
as in the test. It is checked after the module's fake (a test fn may read the fake's state) and
emitted only by `candor test`; `pub test fn` shares one across files. Naming one outside a test
is CAN0035, with fake-only things; `assert`'s and the fake-only errors' helps now name `test fn`.
A failing `assert` in a helper panics like any other, so the test fails, and the trace has the
helper's line and the test's.

### The webhook port's small gaps

Card 118, the rest of the webhook port's `candor.log`. `http.Request.remotePort: int?` beside
`remote` (the original logs `ip:port`). An `exec.Line` keeps its `ending`, so `exec.output` is
what was printed, byte for byte, and its new `combined` is both streams in the order the lines
came, Go's `CombinedOutput` near enough (two lines printed at once on different streams may
swap): still lines, so the fold stays the one way output arrives. `exec.scriptSlow` spends
test time before each line and the end, so a test can time a run out. `fs.watch` of a file is
done in Candor: its directory watched, changes to other names dropped, a removal not an end, so
a config file can be reloaded however an editor saves it, in `main` and in tests alike.

Left: an effect's name can't name a local (`env`), which the port tripped on; it is the
no-shadowing rule, kept. JSON numbers lose their text (below).

### `crypto`: sealing bytes, and keys from passphrases

Card 119, asked for by a password vault in the console port.

```candor
let salt = random.bytes(16)
let key = crypto.deriveKey(passphrase, salt, crypto.Argon2 { time: 3, memoryKiB: 65_536, threads: 4 })
let sealed = crypto.seal(key, secret.toBytes())   // uses random
let back = crypto.open(key, sealed)?              // Result<Bytes, string>
```

- **Random bytes are `random.bytes(n)`** (Pal): the `random` effect already draws from
  crypto/rand, so a second effect meaning "random from the OS" would only split the fakes. The
  real one reads crypto/rand directly; the fake draws from the test's seed, like `token`.
- **`seal` is AES-256-GCM** with a 12-byte nonce from `random`, put first; the tag goes last, so
  a sealed message is 28 bytes longer, and Go's or Node's AES-GCM opens it. `uses random` is all
  the effect there is: in a test, sealing is reproducible under the seed, and `open` and
  `deriveKey` are plain functions with no fake, since nothing in them varies.
- **`open` can't say which went wrong**: a wrong key and a changed byte fail alike, as GCM
  can't tell them apart; too few bytes says so.
- **`deriveKey` is argon2id**, 32 bytes, with the costs a struct the caller fills in (no
  default: the vault stores them beside the salt). Contracts check the salt (8 bytes or more)
  and argon2's ranges. The key's length is checked in Go, not by a contract, because a contract's
  diagram prints the values in it: a failure would put the key in a log.
- golang.org/x/crypto/argon2 is required by the compiler when `crypto` is imported, like x/text
  for `mime`: it is a dependency of std/cryptogo, which no `extern` names.

The port found a compiler bug: a contract's text was cut from the entry file's source, so one in
an imported module showed the wrong line, or crashed the compiler past the entry's end. Each
emitted unit now carries its own source.

### Test binaries are deleted once they have run

`.candor/<module>.test/` kept each test file's binary, 7-17 MB apiece: 110 MB in the console
port's server for eight test files, none ever run again. `candor test` now deletes the binary after it
exits, pass or fail (Pal). The module around it stays: go.mod, go.sum and gotypes.json keep the
next build quick, and Go's build cache has the compiled packages, so a rebuild is a link. `run`
and `build` keep theirs: one per program, and `build`'s binary is what was asked for.

### A lambda's result partly written with type parameters

A bug from the console port, card 121: for `f: fn(int) -> Result<(int, T), string>`, what the
parameter's type says of the lambda's `Ok` had `T` as `error`, which wins when merged with the
returns, so the lambda's type held an `error` nobody reported and the emitter crashed. Unknown
parameters are now holes in those hints, as in the returns' own shapes.

### `json.encodeIndented`

Card 122, from the console port (a committed tasks.json that wants small diffs). Mine: one
layout, two spaces a level, as `JSON.stringify(v, null, 2)`; no indent parameter until someone
needs another. Go's `json.Indent` over what `encode` wrote.

### `Lock`: effects under a lock

Card 123. The console port guarded a file's read-change-write with a one-slot Channel, since a
Mutex's function can't use effects (card 018's rule, so a lock is never held while waiting).

- **A Lock handle (Pal).** `s.lock()` gives a `Lock`, which holds nothing;
  `lock.hold(() => ...)` runs the function while no other task holds it and gives back its
  result. The function may use effects, and the call performs them. The Mutex keeps its rule.
- Mine: **one Lock at a time per task.** A `hold` inside a `hold` panics, the same Lock or
  another, and so does one in a task spawned inside a `hold`: two Locks taken in opposite orders
  deadlock, and one can't. What is changed together goes under one Lock. A Mutex inside a hold
  is fine; a hold inside a Mutex's `update` panics, as any handle there does.
- Mine: the lock is let go however the function ends (a return, a panic, a cancel), and a task
  waiting for it can be cancelled: on goroutines it is a one-slot Go channel, not a
  `sync.Mutex`. Under the test scheduler a waiting task is blocked like one on a Channel, and a
  deadlock names it, `1 on Lock.hold`.
- Unlike the Mutex, a held Lock is contended under the scheduler (its function yields at every
  effect), which is the point: the scheduler's orders try the interleavings around it.

### A lambda whose body is an `if` or `match` of `Ok` and `Err`

Card 124, from the console port. `(doc) => match doc { ... => Err(r), ... => Ok(b) }`, passed
where the result is a `Result<T, E>` with `T` to learn, said it couldn't tell what `Err(r)` was:
a `match` with a value joins its arms' types, and each arm alone says only half. Mine: with
nothing saying the result, a body like that is checked as if each branch were a `return` (the
AST is rewritten), and card 050's inference over returns puts the halves together. Bodies whose
branches each say their type are left alone, so their mismatch errors read as before.

### `Result.ok()`

Card 125, from the console port, which wrote its own `or(r, fallback)`. Pal's call: `r.ok()`
gives a `T?`, so the value or a fallback is `r.ok() ?? fallback`. `??` on the Result itself
stays refused: the error would go unread with nothing at the call saying so, and `.ok()` says
it. A `Result<void, E>` has no value to take (CAN0024, use `isOk()`).

### Effects on callbacks: `uses f` in the guide and the help

Card 126, from the console port, which logged "no effect polymorphism": a pure helper taking a
lookup backed by the store declared `uses sql`. `uses f` does that already; the guide never
said so, and the mismatch's help said to add the effect to the type. Pal's calls: document it,
and `uses` written on a lambda stays out, with its own error (a lambda's effects are what its
body does). Mine: when the function type is a user function's parameter, the help offers
`uses <param>` on that function as well.

### `html.toText`

Card 127, from the console port: Zoho's account mails are HTML-only, and the app wrote a
character walk to show them. Pal's call: a std `html` module with `toText`; `mime` stays as
it is (`text` says what the mail held), and the app writes `m.text ?? html.toText(m.html ?? "")`.
Mine: on golang.org/x/net/html v0.60.0 (the one that needs the x/text `mime` already pins),
required only when a program imports `html`, as `mime` does x/text. What it writes: blank
lines around paragraphs, headings, lists, tables and `pre`; a line for `div`, `li`, `tr` and
the like; `br` a line end; table cells a space apart; list items `- `; an `http(s)` link's
address after its text unless the text holds it; an image's `alt`; `head`, `script`,
`style`, `noscript`, `template`, `svg`, `iframe` left out; whitespace collapsed outside `pre`.
No nesting indents, no numbered lists, no width wrapping: a reader's view, not a renderer.

### `html.toText` reads mail layout

Card 128. The console port ran 0.0.17 over Zoho's mails and kept its own walker: no blank lines between
paragraphs, a bare "(http://...)" for the logo link, a row's cells run together. Scrubbed
skeletons of two mails (tags and styles kept, text as x's) showed why: each paragraph is a
table row, and the gap between them is the cell's `padding:20px 0 0 12px`. Mine, as rules a
browser's view gives, not Zoho's names:

- A block or cell whose inline `style` opens a gap above or below (padding or margin, longhand
  or shorthand; 8px, 6pt, 0.5em, any %) gets a blank line there.
- A row whose cells hold only inline content is one line, cells a ` | ` apart. Otherwise each
  cell is read on its own line, and a cell whose text runs to several lines is set apart by a
  blank line, so its last line doesn't read as the next cell's first.
- A link's address shows only after text of its own (an image's `alt` isn't), and not when
  the text already names it (`www.x.io` for `https://x.io/`).
- `display:none` is left out (mail's hidden preview text); three line ends make one blank line.

The skeletons stayed in the port; the tests carry small pages with the same structure.

Card 129, the one mail of ten still worse (a Zoho Campaigns one): an image whose `alt` is an
address shows nothing; a link to the same address with the same text as the link just
written, nothing between (an icon and its caption), is said once, the address after it; and
a link's address goes on the line its text ends, even when that text is a block inside it.

### Maps show; builds beside the file

Card 130, from the webhook port's second pass (Candor 0.0.19). Mine:

- `Map<K, V>` is `Show` when K and V are, read as Candor writes it: `["b": 2, "a": 1]` in
  insertion order, `[:]` when empty. The assert diagrams already read maps that way.
- `candor run|build|test` builds in `.candor/` beside the file, not in the directory it was
  started from: running a scratch file from a temp dir no longer leaves its build in the
  project. Same place as before when run from the file's folder.
- Not done: a deleted module's `.candor/<module>.test` stays; `candor` can't know it's stale,
  and the folder is ignored and disposable.

### `exec.withArgv0`

Card 131, from the webhook port: the original runs a hook's command with argv[0] set to the
command as written in the hooks file. Pal's call: `Command.argv0: string?` and
`exec.withArgv0(cmd, name)`; none keeps `program`. Go sets `cmd.Args[0]`; the fake records it
with the rest of the command.

### JSON numbers keep their text

Card 132, from the webhook port: the original reads payloads with `json.Number`, so `1.50` or
`1e3` reach a hook's command as written; Candor re-rendered them (`1.5`, `1000`, and digits
past int64 as `9.223372036854776e+19`). Pal's call: keep the text beside the value, not one
`Number` variant (that would break every match on `Int`/`Float`).

- `Int { value, text: string? }`, `Float { value, text: string? }`; encoding writes `text`
  when it's there.
- Mine: `text` is kept only when it differs from how `value` writes. A decoded `12` is
  `.Int { value: 12 }` with no text, so it equals the one built in code; equality and
  patterns written before go on working. A `1.50` and a built `1.5` are not equal: they
  don't write the same.

### Go pins that agree

Card 133, from the console port: on 0.0.19 a program importing `crypto` with `mime`, `imap` or `html`
didn't build. x/crypto v0.58.0 requires x/text v0.43.0, `mime` pinned v0.42.0, and `go get`
refuses to go below what another named module requires. x/text is now v0.43.0; the other
pins were checked against each other's go.mod. `test/std-together.test.ts` builds and runs
one program with every std module that has Go dependencies, so the next clash fails there.

Found on the way: a failed `go get` left go.mod without requirements but kept the stamp of
the last good one, so going back to those pins skipped the get and the build broke for
good. The stamp is now removed first, and a build folder with a stamp but no go.sum (what a
failed get leaves) gets again, which mends folders broken by 0.0.20 and older.

### A second database file: `sql.attach`

Card 134, from the console port: its vault wanted a SQLite file of its own beside the app's, and `sql`
held one database. Pal's call: ATTACH on the one connection, with qualified names, rather than
database handles (which Postgres may want some day, and which would change every program).

- `sql.attach(source, name)`, after `sql.open`: attached on the one connection, so it stays
  for the program. In a test, a fresh database in memory, as `sql.open` leaves the test's own.
  Inside a transaction it is an `Err` (SQLite refuses, and the one connection is the
  transaction's).
- Migrations make the attached file's tables by their qualified name (`CREATE TABLE IF NOT
  EXISTS vault.secrets (...)`), and the schema check keys them so; `main.t` is `t`. A bare name
  is the main database's table, else the one attached table of that name, as SQLite looks it
  up. In a query `vault.secrets` goes by `secrets`, and `vault.secrets.col` is `secrets.col`.
  Joins across the files are checked like any other.
- Mine: `ATTACH` or `DETACH` in a query is an error pointing at `sql.attach`; by hand a test
  would attach the real file.

### Leading-dot chains

Card 135, from the open questions: agents used to Rust and TypeScript start a line with
`.mapErr(...)`, and it was an error (it caught me in card 100's docs). Pal's call: allow it.

- A line starting with `.` and a lowercase name (or `_`) continues the expression above: the
  lexer drops the newline before it, across blank and comment lines too. Variants start
  uppercase (`CAN0030`), so a match arm `.Paid => ...` or a `.Variant` value on its own line
  is unchanged; so is `..`.
- A trailing `.` still continues too. Docs show the leading form for long chains.
- `.name` where nothing comes before it (`let n = .length()`) is still the error, its help now
  "a method call goes after its object, on the same line or at the start of the next".

### Release checksums, old versions, macOS

Card 136, from the open questions of 094. Pal's calls:

- macOS: no notarizing (an Apple account, and a Mac to run it on). The README gives
  `xattr -d com.apple.quarantine candor` for a binary downloaded with a browser; the install
  script's `curl` sets no quarantine flag. No Mac here, so the macOS binaries stay cross-built
  only and the README says so.
- Old versions: candor removes them itself, so a binary copied in by hand doesn't leave folders
  behind either.

Mine:

- `bun run release` writes `dist/SHA256SUMS` (`sha256sum -c` format) for the binaries it built.
  Both install scripts fetch it, and a binary missing from it or not matching is deleted and
  nothing installed. `CANDOR_URL` fetches from another place than GitHub's latest release.
- `src/home.ts`: after a version unpacks `~/.candor/<version>/`, folders named like an older
  version (`0.0.21`, compared by number) go; `bin/`, other names and newer versions stay. A
  folder in use on Windows is left for next time. Unpacking happens on the first command that
  needs a std module or the runtime, not on `candor version`.
- Checked: windows-x64 through install.ps1 and linux-x64 through install.sh (WSL), each from a
  local server, installed and ran; a SHA256SUMS of zeros was refused with nothing installed.

### More SQL checked: subqueries, UNION, CASE, RETURNING

Card 137, from the open questions of 064, 091 and 134. Pal's calls:

- Scope: everything the open question listed but WITH, which gets its own card.
- Real programs first: `candor check` on the sound library and console ports gave no "not checked" notes,
  and their SQL has one CASE and no subqueries, UNION or RETURNING. So nothing to order by;
  the card did the whole scope.

Mine:

- A `(SELECT ...)` is lifted into one token before a query is read, so the clause around it
  sees one value, and it is checked as a query of its own with the tables around it in reach
  (a correlated subquery). A name resolves in the nearest query first, as in SQLite.
- A subquery used as a value (`= (SELECT ...)`, `IN (SELECT ...)`, in the SELECT list) must give
  one column. As a value it can be NULL when it finds no row, except an aggregate with no GROUP
  BY or HAVING (`(SELECT count(*) ...)`), which always gives one. `EXISTS (...)` is a bool.
- A subquery in FROM is a table of its columns, going by its alias.
- UNION / INTERSECT / EXCEPT: each SELECT is checked; they give as many columns (an error
  otherwise); a UNION's column is NULL if any side's is, an INTERSECT's if both are, an EXCEPT's
  as its first side. A UNION mixing a string and an int in one column is an error (reading it
  would fail on some rows); ints and floats mix as floats. ORDER BY after one names a column it
  gives, or its number.
- Comparisons, `IS`, `IN`, `LIKE`, `BETWEEN`, AND / OR / NOT type as bool (NULL if an operand
  is, but `IS`). `CASE` gives what its results share, NULL without an ELSE; `iif`, `nullif`,
  `instr`, `last_insert_rowid()`, `changes()` and `random()` are known too.
- A SELECT without FROM is now checked (`SELECT EXISTS (...)`), where it was skipped.
- RETURNING is a SELECT list on the table written. `sql.query` on an INSERT, UPDATE or DELETE
  without one is an error: it gives no rows.
- `UPDATE ... FROM` checks the other tables, and `other.col` into a column by type.
  `INSERT ... SELECT` fills the columns in order: count, type, and NULL into NOT NULL.
- Still a note: WITH (checked since card 139), NATURAL joins, table-valued functions
  (`json_each`), VALUES as a part of a compound. Tests that want the runtime's own errors now
  hide their query in a WITH (a `sql.Query` since 139).
- Found on the way: a table with no alias before WHERE took `WHERE` as its alias, so
  `rooms.id` didn't resolve. Fixed.

### Bytes through Go bindings

```
extern "encoding/hex" {
  fn Decode(dst: Bytes, src: Bytes) -> Result<int, GoError> as decode
}
```

Card 138, closing card 084's "not yet". No new choice: it follows `List<string>`.

- A `Bytes` passes to and from any Go type whose underlying type is `[]byte` (`[]byte`,
  `json.RawMessage`), through `~[]byte`, as a parameter, a result, in `Result`, `T?` and a
  package `let`.
- Copied each way (`slices.Clone`): Go may write into a slice it is given (`hex.Decode` does)
  or keep one it gave back and change it later, and a Candor `Bytes` never changes.
- The Go type reader reports `[]byte` as a kind of its own, so `candor bind` drafts `Bytes`
  where it used to skip the function.

Checked in `test/bytes-bindings.test.ts`: Go writing into its argument, and a Go package that
keeps the slice it gave back and scribbles on it, leave the Candor values as they were.

### WITH checked against the schema

```
WITH busy AS (SELECT room, count(*) AS n FROM bookings GROUP BY room)
SELECT rooms.name, coalesce(busy.n, 0) AS n FROM rooms LEFT JOIN busy ON busy.room = rooms.id
```

Card 139, split from 137. No new choice: each query a WITH names is a table, as a subquery in
FROM is (137).

- `WITH a [(cols)] AS [NOT] [MATERIALIZED] (...), b AS (...)` before a SELECT (a compound too),
  INSERT, UPDATE or DELETE, inside a subquery, and in `INSERT ... WITH ... SELECT`. Each sees
  the ones before it; its names reach its own statement only, and hide a table of that name.
- A column list renames what the query selects; a count that differs is an error.
- Recursive stays a note: `WITH RECURSIVE`, or a query that reads its own name (SQLite reads
  that as recursive without the word). A WITH query that is VALUES is a note too.
- Tests that want the runtime's own row errors used to hide their query in a WITH; they now pass
  it in as a `sql.Query`, which the check (it reads the literal in the call) doesn't see.

Checked in `test/sql-with.test.ts`, with a run.

### `xml`: a tree, read as feeds need

```
let feed = xml.parse(body)?
for item in feed.child("channel").children("item") {
  let title = item.child("title").text().trim()
  let url = item.child("enclosure").attr("url")   // string?
}
xml.document(xml.element("opml", ["version": "2.0"], [...]))
```

Card 140, for the yarr port (card 141): RSS, Atom, RDF and OPML are XML, and Candor had none.
Pal's calls: a tree with lookups, not a derived `impl Xml`; names are local names with the
namespace beside them; `parse` is lenient and `parseStrict` refuses; writing from the tree is in.
Mine:

- **One enum, `xml.Node`**: `Element { name, space, attrs, children }` or `Text { value }`, as
  `json.Value` is one enum, so children mix elements and text with no wrapping. Lookups are the
  `xml.Lookup` trait (no inherent methods): `child`, `children`, `childIn`/`childrenIn`,
  `elements`, `nodes`, `attr`/`attrIn` (a `string?`), `attrs`, `name`, `space`, and `text` (all
  the text inside, the elements' too). A missing child is an empty text node, so a chain goes
  on and ends in ""; `children(name).first()` tells missing from empty.
- **Go's encoding/xml underneath** (std/xmlgo), the tree crossing as JSON like `regex`'s matches.
  Lenient is `Strict = false` with HTML entities and charsets from the declaration (x/text, as
  `mime`), plus what feeds need that Go doesn't do: control characters dropped, invalid UTF-8
  replaced in a UTF-8 document, an unknown charset read as UTF-8, a document cut short or
  stopped by a stray closing tag kept up to there, a second root ignored. Not Go's HTML
  auto-close: it closes RSS's `<link>`, which has text, and loses every item after it.
- **Comments, processing instructions and the DOCTYPE are dropped**; CDATA is text.
- **Writing**: `xml.element(name, attrs, children)`, `xml.text`, `encode` (as is),
  `encodeIndented` (whitespace-only text left out, mixed content on one line), `document` (the
  declaration first). A parsed tree is written as read, prefixes included, so it reads back
  equal. Built in code, an element in no namespace takes its parent's (so building Atom doesn't
  repeat the namespace on every child), one with a prefix declared around it gets the prefix,
  any other declares `xmlns="..."`; an attribute in an undeclared namespace gets a made-up `ns1`.
- **The source is a string**: a body or a file's bytes as text (`b.toRawText()`), so a declared
  charset converts the bytes as they came.

Checked in `test/xml.test.ts` (RSS, Atom, leniency, charsets incl. windows-1251, writing,
round trips) and `test/std-together.test.ts`.

### Virtual tables, row values, windows, SQLite's own tables

```
CREATE VIRTUAL TABLE search USING fts5(title, content, tokenize = 'porter')
SELECT rowid, title FROM search WHERE search MATCH ${q} ORDER BY rank
SELECT id FROM items WHERE (date, id) < (SELECT date, id FROM items WHERE id = ${id})
SELECT id, row_number() OVER (PARTITION BY feed ORDER BY date DESC) AS n FROM items
SELECT user_version FROM pragma_user_version
```

Card 142, from the yarr port (141): valid SQLite the schema check refused, so yarr declared a
decoy table after its fts5 one. No design call:

- **fts5**: its columns are the arguments without `=` (options), untyped and nullable, as fts5
  stores whatever it is given; hidden beside them the column named after the table (`MATCH`),
  `rank` (a float, NULL outside a MATCH) and `rowid`. **rtree** (`rtree_i32`): an int id, float
  bounds, untyped `+aux` columns. Another module's table is a note on the queries that read it.
- **fts4 and fts3 are errors** on the migration: the runtime's SQLite (modernc) has fts5 only,
  and the migration would fail when it runs.
- **rowid**: every table has `rowid`, `_rowid_` and `oid` unless it is `WITHOUT ROWID` or a
  column takes the name. Hidden columns aren't in `*` or an INSERT without a column list.
- **Row values**: a subquery compared with `(a, b)` (or `IN`) selects as many columns.
- **Windows**: `OVER (...)`, `OVER w`, `WINDOW w AS (...)`, `FILTER (WHERE ...)`; the spec's
  words aren't columns, what it partitions and orders by are. `row_number`, `rank`,
  `dense_rank`, `ntile` are ints, `percent_rank` and `cume_dist` floats, `lag`/`lead` NULL
  without a default, `first_value`/`last_value` the column's type. An aggregate over a window
  gives a row per row, so it's neither NULL over no rows nor one row.
- **SQLite's own**: `sqlite_schema` (and `sqlite_master`), and the pragmas read as tables that
  give one value (`pragma_user_version`, `pragma_journal_mode`, ...); another pragma is a note.

Checked in `test/sql-virtual.test.ts`, with a run (MATCH, a row value, a window, a pragma).

### `candor test` over a project

```
candor test                # every file with test blocks under this folder, then a total
candor test src tools/x.candor --only parse
candor check               # every .candor file under this folder
```

Card 145, from the yarr port (141): `candor test a b` ran `a` and ignored `b`, so yarr's 15
test files were run one by one. No design call:

- `test` and `check` take any number of files and folders; none is the current folder. A
  folder means the `.candor` files under it, skipping folders starting with `.` (builds, git)
  and `node_modules`.
- A test file is one with a `test "..."` line (with `--only`, one whose name matches), so
  files without tests aren't built. Each file builds and runs on its own, under `== file`, and
  a total line ends it (`--json`: a `total` line after each file's lines); it fails if any file
  failed, compile errors included. `check` prints only diagnostics and one line.
- One file still works as before; `file:line` and `--out` are for one file, and every other
  command now refuses a second file instead of ignoring it.

Checked in `test/cli-many.test.ts`; on yarr, `candor test` runs 166 tests in 15 files.

### No SQL functions from Candor, for now

Card 147, from the yarr port (141): yarr's triggers call `strip_html(new.content)`, a Go
function registered on the SQLite connection, to fill its search index. Candor can't register
one, so the port fills the index from Candor code beside each write.

Pal's call: not now (reversed by #b29bfb64, "SQL functions written in Candor"). Logic stays in Candor, where it is typed, tested with fakes and seen by
the reader of the code, not in triggers calling into it. The cost: a database whose triggers
call such a function (one made by Go yarr) can't be written by the port. Revisit if another
port needs it; the shape would be `sql.function(name, f)` before `sql.open`, pure functions
only, known to the SQL check.

### A column type SQLite reads as a number is an error

```
sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, guid string NOT NULL)")
// error: `guid string`: SQLite reads string as NUMERIC, so text that looks like a number
//        ("50") is stored and read back as one
//   help: write `guid TEXT` for text
```

Card 143, from the yarr port (141): SQLite gives a declared type TEXT affinity only if it has
TEXT, CHAR or CLOB in it; `string`, `json`, `uuid` get NUMERIC, so a guid "50" became the
integer 50 and a read into a `string` failed at run time. yarr cast every read.

Pal's call: an error on the migration, with help to write TEXT. Not a warning (easy to miss),
and not typing the column as numeric (the error would land on a query, far from the cause).
Names meant as numbers or dates (NUMERIC, DECIMAL, NUMBER, DATE, DATETIME, TIMESTAMP, TIME,
MONEY, ANY) and Candor's BOOLEAN pass; so does a column with no type. CREATE TABLE and ALTER
TABLE ... ADD COLUMN are both checked.

Checked in `test/sql-affinity.test.ts`.

### `xml`: own text, inner XML, lenient written down

```
item.child("title").ownText()            // its own text, not its elements'
entry.child("content").innerXml()        // `<div xmlns="...">Hi <b>there</b></div>`
```

Card 149, from the yarr port's second pass (141), which moved its feed parser onto `xml`:

- **Lenient stays as it is** (Pal's call): a document cut short gives the elements read so far
  and a stray closing tag ends it, where Go's encoding/xml errors. A feed whose download broke
  off shows its first items instead of failing its refresh. The module's docs now say so.
- **`ownText()`**: the text children only; RSS reads an element's own character data.
- **`innerXml()` is written from the tree**, not cut from the source: what is between the tags,
  as `encode` writes it. The same XML, not the same bytes (CDATA as escaped text, entities as
  characters). Keeping the source would put a field on `Node.Element` and break code that
  builds elements; yarr's Atom xhtml content reads the same either way.
- **Text escapes only `&`, `<`, `>`** when written; quotes stay as they are (`it's`), as most
  writers do. Attribute values still escape both quotes; `xml.escape` is unchanged.
- The default namespace was already the `space` of unprefixed elements; the docs now say so.
  Asking which charset a document was read as, or decoding bytes by charset, goes with card
  146 (decoding: card 151).

Checked in `test/xml.test.ts`.

### `embed`: files built into the program

```
test "parses a feed" {
  let feed = embed("testdata/feed.xml")          // string: the file must be UTF-8
  let logo = embed<Bytes>("testdata/logo.png")   // any file
}
```

Card 144, from the yarr port (141): a test's `fs` is an empty fake, so tests couldn't read the
fixtures next to them, and yarr generated test files with 29 feeds pasted in as strings.

Pal's call: embedding at build time, for tests and apps alike, not a fake seeded from a folder.
Mine:

- **A built-in function**, `embed(path)`, a `string`; `embed<Bytes>(path)` for any file. A type
  argument says which, as `sql.query<T>` does; a file that isn't UTF-8 as a string is an error
  whose help writes the `Bytes` form. A program's own function named `embed` wins.
- **The path is a string literal**, relative to the file that names it (as imports are), read
  as the program compiles: a missing file or a folder is an error (CAN0062). No folders or
  globs yet; one call per file.
- **Go's //go:embed underneath**: each file is copied into the build (`embed/N`) and becomes a
  package variable, so main.go stays small and Go keeps the bytes out of the code. The same
  file embedded twice is one variable. No effect: the content can't change while it runs.

Checked in `test/embed.test.ts`, with a run (a test fixture, bytes, a module embedding a file
next to itself).

### Small papercuts from yarr: empty literals, block comments, `!`, `T??`

```
let items = if ok { parsed } else { [] }     // [] is a List<Item>, from the other branch
let a = m["k"]                               // on a Map<string, int?>: an int?, not int??
let b = get(v) ?? none                       // a generic fn of the program with T = int?
```

Card 148, from the yarr port (141). Pal's calls:

- **`T??` is `T?` in the built-ins**: `m[k]`, `xs[i]`, `first`/`last`, `pop`, `m.remove`,
  `r.ok()` and `random.pick` on an item that is itself a `U?` give a `U?`. "Missing" and "present
  but `none`" are the same `none` there, which is what every port wanted; `m.has(k)` still tells
  them apart. Not `recv` on a channel of `T?`: its `none` means closed, and a sent `none` must
  stay a value. A generic function of the program can still give `int??` (flattening there
  means converting Go's `opt__[opt__[T]]` at each call and copying lists of them); the error
  says so, and `x ?? none` flattens one, which it now does for any `T??`.
- **`/* */` is an error** whose help says to write `//` on each line, not a second comment form.

Mine:

- **An empty `[]` or `[:]` in a branch** of an `if` or `match` used as a value takes its type
  from the other branches; all of them empty is one error, on the first. `[]` also goes where
  a `List<T>?` is expected.
- **`x!`**: the parse error gets help naming `?? 0`, `if x == none`, `match` and `?`.

Checked in `test/yarr-papercuts.test.ts`, with a run.

### `url`: parse, resolve, query strings

```
url.resolve(pageUrl, href) ?? ""            // "../feed.xml", "//cdn/x.png", "?page=2"
match url.parse(link) { none => ..., u => u.host }
url.query("a=1&a=2")["a"]                   // ["1", "2"]
"${base}?${url.encodeQuery(["q": [term]])}"
```

Card 150, split from 146 (Pal's yes); the choices were mine. yarr wrote its own resolver
(~200 lines) for feed, page and enclosure links.

- **A module, `url`**, not functions in `http`: feeds, mail and `mailto:` links are URLs too.
  Importing it takes the name `url`, which programs use for variables; the no-shadowing error
  already says `import "url" as u`, and the module header says it.
- **`parse` gives `Url?`**, not a Result: why a URL doesn't parse is rarely worth reading. A
  relative URL parses (scheme and host empty). `host` without the port or IPv6 brackets, `port:
  int?`, `path` and `fragment` decoded, `query` as written, since `url.query` reads it; an
  opaque `mailto:x` keeps `x` as its path. `url.format(u)` writes one back, so a changed copy
  (`Url { ...u, path }`) makes a URL.
- **`resolve(base, ref) -> string?`** is Go's `ResolveReference`, strings in and out: what
  callers have is strings.
- **Query strings keep their order**: `url.query` gives `Map<string, List<string>>` in the
  order the keys came (Go's `ParseQuery` loses it), a bad escape kept as written rather than
  failing; `encodeQuery` writes in the map's order (Go's sorts).
- **Escaping** in two pairs, as Go has it: `encode`/`decode` for a query key or value (`+` is a
  space), `encodePath`/`decodePath` for a path segment.

`http` keeps its own private resolver for redirects. Checked in `test/url.test.ts`.

### Charsets: `bytes.decode`, `bytes.encode`, `xml.parseWith`

```
bytes.decode(res.body.toBytes(), "windows-1251") ?? res.body
bytes.encode("café", "iso-8859-1")           // Bytes?: none if a character doesn't fit
bytes.charset("latin1")                         // "windows-1252"
xml.parseWith(body, charset)                    // the header's charset over the declaration's
```

Card 151, split from 146 (Pal's yes); the choices were mine. yarr wrote windows-1251, -1252
and ISO-8859-1 tables by hand, and pushed a header's charset into the XML declaration.

- **In `bytes`**, not a module of its own: it is bytes to text and back. x/text, which `mime`
  and `xml` already use, by the WHATWG labels (`htmlindex`), any case: what a Content-Type
  header or an HTML `<meta>` says goes in as it came.
- **`decode` is `string?`**, none only for a charset it doesn't know; bytes the charset doesn't
  allow are U+FFFD, as browsers read them. Like browsers, "iso-8859-1" and "ascii" are read as
  windows-1252.
- **`encode` is `Bytes?`**, none also when a character doesn't fit the charset, rather than a
  silent `?`: a program that wants the substitute can map first.
- **`bytes.charset(label)`** gives the canonical name, or none: to check a label before using it.
- **`xml.parseWith(source, charset)`**: lenient `parse`, the text decoded from `charset` first
  and the declaration's ignored. A charset it doesn't know is passed over, the declaration's
  read, since a header's charset is often wrong anyway. No strict form; add one if asked.

Checked in `test/charset.test.ts` (windows-1251, koi8-r, shift_jis, utf-16le, round trips in
gbk, big5, euc-kr, euc-jp; xml under a wrong declaration).

### Gzip: `serve` sends it, the client reads it, `bytes.gzip`

```
bytes.gzip(b)                    // Bytes
bytes.gunzip(b)                  // Bytes?: none if it isn't gzip
http.ServeOptions { gzip: false } // on unless turned off
```

Card 152, split from 146 (Pal's yes). yarr's responses went out uncompressed where the
original gzips them; a gzipped feed body needed reading.

- **`serve` gzips by itself** (Pal: automatic, over an option or a per-response helper): for a
  client whose `accept-encoding` takes gzip (named or `*`, not `q=0`), a text-like type (text/*
  but not an event stream, JSON, JavaScript, XML and `+xml`/`+json`, SVG, wasm), a body not
  known to be under 1 KiB, a status that has a body (not 206, 304, 204), and no
  `content-encoding` from the handler. `vary: Accept-Encoding` goes on every text-like answer.
  Streamed bodies are gzipped too, flushed a piece at a time; files from `serveFile` too, but a
  range answer isn't. `ServeOptions.gzip: false` turns it off.
- **`http.served(req, res)` shows it**, so a test sees what `serve` sends: the same Go decides.
- **The client always un-gzips** (Pal): Go's transport does when it asked for gzip itself; when
  the request set `accept-encoding` itself, the runtime does. Either way `res.body` is the
  content and `content-encoding` is gone. The 16 MiB limit is on the un-gzipped body. The fake
  client un-gzips a canned or handled response marked gzip the same way.
- **In `bytes`** (Pal), next to the charsets: `gzip`, `gunzip`. No level or streaming; gunzip
  has no size limit, so its doc says to check what comes from outside.

Checked in `test/gzip.test.ts` (round trips, `served` for text, tiny, binary, pre-encoded,
event stream, stream, file, range; the fake client; a real server and client) and
`runtime/go/http_test.go` (what a raw Go client gets for each `accept-encoding`).

### Time zones and layouts: `time.zone`, `time.parseLayout`

```
let oslo = time.zone("Europe/Oslo") ?? time.utcZone()   // Zone?: none for an unknown name
time.partsIn(t, oslo); time.formatIn(t, oslo); time.offsetIn(t, oslo)
time.inZone(oslo, 2026, 10, 28, 9, 0, 0)                // Result<int, string>
time.startOfDayIn(t, oslo); time.addDaysIn(t, 1, oslo); time.daysBetweenIn(a, b, oslo)
time.parseLayout("Tue, 27 Oct 2026 09:00:00 EST", "Mon, 02 Jan 2006 15:04:05 MST")
time.parseLayoutIn(text, layout, oslo); time.formatLayout(t, layout, oslo)
```

Card 153, split from 146 (Pal's yes). yarr's feed dates with `EST` or `CET` counted as UTC,
wrong by hours (Go's own `time.Parse` does the same unless the machine is on that zone), and it
carried an 831-line interpreter of Go's layout language to read them.

- **A `Zone` value** (Pal, over a name string on every call): `time.zone(name)` checks the name
  once and gives `none` for an unknown one, so the `...In` functions can't fail. It crosses to
  Go as its name; Go caches the loaded location. The zone database is built into every program
  that imports `time` (`time/tzdata`, about 450 KB), so a name means the same on any machine.
  The machine's own zone (`Local`) isn't offered: it would make pure functions depend on where
  they run; the zone is named in config.
- **Daylight saving**: `inZone` is an `Err` for a time the clocks skip, and the earlier reading
  of one they show twice (Go's `time.Date` doesn't say which; it gave the later). `addDaysIn`
  keeps the clock time, so a day is 23 or 25 hours across a change; `startOfDayIn` and
  `daysBetweenIn` count that zone's midnights. `time.parts(t)` is now `partsIn(t, utcZone())`.
- **Go's layouts** (Pal, over a loose parser or both): AI coders know them, and yarr's list of
  layouts from the original works unchanged. `parseLayout` reads a time with no zone as UTC,
  `parseLayoutIn` on a zone's clocks; `formatLayout` always takes a zone.
- **Zone abbreviations from a fixed table** (Pal: US first, unknown is an error): about 60 common
  ones at fixed offsets, CST as US Central, IST as India, BST as British Summer Time. One the
  table lacks is an `Err` saying to give an offset, not UTC. An abbreviation the zone itself
  uses (`EDT` read in New York) takes the zone's offset. `GMT+2` is two hours ahead (Go kept its
  clock time as UTC).

Checked in `test/timezone.test.ts` (names, Oslo and New York offsets winter and summer, skipped
and repeated hours, a 25-hour day, layouts with EST, PDT, CET, IST, GMT, GMT+2, an unknown
abbreviation, a date alone, `parseLayoutIn`, `formatLayout`). yarr's `src/dates.candor` on a
branch (the yarr port's `time-zones`): 831 lines to 249, nearly all of it the layout list; its
dates tests and feed tests pass, now with EST at -05:00.

### Reading zips: `bytes.unzip`

```
let files = bytes.unzip(attachment, 10_000_000)?   // List<bytes.ZipEntry>: name, size, data
```

Card 160, for the console port's DMARC reports (Google sends a .zip of one XML file). Pal's calls: in
`bytes` beside gzip, a `Result` whose `Err` says why; the cap on inflated size is a required
argument, so the caller always says it.

- Read only, from Bytes in memory, through Go's archive/zip: the central directory, so an entry
  with a data descriptor (flag bit 3, its local header's CRC and sizes zero) reads right.
- Stored and deflate only; another method is an `Err` naming it ("method 12 (bzip2)"), as is an
  encrypted entry. zip64 is read (Go does), not refused: the card asked for an error, but the
  bytes come out right, which was the point of refusing.
- Each entry is checked against its CRC-32. The cap counts the bytes inflated, not the headers'
  sizes, over all entries together.
- Folder entries are left out; a name keeps its folders ("reports/a.txt").
- No writing: nothing asked for it.

Checked in `test/zip.test.ts` against fixtures made by real tools (test/fixtures/zip: bsdtar
with a data descriptor, Compress-Archive, Python's zipfile), a flipped data byte, a cut archive,
bzip2, the encrypted flag, and 2 MB of zeros in 2 KB.

### HTML as a tree: `html.parse`, `parseFragment`, `encode`

```
let page = html.parse(body)                      // xml.Node: <html> with head and body
let feeds = page.child("head").children("link").filter((l) => l.attr("rel") == "alternate")
let nodes = html.parseFragment(item.content)     // List<xml.Node>
html.encodeAll(nodes)                            // HTML again
```

Card 154, split from 146: yarr wrote its own tokenizer, tree builder and renderer
(markup.candor, 575 lines) for its sanitizer and feed finder. Pal's calls:

- The tree is `xml.Node`, read with `xml.Lookup`: one tree type and one set of lookups for
  both. HTML elements have the space ""; SVG and MathML (and xlink:/xml: attributes) their
  namespace URL, as xml gives them.
- Both entry points: `parse` for a page (head and body built as a browser builds them),
  `parseFragment` for what goes in a body. Neither fails, so neither is a `Result`.
- `encode` writes HTML as Go's html.Render does; comments and the DOCTYPE are left out of the
  tree, as in xml, so no third `Node` variant.

Small choices: x/net/html (already behind `toText`) does the reading and writing, the tree
crossing as JSON as xml's does; void elements come out `<br/>`, as Render writes them; a void
element given children in code is followed by them (Render refuses one), as a browser reads
`<br>x`; `encodeAll` joins a fragment. Checked in `test/html-tree.test.ts`, with a small
sanitizer. Not tried on yarr yet: `parseFragment` and `encodeAll` stand in for its tokenizer,
tree builder and renderer (about 500 of markup.candor's lines); its node search and text
helpers would stay, written on `xml.Lookup`. Writing it, `List.flatMap` was missing (a loop
of `concat` instead).

### `req.headers["host"]` (card 155)

Go's server moves Host (HTTP/2's `:authority`) out of `r.Header` into `r.Host`, so `serve` left
it out of `req.headers` and a server couldn't check the name it was reached by (the console port's MCP
endpoint wanted `localhost` or `127.0.0.1` against DNS rebinding).

Pal's call: put it back in the headers, not a `host` field. Nothing new to learn, a test's fake
request sets it as any header (`headers: ["host": "localhost"]`), and `http.headerAll` sees it.
Small choice: it is as sent, port and all; checked in `test/http.test.ts`, served and faked.

### `sql.attach` again is Ok (card 156)

A test's in-memory database lives for the whole test, and `sql.open` in a test already leaves
it as it is; but a second `sql.attach` of the same name failed (SQLite's "database vault is
already in use"), so a test couldn't simulate a restart. The console port split its vault's `attach` from
its `prepare` to get around it.

Pal's call: attaching the same source as the same name again is Ok and changes nothing (the
data stays), in tests and programs alike; no `sql.detach`. The name given another file is an
`Err`: "vault is attached already, to \<file>: one name, one file".

Small choices: names compare as SQLite does, ignoring case; a file source compares by its
absolute path (`./vault.db` is `vault.db`), `:memory:` and `file:` URIs as written. Checked in
`test/sql-attach.test.ts`.

### `candor build --target` (card 157)

The console port deploys to a Linux server from Windows: GOOS, GOARCH and CGO_ENABLED in the environment
cross-compiled, as Go does, but the binary kept Windows' `.exe` name, renamed on install.

Picked (small, per the card): `--target` with the release script's names, plus `windows-arm64`:
windows-x64, windows-arm64, linux-x64, linux-arm64, darwin-x64, darwin-arm64. It sets GOOS and
GOARCH with cgo off (SQLite is modernc's, pure Go), and names the binary for the system: `.exe`
only for Windows. Only `build` takes it; run, test and debug refuse it, since they run the
binary here. A GOOS set in the environment without `--target` names the binary by it too.
Checked in `test/build-target.test.ts` by the binaries' magic numbers (ELF, Mach-O, MZ).

### `continue` and `break` as arms (card 158)

`let v = match r { Ok(v) => v, Err(_) => continue }` was CAN0023 (arms int and void): `return`
counted as leaving an arm, `continue` and `break` didn't. The console port wrote `.ok()`, a none check
and a `continue` instead.

Picked (a fix, no new syntax): a block ending in `break` or `continue` diverges as one ending in
`return` does, for match arms and if branches, in a `let` or anywhere an expression goes (an
argument, after `&&`, in interpolation). The emitter already lowers a value `match`/`if` to
statements in the loop's own body, so Go's `continue` and `break` reach the loop; `break` from
an enum's arm leaves the loop, not a Go `switch`. Outside a loop they are still CAN0038; when
every arm leaves, the error says "returns, breaks or continues". `x ?? continue` stays
unwritten: `??` takes an expression, and `return` isn't one there either. Checked in
`test/loop-arms.test.ts`.

### `trimStart`, `trimEnd`, `removePrefix`, `removeSuffix`, `reversed` (card 159)

The console port reached for `trimEnd(suffix)` and `xs.reversed()`; neither was there.

Pal's calls: text goes by `removePrefix(p)` / `removeSuffix(s)` (Kotlin's names): a `string`,
removed once, unchanged when absent. `trimStart()` / `trimEnd()` take nothing and remove
whitespace at one end, as in JavaScript, beside `trim()`. A trim given an argument is an error
whose help names `removePrefix` or `removeSuffix`. `xs.reversed()` is a copy, last item first.
`strip*`, `lstrip`, `rstrip`, `trimLeft`, `trimRight` and a string's `reverse` get the Candor
name in their help.

### An empty start takes its type from an annotated lambda parameter (card 161)

The console port wrote `xs.fold([], (acc: List<Report>, x) => ...)` and got CAN0032: the `[]` was typed
before the lambda, whose annotation says exactly what it holds.

Picked: `fold`'s `[]`, `[:]` or `none` start takes the type annotated on the lambda's first
parameter. The same for a generic function's empty argument (`[]`, `[:]`, `none`, `Ok(...)`): a
lambda argument's annotated parameters fix the type parameters they mention before it is checked.
Without an annotation it stays CAN0032; inside `fold` the help now says to annotate `acc`. A
broken annotation is reported once, by the lambda.

### Ready to show: private names out, Kimi dropped

Before the repo goes public, Pal's calls: this log keeps his calls but not his private apps, so
the ports that drove cards are "the console port" and "the sound library port"; samples use
reserved domains (`example.org`) and sample names, not his. Kimi Code is no longer used: the
trial runners have one agent, headless Claude Code; card 093's Kimi runs stay as history.

### Builds in a cache, out of the project (card 162)

Pal found `.candor/` folders in every folder he had compiled in: 16 under his code folder,
463 MB in this repo's own (old trial builds). His calls: builds go to a user cache, as Go's do,
and `candor build`'s binary goes beside the file, as `go build`'s does.

- `run`, `test`, `debug`, `check` (with bindings) and `build` work in
  `~/.candor/cache/<folder>-<hash>/<module>` (`<module>.test` for tests): one entry per source
  folder, named for it and a hash of its full path, so two `app` modules in different folders
  don't share a build. `CANDOR_CACHE` moves the cache; the tests use one in the temp folder.
- A module's build unused for 30 days is deleted, looked at once a day, on a build. Each build
  touches its `.used` file; a folder in use (Windows) is left for next time.
- `candor build` writes `<module>` (`.exe` for Windows) beside the source file and prints its
  path; `-o <file>` names it. A folder in the way is an error saying to use `-o`, where Go
  would quietly put the binary inside it.
- `--out <dir>` still builds there, binary included, as before.
- `candor init`'s `.gitignore` names the binary (`/<module>`, `/<module>.exe`) instead of
  `.candor/`.
- Not done: the old `.candor/` folders aren't removed; they are disposable. A deploy that took
  `.candor/<module>/<module>` now finds the binary beside the source.

### The front page for strangers

Pal's calls for the public README:

- A short "Why": five bullets (effects in the signature, errors as values, fakes built in,
  errors that carry their fix, one Go binary). The full argument is the site's.
- Status: 0.0.x changes between releases; a breaking change comes with a compiler error whose
  help says the fix, and is listed in the release notes. The real compatibility promise is
  still open (below).
- Issues welcome (version, smallest file, output); pull requests not taken yet while the design
  settles, said in the README and at the top of CONTRIBUTING.md. No issue templates.
- Licenses: MIT OR Apache-2.0, both files, "The Candor Authors".

### No `${}` in a pragma (card 170)

A `${}` in a query is a bound parameter, and SQLite takes none in a pragma: `sql.exec("PRAGMA
user_version = ${v}")` passed `candor check` and failed at run time with `near "?": syntax
error`. The yarr port hit it. Now it is CAN0056 at check time, help: write the value in the
text, e.g. a `match` over the versions. Splicing the value in instead was ruled out: keeping
values out of the SQL text is what the parameter rule is for. Small choice: CAN0056 like
ATTACH, not a new code. Checked in `test/sql-virtual.test.ts`.

### The change trial leaves the repo (card #11976b02)

The trial that counts (Pal, 2026-10-28) is an agent changing an existing codebase, in its Go
original and its Candor port: ntfy, webhook and supercronic, each with a feature, a planted bug,
a visible change and a refactor. Pal's call: it stays private, not in this repo, now or when the
repo goes public: the Go is third-party, the ports are unreviewed, and hidden tests and
references in public would end up in training data. Public later stays possible; public now
couldn't be undone. `trials/ntfy/` (card 049) and its runs moved out; this repo keeps
`harness.ts` and `agent.ts`, which its runner uses, and the figures (numbers.json,
docs/trials.md).

What the runner adds over card 049's: any app (`app.json`), each request's kind, a shape check
for refactors, and reading cost: tokens and model calls before the first edit to the code. An
edit is Edit/Write or a Bash command that writes a file (agents edit with `sed -i`, python and
redirects as often as with Edit), log.md aside. Small choices: ntfy's Candor references are the
diffs of the sonnet runs that passed everything; `tools/plant-errors.ts` loses ntfy's port as a
corpus.

### The change trial's figures (card #cda9a398)

78 runs on sonnet, Candor 0.0.29 (2026-10-29): 13 requests, Go and Candor, three each. The
change repo's `run.ts report --since <time> --json` writes summary.json from those runs only
(earlier ones stay out); `bun run numbers` copies it into numbers.json's `change` and rewrites
docs/trials.md's change block, which `test/numbers.test.ts` checks against it. App descriptions,
request one-liners and catches are written by hand in numbers.json. Codebase lines are non-blank
lines without tests (Go `_test.go`, Candor `test` blocks).

What came out: 36/39 Go runs and 38/39 Candor runs passed; no run broke a shared test. Candor
read more before its first edit (median 46k against 39k tokens) and used more tokens (185k
against 164k) but fewer turns (9 against 12) and compiler runs (4 against 8). The gap is
uneven: ntfy's topic-limits read 187k against 75k, webhook's max-concurrent 92k against 30k
(two of its three Go runs never called the limit they wrote), and Candor read less on three
requests. One shape check was corrected after the runs: priority-type failed a Candor function
converting the type to its wire number, which Go has as `int(p)`; both checks allow such a
conversion now and that run was rescored.

### Context at the first edit, and docs/agent.md (card #f4df4655)

The reading figure summed every model call's whole input before the first edit, so whatever
was read early counted again on every later call. The change trial now reports the context the
first edit was made in (that call's whole input, cache included) beside the sum; docs/trials.md
shows it. Over the 78 runs: Go 14k, Candor 20k (the sums were 39k and 46k).

`candor guide` now prints docs/agent.md (Pal, 2026-10-29): one short page, ~3k tokens, for an
agent reading and changing Candor: Go next to Candor, optionals and Results, effects,
concurrency, tests and the CLI, a map of std. `candor guide start` prints start.md, the long
guide. It is the one text every agent integration points at (the skill, `candor init`'s
AGENTS.md, later Copilot and Gemini: Tooling #0ead72a3). The change trial's prompt starts
agents on it. Its blocks compile (test/start.test.ts); test/guide.test.ts keeps it under 16k
characters.

Six re-runs on Candor of the two requests with the widest gap (ntfy topic-limits, webhook
max-concurrent; 3 each, sonnet) all passed, read agent.md and not start.md, and cost a steady
~14k characters of docs. Context didn't drop: topic-limits 42k (was 39k), max-concurrent 28k
(was 25k). Splitting each run's reads before its first edit into docs and code showed docs
were never most of the gap: the earlier runs read 5–20k characters of start.md (one 67k), and
Candor runs read 1.5–2x the code characters Go runs did. The Candor ports keep code and tests
in a few large files (webhook.candor 78 KB, ntfy's app.candor 56 KB), which agents `cat` whole;
Go's tests sit in `_test.go` files an agent passes over. Kept agent.md all the same: it costs
less and the same every run, and nothing failed.

### `candor outline` (card #917237b1)

`candor outline [files or dirs]` (Pal's pick of four, 2026-10-29) prints each file's
declarations without their bodies: types with all their fields or variants, function
signatures (`uses` and contracts included), impls, effects and fakes with their operations,
externs, consts cut at 100 characters. Each has its line range, so an agent reads only the
lines it needs. Tests and `test fn`s are counted, with the lines they span; `--tests` lists them
in place. With no file, every `.candor` file under the folder, as `check` takes them. It parses
and doesn't check: a file that doesn't type-check still outlines. webhook.candor: 78k
characters, outline 6k; all of ntfy's Candor, 110k and 23k. agent.md now says to outline
before reading, not to read the module you're changing; the checklist, AGENTS.md and the skill
say the same, and the change trial's prompt names the command.

Six re-runs of the same two requests (Candor, sonnet, 3 each, $1.45): all passed, every one ran
`outline` first and then read by line range. Context at the first edit didn't drop:
topic-limits 40k, 47k, 50k (was 38–43k; Go 27k), max-concurrent 25k, 27k, 26k (was 23–28k; Go
14k). Code characters read before the first edit: topic-limits 62–72k, max-concurrent 21–25k,
the same as before. The agents traded whole files for an outline (ntfy's is 23k characters,
read whole) plus wide ranges (100–150 lines each), and they read tests on purpose, as examples
(`sed -n 1745,1818p app.candor`). Kept: it is how they navigated, and it costs nothing when
unused. The gap isn't how the code is laid out but how much of it an agent wants to see before
it trusts itself in a language it wasn't trained on; Go agents know the idioms and look less.

### The same-spec trial on sonnet (card #71862927)

The trial that writes an app from a spec ran again on sonnet (Pal, 2026-10-29), one run per app
and language, Candor 0.0.29: its only figures were Kimi's from 2026-10-26 on Candor 0.0.1.
trials/run.ts copies docs/agent.md and starts the Candor prompt on it, records context at the
first file written (`reading`, now in trials/agent.ts for both runners), works under
a temp directory outside the repo (`CANDOR_TRIALS_TMP`) and removes each directory once the run is kept, stopping anything left
running from it. `bun run numbers` renders docs/trials.md's same-spec block from numbers.json,
as it does the change block; test/numbers.test.ts checks it.

All 12 passed every acceptance test ($2.70). Context at the first file written: Go 9–10k,
Candor 22–31k; tokens in all 3–5x. Before writing, Candor runs read agent.md, two sections of
start.md and often std/http.candor (30–45k characters); Go runs read the spec. So writing from
nothing, the gap is the docs, where changing a codebase it was the code (#917237b1). agent.md
has no whole service, which sends agents to start.md and std/http.candor: a short HTTP + SQL
skeleton in it may save the trip.

### Other agents on the change trial (card #1653f322)

Is Candor's reading gap Claude's or the language's? supercronic's four change requests ran once
per language on Claude Code with Opus (Pal's addition) and on Antigravity (`agy`, Google's
Gemini 4 Argon) beside sonnet's change-trial runs. Kimi is parked (#5a966254): two vendors
already answer the question. trials/agent.ts gains an `agy`
agent: headless `agy -p` with stream-json, an allowlist of its file and shell tools passed with
`--settings` (its rules take an exact path or `*`, probed: no path globs), its sandbox and a
45-minute limit. `reading()` now takes the agent, which lists its model calls in order (each one's
usage, and whether it edits); Claude's figures came out identical. agy reports no cost. The change
runner's `compare` writes compare-summary.json from compare.json (agent, model, run window);
`bun run numbers` renders docs/trials.md's other-agents block.

All 16 new runs passed everything. Context at the first edit, Go / Candor medians: sonnet 13k /
18k, Opus 15k / 26k, Gemini 42k / 66k. Every agent reads more before changing Candor (1.4–1.7x),
so the gap holds across models and vendors: it's the language and its docs, not Claude. Gemini
reads about 3x Claude in both languages. Tokens in all widen most (about 3x for Opus and Gemini),
from longer Candor runs: more turns and compiler runs.

### Docs rounds: a lean agent.md and a shorter outline (card #7de8b2de)

Rounds of one change each, Candor only on sonnet, 3 runs each of the four widest-gap requests
(ntfy topic-limits, webhook max-concurrent, supercronic options-struct and job-names). Measured:
context at the first edit, and what was read before it split into docs, code and tests (the
change repo's `rounds.ts`). Round 0 showed every run reads agent.md whole (12k characters,
~3.5k tokens) and no other doc: on supercronic that was most of the gap to Go.

- **agent.md halved** (12k to 6k characters): what changing code needs (the loop, Go next to
  Candor, what trips a Go reader, optionals and `?`, effects, common changes). Concurrency, tests
  and the std map moved to `docs/agent-more.md`, `candor guide more`: still one shared text, in
  two parts (Pal's #f4df4655 call stands). The max-concurrent runs read the second part for
  Mutex, as meant. `guide.test.ts` holds the guide under 10k characters.
- **`candor outline` shows a private function by name only**; types, pub signatures and every
  line range stay. `--full` gives every signature. ntfy's outline: 23k to 17k characters.
- **Worked examples of common changes** in agent.md (Pal: all three, then combinations). The
  first set had a per-key limit, close to two of the four requests themselves; it cut only
  topic-limits. Pal kept generic ones (an optional field, a new variant, a route): neutral.

| Round | topic-limits | max-concurrent | options-struct | job-names | Sum |
|---|---:|---:|---:|---:|---:|
| 0: baseline | 42k | 26k | 22k | 18k | 108k |
| 1: lean agent.md | 39k | 23k | 19k | 17k | 98k |
| 2: + short outline | 38k | 20k | 19k | 17k | 94k |
| 3: + examples (per-key limit) | 34k | 22k | 19k | 17k | 92k |
| 4: + generic examples (kept) | 34k | 22k | 21k | 17k | 94k |
| Go (the change trial) | 27k | 14k | 13k | 13k | 67k |

Medians of 3 runs; all 60 passed. The gap to Go went from 41k to 27k, about a third. The rest is
code: Candor runs still read more of the code around the change than Go runs do, and no doc
change reached that.

### Both trials' Candor side run again on the shorter guide (card #34593426)

Candor's 39 change runs and 6 same-spec runs were run again on 2026-10-29 evening; Go's stay,
since Go doesn't read Candor's docs. The change repo's `report` takes Candor's runs from a window
of their own (`--candor-since`). The change trial's median context at the first edit went from
20k to 17k (Go 14k), tokens in all from 185k to 155k (Go 164k), cost from $5.62 to $4.79; 37 of
39 passed (one acl-bug miss as before, one shared test lost to a likely timeout, kept counted).
Same-spec hardly moved (21k to 35k, as before): writing a whole app, runs read both parts of the
guide. The other-agents table keeps sonnet's earlier runs, on the docs Opus and Gemini had.

### Tests in their own file: `x_test.candor` (card #240e482c)

Pal's call: a module's tests go in `x_test.candor` beside `x.candor`, by name (Go's rule, not a
header line), and only there. Inline tests had a port's code and tests in one big file, which
agents read whole before an edit.

- The test file starts with the same `module x` line and is part of module x: it sees x's
  private names and its imports, and may import more, and hold helpers, types and consts for
  its tests. A different module line is CAN0063.
- `candor test` and `candor check` read it with the module; `build`, `run`, `emit` and an
  importing module never do. So a name only the test file declares is unknown to a build.
- A `test` block or a private `test fn` in `x.candor` is CAN0063, with the file it goes in. A
  `pub test fn` may stay there: it is for other modules' tests, which never read x's test file.
- How: the test file is lexed with its lines numbered on from the module's last, its imports
  and declarations added to the module, so the checker and emitter see one module with one set
  of spans. Diagnostics, `//line` directives, assert lines and the runner's file name turn
  lines past the module's back into the test file's.
- CLI: `candor test x_test.candor[:line]` is x.candor's run, the line one of the test file's.
  Folder runs take a test file with its module (one with no module is refused). `candor
  outline x_test.candor` lists its tests; x.candor's outline says how many it has.
- Moved: examples (19), test fixtures in test/fixtures, the docs' blocks (a block starting `//
  x_test.candor` is the test file of the block before it), `candor init`'s project, the
  same-spec references and prompt, card 040's bookings. The compiler's own test fixtures stay
  written whole, tests below the code, and `test/split.ts` splits them as a project has them.
- The ports and the change-trial codebases moved too (candortests). buntdb's and yarr's sibling
  test modules (`module x_test`, importing x) became x's test files: names unqualified, and
  helpers renamed where they clashed with x's names (`desc`, `count`, `item`, `baseUrl`, ...).
  Plants and references were regenerated as patches against the split codebases.
- Tests: test/testing.test.ts ("test files"), test/outline.test.ts.
- Re-runs (Candor, sonnet, 3 each, 2026-10-29, all passed): context at the first edit,
  topic-limits 33/35/37k (37k median with inline tests, same docs; Go 27k), max-concurrent
  21/19/19k (was 21k; Go 14k). About 2k less on each, within the spread of three runs. Code
  read before the first edit fell (topic-limits 38-49k chars to 29-40k), but runs still open
  the test file on purpose, as examples (6-14k chars). It tidies the codebase; it doesn't
  close the gap.

### Program code doesn't see the test-only names (card #79ce004a)

Pal's call, on the open question #240e482c left (and card 171's `test fn file()` against a local
`file`, from the webhook port): a name only tests can see doesn't block program code.

- Test-only names: what x_test.candor declares (functions, types, consts) and every `test fn`.
- In program code (x.candor's functions, methods, effect and fake bodies, consts), a local may
  take one of those names. It is no shadowing there: program code never sees the other.
- Test code (tests, test fns, anything in x_test.candor) sees both, so the rule holds as
  before: a local there can't reuse a function's name, from either file.
- Program code naming a function or const of the test file is CAN0063 at check time, "`limit` is
  declared in x_test.candor, which `candor build` doesn't read", help: move it into x.candor.
  Before, `check` passed and `build` failed. A test file's type named in program code still only
  fails the build.
- Tests: test/testing.test.ts ("program code may reuse a name only the test file declares").

### A whole service in the guide's second part (card #bab38ee1)

The same-spec runs read both parts of the guide, then went looking for a whole service:
examples/todos or orders, start.md's "A whole service", the heads of std/http and std/json.
docs/agent-more.md now starts with one (about 2.6k characters): JSON over HTTP in SQLite,
`handle` taking plain values and `route` answering errors as `Err(response)`, 405 against 404,
a 400 from `json.decode`, a 500 from the database, `main` opening `DB` and serving on
127.0.0.1:`PORT`, exiting 1 on an `Err`, and its test file; then one line each on transactions,
empty and text responses, headers, `queryOne`, and where shutdown is. In agent-more.md, not
agent.md: change runs read agent.md whole and rarely the second part, so they pay nothing.
agent.md, the checklist and the plugin's skill say the second part has it.

Six Candor runs again (sonnet, all passed; Go's stay): context at the first file written 27k
median to 24k (blobs 35 to 27k, bookings 25 to 20k, gateway 29 to 24k, pricing 26 to 25k, jobs
and logs the same), Candor cost $1.95 to $1.47. Go is 9–10k. Bookings read the guide and
examples/todos and wrote; the rest still read std/http's or std/json's head, and jobs and
pricing start.md's shutdown section. One run each: a small sample, the direction is clear.
Tests: test/start.test.ts (the block and its test), test/guide.test.ts.

### Pal's calls on what the 2026-10-28 ports ran into (cards #6a607d39, #8a5f2239, #dfd9edd7, #6ea8241a, #a64e87fe)

Decided 2026-10-30; each is a Modules card now, implemented one per session.

- **Exit status** (#6a607d39, revises card 055): std gets an `Exit` type with a status and a
  message, and `main` may return `Result<void, Exit>`; its `Err` prints the message on stderr
  and exits with the status. Any other error type still exits 1. An app with its own error
  enum maps it to `Exit` in `main`. Not a trait, so the status shows in `main`'s signature.
  Still no `env.exit`: cleanup in `main` runs.
- **Consts** (#8a5f2239, revises card 079): a module const may also be a list, map or record
  built from constants, or a named function (not a lambda). Emitted as Go package variables
  nothing in Candor can change.
- **Long-lived tasks** (#dfd9edd7): `scope.background(f)` starts a task the scope cancels once
  the rest of its work is done (its function has returned and its other tasks have ended). A
  background task's `Err` still cancels the scope. A server, a watcher or a library's manager
  task runs this way, and a forgotten close no longer hangs the scope. No `scope.cancel()` for
  now.
- **Locks** (#dfd9edd7): no lock handles that outlive a call. Callbacks (`lock.with(fn)`,
  `sql.transaction`) are the Candor form of Begin/Commit/Rollback; the guide says so.
- **Streams** (#6ea8241a): a general reader/writer pair in std now, not per module. The shape
  (types or effect, how fs, http, exec, json and xml take it, the fakes) is the card's first
  step and comes back to Pal.
- **Friction** (#a64e87fe): changed: `Ok(.Variant)` / `Err(.Variant)` patterns take the leading
  dot; `.Variant { _ }` for unused fields; a lambda's parameter types and a generic call's type
  arguments are taken from the expected type where it is known. Help lines only: a char's
  number is `.code()` (`toChar()` gives an optional), and a scope that spawns a `Result` task
  returns a `Result`.

### `main` exits with a status through the built-in `Exit` (card #6a607d39)

Revises card 055 ("an `Err` from `main` exits 1"), as decided above.

- `Exit { status: int, message: string }` is built in, like `GoError`: no import, the same type
  in every module. A module that declares its own `Exit` hides it (hey's port has one), so no
  program that compiled before breaks.
- `fn main() -> Result<void, Exit>`: an `Err` prints the message on stderr, a newline added if
  it has none and nothing if it is empty, then exits with the status. 0 is allowed (`-h`
  printing usage). A status outside 0 to 125 exits 1 and says so: 126 and up mean "can't run"
  or a signal to a shell, and the status isn't known until run time, so it can't be checked.
- Any other error type still exits 1, as before. `main`'s CAN0010 help and the `?`-in-`main`
  help name `Exit`.
- Nothing new for tests: a function returning `Result<T, Exit>` is compared like any value.
- Emitted as `candor__Exit`, declared once in the Go program when something names it;
  `candor.ExitWith` ends the program. `candor doc exit` and reference.md have it.

Tests: test/main-result.test.ts (status 2 and 0 end to end, the range, a test comparing an
`Exit`, a module's own `Exit`); test/reference.test.ts runs its examples.

### Consts hold lists, maps, records and function names (card #8a5f2239)

Revises card 079 ("Module constants"), as decided above.

- A const's value may also be a list, map, tuple or record (struct or variant, `.Short` too) of
  constants, `none` where an optional is expected, an enum variant without fields, and the name
  of a function, own or imported. Any type may be written: `const noLess: List<fn(string,
  string) -> bool> = []`.
- Operators still take only the scalars Go folds: `a + a` on a list const is CAN0059 ("an
  operator in a const works on ints, ..."). A call (`xs.length()` included) and an interpolated
  string stay CAN0059. A lambda is CAN0059 with help to write a `fn` and name it.
- A named function must have no effects (a const has none to give it) and not be generic (Go
  needs its type arguments); each is CAN0059 with its own help.
- Scalars are Go consts as before. The others are Go package variables, set in one `func
  init()` in the checker's order (each after the consts it names; modules after their imports).
  Not initializers: a function a const names may read that const, which Go would refuse as an
  initialization cycle.
- Unchanged by anything in Candor: `xs.push` on a const is CAN0036 (not `let mut`), and `let mut
  ys = xs` copies, as for any `let`.
- Checked by hand: supercronic's month and day tables and buntdb's `noLess()` written as consts
  (in a module and its test file).

Tests: test/consts.test.ts (lists, maps, records, a tuple, `none`, function names across modules
run; the Go `var` and `init`; push refused; lambda, effects, generic, operator on a list).

### The ports' pattern and inference friction (card #a64e87fe)

As decided above. Each item was reproduced on master first, from the ports' transcripts; several
had been fixed since, or were knock-on errors from an earlier one.

- Already worked: `Ok(.V)`/`Err(.V)` patterns; generic type arguments from an annotated `let`
  (`let r: Result<T, E> = viewWith(...)`); `drive(o, (events) => ...)` with a
  `fn(Channel<Event>)` parameter; `io.errorOutput().lines().map((l) => ...)` in a test; `r.ok()
  ?? ([], [])`; the help for a scope spawning a `Result` task. Pinned by tests.
- `.Bad { _ }`, `.Bad { why, _ }`: `_` in a field pattern stands for the fields not named (the
  parser drops it; leaving them out already worked). The `..` help names it.
- An expression-body lambda whose result is a partly known `Result<R, E>`, `viewWith((tx) =>
  Ok(tx.n))`, is checked as `{ return Ok(tx.n) }`, so `R` comes from the value and `E` from the
  parameter's type, as block bodies already did.
- `fold`'s empty start (`[]`, `[:]`, `none`) takes the expected type when the lambda's `acc`
  isn't annotated: `return xs.fold([], ...)` in a `-> List<int>`.
- A list or map literal holding `Ok(...)`, `none` or `.V` takes the other side's type in `==`
  and elsewhere context is used: `reads == [Ok("a"), Err("b")]`. A lambda in a list doesn't (it
  says its own type).
- After a call that already failed (`h.items.map(...)` on an `int?`, `io.errorOutput()` outside
  a test), its lambda's unannotated parameters are not reported again with a made-up `int`.
- Help only: `s.mutex([])` or `s.mutex([:])` with nothing saying the type shows `let m:
  Mutex<List<int>> = s.mutex([])` (later uses are not read for it); `c.toInt()` (and `ord`,
  `charCode`, ...) on a char names `code()` and a digit's `c.toString().toInt()`; a `T?` where
  a `T` goes (`97.toChar()`, `xs[0]`) names `??` with a default for the type, or the `none`
  check.

Seen on the way: a tuple has no `Show`, so `"${(1, [2])}"` is refused. Not part of this card.

Tests: test/friction.test.ts (patterns, lambda result, fold, list `==` run; the help lines; no
knock-on lambda errors); test/types.test.ts's `..` help.

### `scope.background` for tasks that run until the scope's work is done (card #dfd9edd7)

As decided above.

- `s.background(f)` is checked as `s.spawn(f)` (a fallible one must be spawned in the scope's
  own function, which then returns a `Result` with its error) and gives nothing back: no
  `Task`, as nothing may wait for it.
- The scope, once its function has returned, waits for its other tasks (and those they start),
  then cancels the background ones and waits for them to stop, their `defer`s included. A
  background `Err` cancels the scope as a spawned one's does; cancelling it at the end is not a
  failure. `s.wait()` leaves background tasks out (it would wait forever). No `scope.cancel()`.
- Runtime: background tasks share one token, a child of the scope's, so a failure anywhere still
  reaches them. Real goroutines count the others in `fg` under the group's mutex with a
  `sync.Cond` (a WaitGroup can't be waited on while it may still grow from zero); the test
  scheduler walks the scope's tasks skipping background ones, then cancels and walks them all.
- Locks stay callbacks: the guide says `lock.hold(f)` and `sql.transaction(f, ...)` are
  Candor's Begin/Commit/Rollback.
- start.md's shutdown example keeps its `tasks.race`: as a background task the server would
  keep taking orders while the workers drain a closed queue. The overview names `background`.
- Checked by hand: supercronic's `app` becomes `s.background` for `control` and `watchCrontab`
  and `return supervise(...)`, no race or parked channel (the same shape runs in
  test/background.test.ts); buntdb with `scope.background(() => manage(db))` passes its 54
  tests, and a scope that opens a database and never closes it ends at once instead of hanging.

Tests: test/background.test.ts (run for real and under seeded orders: sources cancelled when
the work ends, `defer`s run, a background `Err` is the scope's, `wait` skips them; no Task, the
Result rule); runtime/go/tasks_test.go (the same on real goroutines and five seeds);
reference.ts `background` example.

### Small std helpers the ports wrote by hand (card #c9d1ab04)

- `random.uuid4()`: a version 4 UUID, all random bits. `random.uuid()` stays v7 (time first,
  sorts by creation); webhook wanted ids whose first characters don't repeat.
- `s.trimChars(set)`: any of the set's characters from both ends, Go's `strings.Trim`
  (webhook's XML trim of `"\t\r\b\n "`). Card 159 stands: `trim(x)` with an argument is still
  refused; its help now names `trimChars` beside `removePrefix`/`removeSuffix`. One method for
  both ends; no start/end variants until someone needs one.
- `s.quoted()`: Go's `%q` (`strconv.Quote`): quotes, `\` and `"` escaped, control characters
  as `\n`, `\t`, `\x..`, printable Unicode kept (supercronic's log quoting).
- Dropped: several Content-Type headers on a multipart file part. A part has one; webhook only
  loops over Go's `Header["Content-Type"]`. `FormFile.contentType` stays one string.
- Left for Pal: a `Set<T>` (or set operations on lists), a new built-in type.

Tests: the reference examples (test/reference.test.ts); the method lists and the trim help in
test/strings.test.ts, test/random.test.ts and test/trim-reversed.test.ts.

Decided by Pal 2026-10-30: set operations on lists (`union`, `intersect`, `unique`), no
`Set<T>` until a second port asks.

Done:
- `xs.unique()`: each item once, where it first appears. `xs.union(ys)`: `xs.concat(ys).unique()`.
  `xs.intersect(ys)`: xs's items that ys has, each once, in xs's order. All three drop
  duplicates, so their results are sets in list form; the receiver is unchanged.
- Items need `==` (refused like `contains` otherwise). Items Go's `==` compares go through a Go
  map (linear); others (lists, records holding lists, bytes, a `T: Eq`) through the type's
  equality pair by pair (quadratic, fine at a port's sizes; a `Set<T>` would fix it if needed).
- No `difference`: `xs.filter((x) => !ys.contains(x))` says it, and the reference's misnamed
  list points there; `distinct`/`dedupe` point to `unique`, `intersection` to `intersect`.

Tests: test/list-sets.test.ts (both paths, a type parameter, the receiver kept, the refusal);
the reference examples.

### Signals outside `http.serve` (card #cb18c33b)

Decided by Pal 2026-10-30: `env.signals(s, [...])` gives a `Channel<Signal>` for the scope's
life; a fake sends them in tests; Windows as Go has it.

- `Signal` is built in like `Exit`: `enum Signal { Interrupt, Terminate, Hangup, User1, User2 }`,
  no import, hidden by a module's own `Signal` (then `env.signals` says so). The variants are
  capitalised like every enum's. Built-in types now print bare (`Exit`, `Signal`, not
  `candor.Exit`) in messages and the reference.
- `env.signals(s, which)`: the Scope comes first, as for the handles, so the channel and the
  delivery end with it; then the signals are what they were before (Ctrl-C ends the program).
  An empty list is refused. It is an `env` operation: signals are the process's, like its args.
- Up to 8 wait unread; more are dropped, as Go's `signal.Notify` drops them. Delivery never
  blocks. No `Show` for `Signal` yet (a built-in impl needs a declaration the impl table
  doesn't have); `match` names it.
- Tests: `env.sendSignal(.X)` on the fake `env` gives it to every `env.signals` channel
  asking for it, now; refused outside tests with help.
- Windows: `.Interrupt` (Ctrl-C, Ctrl-Break) and `.Terminate` (Go gives a console's close,
  logoff or shutdown as SIGTERM); the others may be asked for and never come.
- Runtime: `Env.Notify(tags, send) -> stop`; `candor.Signals` makes the channel and stops at the
  scope's end through a new `group.atEnd`. The real env uses `os/signal` (swappable for tests);
  `http.serve` keeps its own handling.
- Checked by hand: supercronic drops its loopback `control` server (and the `http` effect):
  `env.signals(s, [.Interrupt, .Terminate, .User2])` read by a background task, SIGUSR2 a
  reload as in the original; its 35 tests pass, two new ones sending signals over 100 orderings.
  hey: Ctrl-C sets the stop flag `-z` uses, so the report is printed; it compiles and its tests
  pass. Seen: hey's `-z` sleeper is a `spawn`, so after Ctrl-C the scope still waits it out;
  `s.background` is the fix for the port.

Tests: test/signals.test.ts (hey's shape under seeded orders, a run that is sent none, the
errors, a module's own Signal); runtime/go/signals_test.go (os/signal path with a swapped
notifier, the fake on both schedulers, the buffer); reference.ts `signals` and `sendSignal`.

### A flag parser in std (card #0c2dc168)

Decided by Pal 2026-10-30: `flags.parse(env.args(), Options { ...defaults })` gives
`Result<(Options, List<string>), Exit>`; flag names from the fields, a mistake is
`Exit { status: 2, message }` with the usage. Durations as a `time.Duration` type, and each
field's help from its comment (Pal, same day, over a name ending in `Ms` and over types and
defaults only).

- `import "flags"`; `parse<T>` takes any struct, no `impl`: the checker checks its fields and
  the emitter writes each call for that struct (`flagCalls`), a `candor.Flag` per field whose
  Set writes a copy of the defaults. A generic `T` is refused (the struct must be known there).
- Fields: `string`, `int` (Go's base-0 ParseInt: `0x10`), `float`, `bool`, `time.Duration`,
  a `T?` of one (none unless given), a `List` of one but bool (each use adds one; the first
  replaces the default). Anything else is refused with help to read a string and convert.
- Names: the field's in kebab case (`disableCompression` is `-disable-compression`), or its `as`
  name (`headers: List<string> as "H"`). `as` on a struct `flags.parse` reads in the module
  needs no `impl Json`; two fields with one flag are refused.
- Go's rules exactly (`-x`, `--x`, `-x=v`, `-x v` but never for a bool, ends at a non-flag or
  `--`) and Go's messages ("flag provided but not defined: -x", "invalid value ... parse
  error", "value out of range"). `-h`/`-help` with no such field: `Exit { status: 0 }` and the
  usage, as Go's ExitOnError exits 0.
- Usage: Go's PrintDefaults, byte for byte (flags sorted, `
    	` before the help, the
  default unless zero, a backquoted name in the help as the kind). The header is the struct's
  comment, else `Usage:`. Comments become docs only here: the lexer keeps the `//` lines directly
  above a token that starts its line (`Token.doc`), the parser puts them on structs and fields.
  Lines are joined; a blank comment line keeps a paragraph break.
- `time.Duration { ms }` with `Show` as Go's `Duration.String` (`"1m30s"`) and
  `time.parseDuration`; time stays an int of ms everywhere else.
- Checked by hand: hey (its own module named `flags` renamed, which a port must do): ~130 lines
  of parsing and a duration parser replaced by a `Flags` struct and `flags.parse`, its 23
  options tests pass, flag errors now status 2 inside. Its main still exits 1: its own `Exit`
  struct hides the built-in one. supercronic: the generated usage is the original's byte for
  byte (the port's hand copy had Go's tab expanded); its 35 tests pass on `flags.parse`. The
  `-sentryDsn` alias is a second field merged after parsing.

Tests: test/flags.test.ts (each kind, lists, ends, every Go message, -h and the exact usage,
durations, a real run's exit 2 and 0, the checker's refusals, doc comments in the lexer).

### Process groups, a graceful stop and the program's pid in exec (card #142ecc59)

From supercronic, whose original runs each job in its own process group (Setpgid) and has no
way in Candor to stop a job gently or know whether it is PID 1. Decided by Pal 2026-10-30:

- `exec.withOwnGroup(cmd)`: the child gets its own process group, and cancelling kills the
  whole group, grandchildren too. Opt-in: a child in its own group outlives a parent stopped by
  Ctrl-C, so it stays off by default. Does nothing on Windows.
- `exec.withStop(cmd, signal, graceMs)`: on cancel, send the signal, wait up to `graceMs`, then
  kill (Go's `cmd.Cancel` and `WaitDelay`). No process handle and no child pid: cancelling the
  task stays the one way to stop a program.
- `env.pid() -> int`. Reaping as PID 1: Some day, since waiting on any child races exec's own
  wait.

Done:
- `Command` has `ownGroup: bool` and `stop: exec.Stop?` (`Stop { signal: Signal, graceMs }`),
  so `exec.ran()` shows both in a test. The built-in `Exit` and `Signal` now go into scope
  before struct fields are checked, so a field may be one.
- execgo: `Setpgid` and a `cmd.Cancel` that signals the process or, with a group, `kill(-pgid)`;
  with a stop, a kill follows `graceMs` later, and `WaitDelay` is the grace plus the 2 s it was.
  On Windows both do nothing more than kill.
- A cancelled task unwinds before `exec.wait`, so the cancel used to return at once and leave a
  stopping program running. With `withStop`, the cancelled `next` now waits for the program to
  end (signal, grace, kill) before the task goes on unwinding. A kill at once still doesn't
  wait.
- `env.pid()`; the fake gives 1000 until `env.setPid(n)`.
- Checked on Linux (WSL): own group + stop, the program and its child both get SIGTERM and stop
  in a few ms; a stop without a group waits the grace, then kills, and the child is left
  running (why the group is there); own group alone kills at once. supercronic: jobs
  `withOwnGroup` (it waits for running jobs rather than cancelling them, so it needs no stop),
  the pid-1 warning on `env.pid()`; its 35 tests pass.

Tests: test/exec-stop.test.ts (the real run: on Windows killed at once, on Unix both get the
signal; the fake's record; pid), reference examples.

### The time module's gaps from the ports (card #862ac7c0)

From supercronic, hey and yarr. Go duration parsing and formatting came with the flag parser
(#0c2dc168). Decided (Pal, 2026-10-30):

- Local zone: `env.zone() -> Zone`, from `$TZ`, then the machine's zone, then UTC. An effect,
  so `time` stays pure and a function that depends on the machine says so. The fake gives UTC
  until `env.setZone(z)`. `time.zone("Local")` stays refused.
- A wall time a DST change skips: `time.inZone` rolls it forward by the gap, as Go does (02:30
  on the spring-forward night is 03:30). It is still an `Err` for a date that doesn't exist
  (Feb 30). `time.validIn(z, ...)` tells whether the parts name a time there.
- `time.parseLayout` reads an unknown zone abbreviation at offset 0, as Go does; the doc
  comment says the time may be off by the zone's real offset.
- `clock.nanos()`: a monotonic count of nanoseconds, for measuring how long something took.
  Times stay millisecond ints. The fake clock's nanos are its ms × 1,000,000.

Done:

- `env.zone()` and `env.setZone(z)` are sent by the checker to private `envZone` and
  `setEnvZone` in std/time (as `env.load` goes to std/fs), whose bodies the emitter writes in
  Go. Without `import "time"` the call is CAN0041 with that help; `setZone` outside a test is
  refused. Neither is an op in effects.ts, as their type is std's `time.Zone`.
- The machine's zone: `$TZ` (a leading `:` allowed) if it names one, else the name
  `/etc/localtime` links to, else `/etc/timezone`, else "Local" (Windows: Go can't name the
  zone there), which timego reads as Go's `time.Local`; UTC when the machine has no zone at all.
  `time.zone("Local")` stays none. Checked: Windows gives "Local" at Oslo's offset, Linux
  (WSL) "Europe/Oslo".
- `inZone` checks the date alone (`goValid`); `DateIn` already rolled forward through Go's
  time.Date. `time.validIn` added.
- `parseLayout`: an unknown abbreviation gives the clock time at offset 0.
- `clock.nanos()`: Go's monotonic clock since the program started; the fake's ms × 1e6.
- Ports, on copies: supercronic reads its default zone from `env.zone()` (Go's behaviour, the
  machine's zone, comes back) and its hand-written `at` is `inZone(...)`; 35 tests pass.
  yarr's date and feed tests pass (41). hey: not changed; its samples would move to
  `clock.nanos()` with `secs` dividing by 1e9.

Tests: test/time-gaps.test.ts ($TZ, the fake, nanos, the errors), test/timezone.test.ts (the
gap, validIn, abbreviations), reference examples.

### The reader/writer shape (card #6ea8241a)

Pal's calls (2026-10-30), on the shape the card's first step put to him:

- **Function types, not new types.** A writer is `fn(Bytes) -> Result<void, string>`, a reader
  `fn(int) -> Result<Bytes?, string>`: it pulls up to n bytes, and gives `none` at the end. A
  function that takes one declares `uses w` / `uses r`, so its effects stay in its signature,
  and a pure caller handing it an in-memory one stays pure. Any Candor function is a writer (a
  hasher, a counter). http's `send` is already one.
- **Opened by a callback.** `fs.reading(path, (r) => ...)`, `fs.writing(path, (w) => ...)`:
  closed when the function returns, as `lock.hold` and `sql.transaction` are. No handle
  outlives a call.
- **Built in steps.** First: the helpers (lines, read all, copy), fs, in-memory `bytes`
  (`bytes.collect`, `bytes.reading`), json encode/decode on a stream; buntdb's save/load on a
  copy. Then cards for http bodies, exec stdin/stdout and a streaming xml reader. http's
  `readBody` and `streamResponse` stay as they are.
- Not traits: a trait fixes its methods' effects for every impl (card 058), so one `Reader`
  trait can't be both an fs reader and an http one. Opaque `io.Reader`/`io.Writer` types were
  the other option: closer to Go, but a function writing to disk through one shows no effect.
- Mine: errors are `string`, so a function passing data through needs no error type
  parameter. A cancel closes the file or connection under a blocked read; fakes are in memory
  and never block.

Done (first build):

- **fs**: `fs.reading<T>(path, f)` and `fs.writing<T>(path, f)`, `f` returning `Result<T,
  string>`, the whole call `Result<T, string>`: an open failure is the `FsError`'s text. The
  reader's type is `... uses fs`, so a lambda calling it takes on fs, and a function given it
  needs `uses r` (the existing help says so). Mine: `writing` writes a new file beside `path`
  and, on `Ok`, syncs it and moves it over `path` (keeping its permissions); on an `Err`, a
  crash or a cancel it is removed, so a file is never half written. A reader or writer called
  after its call returned gives an `Err`. A read below 1 byte asks for 64 KiB; one read is at
  most 16 MiB. The fake reads a snapshot of the file and writes it whole on `Ok`.
- **bytes**: `collect<E>(f)` and `reading<T, E>(b, f)`, generic in the error since they add
  none of their own (buntdb's tests keep its `Error`); `readAll`, `readLines` (as
  `fs.readLines`: `\n` or `\r\n` cut, a last line without one counts) and `copy` (the bytes
  copied) over any reader.
- **json**: `encodeTo(value, w)`, `decodeFrom<T>(r)`. Both hold the whole text, as a decoded
  `T` is whole anyway; `decodeFrom` is written in the emitter, so `json` still imports nothing
  (importing `bytes` would bring x/text to every JSON program).
- Runtime: runtime/go/stream.go (`Pull`, `Push`, `StreamErr`, the helpers), `FS.Reading` and
  `FS.Writing`; the emitter converts Candor readers and writers to and from them.
- Not in src/reference.ts: these are std module functions, documented in their modules as
  `fs.readLines` is.
- buntdb, on a copy: `save(db, w)` and `load(db, r)`, as Go's take an io.Writer and io.Reader;
  `shrink` writes through `fs.writing` instead of its own .tmp and rename. 54 tests pass.
- Next, as cards: http bodies as readers/writers, exec stdin/stdout, a streaming xml reader;
  fs sync/truncate (#02cd3f5b).

Tests: test/streams.test.ts (a real run, the fake, memory, the effect rules),
runtime/go/stream_test.go (odd pieces, errors, a failed write, a late write).

### fs sync and truncate (card #02cd3f5b)

From buntdb, whose sync policies (never, every second, always) were kept and did nothing, and
which cut a torn tail by rewriting the whole file. Decided by Pal 2026-10-30:

- Plain operations beside `fs.append`: `fs.sync(path)` (flush the file to disk) and
  `fs.truncate(path, size)`. No file handle and nothing to close; each opens the file, as
  `fs.append` already does. `always` is append then sync; `everySecond` is a sync in the
  manager loop.
- Not chosen: an appending callback like `fs.writing` (buntdb's file lives as long as the
  database, so the callback would wrap its whole life), and a handle held by a scope (a first
  value holding an OS resource past a call).

Done:
- `fs.sync(path)`: a file or a directory. On Windows a file is opened for writing to flush it
  (Windows flushes only such a handle), and a directory is only checked. The fake checks the
  path is there.
- `fs.truncate(path, size)`: cuts, or pads with zero bytes as Go does; a missing file is
  `NotFound`, a directory or a negative size `Failed`.
- `fs.writing` now syncs the directory after its rename (not on Windows; ignored where a file
  system refuses it), so the swap itself survives a crash.
- buntdb, on a copy: `always` syncs after each commit's append; `everySecond` syncs in the
  manager loop when something was appended since; a torn tail is cut with `fs.truncate`, not
  rewritten. 54 tests pass.

Tests: test/streams.test.ts (a real run and the fake), runtime/go/stream_test.go
(`TestTruncateAndSync`, disk and memory; also run on Linux under WSL).

### http bodies as readers and writers (card #a955299f)

The reader/writer shape (#6ea8241a) for http. Decided by Pal 2026-10-30:

- `http.reading(req, (r) => ...)` reads a request's body, and `http.readingResponse(res, (r) =>
  ...)` a client response's (from `openStream`). Named like `fs.reading` and `bytes.reading`; the
  reader lives for the callback.
- `http.writing(status, headers, (w) => ...)` is a streamed response whose callback takes a
  writer and returns `Result`; a write after the client has gone is an `Err`.
  `streamResponse` and `streamBytes` stay as they are (nothing breaks); the docs teach
  `writing` for new code.
- An `Err` from `writing`'s callback, after the status and headers have gone out, cuts the
  connection, so the client sees a broken body and not one that looks whole (Go's handler
  abort). The error goes to stderr as a crash in a handler does.
- Not chosen: `bodyReader`/`responseReader` names; changing `streamBytes`' `send` to the writer
  type (one API, but a breaking change for every handler using it); ending the body cleanly on
  an `Err`.

Done (`test/http-rw.test.ts`):

- `http.reading<T, E>(req, f)` and `http.readingResponse<T, E>(res, f)` are `bytes.reading`'s
  shape. The reader does no effect, as `readBody` did none. A body held whole (any request off
  a `largeBodies` route, the fake client's responses) is read from memory; `streamed`'s pieces
  come one a read. `readingResponse` closes the connection when `f` returns, read or not.
- `http.writing<E>(status, headers, f)`: `f`'s `Err` cuts the connection
  (`http.ErrAbortHandler`) and prints `error: <e>` with the request, as a crash prints. Not
  printed when a failed write caused it (the client gone): that is the client's doing, not the
  server's. In a test, `bodyOf` is what was written before the `Err`.
- Mine: the runtime keeps a body to read as a pull (`candor.PutPull`), with the push form the
  older functions use made from it; `readBody`/`readResponse` are unchanged on top. The real
  request body and the client's response body are both `candor.ReaderPull` over Go's reader.

### exec stdin and stdout as a writer and a reader (card #09306770)

The reader/writer shape (#6ea8241a) for programs. Decided by Pal 2026-10-30:

- `exec.piping(cmd, (w) => feed(w), (r) => read(r))`: a writer to the program's stdin and a
  reader over its stdout. The feed runs as a task of its own beside the read, and stdin closes
  when the feed returns. Writing all of stdin before reading stdout deadlocks once a pipe fills
  (gzip stops reading while its stdout is full); two callbacks run side by side can't.
- `exec.reading(cmd, (r) => ...)` for stdout alone, stdin from `withStdin`/`withStdinFile` as
  now.
- stderr is collected and given in the result beside the exit code, as `exec.output` gives it.
- Not chosen: one callback with the writer, the reader and a `close` (the deadlock is the
  caller's to avoid, and a forgotten close hangs); a stdout reader only (no pipe between two
  programs without a temp file); stderr passed through, or a third reader.

Done (`test/exec-pipes.test.ts`):

- `exec.reading<T>(cmd, read)` and `exec.piping<T>(cmd, feed, read)` give
  `Result<exec.Piped<T>, ExecError>`: `code`, `value` (what `read` returned, often a `Result`
  of its own) and `stderr`. The reader and writer are `uses exec`, as `fs.reading`'s is
  `uses fs`. `piping` needs `tasks` for the feed's task.
- When `read` returns, stdout is closed (the program gets a broken pipe), then the exit is
  waited for. A write the program refused (it ended or closed stdin) ends `feed` with an `Err`
  that is not a failure; any other `Err` from `feed` cancels the read and is
  `ExecError.Failed { "feeding the program's stdin: ..." }` once the program has ended.
- Mine: new effect operations (`spawnPiped`, `readOut`, `writeIn`, `closeIn`, `closeOut`,
  `refused`, `stderrOf`) beside `spawn`/`next`/`wait`, so the fake plays them: a scripted
  stdout line is one read (cut to `n`), stderr lines are kept, and what was written becomes the
  command's `.Data` stdin in `exec.ran()`. Runtime: execgo's `Start` takes `piped`; stdout is
  Go's pipe read directly, stderr a buffer, and a cancel stops reading after the grace
  (`WaitDelay`) in case a child holds stdout open.
- Not done: binary stdout in the fake (a scripted line is text).

### A streaming xml reader (card #2d9c4f98)

The reader/writer shape (#6ea8241a) for XML, closing card 140's "a tree only" for large
documents. Decided by Pal 2026-10-30:

- `xml.elements(r, ["item", "entry"], start, each)`: each element with one of the names comes
  as a small `xml.Node`, folded with `Step` as `fs.watch` folds, so `each` can stop early. The
  usual lookups read it.
- The result also carries the rest of the document as a tree, with the matched elements left
  out: a feed's channel title, link and image are read with the same lookups, and the bulk
  (the items) is never held whole.
- As lenient as `xml.parse` (entities, mismatched tags; a document cut short ends after the
  elements read so far), the declaration's charset, a charset option as `parseWith` and a strict
  one as `parseStrict`.
- Not chosen: a fold over start/end/text events (every caller tracks depth and builds its own
  state), or both; dropping what isn't matched; strict only (real feeds that `parse` reads would
  fail).

Done (`test/xml-stream.test.ts`):

- `xml.elements(r, names, start, each)`, `xml.elementsWith(r, charset, ...)` and
  `xml.elementsStrict(r, ...)` give `Result<(A, Node), Error>`, `each` returning `fs.Step<A>`
  (xml now imports fs for it; `.Continue`/`.Stop` need no import).
- Mine: names match local names; a match inside a match stays in it as a child; a match cut
  short by the document's end is left out (half an item is no use); when `each` stops, the rest
  is what was read until then; a root that matches leaves an empty text node as the rest. A
  failure of the reader is an `Err` at line 0 with the reader's message, lenient or not, so a
  broken download isn't taken for a short feed.
- Go: std/xmlgo's `Elements` over `candor.PullReader` (new), the emitter writing `scan`'s body.
  The input is prepared as it arrives, as `Parse` prepares text: BOM, the charset given,
  control characters dropped, invalid UTF-8 as U+FFFD (x/text's UTF-8 decoder) when the
  declaration in the first KiB says UTF-8 or nothing.
- Checked on a copy of yarr: `parseRss` through `xml.elementsWith` (each item's `space()` as
  the feed's namespace), its 34 feed tests pass. The port itself is unchanged.

### SQL functions written in Candor (card #b29bfb64)

Reverses card 147's "not now" (Pal, 2026-10-31, picking the card). yarr's triggers call
`strip_html`, a Go function registered with SQLite; the port couldn't, so it kept its search
index in code and couldn't write a database the Go yarr made. Pal's call on the shape: a call
before `sql.open`, as Go registers one, not a part of `open`.

```candor
fn stripHtml(content: string?) -> string? { ... }

pub fn open(path: string) -> Result<void, sql.Error> uses sql {
  sql.function("strip_html", stripHtml)?
  sql.open(path)?
  return migrate()
}
```

- `sql.function(name, f) -> Result<void, Error>`: the name a string literal (letters, digits,
  `_`) that SQLite has no function by (`lower`, `json_extract`, `bm25`, ...: refused, with
  `app_lower` as the help); `f` a named function, own or imported, without `uses`, effect
  parameters or type parameters. Its parameters and result are int, float, string, bool, Bytes
  or a `T?` of one (none is NULL); the result may be a `Result<T, string>`, whose `Err` fails
  the statement with the message. A lambda, a variable or a generic function is refused before
  inference, so the error says why rather than "can't tell `F`".
- Pure only: SQLite calls it from queries, triggers and indexes, where an effect has no task,
  no fake and no order. Registered deterministic.
- The same function under the same name from two places (main and a test helper) is one
  registration; another function under a taken name is CAN0016.
- After `sql.open` (in a test, after the first query) is an `Err` that says to move it.
- The schema check knows each one, from this module and its imports (as migrations): calls in
  any query, triggers included, must give it its number of arguments; a `${}` given as an
  argument must fit its parameter (a `T?` or `none` only into a `T?`); in a SELECT it has its
  result's type, so `half(n) AS h` into `h: float` is "`half(n)` can be NULL". A column given
  as an argument isn't checked against the parameter.
- Run time: a NULL into a parameter that isn't `T?`, or a value of another type, fails the
  statement naming the function, the argument and the fix. A bool comes back as 0 or 1.
- Mine: each database gets a driver of its own (`sqlite.Driver{}`, the driver's
  private-registration pattern) holding exactly what was registered for it. So a test has only
  the functions it registered, whatever ran before it in the same binary; a process-wide
  registration would have made a forgotten one pass or fail by test order. The generated code
  makes that driver, since the runtime doesn't import the driver.
- Checked on a copy of yarr: the original's m14 and m15 (an FTS5 table over `items` with
  `content=`, triggers calling `strip_html` on insert, update and delete), `strip_html` as
  `util.extractText` on a `string?`, createItems no longer writing the index: all 166 tests pass,
  search included. The port itself is unchanged. Each test registers before its first query,
  which the error caught where one read the schema version first.

Checked in `test/sql-function.test.ts`.

### Both trials' Candor side run again on 0.0.30 (card #b62264d5)

Candor's 39 change runs and 6 same-spec runs were run again on 2026-10-31 (Candor 0.0.30 plus
#b29bfb64; tests in `x_test.candor`, the two-part guide with its whole service); Go's stay.
Every reference passed first (`trials/run.ts refs` 6, the change repo's `refs` 32). Change trial:
39 of 39 passed (Go 36), median context at the first edit 17k as before (Go 14k), tokens in all
155k to 133k (Go 164k), cost $4.79 to $4.44 (Go $4.56). Candor's first edit still comes later on
8 requests of 13; topic-limits is the widest (35k, Go 27k), and one of its runs took 27 turns and
a million tokens. Same-spec: all passed, median context 24k to 23k (Go 9-10k), cost $1.47 to
$1.40. The gap is still reading, not passing.

### Builds of one file at once take turns (bug #a538dc9d)

Every build of a file shares its cache folder (card 162), so two `candor run`s of it at once
removed and copied the same `local__N` packages under each other, and one died (EBUSY). Now a
build holds a lock in its folder (`.lock`, made only if absent, holding the pid) from preparing
the folder to the built binary; the other waits, then builds, mostly from Go's cache. A lock
whose process is gone, or older than 10 minutes, is taken over. The run itself is outside the
lock, so a long-running server doesn't hold up the next build. That needs one more thing on
Windows, which won't replace a running program: a cached binary still running is renamed
aside (`r.exe.<pid>.old`) for Go to build anew, and removed at a later build once it stops. A
test binary is renamed to one of its own after the build, since it is removed after its run and
could otherwise be removed under another test run of the same file. Considered: a fresh folder
per build, renamed into place; it loses the folder's `go get` and gotypes caches each time.
Tests: `test/build-lock.test.ts` (three runs and three test runs at once; a dead owner's lock
taken over, a live one's waited for).

### topic-limits asks more of the Candor port than of Go (card #efaf11d6)

The widest reading gap of the change trial (#b62264d5: context at the first edit 35k, Go 27k).
The six 0.0.30-era runs, read call by call up to the first edit: Go's tool output came to
32-40k chars, Candor's 51-67k. About 7k of Candor's extra is agent.md, which Go doesn't
read. The outline (6-10k) stands in for Go's first `grep -n topic server.go` (7-10k), so it
costs about the same. The rest is code, and it is code Go didn't need. Go's ntfy already has
the topic registry: `s.topics`, filled at startup from `messageCache.Topics()`, one choke point
(`topicsFromIDs`) that every publish and subscribe goes through, and stale topics pruned by the
manager. Go adds two checks there (126 changed lines). The Candor port left the registry out
(card 049's findings say so), so the request makes the agent build it. That means the cache query,
the topic map in `Server`, the subscriber counts from the hub, the manager's pruning, and a call
in each of the four handlers that name topics (145 changed lines). The Candor runs read exactly
those places: hub, cache, the manager, `publishAt`, `actionAt`, `subscribeHttp` and `subscribeWs`.
So this request's gap is the codebase, not the language. The other wide request,
max-concurrent, hasn't been checked for the same thing.

### The other requests start equal (card #1ea46664)

I checked the twelve other change requests the same way: their two references against the
starting code, and the pre-edit reads where Candor's context runs more than agent.md's ~2k
over Go's. Only topic-limits starts the two sides from different machinery. Beyond agent.md:
- max-concurrent (21k, Go 14k) is equal work, and the cost is the language. Candor has no
  package-level state, so the counter is a `Mutex` field of `Server`, and every construction of
  it changes, the tests' among them. The runs look up agent-more.md's Mutex section (2-5k chars)
  first. The outline (6-8k) also outweighs Go's greps here (1-3k), since the change is small.
- exit-code (16k, Go 12k) is equal work, and again the cost is the language. Go's error carries
  the exit code (`%w`, `errors.As`). Candor's error is a declared type, here a string, so the
  detail needs a `Failure` record through `runJob` and its callers.
- options-struct (17k, Go 13k) differs in the test suites: the port's 32 tests call the
  changed functions 17 times, upstream's 7 tests call them 7 times.
- The other nine are within agent.md's cost or below Go.
The Candor plants and references also carry runs of blank lines left over from the
`x_test.candor` split (#240e482c), for example 20 at the end of webhook's `hooks.candor`. They do
no harm, but should go when the patches are next made.

### The Candor ntfy gets Go's topic registry; topic-limits even (card #1901db8d)

So that topic-limits asks the same of both sides, the Candor ntfy now has what Go's starts
with. That means a topic map in `Server`, filled at startup from `cache.topics()`, and
`topicsOf` as the one choke point, as `topicsFromIDs` is in Go: every publish, action and
subscription names its topics through it. Subscriptions are counted in `subscribeHttp` and
`subscribeWs`, and the manager forgets a topic after 16 hours without use or subscribers. There
are no limits; one test checks that topics become known. The request text is unchanged. The
reference is now the two checks in `topicsOf` plus config, buckets and errors: 86 added lines
(was 145; Go's is 126). The blank-line runs left from the split are gone from every Candor plant
and reference, and all 32 refs pass. Three Candor topic-limits runs on sonnet, all passed:
context at the first edit 30/25/27k, against 33/35/37k before; Go's is 27k. The median Candor
context over the 13 requests stays 17k (Go 14k), and Candor's first edit now comes later on 7
requests, not 8. The change repo's `report --rerun app/request/lang@ISO` counts only that
request's runs from then on, so a single request can be rerun without changing the others' windows.
Two runs started in the same second share a working dir and the second fails at setup, so start
them a few seconds apart.

### The service section gets its signatures and a shutdown pattern (card #9def8586)

After #bab38ee1, same-spec runs still looked things up before writing: 5 of 6 grepped
std/http.candor's `pub fn`s or read its head (`serve`, `route`, Request and Response), 3 read
std/json.candor's head (`nulls`, renames, `json.Value`), bookings read sql's `transaction`, and
jobs read start.md's "Shared state, workers, shutdown". agent-more.md's service section now
lists those: Request and Response fields, `route`, the four responses, `serve` (a task per
request, Ctrl-C's 10 s grace, the 1 MiB body cap and `largeBodies`), `json.decode`/`encode`,
`nulls`, renames, `json.Value`, what `exec`, `insert` and `queryOne` give, and `?` inside a
transaction. A second block replaces the pointer to start.md: state in a `Mutex` made in
`main`'s scope and handed to `handle`, stopped on `POST /shutdown` by racing the server, with
its test. agent-more.md went from 11.7k to 15k characters.

Six Candor runs (sonnet, all passed; Go's stay): context at the first file written bookings
22→22k, gateway 21→22k, jobs 26→28k, logs 17→23k, pricing 25→22k, blobs 27→26k; median 23k to
22k (Go 9–10k), cost $1.40 to $1.47. The http lookups and the start.md trip mostly went, but
every run that reads the guide's second part whole now pays about 1k tokens more, which ate the
gain: neutral, as #7de8b2de's generic examples were. Kept (Pal): the text answers what runs
went looking for. logs, a CLI app, reads the docs by range, and the noise of one run each is
±3k. Tests: test/start.test.ts compiles the new blocks.

### A service is a guide part of its own (card #144da828)

After #9def8586 what was left of the same-spec gap was reading the guide itself: both parts whole,
about 22k characters, before the first file. The whole service, its test, the list of what a
service reaches for and the Mutex + shutdown block moved from agent-more.md to
`docs/agent-service.md`, printed by `candor guide service` (7.4k characters). agent-more.md keeps
effects in function types, concurrency, tests and the std map (6.7k). agent.md's list of parts
says which to read for what: writing a new service, or concurrency and tests. The checklist,
the CLI help, the skill and CONTRIBUTING name the new part; both trial runners copy it. The
same-spec prompt is unchanged: agents reach the part through agent.md, as they would outside
the trial.

Six Candor runs (sonnet, all passed; Go's stay): bookings 22→17k, gateway 22→22k, jobs 28→23k,
logs 23→19k, pricing 22→19k, blobs 26→24k; median 22k to 20.5k (Go 9–10k), cost $1.47 to
$1.41. Three of the five services read agent.md and the service part only; gateway and jobs,
which keep state across requests, read agent-more.md too. logs, a CLI app, read neither part
whole. Kept: every app but gateway read less, though with one run each the change is about the
noise. Tests: test/guide.test.ts (each part and the pointers to it), test/start.test.ts
compiles the new part's blocks.

### http client: Host, compression, keep-alive, no timeout (card #7d862c59)

The hey port (a4595be in candortests/hey) was the first to lean on the client and worked around
four gaps. Pal (2026-10-31) took these now, and left the rest for some day:

- A `host` header is the Host sent (Go ignores one among the headers and needs `req.Host`), for
  `send`, `openStream` and the WebSocket dial. No new field: it is what `curl -H` does.
- `compressed: bool?` on ClientRequest: `false` asks for no gzip (Go's `DisableCompression`, on a
  transport of its own). Left out, gzip is asked for and undone as before.
- `keepAlive: bool?`: `false` closes the connection after the request (`req.Close`, so
  `connection: close`).
- `timeoutMs: 0` is no timeout (it was refused; hey used a year in ms); a negative one is still
  an error. The fake waits for a handler with no limit too.

Optional fields like `redirects`, so existing code is unchanged. Some day: timings on the
response (Go's httptrace; hey's report shows 0 for three stages), a per-request proxy (Go
already reads HTTP_PROXY), an HTTP/2 switch (h2 is negotiated over TLS already). Tests:
test/http-client-options.test.ts (a real 127.0.0.1 server echoing what arrived; the fake).

### Public release and the one-page site (cards #1db3572b, #c237feac, #69e54b5d)

Pal's calls (2026-10-31): Candor is released as it is. The repo went public from one commit
(devnullada/candor; the history stays in a private archive), 0.0.31 is on GitHub Releases, and
candorlanguage.org is one page. The README and the site just say it is released: nothing about
progress or plans.

- The site is one static Astro page in `site/`: what Candor is, a service and its test, install,
  the trial figures read from trial-numbers/numbers.json with every catch, and links to the docs
  on GitHub. Highlighting borrows Shiki's Rust grammar until a Candor grammar exists.
- For agents: `/llms.txt` and the guides and reference as plain Markdown beside the page;
  robots.txt allows every crawler.
- `bun run deploy` in site/ builds, packs and ships over ssh; Release.sh swaps a `current`
  symlink and keeps five releases. Tests: test/site.test.ts runs the page's example.
- CLAUDE.md is a one-line `@AGENTS.md` import, not a symlink: Windows clones can't make links.
- install.ps1 renames an installed candor.exe aside before replacing it (it failed over one).

### The docs on the site (card #f5c8af00)

Pal (2026-10-31): "a proper site page… simple but enough, built for developers": the docs on
the site rather than links out to GitHub.

- `/docs/start`, `/docs/reference`, `/docs/design`, `/docs/trials` render `docs/*.md` from the
  repo as they are (an Astro content collection over `../docs`), so the page shows the examples
  the tests check. No copy, nothing hand-curated: `/principles` (#b8ae94b8) stays for later.
- Links between docs become site links; links into the repo (`../std/http.candor`) go to GitHub
  (`site/src/doc-links.mjs`).
- Sidebar, page, and the page's h2/h3 headings; search is Pagefind, a static index built after
  `astro build`. `/download` lists the release's five binaries and SHA256SUMS. Links end in `/`,
  as Caddy serves them.
- Text the docs meant literally, `List<T>` in a heading, was read as an HTML tag (on GitHub
  too). `docs/reference.md` escapes it now (`src/reference.ts`); `candor doc` prints it as is.
- `/contact` (#5448c737): a form that mails candor@sha256.no through sha256's contact service, the
  one sha256.no's form uses (Candor, Zoho's API); Caddy proxies `/api/contact` to it. No service
  in this repo. Bugs still go to GitHub issues, and the page says so.

## Open questions

- Change trial: pass rate doesn't separate the languages at these requests. Harder requests,
  or let reading and tokens carry the comparison.
- Why Candor agents read more code (#f4df4655, #917237b1): not file layout, since an outline
  and reading by range left it unchanged. Likely the agent reading surrounding code to learn
  idioms it wasn't trained on. Opus and Gemini show the same gap (#1653f322), so it's not one
  model's habit. The docs rounds (#7de8b2de) closed a third of it with a lean agent.md and a
  shorter outline; examples did nothing. What is left is code reading. Tests in their own file
  (`x_test.candor`, #240e482c) took about 2k off each of the two widest requests, within noise.
  The widest, topic-limits, turned out to be unequal work (#efaf11d6): the Candor port lacked
  the topic registry Go's ntfy has. With it added, the request comes out even, 27k on both sides
  (#1901db8d). The other twelve start equal (#1ea46664); after agent.md's
  fixed ~2k, what is left is language-shaped: state threaded through a `Mutex` field
  (max-concurrent), declared error types (exit-code).
- A test file's types named in program code fail only at build (#79ce004a checks functions and
  consts). Catch them at check too if an agent trips on it.

- Compatibility: what to promise past "breaking changes come with their fix" while Candor is
  0.0.x (dated spec versions, a version line per file, editions).
- Pull requests: when, and on what terms (a CLA or DCO, or neither).

- `T??` (148): flattened in the built-ins only; a program's own generic function still gives
  one, fixed with `?? none`. Flatten there too if ports keep hitting it.
- `embed` (144): one file per call; a folder (`Map<string, Bytes>`) when a program serves many.
- XML (card 140): a derived `impl Xml` (typed decode, as `Json`) if ports keep writing the
  same lookups. Streaming: `xml.elements` (#2d9c4f98).
- Aliased imports: messages name a type by its module's own name (`geo.Point`), not the alias
  the file writes (`g.Point`). Fine while aliases are rare.
- Narrowing: `push` on a narrowed list in place.
- Panic traces: a statement that spans lines is reported at its first line, except for the
  statements, lambda bodies and `else if` conditions inside it, which have their own. A panic
  inside a Go binding shows the Candor call site only; `CANDOR_TRACE=go` has the Go frames.
- Maps: the encoded keys for deep types are built by reflection; a generated hash per type would
  be faster if it shows up. `s.m[k] = v` copies each time, like `s.items.push`.
- Lists: `xs__own` starts true after a literal only; `map`, `filter`, `sorted` and `concat`
  results are fresh too and could start it true. `xs[i][j] = v` could be lowered to the
  copy-out-and-back its error suggests.
- `s.items.push(x)` on a list inside a struct copies every time. Fine for now; could be
  amortized like variables if it shows up in profiles.
- Concurrency: should a blocking Go call made through a foreign binding (card 009) be
  cancellable, and how does the test scheduler see it? `tasks.select` goes through
  `reflect.Select` on goroutines; a plain Go `select` for a literal arm list if it shows up in
  profiles. No race detector run yet (cgo needs a C compiler here). Under the test scheduler,
  virtual time stands still while any task can run, so `tasks.timeout` around a task that
  never waits doesn't fire there (found in card 074); should time charge for steps?
- Integer literal typing (`let x = 1` is `int` for now, `int64` in Go).
- Strings: grapheme clusters if display width shows up.
- Modules: packages after card 049. A private function nothing calls could be a warning.
  Effects are always public; a private helper effect would need a new decision.
- Bindings: out-parameters (`rows.Scan(&a, &b)`, `json.Unmarshal`) need Go next to the
  binding. A Go interface that may be nil is checked nowhere (`T?` on one means `(T, bool)`).
  Go types in user code (`time.Time` as a value) would need value semantics. Drafts list what
  can't cross yet; each is a candidate. A Go package used only through `./native` code can't be
  versioned yet (the native package has no go.mod of its own).
- Effect state: a writer holds the lock across its Go calls, so a slow `open` blocks readers. Is
  a finer rule wanted (lock only around the writes)?
- `mime.compose` writes plain text only: no HTML alternative, no attachments, no Bcc (112).
  When a program needs them.
- `http`: binary bodies ride in `body: string` (085); `http.respond` takes text only (a test
  answers with bytes through `http.answer` and `bytesResponse`). `http.answer` takes a handler
  that uses `clock` only, so a test calls a `uses fs` handler directly (and `http.served` for a
  file's ranges, 110). `listen` resumes at once, ignoring `retry:`.
- `sql`: a second file is attached (134); a connection of its own per database, or Postgres
  beside SQLite, would need handles. SQL functions from Candor are scalar only (#b29bfb64): no aggregates or window functions, and a column given to one isn't checked against its parameter. The schema check (cards 064, 091, 137, 139) skips
  recursive WITH, NATURAL joins, table-valued functions (`pragma_table_info('t')`) and virtual
  tables other than fts5 and rtree. It reads SQLite: types by affinity, SQLite's
  functions; a PRIMARY KEY that isn't `INTEGER PRIMARY KEY` is taken as NOT NULL, though an
  ordinary SQLite table lets it hold NULL (a legacy quirk). Postgres is on the Candor future board; it
  would need its own schema reader and function list beside this.
- `time` (153): the zone abbreviation table is fixed and US first; a feed from elsewhere may
  need a way to say what CST or IST means to it.
- `Bytes` (084): `for x in b` and `b[i]` could come if `toList()` and `at(i)` prove clumsy.
  Go bindings copy them each way (138), which costs on large data; a binding that needs to
  avoid it goes through a std module.
- `fs`: `within` goes by the text, so symlinks under a root aren't caught (Go's `os.Root`
  would, if a card wants it). No permissions or file modes. `fs.watch` (108): the debounce
  times are fixed, a network drive's events are the
  OS's to give, and the fake doesn't collapse bursts. On Linux and macOS a directory under a
  watch has its own inotify or kqueue watch; neither stops a move there, but kqueue holds a
  descriptor per directory (and file), which a large tree can run out of. Built for those, not
  yet run there.
- Floats: `clamp(lo, hi)` if `x.max(lo).min(hi)` shows up often. A binding passing a float into a
  Go `float32` rounds it, and one past float32's range becomes Go's infinity there.
- Effects: operations that use other effects (would a caller of `http.get` then declare
  `clock`?). A fake's handler can name only built-in effects from std, so `http.answer` can't
  take the app's own handler when it uses the app's effects.
- Generics: generic
  functions as values (`first<int>` without a call); mutually recursive generic types that grow
  their arguments still reach Go (direct self-reference is refused).
- Traits: generic methods, traits with type parameters. `Show` for maps and tuples. A way to pick between two traits'
  methods of one name. `"${a}${f()}"` reads `a` after calling `f`: `toString` is pure, so
  only which of two panics comes first could tell.
- Contracts: which ones can be checked statically and cheaply. A `requires x != none` could
  narrow `x` in the body. Contracts on trait methods (each impl checked against them), on
  effect operations and on fakes. `old(...)` isn't needed while parameters can't change. A
  multi-line clause is shown on one line in its diagram.
- Typed holes and the query server: both want the checker to be incremental.
- Syntax recovery (cards 028, 092): diagnostics of a file come syntax first, then the checker's,
  not by line. A broken function signature or struct header still drops the declaration.
- `exec` (100): no separate ordering of stdout and stderr; `withStop` and `withOwnGroup` are
  Unix only (a cancel on Windows kills). A lambda can't collect into a `let mut`, so a test
  of a streaming callback prints and reads `io.output()`.
- Releases (094, 136): the macOS binaries are cross-built only, never run on a Mac.
