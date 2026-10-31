import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 061: an http client in the `http` effect. `get`, `post`, `postJson`, `send`; a response
// is never an error, whatever its status; a 30 s timeout by default. The fake answers from a
// table (`respond`) or a handler (`answer`) and records what was sent (`sent`). Card 083: a header
// sent twice (`addRequestHeader`), a response's repeats read (`responseHeaderAll`).

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(name: string, src: string, cmd: 'run' | 'test', env: Record<string, string> = {}) {
  const dir = path.join(tmpdir(), 'candor-test', 'http-client', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
    timeout: 120_000,
  });
}

const app = `module m

import "http"
import "json"

struct Item {
  name: string
  count: int
}

impl Json for Item

fn handle(req: http.Request) -> http.Response uses clock {
  if req.path == "/slow" {
    clock.sleep(2_000)
  }
  if req.path == "/repeats" {
    let res = http.textResponse(200, http.headerAll(req, "x-tag").join(","))
    return http.addHeader(http.addHeader(res, "set-cookie", "a=1"), "set-cookie", "b=2")
  }
  if req.method == "POST" {
    return http.textResponse(201, "\${req.headers["content-type"] ?? "-"} \${req.body}")
  }
  if req.path == "/missing" {
    return http.textResponse(404, "no")
  }
  return http.jsonResponse(200, Item { name: req.query["name"] ?? "?", count: 3 })
}

fn describe(url: string) -> string uses http {
  match http.get(url) {
    Err(e) => return "failed: \${e}"
    Ok(res) => {
      if res.status != 200 {
        return "status \${res.status}"
      }
      return match json.decode<Item>(res.body) {
        Ok(item) => "\${item.name}: \${item.count}",
        Err(e) => "bad body: \${e.message}",
      }
    }
  }
}

// A header sent twice, and the server's two cookies read back.
fn repeats(base: string) -> string uses http {
  let req = http.addRequestHeader(http.addRequestHeader(http.request("GET", "\${base}/repeats"), "X-Tag", "a"), "x-tag", "b")
  return match http.send(req) {
    Ok(res) => "\${res.body} \${http.responseHeaderAll(res, "Set-Cookie").join(",")}",
    Err(e) => "\${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  // The server starts in another task: wait until it answers.
  for _ in 0..100 {
    match http.get("\${base}/item") {
      Ok(_) => {
        let posted = match http.postJson("\${base}/items", Item { name: "cup", count: 1 }) {
          Ok(res) => "\${res.status} \${res.body}",
          Err(e) => "\${e}",
        }
        let slow = match http.send(http.ClientRequest { ...http.request("GET", "\${base}/slow"), timeoutMs: 200 }) {
          Ok(res) => "answered \${res.status}",
          Err(e) => "\${e}",
        }
        return [describe("\${base}/item?name=tea%20cup"), describe("\${base}/missing"), posted, slow, repeats(base)]
      }
      Err(_) => clock.sleep(50)
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock, env {
  let port = env.get("PORT") ?? "18555"
  let lines = tasks.race([
    () => match http.serve("127.0.0.1:\${port}", handle) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => calls("http://127.0.0.1:\${port}"),
  ])
  for line in lines {
    io.println(line)
  }
  io.println(describe("http://127.0.0.1:1/"))
}

fn pure(req: http.Request) -> http.Response {
  return http.jsonResponse(200, Item { name: "\${req.method} \${req.path} \${req.query["q"] ?? ""} \${req.headers["x-id"] ?? ""}", count: 7 })
}

test "the fake answers from its table, and records what was sent" {
  http.respond("http://a.test/item", 200, """{"name": "x", "count": 1}""")
  http.respond("http://a.test/gone", 404, "")
  assert describe("http://a.test/item") == "x: 1"
  assert describe("http://a.test/gone") == "status 404"
  let sent = http.sent()
  assert sent.length() == 2
  let first = sent[0]
  let second = sent[1]
  assert first != none && first.method == "GET"
  assert second != none && second.url == "http://a.test/gone"
}

test "the fake answers with a handler, which sees a server's request" {
  http.answer(pure)
  let req = http.ClientRequest { ...http.request("PUT", "http://a.test/things/1?q=a%20b"), headers: ["X-Id": "7"] }
  match http.send(req) {
    Ok(res) => assert res.body == """{"name":"PUT /things/1 a b 7","count":7}"""
    Err(_) => assert false
  }
  match http.postJson("http://a.test/p", Item { name: "n", count: 2 }) {
    Ok(_) => {
      let last = http.sent().last()
      assert last != none && last.headers == ["content-type": "application/json"]
      assert last != none && last.body == """{"name":"n","count":2}"""
    }
    Err(_) => assert false
  }
}

test "the fake: repeated headers reach the handler, and its repeats come back" {
  http.answer(handle)
  assert repeats("http://a.test") == "a,b a=1,b=2"
  let tags = http.addRequestHeader(http.addRequestHeader(http.request("GET", "u"), "X-Tag", "a"), "x-tag", "b")
  assert tags.headers == ["X-Tag": "a"]
  assert http.addRequestHeader(http.request("GET", "u"), "X-Tag", "a") == http.ClientRequest { ...http.request("GET", "u"), headers: ["X-Tag": "a"] }
}

test "with nothing set up, the fake fails and says how to set it up" {
  let d = describe("http://a.test/x")
  assert d.startsWith("failed: nothing answers GET http://a.test/x") && d.contains("http.respond")
}
`;

test('a program calls its own server on 127.0.0.1 and decodes the JSON reply', () => {
  const port = String(18_100 + Math.floor(Math.random() * 800));
  const r = cli('real', app, 'run', { PORT: port });
  expect(r.stderr).toBe('');
  const lines = r.stdout.replace(/\r\n/g, '\n').split('\n');
  expect(lines.slice(0, 5)).toEqual(['tea cup: 3', 'status 404', '201 application/json {"name":"cup","count":1}', 'no response in time', 'a,b a=1,b=2']);
  expect(lines[5]).toStartWith('failed: Get "http://127.0.0.1:1/"');
}, 120_000);

test('the fake: a table, a handler, what was sent', () => {
  const r = cli('fake', app, 'test');
  expect(r.stdout).toContain('4 passed, 0 failed');
}, 120_000);

test('the client needs `uses http`; a zero timeout fails the request', () => {
  const d = compileSplit('module m\nimport "http"\nfn f() -> bool {\n  return http.get("x") == none\n}\nfn main() {}\n', 'm.candor').diagnostics.filter((x) => x.severity === 'error');
  expect(d.map((x) => x.code)).toContain('CAN0004');
}, 120_000);
