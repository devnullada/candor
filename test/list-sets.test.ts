import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// #c9d1ab04: `xs.unique()`, `xs.union(ys)`, `xs.intersect(ys)` on lists, order kept, by `==`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

const app = `module app

struct P {
  x: int
  tags: List<string>
}

fn uniq<T: Eq>(xs: List<T>) -> List<T> {
  return xs.unique()
}
`;

const tests = `module app

test "Go-comparable items go by a map" {
  assert [3, 1, 3, 2, 1].unique() == [3, 1, 2]
  assert ["b", "a"].union(["a", "c", "c"]) == ["b", "a", "c"]
  assert [5, 1, 3, 1].intersect([1, 5, 9]) == [5, 1]
  let empty: List<int> = []
  assert empty.unique() == [] && empty.union([1, 1]) == [1] && [1].intersect(empty) == []
  assert [(1, "a"), (1, "a"), (2, "b")].unique() == [(1, "a"), (2, "b")]
}

test "other items go by their own ==" {
  let a = P { x: 1, tags: ["t"] }
  let b = P { x: 1, tags: ["u"] }
  assert [a, b, P { x: 1, tags: ["t"] }].unique() == [a, b]
  assert [[1], [2], [1]].union([[3], [2]]) == [[1], [2], [3]]
  assert [a, b].intersect([P { x: 1, tags: ["u"] }]) == [b]
  assert ["x".toBytes(), "x".toBytes(), "y".toBytes()].unique().length() == 2
}

test "a type parameter's Eq" {
  assert uniq([2, 2, 1]) == [2, 1]
  assert uniq([[1], [1]]) == [[1]]
}

test "the receiver is not changed" {
  let xs = [1, 1]
  let ys = xs.unique()
  assert xs == [1, 1] && ys == [1]
}
`;

test('unique, union and intersect keep order and go by ==', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'list-sets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.candor'), app);
  writeFileSync(path.join(dir, 'app_test.candor'), tests);
  const r = spawnSync(process.execPath, ['run', cli, 'test', path.join(dir, 'app.candor'), '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stdout + r.stderr).toContain('4 passed, 0 failed');
}, 120_000);

test('items without == are refused', () => {
  const errs = compile('module m\n\nfn main() {\n  let fs = [() => 1]\n  let u = fs.unique()\n  let v = fs.union(fs)\n}\n', 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);
  expect(errs.length).toBe(2);
  expect(errs[0]).toStartWith('`unique` compares items with `==`, but');
  expect(errs[1]).toStartWith('`union` compares items with `==`, but');
});
