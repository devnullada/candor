import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';

const bare = (body: string, extra = '') => `module m\n${extra}fn main() {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const errors = (src: string) => compile(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);
const go = (src: string) => {
  const r = compile(src, 't');
  expect(r.diagnostics).toEqual([]);
  return r.go!;
};

const minMax = 'fn minMax(xs: List<int>) -> (int, int) {\n  return (1, 9)\n}\n';

describe('types, literals and `let`', () => {
  test('an anonymous Go struct, taken apart by `let`', () => {
    const out = go(bare('  let (lo, hi) = minMax([1])\n  if lo > hi {\n    return\n  }', minMax));
    expect(out).toContain('func m__minMax(ctx__ *candor.Ctx, xs []int64) struct{ V0 int64; V1 int64 } {');
    expect(out).toContain('return struct{ V0 int64; V1 int64 }{V0: 1, V1: 9}');
    expect(out).toContain('var lo int64 = t__1.V0');
  });

  test('the context types the parts', () => {
    expect(diags(bare('  let p: (int, string?) = (1, none)\n  let (n, s) = p\n  let t: int = n\n  let u: string = s ?? ""'))).toEqual([
      ['CAN0013', '`t` is never used'],
      ['CAN0013', '`u` is never used'],
    ]);
    expect(diags(bare('  let p = (1, none)'))).toEqual([['CAN0032', 'annotate it: `let p: (int, string?) = (1, none)`']]);
  });

  test('items by position, `.0`; no other members; no `let mut (a, b)`', () => {
    expect(errors(bare('  let p = (1, "a")\n  let a: int = p.0\n  let b: string = p.1', ''))).toEqual([]);
    expect(diags(bare('  let p = (1, 2)\n  let a = p.2'))[0]).toEqual(['CAN0008', 'its items are `.0`, `.1`, from 0; or take it apart: `let (a, b) = ...`']);
    expect(diags(bare('  let p = (1, 2)\n  let a = p.first'))[0]).toEqual(['CAN0008', 'its items are `.0`, `.1`, from 0; or take it apart: `let (a, b) = ...`']);
    expect(diags(bare('  let mut (a, b) = (1, 2)'))).toEqual([['CAN0001', 'destructure with `let (a, b) = ...`, then copy what changes: `let mut total = a`']]);
  });

  test('a `let` pattern must match every value', () => {
    expect(errors(bare('  let (0, b) = (1, 2)'))).toEqual([['CAN0027', 'this pattern does not match every (int, int): not `(_, _)`', 'a `let` cannot skip a value; use `match`']]);
    expect(errors(bare('  let (a, b, c) = (1, 2)'))).toEqual([['CAN0005', 'this pattern has 3 parts, but the value matched is (int, int)', undefined]]);
  });

  test('a name in a `let` takes a `T?` whole', () => {
    expect(errors(bare('  let p: (int, string?) = (1, none)\n  let (n, s) = p\n  let x: string? = s\n  let y = n + 1', ''))).toEqual([]);
  });
});

describe('patterns', () => {
  test('`match` on a tuple is checked for every case', () => {
    expect(errors('module m\nfn f(p: (int, bool)) -> string {\n  return match p {\n    (0, _) => "zero",\n    (_, true) => "flagged",\n  }\n}\nfn main() {}\n')).toEqual([
      ['CAN0027', 'this `match` does not cover `(_, false)`', 'add an arm for it, or a final `_ =>` arm'],
    ]);
    const out = go('module m\nfn f(p: (int, bool)) -> string {\n  return match p {\n    (0, _) => "zero",\n    (n, false) => n.toString(),\n    _ => "flagged",\n  }\n}\nfn main() {}\n');
    expect(out).toContain('if (p.V0 == 0) {');
    expect(out).toContain('} else if (!p.V1) {');
  });

  test('`(a, b)` on something else', () => {
    expect(errors(bare('  match 1 {\n    (a, b) => {},\n  }'))[0]).toEqual(['CAN0005', '`(...)` matches a tuple, but the value matched is int', undefined]);
  });
});

describe('loops and methods', () => {
  test('`for (i, x) in xs.enumerated()`', () => {
    const out = go('module m\nfn f(xs: List<string>) -> int {\n  let mut n = 0\n  for (i, x) in xs.enumerated() {\n    if x != "" {\n      n += i\n    }\n  }\n  return n\n}\nfn main() {}\n');
    expect(out).toContain('range enumerated__(xs) {');
    expect(out).toContain('var i int64 = t__1.V0');
  });

  test('`m.entries()` and nested patterns over a map', () => {
    const out = go('module m\nstruct P {\n  x: int\n}\nfn f(m: Map<string, P>) -> int {\n  let mut n = m.entries().length()\n  for (_, P { x }) in m {\n    n += x\n  }\n  return n\n}\nfn main() {}\n');
    expect(out).toContain('entries__(m)');
    expect(out).toContain('var x int64 = t__1.Value.x');
  });

  test('a pair over a list that gives one value', () => {
    expect(diags(bare('  for (a, b) in [1] {\n    assert a == b\n  }'))[0]).toEqual(['CAN0040', 'write `for x in ...`; to number the items, loop over `.enumerated()`']);
  });
});

describe('equality and keys', () => {
  test('`==` is Go\'s when the parts allow, a generated function otherwise', () => {
    expect(go(bare('  if (1, "a") == (1, "a") {\n    return\n  }'))).toContain('(struct{ V0 int64; V1 string }{V0: 1, V1: "a"} == struct{ V0 int64; V1 string }{V0: 1, V1: "a"})');
    expect(go(bare('  if (1, [2]) == (1, [2]) {\n    return\n  }'))).toContain('return a.V0 == b.V0 && eq__');
  });

  test('a tuple as a map key, and `[(a, b): v]` is not a lambda', () => {
    expect(errors(bare('  let m: Map<(int, List<int>), string> = [(1, [2]): "a"]\n  let s = m[(1, [2])] ?? ""\n  if s != "a" {\n    return\n  }'))).toEqual([]);
  });
});
