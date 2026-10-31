# Start here

Candor on one page, for writing a backend service: the shapes you'll need, in the order you'll
need them. Every block of code here compiles, and the two whole programs pass their tests
(`test/start.test.ts`). For the rest:

- [`docs/reference.md`](reference.md): every method of the built-in types and effects
  (`candor doc split`, `candor doc tasks`).
- [`std/http.candor`](../std/http.candor), [`std/json.candor`](../std/json.candor),
  [`std/sql.candor`](../std/sql.candor), [`std/fs.candor`](../std/fs.candor),
  [`std/net.candor`](../std/net.candor), [`std/exec.candor`](../std/exec.candor),
  [`std/mime.candor`](../std/mime.candor), [`std/imap.candor`](../std/imap.candor),
  [`std/smtp.candor`](../std/smtp.candor), [`std/regex.candor`](../std/regex.candor),
  [`std/crypto.candor`](../std/crypto.candor), [`std/html.candor`](../std/html.candor),
  [`std/xml.candor`](../std/xml.candor), [`std/url.candor`](../std/url.candor),
  [`std/bytes.candor`](../std/bytes.candor), [`std/hash.candor`](../std/hash.candor),
  [`std/time.candor`](../std/time.candor), [`std/flags.candor`](../std/flags.candor): the
  standard modules, documented at the top.
- [`docs/design.md`](design.md): why things are as they are. Long; search it.

## The loop

```
candor check app.candor      # every error in the file at once, each with a `help:` line: the fix
candor test app.candor       # its tests, in app_test.candor beside it; --only "name" for one
candor test                  # every file's tests under this folder, one total
candor run app.candor        # build and run: PORT=8080 candor run app.candor
candor build app.candor      # a binary beside app.candor, named for its module; -o to name it
candor build app.candor --target linux-x64   # one for a Linux server, named without .exe
```

On Windows the CLI is `./candor.cmd`. Write the whole file, `check` it, do what the help lines
say, and check again.

## A whole service

JSON over HTTP, kept in SQLite: `POST /items` adds one, `GET /items/{id}` reads it,
`POST /items/{id}/take` takes from its stock, or 409.

```candor
module shop

import "http"
import "json"
import "sql"

struct Item {
  id: int
  name: string
  stock: int
}
impl Json for Item
impl Row for Item

// A POST body. A `T?` field may be missing or null.
struct NewItem {
  name: string
  stock: int?
}
impl Json for NewItem

struct Take {
  n: int
}
impl Json for Take

// The body of every error.
struct Problem {
  error: string
}
impl Json for Problem

fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("""
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      stock INTEGER NOT NULL
    )
    """)?
  return Ok()
}

fn find(id: int) -> Result<Item?, sql.Error> uses sql {
  return Ok(sql.query<Item>("SELECT id, name, stock FROM items WHERE id = ${id}")?.first())
}

// The item after taking `n`, or the answer saying why not; the read and the write are one
// transaction. The outer Result is the database's, the inner one the request's.
fn take(id: int, n: int) -> Result<Result<Item, http.Response>, sql.Error> uses sql {
  return sql.transaction(() => {
    let item = find(id)?
    if item == none {
      return Ok(Err(problem(404, "no item ${id}")))
    }
    if item.stock < n {
      return Ok(Err(problem(409, "only ${item.stock} left")))
    }
    sql.exec("UPDATE items SET stock = stock - ${n} WHERE id = ${id}")?
    return Ok(Ok(Item { ...item, stock: item.stock - n }))
  }, (e) => e)
}

// The service. `route` gives errors as `Err(response)`, so `?` can answer early.
fn handle(req: http.Request) -> http.Response uses sql {
  return match route(req) {
    Ok(res) => res,
    Err(res) => res,
  }
}

fn route(req: http.Request) -> Result<http.Response, http.Response> uses sql {
  // A path without a method matches every method: the others get a 405.
  if http.route(req, "/items") != none {
    if req.method != "POST" {
      return Err(problem(405, "/items takes POST"))
    }
    let body = decode<NewItem>(req.body)?
    let name = body.name.trim()
    let stock = body.stock ?? 0
    if name.isEmpty() || stock < 0 {
      return Err(problem(400, "`name` must not be blank, nor `stock` negative"))
    }
    let id = stored(sql.insert("INSERT INTO items (name, stock) VALUES (${name}, ${stock})"))?
    return Ok(http.jsonResponse(201, Item { id, name, stock }))
  }
  // With a method, other methods don't match, and fall through to the 404.
  let one = http.route(req, "GET /items/{id}")
  if one != none {
    let id = idIn(one)?
    let item = stored(find(id))?
    if item == none {
      return Err(problem(404, "no item ${id}"))
    }
    return Ok(http.jsonResponse(200, item))
  }
  let taking = http.route(req, "POST /items/{id}/take")
  if taking != none {
    let id = idIn(taking)?
    let n = decode<Take>(req.body)?.n
    let item = stored(take(id, n))?
    return Ok(http.jsonResponse(200, item?))
  }
  return Err(problem(404, "no route ${req.method} ${req.path}"))
}

fn decode<T: Json>(text: string) -> Result<T, http.Response> {
  return json.decode<T>(text).mapErr((e) => problem(400, "bad body: ${e}"))
}

// A database error is the server's fault.
fn stored<T>(r: Result<T, sql.Error>) -> Result<T, http.Response> {
  return r.mapErr((e) => problem(500, "the database failed: ${e}"))
}

fn idIn(params: Map<string, string>) -> Result<int, http.Response> {
  let given = params["id"] ?? ""
  let id = given.toInt()
  if id == none {
    return Err(problem(404, "no item `${given}`"))
  }
  return Ok(id)
}

fn problem(status: int, message: string) -> http.Response {
  return http.jsonResponse(status, Problem { error: message })
}

fn open() -> Result<void, sql.Error> uses sql {
  sql.open("shop.db")?
  return migrate()
}

// `main` lists every effect the program uses.
fn main() uses io, env, sql, http, tasks {
  let port = env.get("PORT") ?? "8080"
  match open() {
    Ok() => {},
    Err(e) => {
      io.println("can't open the database: ${e}")
      return
    },
  }
  // 127.0.0.1: this machine only (":${port}" is every interface). A task per request.
  match http.serve("127.0.0.1:${port}", handle) {
    Ok() => {},
    Err(message) => io.println("can't serve: ${message}"),
  }
}

// Tests call `handle` with plain values; their database is SQLite in memory, fresh per test.
fn send(method: string, path: string, body: string) -> http.Response uses sql {
  return handle(http.Request { method, path, query: [:], headers: [:], body })
}
```

```candor
// shop_test.candor
module shop

test "an item is added and taken from" {
  assert migrate() == Ok()
  assert send("POST", "/items", """{"name": "wax", "stock": 3}""").status == 201
  assert send("POST", "/items/1/take", """{"n": 2}""").body == """{"id":1,"name":"wax","stock":1}"""
  assert send("POST", "/items/1/take", """{"n": 2}""").status == 409
}

test "what doesn't fit" {
  assert migrate() == Ok()
  assert send("GET", "/items/9", "").status == 404
  assert send("GET", "/items/x", "").status == 404
  assert send("POST", "/items", "{").body == """{"error":"bad body: $: not JSON: it ends too soon"}"""
  assert send("POST", "/items", """{"stock": 1}""").status == 400
  assert send("PUT", "/items", "").status == 405
}
```

## The language

Values never change behind your back: assigning or passing copies (cheaply). `let mut` to
reassign or change in place.

A newline ends a statement, except after an operator, `,`, `=` or an open bracket, and before
a line starting with `.method`: a long chain puts each call on its own line.

```candor
let shown = [3, -1, 2]
  .filter((x) => x > 0)
  .map((x) => "#${x}")
assert shown == ["#3", "#2"]
```

```candor
let n = 3
let mut total = 0
total += n
let size = if total > 2 { "big" } else { "small" }
let xs = [1, 2, 3]
let mut ys = xs
ys.push(4)
assert xs == [1, 2, 3] && ys.length() == 4
assert xs[5] == none                    // indexing gives an optional
let mut counts: Map<string, int> = [:]  // an empty literal needs its type from somewhere
counts["a"] = (counts["a"] ?? 0) + 1    // no `+=` on a map item: say what a missing key starts at
let ages: Map<string, int?> = ["bo": none]
assert ages["bo"] == none && ages["al"] == none   // an `int?` item: `m[k]` is an `int?`, never `int??`
let picked = if n > 9 { [] } else { [n] }         // `[]` takes its type from the other branch
assert picked == [3]
for (key, value) in counts {            // in the order the keys went in, unlike Go; JSON keeps it
  assert key == "a" && value == 1
}
for (i, x) in xs.enumerated() {
  assert xs[i] == x
}
for i in 0..3 {                         // 0, 1, 2
  total += i
}
let line = "${size}: ${total}"          // interpolation; `+` joins strings
let json = """{"a": 1}"""               // raw, may span lines
assert line == "big: 6" && json.length() == 8
let doubled = xs.map((x) => x * 2).filter((x) => x > 2)
assert doubled == [4, 6]
assert xs.all((x) => x > 0) && xs.fold(0, (acc, x) => acc + x) == xs.sum()
let pair = ("a", 1)
assert pair.0 == "a" && pair.1 == 1     // tuple items by position
assert (0..3) == [0, 1, 2]              // a range is a List<int> outside `for`
let digits = "a1b2".chars().filter((c) => c.isDigit())
assert digits == ['1', '2'] && digits.join("") == "12"   // chars are `char`, in single quotes
assert " v1.2/ ".trim().removePrefix("v").removeSuffix("/") == "1.2" && xs.reversed() == [3, 2, 1]
```

Comments are `//` only. There's no `!` to unwrap a `T?`: `x ?? fallback`, `if x != none`, or
`match`.

Strings: `"..."` takes the escapes `\n`, `\t`, `\r`, `\0`, `\\`, `\"`, `\$`, and `\u{1b}` for
any code point (1 to 6 hex digits; chars take it too). `"""` is raw: a
backslash is text, so JSON and regexes need no doubling, but `${...}` still interpolates. With
text after the opening `"""` it is one line. With the opening `"""` ending its line, the text is
the lines up to one holding only the closing `"""`: that line's indent is taken off every line,
and the newline before it is dropped (end with a blank line to keep one). A line starting left
of the closing `"""` is an error, as is text before it on its line.

```candor
let query = """
  SELECT id
  FROM items
  """
assert query == "SELECT id\nFROM items"
assert """a\n${1 + 1}""" == "a\\n2"
assert "say \"hi\"" == """say "hi" """.trim()
```

Reserved, so not names: `module fn uses let return true false if else match struct enum none
assert mut for in while break continue defer`.

Structs are nominal, every field given except optional ones (`T?`), which are `none` when left
out; `...` copies one with changes. Enum variants are
written with their enum, `Shape.Dot`. Where the enum is known, leave it out: `.Dot` in a pattern,
and in a value that goes where a `Shape` is expected (a return, an argument, a field, an annotated
`let`, `==`, a list item, `Ok(...)`/`Err(...)`). `match` must cover every case. An arm or branch
that ends in `return`, `break` or `continue` gives no value, so the others decide it: in a loop,
`let n = match s.toInt() { Ok(n) => n, Err(_) => continue }`. A module-level
`const` (`pub` to share it) is an int, float, string, bool or char known while compiling:
literals, other consts and operators on them.

```candor
struct Point {
  x: int
  y: int
}

enum Shape {
  Circle { r: int }
  Rect { corner: Point, w: int, h: int }
  Dot
}

fn area(s: Shape) -> int {
  return match s {
    Shape.Circle { r } => 3 * r * r,
    .Rect { w, h } => w * h,
    .Dot => 0,
  }
}

fn moved(p: Point) -> Point {
  return Point { ...p, x: p.x + 1 }
}

struct Due {
  at: int
  id: int
}

// Sorting by two things: a tuple key, compared item by item.
fn order(ds: List<Due>) -> List<int> {
  return ds.sortedBy((d) => (d.at, d.id)).map((d) => d.id)
}

// A const is worked out while compiling and never changes: literals and operators on them, or
// lists, maps and records of constants and function names (no calls, no lambdas).
const maxSide = 2 * 8
const kinds = ["dot", "circle", "rect"]

fn shapes() -> List<Shape> {
  return [.Dot, .Circle { r: 2 }, Shape.Rect { corner: Point { x: 0, y: 0 }, w: maxSide, h: 3 }]
}
```

Absence is `T?` with `none`, errors are `Result<T, E>`; no null, no exceptions. After
`if x == none { return ... }`, or a `match x` whose `none` arm returns, `x` is a `T` (fields
too). A name in a pattern takes the whole value, `none` included: `.File { path, size }` with
`size: int?` is one arm, its `size` an `int?`. After an arm that took `none` there it is the
present value: in `match x { none => ..., x => ... }` the second `x` is the `T`, and after
`.File { path, size: none }`, `.File { path, size }` has an `int`. `x.map(f)` reads
through a `T?` (there is no `?.`): `u.email.map((e) => e.length()) ?? 0`. `?` on a Result
returns its `Err` from the function, whose error type must be the same: `mapErr` converts,
`map` changes the value, `isOk()`/`isErr()` only say which it is (`assert r.isErr()`), and
`r.ok() ?? fallback` is the value or a fallback, the error dropped (`??` on the Result itself
is an error). An arm may list several patterns, `"rw" | "read-write" => ...`, that
bind the same names; `(_) => ...` ignores a lambda's argument.

```candor
struct User {
  name: string
  email: string?
}

enum ParseError {
  Empty
  NotANumber { text: string }
}

fn domain(u: User) -> string? {
  if u.email == none {
    return none
  }
  return u.email.split("@")[1]
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

fn emailLength(u: User) -> int {
  return u.email.map((e) => e.length()) ?? 0
}

fn describe(r: Result<int, ParseError>) -> string {
  return match r {
    Ok(0) | Ok(1) => "small",
    Ok(n) => "got ${n}",
    Err(ParseError.Empty) => "nothing",
    Err(ParseError.NotANumber { text }) => "not a number: ${text}",
  }
}
```

- Functions, not methods: `area(s)`. Traits (`trait`, `impl Ord for User`) are for generic
  code; `impl Show for T`, with no body, derives `"${t}"` as the literal (`T { x: 1, name: "a" }`),
  and a body writes it. Lists, maps (`["a": 1]`), optionals and Results show when their items do. A generic type's
  impl names its parameters: `impl<T: Show> Show for Box<T>`. A trait method may have a default
  body, which an impl may leave out or override, and `uses`, which every caller declares (an
  impl may use fewer). Generics:
  `fn first<T>(xs: List<T>) -> T?`.
- No shadowing: a `let` can't reuse a name in scope, a function's included (`fn req()` and
  `let req` clash), and so is an imported module's: `import "bytes" as b` frees `bytes` for a
  local. The one exception is a `match` arm binding its subject's name.
- A lambda's result comes from where it goes or from its returns; when neither says, annotate:
  `(x): Result<int, string> => ...`.
- A Result you don't use is an error: `?` it, or `match` it.
- `assert` is for `test` blocks only, which go in `x_test.candor` beside `x.candor`.
- `int` is 64 bits, and arithmetic that overflows panics with the line (as `/` by zero does);
  `a.wrappingMul(b)` and its kin wrap, for hashes. To sort by several things, give `sortedBy`
  a tuple, as `order` above, rather than packing numbers into one.
- Bits are methods, not operators: `a.and(b)`, `or`, `xor`, `a.not()`, `a.shl(k)`, `shr`
  (sign kept), `ushr` (zeros in), with `k` 0 to 63. Literals `0xff_ff` and `0b1010`.
- `float` is 64 bits, `1.5`, and never mixes with `int`: `n.toFloat()` one way, `f.round()`
  (`floor`, `ceil`, `truncate`) the other. NaN and infinity can't happen: `/` by zero and
  overflow panic. A percentage: `"${(done.toFloat() / total.toFloat() * 100.0).toFixed(1)}%"`.
- No `Math`: numbers have the methods, `a.max(b)`, `a.min(b)`, `x.pow(y)`, `x.abs()`; a list
  has `xs.max()` and `xs.min()`, a `T?` (`none` when empty). `%` works on floats too.
- `Bytes` are bytes, never changed, like a string; a byte is an int 0 to 255. `s.toBytes()`,
  `b.toText()` (a `string?`, `none` unless UTF-8; `b.toRawText()` keeps any bytes, as `fs.read` does), `b.at(i)`, `slice`, `concat`, `toHex()`,
  `toBase64()`; `import "bytes"` for `bytes.fromList(xs)`, `bytes.fromHex(s)` and
  `bytes.fromBase64(s)` (`none` if they aren't). In JSON, a base64 string.
- Charsets: `bytes.decode(b, "windows-1251")` reads text in another charset (a `string?`, `none`
  for a charset it doesn't know), `bytes.encode(s, "iso-8859-1")` writes it (`none` also when a
  character doesn't fit), by the labels browsers know, so a header's `charset=` goes in as it is.
  `bytes.charset(label)` gives the canonical name. `xml.parseWith(body, charset)` reads a feed in
  the header's charset over its declaration's.
- Gzip: `serve` gzips text-like responses for clients that take it, and the client un-gzips, so
  neither side does anything (`http.ServeOptions { gzip: false }` turns `serve`'s off).
  `bytes.gzip(b)` and `bytes.gunzip(b)` (a `Bytes?`) are for `.gz` files.
- Zip: `bytes.unzip(b, maxBytes)` reads an archive held in memory (an attachment, a body) into a
  `List<bytes.ZipEntry>` (`name`, `size`, `data`), or an `Err` saying what's wrong. `maxBytes`
  caps what it inflates to in all. Stored and deflate entries, CRC-checked; no writing.
- Hashing: `import "hash"`, Bytes in and Bytes out: `hash.sha256(s.toBytes()).toHex()`, also
  `sha1`, `sha512`, `md5`; `hash.hmacSha256(key, data)` (and `hmacSha512`, `hmacSha1`); `hash.equal(a, b)`
  compares signatures in constant time; `hash.sha256File(path)` (`uses fs`) reads a file a
  piece at a time.
- Regular expressions: `import "regex"`, Go's RE2 syntax (no backreferences or lookaround,
  linear time). `let r = regex.compile("^v([0-9]+)$")?` (a `RegexError` if it doesn't), then
  `regex.matches(r, s)`, `regex.find(r, s)` (a `Match?`: `text`, `start`, `end` in code
  points, `groups[1]`, `named["year"]`), `findAll`, `regex.replace(r, s, "$1")` (write
  `"\${name}"` for a named group), `regex.replaceWith(r, s, (m) => ...)`, `regex.split`, and
  `regex.quote(s)` for a literal. Backslashes double in a string: `"\\d+"`.
- HTML as text: `import "html"`, `html.toText(page)`: tags dropped, `head`/`script`/`style`
  and hidden parts left out, entities decoded, a line per block, blank lines where padding
  makes a gap, a row of plain cells as `a | b`, list items as `- `, a link's address after
  its text. Made for mail; it never fails.
- HTML as a tree: `html.parse(page)` gives the `<html>` element with `head` and `body` built
  as a browser builds them, `html.parseFragment(s)` the nodes of what goes in a `<body>` (feed
  content). Both are `xml.Node`, read with xml's lookups (`page.child("head").child("title")
  .text()`); names lower case, comments and DOCTYPE left out; neither fails.
  `html.encode(node)` and `html.encodeAll(nodes)` write HTML (`<br/>`, script text raw), not
  XML: a sanitizer reads a fragment, rebuilds what it allows, and writes it back.
- XML: `import "xml"`. `xml.parse(source)` reads a document into an `xml.Node`, leniently as
  feeds need (HTML entities, mismatched tags, control characters, the charset its declaration
  names; a document cut short gives what was read); `xml.parseStrict` refuses what isn't
  well-formed. Look up a step at a time: `doc.child("channel").children("item")`, `n.text()`
  (all the text inside; `ownText()` without its elements'), `n.innerXml()`, `n.attr("href")`
  (a `string?`); a missing child is an empty node, so chains go on, and `children(name).first()`
  tells. Names are local, `<dc:creator>` is `creator`, with its namespace in `n.space()`;
  `childIn(space, name)` when it matters. Write: `xml.element("outline", ["text": t], [...])`,
  `xml.text(s)`, then `xml.encode`, `xml.encodeIndented` or `xml.document` (with the
  declaration). Pass the bytes as they came (`b.toRawText()`), not text already converted.
  Too large to hold whole: `xml.elements(r, ["item", "entry"], start, (acc, item) => .Continue
  { value: ... })` reads from a reader, folds over each element with one of the names, and gives
  back `(acc, rest)`, the rest the document without them (`rest.child("channel").child("title")`).
- URLs: `import "url"` (it takes the name; `import "url" as u` frees `url` for a variable).
  `url.resolve(pageUrl, href)` reads a link as a browser does (`../x`, `//host/x`, `?page=2`), a
  `string?`. `url.parse(s)` is a `Url?`: `scheme`, `user`, `password`, `host`, `port` (an
  `int?`), `path` and `fragment` decoded, `query` as written; `url.format(u)` writes one back.
  `url.query(q)` is a `Map<string, List<string>>` in order; `url.encodeQuery(m)` writes one.
  `url.encode(s)`/`decode` for a query part (`+` is a space), `encodePath`/`decodePath` for a
  path segment.
- Encryption: `import "crypto"`. `crypto.deriveKey(passphrase, salt, crypto.Argon2 { time: 3,
  memoryKiB: 65_536, threads: 4 })` is a 32-byte key by argon2id (salt from `random.bytes(16)`,
  kept with the costs beside what it seals); `crypto.seal(key, plain)` (`uses random`) is
  AES-256-GCM, nonce first; `crypto.open(key, sealed)` is a `Result<Bytes, string>`, Err on a
  wrong key or changed bytes. A key of another length than 32 panics. In tests `random` is
  seeded, so sealed bytes are the same each run; the rest is real.

### A program in several files

`import "communication/mail"` reads `communication/mail.candor`, relative to the importing
file (`../shared/text` works too), and that file starts with `module mail`: the path's last part
is the module's name. Only what it marks `pub` is seen from outside (a struct's fields too, one
by one), used qualified:
`mail.Inbox`, `mail.sync(...)`. A module needs no `main`; one module per file, no cycles.

```
server/server.candor             module server; import "communication/mail"
server/communication/mail.candor module mail; import "store"   (a sibling: communication/store.candor)
server/communication/store.candor
```

`candor test server/server.candor` runs only that file's tests. Each module's own tests run
with `candor test server/communication/mail.candor`; `candor test` alone runs every file with
tests under the current folder (or `candor test server`, under one), with a total at the end.
`candor check` alone checks every file.

## Effects

Every function says what it may do with `uses`, and calling it needs the same in yours:
`io` (`println`, `eprintln` to stderr, `readLine` from stdin), `clock` (`now`, milliseconds
since 1970; `sleep`), `env` (`get`, `args`; `env.load(".env")?` reads a .env file, `uses env,
fs`, and a variable already set keeps its value), `random` (`int(1, 6)`, `uuid`, `token`, `bytes`, `shuffle`,
`pick`), `tasks` (concurrency), `http` (serve), `sql` and `fs` (files: `fs.read`,
`fs.write`, `fs.list`, `fs.readLines`, `fs.readBytes`, `fs.writeBytes`, `fs.readRange(path,
offset, length)` for a part of a file, `fs.info` for size and
modified time, `fs.rename`, `fs.copy`, `fs.removeAll`; `import "fs"`). A path from a request
goes through `fs.within(root, path)`, none if it would leave `root`; `fs.join(root, path)`
joins with the root's separator. `fs.watch(dir, start, (acc, c) => .Continue { value: ... })`
folds over changes under `dir` (`c.kind` `.Created`, `.Changed`, `.Removed`; `c.path` relative,
with `/`) until it returns `.Stop { value }` or the task ends; in a test, the test's own writes
are the changes. Given a file, it watches that file alone, removal and return included (a
config to reload). Readers and writers are functions: a reader `fn(int) -> Result<Bytes?,
string>` gives up to n bytes and `none` at the end, a writer `fn(Bytes) -> Result<void,
string>` takes a piece. `fs.reading(path, (r) => load(r))` and `fs.writing(path, (w) =>
save(x, w))` open one for the call (a write replaces the file only on `Ok`);
`bytes.collect((w) => ...)` and `bytes.reading(b, (r) => ...)` keep them in memory;
`bytes.readLines`, `readAll`, `copy`, `json.encodeTo`, `json.decodeFrom<T>` take them. A
function taking one writes `uses r`, so it stays pure on memory.
`main` lists them all. A lambda takes on the effects of what it calls; it doesn't write them.

A function type names its effects, `fn(string) -> string? uses sql`, and calling a value of it
needs them. A function that only calls a function it was given writes `uses f` for that
parameter instead: it takes on whatever each function passed does, so a pure helper stays pure
and only its callers (who pass a `uses sql` lookup, or a plain one in a test) declare `sql`:

```candor
fn keyOf(id: string, lookup: fn(string) -> string?) -> string uses lookup {
  return lookup(id) ?? id
}
```
There is no `exit`: `main` returns, or the task serving is cancelled (below). A `main` that
returns `Result<void, E>` exits with status 1 on an `Err`, printing it on stderr, so `?` works
in it. For another status, return `Result<void, Exit>`: `Exit` is built in, and
`Err(Exit { status: 2, message: usage() })` prints the message and exits 2. `import "flags"`:
`let (o, rest) = flags.parse(env.args(), Options { ... })?` reads Go-style flags into a
struct's fields (each field's comment is its help) and gives that Exit, with the usage, on a
mistake.

A time is an `int` of milliseconds, as `clock.now()` gives. `import "time"` reads and writes
them, in UTC and with no effect: `time.format(t)` (`"2026-10-25T10:00:00.000Z"`),
`time.parse(text)` (a `Result<int, string>`), `time.parts(t).weekday`, `time.addMonths(t, 1)`,
`t + time.days(7)`. For a zone's clocks, `time.zone("Europe/Oslo")` gives a `time.Zone?` (the
zone database is built in) for `time.partsIn(t, z)`, `time.formatIn(t, z)`,
`time.startOfDayIn(t, z)`, `time.inZone(z, 2026, 10, 28, 9, 0, 0)` (a time the clocks skip moves
on by the gap, as in Go). The zone the program runs in is `env.zone()`: `$TZ`'s, else the
machine's; an effect, as it depends on where the program runs (UTC in a test, until
`env.setZone(z)`). Other formats go by Go's layouts: `time.parseLayout("Tue, 27 Oct 2026
09:00:00 EST", "Mon, 02 Jan 2006 15:04:05 MST")`, with common zone abbreviations at their
offsets and others at offset 0, as Go reads them; `time.formatLayout(t, layout, z)`. To time
something finer than a millisecond, `clock.nanos()` counts nanoseconds. The rest is in
`std/time.candor`.

```candor
// greet.candor
fn greet(name: string) uses io {
  io.println("hi ${name}")
}

fn main() uses io, env {
  greet(env.get("USER") ?? "you")
}

// A command: reads stdin to the end, fails with status 1 on a bad argument.
fn count() -> Result<void, string> uses io, env {
  let word = env.args()[0] ?? ""
  if word.isEmpty() {
    return Err("usage: count <word>")
  }
  let mut n = 0
  while true {
    let line = io.readLine()
    if line == none {
      break
    }
    n += line.split(" ").filter((w) => w == word).length()
  }
  io.println("${word}: ${n}")
  return Ok()
}
```

```candor
// greet_test.candor
test "count" {
  env.setArgs(["a"])
  io.setInput("a b a\nb a")
  assert count() == Ok()
  assert io.output() == "a: 3\n"
}
```

In a `test` block every effect is a fake: `io.output()` gives what was printed (and
`io.errorOutput()` stderr), `io.setInput` gives what `readLine` reads, `env.set`
sets a variable, the clock is virtual (`clock.now()` starts at 0, not at today, and `sleep` takes no real
time), `random` gives the same values in every run (`random.seed(n)` for others),
`sql` is SQLite in memory, and `fs` a file system in memory, empty but for `.`.

## HTTP

- `http.serve(addr, handle)` runs `handle: fn(http.Request) -> http.Response` in a task per
  request until the task serving is cancelled; it gives `Err(message)` if it can't listen.
  Ctrl-C or SIGTERM stops it gracefully: requests in flight finish (up to 10 s,
  `ServeOptions { graceMs }`; event streams and WebSockets are cut at once), `serve` returns
  `Ok`, and `main` carries on after it. Return the `Err` from `main` (`-> Result<void, string>`)
  so a port already taken exits 1, not 0 with a message.
- `http.Request`: `method`, `path` (without the query), `query` and `headers` (both
  `Map<string, string>`, header names lowercase, a repeated key's first value), `body` (a
  string), `remote` (the client's IP, a `string?`: set by `serve`, none in a test's requests
  unless the test sets it) and `remotePort` (an `int?`, likewise). `headers["host"]` is the name
  and port the client reached, as sent: a loopback-only server checks it against DNS rebinding. `http.queryAll(req, "tag")` and `http.headerAll(req, name)` give
  every value, a `List<string>`; tests set them with `http.withQuery(req, "tag", ["a", "b"])`
  and `http.withHeader`.
- `http.Response`: `status`, `headers`, `body`. Build it with `http.jsonResponse(status, value)`,
  `http.textResponse(status, text)` or `http.emptyResponse(status)`, or as a struct.
  `http.addHeader(res, "set-cookie", "b=2")` sends one more of a header (two cookies);
  `http.responseHeaderAll(res, name)` reads them back in tests.
- Binary bodies: `body` holds them as they came, UTF-8 or not, and `req.body.toBytes()` (or
  `res.body.toBytes()`) gives the bytes exactly. Send them with
  `http.bytesResponse(200, "image/png", data)`, `http.postBytes(url, contentType, data)`,
  `http.withBody(req, data)` on a client request, or `http.writing(status, headers, (w) => ...)`
  streamed.
- Files: `http.serveDir("public", req.path.slice(8))` serves `/static/...`
  from `public` (a directory gives its `index.html`; `..` out of it is a 404), and
  `http.serveFile(path)` one file, its content type from `http.mimeType(path)`. Both `uses fs`.
  The server sends the file from disk and answers `Range` requests, so `<audio>` and `<video>`
  can seek; in a test the whole file is the body, and `http.served(req, handle(req))` gives what
  the server would send (206, 416, 304, HEAD). Their 404, 403, 416 and 500 have empty bodies.
- `http.route(req, "GET /items/{id}")` gives the path's parameters, `["id": "3"]`, or `none`.
  Ids come as strings: `.toInt()` gives an `int?`.
- The client, in the same `http` effect: `http.get(url)`, `http.post(url, body)`,
  `http.postJson(url, value)`, or `http.send(req)` with a request from `http.request(method, url)`
  changed with `...` (`headers`, `body`, `timeoutMs`, 30 000 by default). Each gives
  `Result<http.Response, http.HttpError>`; any status is an `Ok`, and `HttpError` is `.Failed`
  or `.Timeout`. `http.addRequestHeader(req, name, value)` sends a header once more;
  `http.responseHeaderAll(res, name)` reads every value of one the server sent twice.
  Redirects are followed, up to 10; `res.url` is where it landed. `redirects: 0` on the request
  gives the redirect itself (`res.headers["location"]`), `redirects: n` follows at most n.
  `timeoutMs: 0` waits for as long as it takes; a `host` header is the Host sent;
  `compressed: false` asks for no gzip, `keepAlive: false` closes the connection after.
- In tests the client gets a fake: `http.respond(url, status, body)`, `http.respondWith(url,
  res)` for a whole Response (a redirect's `location`), or `http.answer(handle)` to answer with
  a handler; it follows redirects too. `http.requests` (or `http.sent()`) lists what was sent. The handler
  may use `clock`: one that sleeps past the request's `timeoutMs` gives `.Timeout`, in virtual
  time.
- Streaming, with readers and writers as `bytes` has them: `http.writing(status, headers, (w) =>
  { w(piece)?; return Ok() })` sends a body a piece at a time, each as it is written; a write to
  a client that has gone is an `Err`, and an `Err` from the function cuts the connection (the
  client sees a broken body). `http.serveWith(addr, http.ServeOptions { largeBodies: ["POST
  /upload"] }, handle)` leaves those routes' bodies unread (others are read whole, up to 1 MiB);
  the handler reads one with `http.reading(req, (r) => bytes.copy(r, w))`. In tests,
  `http.bodyOf(res)` gives a written body whole and `http.streamed(req, pieces)` makes a streamed
  request. A client reads a body as it comes with `http.openStream(req)` and
  `http.readingResponse(res, (r) => ...)`. The older `streamResponse`, `streamBytes`, `readBody`
  and `readResponse` (a fold over string pieces) still work.
- Forms and uploads: `http.readForm(req, maxBytes)` reads a `multipart/form-data` body (a
  browser's FormData) or a urlencoded one, whole, into `http.Form { fields, files }`: `fields`
  maps each name to its values, each file is `http.FormFile { field, name, contentType, bytes }`.
  `Err(.TooLarge { limit })` past `maxBytes` (answer 413), `.NotAForm`, `.Malformed` or `.Broken`
  otherwise. On a `largeBodies` route it reads the stream. In tests,
  `http.formRequest("POST", "/upload", form)` makes the request a browser would send.
- Server-sent events: `http.events([:], (send) => { send(http.Event { data: "...", id: "1" }) })`
  sends them until the function returns or the client goes away (`req.headers["last-event-id"]`
  on a reconnect); `http.eventsOf(res)` reads them back in a test. The client is a fold:
  `http.listen(url, start, (acc, event) => ...)`, resuming a broken stream from its last id.
- WebSockets: `return http.upgrade(req, (ws) => ...)`, then `ws.send(text)` and `ws.receive()`
  (`none` once the client goes) for as long as the function runs. Binary messages:
  `ws.sendBytes(b)`, and `ws.receiveMessage()` gives `.Text { text }` or `.Binary { data }`
  (`receive` skips binary ones). A test
  plays the client: `let client = http.socketOf(s, handle(req))` inside `tasks.scope((s) =>
  ...)` runs the handler in a task and gives the other end. The client:
  `http.connect("ws://host/chat", (ws) => ...)?` (`http.connectWith(req, talk)` sends headers)
  closes the connection when its function returns. In tests, a handler given to `http.answer`
  that answers with `http.upgrade` is the server, in memory.

```candor
module prices

import "http"
import "json"

struct Price {
  item: string
  cents: int
}
impl Json for Price

fn price(item: string) -> Result<int, string> uses http {
  let res = http.get("https://prices.example/items/${item}").mapErr((e) => "${e}")?
  if res.status != 200 {
    return Err("status ${res.status}")
  }
  return Ok(json.decode<Price>(res.body).mapErr((e) => e.message)?.cents)
}

fn main() {}
```

```candor
// prices_test.candor
module prices

test "price reads the reply" {
  http.respond("https://prices.example/items/tea", 200, """{"item": "tea", "cents": 250}""")
  assert price("tea") == Ok(250)
  assert http.sent().length() == 1
}
```

## JSON

`impl Json for T`, with no body, derives it; the types of its fields need their own. Fields are
named as written, or by a rule for the whole type, `impl Json(snake) for T` (`kebab`, `camel`,
`pascal`), and `as "type"` after a field or variant names that one. An object's fields come in
the struct's order. A `T?` field that is
`none` is left out (`null` inside a list or map), or written `null` with `impl Json(nulls) for T`
(`impl Json(snake, nulls)` with a rule), and decoding a missing one or `null` gives `none`;
a struct literal takes a plain `T` for it (`note: "x"`, no wrapping);
`json.decode` skips fields it doesn't know, `json.decodeStrict` refuses them.
`json.encode` writes compact JSON; `json.encodeIndented` two spaces a level, as
`JSON.stringify(v, null, 2)`, for files people read and diff. An enum without fields is its variant's name, `"Dot"`, or what the rule or `as` makes it.

A form of your own goes via a type that is `Json`: `impl Json for Money via string` with
`fn toJson(self) -> string` and `fn fromJson(s: string) -> Result<Money, string>`; an `Err` is a
decode error at that value's path.

JSON whose shape no type gives is a `json.Value`: `json.decode<json.Value>(text)`, or a field of
that type inside a typed struct. It is an enum, `.Null`, `.Bool { value }`, `.Int { value }`,
`.Float { value }`, `.Text { value }`, `.List { items }`, `.Object { fields }` (keys in order),
encoded back as the JSON it holds. A number also keeps its `text` as written when `value`
would write differently (`1.50`, `1e3`, digits past int64), so it passes through unchanged;
a decoded `12` still equals `.Int { value: 12 }`. Its methods chain, giving `.Null` for what isn't there:
`v.get("key")`, `v.at(1)`, then `v.text()`, `int()`, `float()`, `bool()` (each an optional),
`items()`, `fields()`.

```candor
// app.candor
import "json"

enum Level {
  Low
  High
  VeryHigh as "severe"
}
impl Json(snake) for Level

struct Reading {
  level: Level
  readAt: int
  note: string?
}
impl Json(snake) for Reading
```

```candor
// app_test.candor
test "round trip" {
  assert json.encode(Reading { level: Level.High, readAt: 5, note: none }) == """{"level":"high","read_at":5}"""
  assert json.decode<Reading>("""{"level": "severe", "read_at": 1}""") == Ok(Reading { level: Level.VeryHigh, readAt: 1, note: none })
  let bad = json.decode<Reading>("""{"level": 3, "read_at": 1}""")
  assert bad.mapErr((e) => e.path) == Err("$.level")
  let typo = json.decodeStrict<Reading>("""{"level": "low", "readAt": 1}""")
  assert typo.mapErr((e) => e.path) == Err("$.readAt")
}

test "any shape" {
  let v = json.decode<json.Value>("""{"vcard": ["fn", {}, "text", "Acme"], "n": 3}""")
  assert v.map((x) => x.get("vcard").at(3).text()) == Ok("Acme")
  assert v.map((x) => x.get("missing").at(0).text()) == Ok(none)
  assert v.map((x) => "${x}") == Ok("""{"vcard":["fn",{},"text","Acme"],"n":3}""")
}
```

## SQL

`sql.open(path)` once (`":memory:"` works), then `sql.exec` (rows changed), `sql.insert` (the
new id), `sql.query<T>` (rows as a `List<T>`, `T` with `impl Row`, its fields the columns
by name; or `int`, `string`, `bool` for one column) and `sql.queryOne<T>` (a `T?`; more than one
row is an `Err`). The query is a string literal whose `${...}` are parameters, never spliced
in: int, string, bool, float, Bytes, or an optional of them (none is NULL, and so is `${none}`).

Queries are checked as the program compiles, against the tables the program's own migrations
make (the `CREATE TABLE` and `ALTER TABLE` in its `sql.exec` calls): a misspelt column, a string
into an INTEGER column, a nullable column read into a field that isn't `T?`, a NOT NULL column
an INSERT leaves out, a column typed `string` or `json` (SQLite stores "50" there as a number:
write TEXT), a `sum(x)` (NULL over no rows) read into an `int`: give it a default,
`coalesce(sum(x), 0)`. Joins, aliases, upserts, subqueries, UNION, RETURNING, WITH, row values,
window functions and fts5 tables (`CREATE VIRTUAL TABLE s USING fts5(title, body)`, then
`WHERE s MATCH ${q} ORDER BY rank`; no fts4) are checked; a recursive WITH isn't, and `candor check` notes it. `sql.transaction(f, wrap)`: `f`'s `Ok` commits, an `Err`, a crash or a cancel rolls
back; `wrap` turns a failed BEGIN or COMMIT into your error type, `(e) => e` when it's
`sql.Error`. See `take` above.

A second file: `sql.attach("data/vault.db", "vault")` after `sql.open` (not in a transaction;
in a test, a fresh one in memory). Its migrations and queries name its tables
`vault.secrets`, checked like the rest, and a join may read both files. Attaching the same
file as the same name again is Ok and changes nothing, so a test can start the app twice.

A SQL function written in Candor, for a trigger or an index to call:
`sql.function("strip_html", stripHtml)?` before `sql.open` (in a test, before the first query).
The name is a literal SQLite doesn't have; the function is named, has no `uses`, and takes and
gives int, float, string, bool, Bytes or a `T?` of one (none is NULL), or gives a
`Result<T, string>` whose `Err` fails the statement. The check knows it: the arguments a call
gives it, and the type it returns.

## DNS and TCP

`import "net"`, `uses net`: `net.lookupA`, `lookupAaaa`, `lookupNs` and `lookupTxt` give a
`List<string>` (TXT: one item per record, its strings joined), `lookupCname` a `string`,
`lookupMx` a `List<net.Mx>` (`host`, `priority`, lowest first); a lookup gives up after 5 s.
`net.reachable(host, port, timeoutMs)` connects and closes again: the milliseconds it took, or
a `net.NetError` (`.NotFound`, `.Timeout`, `.Refused`, `.Failed`). In a test nothing resolves
and every port refuses until the test sets it; time passes on the fake clock.

```candor
// spf.candor
import "net"

fn spf(domain: string) -> string? uses net {
  return match net.lookupTxt(domain) {
    Ok(txt) => txt.filter((t) => t.startsWith("v=spf1"))[0],
    Err(_) => none,
  }
}
```

```candor
// spf_test.candor
test "records and ports come from the test" {
  net.setRecords("example.org", .Txt, ["v=spf1 -all"])
  net.setMx("example.org", [net.Mx { host: "mx1.example.org", priority: 10 }])
  net.setReachable("example.org", 443, 40)
  assert spf("example.org") == "v=spf1 -all" && spf("other.org") == none
  assert net.lookupMx("example.org").map((mx) => mx.length()) == Ok(1)
  assert net.reachable("example.org", 443, 1_000) == Ok(40) && clock.now() == 40
  assert net.reachable("example.org", 25, 1_000) == Err(.Refused)
}
```

`examples/infra.candor` checks a domain's mail and web port.

## Running programs

`import "exec"`, `uses exec`: `exec.command(program, args)`, then `exec.withDir`, `withEnv`,
`withStdin(bytes)`, `withStdinText(text)`, `withStdinFile(path)` (streamed from disk) or
`withArgv0(name)` (the name it's told it was run as).
`exec.run(cmd, start, each)` folds over the output a line at a time while the program runs
(`line.text`, `line.fromStderr`, `line.ending`) and gives an `exec.Finished` with the exit
`code` and the fold's `value`; `exec.output(cmd)` waits for all of it (`code`, `stdout`,
`stderr`, and `combined`, both in the order printed), exactly as printed. A non-zero exit is
not an `Err`: only a program that can't start is (`.NotFound`, `.Failed`). For bytes, not
lines: `exec.reading(cmd, (r) => ...)` reads stdout with a reader, and `exec.piping(cmd, (w) =>
feed(w), (r) => ...)` also writes stdin from a task of its own (`uses tasks`), so a full pipe
can't stall it; stdin ends when the feed returns. Both give an `exec.Piped` (`code`, `value`,
`stderr`). In a test a scripted stdout line is one read, and what was written is the stdin in
`exec.ran()`. Cancelling the task
kills the program; with `exec.withStop(cmd, .Terminate, graceMs)` it is sent the signal and
killed only if still running `graceMs` later, the task waiting for it, and
`exec.withOwnGroup(cmd)` gives it a process group of its own so what it started stops too (both
Unix only; on Windows a cancel kills). `env.pid()` is this process's id. In a test nothing runs: `exec.script(program, lines, code)` says what a
program prints (`exec.out(text)`, `exec.err(text)`), `exec.scriptSlow(..., ms)` makes it take
test time (for `tasks.timeout`), and `exec.ran()` lists the commands, stdin included.

```candor
// build.candor
import "exec"

fn build(dir: string) -> Result<int, string> uses exec {
  let cmd = exec.withDir(exec.command("make", ["site"]), dir)
  let done = exec.run(cmd, 0, (n, line) => n + 1).mapErr((e) => e.toString())?
  return if done.code == 0 { Ok(done.value) } else { Err("make exited ${done.code}") }
}
```

```candor
// build_test.candor
test "make's output is counted, a failure reported" {
  exec.script("make", [exec.out("cc a.c"), exec.err("warning: x")], 0)
  assert build("site") == Ok(2)
  assert exec.ran().map((c) => c.dir ?? ".") == ["site"]
  exec.script("make", [], 2)
  assert build("site") == Err("make exited 2")
}
```

`examples/deploy.candor` pipes a tarball into `ssh` and streams the release's output.

## Mail

`import "mime"`: `mime.parse(raw)` reads a raw message (Bytes, as IMAP fetches it) into a
`mime.Message`: `messageId`, `inReplyTo` and `references` (ids without angle brackets),
`subject`, `date` (ms, or none), `from` (an `Address?`), `to`, `cc`, `replyTo` (`name`,
`address`), `text` and `html` decoded from any charset and transfer encoding (an HTML-only
mail has no `text`: `m.text ?? html.toText(m.html ?? "")`), `attachments`
(`filename`, `contentType`, `size`, `contentId`, `inline`, `data`), and every header by
lowercase name (`mime.header(m, "list-id")`). `mime.compose(draft)` (`uses random, clock`)
writes a UTF-8 plain-text message and gives its new `messageId`, the envelope's `from` and
`recipients`, and the `data` to send.

```candor
// app.candor
import "mime"
```

```candor
// app_test.candor
test "a reply keeps the thread" {
  let raw = "From: Ada <ada@example.com>\r\nMessage-ID: <1@example.com>\r\nSubject: hi\r\n\r\nhello\r\n"
  let m = match mime.parse(raw.toBytes()) {
    Ok(m) => m,
    Err(e) => {
      assert e.toString() == ""
      return
    },
  }
  assert m.text == "hello\r\n" && m.from.map((a) => a.name) == "Ada"
  let id = m.messageId ?? ""
  let out = mime.compose(mime.Draft {
    from: mime.Address { name: "Dev", address: "dev@example.org" },
    to: [mime.Address { name: "Ada", address: "ada@example.com" }],
    subject: "Re: hi",
    text: "Thanks!",
    inReplyTo: id,
    references: [id],
  })
  assert out.recipients == ["ada@example.com"]
  assert out.messageId.endsWith("@example.org")
}
```

`import "imap"`, `uses imap`: `imap.session(account, work)` logs in (`imap.Account { host,
port, user, password }`, implicit TLS on 993), runs `work` with the session and logs out,
however `work` ends. In it: `imap.folders(s)` (each with its `specialUse`, `.Sent` among them),
`imap.select(s, folder)` (read-only: `uidValidity`, `count`, `uidNext`), `imap.fetch(s, from,
to)` by sequence number (1 is the oldest) and `imap.fetchAbove(s, uid)` for what came after a
UID. A fetched message has its `uid`, `date` and `source` for `mime.parse`; fetching marks
nothing seen. UIDs hold only within one `uidValidity`: keep both, and start over when it
changes. In a test: `imap.addMessage(folder, raw, date)`, `imap.addFolder(name, .Sent)`,
`imap.setUidValidity(folder, n)`, `imap.refuseLogin(message)`, `imap.openSessions()`.

```candor
// mail.candor
import "imap"

// The UIDs above `last` in INBOX, or the newest 50 when `last` is none.
fn newUids(account: imap.Account, last: int?) -> Result<List<int>, imap.ImapError> uses imap {
  return imap.session(account, (s) => {
    let inbox = imap.select(s, "INBOX")?
    let got = match last {
      none => imap.fetch(s, (inbox.count - 49).max(1), inbox.count)?,
      uid => imap.fetchAbove(s, uid)?,
    }
    return Ok(got.map((m) => m.uid))
  })
}
```

```candor
// mail_test.candor
test "only what came since" {
  let account = imap.Account { host: "imap.example.com", port: 993, user: "me", password: "app" }
  imap.addMessage("INBOX", "Subject: a\r\n\r\nx".toBytes(), 0)
  assert newUids(account, none) == Ok([1])
  imap.addMessage("INBOX", "Subject: b\r\n\r\ny".toBytes(), 0)
  assert newUids(account, 1) == Ok([2])
  assert imap.openSessions() == 0
}
```

`import "smtp"`, `uses smtp`: `smtp.send(account, composed)` sends what `mime.compose` wrote
from its From to its To and Cc; `smtp.verify(account)` logs in and sends nothing (an app
password that reads mail may still be refused here). Port 465 is implicit TLS, any other port
must offer STARTTLS. `smtp.SmtpError`: `.Connect`, `.Login`, `.Recipient`, `.Timeout`,
`.Failed`. In a test: `smtp.sent()` (each with `from`, `recipients`, `message`),
`smtp.refuseLogin(message)`, `smtp.refuseRecipient(address)`. `examples/mailcheck.candor` checks
a real mailbox both ways.

## Shared state, workers, shutdown

Tasks live in a scope and end before it does. Tasks share only what the scope makes: a
`Mutex<T>` (`get`, `update(f)`, `updateWith(f)` giving a result back), an `Atomic<T>` and a
`Channel<T>` (`send`, `recv() -> T?`, `close`, `for x in ch`). `tasks.race` runs functions at
once, and the first to finish cancels the rest (for a `Result`, the first `Ok`: an `Err` waits for
the others, and comes back only if all fail); `tasks.timeout(ms, f)` gives `none` if `f`
took too long; `tasks.both`, `tasks.all`, `tasks.select` and `s.spawn(f).join()` are in the
reference. `s.background(f)` starts a task that never needs to end on its own, a watcher or a
server beside the work: the scope cancels it once its function has returned and its other tasks
have ended. `env.signals(s, [.Interrupt, .Terminate])` gives a channel of the signals the process
is sent, until the scope ends; a background task reading it can stop the work.

Check and change in one `updateWith`: `if m.get()...` followed by `m.update(...)` lets another
task change the value in between. The function given to `update` can't use another Mutex (so
Mutexes never deadlock), so state that is checked together lives in one Mutex: a topic registry
and each client's budget, checked in one step, are two fields of one struct, and
`updateWith((st) => ...)` gives back `(st, false)` to refuse.

A Mutex's functions only compute. For work under a lock that uses effects, such as reading a
file, changing it and writing it back, use a `Lock`: `let lock = s.lock()`, then
`lock.hold(() => { ... })` runs the function while no other task holds it, and gives back what
it returns. A task holds one Lock at a time (a `hold` inside a `hold` panics), so what is
changed together goes under one Lock.

```candor
import "fs"

fn bump(lock: Lock, file: string) -> Result<void, fs.FsError> uses fs {
  return lock.hold(() => {
    let n = (fs.read(file)?).toInt() ?? 0
    fs.write(file, (n + 1).toString())?
    return Ok()
  })
}
```

This one queues orders for a pool of workers, and stops on `POST /shutdown`: the server races
a task that waits for the store to say so, and the race cancels the server.

```candor
module orders

import "http"
import "json"

enum State {
  Waiting
  Working
  Done
}

// Everything the requests and the workers share, under one Mutex.
struct Store {
  orders: Map<int, State>
  next: int
  closing: bool
}

struct View {
  id: int
  state: string
}
impl Json for View

struct Problem {
  error: string
}
impl Json for Problem

// Changes to the store are plain functions; the Mutex runs them one at a time.
fn added(st: Store) -> (Store, int) {
  let mut orders = st.orders
  orders[st.next] = State.Waiting
  return (Store { ...st, orders, next: st.next + 1 }, st.next)
}

fn moved(st: Store, id: int, to: State) -> Store {
  let mut orders = st.orders
  orders[id] = to
  return Store { ...st, orders }
}

fn label(s: State) -> string {
  return match s {
    State.Waiting => "waiting",
    State.Working => "working",
    State.Done => "done",
  }
}

// Takes orders until the queue is closed and empty.
fn worker(store: Mutex<Store>, queue: Channel<int>) uses clock {
  for id in queue {
    store.update((st) => moved(st, id, State.Working))
    clock.sleep(100)
    store.update((st) => moved(st, id, State.Done))
  }
}

fn handle(req: http.Request, store: Mutex<Store>, queue: Channel<int>) -> http.Response {
  if http.route(req, "POST /orders") != none {
    let id = store.updateWith((st) => added(st))
    queue.send(id)
    return http.jsonResponse(201, View { id, state: "waiting" })
  }
  let one = http.route(req, "GET /orders/{id}")
  if one != none {
    let id = (one["id"] ?? "").toInt() ?? 0
    let state = store.get().orders[id]
    if state == none {
      return problem(404, "no order ${id}")
    }
    return http.jsonResponse(200, View { id, state: label(state) })
  }
  if http.route(req, "POST /shutdown") != none {
    store.update((st) => Store { ...st, closing: true })
    return http.Response { status: 202, headers: ["content-type": "application/json"], body: "{}" }
  }
  return problem(404, "no route ${req.method} ${req.path}")
}

fn problem(status: int, message: string) -> http.Response {
  return http.jsonResponse(status, Problem { error: message })
}

fn closing(store: Mutex<Store>) uses clock {
  while !store.get().closing {
    clock.sleep(10)
  }
}

fn main() uses io, env, http, tasks, clock {
  let port = env.get("PORT") ?? "8080"
  let workers = (env.get("WORKERS") ?? "4").toInt() ?? 4
  let served = tasks.scope((s) => {
    let store = s.mutex(Store { orders: [:], next: 1, closing: false })
    let queue: Channel<int> = s.channel(1000)
    for _ in 0..workers {
      s.spawn(() => worker(store, queue))
    }
    let result = tasks.race([() => http.serve("127.0.0.1:${port}", (req) => handle(req, store, queue)), () => {
      closing(store)
      return Ok()
    }])
    // The workers finish what is queued; the scope waits for them.
    queue.close()
    return result
  })
  match served {
    Ok() => io.println("stopped"),
    Err(message) => io.println("can't serve: ${message}"),
  }
}

fn request(method: string, path: string) -> http.Request {
  return http.Request { method, path, query: [:], headers: [:], body: "" }
}
```

```candor
// orders_test.candor
module orders

// Tests run tasks one at a time, in 100 seeded orders (half PCT), on virtual time.
test "an order is worked" {
  tasks.scope((s) => {
    let store = s.mutex(Store { orders: [:], next: 1, closing: false })
    let queue: Channel<int> = s.channel(10)
    s.spawn(() => worker(store, queue))
    assert handle(request("POST", "/orders"), store, queue).status == 201
    clock.sleep(150)
    assert handle(request("GET", "/orders/1"), store, queue).body == """{"id":1,"state":"done"}"""
    queue.close()
  })
}
```

`defer { ... }` at the top level of a function body runs when the function ends, however it
ends: `return`, `?`, a crash, or its task cancelled. The last `defer` runs first. Use it to
give back what the function took from shared state, such as a subscriber's place in a
`Mutex<Map<...>>`. The body can use effects even while its task is being cancelled. It can't
`return`, use `?`, or change the function's variables, since they are gone by then.

## Tests

A module's tests go in their own file beside it: `app.candor`'s in `app_test.candor`, which
starts with the same `module` line and sees the module's private names and imports (Go's
`_test.go`). A test in `app.candor` itself is an error (CAN0063). `candor build` and `run` leave
the test file out; `candor test app.candor` or `candor test app_test.candor` runs it.

`test "name" { ... }` holds `assert`s (on failure it shows the value of each part). Tests call functions directly with plain values; give `handle` a
`http.Request` rather than starting a server. `candor test app_test.candor:42` runs the test
holding line 42, `--only "name"` those whose name contains it; `--seed N` replays a task order a failure
printed; `--json` prints a JSON line per test as it ends, then the totals.

Setup and checks that several tests share go in a `test fn`: like a test it may `assert` and
use the fakes' own functions (`exec.script`, `io.output()`, ...), and only tests and other test
fns can call it; `candor build` leaves it out. It declares its effects as any function does, and
gets the calling test's fakes. A failing `assert` inside one fails the test, with the trace back
to it. A `pub test fn`, in a module's own file, shares one with other modules' tests.

```candor
// app.candor
import "exec"

fn gitVersion() -> string uses exec {
  return match exec.output(exec.command("git", ["--version"])) {
    Ok(out) => out.stdout.trim(),
    Err(e) => "${e}",
  }
}
```

```candor
// app_test.candor
test fn ranOnce(program: string) -> exec.Command uses exec {
  let ran = exec.ran()
  assert ran.length() == 1
  assert ran[0].map((c) => c.program) == program
  return ran[0] ?? exec.command(program, [])
}

test "asks git its version" {
  exec.script("git", [exec.out("git version 2.49")], 0)
  assert gitVersion() == "git version 2.49"
  assert ranOnce("git").args == ["--version"]
}
```

Fixtures: `embed("testdata/feed.xml")` is that file's text, read when the program compiles and
built into it (the test's `fs` is an empty fake, so reading the file at run time finds nothing).
The path is a literal, relative to the file that names it; a missing file is a compile error.
`embed<Bytes>("testdata/logo.png")` gives any file's bytes; a string needs UTF-8. It works
outside tests too, for files a program serves or templates it fills.

To step through a program, `candor debug app.candor` runs it under Delve (`go install
github.com/go-delve/delve/cmd/dlv@latest`): `break app.candor:12`, `continue`, `next`, `print
total`, `locals`, `bt`. Lines are the Candor file's and locals keep their names; functions and
types show as Go has them, `main.app__total` for `total` in module `app` (`ctx__` is the hidden
context). `--init cmds.txt` runs Delve commands first; `--` passes arguments to the program.

## What the compiler will tell you

The mistakes newcomers make most, each its own error with the fix in its help line:

```candor wrong CAN0002
enum State {
  Queued
  Done
}

fn first() -> State {
  return Queued
}
```

`State.Queued`, always.

```candor wrong CAN0036
fn count(words: List<string>) -> Map<string, int> {
  let mut m: Map<string, int> = [:]
  for w in words {
    m[w] += 1
  }
  return m
}
```

`m[w] = (m[w] ?? 0) + 1`: a missing key has no value to add to.

```candor wrong CAN0049
import "sql"

fn clear() uses sql {
  sql.exec("DELETE FROM items")
}
```

A dropped Result: make `clear` return one and `?` it, or `match` it.

```candor wrong CAN0032
fn main() {
  let empty = []
}
```

`let empty: List<int> = []`: an empty list, map or `none` needs its type from somewhere. For a
`fold` that starts empty, annotate the lambda's `acc`: `xs.fold([], (acc: List<int>, x) => ...)`.
