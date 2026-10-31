import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 085: binary bodies. `body` stays a string holding the bytes as they came, which
// `body.toBytes()` reads exactly; `bytesResponse`, `postBytes`, `withBody` and `streamBytes`
// send Bytes.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(name: string, src: string, cmd: 'run' | 'test', env: Record<string, string> = {}) {
  const dir = path.join(tmpdir(), 'candor-test', 'http-bytes', name);
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

import "bytes"
import "http"

fn hex(s: string) -> Bytes {
  return bytes.fromHex(s) ?? "".toBytes()
}

// A PNG's signature, then bytes that aren't UTF-8.
fn logo() -> Bytes {
  return hex("89504e470d0a1a0a00ff80fe")
}

fn handle(req: http.Request) -> http.Response {
  if req.path == "/logo.png" {
    return http.bytesResponse(200, "image/png", logo())
  }
  if req.path == "/stream" {
    return http.streamBytes(200, ["content-type": "application/octet-stream"], (send) => {
      send(hex("ff00"))
      send(hex("fe"))
    })
  }
  if req.path == "/echo" {
    return http.bytesResponse(200, "application/octet-stream", req.body.toBytes())
  }
  // An upload: what came, as hex.
  let data = req.body.toBytes()
  return http.textResponse(200, "\${req.headers["content-type"] ?? "-"} \${data.length()} \${data.toHex()}")
}

fn body(r: Result<http.Response, http.HttpError>) -> string {
  return match r {
    Ok(res) => "\${res.status} \${res.headers["content-type"] ?? "-"} \${res.body.toBytes().toHex()}",
    Err(e) => "\${e}",
  }
}

fn text(r: Result<http.Response, http.HttpError>) -> string {
  return match r {
    Ok(res) => res.body,
    Err(e) => "\${e}",
  }
}

fn calls(base: string) -> List<string> uses http {
  return [
    body(http.get("\${base}/logo.png")),
    text(http.postBytes("\${base}/upload", "image/png", logo())),
    body(http.send(http.withBody(http.request("PUT", "\${base}/echo"), hex("00ff")))),
    body(http.get("\${base}/stream")),
  ]
}

fn waitAndCall(base: string) -> List<string> uses http, clock {
  // The server starts in another task: wait until it answers.
  for _ in 0..100 {
    match http.get("\${base}/logo.png") {
      Ok(_) => return calls(base),
      Err(_) => clock.sleep(50),
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
    () => waitAndCall("http://127.0.0.1:\${port}"),
  ])
  for line in lines {
    io.println(line)
  }
}

test "the fake carries binary bodies both ways" {
  http.answer(handle)
  assert calls("http://a.test") == [
    "200 image/png 89504e470d0a1a0a00ff80fe",
    "image/png 12 89504e470d0a1a0a00ff80fe",
    "200 application/octet-stream 00ff",
    "200 application/octet-stream ff00fe",
  ]
  let sent = http.sent()
  let upload = sent[1]
  assert upload != none && upload.body.toBytes() == logo() && upload.headers == ["content-type": "image/png"]
}

test "a handler's binary response, read in a test" {
  let res = handle(http.Request { method: "GET", path: "/stream", query: [:], headers: [:], body: "" })
  assert http.bodyOf(res).toBytes() == hex("ff00fe")
  assert handle(http.Request { method: "GET", path: "/logo.png", query: [:], headers: [:], body: "" }).body.toBytes() == logo()
}

test "a body that isn't UTF-8 is its bytes as they came" {
  let req = http.withBody(http.request("POST", "u"), hex("ff41"))
  assert req.body.byteLength() == 2
  assert req.body.length() == 2
  assert req.body.toBytes() == hex("ff41")
  assert req.body.toBytes().toText() == none
}
`;

test('a server serves an image and takes an upload; the client reads both exactly', () => {
  const port = String(18_100 + Math.floor(Math.random() * 800));
  const r = cli('real', app, 'run', { PORT: port });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe(
    [
      '200 image/png 89504e470d0a1a0a00ff80fe',
      'image/png 12 89504e470d0a1a0a00ff80fe',
      '200 application/octet-stream 00ff',
      '200 application/octet-stream ff00fe',
      '',
    ].join('\n'),
  );
}, 120_000);

test('the fake: binary bodies, a streamed one, bytes that are not UTF-8', () => {
  const r = cli('fake', app, 'test');
  expect(r.stdout).toContain('3 passed, 0 failed');
}, 120_000);
