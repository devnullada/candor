import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `http.served(req, res)` gives what `serve` sends for a handler's answer: a file from
// `http.serveFile` goes through the same ServeContent, so a test sees 206, 416, 304 and HEAD.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'http-served');
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    // Go 1.27.3 caps a request's ranges; a module below `go 1.26`, as Candor's builds are, gets a cap
    // of 1, so several ranges answer 200 with the whole file. This test is about the multipart form.
    env: { ...process.env, CANDOR_GO: go, GODEBUG: 'httpservecontentmaxranges=200' },
  });
}

const src = `module m

import "fs"
import "http"

fn handle(req: http.Request) -> http.Response uses fs {
  if req.path == "/text" {
    return http.textResponse(200, "hi")
  }
  if req.path == "/tagged" {
    return http.addHeader(http.serveFile("a.txt"), "etag", "\\"v1\\"")
  }
  return http.serveFile("a.txt")
}

fn request(method: string, path: string, header: string, value: string) -> http.Request {
  let req = http.Request { method, path, query: [:], headers: [:], body: "" }
  return if header == "" { req } else { http.withHeader(req, header, [value]) }
}

// What a client gets: status, the headers that matter here, the body.
fn ask(method: string, path: string, header: string, value: string) -> string uses fs {
  let req = request(method, path, header, value)
  let res = http.served(req, handle(req))
  let h = (name: string) => res.headers[name] ?? "-"
  return "\${res.status} \${h("content-range")} | \${h("last-modified")} | \${h("content-length")} | \${h("content-type")} | \${res.body}"
}

test "a file is answered as the server answers it" {
  clock.set(1_700_000_000_000)
  assert fs.write("a.txt", "abcdefghij") == Ok()
  let modified = "Tue, 14 Nov 2023 22:13:20 GMT"
  assert ask("GET", "/", "", "") == "200 - | \${modified} | 10 | text/plain; charset=utf-8 | abcdefghij"
  assert ask("GET", "/", "range", "bytes=2-4") == "206 bytes 2-4/10 | \${modified} | 3 | text/plain; charset=utf-8 | cde"
  assert ask("GET", "/", "range", "bytes=-3") == "206 bytes 7-9/10 | \${modified} | 3 | text/plain; charset=utf-8 | hij"
  assert ask("GET", "/", "range", "bytes=20-") == "416 bytes */10 | - | 0 | - | "
  assert ask("GET", "/", "if-modified-since", modified) == "304 - | \${modified} | - | - | "
  assert ask("GET", "/", "if-modified-since", "Mon, 13 Nov 2023 00:00:00 GMT") == "200 - | \${modified} | 10 | text/plain; charset=utf-8 | abcdefghij"
  assert ask("HEAD", "/", "", "") == "200 - | \${modified} | 10 | text/plain; charset=utf-8 | "
  assert ask("GET", "/tagged", "if-none-match", "\\"v1\\"") == "304 - | - | - | - | "
  let req = request("GET", "/", "", "")
  assert http.served(req, handle(req)).headers["accept-ranges"] == "bytes"
}

test "several ranges are multipart, the same every run" {
  clock.set(1_700_000_000_000)
  assert fs.write("a.txt", "abcdefghij") == Ok()
  let req = request("GET", "/", "range", "bytes=0-1,4-5")
  let res = http.served(req, handle(req))
  let boundary = "000000000000000000000000000000000000000000000000000000000000"
  assert res.status == 206
  assert res.headers["content-type"] == "multipart/byteranges; boundary=\${boundary}"
  assert res.body == "--\${boundary}\\r\\nContent-Range: bytes 0-1/10\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\nab\\r\\n--\${boundary}\\r\\nContent-Range: bytes 4-5/10\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\nef\\r\\n--\${boundary}--\\r\\n"
  assert res.headers["content-length"] == "\${res.body.byteLength()}"
}

test "called directly, the handler's answer is the whole file" {
  assert fs.write("a.txt", "abcdefghij") == Ok()
  let res = handle(request("GET", "/", "range", "bytes=2-4"))
  assert res.status == 200 && res.body == "abcdefghij"
}

test "a file written at the clock's start has no last-modified, as on a server" {
  assert fs.write("a.txt", "abcdefghij") == Ok()
  assert ask("GET", "/", "", "") == "200 - | - | 10 | text/plain; charset=utf-8 | abcdefghij"
  assert ask("GET", "/", "range", "bytes=0-0") == "206 bytes 0-0/10 | - | 1 | text/plain; charset=utf-8 | a"
}

test "anything else is the handler's answer, without a body for HEAD" {
  assert ask("GET", "/text", "range", "bytes=0-0") == "200 - | - | - | text/plain; charset=utf-8 | hi"
  assert ask("HEAD", "/text", "", "") == "200 - | - | - | text/plain; charset=utf-8 | "
}
`;

test('http.served answers ranges, 304 and HEAD for a file in a test', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('5 passed, 0 failed');
}, 120_000);
