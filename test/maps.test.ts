import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';

const bare = (body: string) => `module m\nfn main() {\n${body}\n}\n`;
const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);
const go = (src: string) => {
  const r = compile(src, 't');
  expect(r.diagnostics).toEqual([]);
  return r.go!;
};

describe('the type and literals', () => {
  test('`["a": 1]`, `[:]` from context, and `Map<K, V>`', () => {
    const out = go(mod('  let m = ["a": 1, "b": 2]\n  let e: Map<string, int> = [:]\n  io.println((m == e).toString())'));
    expect(out).toContain('var m candor.Map[string, int64] = candor.MapOf([]candor.MapEntry[string, int64]{{Key: "a", Value: 1}, {Key: "b", Value: 2}})');
    expect(out).toContain('var e candor.Map[string, int64] = candor.Map[string, int64]{}');
  });

  test('an empty map needs a type', () => {
    expect(diags(mod('  let m = [:]\n  io.println(m.length().toString())'))).toEqual([['CAN0032', 'annotate it: `let m: Map<string, int> = [:]`']]);
  });

  test('a literal is one or the other', () => {
    expect(diags(mod('  let m = ["a": 1, 2]'))[0]).toEqual(['CAN0001', 'give every item of a map a key: `[k: v, ...]`']);
    expect(codes(mod('  let m = [1, "a": 2]'))[0]).toBe('CAN0001');
  });

  test('entries must agree, and a literal key given twice is an error', () => {
    expect(codes(mod('  let m = ["a": 1, "b": "x"]'))).toContain('CAN0005');
    expect(diags(mod('  let m = ["a": 1, "a": 2]\n  io.println(m.length().toString())'))).toEqual([['CAN0016', 'keep one']]);
  });

  test('keys must have `==`', () => {
    expect(diags('module m\nfn f(m: Map<fn() -> int, int>) {}\nfn main() {}\n')).toEqual([['CAN0047', 'map keys are compared with `==`, but functions cannot be compared']]);
    expect(diags('module m\nfn f<K>(m: Map<K, int>) {}\nfn main() {}\n')).toEqual([['CAN0047', 'add the bound where `K` is declared: `<K: Eq>`']]);
    // Lists and structs holding them are fine: they compare by value.
    expect(codes('module m\nstruct P {\n  xs: List<int>\n}\nfn f(m: Map<P, Map<List<int>, int>>) {}\nfn main() {}\n')).toEqual([]);
  });

  test('`Map` takes two types', () => {
    expect(diags('module m\nfn f(m: Map<string>) {}\nfn main() {}\n')).toEqual([['CAN0015', 'write `Map<K, V>`: the key, then the value']]);
  });
});

describe('lookups and methods', () => {
  test('`m[k]` is a `V?`', () => {
    expect(codes(mod('  let m = ["a": 1]\n  let n: int = m["a"]'))).toContain('CAN0005');
    expect(codes(mod('  let m = ["a": 1]\n  io.println(m[1].toString())'))).toContain('CAN0005');
    expect(go(mod('  let m = ["a": 1]\n  io.println((m["a"] ?? 0).toString())'))).toContain('optOf__(m.Get("a"))');
  });

  test('read-only methods', () => {
    const out = go(mod('  let m = ["a": 1]\n  io.println(m.length().toString() + m.isEmpty().toString() + m.has("a").toString() + m.keys().join("") + m.values().length().toString())'));
    expect(out).toContain('m.Len()');
    expect(out).toContain('m.Has("a")');
    expect(out).toContain('m.Keys()');
  });

  test('names from other languages point at the Candor one', () => {
    expect(diags(bare('  let m = ["a": 1]\n  let x = m.get("a")'))).toEqual([['CAN0008', 'look a key up by index, `m[key]`: it gives a `V?`']]);
    expect(diags(bare('  let m = ["a": 1]\n  let x = m.containsKey("a")'))).toEqual([['CAN0008', 'use `has`']]);
    expect(diags(bare('  let m = ["a": 1]\n  let x = m.length'))).toEqual([['CAN0020', 'write `.length()`']]);
  });

  test('`m[k] = v` and `remove` need a `let mut`; `set` points at `m[k] = v`', () => {
    expect(diags(bare('  let m = ["a": 1]\n  m["b"] = 2'))).toEqual([['CAN0036', 'declare it with `let mut m`']]);
    expect(diags(bare('  let m = ["a": 1]\n  m.remove("a")'))).toEqual([['CAN0036', 'declare it with `let mut m`']]);
    expect(diags(bare('  let mut m = ["a": 1]\n  m.set("b", 2)'))).toEqual([['CAN0008', 'assign by index: `m[key] = value`']]);
    const out = go(mod('  let mut m = ["a": 1]\n  m["b"] = 2\n  let r = m.remove("a")\n  io.println((r ?? 0).toString())'));
    expect(out).toContain('m.Set("b", 2)');
    expect(out).toContain('optOf__(m.Remove("a"))');
  });

  test('`m[k] = v` checks the key and the value, and takes a `V`, not a `V?`', () => {
    expect(codes(bare('  let mut m = ["a": 1]\n  m[1] = 2'))).toEqual(['CAN0005']);
    expect(codes(bare('  let mut m = ["a": 1]\n  m["b"] = "x"'))).toEqual(['CAN0005']);
    expect(codes(bare('  let mut m = ["a": 1]\n  m["b"] = m["a"]'))).toEqual(['CAN0005']);
    expect(diags(bare('  let mut m = ["a": 1]\n  m["b"] = m["a"] ?? 0'))).toEqual([]);
  });

  test('`m[k] += v` is refused: the key may be missing', () => {
    expect(diags(bare('  let mut m = ["a": 1]\n  m["a"] += 1'))).toEqual([['CAN0036', 'say what a missing key starts at: `m["a"] = (m["a"] ?? 0) + 1`']]);
    expect(diags(bare('  let mut m = ["a": 1]\n  let k = "a"\n  m[k] -= 1'))).toEqual([['CAN0036', 'say what a missing key starts at: `m[k] = (m[k] ?? 0) + 1`']]);
  });

  test('`m[k] = v` evaluates the map\'s key before the value', () => {
    const src = 'module m\nfn k() -> string uses io {\n  io.println("k")\n  return "a"\n}\nfn v() -> int uses io {\n  io.println("v")\n  return 1\n}\nfn main() uses io {\n  let mut m: Map<string, int> = [:]\n  m[k()] = v()\n}\n';
    const out = go(src);
    expect(out.indexOf('m__k(')).toBeLessThan(out.indexOf('m__v('));
  });

  test('a map field in a struct is copied before it changes', () => {
    const extra = 'struct S {\n  m: Map<string, int>\n}\n';
    expect(go(mod('  let mut s = S { m: [:] }\n  s.m["a"] = 1\n  io.println(s.m.length().toString())', extra))).toContain('s.m.SetCopy("a", 1)');
    expect(diags(bare('  let s = S { m: [:] }\n  s.m["a"] = 1').replace('module m\n', `module m\n${extra}`))).toEqual([['CAN0036', 'declare it with `let mut s`']]);
  });

  test('reading a `let mut` map as a value shares it; lookups do not', () => {
    const out = go('module m\nfn f() -> Map<string, int> {\n  let mut m: Map<string, int> = [:]\n  m["a"] = 1\n  if m.has("a") && m["a"] == 1 {\n    return m\n  }\n  return [:]\n}\nfn main() {}\n');
    expect(out).toContain('return m.Share()');
    expect(out).toContain('m.Has("a")');
    expect(out).not.toContain('m.Share().Has');
  });
});

describe('loops', () => {
  test('`for (k, v) in m`', () => {
    const out = go(mod('  let m = ["a": 1]\n  for (k, v) in m {\n    io.println(k + v.toString())\n  }'));
    expect(out).toContain('range m.Entries() {');
    expect(out).toContain('var k string = t__1.Key');
  });

  test('one name over a map, or two over a list', () => {
    expect(diags(mod('  let m = ["a": 1]\n  for k in m {\n    io.println(k)\n  }'))).toEqual([['CAN0040', 'write `for (k, value) in ...`, or loop over `.keys()`']]);
    expect(diags(mod('  for (a, b) in [1] {\n    io.println(a.toString())\n  }'))[0]).toEqual(['CAN0040', 'write `for x in ...`; to number the items, loop over `.enumerated()`']);
  });
});

describe('equality', () => {
  test('maps are `Eq` when their values are, and compare ignoring order', () => {
    const out = go(mod('  io.println((["a": 1] == ["a": 1]).toString())'));
    expect(out).toContain('return candor.MapEq(a, b, func(x, y int64) bool { return x == y })');
    expect(codes(mod('  let m = ["a": () => 1]\n  io.println((m == m).toString())'))).toEqual(['CAN0019']);
  });

  test('a generic map compares its values through the bound', () => {
    expect(go('module m\nfn same<K: Eq, V: Eq>(a: Map<K, V>, b: Map<K, V>) -> bool {\n  return a == b\n}\nfn main() {}\n')).toContain('candor.MapEq(a, b, (*new(V__Eq)).eq)');
  });
});

describe('`??` gives its right side a type', () => {
  test('`m[k] ?? []` and `?? [:]`', () => {
    expect(codes(mod('  let m: Map<string, List<int>> = [:]\n  let xs = m["a"] ?? []\n  let n: Map<string, int>? = none\n  let e = n ?? [:]\n  io.println(xs.length().toString() + e.length().toString())'))).toEqual([]);
  });
});
