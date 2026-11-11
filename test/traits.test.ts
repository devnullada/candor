import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';

const program = (body: string, files: Record<string, string> = {}) => compile(`module m\n${body}\n`, 'm.candor', 'test', { read: (f) => files[f] ?? null });
const diags = (body: string, files?: Record<string, string>) => program(body, files).diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);
const messages = (body: string, files?: Record<string, string>) => diags(body, files).map(([, m]) => m);
const go = (body: string, files?: Record<string, string>) => {
  const r = program(body, files);
  expect(r.diagnostics).toEqual([]);
  return r.go!;
};

const describeTrait = 'trait Describe {\n  fn describe(self) -> string\n}\n';
const point = 'struct P {\n  x: int\n}\n';
const describeP = `${describeTrait}${point}impl Describe for P {\n  fn describe(self) -> string {\n    return self.x.toString()\n  }\n}\n`;
const ordP = `${point}impl Ord for P {\n  fn compare(self, other: P) -> int {\n    return self.x - other.x\n  }\n}\n`;

describe('bounds', () => {
  test('are written after the type parameter, joined with `+`', () => {
    const out = go(`${describeTrait}fn f<T: Ord + Describe, U>(x: T, u: U) -> string {\n  return x.describe()\n}`);
    expect(out).toContain('func m__f[T__ any, T__Ord Ord__[T__], T__m__Describe m__Describe[T__], U__ any](ctx__ *candor.Ctx, x T__, u U__) string {');
    expect(out).toContain('return (*new(T__m__Describe)).describe(ctx__, x)');
  });

  test('name traits', () => {
    expect(diags('fn f<T: Foo>(x: T) {\n}')).toEqual([['CAN0015', 'unknown trait `Foo`', 'bounds are `Eq`, `Ord`, or traits declared with `trait`']]);
    expect(diags('fn f<T: Eqq>(x: T) {\n}')[0][2]).toBe('did you mean `Eq`?');
    expect(messages(`${point}fn f<T: P>(x: T) {\n}`)).toEqual(['`P` is a type, not a trait']);
    expect(messages('fn f<T: Eq + Eq>(x: T) {\n}')).toEqual(['`Eq` is listed twice']);
  });

  test('are checked where a call picks the type', () => {
    const has = 'fn has<T: Eq>(xs: List<T>, x: T) -> bool {\n  return xs.contains(x)\n}\n';
    expect(diags(`${has}fn g() -> bool {\n  return has([(x: int) => x], (x: int) => x)\n}`)).toEqual([
      ['CAN0047', '`has` needs `T: Eq`, and `T` is fn(int) -> int here: functions cannot be compared', undefined],
    ]);
    expect(diags(`${has}fn g<U>(xs: List<U>, x: U) -> bool {\n  return has(xs, x)\n}`)).toEqual([
      ['CAN0047', '`has` needs `T: Eq`, and `T` is `U` here: `U` has no bound `Eq`', 'add the bound where `U` is declared: `<U: Eq>`'],
    ]);
    expect(diags(`${point}fn big<T: Ord>(xs: List<T>) -> T? {\n  return xs.sorted().last()\n}\nfn g() -> P? {\n  return big([P { x: 1 }])\n}`)).toEqual([
      ['CAN0047', '`big` needs `T: Ord`, and `T` is P here: P has no `impl Ord`', 'give it one: `impl Ord for P { fn compare(self, other: P) -> int { ... } }`'],
    ]);
  });

  test('on a type are checked wherever it is used', () => {
    const ranked = 'struct Ranked<T: Ord> {\n  items: List<T>\n}\n';
    expect(messages(`${ranked}fn f<U>(r: Ranked<U>) {\n}`)).toEqual(['`Ranked` needs `T: Ord`, and `T` is `U` here: `U` has no bound `Ord`']);
    expect(messages(`${ranked}${point}fn f() {\n  let r = Ranked { items: [P { x: 1 }] }\n}`)).toEqual(['`Ranked` needs `T: Ord`, and `T` is P here: P has no `impl Ord`']);
    expect(messages(`${ranked}struct Both<U> {\n  r: Ranked<U>\n}`)).toEqual(['`Ranked` needs `T: Ord`, and `T` is `U` here: `U` has no bound `Ord`']);
    go(`${ranked}fn f<U: Ord>(r: Ranked<U>) -> List<U> {\n  return r.items\n}`);
  });

  test('pass their dictionaries on at every call', () => {
    const out = go(`${ordP}fn top<T: Ord>(xs: List<T>) -> T? {\n  return xs.sorted().last()\n}\nfn twice<U: Ord>(xs: List<U>) -> U? {\n  return top(xs)\n}\nfn g() -> P? {\n  return twice([P { x: 1 }])\n}`);
    expect(out).toContain('return m__top[U__, U__Ord](ctx__, xs)');
    expect(out).toContain('return m__twice[m__P, Ord__for__m__P](ctx__, []m__P{m__P{x: 1}})');
    expect(out).toContain('sorted__(ctx__, xs, (*new(T__Ord)).compare)');
  });
});

describe('Eq', () => {
  test('is what `==` and `contains` work on, through a bound too', () => {
    const out = go('fn same<T: Eq>(a: List<T>, b: T?, x: T) -> bool {\n  return a == [] || b == none || a.contains(x) || x == x\n}');
    expect(out).toContain('func m__same[T__ any, T__Eq Eq__[T__]]');
    expect(out).toContain('contains__(a, x, (*new(T__Eq)).eq)');
    expect(out).toContain('(*new(T__Eq)).eq(x, x)');
    // Equality on a type holding `T` is generic over it.
    expect(out).toContain('func eq__1[T__ any, T__Eq Eq__[T__]](a, b []T__) bool {');
  });

  test("a concrete type's dictionary is Go's `==`, or its equality function", () => {
    const out = go('fn has<T: Eq>(xs: List<T>, x: T) -> bool {\n  return xs.contains(x)\n}\nfn g() -> bool {\n  return has([1], 1) && has([[1]], [1])\n}');
    expect(out).toContain('m__has[int64, eqGo__[int64]](ctx__');
    expect(out).toContain('m__has[[]int64, eqd__');
  });

  test('cannot be implemented', () => {
    expect(diags(`${point}impl Eq for P {\n}`)).toEqual([
      ['CAN0048', '`Eq` cannot be implemented', '`==` always compares by value, field by field: every type whose fields can be compared is `Eq` already'],
    ]);
  });
});

describe('Ord', () => {
  test('is int, string, and types with `impl Ord`', () => {
    const out = go(`${ordP}fn g(a: P, b: P) -> bool {\n  return a < b && 1 < 2 && "a" <= "b" && a.compare(b) == 1.compare(2)\n}`);
    expect(out).toContain('((Ord__for__m__P{}).compare(ctx__, a, b) < 0)');
    expect(out).toContain('(1 < 2)');
    expect(out).toContain('(ordGo__[int64]{}).compare(ctx__, 1, 2)');
    expect(out).toContain('func (Ord__for__m__P) compare(ctx__ *candor.Ctx, self m__P, other m__P) int64 {');
  });

  test('orders `<` and `sorted`', () => {
    expect(diags(`${point}fn f(a: P, b: P) -> bool {\n  return a < b\n}`)).toEqual([
      ['CAN0019', 'cannot apply `<` to P and P', 'P has no `impl Ord`: give it one: `impl Ord for P { fn compare(self, other: P) -> int { ... } }`'],
    ]);
    expect(diags('fn f<T>(a: T, b: T) -> bool {\n  return a < b\n}')[0][2]).toBe('`T` has no bound `Ord`: add the bound where `T` is declared: `<T: Ord>`');
    expect(messages(`${point}fn f(xs: List<P>) -> List<P> {\n  return xs.sorted()\n}`)).toEqual(['`sorted` orders items with `<`, but P has no `impl Ord`']);
  });

  test('int and string have it already', () => {
    expect(messages('impl Ord for int {\n  fn compare(self, other: int) -> int {\n    return 0\n  }\n}')).toEqual(['int is `Ord` already']);
  });
});

describe('traits', () => {
  test('are Go interfaces; an impl is a type with their methods', () => {
    const out = go(`${describeP}fn g(p: P) -> string {\n  return p.describe()\n}`);
    expect(out).toContain('type m__Describe[Self__ any] interface {\n\tdescribe(*candor.Ctx, Self__) string\n}');
    expect(out).toContain('type m__Describe__for__m__P struct{}');
    expect(out).toContain('func (m__Describe__for__m__P) describe(ctx__ *candor.Ctx, self m__P) string {');
    expect(out).toContain('return (m__Describe__for__m__P{}).describe(ctx__, p)');
  });

  test('`Self` is the type that has the trait', () => {
    const same = `trait Same {\n  fn same(self, other: Self) -> bool\n}\n${point}impl Same for P {\n  fn same(self, other: Self) -> bool {\n    return self == other\n  }\n}\n`;
    go(`${same}fn g(p: P) -> bool {\n  return p.same(p)\n}`);
    expect(messages('fn f(x: Self) {\n}')).toEqual(['`Self` only means something in a `trait` or an `impl`']);
  });

  test('are not types', () => {
    expect(diags(`${describeTrait}fn f(x: Describe) {\n}`)).toEqual([['CAN0015', '`Describe` is a trait, not a type', 'take a type parameter that has it: `fn f<T: Describe>(x: T)`']]);
  });

  test('methods are called, and only what the bounds give', () => {
    expect(messages(`${describeP}fn g(p: P) {\n  let f = p.describe\n}`)).toEqual(['`describe` is a method and must be called']);
    expect(diags(`${describeTrait}fn f<T>(x: T) -> string {\n  return x.describe()\n}`)).toEqual([
      ['CAN0008', '`T` is a type parameter, and its bounds give no `describe`', 'add the bound: `<T: Describe>`'],
    ]);
    const two = 'trait A {\n  fn go(self) -> int\n}\ntrait B {\n  fn go(self) -> int\n}\n';
    expect(messages(`${two}fn f<T: A + B>(x: T) -> int {\n  return x.go()\n}`)).toEqual(['`go` is a method of both `A` and `B`, so it is unclear which one this calls']);
  });

  test('declare signatures: `self` first, nothing generic', () => {
    expect(messages('trait S {\n  fn s() -> string\n}')).toEqual(['`s` in `S` takes `self` first']);
    expect(messages('trait S {\n  fn s(self, f: fn()) uses f\n}')).toEqual(["a method's `uses` names effects, and `f` is a parameter"]);
    expect(messages('trait S {\n  fn s<T>(self, x: T)\n}')).toEqual(['a method cannot be generic yet']);
    expect(messages('trait S {\n  fn s(self)\n  fn s(self)\n}')).toEqual(['`s` is listed twice']);
    expect(diags('trait S<T> {\n}')[0][1]).toBe('traits take no type parameters yet');
    expect(diags('fn f(self) {\n}')[0][1]).toBe('only methods take `self`');
  });
});

describe('impls', () => {
  test('give every method, with the signature the trait gives', () => {
    const trait = 'trait S {\n  fn s(self) -> string\n  fn t(self) -> int\n}\n';
    expect(messages(`${trait}${point}impl S for P {\n  fn s(self) -> int {\n    return 1\n  }\n  fn u(self) {\n  }\n}`)).toEqual([
      '`impl S for P` has no `t`',
      '`s` must have the signature `S` gives it: expected fn(P) -> string, found fn(P) -> int',
      '`S` has no method `u`',
    ]);
  });

  test('are for a struct or enum, or int, string or bool, one per trait and type', () => {
    expect(messages(`${describeTrait}impl Describe for List<int> {\n}`)).toEqual(['an `impl` is for one struct or enum, or int, string or bool, not List<int>']);
    expect(messages(`${describeTrait}impl<T> Describe for T {\n}`)).toEqual(['an `impl` is for one struct or enum, or int, string or bool, not T']);
    expect(messages(`${describeP}impl Describe for P {\n  fn describe(self) -> string {\n    return ""\n  }\n}`)).toEqual(['P already has `impl Describe`']);
    go(`${describeTrait}impl Describe for int {\n  fn describe(self) -> string {\n    return self.toString()\n  }\n}\nfn g() -> string {\n  return 1.describe()\n}`);
  });

  test("can't hide a field or a built-in method", () => {
    const x = 'trait X {\n  fn x(self) -> int\n}\n';
    expect(messages(`${x}${point}impl X for P {\n  fn x(self) -> int {\n    return 1\n  }\n}`)).toEqual(['P has a field `x`, so a method cannot have that name']);
    expect(messages(`trait T {\n  fn toString(self) -> string\n}\nimpl T for int {\n  fn toString(self) -> string {\n    return ""\n  }\n}`)).toEqual(['int has a method `toString` already']);
  });

  const shapes = 'module shapes\npub trait Area {\n  fn area(self) -> int\n}\npub struct Sq {\n  pub side: int\n}\nimpl Area for Sq {\n  fn area(self) -> int {\n    return self.side * self.side\n  }\n}\n';
  const files = { 'shapes.candor': shapes };

  test('of imported traits and types work, written with their module', () => {
    const out = go(
      `import "shapes"\n${point}impl shapes.Area for P {\n  fn area(self) -> int {\n    return self.x\n  }\n}\nfn total<T: shapes.Area>(xs: List<T>) -> int {\n  let mut n = 0\n  for x in xs {\n    n += x.area()\n  }\n  return n\n}\nfn g() -> int {\n  return total([P { x: 1 }]) + total([shapes.Sq { side: 2 }]) + shapes.Sq { side: 3 }.area()\n}`,
      files,
    );
    expect(out).toContain('type shapes__Area__for__m__P struct{}');
    expect(out).toContain('m__total[shapes__Sq, shapes__Area__for__shapes__Sq](ctx__');
  });

  test('live with the trait or the type', () => {
    expect(diags('import "shapes"\nimpl Ord for shapes.Sq {\n  fn compare(self, other: shapes.Sq) -> int {\n    return 0\n  }\n}', files)).toEqual([
      ['CAN0048', '`impl Ord for shapes.Sq` belongs in the module of `Ord` or of shapes.Sq', 'so there is one place to look for it, and two modules cannot give the same type the same trait'],
    ]);
    expect(messages('import "shapes"\nfn f<T: shapes.Volume>(x: T) {\n}', files)).toEqual(['module `shapes` has no trait `Volume`']);
    expect(diags('import "shapes"\nfn f<T: Area>(x: T) {\n}', files)[0][2]).toBe('`Area` is declared in module `shapes`; write `shapes.Area`');
  });
});
