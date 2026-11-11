import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';

const program = (body: string, files: Record<string, string> = {}) => compile(`module m\n${body}\n`, 'm.candor', 'test', { read: (f) => files[f] ?? null });
const diags = (body: string, files?: Record<string, string>) => program(body, files).diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);
const codes = (body: string) => program(body).diagnostics.map((d) => d.code);
const go = (body: string) => {
  const r = program(body);
  expect(r.diagnostics).toEqual([]);
  return r.go!;
};

const page = 'struct Page<T> {\n  items: List<T>\n  next: string?\n}\n';
const tree = 'enum Tree<T> {\n  Leaf\n  Node { left: Tree<T>, value: T, right: Tree<T> }\n}\n';
const first = 'fn first<T>(xs: List<T>) -> T? {\n  return xs[0]\n}\n';
const each = 'fn each<T>(xs: List<T>, f: fn(T)) uses f {\n  for x in xs {\n    f(x)\n  }\n}\n';

describe('generic declarations', () => {
  test('become Go generics, and every use names its type arguments', () => {
    const out = go(`${page}${tree}${first}fn g() -> int? {\n  let p = Page { items: [1], next: none }\n  return first(p.items)\n}`);
    expect(out).toContain('type m__Page[T__ any] struct {\n\titems []T__\n\tnext opt__[string]\n}');
    expect(out).toContain('type m__Tree[T__ any] struct {\n\ttag__ uint16\n\tNode__left *m__Tree[T__]');
    expect(out).toContain('func m__first[T__ any](ctx__ *candor.Ctx, xs []T__) opt__[T__] {');
    expect(out).toContain('m__Page[int64]{items: []int64{1}, next: opt__[string]{}}');
    expect(out).toContain('return m__first[int64](ctx__, p.items)');
  });

  test('a type is written with its type arguments', () => {
    expect(diags(`${page}fn g(p: Page) {\n}`)).toEqual([['CAN0046', '`Page` is generic, so it needs a type argument', 'write `Page<T>`, with the type in place of `T`']]);
    expect(diags(`${page}fn g(p: Page<int, string>) {\n}`)[0][1]).toBe('`Page` takes 1 type, found 2');
    expect(diags('struct P {\n  x: int\n}\nfn g(p: P<int>) {\n}')[0][1]).toBe('`P` is not generic, so it takes no type arguments');
    expect(diags('fn f<T>(x: T<int>) {\n}')[0][1]).toBe('`T` is a type parameter, so it takes no type arguments');
  });

  test('type parameter names', () => {
    expect(codes('fn f<t>(x: t) {\n}')).toEqual(['CAN0030']);
    expect(diags('fn f<T, T>(x: T) {\n}')[0][1]).toBe('type parameter `T` is listed twice');
    expect(diags('struct T {\n  x: int\n}\nfn f<T>(x: T) {\n}')[0][1]).toBe('`T` is already a type');
  });

  test("inside its own declaration, a type is only itself", () => {
    expect(diags('enum W<T> {\n  End\n  More { w: W<List<T>> }\n}')).toEqual([
      ['CAN0046', 'inside its own declaration, `W` can only be `W<T>`', 'Go cannot build a type that holds itself with other type arguments'],
    ]);
  });

  test('effect operations and main are not generic', () => {
    const ops = 'effect m {\n  pub fn get<T>(x: T) -> T {\n    return x\n  }\n}\nfake m {\n  fn get<T>(x: T) -> T {\n    return x\n  }\n}';
    expect(diags(ops).map(([, m]) => m)).toEqual(["an effect's operations and its fake cannot be generic", "an effect's operations and its fake cannot be generic"]);
    expect(compile('module m\nfn main<T>() {\n}\n', 'm.candor').diagnostics.map((d) => d.code)).toEqual(['CAN0010']);
  });
});

describe('type arguments come from the arguments', () => {
  test('including from lambdas, after the arguments that say more', () => {
    const mapList = 'fn mapList<T, U>(xs: List<T>, f: fn(T) -> U) -> List<U> {\n  let mut out: List<U> = []\n  for x in xs {\n    out.push(f(x))\n  }\n  return out\n}\n';
    const out = go(`${mapList}fn g() -> List<string> {\n  return mapList([1, 2], (n) => n.toString())\n}`);
    expect(out).toContain('m__mapList[int64, string](ctx__, []int64{1, 2}, t__1)');
    // `none` waits for `x` to say what `T` is.
    expect(codes(`fn pick<T>(a: T?, b: T) -> T {\n  return a ?? b\n}\nfn g() -> int {\n  return pick(none, 1)\n}`)).toEqual([]);
  });

  test('or are written, when nothing passed says', () => {
    const empty = 'fn empty<T>() -> List<T> {\n  let xs: List<T> = []\n  return xs\n}\n';
    expect(go(`${empty}fn g() -> int {\n  return empty<int>().length()\n}`)).toContain('m__empty[int64](ctx__)');
    // Where the result goes says what the arguments don't.
    expect(go(`${empty}fn g() -> List<int> {\n  return empty()\n}`)).toContain('m__empty[int64](ctx__)');
    expect(go(`${empty}fn g() -> int {\n  let xs: List<int> = empty()\n  return xs.length()\n}`)).toContain('m__empty[int64](ctx__)');
    expect(diags(`${empty}fn g() {\n  let e = empty()\n}`)[0][2]).toBe('write it: `empty<T>()`, with the type in place of `T`');
    expect(diags(`${first}fn g() -> bool {\n  return first<int, int>([1]) == none\n}`)[0][1]).toBe('`first` takes 1 type, found 2');
    expect(diags('fn g(x: int) -> int {\n  return g<int>(x)\n}')[0][1]).toBe('`g` is not generic, so it takes no type arguments');
  });

  test('a lambda whose first returns are `Err`, `Ok` or `none` waits for one that says the rest', () => {
    expect(codes('fn g(n: int) -> bool {\n  let f = () => {\n    if n < 0 {\n      return Err("neg")\n    }\n    return Ok(n)\n  }\n  return f() == Ok(1)\n}')).toEqual([]);
    expect(codes('fn g(n: int) -> bool {\n  let f = () => {\n    if n < 0 {\n      return none\n    }\n    return Ok(n)\n  }\n  return true\n}')).toContain('CAN0032');
    expect(diags('fn g() {\n  let f = () => {\n    return Err("x")\n  }\n}')).toEqual([
      [
        'CAN0032',
        'cannot tell what this lambda returns: its returns say Result<_, string>, where `_` is not known',
        'annotate it: `(...): Result<T, string> => ...`, with `T` the type meant, or return a value that says',
      ],
    ]);
  });

  test('where the result goes fills what the arguments leave open', () => {
    const run = 'fn run<T, E>(f: fn() -> Result<T, E>) -> Result<T, E> {\n  return f()\n}\n';
    expect(go(`${run}fn g(n: int) -> Result<int, string> {\n  return run(() => {\n    if n < 0 {\n      return Err("neg")\n    }\n    return Err("always")\n  })\n}`)).toContain('m__run[int64, string](ctx__');
    expect(go(`${run}fn g() -> Result<int, string> {\n  return run(() => Ok(1))\n}`)).toContain('m__run[int64, string](ctx__');
    expect(codes(`${first}fn g() -> int? {\n  return first([])\n}`)).toEqual([]);
    expect(codes('fn g() -> Result<int, string> uses tasks {\n  return tasks.scope((s) => {\n    return Err("x")\n  })\n}')).toEqual([]);
  });

  test('when they disagree, the arguments win, and the error says which type came from where', () => {
    const run = 'fn run<T, E>(f: fn() -> Result<T, E>) -> Result<T, E> {\n  return f()\n}\n';
    expect(diags(`${run}fn g(n: int) -> Result<string, string> {\n  return run(() => {\n    if n < 0 {\n      return Err("neg")\n    }\n    return Ok(n)\n  })\n}`)).toEqual([
      [
        'CAN0005',
        '`run(...)` gives Result<int, string>, but where it goes expects Result<string, string>',
        '`T` is int, from the `return` on line 10, and the arguments decide. Change that or the type where it goes',
      ],
    ]);
    expect(diags(`${first}fn g() {\n  let x: string? = first([1])\n}`)[0][2]).toBe('`T` is int, from `xs` (line 6), and the arguments decide. Change that or the type where it goes');
    expect(diags(`${page}fn g() {\n  let p: Page<string> = Page { items: [1], next: none }\n}`)[0][2]).toBe(
      '`T` is int, from field `items` (line 7), and the arguments decide. Change that or the type where it goes',
    );
  });

  test('arguments that disagree', () => {
    expect(diags('fn pair<T>(a: T, b: T) -> List<T> {\n  return [a, b]\n}\nfn g() -> List<int> {\n  return pair(1, "a")\n}')).toEqual([['CAN0005', 'expected int, found string', undefined]]);
  });

  test('struct literals, from their fields', () => {
    expect(go(`${page}fn g() -> Page<bool> {\n  return Page { items: [true], next: "2" }\n}`)).toContain('m__Page[bool]{');
    expect(go(`${page}fn g() -> Page<int> {\n  return Page { items: [], next: none }\n}`)).toContain('m__Page[int64]{');
    expect(diags(`${page}fn g() {\n  let p = Page { items: [], next: none }\n}`)[0].slice(0, 2)).toEqual(['CAN0046', "the fields of `Page` don't say what `T` is"]);
    expect(codes(`${page}fn g() -> Page<int> {\n  return Page<int> { items: [], next: none }\n}`)).toEqual([]);
    // A copy says it all.
    expect(codes(`${page}fn g(p: Page<int>) -> Page<int> {\n  return Page { ...p, next: none }\n}`)).toEqual([]);
  });

  test('variants, from their fields; one without fields from where it goes', () => {
    expect(codes(`${tree}fn g() -> Tree<int> {\n  return Tree.Node { left: Tree<int>.Leaf, value: 1, right: Tree<int>.Leaf }\n}`)).toEqual([]);
    expect(codes(`${tree}fn g() -> Tree<int> {\n  return Tree.Node { left: Tree.Leaf, value: 1, right: Tree.Leaf }\n}`)).toEqual([]);
    expect(codes(`${tree}fn g() -> Tree<int> {\n  return Tree.Leaf\n}`)).toEqual([]);
    expect(diags(`${tree}fn g() {\n  let t = Tree.Leaf\n}`)[0]).toEqual(['CAN0046', "`Tree.Leaf` doesn't say what `T` is", 'write it: `Tree<T>.Leaf`, with the type in place of `T`']);
    expect(diags(`${tree}fn g() -> Tree<int> {\n  return Tree.Node<int> { left: Tree<int>.Leaf, value: 1, right: Tree<int>.Leaf }\n}`)[0][1]).toBe(
      'type arguments go right after the name of the type',
    );
    // The other side of `==` says too.
    expect(codes(`${tree}fn g(t: Tree<int>) -> bool {\n  return t == Tree.Leaf\n}`)).toEqual([]);
  });

  test('patterns on an instance see its fields', () => {
    const r = program(`${tree}fn sum(t: Tree<int>) -> int {\n  return match t {\n    Tree.Leaf => 0\n    Tree.Node { left, value, right } => sum(left) + value + sum(right)\n  }\n}`);
    expect(r.diagnostics).toEqual([]);
    expect(diags(`${tree}fn g(t: Tree<int>) -> bool {\n  return match t {\n    Tree.Node { value: "x" } => true\n    _ => false\n  }\n}`)[0][1]).toBe('this pattern is string, but the value matched is int');
  });
});

describe('a type parameter can only be carried', () => {
  test('not compared', () => {
    expect(diags('fn has<T>(xs: List<T>, x: T) -> bool {\n  return xs.contains(x)\n}')[0][1]).toBe('`contains` compares items with `==`, but `T` has no bound `Eq`');
    expect(diags('fn same<T>(a: T, b: T) -> bool {\n  return a == b\n}')).toEqual([
      [
        'CAN0019',
        'cannot apply `==` to T and T',
        '`T` has no bound `Eq`: add the bound where `T` is declared: `<T: Eq>`',
      ],
    ]);
    expect(diags(`${page}fn same<T>(a: Page<T>, b: Page<T>) -> bool {\n  return a == b\n}`)[0][2]).toStartWith('Page<T> holds `T`, and `T` has no bound `Eq`');
    // Once it stands for something comparable, it compares.
    expect(codes(`${page}fn g(a: Page<int>) -> bool {\n  return a == Page { items: [1], next: none }\n}`)).toEqual([]);
  });

  test('not looked into', () => {
    expect(diags('fn f<T>(x: T) -> int {\n  return x.length()\n}')).toEqual([
      ['CAN0008', '`T` is a type parameter, and its bounds give no `length`', 'a type parameter has only the methods its bounds give: bound it by a trait that has them, `<T: SomeTrait>`'],
    ]);
  });

  test('and a generic function is called, not passed', () => {
    expect(diags(`${first}fn g() {\n  let f = first\n}`)).toEqual([['CAN0025', '`first` is generic, so it can only be called', 'wrap it in a lambda: `(xs) => first(xs)`']]);
  });

  test('`void` too', () => {
    const mapList = 'fn mapList<T, U>(xs: List<T>, f: fn(T) -> U) -> List<U> {\n  return []\n}\n';
    expect(diags(`${mapList}fn skip(s: string) {}\nfn g() -> int {\n  let r = mapList(["a"], (x) => skip(x))\n  return r.length()\n}`)).toEqual([]);
  });

  test('a recursive call may not grow its type arguments', () => {
    const depth = 'fn depth<T>(x: T, n: int) -> int {\n  if n == 0 {\n    return 0\n  }\n  return 1 + depth([x], n - 1)\n}';
    expect(diags(depth)[0][1]).toBe('`depth` is called here with `T` inside `List<T>`, and gets back here, so every round would need a bigger type');
    expect(codes('fn len<T>(xs: List<T>, n: int) -> int {\n  if n == 0 {\n    return 0\n  }\n  return len(xs, n - 1)\n}')).toEqual([]);
  });
});

describe('uses f', () => {
  test("takes on whatever the function passed does, and the caller must allow it", () => {
    expect(codes(`${each}fn g() uses io {\n  each(["a"], (x) => io.println(x))\n}`)).toEqual([]);
    expect(diags(`${each}fn g() {\n  each(["a"], (x) => io.println(x))\n}`)).toEqual([['CAN0004', '`io` is used here but `g` does not declare it', 'add `uses io` to the signature of `fn g`']]);
    // A function value carries its effects in its type.
    expect(diags(`${each}fn g(f: fn(int) uses clock) {\n  each([1], f)\n}`)[0][1]).toBe('the function passed here uses `clock`, which `g` does not declare');
    // Pure callbacks need nothing.
    expect(go(`${each}fn g() {\n  each([1], (x) => {\n  })\n}`)).toContain('m__each[int64](ctx__, []int64{1}, t__1)');
  });

  test('without it, the function passed may do nothing', () => {
    expect(diags('fn each<T>(xs: List<T>, f: fn(T)) {\n  for x in xs {\n    f(x)\n  }\n}\nfn g() uses io {\n  each(["a"], (x) => io.println(x))\n}')[0][1]).toBe(
      'this function uses `io`, which `fn(string)` does not allow',
    );
  });

  test('passes on through other functions that take it on', () => {
    const twice = `${each}fn twice<T>(xs: List<T>, f: fn(T)) uses f {\n  each(xs, f)\n  each(xs, (x) => f(x))\n}\n`;
    expect(codes(`${twice}fn g() uses io {\n  twice(["a"], (x) => io.println(x))\n}`)).toEqual([]);
    // Calling `f` performs it, so a lambda that does can't go where nothing is allowed.
    expect(codes(`fn later(f: fn()) uses f {\n  let g: fn() = () => f()\n}`)).toContain('CAN0005');
  });

  test('names a parameter that is a function, and is used', () => {
    expect(diags('fn f(n: int) uses n {\n}')).toEqual([['CAN0043', '`uses n` takes on what the function `n` does, but `n` is int', 'name an effect, or a parameter that is a function']]);
    expect(program('fn f(g: fn()) uses g {\n}').diagnostics.map((d) => [d.code, d.message])).toEqual([['CAN0014', '`f` declares `uses g` but never calls `g`']]);
    expect(diags('fn run(f: fn()) uses f {\n  f()\n}\nfn g() {\n  let r = run\n}')[0][1]).toBe('`run` takes on the effects of the function it is given, so it can only be called');
  });
});

test('generic types and functions of an imported module', () => {
  // Everything `pub`, fields too.
  const pub = (decls: string) => decls.replace(/^(struct|enum|fn) /gm, 'pub $1 ').replace(/^  (\w+): /gm, '  pub $1: ');
  const kit = `module kit\n${pub(page)}${pub(tree)}${pub(each)}pub fn wrap<T>(xs: List<T>) -> Page<T> {\n  return Page { items: xs, next: none }\n}\n`;
  const files = { 'lib/kit.candor': kit };
  const main =
    'import "lib/kit"\nfn size<T>(t: kit.Tree<T>) -> int {\n  return match t {\n    kit.Tree.Leaf => 0\n    kit.Tree.Node { left, right } => size(left) + 1 + size(right)\n  }\n}\n' +
    'fn g() uses io {\n  let p: kit.Page<int> = kit.wrap([1])\n  let q = kit.Page<string> { items: [], next: none }\n  let t = kit.Tree<bool>.Leaf\n  kit.each(q.items, (s) => io.println(s))\n  io.println(p.items.length().toString() + size(t).toString() + kit.wrap<int>([]).items.length().toString())\n}';
  const r = program(main, files);
  expect(r.diagnostics).toEqual([]);
  expect(r.go).toContain('kit__wrap[int64](ctx__, []int64{1})');
  expect(r.go).toContain('kit__Page[string]{items: []string{}, next: opt__[string]{}}');
  expect(diags('import "lib/kit"\nfn g() -> kit.Page<int> {\n  return kit.Page { items: [], next: none }\n}', files)).toEqual([]);
  expect(diags('import "lib/kit"\nfn g() {\n  let p = kit.Page { items: [], next: none }\n}', files)[0][2]).toBe('write it: `kit.Page<T> { ... }`, with the type in place of `T`');
});

describe('parsing', () => {
  test('`<` after a name is a comparison unless type arguments and `(`, `{` or `.` follow', () => {
    expect(codes('fn g(a: int, b: int, c: int) -> bool {\n  return a < b && b > (c)\n}')).toEqual([]);
    expect(codes('fn h(x: bool, y: bool) -> bool {\n  return x\n}\nfn g(a: int, b: int, c: int, d: int) -> bool {\n  return h(a < b, c > d)\n}')).toEqual([]);
    expect(codes('fn g(a: int, b: int) -> bool {\n  if a < b {\n    return true\n  }\n  return false\n}')).toEqual([]);
  });
});
