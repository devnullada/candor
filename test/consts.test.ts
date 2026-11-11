import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { plain } from './plain';

// `const name = value` at module level: compile-time scalars, lowered to Go consts.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const geo = `module geo

pub const earthKm = 6371
pub const label = "km"
const hidden = 1
`;

const program = (src: string) => compile(src, 'm.candor', 'main', { read: (f) => ({ 'geo.candor': geo })[f] ?? null });
const errors = (decls: string, body = '') =>
  program(`module m\n\nimport "geo"\n\n${decls}\n\nfn main() {\n${body}\n}\n`)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

test('consts fold, in any order and across modules, and run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'consts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'geo.candor'), geo);
  const file = path.join(dir, 'm.candor');
  writeFileSync(
    file,
    `module m

import "geo"

const total = backlog * 2 + 1
const backlog = 20
pub const alphabet = "0123456789abcdef"
const half: float = 0.5
const big = geo.earthKm * 1_000
const unit = " " + geo.label
const sep = 'é'
const on = backlog > 10 && !false
const neg = -backlog % 7

fn main() uses io {
  io.println("\${total} \${alphabet.length()} \${half * 3.0} \${big}\${unit} \${sep} \${on} \${neg}")
  let xs = [1, 2, 3]
  io.println("\${xs.length() < backlog}")
}
`,
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('41 16 1.5 6371000 km é true -6\ntrue\n');
});

test('lowered to typed Go consts with the folded value', () => {
  const r = program('module m\n\nconst backlog = 20\nconst total = backlog * 2 + 1\nconst name = "a" + "b"\nconst c = \'é\'\n\nfn main() uses io {\n  io.println("${total}")\n}\n');
  expect(r.diagnostics).toEqual([]);
  const out = plain(r.go);
  expect(out).toContain('const m__backlog int64 = 20\n');
  expect(out).toContain('const m__total int64 = 41\n');
  expect(out).toContain('const m__name string = "ab"\n');
  expect(out).toContain('const m__c rune = rune(233)\n');
});

test('a value not known while compiling, a cycle, a type that is not a scalar', () => {
  const runtime = (v: string) => errors(`fn f() -> int {\n  return 1\n}\nconst x = ${v}`);
  const help = 'a const holds literals, other consts, operators on them, lists, maps and records of these, and function names; for anything else, write a function: `fn name() -> T { ... }`';
  expect(runtime('f()')).toEqual([['CAN0059', "a const's value is worked out while compiling, and a call is not known until the program runs", help]]);
  expect(runtime('[f()]')[0][1]).toBe("a const's value is worked out while compiling, and a call is not known until the program runs");
  expect(runtime('"${1}"')[0][1]).toBe("a const's value is worked out while compiling, and an interpolated string is not known until the program runs");
  expect(runtime('1 + f')[0][1]).toBe('an operator in a const works on ints, floats, strings, bools and chars, and the function `f` is not one');
  expect(runtime('x.length()')[0][1]).toBe("a const's value is worked out while compiling, and a call is not known until the program runs");
  expect(errors('const a = b + 1\nconst b = c\nconst c = a * 2')).toEqual([
    ['CAN0060', '`a` is worked out from itself: its value names it, here or through other consts', 'give one of these consts a value that does not depend on the others'],
  ]);
  expect(errors('const xs: List<int> = 1')[0][1]).toBe('expected List<int>, found int');
  expect(errors('const s: string = 1')[0][1]).toBe('expected string, found int');
});

// Lists, maps, tuples and records of constants, and function names, as Go variables.
test('lists, maps, records and function names, across modules, and run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'consts-var');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'names.candor'),
    `module names

pub enum Kind {
  Weekday
  Weekend
}

pub struct Day {
  pub name: string
  pub kind: Kind
}

pub const months = ["jan", "feb", "mar"]
pub const monthOf = ["jan": 1, "feb": 2, "mar": 3]
pub const days = [Day { name: "sat", kind: .Weekend }, Day { name: "mon", kind: Kind.Weekday }]
pub const first = days

pub fn less(a: int, b: int) -> bool {
  return a < b
}

// A function a const names may read that const: Go sets it in \`init\`.
fn more(a: int, b: int) -> bool {
  return orders.length() == 2 && a > b
}

pub const orders = [less, more]
pub const order = less
`,
  );
  const file = path.join(dir, 'm.candor');
  writeFileSync(
    file,
    `module m

import "names"

const pair = (backlog, names.months)
const backlog = 2
const none_: int? = none
const empty: List<string> = []

fn main() uses io {
  let mut ms = names.months
  ms.push("apr")
  io.println("\${ms} \${names.months} \${names.monthOf["feb"]} \${pair.0} \${pair.1.length()} \${none_} \${empty}")
  io.println("\${names.first.map((d) => d.name)} \${names.days.map((d) => d.kind == .Weekend)}")
  let more = names.orders[1] ?? names.order
  io.println("\${names.order(1, 2)} \${more(3, 1)}")
}
`,
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('["jan", "feb", "mar", "apr"] ["jan", "feb", "mar"] 2 2 3 none []\n["sat", "mon"] [true, false]\ntrue true\n');
}, 60_000);

test('a list const is a Go variable set in init, and is not changed in place', () => {
  const r = program('module m\n\nconst xs = [1, 2]\nconst ys = xs\n\nfn main() uses io {\n  io.println("${ys}")\n}\n');
  expect(r.diagnostics).toEqual([]);
  const out = plain(r.go);
  expect(out).toContain('var m__xs []int64\n');
  expect(out).toContain('func init() {\n\tm__xs = []int64{1, 2}\n\tm__ys = m__xs\n}');
  expect(errors('const xs = [1]', '  xs.push(2)')[0].slice(0, 2)).toEqual(['CAN0036', 'can only push to a `let mut` variable or its fields']);
});

test('a lambda, a function with effects, a generic one, an operator on a list', () => {
  const fns = 'fn show(s: string) uses io {\n  io.println(s)\n}\nfn first<T>(xs: List<T>) -> T? {\n  return xs[0]\n}\n';
  expect(errors(`${fns}const f = (x: int) => x + 1`)).toEqual([
    [
      'CAN0059',
      "a const's value is worked out while compiling, and a lambda is not known until the program runs",
      'a const can name a function but not hold a lambda: write it as `fn name(...) { ... }` and give the const its name',
    ],
  ]);
  expect(errors(`${fns}const f = [show]`)).toEqual([
    ['CAN0059', "a const can't name `show`: it uses `io`", 'a const names only functions without effects; take the function as a parameter where it is needed instead'],
  ]);
  expect(errors(`${fns}const f = first`)[0][1]).toBe("a const can't name `first`: it is generic");
  expect(errors('const a = [1]\nconst b = a + a')[0][1]).toBe('an operator in a const works on ints, floats, strings, bools and chars, and `a` is not one');
});

test('overflow, division by zero, privacy, names', () => {
  expect(errors('const max = 9223372036854775807\nconst over = max + 1')[0][1]).toBe('this constant expression overflows int (64-bit): it is 9223372036854775808');
  expect(errors('const zero = 0', '  let n = 10\n  let q = n / zero')[0][1]).toBe('division by zero: this divisor of `/` is always 0');
  expect(errors('const k = geo.hidden')[0].slice(0, 2)).toEqual(['CAN0054', '`hidden` is private to module `geo`']);
  expect(errors('const limit = 1\nfn limit() -> int {\n  return 2\n}')[0][1]).toBe('`limit` is already defined');
  expect(errors('const limit = 1', '  let limit = 2')[0][1]).toBe('`limit` is already a const');
  expect(errors('', '  const x = 1')[0].slice(1)).toEqual(['`const` goes at module level, outside functions', 'inside a function, write `let`']);
});
