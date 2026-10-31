import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 070: server-sent events. `http.events` sends them on 063's streamed body, `http.eventsOf`
// reads them back in a test, and `http.listen` is the client: a fold over the events, resuming a
// broken stream with `last-event-id`. Underneath, `http.openStream` and `http.readResponse` read
// any body as it comes.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cliArgs = (...args: string[]) => ['run', path.join(root, 'src', 'cli.ts'), ...args];
const cli = (dir: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, cliArgs(...args), { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go, ...env } });

const program = `module ticks

import "http"

fn handle(req: http.Request) -> http.Response {
  let from = (req.headers["last-event-id"] ?? "0").toInt() ?? 0
  if http.route(req, "GET /ticks") != none {
    return http.events([:], (send) => {
      for n in from + 1..from + 4 {
        send(http.Event { data: "tick \${n}\\nline two", id: "\${n}" })
      }
      send(http.Event { data: "bye", event: "done" })
    })
  }
  if http.route(req, "GET /flaky") != none {
    // The first connection breaks after two events; the client resumes from the second.
    return http.events([:], (send) => {
      send(http.Event { data: "\${from + 1}", id: "\${from + 1}" })
      if from == 0 {
        send(http.Event { data: "2", id: "2" })
        let zero = from
        send(http.Event { data: "\${1 / zero}" })
      }
    })
  }
  return http.textResponse(404, "no")
}

// \`/forever\` sends until the client goes away, saying so on stderr.
fn live(req: http.Request) -> http.Response uses io, clock {
  if req.path != "/forever" {
    return handle(req)
  }
  return http.events([:], (send) => {
    for n in 0..100_000 {
      io.eprintln("sent \${n}")
      send(http.Event { data: "\${n}" })
      clock.sleep(20)
    }
  })
}

fn show(seen: List<string>, e: http.Event) -> List<string> {
  return seen.concat(["\${e.event ?? "message"}/\${e.id ?? "-"}: \${e.data.replaceAll("\\n", "+")}"])
}

fn listenTo(base: string) -> List<string> uses http, clock {
  // The server starts in another task: wait until it answers.
  for _ in 0..100 {
    match http.get("\${base}/missing") {
      Ok(_) => {
        let empty: List<string> = []
        let ticks = match http.listen("\${base}/ticks", empty, show) {
          Ok(seen) => seen.join(" | "),
          Err(e) => "failed: \${e}",
        }
        let flaky = match http.listen("\${base}/flaky", empty, show) {
          Ok(seen) => seen.join(" | "),
          Err(e) => "failed: \${e}",
        }
        let missing = match http.listen("\${base}/nothing", 0, (n, e) => n + 1) {
          Ok(n) => "\${n}",
          Err(e) => "\${e}",
        }
        return [ticks, flaky, missing]
      }
      Err(_) => clock.sleep(50)
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, tasks, clock, env {
  let port = env.get("PORT") ?? "18300"
  if env.get("MODE") == "serve" {
    match http.serve("127.0.0.1:\${port}", live) {
      Ok() => {},
      Err(e) => io.println("serve: \${e}"),
    }
    return
  }
  let lines = tasks.race([
    () => match http.serve("127.0.0.1:\${port}", live) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => listenTo("http://127.0.0.1:\${port}"),
  ])
  for line in lines {
    io.println(line)
  }
}

test "the handler's events" {
  let res = handle(http.Request { method: "GET", path: "/ticks", query: [:], headers: ["last-event-id": "5"], body: "" })
  assert res.headers["content-type"] == "text/event-stream"
  assert res.headers["cache-control"] == "no-cache"
  let evs = http.eventsOf(res)
  assert evs.length() == 4
  assert evs[0] == http.Event { data: "tick 6\\nline two", id: "6" }
  assert evs[3] == http.Event { data: "bye", event: "done" }
}

test "listen against the fake" {
  http.answer(handle)
  assert http.listen("http://x/ticks", 0, (count, e) => count + 1) == Ok(4)
  let sent = http.sent()
  assert sent.length() == 1
  assert sent.all((r) => r.headers["accept"] == "text/event-stream")
}

test "a canned stream, and a body read as it comes" {
  http.respond("http://x/canned", 200, ": hello\\n\\ndata: a\\r\\ndata: b\\r\\n\\nid: 7\\ndata: c\\n\\n")
  assert http.listen("http://x/canned", "", (s, e) => "\${s}[\${e.data}]") == Ok("[a\\nb][c]")
  match http.openStream(http.request("GET", "http://x/canned")) {
    Ok(res) => assert http.readResponse(res, 0, (n, piece) => n + piece.length()) == Ok(43),
    Err(_) => assert false,
  }
}
`;

function setup(name: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'sse', name);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'ticks.candor'), program);
  return dir;
}

test('events reach a real client as sent; a broken stream resumes from its last id', () => {
  const dir = setup('real');
  const port = String(18_900 + Math.floor(Math.random() * 90));
  const r = cli(dir, { PORT: port }, 'run', 'ticks.candor');
  const lines = r.stdout.replace(/\r\n/g, '\n').split('\n');
  expect(lines.slice(0, 3)).toEqual([
    'message/1: tick 1+line two | message/2: tick 2+line two | message/3: tick 3+line two | done/-: bye',
    'message/1: 1 | message/2: 2 | message/3: 3',
    `http://127.0.0.1:${port}/nothing answered 404, not an event stream`,
  ]);
  // The crash that broke the first /flaky stream is reported, and the server carried on.
  expect(r.stderr).toContain('integer divide by zero');
  expect(r.stderr).toContain('its body cut short');
}, 120_000);

test('the fake: a handler\'s events in order; listen against a handler or a canned body', () => {
  const dir = setup('fake');
  const r = cli(dir, {}, 'test', 'ticks.candor');
  expect(r.stdout).toBe('PASS the handler\'s events\nPASS listen against the fake\nPASS a canned stream, and a body read as it comes\n\n3 passed, 0 failed\n');
}, 120_000);

test('a client that goes away cancels the handler', async () => {
  const dir = setup('cancel');
  const port = String(18_990 + Math.floor(Math.random() * 9));
  const build = cli(dir, {}, 'build', 'ticks.candor');
  expect(build.status).toBe(0);
  const exe = build.stdout.trim();
  const server = spawn(exe, [], { cwd: dir, env: { ...process.env, PORT: port, MODE: 'serve' } });
  let stderr = '';
  server.stderr.on('data', (d) => (stderr += d));
  try {
    let res: Response | null = null;
    const abort = new AbortController();
    for (let i = 0; i < 100 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/forever`, { signal: abort.signal });
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(res?.headers.get('content-type')).toBe('text/event-stream');
    const reader = res!.body!.getReader();
    let text = '';
    while (!text.includes('data: 2\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text.startsWith('data: 0\n\ndata: 1\n\ndata: 2\n\n')).toBe(true);
    abort.abort();
    await Bun.sleep(300);
    const sent = stderr.split('\n').filter((l) => l.startsWith('sent')).length;
    await Bun.sleep(300);
    expect(stderr.split('\n').filter((l) => l.startsWith('sent')).length).toBe(sent);
    expect(sent).toBeLessThan(30);
  } finally {
    server.kill();
  }
}, 120_000);
