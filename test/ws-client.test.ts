import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// A WebSocket client, `http.connect(url, talk)`. The connection closes when `talk`
// returns. In tests the handler given to `http.answer` is the server, in memory.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const fixture = path.join(import.meta.dir, 'fixtures', 'ws-client.candor');
const out = path.join(import.meta.dir, '..', '.candor', 'test-ws-client');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go }, timeout: 120_000 });

test('the fake: the app handler answers, under the task scheduler; a crash in it fails the test', () => {
  const r = cli('test', fixture, '--out', path.join(out, 'test'));
  expect(r.stdout).toContain("PASS the fake: the app's handler is the server (100 runs)");
  expect(r.stdout).toContain('4 passed, 1 failed');
  expect(r.stdout).toContain('panic: integer divide by zero');
  expect(r.stdout).toContain('in talkOver');
}, 120_000);

test('a real client talks to a real server, sends a header twice and binary messages, and is refused where no WebSocket is', async () => {
  const built = cli('build', fixture, '--out', path.join(out, 'build'));
  expect(built.stderr).toBe('');
  const exe = built.stdout.trim();
  const port = String(18_100 + Math.floor(Math.random() * 800));
  const server = Bun.spawn([exe], { env: { ...process.env, PORT: port, SERVE: '1' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) break;
      if (i > 100) throw new Error('the server never came up');
      await Bun.sleep(50);
    }
    const client = Bun.spawn([exe], { env: { ...process.env, PORT: port }, stdout: 'pipe', stderr: 'pipe' });
    expect(await client.exited).toBe(0);
    expect((await new Response(client.stdout).text()).replace(/\r\n/g, '\n')).toBe(
      `hello ada and bo\nclosed\necho: one\necho: two\nbinary 0102ff0102ff\ntext got hi\nlast\nfailed: ws://127.0.0.1:${port}/nope answered 404, not a WebSocket\n`,
    );
  } finally {
    server.kill();
  }
}, 120_000);
