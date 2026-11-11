import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockBuild } from '../src/home';
import { writeModule } from './split';

// Candors building the same file at once take turns in its build folder, and a run
// still going doesn't keep the next build from replacing its binary.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

const native = `package native

import "time"

func Nap() int {
\ttime.Sleep(time.Second)
\treturn 7
}
`;

const program = `module r

extern "./native" {
  fn Nap() -> int as nap
}

fn main() uses io {
  io.println("\${nap()}")
}

test "naps" {
  assert nap() == 7
}
`;

const at = (dir: string, command: string) =>
  new Promise<string>((done) => {
    const p = spawn(process.execPath, ['--no-env-file', 'run', cli, command, path.join(dir, 'r.candor')], {
      env: { ...process.env, CANDOR_GO: go, CANDOR_CACHE: path.join(dir, 'cache') },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done(`${code}: ${out.trim().replace(/\r/g, '')}`));
  });

test(
  'three runs and three test runs of one file with a Go package, at once',
  async () => {
    const dir = path.join(tmpdir(), 'candor-test', 'build-lock');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'native'), { recursive: true });
    writeFileSync(path.join(dir, 'native', 'native.go'), native);
    writeModule(path.join(dir, 'r.candor'), program);
    expect(await Promise.all([at(dir, 'run'), at(dir, 'run'), at(dir, 'run')])).toEqual(['0: 7', '0: 7', '0: 7']);
    const tests = await Promise.all([at(dir, 'test'), at(dir, 'test'), at(dir, 'test')]);
    for (const t of tests) expect(t).toStartWith('0: ');
  },
  240_000,
);

test("a lock whose candor is gone is taken over; a live one's is waited for", async () => {
  const dir = path.join(tmpdir(), 'candor-test', 'build-lock-unit');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // No process has pid 2^31-1.
  writeFileSync(path.join(dir, '.lock'), String(2 ** 31 - 1));
  const unlock = lockBuild(dir);
  expect(existsSync(path.join(dir, '.lock'))).toBe(true);
  unlock();
  expect(existsSync(path.join(dir, '.lock'))).toBe(false);

  // Held by this (live) process: a child candor waits until it is let go, then takes it.
  writeFileSync(path.join(dir, '.lock'), String(process.pid));
  const home = JSON.stringify(path.join(import.meta.dir, '..', 'src', 'home.ts'));
  const child = Bun.spawn([process.execPath, '-e', `require(${home}).lockBuild(${JSON.stringify(dir)})(); console.log("got it")`], { stdout: 'pipe' });
  await Bun.sleep(500);
  expect(child.exitCode).toBe(null);
  rmSync(path.join(dir, '.lock'));
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe('got it\n');
  expect(existsSync(path.join(dir, '.lock'))).toBe(false);
});
