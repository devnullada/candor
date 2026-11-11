import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `.Variant` and `.Variant { ... }` in an expression, wherever an enum is expected.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'variant-expr', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const geo = `module geo
pub struct Point {
  pub x: int
  pub y: int
}
pub enum Shape {
  Dot
  Circle { center: Point, radius: int }
}
`;

const prelude = `module m

import "geo"

enum Fail {
  NotFound
  Forbidden
  Limited { retryAfter: int }
}
`;

const diags = (body: string) =>
  compile(`${prelude}\nfn main() {\n${body}\n}\n`, 'm.candor', 'main', { read: (f) => ({ 'geo.candor': geo })[f] ?? null }).diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);

test('every place that expects an enum takes the short form', () => {
  const r = run(
    'all',
    `module m

enum Fail {
  NotFound
  Forbidden
  Limited { retryAfter: int }
}

enum Tree<T> {
  Leaf
  Node { value: T }
}

struct Reply {
  status: Fail
  next: Fail?
}

fn check(n: int) -> Result<int, Fail> {
  if n < 0 { return Err(.Forbidden) }
  if n > 100 { return Err(.Limited { retryAfter: n }) }
  return Ok(n)
}

fn name(f: Fail) -> string {
  return match f {
    .NotFound => "not found",
    .Forbidden => "forbidden",
    .Limited { retryAfter } => "limited \${retryAfter}",
  }
}

fn pick(b: bool) -> Fail {
  if b { return .NotFound }
  return .Forbidden
}

fn orNot(f: Fail?) -> Fail {
  return f ?? .NotFound
}

fn same<T: Eq>(a: T, b: T) -> bool {
  return a == b
}

fn main() uses io {
  let a: Fail = .NotFound
  let mut b: Fail? = none
  b = .Forbidden
  let r = Reply { status: .Limited { retryAfter: 3 }, next: .NotFound }
  let xs: List<Fail> = [.NotFound, .Forbidden]
  let t: Tree<int> = .Node { value: 7 }
  let leaf: Tree<string> = .Leaf
  io.println(name(.Forbidden))
  io.println("\${a == .NotFound} \${.Forbidden == a} \${b != .NotFound} \${same(a, .NotFound)}")
  io.println(name(r.status))
  io.println("\${xs.length()} \${xs.contains(.Forbidden)}")
  io.println(match check(200) {
    Ok(n) => "\${n}",
    Err(e) => name(e),
  })
  io.println(name(orNot(none)) + " " + name(pick(false)))
  io.println(match t {
    .Leaf => "leaf",
    .Node { value } => "node \${value}",
  })
  io.println("\${leaf == .Leaf}")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('forbidden\ntrue false true true\nlimited 3\n2 true\nlimited 200\nnot found forbidden\nnode 7\ntrue\n');
});

test('an imported enum, short and long', () => {
  expect(diags('  let s: geo.Shape = .Dot\n  let c: geo.Shape = .Circle { center: geo.Point { x: 1, y: 2 }, radius: 3 }\n  let same = s == geo.Shape.Dot && c != .Dot')).toEqual([]);
});

test('nothing expects an enum: the help writes it the long way', () => {
  expect(diags('  let f = .Forbidden')).toEqual([
    ['CAN0032', 'cannot tell which enum `.Forbidden` is a variant of: nothing here expects an enum', 'write it the long way: `Fail.Forbidden`'],
  ]);
  expect(diags('  let s = .Circle { center: geo.Point { x: 1, y: 2 }, radius: 3 }')[0][2]).toBe('write it the long way: `geo.Shape.Circle { ... }`');
  expect(diags('  let s = .Nope')[0][2]).toBe("write the enum's name too: `Type.Nope`");
});

test('a wrong variant, an expected type that is not an enum, a lowercase name', () => {
  expect(diags('  let f: Fail = .Gone')).toEqual([['CAN0008', 'enum `Fail` has no variant `Gone`', 'its variants are `NotFound`, `Forbidden` and `Limited`']]);
  expect(diags('  let n: int = .Forbidden')).toEqual([
    ['CAN0005', '`.Forbidden` names a variant of the enum expected here, but int is expected', 'write it the long way: `Fail.Forbidden`'],
  ]);
  expect(diags('  let f: Fail = .Limited')[0][1]).toBe('`Fail.Limited` is missing field `retryAfter`');
  expect(diags('  let f: Fail = .Limited { retryAfter: "soon" }')[0][1]).toBe('expected int, found string');
  // On the next line it continues the call above.
  expect(diags('  let xs = [1]\n  let n = xs\n  .length()')).toEqual([]);
  expect(diags('  let n = .length()')[0].slice(1)).toEqual([
    '`.length` cannot start an expression',
    'a method call goes after its object, on the same line or at the start of the next',
  ]);
});

test('`x ?? .V` on a value that is never none reports the `??` alone', () => {
  expect(diags('  let f = Fail.NotFound\n  let g = f ?? .Forbidden').map((d) => d[0])).toEqual(['CAN0019']);
});
