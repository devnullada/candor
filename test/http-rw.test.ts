import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Http bodies as readers and writers. `http.reading(req, f)` and
// `http.readingResponse(res, f)` give a reader over a body as it arrives; `http.writing(status,
// headers, f)` gives a writer, a write to a client that has gone is an Err, and an Err from `f`
// cuts the connection.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'http-rw');

function cli(cmd: 'run' | 'test', src: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'm.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'm.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 200_000,
  });
}

const lib = `module m

import "bytes"
import "http"

// The size of each read, to the end.
fn sizes(r: fn(int) -> Result<Bytes?, string>) -> Result<List<int>, string> uses r {
  let mut out: List<int> = []
  while true {
    match r(0)? {
      none => return Ok(out),
      b => out.push(b.length()),
    }
  }
  return Ok(out)
}

fn handle(req: http.Request) -> http.Response uses clock {
  if req.path == "/upload" {
    return match http.reading(req, (r) => sizes(r)) {
      Ok(s) => http.textResponse(200, "\${s.fold(0, (a, n) => a + n)} bytes, \${if s.length() > 1 { "pieces" } else { "one piece" }}"),
      Err(e) => http.textResponse(400, e),
    }
  }
  if req.path == "/lines" {
    return http.writing(200, ["content-type": "text/plain"], (w): Result<void, string> => {
      for i in 0..3 {
        w("line \${i}\\n".toBytes())?
        clock.sleep(100)
      }
      return Ok()
    })
  }
  if req.path == "/broken" {
    return http.writing(200, ["content-type": "text/plain"], (w): Result<void, string> => {
      w("half".toBytes())?
      return Err("the disk went away")
    })
  }
  return http.emptyResponse(404)
}
`;

test('reading and writing on the fakes: streamed pieces, a plain body, bodyOf', () => {
  const r = cli('test', `${lib}
fn main() {}

fn upload(body: string) -> http.Request {
  return http.Request { method: "POST", path: "/upload", query: [:], headers: [:], body }
}

test "a streamed request body is read a piece at a time" {
  let req = http.streamed(upload(""), ["ab", "c", "def"])
  assert http.reading(req, (r) => sizes(r)) == Ok([2, 1, 3])
  assert http.bodyOf(handle(req)) == "6 bytes, pieces"
  assert http.bodyOf(handle(upload("abcd"))) == "4 bytes, one piece"
  assert http.reading(upload(""), (r) => sizes(r)) == Ok([])
}

test "a written body, whole and cut short" {
  let res = handle(http.Request { method: "GET", path: "/lines", query: [:], headers: [:], body: "" })
  assert res.status == 200 && res.body == ""
  assert http.bodyOf(res) == "line 0\\nline 1\\nline 2\\n"
  assert http.reading(upload(""), (r) => bytes.readAll(r)) == Ok("".toBytes())
  assert http.bodyOf(handle(http.Request { method: "GET", path: "/broken", query: [:], headers: [:], body: "" })) == "half"
}

test "readingResponse reads a fake client's response" {
  http.respond("http://x/a", 200, "one\\ntwo\\n")
  let res = http.openStream(http.request("GET", "http://x/a"))
  assert res.isOk()
  let lines = http.readingResponse(res.ok() ?? http.emptyResponse(500), (r) => bytes.readLines(r, [], (acc: List<string>, line) => acc.concat([line])))
  assert lines == Ok(["one", "two"])
}
`);
  expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
}, 240_000);

test('a real server reads with a reader and writes with a writer; an Err cuts the connection', () => {
  const port = 18_100 + Math.floor(Math.random() * 800);
  const r = cli('run', `${lib}
fn lines(base: string) -> string uses http {
  let res = match http.openStream(http.request("GET", "\${base}/lines")) {
    Ok(r) => r,
    Err(e) => return "open: \${e}",
  }
  return match http.readingResponse(res, (r) => bytes.readLines(r, [], (acc: List<string>, line) => acc.concat([line]))) {
    Ok(ls) => ls.join(","),
    Err(e) => "broke: \${e}",
  }
}

// Reads the first line only: the connection closes with the body unread.
fn first(base: string) -> string uses http {
  let res = match http.openStream(http.request("GET", "\${base}/lines")) {
    Ok(r) => r,
    Err(e) => return "open: \${e}",
  }
  return match http.readingResponse(res, (r) => r(6)) {
    Ok(b) => (b ?? "".toBytes()).toText() ?? "?",
    Err(e) => "broke: \${e}",
  }
}

fn broken(base: string) -> string uses http {
  let res = match http.openStream(http.request("GET", "\${base}/broken")) {
    Ok(r) => r,
    Err(e) => return "open: \${e}",
  }
  return match http.readingResponse(res, (r) => bytes.readAll(r)) {
    Ok(b) => "whole: \${b.length()}",
    Err(_) => "broken",
  }
}

fn upload(base: string) -> string uses http {
  return match http.post("\${base}/upload", "x".repeat(3 * 1024 * 1024)) {
    Ok(res) => "\${res.status} \${res.body}",
    Err(e) => "failed: \${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  for _ in 0..200 {
    match http.get("\${base}/none") {
      Ok(_) => return [lines(base), first(base), broken(base), upload(base)],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock {
  let out = tasks.race([
    () => match http.serveWith("127.0.0.1:${port}", http.ServeOptions { largeBodies: ["POST /upload"] }, handle) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => calls("http://127.0.0.1:${port}"),
  ])
  for line in out {
    io.println(line)
  }
}
`);
  expect(r.stdout.split('\n')).toEqual(['line 0,line 1,line 2', 'line 0', 'broken', `200 ${3 << 20} bytes, pieces`, '']);
  expect(r.stderr).toBe('error: the disk went away\nin a request: GET /broken, its body cut short\n');
}, 240_000);
