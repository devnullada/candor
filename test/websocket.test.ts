import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// WebSockets. `http.upgrade(req, (ws) => ...)` talks over the connection with
// `ws.send(text)` and `ws.receive()` (none once closed), on github.com/coder/websocket; in a test,
// `http.socketOf(s, res)` runs the handler in a task and gives the test the client's end.
// test/fixtures/ws-chat.candor is an echo server and a chat room.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const fixture = path.join(root, 'test', 'fixtures', 'ws-chat.candor');
const out = path.join(tmpdir(), 'candor-test', 'websocket');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args, fixture, '--out', out], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

/** A client whose messages queue until asked for. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  const waiting: ((m: string) => void)[] = [];
  let closed = false;
  const onClose: (() => void)[] = [];
  ws.onmessage = (e) => {
    const m = String(e.data);
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  };
  ws.onclose = () => {
    closed = true;
    for (const f of onClose) f();
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error(`cannot connect to ${url}`));
  });
  return {
    send: (m: string) => ws.send(m),
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<string>((ok) => waiting.push(ok))),
    /** Messages until one ends with the text: others in the room may talk first. */
    async until(text: string) {
      for (;;) {
        const m = await this.next();
        if (m.endsWith(text)) return m;
      }
    },
    close: () => ws.close(),
    closed: () => (closed ? Promise.resolve() : new Promise<void>((ok) => onClose.push(ok))),
  };
}

test('the fake: the test plays the client, under the task scheduler', () => {
  const r = cli('test');
  expect(r.stdout).toBe('PASS echo, the test playing the client (100 runs)\nPASS a chat of two, and one leaving (100 runs)\n\n2 passed, 0 failed\n');
}, 120_000);

test('echo and a chat with real clients; stopping the server closes them', async () => {
  const build = cli('build');
  expect(build.status).toBe(0);
  const port = String(18_400 + Math.floor(Math.random() * 90));
  const server = spawn(build.stdout.trim(), [], { env: { ...process.env, PORT: port, STOP_MS: '4000' } });
  let stdout = '';
  server.stdout.on('data', (d) => (stdout += d));
  const exited = new Promise<number | null>((ok) => server.on('exit', ok));
  try {
    const base = `ws://127.0.0.1:${port}`;
    let echo: Awaited<ReturnType<typeof connect>> | null = null;
    for (let i = 0; i < 100 && !echo; i++) {
      try {
        echo = await connect(`${base}/echo`);
      } catch {
        await Bun.sleep(50);
      }
    }
    echo!.send('hi');
    expect(await echo!.next()).toBe('echo: hi');
    echo!.send('bye');
    await echo!.closed();

    const ann = await connect(`${base}/chat`);
    const bob = await connect(`${base}/chat`);
    // Each is in the room once it has heard itself; then each hears the other.
    ann.send('hello from ann');
    expect(await ann.until(': hello from ann')).toMatch(/^\d+: hello from ann$/);
    bob.send('hi from bob');
    expect(await bob.until(': hi from bob')).toMatch(/^\d+: hi from bob$/);
    expect(await ann.until(': hi from bob')).toMatch(/^\d+: hi from bob$/);
    bob.close();
    await bob.closed();
    ann.send('still here');
    expect(await ann.until(': still here')).toMatch(/^\d+: still here$/);

    // The server stops at 4 s: Ann's connection is closed for her, and the program ends.
    await ann.closed();
    expect(await exited).toBe(0);
    expect(stdout).toBe('stopped\n');
  } finally {
    server.kill();
  }
}, 120_000);

test('a request that is not an upgrade is refused', async () => {
  const build = cli('build');
  const port = String(18_490 + Math.floor(Math.random() * 9));
  const server = spawn(build.stdout.trim(), [], { env: { ...process.env, PORT: port, STOP_MS: '3000' } });
  try {
    let res: Response | null = null;
    for (let i = 0; i < 100 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/echo`);
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(res!.status).toBe(426);
  } finally {
    server.kill();
  }
}, 120_000);
