import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plain } from './plain';
import { compileSplit, writeModule } from './split';

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io, tasks {\n${body}\n}\n`;
// `body` inside a scope, whose function returns nothing.
const inScope = (body: string, extra = '') => mod(`  tasks.scope((s) => {\n${body}\n  })`, extra);
const diags = (src: string) => compileSplit(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);
const helps = (src: string) => diags(src).map(([, , h]) => h);

describe('made by a scope', () => {
  test('what they hold comes from the value, or from where they go', () => {
    expect(diags(inScope('    let m = s.mutex(0)\n    let a: Atomic<bool> = s.atomic(false)\n    let ch: Channel<int?> = s.channel(2)\n    let t: Mutex<List<int>> = s.mutex([])\n    m.update((n) => n + 1)\n    a.set(true)\n    ch.send(none)\n    t.update((xs) => xs.concat([1]))'))).toEqual([]);
  });

  test('a channel says what goes through it', () => {
    expect(diags(inScope('    let ch = s.channel(1)\n    ch.close()'))).toEqual([
      ['CAN0032', 'cannot tell what goes through this channel', 'annotate it: `let ch: Channel<int> = s.channel(8)`'],
    ]);
  });

  test('an Atomic holds an int or a bool', () => {
    expect(diags(inScope('    let a = s.atomic("x")\n    a.get()'))).toEqual([['CAN0005', 'an Atomic holds an int or a bool, not string', 'for anything else, use a Mutex: `s.mutex(...)`']]);
    expect(diags(mod('', 'fn f(a: Atomic<List<int>>) {}\n'))[0][1]).toBe('an Atomic holds an int or a bool, not List<int>');
  });

  test("they belong to the scope: its function can't return one", () => {
    expect(diags(mod('  let ch = tasks.scope((s) => {\n    let c: Channel<int> = s.channel(1)\n    return c\n  })'))[0].slice(1)).toEqual([
      "a Channel<int> belongs to the scope that made it, so the scope's function can't return one",
      'make it with an outer scope, or return what you read from it',
    ]);
    expect(diags(mod('  let p = tasks.scope((s) => (1, s.mutex(0)))'))[0][1]).toBe("(int, Mutex<int>) holds a Mutex<int>, which belongs to the scope that made it, so the scope's function can't return one");
  });

  test('handles: no `==`, and a helper needs no `uses`', () => {
    expect(helps(inScope('    let m = s.mutex(0)\n    let same = m == m'))).toEqual(['a Mutex is shared by tasks, not a value: compare what you read from it']);
    const helper = 'fn bump(m: Mutex<int>) -> int {\n  return m.update((n) => n + 1)\n}\nfn reset<T>(m: Mutex<T>, v: T) {\n  m.update((old) => v)\n}\n';
    expect(diags(inScope('    let m = s.mutex(0)\n    bump(m)\n    reset(m, 5)', helper))).toEqual([]);
  });
});

describe('a Mutex', () => {
  test('changes by function, which runs under the lock and so uses no effects', () => {
    expect(diags(inScope('    let m = s.mutex(0)\n    m.update((n) => {\n      io.println("hi")\n      return n + 1\n    })'))).toEqual([
      ['CAN0052', "the function given to `update` runs while the Mutex is locked, so it can't use effects (it uses io)", 'do the effect before or after: `update` gives back what the function returned'],
    ]);
    expect(helps(inScope('    let m = s.mutex(0)\n    m.set(1)'))).toEqual(['a Mutex changes by function, so no update is lost: `m.update((v) => ...)`']);
  });

  test('`updateWith` gives back a result', () => {
    expect(diags(inScope('    let m = s.mutex(0)\n    let old: int = m.updateWith((n) => (n + 1, n))'))).toEqual([]);
    expect(diags(inScope('    let m = s.mutex(0)\n    m.updateWith((n) => n)'))[0][2]).toBe('as in `m.updateWith((n) => (n + 1, n))`, which stores n + 1 and gives back n');
  });
});

describe('a Channel', () => {
  test('`for x in ch` until it is closed', () => {
    const r = compileSplit(inScope('    let ch: Channel<(int, string)> = s.channel(1)\n    ch.send((1, "a"))\n    ch.close()\n    for (n, w) in ch {\n      io.println(w + n.toString())\n    }'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('t__1 := ch\n\t\tfor {\n\t\t\tt__3, t__2 := t__1.Recv(ctx__)\n\t\t\tif !t__2 {\n\t\t\t\tbreak\n\t\t\t}\n\t\t\tvar n int64 = t__3.V0');
    expect(diags(inScope('    let m = s.mutex(0)\n    for x in m {\n    }'))[0][2]).toBe('`for` takes a List, a Map, a Channel, or a range `a..b`');
  });

  test('`recv` gives none once closed and empty', () => {
    const r = compileSplit(inScope('    let ch: Channel<int> = s.channel(1)\n    ch.close()\n    io.println((ch.recv() ?? -1).toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('optOf__(ch.Recv(ctx__))');
  });
});

describe('tasks.both', () => {
  test('a tuple, or a Result of one if either can fail', () => {
    const f = 'fn find(id: int) -> Result<int, string> {\n  return Ok(id)\n}\n';
    expect(diags(mod('  let (a, b) = tasks.both(() => 1, () => "x")\n  io.println(b + a.toString())', f))).toEqual([]);
    expect(diags(mod('  let r: Result<(int, string), string> = tasks.both(() => find(1), () => "x")\n  io.println((r == Ok((1, "x"))).toString())', f))).toEqual([]);
  });

  test('the same error, and something to give back', () => {
    const f = 'fn find(id: int) -> Result<int, string> {\n  return Ok(id)\n}\nfn other(id: int) -> Result<int, bool> {\n  return Ok(id)\n}\n';
    expect(diags(mod('  tasks.both(() => find(1), () => other(1))', f))[0][1]).toBe('both functions can fail, but with different errors, string and bool');
    expect(diags(mod('  tasks.both(() => io.println("a"), () => 1)'))[0][1]).toBe('`tasks.both` gives both results, but this function returns nothing');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

describe('run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'shared');
  mkdirSync(dir, { recursive: true });
  const bumps = `module bumps

fn bump(n: int) -> (int, int) uses tasks {
  return tasks.scope((s) => {
    let m = s.mutex(0)
    let a = s.atomic(0)
    let mut ts: List<Task<void>> = []
    for _ in 0..n {
      ts.push(s.spawn(() => {
        m.update((x) => x + 1)
        a.add(1)
      }))
    }
    for t in ts {
      t.join()
    }
    return (m.get(), a.get())
  })
}

fn drain(n: int, close: bool) -> int uses tasks {
  return tasks.scope((s) => {
    let ch: Channel<int> = s.channel(2)
    let sum = s.atomic(0)
    let worker = s.spawn(() => {
      for x in ch {
        sum.add(x)
      }
    })
    for i in 0..n {
      ch.send(i)
    }
    if close {
      ch.close()
    }
    worker.join()
    return sum.get()
  })
}

fn main() uses io, tasks {
  let (m, a) = bump(100)
  io.println(m.toString() + " " + a.toString() + " " + drain(10, true).toString())
}

test "100 tasks lose nothing" {
  assert bump(100) == (100, 100)
  assert drain(10, true) == 45
}

test "a forgotten close" {
  assert drain(3, false) == 3
}
`;

  test(
    'on goroutines, 100 tasks bumping a Mutex and an Atomic lose nothing',
    () => {
      writeModule(path.join(dir, 'bumps.candor'), bumps);
      for (let i = 0; i < 3; i++) {
        const r = cli(dir, 'run', 'bumps.candor', '--out', path.join(dir, 'out'));
        expect(r.stderr).toBe('');
        expect(r.stdout).toBe('100 100 45\n');
      }
    },
    120_000,
  );

  test(
    'on the test scheduler too, and a forgotten close is a deadlock with its seed',
    () => {
      writeModule(path.join(dir, 'bumps.candor'), bumps);
      const r = cli(dir, 'test', 'bumps.candor', '--out', path.join(dir, 'test'));
      expect(r.stdout).toContain('PASS 100 tasks lose nothing (100 runs)\n');
      expect(r.stdout).toContain(
        'FAIL a forgotten close\n\n    panic: candor: deadlock: every task is waiting and nothing can wake them (1 on Task.join, 1 on Channel.recv)\n      is a Channel never closed? `ch.close()` ends a `for x in ch` loop\n      at bumps.candor:36 in drain\n      at bumps.candor:22 in drain\n      at bumps_test.candor:52 in test "a forgotten close"\n',
      );
      const seed = r.stdout.match(/run with --seed (\d+)/)![1];
      const again = cli(dir, 'test', 'bumps.candor', '--out', path.join(dir, 'test'), '--seed', seed);
      // A seed alone runs one order.
      expect(again.stdout).toBe(r.stdout.replace(' (100 runs)', ''));
    },
    120_000,
  );
});
