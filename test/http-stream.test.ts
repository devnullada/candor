import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 063: a struct literal may leave out optional fields (`none`); `http.streamResponse` sends
// a body a piece at a time; `serveWith` with `largeBodies` hands those routes' bodies to
// `http.readBody` unread, at any size; `http.bodyOf` gives a streamed body whole, for tests.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const errors = (src: string) => compileSplit(src, 'm.candor').diagnostics.filter((d) => d.severity === 'error');

const program = `module stream

import "http"

fn handle(req: http.Request) -> http.Response uses clock {
  if req.path == "/ticks" {
    return http.streamResponse(200, ["content-type": "text/plain"], (send) => {
      for i in 0..3 {
        send("tick \${i}\\n")
        clock.sleep(400)
      }
    })
  }
  if req.path == "/upload" {
    // How many pieces, and how many bytes in all.
    return match http.readBody(req, (0, 0), (seen, piece) => (seen.0 + 1, seen.1 + piece.byteLength())) {
      Ok(n) => http.textResponse(200, "\${n.1} bytes in \${if n.0 > 1 { "pieces" } else { "one piece" }}"),
      Err(e) => http.textResponse(400, e),
    }
  }
  if req.path == "/count" {
    return http.textResponse(200, "small body: \${req.body.length()}")
  }
  return http.emptyResponse(404)
}

fn main() uses http, tasks, clock, env {
  let port = env.get("PORT") ?? "8080"
  let options = http.ServeOptions { largeBodies: ["POST /upload"] }
  match http.serveWith("127.0.0.1:\${port}", options, handle) {
    Ok() => {}
    Err(_) => {}
  }
}

test "a streamed body, whole" {
  let res = handle(http.Request { method: "GET", path: "/ticks", query: [:], headers: [:], body: "" })
  assert res.status == 200 && res.body == ""
  assert http.bodyOf(res) == "tick 0\\ntick 1\\ntick 2\\n"
}

test "a test can hand a handler a streamed request body" {
  let req = http.streamed(http.Request { method: "POST", path: "/upload", query: [:], headers: [:], body: "" }, ["ab", "c"])
  assert http.bodyOf(handle(req)) == "3 bytes in pieces"
  let plain = http.Request { method: "POST", path: "/upload", query: [:], headers: [:], body: "abcd" }
  assert http.bodyOf(handle(plain)) == "4 bytes in one piece"
}

test "bodyOf on a plain response is its body; responses still compare" {
  assert http.bodyOf(http.textResponse(200, "x")) == "x"
  assert http.textResponse(200, "x") == http.textResponse(200, "x")
}
`;

const dir = path.join(tmpdir(), 'candor-test', 'http-stream');
mkdirSync(dir, { recursive: true });
writeModule(path.join(dir, 'stream.candor'), program);

test('an optional field may be left out of a struct literal; it is none', () => {
  expect(errors('module m\nstruct P {\n  a: int\n  b: string?\n}\nfn main() {\n  let p = P { a: 1 }\n  let q = P { b: "x" }\n}\n').map((d) => [d.code, d.message, d.help])).toEqual([
    ['CAN0026', '`P` is missing field `a`', 'every field must be given, except optional ones (`T?`), which are `none` when left out'],
  ]);
});

test(
  'streamResponse, readBody and bodyOf in test blocks',
  () => {
    const t = cli(dir, 'test', 'stream.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('3 passed, 0 failed');
  },
  120_000,
);

test(
  'a streamed body arrives piece by piece; a large-body route reads past 1 MiB',
  async () => {
    const built = cli(dir, 'build', 'stream.candor', '--out', path.join(dir, 'out'));
    expect(built.stderr).toBe('');
    const exe = built.stdout.trim();
    const port = 18_100 + Math.floor(Math.random() * 800);
    const server = Bun.spawn([exe], { env: { ...process.env, PORT: String(port) }, stderr: 'pipe', stdout: 'pipe' });
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; ; i++) {
        const up = await fetch(`${url}/count`).then(() => true, () => false);
        if (up) break;
        if (i > 100) throw new Error('the server never came up');
        await Bun.sleep(50);
      }
      // The first piece comes long before the last is written (they are 400 ms apart).
      const start = Date.now();
      const res = await fetch(`${url}/ticks`);
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const firstAt = Date.now() - start;
      let rest = '';
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
      expect(first + rest).toBe('tick 0\ntick 1\ntick 2\n');
      expect(first).toStartWith('tick 0');
      expect(firstAt).toBeLessThan(700);
      expect(Date.now() - start).toBeGreaterThan(1000);

      const big = 'x'.repeat(3 << 20);
      expect((await fetch(`${url}/count`, { method: 'POST', body: big })).status).toBe(413);
      const up = await fetch(`${url}/upload`, { method: 'POST', body: big });
      expect([up.status, await up.text()]).toEqual([200, `${3 << 20} bytes in pieces`]);
    } finally {
      server.kill();
    }
  },
  120_000,
);
