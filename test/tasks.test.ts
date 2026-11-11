import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { plain } from './plain';
import { compileSplit } from './split';

const root = path.join(import.meta.dir, '..');
const mod = (body: string, extra = '', uses = 'io, tasks') => `module m\n${extra}fn main() uses ${uses} {\n${body}\n}\n`;
const diags = (src: string) => compileSplit(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (src: string) => compileSplit(src, 't').diagnostics.map((d) => d.code);
const lookups =
  'fn find(id: int) -> Result<int, string> {\n  return Ok(id)\n}\nfn other(id: int) -> Result<int, bool> {\n  return Ok(id)\n}\n';

describe('scopes', () => {
  test('a scope returns what its function returns', () => {
    const body = '  let n = tasks.scope((s) => {\n    let a = s.spawn(() => 1)\n    let b = s.spawn(() => 2)\n    return a.join() + b.join()\n  })\n  io.println(n.toString())';
    expect(codes(mod(body))).toEqual([]);
  });

  test('tasks that can fail: `return Ok(...)` is enough, the error type comes from them', () => {
    const body = '  let r = tasks.scope((s) => {\n    let a = s.spawn(() => find(1))\n    return Ok(a.join()? + 1)\n  })\n  io.println((r == Ok(2)).toString())';
    expect(codes(mod(body, lookups))).toEqual([]);
  });

  test('a task that can fail needs a scope that returns a Result', () => {
    const body = '  let n = tasks.scope((s) => {\n    s.spawn(() => find(1))\n    return 1\n  })\n  io.println(n.toString())';
    expect(diags(mod(body, lookups))).toEqual([
      ['CAN0005', "end the scope's function with `return Ok(...)`: the first failure becomes the scope's result"],
    ]);
  });

  test('with the same error type', () => {
    const body = '  let r = tasks.scope((s) => {\n    let a = s.spawn(() => find(1))\n    s.spawn(() => other(1))\n    return Ok(a.join()?)\n  })\n  io.println((r == Ok(1)).toString())';
    expect(diags(mod(body, lookups))).toEqual([['CAN0005', 'there is no automatic error conversion; convert it with `match` inside the task']]);
  });

  test('a Scope passed to a function can only take tasks that cannot fail', () => {
    const extra = `${lookups}fn helper(s: Scope) -> Task<int> {\n  return s.spawn(() => 1)\n}\nfn bad(s: Scope) {\n  s.spawn(() => find(1))\n}\n`;
    expect(codes(mod('  let n = tasks.scope((s) => helper(s).join())\n  io.println(n.toString())', extra))).toEqual(['CAN0005']);
  });

  test('effects of spawned work belong to the function that spawns it', () => {
    const src = 'module m\nfn work() uses tasks {\n  tasks.scope((s) => {\n    s.spawn(() => io.println("x"))\n  })\n}\nfn main() {}\n';
    expect(codes(src)).toContain('CAN0004');
    expect(diags('module m\nfn main() {\n  tasks.scope((s) => 1)\n}\n')[0]).toEqual(['CAN0004', 'add `uses tasks` to the signature of `fn main`']);
  });

  test('s.wait() waits for every task spawned so far, gives nothing back, and takes no arguments', () => {
    const body =
      '  let n = tasks.scope((s) => {\n    s.spawn(() => io.println("a"))\n    s.wait()\n    s.spawn(() => io.println("b"))\n    s.wait()\n    return 1\n  })\n  io.println(n.toString())';
    const r = compileSplit(mod(body), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('s.Wait(ctx__)');
    expect(codes(mod('  tasks.scope((s) => {\n    s.wait(1)\n  })', '', 'tasks'))).toEqual([Codes.ArgCount]);
    expect(codes(mod('  tasks.scope((s) => {\n    let x = s.wait()\n    io.println("x")\n  })'))).toEqual([Codes.NoValue]);
    // A Scope that came in as a parameter can wait too.
    expect(codes(mod('  tasks.scope((s) => drain(s))', 'fn drain(s: Scope) {\n  s.wait()\n}\n', 'tasks'))).toEqual([]);
  });

  test('Scope and Task are not values to compare or methods to forget calling', () => {
    expect(codes(mod('  tasks.scope((s) => {\n    let a = s.spawn(() => 1)\n    let same = a == a\n  })'))).toContain('CAN0019');
    expect(diags(mod('  let f = tasks.scope', '', 'tasks'))[0]).toEqual(['CAN0020', 'write `.scope(...)`']);
    expect(diags(mod('  tasks.spawn(() => 1)', '', 'tasks'))).toEqual([['CAN0008', 'available: scope, all, both, race, timeout, select, after, otherwise']]);
  });
});

describe('helpers', () => {
  test('all: a List, or a Result of one when the function can fail', () => {
    expect(codes(mod('  let xs: List<int> = tasks.all([1, 2], (x) => x * 2)\n  io.println(xs.length().toString())'))).toEqual([]);
    expect(codes(mod('  let r: Result<List<int>, string> = tasks.all([1, 2], (x) => find(x))\n  io.println((r == Ok([1])).toString())', lookups))).toEqual([]);
  });

  test('race: functions without parameters, which may use different effects', () => {
    expect(codes(mod('  let n = tasks.race([() => 1, () => {\n    io.println("b")\n    return 2\n  }])\n  io.println(n.toString())'))).toEqual([]);
    expect(codes(mod('  let n = tasks.race([1, () => 2])\n  io.println(n.toString())'))).toEqual(['CAN0005']);
  });

  test('timeout: an optional, or a bool for a function that returns nothing', () => {
    expect(codes(mod('  let n: int? = tasks.timeout(100, () => 1)\n  let done: bool = tasks.timeout(100, () => io.println("x"))\n  io.println(done.toString())'))).toEqual(['CAN0013']);
    expect(diags(mod('  let x: int? = none\n  let n = tasks.timeout(100, () => x)\n  io.println("x")'))[0]).toEqual(['CAN0005', 'return a Result instead']);
  });
});

describe('habits', () => {
  test('await, async and go', () => {
    expect(diags(mod('  let x = await find(1)', lookups))[0]).toEqual([
      'CAN0001',
      'calls wait for their result already; to run things at the same time, use `tasks.scope` or `tasks.all`',
    ]);
    expect(diags('module m\nasync fn f() {}\n')[0][0]).toBe('CAN0001');
    expect(diags(mod('  go work()'))[0][0]).toBe('CAN0001');
    // Still ordinary names otherwise.
    expect(codes(mod('  let await = 1\n  io.println(await.toString())', '', 'io'))).toEqual([]);
  });
});

describe('Go', () => {
  test('every function gets the context, and every loop checks it', () => {
    const r = compileSplit('module m\nfn spin(n: int) -> int {\n  let mut i = 0\n  while i < n {\n    i += 1\n  }\n  return i\n}\nfn main() {}\n', 't');
    expect(r.go).toContain('func m__spin(ctx__ *candor.Ctx, n int64) int64 {');
    expect(plain(r.go)).toContain('for (i < n) {\n\t\tctx__.Check()');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });

describe('runtime', () => {
  test(
    'Go tests: parallelism, cancellation, no goroutine outlives its scope, the scheduler',
    () => {
      const r = spawnSync(go, ['test', '-count=1', './...'], { cwd: path.join(root, 'runtime', 'go'), encoding: 'utf8' });
      expect(r.stdout + r.stderr).toContain('ok');
      expect(r.status).toBe(0);
    },
    120_000,
  );

  test(
    'the same seed gives the same task order; other seeds give others',
    () => {
      const order = (seed: number) => {
        const r = cli('test', 'test/fixtures/interleave.candor', '--seed', String(seed), '--out', path.join(tmpdir(), 'candor-test', 'interleave'));
        expect(r.stdout).toContain(`seed ${seed}: run with --seed ${seed}`);
        return r.stdout.match(/"([a-d]{8})"/)![1];
      };
      const first = order(1);
      expect(order(1)).toBe(first);
      const others = new Set([2, 3, 4, 5].map(order));
      expect(others.size).toBeGreaterThan(1);
    },
    120_000,
  );

  test(
    'a test that starts tasks runs in many orders until one fails, and its seed replays that one',
    () => {
      const out = path.join(tmpdir(), 'candor-test', 'lost-update');
      const r = cli('test', 'test/fixtures/lost-update.candor', '--seed', '1', '--runs', '100', '--out', out);
      expect(r.stdout).toMatch(/^FAIL three bumps make three \(test\/fixtures\/lost-update_test.candor:13\), run \d+ of 100\n/);
      expect(r.stdout).toContain('PASS one task (100 runs)\n');
      const seed = r.stdout.match(/seed (\d+): run with --seed \1 --only "three bumps make three" for the same task order\n/)![1];
      const again = cli('test', 'test/fixtures/lost-update.candor', '--seed', seed, '--only', 'three', '--out', out);
      expect(again.stdout).toStartWith('FAIL three bumps make three (test/fixtures/lost-update_test.candor:13)\n');
      expect(again.status).toBe(1);
      // A seed alone is one order.
      expect(cli('test', 'test/fixtures/lost-update.candor', '--seed', seed, '--only', 'one', '--out', out).stdout).toStartWith('PASS one task\n');
    },
    120_000,
  );
});
