import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { plain } from './plain';

const decls = `enum E {
  Bad
  Worse { why: string }
}
`;

/** A module with `extra` declarations and `body` as `main`. */
const mod = (body: string, extra = '') => `module m\n${decls}${extra}\nfn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);
const helpOf = (src: string, code: string) => compile(src, 't').diagnostics.find((d) => d.code === code)?.help;

describe('T?', () => {
  test('a T goes where a T? is expected, and is wrapped in Go', () => {
    const r = compile(mod('  let x: int? = 5\n  io.println((x ?? 0).toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('var x opt__[int64] = opt__[int64]{some: true, value: 5}');
    expect(r.go).toContain('type opt__[T any] struct {');
  });

  test('none needs to know what is missing', () => {
    expect(codes(mod('  let x = none\n  io.println("x")'))).toEqual(['CAN0032']);
    expect(codes(mod('  let x: string? = none\n  io.println(x ?? "-")'))).toEqual([]);
  });

  test('a T? is not a T', () => {
    expect(diags(mod('  let x: int? = 5\n  let y: int = x\n  io.println(y.toString())'))).toEqual([
      ['CAN0005', 'expected int, found int?'],
    ]);
  });

  test('?? only evaluates the default when needed', () => {
    const src = mod('  let x: string? = "a"\n  io.println(x ?? f())', 'fn f() -> string {\n  return "b"\n}\n');
    const go = plain(compile(src, 't').go);
    expect(go).toMatch(/if t__1\.some \{\n\t\tt__2 = t__1\.value\n\t\} else \{\n\t\tt__2 = m__f\(ctx__\)\n\t\}/);
  });

  test('?? on something that is never none', () => {
    expect(helpOf(mod('  io.println("a" ?? "b")'), 'CAN0019')).toBe('it is never `none`; remove `?? ...`');
  });

  test('optionals compare by value, with none and with a plain value', () => {
    const r = compile(mod('  let x: int? = 5\n  if x == none || x == 5 {\n    io.println("x")\n  }'), 't');
    expect(r.diagnostics).toEqual([]);
    // Against `none`, only presence is read; on the right of `||`, `x` is narrowed to an int.
    expect(r.go).toContain('((!x.some) || (x.value == 5))');
    const plain = compile(mod('  let x: int? = 5\n  if x == 5 {\n    io.println("x")\n  }'), 't');
    expect(plain.go).toContain('(x == opt__[int64]{some: true, value: 5})');
  });

  test('branches with a value and none make a T?', () => {
    const r = compile(mod('  let x = if true { 1 } else { none }\n  io.println((x ?? 0).toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('var t__1 opt__[int64]');
    // `none` first too (it became `none?` against itself).
    const first = compile(mod('  let x = if false { none } else { 1 }\n  let y = match x {\n    none => none\n    n => n + 1\n  }\n  io.println(((x ?? 0) + (y ?? 0)).toString())'), 't');
    expect(first.diagnostics).toEqual([]);
  });

  test('match: none, and a name binds the present value', () => {
    const src = mod('  let x: int? = 5\n  let s = match x {\n    none => "none"\n    n => n.toString()\n  }\n  io.println(s)');
    const r = compile(src, 't');
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('} else {\n\t\tvar n int64 = x.value');
  });

  test('match: a name without a none arm above takes the whole optional', () => {
    const src = mod('  let x: int? = 5\n  let s = match x {\n    n => n + 1\n  }\n  io.println(s.toString())');
    expect(diags(src)).toEqual([['CAN0019', 'cannot apply `+` to int? and int']]);
    expect(helpOf(src, 'CAN0019')).toContain('put an arm for `none` above this one');
  });

  test('match: literals on a T? are about the present value', () => {
    const src = mod('  let x: int? = 5\n  let s = match x {\n    none => "none"\n    0 => "zero"\n  }\n  io.println(s)');
    expect(diags(src)).toEqual([['CAN0027', 'this `match` does not cover `x`']]);
  });

  test('habits from other languages get the Candor spelling', () => {
    expect(helpOf(mod('  let x: int? = null\n  io.println("x")'), 'CAN0002')).toBe(
      'absence is `none`, and only a `T?` can hold it',
    );
    expect(helpOf(mod('  let x: int? = Some(1)\n  io.println("x")'), 'CAN0002')).toContain('write the value itself');
    expect(helpOf(mod('  let x: Option<int> = 1\n  io.println("x")'), 'CAN0015')).toBe('write `int?`');
  });

  test('a struct may contain itself through T?', () => {
    const r = compile(mod('  let n = Node { next: none }\n  io.println("x")', 'struct Node {\n  next: Node?\n}\n'), 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0013']);
    expect(r.go).toContain('\tnext *opt__[m__Node]');
    expect(r.go).toContain('m__Node{next: ptr__(opt__[m__Node]{})}');
  });
});

describe('Result', () => {
  const fn = (body: string, ret = 'Result<int, E>') => mod('  io.println("x")', `fn f(s: string) -> ${ret} {\n${body}\n}\n`);

  test('Ok and Err take their type from where they go', () => {
    const r = compile(fn('  if s == "" {\n    return Err(E.Bad)\n  }\n  return Ok(1)'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('return res__[int64, m__E]{err: m__E{tag__: 0}}');
    expect(r.go).toContain('return res__[int64, m__E]{ok: true, value: 1}');
  });

  test('Ok without a known Result type', () => {
    expect(codes(mod('  let r = Ok(1)\n  io.println("x")'))).toEqual(['CAN0032']);
  });

  test('Ok with the wrong value', () => {
    expect(diags(fn('  return Ok("one")'))).toEqual([['CAN0005', 'expected int, found string']]);
  });

  test('? returns the error early', () => {
    const r = compile(fn('  let n = f(s)?\n  return Ok(n + 1)'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('var t__1 res__[int64, m__E] = m__f(ctx__, s)\n\tif !t__1.ok {\n\t\treturn res__[int64, m__E]{err: t__1.err}\n\t}');
    expect(r.go).toContain('var n int64 = t__1.value');
  });

  test('? needs the function to return a Result', () => {
    const src = mod('  let n = f("1")?\n  io.println(n.toString())', 'fn f(s: string) -> Result<int, E> {\n  return Ok(1)\n}\n');
    expect(diags(src)).toEqual([['CAN0033', '`?` passes the error on, but `main` returns void']]);
  });

  test('? does not convert error types', () => {
    const extra = 'fn g() -> Result<int, string> {\n  return Ok(1)\n}\n';
    const src = mod('  io.println("x")', `${extra}fn f() -> Result<int, E> {\n  let n = g()?\n  return Ok(n)\n}\n`);
    expect(diags(src)).toEqual([['CAN0033', '`?` would pass on a string error, but `f` returns Result<int, E>']]);
  });

  test('? on an optional in a Result function', () => {
    const src = fn('  let x: int? = 1\n  let n = x?\n  return Ok(n)');
    expect(helpOf(src, 'CAN0033')).toBe('handle `none` with `match` or `??`');
  });

  test('match on Ok and Err, exhaustively, through nested patterns', () => {
    const body = '  return match f(s) {\n    Ok(n) => n\n    Err(E.Bad) => 0\n  }';
    const src = mod('  io.println("x")', `fn f(s: string) -> Result<int, E> {\n  return Ok(1)\n}\nfn g(s: string) -> int {\n${body}\n}\n`);
    expect(diags(src)).toEqual([['CAN0027', 'this `match` does not cover `Err(E.Worse)`']]);
  });

  test('Some in a pattern gets a fix', () => {
    const src = mod('  let x: int? = 1\n  match x {\n    Some(n) => io.println("x")\n    none => io.println("y")\n  }');
    expect(helpOf(src, 'CAN0001')).toContain('write `x`, not `Some(x)`');
  });
});
