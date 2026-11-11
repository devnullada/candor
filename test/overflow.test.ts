import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Int arithmetic traps on overflow, `wrapping*` wraps; tuples are ordered, and
// `sortedBy` sorts by a key.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(name: string, src: string, ...args: string[]) {
  const dir = path.join(tmpdir(), 'candor-test', 'overflow', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}
const diags = (src: string) => compileSplit(src, 't').diagnostics.map((d) => [d.code, d.message, d.help ?? '']);
const max = '9_223_372_036_854_775_807';

describe('overflow traps', () => {
  test('a sum that overflows panics, naming the line', () => {
    const r = cli('run', `module m\n\nfn grow(n: int) -> int {\n  return n + 1\n}\n\nfn main() uses io {\n  io.println(grow(5).toString())\n  io.println(grow(${max}).toString())\n}\n`, 'run');
    expect(r.stdout).toBe('6\n');
    expect(r.stderr).toContain('panic: integer overflow: 9223372036854775807 + 1 doesn\'t fit in an int');
    expect(r.stderr).toMatch(/run\.candor:4 in grow\n.*run\.candor:9 in main/);
    expect(r.status).not.toBe(0);
  }, 60_000);

  test('every operator that can overflow traps, in a test; `%` and wrapping methods don\'t', () => {
    const src = [
      'module m',
      '',
      'fn main() {}',
      '',
      `fn big() -> int {\n  return ${max}\n}`,
      '',
      'fn small() -> int {\n  return -big() - 1\n}',
      '',
      'test "add" {\n  assert big() + 1 == 0\n}',
      'test "sub" {\n  assert small() - 1 == 0\n}',
      'test "mul" {\n  assert 1_800_000_000_000 * big() == 0\n}',
      'test "neg" {\n  assert -small() == 0\n}',
      'test "div" {\n  assert small() / -1 == 0\n}',
      'test "plus-assign" {\n  let mut n = big()\n  n += 1\n}',
      'test "list item" {\n  let mut xs = [big()]\n  xs[0] *= 2\n}',
      'test "fine" {\n  assert small() % -1 == 0\n  assert big().wrappingAdd(1) == small()\n  assert small().wrappingSub(1) == big()\n  assert big().wrappingMul(2) == -2\n  assert -big() == small() + 1\n  let mut n = 1\n  n *= 3\n  assert n == 3\n}',
      '',
    ].join('\n');
    expect(diags(src)).toEqual([]);
    const r = cli('ops', src, 'test', '--json');
    const report = jsonLines(r.stdout);
    const outcomes = Object.fromEntries(report.tests.map((t: { name: string; status: string; failure?: { message: string } }) => [t.name, t.failure?.message ?? t.status]));
    expect(outcomes).toEqual({
      add: 'integer overflow: 9223372036854775807 + 1 doesn\'t fit in an int',
      sub: 'integer overflow: -9223372036854775808 - 1 doesn\'t fit in an int',
      mul: 'integer overflow: 1800000000000 * 9223372036854775807 doesn\'t fit in an int',
      neg: 'integer overflow: -(-9223372036854775808) doesn\'t fit in an int',
      div: 'integer overflow: -9223372036854775808 / -1 doesn\'t fit in an int',
      'plus-assign': 'integer overflow: 9223372036854775807 + 1 doesn\'t fit in an int',
      'list item': 'integer overflow: 9223372036854775807 * 2 doesn\'t fit in an int',
      fine: 'pass',
    });
  }, 60_000);

  test('the most negative int is still a literal', () => {
    expect(compileSplit('module m\nfn main() {\n  let n = -9_223_372_036_854_775_808\n}\n', 't').go).toContain('-(9223372036854775808)');
  });
});

describe('ordered tuples and sortedBy', () => {
  test('tuples compare item by item, and sort', () => {
    const src = [
      'module m',
      '',
      'fn main() {}',
      '',
      'struct Due {\n  at: int\n  id: int\n}',
      '',
      'fn largest<T: Ord>(xs: List<T>) -> T? {\n  return xs.sorted().last()\n}',
      '',
      'test "tuples" {\n  assert (1, "b") < (1, "c")\n  assert (2, "a") > (1, "z")\n  assert (1, 1) <= (1, 1)\n  assert [(2, "a"), (1, "b"), (1, "a")].sorted() == [(1, "a"), (1, "b"), (2, "a")]\n  assert largest([(1, (2, 3)), (1, (3, 0))]) == (1, (3, 0))\n}',
      '',
      'test "sortedBy" {\n  let ds = [Due { at: 5, id: 2 }, Due { at: 1, id: 9 }, Due { at: 5, id: 1 }]\n  assert ds.sortedBy((d) => (d.at, d.id)).map((d) => d.id) == [9, 1, 2]\n  assert ds.sortedBy((d) => d.at).map((d) => d.id) == [9, 2, 1]\n  let empty: List<Due> = []\n  assert empty.sortedBy((d) => d.at) == []\n}',
      '',
    ].join('\n');
    expect(diags(src)).toEqual([]);
    const r = cli('tuples', src, 'test');
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('2 passed, 0 failed');
  }, 60_000);

  test('a tuple with an unordered item is not ordered, and says which', () => {
    expect(diags('module m\nfn main() {\n  let b = (1, true) < (2, false)\n}\n')[0][2]).toContain('(int, bool) is ordered item by item, and bool has no `impl Ord`');
    expect(diags('module m\nfn main() {\n  let xs = [(1, [2])].sorted()\n}\n')[0][1]).toContain('is ordered item by item, and List<int> has no `impl Ord`');
  });

  test('sortedBy wants an ordered key', () => {
    const [code, message, help] = diags('module m\nstruct P {\n  x: int\n}\nfn main() {\n  let ps = [P { x: 1 }].sortedBy((p) => p)\n}\n')[0];
    expect([code, message]).toEqual(['CAN0019', '`sortedBy` orders items by the key the function gives, with `<`, but P has no `impl Ord`']);
    expect(help).not.toBe('');
    expect(diags('module m\nfn main() uses io {\n  let xs = [1].sortedBy((x) => io.println("a"))\n}\n')[0][1]).toContain('it returns nothing');
  });
});

/** `candor test --json`'s lines: a line per test as it ends, then the totals. */
function jsonLines(stdout: string) {
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  return { tests: lines.filter((l) => l.type === 'test'), summary: lines.at(-1) };
}
