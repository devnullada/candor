import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// #7d862c59: the client options the hey port missed. A `host` header is the Host sent;
// `compressed: false` asks for no gzip; `keepAlive: false` closes the connection after the
// request; `timeoutMs: 0` is no timeout (real client, WebSocket dial and the fake).

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'http-client-options');

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

import "http"

// Echoes the headers the client options change.
fn handle(req: http.Request) -> http.Response uses clock {
  if req.path == "/slow" {
    clock.sleep(60_000)
  }
  let h = (name: string) => req.headers[name] ?? "-"
  return http.textResponse(200, "host=\${h("host")} enc=\${h("accept-encoding")} conn=\${h("connection")}")
}
`;

test('a real client sends the Host given, no gzip, connection: close; 0 is no timeout', () => {
  const port = 19_000 + Math.floor(Math.random() * 800);
  const r = cli('run', `${lib}
fn show(r: Result<http.Response, http.HttpError>) -> string {
  return match r {
    Ok(res) => res.body,
    Err(e) => "failed: \${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  for _ in 0..200 {
    match http.get("\${base}/none") {
      Ok(_) => return [
        show(http.get("\${base}/")),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/"), headers: ["Host": "shop.test"] })),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/"), compressed: false, keepAlive: false })),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/"), timeoutMs: 0 })),
        show(http.send(http.ClientRequest { ...http.request("GET", "\${base}/"), timeoutMs: -1 })),
      ],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock {
  let out = tasks.race([
    () => match http.serve("127.0.0.1:${port}", handle) {
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
  expect(r.stderr).toBe('');
  expect(r.stdout.split('\n')).toEqual([
    `host=127.0.0.1:${port} enc=gzip conn=-`,
    'host=shop.test enc=gzip conn=-',
    `host=127.0.0.1:${port} enc=- conn=close`,
    `host=127.0.0.1:${port} enc=gzip conn=-`,
    'failed: timeoutMs is -1: give it a positive number of milliseconds, or 0 for no timeout',
    '',
  ]);
}, 240_000);

test('the fake: 0 waits for a slow handler, the options are in http.requests', () => {
  const r = cli('test', `${lib}
test "no timeout waits on the fake clock" {
  http.answer(handle)
  let slow = http.ClientRequest { ...http.request("GET", "http://a.test/slow"), timeoutMs: 0 }
  assert http.send(slow).map((res) => res.status) == Ok(200)
  assert http.send(http.request("GET", "http://a.test/slow")) == Err(.Timeout)
}

test "the options are seen" {
  http.answer(handle)
  let req = http.ClientRequest { ...http.request("GET", "http://a.test/"), headers: ["host": "b.test"], compressed: false, keepAlive: false }
  assert http.send(req).map((res) => res.body) == Ok("host=b.test enc=- conn=-")
  let sent = http.requests[0] ?? http.request("GET", "-")
  assert sent.compressed == false
  assert sent.keepAlive == false
}
`);
  expect(r.stdout + r.stderr).toContain('2 passed, 0 failed');
}, 240_000);
