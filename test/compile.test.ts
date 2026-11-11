import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { plain } from './plain';

const hello = `module hello

fn main() uses io {
  io.println("Hello, world")
}
`;

const codes = (src: string) => compile(src, 'test.candor').diagnostics.map((d) => d.code);

describe('hello world', () => {
  test('compiles to Go', () => {
    const r = compile(hello, 'hello.candor');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('candor "candor.dev/runtime"');
    expect(r.go).toContain('hello__main(candor.Root(), candor.StdIO())');
    expect(r.go).toContain('func hello__main(ctx__ *candor.Ctx, io candor.IO) struct{} {');
    expect(r.go).toContain('io.Println(ctx__, "Hello, world")');
  });

  test('calls may span lines inside parentheses', () => {
    const r = compile(`module m\nfn main() uses io {\n  io.println(\n    "x"\n  )\n}\n`, 't');
    expect(r.diagnostics).toEqual([]);
  });
});

describe('effects', () => {
  test('using an effect without declaring it', () => {
    const r = compile(`module m\nfn main() {\n  io.println("x")\n}\n`, 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([
      ['CAN0004', 'add `uses io` to the signature of `fn main`'],
    ]);
  });

  test('calling a function whose effects the caller lacks', () => {
    const src = `module m\nfn greet(name: string) uses io {\n  io.println(name)\n}\nfn main() {\n  greet("Ada")\n}\n`;
    expect(codes(src)).toEqual(['CAN0004']);
  });

  test('effects are passed along to callees', () => {
    const src = `module m\nfn greet(name: string) uses io {\n  io.println(name)\n}\nfn main() uses io {\n  greet("Ada")\n}\n`;
    expect(compile(src, 't').go).toContain('m__greet(ctx__, io, "Ada")');
  });

  test('a declared but unused effect is a warning, not an error', () => {
    const r = compile(`module m\nfn main() uses io {\n}\n`, 't');
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([['CAN0014', 'warning']]);
    expect(r.go).not.toBeNull();
  });

  test('unknown effect', () => {
    expect(codes(`module m\nfn main() uses db {\n}\n`)).toEqual(['CAN0003']);
  });
});

describe('types and names', () => {
  test('argument type mismatch', () => {
    const r = compile(`module m\nfn main() uses io {\n  io.println(42)\n}\n`, 't');
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([['CAN0005', 'expected string, found int']]);
  });

  test('wrong argument count', () => {
    expect(codes(`module m\nfn main() uses io {\n  io.println()\n}\n`)).toEqual(['CAN0006']);
  });

  test('unknown name suggests a fix', () => {
    const r = compile(`module m\nfn main() uses io {\n  let greeting = "hi"\n  io.println(greting)\n}\n`, 't');
    const d = r.diagnostics.find((d) => d.code === 'CAN0002');
    expect(d?.help).toBe('did you mean `greeting`?');
  });

  test('unused let is a warning and still builds', () => {
    const r = compile(`module m\nfn main() uses io {\n  let x = 1\n  io.println("x")\n}\n`, 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0013']);
    expect(r.go).toContain('var x int64 = 1');
    expect(r.go).toContain('_ = x');
  });

  test('function returning a value must end with return', () => {
    expect(codes(`module m\nfn f() -> int {\n  let x = 1\n}\nfn main() {\n}\n`)).toEqual(['CAN0011', 'CAN0013']);
  });

  test('missing main', () => {
    expect(codes(`module m\n`)).toEqual(['CAN0007']);
  });

  test('syntax error', () => {
    expect(codes(`module m\nfn main( {\n}\n`)).toEqual(['CAN0001']);
  });
});

describe('operators', () => {
  const body = (stmts: string) => `module m\nfn main() uses io {\n${stmts}\n}\n`;

  test('precedence, fully parenthesized in Go', () => {
    const r = compile(body('  let x = 1 + 2 * 3 - 4\n  io.println(x.toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('var x int64 = candor.Sub(candor.Add(1, candor.Mul(2, 3)), 4)');
    expect(r.go).toContain('io.Println(ctx__, strconv.FormatInt(x, 10))');
    expect(r.go).toContain('\t"strconv"');
  });

  test('string + int is an error that names the fix', () => {
    const r = compile(body('  io.println("n = " + 1)'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([['CAN0019', 'cannot apply `+` to string and int']]);
    expect(r.diagnostics[0].help).toContain('`.toString()`');
  });

  test('=== is rejected with a fix', () => {
    const r = compile(body('  let b = 1 === 1'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([['CAN0001', 'use `==`']]);
  });

  test('comparisons cannot be chained', () => {
    expect(codes(body('  let b = 1 < 2 < 3'))).toEqual(['CAN0001']);
  });

  test('a comparison of comparisons is fine', () => {
    expect(codes(body('  io.println((1 < 2 == 3 < 4).toString())'))).toEqual([]);
  });

  test('an operator at the end of a line continues the expression', () => {
    expect(codes(body('  let x = 1 +\n    2\n  io.println(x.toString())'))).toEqual([]);
  });

  test('division by a constant zero', () => {
    expect(codes(body('  let x = 7\n  io.println((x / (1 - 1)).toString())'))).toEqual(['CAN0018']);
  });

  test('constant overflow', () => {
    expect(codes(body('  io.println((9223372036854775807 + 1).toString())'))).toEqual(['CAN0017']);
  });

  test('the smallest int literal is allowed', () => {
    expect(codes(body('  io.println((-9223372036854775808).toString())'))).toEqual([]);
  });

  test('methods must be called', () => {
    expect(codes(body('  let f = 1.toString\n  io.println(f())'))).toEqual(['CAN0020']);
  });

  test('! and && need bools, reported once', () => {
    expect(codes(body('  let b = !1 && true\n  io.println(b.toString())'))).toEqual(['CAN0019']);
  });
});

describe('if', () => {
  const body = (stmts: string) => `module m\nfn main() uses io {\n${stmts}\n}\n`;
  const fns = (src: string) => `module m\n${src}\nfn main() {\n}\n`;

  test('as a value, lowered to a temporary', () => {
    const r = compile(fns('fn f(c: bool) -> int {\n  return if c { 1 } else { 2 }\n}'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('var t__1 int64\n\tif c {\n\t\tt__1 = 1\n\t} else {\n\t\tt__1 = 2\n\t}\n\treturn t__1');
  });

  test('as a statement, else is optional', () => {
    expect(codes(body('  if 1 < 2 {\n    io.println("yes")\n  }'))).toEqual([]);
  });

  test('else may start the next line', () => {
    expect(codes(body('  if 1 < 2 {\n    io.println("a")\n  }\n  else {\n    io.println("b")\n  }'))).toEqual([]);
  });

  test('the condition must be bool', () => {
    const r = compile(body('  if 1 {\n    io.println("x")\n  }'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([
      ['CAN0021', 'there is no truthiness; compare explicitly, as in `n != 0`'],
    ]);
  });

  test('as a value, else is required', () => {
    expect(codes(body('  let x = if true { 1 }\n  io.println(x.toString())'))).toEqual(['CAN0022']);
  });

  test('branches must agree', () => {
    expect(codes(body('  let x = if true { 1 } else { "one" }\n  io.println(x)'))).toEqual(['CAN0023']);
  });

  test('a function returns through every branch', () => {
    expect(codes(fns('fn f(c: bool) -> int {\n  if c {\n    return 1\n  } else {\n    return 2\n  }\n}'))).toEqual([]);
  });

  test('a missing branch return is caught', () => {
    expect(codes(fns('fn f(c: bool) -> int {\n  if c {\n    return 1\n  }\n}'))).toEqual(['CAN0011']);
  });

  test('a trailing expression in a function suggests return', () => {
    const r = compile(fns('fn f() -> int {\n  1\n}'), 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0011']);
    expect(r.diagnostics[0].help).toStartWith('add `return`');
  });

  test('a let inside a branch is not visible after it', () => {
    const src = body('  if true {\n    let y = 1\n    io.println(y.toString())\n  }\n  io.println(y.toString())');
    expect(codes(src)).toEqual(['CAN0002']);
  });

  test('no shadowing', () => {
    const src = body('  let x = 1\n  if true {\n    let x = 2\n    io.println(x.toString())\n  }\n  io.println(x.toString())');
    expect(codes(src)).toEqual(['CAN0016']);
  });

  test('assigning something with no value', () => {
    const r = compile(body('  let x = io.println("a")'), 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0024']);
  });

  test('left-to-right evaluation survives lowering', () => {
    const src = `module m\nfn f() -> int {\n  return 1\n}\nfn main() uses io {\n  io.println((f() + if true { 2 } else { 3 }).toString())\n}\n`;
    const go = compile(src, 't').go!;
    expect(go.indexOf('var t__2 int64 = m__f(ctx__)')).toBeGreaterThan(-1);
    expect(go.indexOf('var t__2 int64 = m__f(ctx__)')).toBeLessThan(go.indexOf('var t__1 int64\n'));
  });

  test('a match ending a function suggests return', () => {
    const src = fns('enum E {\n  A\n  B\n}\nfn f(e: E) -> int {\n  match e {\n    E.A => 1\n    E.B => 2\n  }\n}');
    const r = compile(src, 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0011']);
    expect(r.diagnostics[0].help).toStartWith('add `return`');
  });

  test('names with __ are reserved', () => {
    expect(codes(body('  let a__b = 1'))).toEqual(['CAN0001']);
  });

  test('digit separators: `_` between two digits, gone after lexing', () => {
    // One past the range: the separators are gone before the check, and the message shows digits.
    const r = compile(body('  io.println(9_223_372_036_854_775_808.toString())'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['CAN0017', '9223372036854775808 does not fit in int (64-bit)'],
    ]);
    expect(compile(body('  let n = 60_000 + 1_0_0\n  io.println(n.toString())'), 't').go).toContain('var n int64 = candor.Add(60000, 100)');
    for (const bad of ['1000_', '1__000', '60_000_']) {
      expect(compile(body(`  let n = ${bad}`), 't').diagnostics.map((d) => [d.code, d.message])).toEqual([
        ['CAN0001', `\`${bad}\`: a digit separator goes between two digits, as in \`60_000\``],
      ]);
    }
    // A leading underscore makes a name, as it always did.
    expect(codes(body('  let n = _1000'))).toContain('CAN0002');
  });
});
