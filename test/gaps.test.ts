import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Or-patterns, `T?.map`, `Result.map`, `List.slice`, `(_) =>`. The methods' examples
// run in test/reference.test.ts.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'gaps', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const prelude = `module m

enum Shape {
  Dot
  Circle { r: int }
  Square { side: int }
  Line { length: int, label: string }
}
`;
const diags = (decls: string) =>
  compile(`${prelude}\n${decls}\n\nfn main() {}\n`, 'm.candor').diagnostics.map((d) => [d.severity, d.code, d.message, d.help]);

test('or-patterns, with and without names, and the rest', () => {
  const r = run(
    'all',
    `${prelude}
fn access(s: string) -> string {
  return match s {
    "rw" | "read-write" | "readwrite" => "both",
    "ro" | "read-only" => "read",
    _ => "none",
  }
}

fn size(s: Shape) -> int {
  return match s {
    .Dot => 0,
    .Circle { r: n } | .Square { side: n } => n,
    .Line { length, label: _ } => length,
  }
}

fn small(r: Result<int, string>) -> bool {
  return match r {
    Ok(0) | Ok(1) | Err(_) => true,
    Ok(_) => false,
  }
}

struct Attachment {
  size: int
  url: string?
}

fn main() uses io {
  io.println("\${access("read-write")} \${access("ro")} \${access("x")}")
  io.println("\${size(.Circle { r: 3 })} \${size(.Square { side: 4 })} \${size(.Dot)}")
  io.println("\${small(Ok(1))} \${small(Err("x"))} \${small(Ok(7))}")
  let a: Attachment? = Attachment { size: 9, url: none }
  let none_: Attachment? = none
  io.println("\${a.map((x) => x.size) ?? 0} \${none_.map((x) => x.size) ?? 0} \${a.map((x) => x.url) ?? "-"}")
  let r: Result<int, string> = Ok(2)
  io.println("\${r.map((n) => n + 1) == Ok(3)}")
  let xs = [1, 2, 3, 4, 5]
  io.println("\${xs.slice(1, 3) == [2, 3]} \${xs.slice(3, 99) == [4, 5]} \${xs.slice(4, 2).isEmpty()}")
  let zeros = xs.map((_) => 0)
  io.println("\${zeros == [0, 0, 0, 0, 0]} \${[(1, "a")].map((_) => true) == [true]}")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('both read none\n3 4 0\ntrue true false\n9 0 -\ntrue\ntrue true true\ntrue true\n');
});

test('every pattern of an arm binds the same names with the same types', () => {
  expect(diags('fn f(s: Shape) -> int {\n  return match s {\n    .Circle { r } | .Square { side } => 1,\n    _ => 0,\n  }\n}')).toContainEqual([
    'error',
    'CAN0061',
    'this pattern does not bind `r`, which the first one does',
    'every pattern of an arm binds the same names, so the arm can use them whichever matched; match the rest with `_`, or give it an arm of its own',
  ]);
  expect(diags('fn f(s: Shape) -> int {\n  return match s {\n    .Circle { r } | .Line { length: r, label } => r,\n    _ => 0,\n  }\n}')[0][2]).toBe(
    'this pattern binds `label`, which the first one does not',
  );
  expect(diags('fn f(s: Shape) -> int {\n  return match s {\n    .Circle { r: x } | .Line { label: x } => 1,\n    _ => 0,\n  }\n}').find((d) => d[0] === 'error')!.slice(1, 3)).toEqual([
    'CAN0005',
    '`x` is string here, but int in the first pattern',
  ]);
});

test('coverage counts each pattern; one already covered is a warning', () => {
  expect(diags('fn f(s: Shape) -> int {\n  return match s {\n    .Dot | .Circle { r: _ } => 1,\n    .Square { side: _ } => 2,\n  }\n}')[0].slice(1, 3)).toEqual([
    'CAN0027',
    'this `match` does not cover `Shape.Line`',
  ]);
  expect(diags('fn f(s: Shape) -> int {\n  return match s {\n    .Dot => 0,\n    .Circle { r: _ } | .Dot => 1,\n    _ => 2,\n  }\n}')[0].slice(0, 3)).toEqual([
    'warning',
    'CAN0028',
    'this pattern can never match: the patterns before it cover it',
  ]);
});

test('a name bound by an or-pattern and never used is one warning', () => {
  const d = diags('fn f(s: Shape) -> int {\n  return match s {\n    .Circle { r: n } | .Square { side: n } => 1,\n    _ => 0,\n  }\n}');
  expect(d.map((x) => x[2])).toEqual(['`n` is never used']);
});

test('map on a Result without a value, functions that give nothing, `_` read as a value', () => {
  expect(diags('fn f(r: Result<void, string>) -> int {\n  let x = r.map((v) => 1)\n  return 0\n}').find((x) => x[0] === 'error')!.slice(2)).toEqual([
    'Result<void, string> holds no value to map',
    'use `?` and go on, or `match` it',
  ]);
  expect(diags('fn f(x: int?) -> int {\n  x.map((v) => {})\n  return 0\n}').find((x) => x[0] === 'error')![2]).toBe('the function given to `map` returns nothing');
  expect(diags('fn f(xs: List<int>) -> List<int> {\n  return xs.map((_) => _)\n}').find((x) => x[0] === 'error')![2]).toBe('`_` ignores a value, so it cannot be read');
});
