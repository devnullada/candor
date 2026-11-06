import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { plain } from './plain';

const bare = (body: string, extra = '') => `module m\n${extra}fn main() {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);
const go = (src: string) => {
  const r = compile(src, 't');
  expect(r.diagnostics).toEqual([]);
  return r.go!;
};

const check = 'fn check(n: int) -> Result<void, string> {\n  if n < 0 {\n    return Err("negative")\n  }\n  return Ok()\n}\n';

describe('writing it', () => {
  test('`Result<void, E>` and `Ok()`', () => {
    const out = go(bare('  match check(1) {\n    Ok() => {},\n    Err(_) => {},\n  }', check));
    expect(out).toContain('func m__check(ctx__ *candor.Ctx, n int64) res__[struct{}, string] {');
    expect(out).toContain('return res__[struct{}, string]{ok: true, value: struct{}{}}');
  });

  test('`Ok()` is only for nothing, and nothing takes only `Ok()`', () => {
    expect(diags('module m\nfn f() -> Result<int, string> {\n  return Ok()\n}\nfn main() {}\n')).toEqual([['CAN0006', 'give the value: `Ok(x)`']]);
    expect(diags('module m\nfn g() {}\nfn f() -> Result<void, string> {\n  return Ok(g())\n}\nfn main() {}\n')).toEqual([['CAN0006', 'write `Ok()`']]);
    expect(diags(bare('  match check(1) {\n    Ok() => {},\n    Err(_) => {},\n  }', 'fn check(n: int) -> Result<int, string> {\n  return Ok(n)\n}\n'))).toEqual([['CAN0005', 'write `Ok(x)`, or `Ok(_)`']]);
  });

  test('`-> void` says nothing', () => {
    expect(diags('module m\nfn f() -> void {}\nfn main() {\n  f()\n}\n')).toEqual([['CAN0050', 'leave out `-> void`']]);
  });

  test('there is no `()`', () => {
    expect(diags('module m\nfn f() -> Result<(), string> {\n  return Ok()\n}\nfn main() {}\n')).toEqual([['CAN0001', 'write `void`']]);
    expect(codes(bare('  let x = ()'))).toEqual(['CAN0001']);
  });
});

describe('using it', () => {
  test('`save(x)?` on its own line passes the error on', () => {
    const out = go(`module m\n${check}fn all(ns: List<int>) -> Result<void, string> {\n  for n in ns {\n    check(n)?\n  }\n  return Ok()\n}\nfn main() {}\n`);
    expect(out).toContain('if !t__1.ok {');
    expect(out).not.toContain('\tt__1.value\n');
  });

  test('a dropped Result is a warning', () => {
    expect(diags(bare('  check(1)', check))).toEqual([['CAN0049', 'pass the error on with `?`, or handle it with `match`']]);
  });

  // Card 74cc743a: these passed the checker and broke `go build` ("value of type bool is not used").
  test("a built-in method's value dropped is CAN0012, with help that fits", () => {
    const pair = 'fn pair() -> Result<int, string> {\n  return Ok(1)\n}\n';
    expect(diags(bare('  check(1).isOk()', check))).toEqual([
      ['CAN0012', 'to ignore the error, `match` it: `match ... { Ok() => {}, Err(_) => {} }`; to pass it on, use `?`'],
    ]);
    expect(diags(bare('  pair().isErr()', pair))).toEqual([
      ['CAN0012', 'to ignore the error, `match` it: `match ... { Ok(_) => {}, Err(_) => {} }`; to pass it on, use `?`'],
    ]);
    expect(diags(bare('  let xs = [1]\n  xs.isEmpty()'))).toEqual([['CAN0012', 'assign it with `let`, or remove it']]);
    expect(diags(bare('  " a ".trim()'))).toEqual([['CAN0012', 'assign it with `let`, or remove it']]);
    expect(diags(bare('  let m = ["a": 1]\n  m.has("a")'))).toEqual([['CAN0012', 'assign it with `let`, or remove it']]);
  });

  test('`xs.pop()` and `m.remove(k)` change the value, so theirs may be dropped', () => {
    const out = go('module m\nfn main() {\n  let mut xs = [1, 2]\n  xs.pop()\n  let mut m = ["a": 1]\n  m.remove("a")\n  if xs.isEmpty() && m.isEmpty() {\n    return\n  }\n}\n');
    expect(out).toContain('func m__main(');
  });

  test('a type parameter can be `void`', () => {
    const out = go('module m\nfn twice<T>(f: fn() -> T) -> List<T> {\n  return [f(), f()]\n}\nfn quiet() {}\nfn main() {\n  let vs = twice(() => quiet())\n  if vs.isEmpty() {\n    quiet()\n  }\n}\n');
    expect(out).toContain('m__twice[struct{}]');
    expect(out).toContain('func(ctx__ *candor.Ctx) struct{} {');
  });

  test('a `void` call as a value runs first, then passes `struct{}{}`', () => {
    const out = go('module m\nfn id<T>(x: T) -> T {\n  return x\n}\nfn quiet() {}\nfn main() {\n  let vs = [id(quiet())]\n  if vs.isEmpty() {\n    quiet()\n  }\n}\n');
    expect(plain(out)).toContain('m__quiet(ctx__)\n\tm__id[struct{}](ctx__, struct{}{})\n\tvar vs []struct{} = []struct{}{struct{}{}}');
  });

  test("a built-in effect's method as a value", () => {
    const out = go('module m\nfn each(xs: List<string>, f: fn(string) uses io) uses io {\n  for x in xs {\n    f(x)\n  }\n}\nfn main() uses io {\n  each(["a"], io.println)\n}\n');
    expect(out).toContain('func(c__ *candor.Ctx, a__0 string) struct{} { io.Println(c__, a__0); return struct{}{} }');
  });
});

describe('bindings', () => {
  test('a Go function that returns only an `error`', () => {
    const r = compile('module m\neffect m {\n  extern "os" {\n    fn Chdir(dir: string) -> Result<void, GoError> as chdir\n  }\n  pub fn go(dir: string) -> bool {\n    return match chdir(dir) {\n      Ok() => true,\n      Err(_) => false,\n    }\n  }\n}\nfake m {\n  fn go(dir: string) -> bool {\n    return true\n  }\n}\nfn main() uses m {\n  if m.go("x") {\n    m.go("y")\n  }\n}\n', 't');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.bindings).toContain('if err := f(A0(a0)); err != nil {');
    expect(r.bindings).toContain('return res__[struct{}, candor.GoError]{ok: true}');
  });
});
