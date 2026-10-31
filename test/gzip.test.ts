import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 152: gzip. `bytes.gzip` and `bytes.gunzip`; `serve` gzips text-like responses for a
// client that takes it (`http.served` shows it in a test); the client, real and fake, un-gzips a
// gzipped body, so `res.body` is always the content.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(name: string, src: string, cmd: 'run' | 'test', env: Record<string, string> = {}) {
  const dir = path.join(tmpdir(), 'candor-test', 'gzip', name);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
    timeout: 120_000,
  });
}

const tests = `module m

import "bytes"
import "fs"
import "http"

fn page() -> string {
  return "<p>gzip me</p>".repeat(200)
}

fn handle(req: http.Request) -> http.Response uses fs {
  if req.path == "/page" {
    return http.Response { status: 200, headers: ["content-type": "text/html; charset=utf-8"], body: page() }
  }
  if req.path == "/tiny" {
    return http.textResponse(200, "hi")
  }
  if req.path == "/png" {
    return http.bytesResponse(200, "image/png", page().toBytes())
  }
  if req.path == "/encoded" {
    return http.Response { status: 200, headers: ["content-type": "text/plain", "content-encoding": "br"], body: page() }
  }
  if req.path == "/events" {
    return http.events([:], (send) => send(http.Event { data: page() }))
  }
  if req.path == "/csv" {
    return http.streamResponse(200, ["content-type": "text/csv"], (send) => {
      for _ in 0..100 {
        send("a,b,c\\n")
      }
    })
  }
  return http.serveFile("site.css")
}

fn get(path: string, accept: string) -> http.Request {
  let req = http.Request { method: "GET", path, query: [:], headers: [:], body: "" }
  return if accept == "" { req } else { http.withHeader(req, "accept-encoding", [accept]) }
}

fn unzip(res: http.Response) -> string {
  return bytes.gunzip(res.body.toBytes()).map((b) => b.toRawText()) ?? "not gzip"
}

test "gzip and gunzip" {
  let data = page().toBytes()
  let small = bytes.gzip(data)
  assert small.length() < data.length() / 10
  assert bytes.gunzip(small) == data
  assert bytes.gunzip(bytes.gzip("".toBytes())) == "".toBytes()
  assert bytes.gunzip(data) == none
  assert bytes.gunzip(small.slice(0, small.length() - 4)) == none
  assert bytes.gunzip(bytes.gzip("a".toBytes()).concat(bytes.gzip("b".toBytes()))) == "ab".toBytes()
}

test "served: text goes out gzipped to a client that takes it" {
  let gz = http.served(get("/page", "gzip, deflate, br"), handle(get("/page", "")))
  assert gz.headers["content-encoding"] == "gzip" && gz.headers["vary"] == "Accept-Encoding"
  assert unzip(gz) == page()
  let plain = http.served(get("/page", ""), handle(get("/page", "")))
  assert plain.headers["content-encoding"] == none && plain.headers["vary"] == "Accept-Encoding"
  assert plain.body == page()
  assert http.served(get("/page", "gzip;q=0"), handle(get("/page", ""))).body == page()
  let head = http.served(http.Request { ...get("/page", "gzip"), method: "HEAD" }, handle(get("/page", "")))
  assert head.headers["content-encoding"] == "gzip" && head.body == ""
}

test "served: what isn't gzipped" {
  for path in ["/tiny", "/png", "/encoded", "/events"] {
    let res = http.served(get(path, "gzip"), handle(get(path, "")))
    assert res.headers["content-encoding"] != "gzip"
  }
  assert http.served(get("/tiny", "gzip"), handle(get("/tiny", ""))).body == "hi"
  assert http.served(get("/png", "gzip"), handle(get("/png", ""))).headers["vary"] == none
}

test "served: a stream and a file are gzipped too, a range isn't" {
  let csv = http.served(get("/csv", "gzip"), handle(get("/csv", "")))
  assert csv.headers["content-encoding"] == "gzip" && unzip(csv) == "a,b,c\\n".repeat(100)
  assert fs.write("site.css", "body { color: red }\\n".repeat(100)) == Ok()
  let css = http.served(get("/site.css", "gzip"), handle(get("/site.css", "")))
  assert css.status == 200 && css.headers["content-encoding"] == "gzip" && css.headers["content-length"] == none
  assert unzip(css) == "body { color: red }\\n".repeat(100)
  let ranged = http.served(http.withHeader(get("/site.css", "gzip"), "range", ["bytes=0-3"]), handle(get("/site.css", "")))
  assert ranged.status == 206 && ranged.headers["content-encoding"] == none && ranged.body == "body"
}

test "the fake client un-gzips as the real one does" {
  let zipped = bytes.gzip(page().toBytes()).toRawText()
  http.respondWith("http://a.test/feed", http.Response { status: 200, headers: ["content-type": "application/xml", "content-encoding": "gzip"], body: zipped })
  match http.get("http://a.test/feed") {
    Ok(res) => assert res.body == page() && res.headers == ["content-type": "application/xml"],
    Err(_) => assert false,
  }
  http.respondWith("http://a.test/odd", http.Response { status: 200, headers: ["content-encoding": "gzip"], body: "not gzip" })
  match http.get("http://a.test/odd") {
    Ok(res) => assert res.body == "not gzip" && res.headers["content-encoding"] == "gzip",
    Err(_) => assert false,
  }
}
`;

test('gzip: bytes, what serve sends, the fake client', () => {
  const r = cli('tests', tests, 'test');
  expect(r.stdout + r.stderr).toContain('5 passed, 0 failed');
}, 180_000);

// A real server and client: a body the handler gzipped itself reaches the client un-gzipped,
// whether Go's transport asked for gzip or the request did; `serve` gzips what isn't.
const real = `module m

import "bytes"
import "http"

fn page() -> string {
  return "<p>gzip me</p>".repeat(200)
}

fn handle(req: http.Request) -> http.Response {
  if req.path == "/zipped" {
    return http.Response { status: 200, headers: ["content-type": "application/rss+xml", "content-encoding": "gzip"], body: bytes.gzip(page().toBytes()).toRawText() }
  }
  return http.Response { status: 200, headers: ["content-type": "text/html"], body: page() }
}

fn fetch(url: string, accept: string) -> string uses http {
  let req = http.request("GET", url)
  let sent = if accept == "" { req } else { http.ClientRequest { ...req, headers: ["accept-encoding": accept] } }
  return match http.send(sent) {
    Ok(res) => "\${res.body == page()} \${res.headers["content-encoding"] ?? "-"} \${res.headers["vary"] ?? "-"}",
    Err(e) => "\${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  for _ in 0..100 {
    match http.get(base) {
      Ok(_) => return [fetch("\${base}/zipped", ""), fetch("\${base}/zipped", "gzip"), fetch("\${base}/page", ""), fetch("\${base}/page", "gzip"), fetch("\${base}/page", "identity")],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock, env {
  let port = env.get("PORT") ?? "18556"
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
}
`;

test('a real client reads gzipped bodies as the content', () => {
  const port = String(18_100 + Math.floor(Math.random() * 800));
  const r = cli('real', real, 'run', { PORT: port });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n').trim().split('\n')).toEqual([
    'true - -',
    'true - -',
    'true - Accept-Encoding',
    'true - Accept-Encoding',
    'true - Accept-Encoding',
  ]);
}, 180_000);
