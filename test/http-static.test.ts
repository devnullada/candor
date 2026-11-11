import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Static files. `http.serveDir` through `fs.within`, `http.serveFile`,
// `http.mimeType`; a real server, and the same handler against the fake fs.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(dir: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
    timeout: 120_000,
  });
}

const app = `module site

import "bytes"
import "fs"
import "http"

fn setUp() -> Result<void, fs.FsError> uses fs {
  fs.removeAll("public")?
  fs.makeDir("public/css/deep")?
  fs.write("public/index.html", "<h1>hi</h1>")?
  fs.write("public/css/site.css", "h1{}")?
  fs.writeBytes("public/logo.PNG", bytes.fromHex("89504e47ff") ?? "".toBytes())?
  return fs.write("secret.txt", "keep out")
}

fn handle(req: http.Request) -> http.Response uses fs {
  if req.path.startsWith("/static/") {
    return http.serveDir("public", req.path.slice(8, req.path.length()))
  }
  if req.path == "/" {
    return http.serveFile("public/index.html")
  }
  return http.textResponse(404, "no route")
}

fn line(r: Result<http.Response, http.HttpError>) -> string {
  return match r {
    Ok(res) => "\${res.status} \${res.headers["content-type"] ?? "-"} \${res.body.toBytes().toHex()}",
    Err(e) => "\${e}",
  }
}

fn calls(base: string) -> List<string> uses http {
  return [
    line(http.get("\${base}/")),
    line(http.get("\${base}/static/")),
    line(http.get("\${base}/static/css/site.css")),
    line(http.get("\${base}/static/logo.PNG")),
    line(http.get("\${base}/static/css/deep")),
    line(http.get("\${base}/static/none.js")),
    line(http.get("\${base}/static/%2e%2e/secret.txt")),
    line(http.get("\${base}/static/..%5csecret.txt")),
  ]
}

fn waitAndCall(base: string) -> List<string> uses http, clock {
  for _ in 0..100 {
    match http.get("\${base}/") {
      Ok(_) => return calls(base),
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock, env, fs {
  match setUp() {
    Ok() => {},
    Err(e) => {
      io.println("set up: \${e}")
      return
    },
  }
  let port = env.get("PORT") ?? "18655"
  let lines = tasks.race([
    () => match http.serve("127.0.0.1:\${port}", handle) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => waitAndCall("http://127.0.0.1:\${port}"),
  ])
  for l in lines {
    io.println(l)
  }
}

fn get(path: string) -> http.Response uses fs {
  return handle(http.Request { method: "GET", path, query: [:], headers: [:], body: "" })
}

test "the handler against the fake fs" {
  assert setUp() == Ok()
  assert get("/static/").body == "<h1>hi</h1>"
  assert get("/static/css/site.css").headers["content-type"] == "text/css; charset=utf-8"
  assert get("/static/logo.PNG").body.toBytes().toHex() == "89504e47ff"
  assert get("/static/../secret.txt").status == 404
  assert get("/static/a/../../secret.txt").status == 404
  assert get("/static/css/deep").status == 404
  assert get("/static/css").status == 404
}

test "content types by extension" {
  assert http.mimeType("a/b/index.HTML") == "text/html; charset=utf-8"
  assert http.mimeType("app.mjs") == "text/javascript; charset=utf-8"
  assert http.mimeType("x.woff2") == "font/woff2"
  assert http.mimeType("Makefile") == "application/octet-stream"
  assert http.mimeType("dir.d\\\\notes") == "application/octet-stream"
  assert http.mimeType("archive.tar.gz") == "application/octet-stream"
}
`;

test('a server serves a directory and refuses paths out of it; the same handler in a test', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'http-static');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'site.candor'), app);
  const port = String(18_100 + Math.floor(Math.random() * 800));
  const run = candor(dir, { PORT: port }, 'run', 'site.candor');
  expect(run.stderr).toBe('');
  const hex = (s: string) => Buffer.from(s).toString('hex');
  expect(run.stdout.replace(/\r\n/g, '\n')).toBe(
    [
      `200 text/html; charset=utf-8 ${hex('<h1>hi</h1>')}`,
      `200 text/html; charset=utf-8 ${hex('<h1>hi</h1>')}`,
      `200 text/css; charset=utf-8 ${hex('h1{}')}`,
      '200 image/png 89504e47ff',
      '404 - ',
      '404 - ',
      '404 - ',
      '404 - ',
      '',
    ].join('\n'),
  );

  const t = candor(dir, {}, 'test', 'site.candor');
  expect(t.stdout).toContain('2 passed, 0 failed');
}, 120_000);
