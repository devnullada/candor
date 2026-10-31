# Candor for an agent: a service

A whole service for [`docs/agent.md`](agent.md)'s reader writing one: HTTP, JSON, SQLite, its
test, what a service reaches for, and shared state with a shutdown. Concurrency, tests and the
standard modules are in [`docs/agent-more.md`](agent-more.md). Every block here compiles
(`test/start.test.ts`).

## A whole service

JSON over HTTP, kept in SQLite. `handle` is the service and takes plain values, so tests call
it; `main` serves it.

```candor
// app.candor
import "http"
import "json"
import "sql"

struct Room {
  id: int
  name: string
}
impl Json for Room
impl Row for Room

// A request body. A missing or mistyped field fails `json.decode`; a `T?` field may be missing.
struct NewRoom {
  name: string
}
impl Json for NewRoom

struct Problem {
  error: string
}
impl Json for Problem

// The migration also tells the compiler the tables, to check every query against.
fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")?
  return Ok()
}

fn handle(req: http.Request) -> http.Response uses sql {
  return match route(req) {
    Ok(res) => res,
    Err(res) => res,
  }
}

// An error is an `Err(response)`, so `?` answers early.
fn route(req: http.Request) -> Result<http.Response, http.Response> uses sql {
  // No method in the pattern: every method matches, and a wrong one gets a 405.
  if http.route(req, "/rooms") != none {
    if req.method == "GET" {
      return Ok(http.jsonResponse(200, stored(sql.query<Room>("SELECT id, name FROM rooms ORDER BY id"))?))
    }
    if req.method != "POST" {
      return Err(problem(405, "/rooms takes GET or POST"))
    }
    let body = json.decode<NewRoom>(req.body).mapErr((e) => problem(400, "bad body: ${e}"))?
    let name = body.name.trim()
    if name.isEmpty() {
      return Err(problem(400, "`name` is blank"))
    }
    // Each `${...}` in a query is a parameter, not text.
    let id = stored(sql.insert("INSERT INTO rooms (name) VALUES (${name})"))?
    return Ok(http.jsonResponse(201, Room { id, name }))
  }
  // With a method, the others fall through to the 404.
  let one = http.route(req, "GET /rooms/{id}")
  if one != none {
    let id = (one["id"] ?? "").toInt()
    if id == none {
      return Err(problem(404, "no room"))
    }
    let room = stored(sql.query<Room>("SELECT id, name FROM rooms WHERE id = ${id}"))?.first()
    if room == none {
      return Err(problem(404, "no room ${id}"))
    }
    return Ok(http.jsonResponse(200, room))
  }
  return Err(problem(404, "no route ${req.method} ${req.path}"))
}

// A database error is the server's fault.
fn stored<T>(r: Result<T, sql.Error>) -> Result<T, http.Response> {
  return r.mapErr((e) => problem(500, "the database failed: ${e}"))
}

fn problem(status: int, message: string) -> http.Response {
  return http.jsonResponse(status, Problem { error: message })
}

// There is no `exit`: an `Err` from `main` prints it and exits 1. `Result<void, Exit>`
// (built in) picks the status: `Err(Exit { status: 2, message: usage() })`.
fn main() -> Result<void, string> uses env, sql, http, tasks {
  let port = env.get("PORT") ?? "8080"
  sql.open(env.get("DB") ?? ":memory:").mapErr((e) => "can't open the database: ${e}")?
  migrate().mapErr((e) => "can't migrate: ${e}")?
  // 127.0.0.1 is this machine only. A task per request; returns when the server stops.
  return http.serve("127.0.0.1:${port}", handle)
}
```

```candor
// app_test.candor
fn send(method: string, path: string, body: string) -> http.Response uses sql {
  return handle(http.Request { method, path, query: [:], headers: [:], body })
}

test "a room is added and read back" {
  assert migrate().isOk()
  assert send("POST", "/rooms", """{"name": " Fjord "}""").status == 201
  assert send("GET", "/rooms/1", "").body == """{"id":1,"name":"Fjord"}"""
  assert send("DELETE", "/rooms", "").status == 405
  assert send("POST", "/rooms", "{").status == 400
}
```

What a service reaches for; the head of `std/http.candor`, `json`, `sql` has the rest:

- `http.Request { method, path, query, headers, body, remote }`: `path` without the query,
  header names lowercase, `remote` the client's IP (`string?`). `http.Response { status,
  headers, body }`.
- `http.route(req, "GET /rooms/{id}") -> Map<string, string>?`.
- `http.jsonResponse(status, value)`, `textResponse(status, text)`, `emptyResponse(status)`,
  `bytesResponse(status, contentType, bytes)`; `http.addHeader(res, name, value)`.
- `http.serve(addr, handle) -> Result<void, string>`: a task per request. Ctrl-C or SIGTERM lets
  the requests in flight finish (up to 10 s) and returns `Ok`. Bodies over 1 MiB get a 413
  unless `http.serveWith(addr, http.ServeOptions { largeBodies: ["POST /files"] }, handle)`.
- `json.decode<T>(text) -> Result<T, json.Error>` skips fields it doesn't know (`decodeStrict`
  refuses them); `json.encode(v)`. A `none` field is left out unless `impl Json(nulls) for T`;
  `impl Json(snake)` renames every field, `kind_: string as "type"` one. Any shape:
  `json.decode<json.Value>(text)`, then `v.get("items").at(0).int()` (an `int?`).
- `sql.exec(q)` gives the rows changed, `sql.insert(q)` the new id, `sql.queryOne<T>(q)` a `T?`.
- Read, check and write in one `sql.transaction(() => { ...; return Ok(x) }, (e) => wrap(e))`:
  a check then an insert outside one races with the next request. Inside, `?` takes the
  lambda's error type, so map a `sql.Error` first, as `stored` does.

State the requests share is a `Mutex` made in `main`'s scope and handed to `handle`; tests make
their own. Stopping on a request: race the server with a task that waits for the flag.

```candor
// counter.candor
import "http"

struct State {
  hits: int
  stopping: bool
}

fn handle(req: http.Request, state: Mutex<State>) -> http.Response {
  if http.route(req, "POST /hits") != none {
    let n = state.updateWith((st) => (State { ...st, hits: st.hits + 1 }, st.hits + 1))
    return http.textResponse(200, "${n}")
  }
  if http.route(req, "POST /shutdown") != none {
    state.update((st) => State { ...st, stopping: true })
    return http.emptyResponse(202)
  }
  return http.textResponse(404, "no route ${req.method} ${req.path}")
}

fn stopped(state: Mutex<State>) uses clock {
  while !state.get().stopping {
    clock.sleep(10)
  }
}

fn main() -> Result<void, string> uses env, http, tasks, clock {
  let port = env.get("PORT") ?? "8080"
  return tasks.scope((s) => {
    let state = s.mutex(State { hits: 0, stopping: false })
    // Workers go here, `s.spawn(() => worker(state))`: the scope waits for them.
    // The first to finish cancels the other: the server (Ctrl-C, or it couldn't listen) or the
    // wait for POST /shutdown.
    return tasks.race([() => http.serve("127.0.0.1:${port}", (req) => handle(req, state)), () => {
      stopped(state)
      return Ok()
    }])
  })
}
```

```candor
// counter_test.candor
fn post(path: string, state: Mutex<State>) -> http.Response {
  return handle(http.Request { method: "POST", path, query: [:], headers: [:], body: "" }, state)
}

test "hits count, and a shutdown is noted" {
  tasks.scope((s) => {
    let state = s.mutex(State { hits: 0, stopping: false })
    assert post("/hits", state).body == "1"
    assert post("/hits", state).body == "2"
    assert post("/shutdown", state).status == 202
    assert state.get().stopping
  })
}
```
