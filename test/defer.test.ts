import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit } from './split';

// Card 074: `defer { ... }` runs when its function ends: on return, `?`, a panic or a cancel,
// last one first, shielded from the cancel. test/fixtures/defer.candor runs each case.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const fixture = path.join(root, 'test', 'fixtures', 'defer.candor');
const out = path.join(tmpdir(), 'candor-test', 'defer');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args, fixture, '--out', out], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io {\n${body}\n}\n`;
const bare = (body: string) => `module m\nfn main() {\n${body}\n}\n`;
const diags = (src: string) => compileSplit(src, 't').diagnostics.map((d) => [d.code, d.message]);
const codes = (src: string) => compileSplit(src, 't').diagnostics.map((d) => d.code);
const find = 'fn find(ok: bool) -> Result<int, string> {\n  if ok {\n    return Ok(1)\n  }\n  return Err("no")\n}\n';

describe('checks', () => {
  test('at the top level of a function, lambda or test body', () => {
    expect(codes(mod('  defer {\n    io.println("bye")\n  }\n  io.println("hi")'))).toEqual([]);
    const lambda = mod('  let f = () => {\n    defer {\n      io.println("bye")\n    }\n    io.println("hi")\n  }\n  f()');
    expect(codes(lambda)).toEqual([]);
    expect(codes('module m\nfn main() {}\ntest "t" {\n  defer {\n    assert true\n  }\n  assert true\n}\n')).toEqual([]);
    expect(compileSplit(mod('  defer {\n    io.println("bye")\n  }'), 't').go).toContain('defer candor.Deferred(ctx__, func(ctx__ *candor.Ctx) {');
  });

  test('not in a block inside the body, nor in another defer', () => {
    expect(diags(mod('  if true {\n    defer {\n      io.println("bye")\n    }\n  }'))).toEqual([[Codes.BadDefer, '`defer` goes at the top level of a function body']]);
    expect(codes(mod('  for _ in 0..2 {\n    defer {\n      io.println("bye")\n    }\n  }'))).toEqual([Codes.BadDefer]);
    expect(diags(mod('  defer {\n    defer {\n      io.println("bye")\n    }\n  }'))).toEqual([[Codes.BadDefer, 'a `defer` cannot hold another `defer`']]);
  });

  test('no `return` or `?`; a lambda inside is its own function', () => {
    expect(codes(bare('  defer {\n    return\n  }'))).toEqual([Codes.BadDefer]);
    const tryIn = compileSplit(mod('  defer {\n    io.println("${find(true)?}")\n  }', find), 't').diagnostics;
    expect(tryIn.map((d) => [d.code, d.help])).toEqual([[Codes.BadDefer, 'handle the error here with `match`']]);
    const inLambda = '  defer {\n    let f = () => {\n      let n = find(true)?\n      return Ok(n)\n    }\n    match f() {\n      Ok(n) => io.println("${n}"),\n      Err(e) => io.println(e),\n    }\n  }';
    expect(codes(mod(inLambda, find))).toEqual([]);
  });

  test('reads the locals, but cannot change them', () => {
    expect(codes(mod('  let mut n = 1\n  defer {\n    io.println("${n}")\n  }\n  n += 1'))).toEqual([]);
    expect(diags(bare('  let mut n = 1\n  defer {\n    n += 1\n  }\n  n += 1'))).toEqual([
      [Codes.BadDefer, 'a `defer` cannot assign to `n`: it runs after the function has returned, so the change would be lost'],
    ]);
    expect(codes(bare('  let mut xs = [1]\n  defer {\n    xs.push(2)\n  }\n  xs.push(3)'))).toEqual([Codes.BadDefer]);
    // Its own variables are its own.
    expect(codes(mod('  defer {\n    let mut i = 0\n    i += 1\n    io.println("${i}")\n  }'))).toEqual([]);
  });

  test('what a test proved of a `let mut` may be stale when it runs', () => {
    const fixed = '  let x: int? = 1\n  if x == none {\n    return\n  }\n  defer {\n    io.println("${x + 1}")\n  }';
    expect(codes(mod(fixed))).toEqual([]);
    const changing = '  let mut x: int? = 1\n  if x == none {\n    return\n  }\n  defer {\n    io.println("${x + 1}")\n  }\n  x = none';
    expect(codes(mod(changing))).toEqual([Codes.InvalidOperands]);
  });

  test('takes a block', () => {
    expect(codes(mod('  defer io.println("bye")'))).toEqual([Codes.SyntaxError]);
  });
});

describe('run', () => {
  test(
    'on return and `?`, last first; on a cancel, with effects; on a panic',
    () => {
      const r = cli('run');
      expect(r.status).toBe(2);
      expect(r.stdout).toBe(
        [
          'early: got 1',
          'early: second',
          'early: first',
          'ok 1',
          'early: second',
          'early: first',
          'err no',
          'spin: cleaned up 3',
          'cancelled: 3',
          'visits: 2',
          'divide: cleaned up',
          '',
        ].join('\n'),
      );
      expect(r.stderr).toStartWith('panic: integer divide by zero\n');
    },
    120_000,
  );

  test(
    'under the test scheduler',
    () => {
      const r = cli('test');
      expect(r.stdout).toContain('2 passed, 0 failed');
    },
    120_000,
  );
});
