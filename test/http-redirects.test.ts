import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 102: `res.url` is where the client landed after redirects; `redirects: n` follows at most
// n (0 gives the redirect itself), left out up to 10 and an 11th fails. The fake does the same.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(name: string, src: string, cmd: 'run' | 'test', env: Record<string, string> = {}) {
  const dir = path.join(tmpdir(), 'candor-test', 'http-redirects', name);
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

fn moved(status: int, to: string) -> http.Response {
  return http.Response { status, headers: ["location": to], body: "" }
}

fn handle(req: http.Request) -> http.Response {
  if req.path == "/old" {
    return moved(301, "/middle")
  }
  if req.path == "/middle" {
    return moved(302, "/new?x=1")
  }
  if req.path == "/loop" {
    return moved(302, "/loop")
  }
  if req.path == "/form" {
    return moved(303, "/new")
  }
  return http.textResponse(200, "\${req.method} \${req.path} \${req.body}")
}

fn show(r: Result<http.Response, http.HttpError>) -> string {
  return match r {
    Ok(res) => "\${res.status} \${res.url ?? "-"} \${res.headers["location"] ?? "-"} \${res.body}",
    Err(e) => "failed: \${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  for _ in 0..100 {
    match http.get("\${base}/new") {
      Ok(_) => return [
        show(http.get("\${base}/old")),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/old"), redirects: 0 })),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/old"), redirects: 1 })),
        show(http.get("\${base}/loop")),
        show(http.send(http.ClientRequest { ...http.request("POST", "\${base}/form"), body: "a" })),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/old"), redirects: -1 })),
      ],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock, env {
  let port = env.get("PORT") ?? "18655"
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

test "the fake follows redirects as the client does" {
  http.answer(handle)
  let base = "http://a.test"
  assert show(http.get("\${base}/old")) == "200 http://a.test/new?x=1 - GET /new "
  assert http.sent().map((r) => r.url) == ["http://a.test/old", "http://a.test/middle", "http://a.test/new?x=1"]
  assert show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/old"), redirects: 0 })) == "301 http://a.test/old /middle "
  assert show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/old"), redirects: 1 })) == "302 http://a.test/middle /new?x=1 "
  assert show(http.get("\${base}/loop")) == "failed: GET \\"http://a.test/loop\\": stopped after 10 redirects"
  assert show(http.send(http.ClientRequest { ...http.request("POST", "\${base}/form"), body: "a" })) == "200 http://a.test/new - GET /new "
}

test "the fake's table answers with a whole response, a redirect included" {
  http.respondWith("http://a.test/", moved(308, "https://b.test/"))
  http.respond("https://b.test/", 200, "here")
  assert show(http.get("http://a.test/")) == "200 https://b.test/ - here"
  assert show(http.send(http.ClientRequest { ...http.request("GET", "http://a.test/"), redirects: -2 })) == "failed: redirects is -2: give 0 or more, or leave it out to follow up to 10"
}
`;

test('the real client: where it landed, how far it follows, a loop fails', () => {
  const port = String(18_900 + Math.floor(Math.random() * 90));
  const r = cli('real', app, 'run', { PORT: port });
  expect(r.stderr).toBe('');
  const base = `http://127.0.0.1:${port}`;
  const lines = r.stdout.replace(/\r\n/g, '\n').split('\n');
  expect(lines.slice(0, 6)).toEqual([
    `200 ${base}/new?x=1 - GET /new `,
    `301 ${base}/old /middle `,
    `302 ${base}/middle /new?x=1 `,
    `failed: Get "/loop": stopped after 10 redirects`,
    `200 ${base}/new - GET /new `,
    'failed: redirects is -1: give 0 or more, or leave it out to follow up to 10',
  ]);
}, 120_000);

test('the fake follows the same way', () => {
  const r = cli('fake', app, 'test');
  expect(r.stdout).toContain('2 passed, 0 failed');
}, 120_000);
