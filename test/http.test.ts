import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// HTTP: `http.serve(addr, handle)` runs `handle` in a task per request; `http.route` matches paths.
// Ctrl-C / SIGTERM stops `serve` gracefully; repeated query keys and headers.

const program = `module hello
import "http"

struct Greeting {
  hello: string
}
impl Json for Greeting

fn handle(req: http.Request) -> http.Response uses clock {
  let hi = http.route(req, "GET /hi/{name}")
  if hi != none {
    return http.jsonResponse(200, Greeting { hello: hi["name"] ?? "" })
  }
  if http.route(req, "GET /echo") != none {
    return http.textResponse(200, "\${req.query["x"] ?? "-"} \${req.headers["x-name"] ?? "-"} \${req.body} from \${req.remote ?? "-"}\${if (req.remotePort ?? 0) > 0 { ":port" } else { "" }}")
  }
  if http.route(req, "GET /all") != none {
    return http.textResponse(200, "\${http.queryAll(req, "x").join(",")} \${http.headerAll(req, "X-Name").join(",")}")
  }
  if http.route(req, "GET /host") != none {
    return http.textResponse(200, "\${req.headers["host"] ?? "-"} \${http.headerAll(req, "host").join(",")}")
  }
  if http.route(req, "GET /cookies") != none {
    return cookies()
  }
  if http.route(req, "/slow") != none {
    clock.sleep(300)
    return http.emptyResponse(204)
  }
  if http.route(req, "/boom") != none {
    let xs = [1]
    return http.textResponse(200, "\${xs[5] ?? 0 / (xs.length() - 1)}")
  }
  return http.textResponse(404, "no route \${req.method} \${req.path}")
}

fn cookies() -> http.Response {
  return http.addHeader(http.addHeader(http.emptyResponse(204), "Set-Cookie", "a=1"), "set-cookie", "b=2")
}

fn main() uses io, env, clock, http, tasks {
  // Loopback only: listening on every interface makes Windows ask for a firewall rule.
  match http.serve("127.0.0.1:\${env.get("PORT") ?? "8080"}", handle) {
    Ok() => io.println("stopped"),
    Err(e) => io.println("can't serve: \${e}"),
  }
}

fn get(path: string) -> http.Request {
  return http.Request { method: "GET", path, query: [:], headers: [:], body: "" }
}

test "route matches a method and a path, and gives the parameters" {
  assert http.route(get("/hi/ada"), "GET /hi/{name}") == ["name": "ada"]
  assert http.route(get("/hi/ada"), "/hi/{name}") == ["name": "ada"]
  assert http.route(get("/hi/ada"), "POST /hi/{name}") == none
  assert http.route(get("/hi/"), "/hi/{name}") == none
  assert http.route(get("/hi/ada/x"), "/hi/{name}") == none
  assert http.route(get("/a/1/b/2"), "/a/{x}/b/{y}") == ["x": "1", "y": "2"]
  assert http.route(get("/todos"), "/todos") != none
}

test "a handler is a function, called directly" {
  assert handle(get("/hi/ada")) == http.jsonResponse(200, Greeting { hello: "ada" })
  assert handle(get("/hi/ada")).headers["content-type"] == "application/json"
  assert handle(get("/nope")).status == 404
  assert get("/nope").remote == none
  assert get("/nope").remotePort == none
  assert handle(http.Request { ...get("/host"), headers: ["host": "localhost:8080"] }).body == "localhost:8080 localhost:8080"
}

test "repeated query keys and headers, read and written" {
  let req = http.withHeader(http.withQuery(get("/all"), "x", ["1", "2"]), "X-Name", ["ada", "bo"])
  assert req.query["x"] == "1"
  assert req.headers["x-name"] == "ada"
  assert handle(req).body == "1,2 ada,bo"
  assert http.queryAll(get("/all"), "x") == []
  assert http.queryAll(http.Request { ...get("/all"), query: ["x": "3"] }, "x") == ["3"]
  assert http.queryAll(http.withQuery(get("/all"), "x", []), "x") == []
  assert http.withQuery(get("/all"), "x", []).query == [:]
  assert http.responseHeaderAll(cookies(), "set-cookie") == ["a=1", "b=2"]
  assert cookies().headers["set-cookie"] == "a=1"
  assert http.addHeader(http.emptyResponse(200), "x", "1") == http.Response { status: 200, headers: ["x": "1"], body: "" }
}

test "serve doesn't run in tests" {
  assert http.serve(":0", handle) == Err("tests don't serve: call the handler with an http.Request")
}
`;

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const dir = path.join(tmpdir(), 'candor-test', 'http');
mkdirSync(dir, { recursive: true });
writeModule(path.join(dir, 'hello.candor'), program);

test(
  'route and the handler, in test blocks',
  () => {
    const t = cli(dir, 'test', 'hello.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('4 passed, 0 failed');
  },
  120_000,
);

test(
  'serves: a task per request, query and headers, and a crash is a 500',
  async () => {
    const built = cli(dir, 'build', 'hello.candor', '--out', path.join(dir, 'out'));
    expect(built.stderr).toBe('');
    const exe = built.stdout.trim();
    const port = 18_100 + Math.floor(Math.random() * 800);
    const server = Bun.spawn([exe], { env: { ...process.env, PORT: String(port) }, stderr: 'pipe', stdout: 'pipe' });
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; ; i++) {
        const up = await fetch(`${url}/hi/x`).then(() => true, () => false);
        if (up) break;
        if (i > 100) throw new Error('the server never came up');
        await Bun.sleep(50);
      }
      const hi = await fetch(`${url}/hi/ada`);
      expect([hi.status, hi.headers.get('content-type'), await hi.text()]).toEqual([200, 'application/json', '{"hello":"ada"}']);
      const echo = await fetch(`${url}/echo?x=1&x=2`, { headers: { 'X-Name': 'ada' }, method: 'GET' });
      expect(await echo.text()).toBe('1 ada  from 127.0.0.1:port');
      // fetch joins a repeated header into one line; Go's runtime test sends two.
      const all = await fetch(`${url}/all?x=1&x=2`, { headers: { 'X-Name': 'ada' } });
      expect(await all.text()).toBe('1,2 ada');
      // Go keeps Host out of its headers; serve puts it back.
      const host = await fetch(`${url}/host`);
      expect(await host.text()).toBe(`127.0.0.1:${port} 127.0.0.1:${port}`);
      const cookies = await fetch(`${url}/cookies`);
      expect(cookies.headers.getSetCookie()).toEqual(['a=1', 'b=2']);

      // Ten requests that sleep 300 ms each take about 300 ms together, not 3 s.
      const start = Date.now();
      const slow = await Promise.all(Array.from({ length: 10 }, () => fetch(`${url}/slow`).then((r) => r.status)));
      expect(slow).toEqual(Array(10).fill(204));
      expect(Date.now() - start).toBeLessThan(2000);

      const boom = await fetch(`${url}/boom`);
      expect(boom.status).toBe(500);
      expect((await fetch(`${url}/hi/again`)).status).toBe(200);
    } finally {
      server.kill();
    }
    const err = await new Response(server.stderr).text();
    expect(err).toContain('panic: integer divide by zero');
    expect(err).toContain('in handle');
    expect(err).toContain('in a request: GET /boom, answered 500');
  },
  120_000,
);

test(
  "says why it can't listen",
  () => {
    const built = cli(dir, 'build', 'hello.candor', '--out', path.join(dir, 'out'));
    const r = spawnSync(built.stdout.trim(), { env: { ...process.env, PORT: 'nope' }, encoding: 'utf8' });
    expect(r.stdout).toStartWith("can't serve: listen tcp: ");
  },
  120_000,
);

// Bun's kill on Windows ends the process outright; Go's runtime test sends the signal there
// (`runtime/go/http_test.go`).
test.skipIf(process.platform === 'win32')(
  'SIGTERM stops serving: the request in flight finishes, main carries on, exit 0',
  async () => {
    const built = cli(dir, 'build', 'hello.candor', '--out', path.join(dir, 'out'));
    const port = 18_100 + Math.floor(Math.random() * 800);
    const server = Bun.spawn([built.stdout.trim()], { env: { ...process.env, PORT: String(port) }, stderr: 'pipe', stdout: 'pipe' });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      if (await fetch(`${url}/hi/x`).then(() => true, () => false)) break;
      if (i > 100) throw new Error('the server never came up');
      await Bun.sleep(50);
    }
    const slow = fetch(`${url}/slow`).then((r) => r.status);
    await Bun.sleep(100);
    server.kill('SIGTERM');
    expect(await slow).toBe(204);
    expect(await server.exited).toBe(0);
    expect(await new Response(server.stdout).text()).toBe('stopped\n');
  },
  120_000,
);
