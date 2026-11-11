import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// `Lock`, for work under a lock that uses effects.

const diags = (src: string) => compileSplit(src, 't', 'test').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message]);

describe('checking', () => {
  test('`s.lock()` is a `Lock`, which takes no type; `hold` gives what its function returns', () => {
    const ok = 'module m\nfn f(lock: Lock) -> int {\n  return lock.hold(() => 1)\n}\nfn main() uses tasks {\n  tasks.scope((s) => {\n    let lock: Lock = s.lock()\n    let n: int = f(lock)\n  })\n}\n';
    expect(diags(ok)).toEqual([]);
    expect(diags('module m\nfn f(lock: Lock<int>) {}\nfn main() {}\n')).toEqual([['CAN0015', '`Lock` takes no type']]);
  });

  test("the function may use effects, which the call needs", () => {
    const src = (uses: string) => `module m\nfn f(lock: Lock)${uses} {\n  lock.hold(() => io.println("x"))\n}\nfn main() {}\n`;
    expect(diags(src(' uses io'))).toEqual([]);
    expect(diags(src('')).map((d) => d[0])).toEqual(['CAN0004']);
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const program = `module counter

import "fs"

// A read-change-write of a file: without the lock, two tasks read the same count.
fn bump(lock: Lock, file: string) -> Result<void, fs.FsError> uses fs {
  return lock.hold(() => {
    let n = (fs.read(file)?).toInt() ?? 0
    fs.write(file, (n + 1).toString())?
    return Ok()
  })
}

fn count(file: string, n: int) -> Result<string, fs.FsError> uses fs, tasks {
  fs.write(file, "0")?
  tasks.scope((s) => {
    let lock = s.lock()
    for _ in 0..n {
      s.spawn(() => bump(lock, file))
    }
    return Ok()
  })?
  return fs.read(file)
}

fn main() uses io, fs, tasks {
  io.println(count("count.txt", 50).toString())
}

test "no update is lost, whatever the order" {
  assert count("count.txt", 20) == Ok("20")
}

test "a hold inside a hold panics" {
  tasks.scope((s) => {
    let a = s.lock()
    let b = s.lock()
    a.hold(() => b.hold(() => 1))
  })
}

test "a task waiting for a held lock that is never let go: a deadlock that names it" {
  tasks.scope((s) => {
    let lock = s.lock()
    let ch: Channel<int> = s.channel(0)
    s.spawn(() => lock.hold(() => ch.recv()))
    s.spawn(() => lock.hold(() => ch.recv()))
  })
}

test "a hold's result, and the lock let go for the next" {
  let n = tasks.scope((s) => {
    let lock = s.lock()
    let t = s.spawn(() => lock.hold(() => 1))
    return t.join() + lock.hold(() => 2)
  })
  assert n == 3
}
`;

test(
  'many tasks change a file under one Lock: on goroutines, and in every order the scheduler tries',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'lock');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeModule(path.join(dir, 'counter.candor'), program);
    const r = cli(dir, 'run', 'counter.candor', '--out', path.join(dir, 'out'));
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('Ok("50")\n');

    const t = cli(dir, 'test', 'counter.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('PASS no update is lost, whatever the order');
    expect(t.stdout).toContain('FAIL a hold inside a hold panics\n\n    panic: candor: Lock.hold inside a hold: a task holds one Lock at a time');
    // The order of the parts follows the seed's task order.
    expect(t.stdout).toMatch(/every task is waiting and nothing can wake them \(1 on its scope's tasks, 1 on (Channel\.recv, 1 on Lock\.hold|Lock\.hold, 1 on Channel\.recv)\)/);
    expect(t.stdout).toContain("PASS a hold's result, and the lock let go for the next");
    expect(t.stdout).toContain('2 passed, 2 failed');
  },
  120_000,
);
