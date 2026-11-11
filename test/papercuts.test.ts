import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

// What the todo service tripped over.

const root = path.join(import.meta.dir, '..');
const errors = (src: string, mode: 'main' | 'test' = 'main') =>
  compile(src, 't.candor', mode)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

describe('a name given twice', () => {
  test('is reported once: what follows means the new binding', () => {
    const src = `module m
fn found(id: int) -> int {
  return id
}
fn f() -> int {
  let found = [1, 2]
  return found.length()
}
fn main() {}
`;
    expect(errors(src)).toEqual([[Codes.Duplicate, '`found` is already a function', 'Candor has no shadowing; pick another name']]);
  });

  test("a fake's state may share a name with the effect's externs", () => {
    const src = `module m
effect m {
  extern "strconv" {
    fn Itoa(i: int) -> string as lastId
  }
  pub fn next() -> string {
    return lastId(1)
  }
}
fake m {
  let mut lastId = 0
  fn next() -> string {
    lastId = lastId + 1
    return lastId.toString()
  }
}
fn main() {}
`;
    expect(errors(src)).toEqual([]);
    expect(errors(src, 'test')).toEqual([]);
  });

  test('inside an operation, the extern is still taken', () => {
    const src = `module m
effect m {
  extern "strconv" {
    fn Itoa(i: int) -> string as itoa
  }
  pub fn next() -> string {
    let itoa = "1"
    return itoa
  }
}
fake m {
  fn next() -> string {
    return ""
  }
}
fn main() {}
`;
    expect(errors(src).map((e) => e[1])).toEqual(['`itoa` is already a function']);
  });
});

describe('`while true`', () => {
  const find = `fn find(xs: List<int>, n: int) -> int {
  let mut i = 0
  while true {
    if (xs[i] ?? n) == n {
      return i
    }
    i = i + 1
  }
}`;

  test('without a `break`, ends a function', () => {
    const r = compile(`module m\n${find}\nfn main() {}\n`, 't.candor');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('\tfor {\n');
  });

  test('with one, does not', () => {
    const src = `module m\nfn f(n: int) -> int {\n  while true {\n    if n > 0 {\n      break\n    }\n  }\n}\nfn main() {}\n`;
    expect(errors(src).map((e) => e[0])).toEqual([Codes.MissingReturn]);
  });

  test('a `break` in a nested loop is that loop\'s', () => {
    const src = `module m\nfn f(xs: List<int>) -> int {\n  while true {\n    for x in xs {\n      break\n    }\n  }\n}\nfn main() {}\n`;
    expect(errors(src)).toEqual([]);
  });
});

test('`candor check` takes a module without `main`; `candor run` still wants one', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });
  const checked = cli('check', 'std/json.candor');
  expect(checked.stderr).toBe('');
  expect(checked.status).toBe(0);
  expect(errors('module m\nfn f() {}\n').map((e) => e[0])).toEqual([Codes.NoMain]);
});

test('`??` on a Result says how to drop the error in plain sight', () => {
  const src = `module m\nfn f() -> Result<int, string> {\n  return Ok(1)\n}\nfn main() {\n  let r = f()\n  let n = r ?? 0\n}\n`;
  expect(errors(src)).toEqual([
    [
      Codes.InvalidOperands,
      '`??` needs an optional on its left, found Result<int, string>',
      "a Result's error would be dropped unread: `r.ok() ?? ...` drops it in plain sight, or `?` passes it on",
    ],
  ]);
});

test('`a ?? b > c` says `??` binds looser (trial 040)', () => {
  const src = (body: string) => `module m\nfn f(xs: List<int>) -> bool {\n  return ${body}\n}\nfn main() {}\n`;
  expect(errors(src('xs.first() ?? 0 > 0'))).toEqual([
    [Codes.TypeMismatch, 'expected int, found bool', '`??` binds looser than `>`, so this reads `a ?? (b > c)`; for `>` on the result, write `(a ?? b) > c`'],
  ]);
  expect(errors(src('(xs.first() ?? 0) > 0'))).toEqual([]);
});
