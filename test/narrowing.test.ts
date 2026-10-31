import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { type Code, Codes } from '../src/diagnostics';

const types = 'struct User {\n  name: string\n  boss: User?\n  items: List<int>?\n}\n';
/** `body` inside `fn f(x: int?, u: User) -> int`, plus a `main` to make a program. */
const fnWith = (body: string, extra = '') =>
  `module m\n${types}${extra}fn f(x: int?, u: User) -> int {\n${body}\n}\nfn main() uses io {\n  io.println(f(1, User { name: "a", boss: none, items: none }).toString())\n}\n`;
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const ok = (body: string) => expect(compile(fnWith(body), 't').diagnostics).toEqual([]);
const fails = (body: string, ...expected: Code[]) => expect(codes(fnWith(body))).toEqual(expected);

describe('narrowing optionals', () => {
  test('a test narrows inside the branch, and the value is read out in Go', () => {
    const r = compile(fnWith('  if x != none {\n    return x + 1\n  }\n  return 0'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('return candor.Add(x.value, 1)');
    ok('  if x == none {\n    return 0\n  } else {\n    return x\n  }');
    ok('  if !(x == none) {\n    return x\n  }\n  return 0');
    ok('  if x == 5 {\n    return x\n  }\n  return 0');
    ok('  if x != 5 {\n    return 0\n  } else {\n    return x\n  }');
    ok('  return if x != none { x } else { 0 }');
  });

  test('only inside: after the `if`, and in the other branch, it is a `T?` again', () => {
    fails('  if x != none {\n    let y = x + 1\n  }\n  return x + 1', Codes.UnusedVariable, Codes.InvalidOperands);
    fails('  if x != none {\n    return 0\n  } else {\n    return x + 1\n  }', Codes.InvalidOperands);
    fails('  if x == 5 {\n    return 0\n  }\n  return x + 1', Codes.InvalidOperands);
  });

  test('`&&` and `||` narrow their right side, and what they prove', () => {
    ok('  if x != none && x > 3 {\n    return x\n  }\n  return 0');
    ok('  if x == none || x < 3 {\n    return 0\n  }\n  return x');
    // Either side may be the present one, so nothing is proved.
    fails('  let y: int? = 2\n  if x != none || y != none {\n    return x\n  }\n  return 0', Codes.TypeMismatch);
  });

  test('a guard that returns, breaks or continues narrows what follows', () => {
    ok('  if x == none {\n    return 0\n  }\n  return x');
    ok('  if x == none {\n    return 0\n  } else if x > 9 {\n    return 9\n  }\n  return x');
    ok('  let mut n = 0\n  for i in [1, 2] {\n    let y: int? = if i > 1 { i } else { none }\n    if y == none {\n      continue\n    }\n    n += y\n  }\n  return n');
    ok('  let mut n = 0\n  while true {\n    let y: int? = if n > 1 { n } else { none }\n    if y != none {\n      n += 1\n    } else {\n      break\n    }\n    n += y\n  }\n  return n');
    ok('  match u.name {\n    "a" => {\n      if x == none {\n        return 1\n      }\n    }\n    _ => return 2\n  }\n  return x');
  });

  test('fields of a local narrow: paths, not calls or indexes', () => {
    ok('  if u.boss != none {\n    return u.boss.name.length()\n  }\n  return 0');
    ok('  if u.boss != none && u.boss.boss != none {\n    return u.boss.boss.name.length()\n  }\n  return 0');
    fails('  let xs = [x]\n  if xs[0] != none {\n    return xs[0]\n  }\n  return 0', Codes.TypeMismatch);
  });

  test('`let mut` narrows until it is assigned', () => {
    ok('  let mut y: int? = none\n  y = 4\n  return y');
    ok('  let mut y = x\n  if y == none {\n    y = 1\n  }\n  return y');
    ok('  let mut y = x\n  if y != none {\n    y += 1\n    return y\n  }\n  return 0');
    fails('  let mut y = x\n  if y != none {\n    y = none\n    return y + 1\n  }\n  return 0', Codes.InvalidOperands);
    fails('  let mut y = x\n  if y != none {\n    y = x\n    return y\n  }\n  return 0', Codes.TypeMismatch);
    // A narrowed `y` still takes a `none` when replaced whole.
    ok('  let mut y = x\n  if y != none {\n    let z = y + 1\n    y = none\n    return z\n  }\n  return 0');
  });

  test('a loop forgets what its body assigns, from the first step', () => {
    fails('  let mut y = x\n  if y != none {\n    for i in [1, 2] {\n      let z = y + i\n      y = none\n    }\n  }\n  return 0', Codes.InvalidOperands);
    // Without a `break`, a `while` ends with its condition false.
    ok('  let mut y = x\n  while y == none {\n    y = 3\n  }\n  return y');
    fails('  let mut y = x\n  while y == none {\n    if u.name == "a" {\n      break\n    }\n    y = 3\n  }\n  return y', Codes.TypeMismatch);
    ok('  let mut y = x\n  let mut n = 0\n  while y != none && y > 0 {\n    y = y - 1\n    n += 1\n  }\n  return n');
  });

  test('a lambda keeps what it learns to itself', () => {
    fails('  let g = () => {\n    if x == none {\n      return 0\n    }\n    return x\n  }\n  return g() + x', Codes.InvalidOperands);
    // What is known outside holds inside: the value can't change.
    ok('  if x != none {\n    let g = () => x + 1\n    return g()\n  }\n  return 0');
  });

  test('lists and maps behind a narrowed optional are not changed in place', () => {
    const src = fnWith('  let mut v = u\n  if v.items != none {\n    v.items.push(1)\n  }\n  return 0');
    expect(diags(src)).toEqual([[Codes.NotMutable, 'copy it out, change it, and assign it back: `let mut copy = v.items ?? ...`, then `v.items = copy`']]);
    fails('  let mut ys: List<int>? = [1]\n  if ys != none {\n    ys[0] = 2\n  }\n  return 0', Codes.NotMutable);
  });

  test('`??` on a narrowed value says why it is not optional', () => {
    expect(diags(fnWith('  if x != none {\n    return x ?? 0\n  }\n  return 0'))).toEqual([
      [Codes.InvalidOperands, 'a test above proved it present, so here it is a int; remove `?? ...`'],
    ]);
  });

  test('a name declared again later knows nothing from before', () => {
    fails('  if u.name == "a" {\n    let y: int? = 1\n    if y == none {\n      return 0\n    }\n  }\n  let y: int? = x\n  return y', Codes.TypeMismatch);
  });
});
