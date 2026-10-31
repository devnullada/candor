import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);

describe('lambdas and effects', () => {
  test('a lambda that uses io cannot go where none is allowed', () => {
    const extra = 'fn pure(f: fn() -> int) -> int {\n  return f()\n}\n';
    expect(diags(mod('  let n = pure(() => {\n    io.println("x")\n    return 1\n  })\n  io.println(n.toString())', extra))).toEqual([
      ['CAN0005', 'allow it in the type: `f: fn() -> int uses io`, or put `uses f` on `pure`: it then takes on what each function passed does, and only its callers declare that'],
    ]);
  });

  test('calling a function value performs its effects', () => {
    const src = 'module m\nfn run(f: fn() uses io) {\n  f()\n}\nfn main() {}\n';
    expect(diags(src)).toEqual([['CAN0004', 'add `uses io` to the signature of `fn run`']]);
  });

  test('a lambda gets its parameter types from the context', () => {
    expect(codes(mod('  let xs = [1, 2].map((x) => x + 1)\n  io.println(xs.length().toString())'))).toEqual([]);
    expect(codes(mod('  let f = (x) => x\n  io.println("x")'))).toContain('CAN0032');
  });

  test('a named function with effects passed as a value', () => {
    const extra = 'fn show(n: int) uses io {\n  io.println(n.toString())\n}\nfn each(xs: List<int>, f: fn(int) uses io) uses io {\n  for x in xs {\n    f(x)\n  }\n}\n';
    const r = compile(mod('  each([1, 2], show)', extra), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('func(ctx__ *candor.Ctx, a__0 int64) struct{} { return m__show(ctx__, io, a__0) }');
  });

  test('lambdas cannot capture let mut', () => {
    expect(codes(mod('  let mut n = 0\n  n += 1\n  let f = () => n\n  io.println(f().toString())'))).toEqual(['CAN0037']);
  });

  test('x => without parentheses', () => {
    expect(diags(mod('  let xs = [1].map(x => x)'))).toEqual([['CAN0001', 'write `(x) => ...`']]);
  });

  test('? in a lambda: `return Ok(x)` completes the Result type the `?` started', () => {
    const extra = 'fn p(s: string) -> Result<int, string> {\n  return Ok(1)\n}\n';
    const body = (head: string) => mod(`  let rs = ["1"].map(${head} => {\n    return Ok(p(x)? + 1)\n  })\n  io.println(rs.length().toString())`, extra);
    expect(codes(body('(x)'))).toEqual([]);
    expect(codes(body('(x): Result<int, string>'))).toEqual([]);
    expect(diags(mod('  let rs = ["1"].map((x) => p(x)? + 1)\n  io.println(rs.length().toString())', extra))).toEqual([
      ['CAN0033', 'annotate it: `(...): Result<int, string> => ...`'],
    ]);
  });

  test('a block body needs return', () => {
    expect(codes(mod('  let xs = [1].map((x) => {\n    x + 1\n  })\n  io.println("x")'))).toContain('CAN0012');
  });
});

describe('lists', () => {
  test('empty lists need a type', () => {
    expect(codes(mod('  let xs = []\n  io.println("x")'))).toEqual(['CAN0032']);
    expect(codes(mod('  let xs: List<int> = []\n  io.println(xs.length().toString())'))).toEqual([]);
  });

  test('T[] and Array<T>', () => {
    expect(diags('module m\nfn f(xs: int[]) {}\nfn main() {}\n')).toEqual([['CAN0001', 'write `List<int>`']]);
    expect(codes('module m\nfn f(xs: Array<int>) {}\nfn main() {}\n')).toEqual(['CAN0015']);
  });

  test('`+` on lists points to concat (card 048)', () => {
    expect(diags(mod('  let xs = [1]\n  let ys = [2]\n  io.println((xs + ys).length().toString())'))).toEqual([['CAN0019', 'there is no `+` on lists; join them with `xs.concat(ys)`']]);
    expect(diags(mod('  io.println(([1] + [2]).length().toString())'))[0][1]).toContain('`a.concat(b)`');
  });

  test('indexing gives an optional', () => {
    expect(codes(mod('  let xs = [1]\n  let x: int = xs[0]\n  io.println(x.toString())'))).toEqual(['CAN0005']);
    expect(codes(mod('  let xs = [1]\n  io.println((xs[0] ?? 0).toString())'))).toEqual([]);
  });

  test('methods must be called; no forEach', () => {
    expect(diags(mod('  let n = [1].length\n  io.println("x")'))[0]).toEqual(['CAN0020', 'write `.length()`']);
    expect(diags(mod('  [1].forEach((x) => io.println(x.toString()))'))).toEqual([['CAN0008', 'loop instead: `for x in xs { ... }`']]);
  });

  test('join needs strings', () => {
    expect(codes(mod('  io.println([1].join(","))'))).toEqual(['CAN0005']);
  });
});

describe('mutation', () => {
  test('only let mut changes', () => {
    expect(diags(mod('  let n = 0\n  n = 1\n  io.println(n.toString())'))).toEqual([['CAN0036', 'declare it with `let mut n`']]);
    expect(diags(mod('  let xs = [1]\n  xs.push(2)\n  io.println("x")'))).toEqual([['CAN0036', 'declare it with `let mut xs`']]);
  });

  test('parameters are not mutable', () => {
    expect(codes('module m\nfn f(xs: List<int>) {\n  xs.push(1)\n}\nfn main() {}\n')).toEqual(['CAN0036']);
  });

  test('let mut that never changes', () => {
    expect(diags(mod('  let mut n = 1\n  io.println(n.toString())'))).toEqual([['CAN0039', 'declare it with `let`, without `mut`']]);
  });

  test('fields of a let mut struct', () => {
    const extra = 'struct P {\n  x: int\n}\n';
    expect(codes(mod('  let mut p = P { x: 1 }\n  p.x += 2\n  io.println(p.x.toString())', extra))).toEqual([]);
  });

  test('no ++, const or var', () => {
    expect(diags(mod('  let mut i = 0\n  i++'))).toEqual([['CAN0001', 'write `+= 1`']]);
    expect(diags(mod('  const x = 1'))).toEqual([['CAN0001', 'inside a function, write `let`']]);
  });

  test('xs[i] = v on a let mut; the item is a T, not a T?', () => {
    expect(codes(mod('  let mut xs = [1]\n  xs[0] = 2\n  xs[0] += 3\n  io.println(xs.length().toString())'))).toEqual([]);
    expect(diags(mod('  let xs = [1]\n  xs[0] = 2\n  io.println("x")'))).toEqual([['CAN0036', 'declare it with `let mut xs`']]);
    expect(codes(mod('  let mut xs = [1]\n  xs[0] = "a"\n  io.println("x")'))).toEqual(['CAN0005']);
    expect(codes(mod('  let mut xs = [1]\n  xs[0] = none\n  io.println("x")'))).toEqual(['CAN0005']);
    expect(codes(mod('  let mut xs = ["a"]\n  xs[0] *= 2\n  io.println("x")'))).toEqual(['CAN0019']);
    expect(codes('module m\nfn f(xs: List<int>) {\n  xs[0] = 1\n}\nfn main() {}\n')).toEqual(['CAN0036']);
  });

  test('xs[i][j] = v points at copying the row out', () => {
    expect(diags(mod('  let mut xs = [[1]]\n  xs[0][0] = 2\n  io.println("x")'))).toContainEqual([
      'CAN0036',
      'copy the row out, change it, and put it back: `let mut row = xs[i] ?? []`, `row[j] = v`, `xs[i] = row`',
    ]);
  });

  test('a let mut list written by index owns its items until it is handed on', () => {
    const extra = 'struct Bag {\n  items: List<int>\n}\nfn sum(xs: List<int>) -> int {\n  return 0\n}\n';
    const r = compile(mod('  let mut xs = [1, 2]\n  xs[0] = 2\n  let n = sum(xs)\n  xs[1] += xs.length() + (xs[0] ?? 0)\n  let mut b = Bag { items: xs }\n  b.items[0] = 1\n  io.println((n + b.items.length()).toString())', extra), 't');
    expect(r.diagnostics).toEqual([]);
    const go = r.go!.split('\n').filter((l) => /__own|set__|setCopy__|get__/.test(l) && !l.startsWith('func '));
    expect(go.map((l) => l.trim())).toEqual([
      'var xs__own = true',
      '_ = xs__own',
      'set__(&xs, &xs__own, 0, 2)',
      // Passed to `sum`: shared from here, so the next write copies first.
      'xs__own = false',
      // Indexed and asked its length: still its own.
      'set__(&xs, &xs__own, t__1, candor.Add(get__(xs, t__1), candor.Add(t__4, t__3)))',
      'xs__own = false',
      'b.items = setCopy__(b.items, 0, 1)',
    ]);
  });
});

describe('loops', () => {
  test('break outside a loop', () => {
    expect(codes(mod('  break'))).toContain('CAN0038');
    expect(codes(mod('  for i in 0..3 {\n    let f = () => {\n      break\n    }\n  }'))).toContain('CAN0038');
  });

  test('for (const x of xs)', () => {
    expect(diags(mod('  for (const x of [1]) {\n  }'))[0][0]).toBe('CAN0001');
  });

  test('looping over an int', () => {
    expect(diags(mod('  for i in 5 {\n    io.println(i.toString())\n  }'))).toEqual([['CAN0040', 'to count, use a range: `for i in 0..n`']]);
  });

  test('unused loop variable', () => {
    expect(diags(mod('  for i in 0..3 {\n    io.println("x")\n  }'))).toEqual([['CAN0013', 'write `for _ in ...`']]);
    expect(codes(mod('  for _ in 0..3 {\n    io.println("x")\n  }'))).toEqual([]);
  });
});

describe('equality', () => {
  test('structs, lists and Results compare by value; functions do not', () => {
    const extra = 'struct P {\n  x: int\n  tags: List<string>\n}\n';
    const r = compile(mod('  let a = P { x: 1, tags: [] }\n  let ok: Result<int, string> = Ok(1)\n  io.println((a == a && ok == Ok(1)).toString())', extra), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('func eq__1(a, b m__P) bool {');
    expect(codes(mod('  let f = (x: int) => x\n  io.println((f == f).toString())'))).toEqual(['CAN0019']);
  });
});
