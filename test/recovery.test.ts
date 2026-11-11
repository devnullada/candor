import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { lex } from '../src/lexer';

const found = (src: string, files: Record<string, string> = {}) =>
  compile(src, 't', 'main', { read: (f) => files[f] ?? null }).diagnostics.map((d) => `${d.span.start.line}:${d.span.start.col} ${d.code} ${d.message}`);

describe('syntax errors do not stop the check', () => {
  test('one error per bad statement, and the function goes on', () => {
    const src = 'module m\nfn main() uses io {\n  let a = 1 1\n  let b = 2 2\n  io.println("${b}")\n  let c: string = 3\n}\n';
    // `b` was dropped with its line: unknown, not missing. The type error after it is reported.
    expect(found(src)).toEqual([
      '3:13 CAN0001 expected end of line, found the number 1',
      '4:13 CAN0001 expected end of line, found the number 2',
      '6:19 CAN0005 expected string, found int',
    ]);
  });

  test('an unclosed `(` takes the rest of its block, which is one error', () => {
    // Newlines inside `( )` don't end statements, so the next one is in the `(` too.
    const src = 'module m\nfn main() uses io {\n  let a = (1 +\n  let b = 2 2\n}\nfn g() -> int {\n  return "s"\n}\n';
    expect(found(src)).toEqual(['4:3 CAN0001 expected an expression, found `let`', '7:10 CAN0005 expected int, found string']);
  });

  test('a syntax error in one function, a type error in another: both', () => {
    const src = 'module m\nfn f() -> int {\n  return 1 +\n}\nfn g() -> int {\n  let s: string = 1\n  return 2\n}\nfn main() {}\n';
    expect(found(src)).toEqual(['4:1 CAN0001 expected an expression, found `}`', '6:19 CAN0005 expected string, found int']);
  });

  test('a type error beside a syntax error in one function: both', () => {
    const src = 'module m\nfn f() -> int {\n  let s: string = 1\n  return 1 1\n}\nfn main() {}\n';
    expect(found(src)).toEqual(['4:12 CAN0001 expected end of line, found the number 1', '3:19 CAN0005 expected string, found int']);
  });

  test('what only follows from a dropped statement is left out', () => {
    // A dropped `if` takes its narrowing, a dropped `return` the function's; `n` is never used.
    const src = `module m
fn f(x: string?) -> int {
  let n = 1
  if x == none) {
    return 0
  }
  let k = x.length() + nope
  return k
}
fn g(xs: List<int>) -> int {
  let total = xs.map((x) => x * 2
  return total.length() + "s"
}
fn main() {}
`;
    expect(found(src)).toEqual([
      '4:15 CAN0001 expected `{`, found `)`',
      '11:34 CAN0001 expected `)`, found end of line',
      '7:24 CAN0002 cannot find `nope`',
    ]);
  });

  test('an error inside a nested block is reported once, by the block that recovered', () => {
    const src = 'module m\nstruct P {\n  x: int\n}\nfn main() uses io {\n  if P { x: 1 }.x == 1 {\n    io.println("x")\n  }\n}\n';
    expect(found(src)).toEqual(['6:11 CAN0001 expected end of line, found `:`']);
  });

  test('a missing `}` is one error, and the next functions are still checked', () => {
    const src = 'module m\nfn f() -> int {\n  if true {\n    return 1\n  return 2\n}\n\nfn main() {\n  let n: int = "s"\n}\n';
    expect(found(src)).toEqual([
      '2:15 CAN0001 this `{` is never closed',
      '9:16 CAN0005 expected int, found string',
    ]);
    expect(compile(src, 't').diagnostics[0].help).toBe('a `}` is missing in this block, or in one inside it, before line 8');
    const atEnd = compile('module m\nfn main() {\n  if true {\n', 't').diagnostics;
    expect(atEnd.map((d) => [d.message, d.help])).toEqual([['this `{` is never closed', 'a `}` is missing in this block, or in one inside it, before the end of the file']]);
  });

  test('a broken item drops the item, not its declaration', () => {
    // From the trials: a variant written like Rust's, and an arm matching it.
    const src = `module m
struct Booking {
  id int
  room: int
  start: string
}
enum Outcome {
  Made(Booking)
  Taken { by: int }
}
fn show(o: Outcome) -> int {
  return match o {
    Outcome.Made(b) => b.id,
    Outcome.Taken { by } => by + "s",
  }
}
fn main() {
  let b = Booking { id: 1, room: 2, start: 3 }
}
`;
    expect(found(src)).toEqual([
      '3:6 CAN0001 expected `:`, found `int`',
      '8:7 CAN0001 expected `,` or end of line, found `(`',
      '13:17 CAN0001 expected `=>`, found `(`',
      '14:32 CAN0019 cannot apply `+` to int and string',
      '18:7 CAN0013 `b` is never used',
      '18:44 CAN0005 expected string, found int',
    ]);
  });

  test('members, extern items and arms each recover', () => {
    const src = `module m
extern "strings" {
  fn ToUpper(s: string -> string as upper
  fn ToLower(s: string) -> string as lower
  fn Repeat(s: string, n: int) -> string as
}
trait Named {
  fn name(self) -> string
  fn bad(self -> int
}
fn main() uses io {
  io.println(lower("A") + 1)
  let n = match 2 {
    1 = "one",
    2 => 2,
    _ => "many",
  }
}
`;
    expect(found(src)).toEqual([
      '3:24 CAN0001 expected `)`, found `->`',
      '5:44 CAN0001 expected a name, found end of line',
      '9:15 CAN0001 expected a name, found `->`',
      '14:7 CAN0001 expected `=>`, found `=`',
      '12:25 CAN0019 cannot apply `+` to string and int',
    ]);
  });

  test('a `(` left open ends at a line that starts no further in', () => {
    const src = 'module m\nfn main() uses io {\n  let a = max(1, 2\n  io.println(a)\n  let s: string = 1\n}\nfn max(a: int, b: int) -> int {\n  return a\n}\n';
    expect(found(src)).toEqual(['3:19 CAN0001 expected `)`, found end of line', '5:19 CAN0005 expected string, found int']);
    // A list whose items start where it does is still one.
    expect(found('module m\nfn main() uses io {\n  let xs = [\n  1,\n  2,\n  ]\n  io.println("${xs}")\n}\n')).toEqual([]);
  });

  test('a stray `}` at module level', () => {
    const src = 'module m\nfn f() {\n}\n}\nfn main() {\n  let n: int = "s"\n}\n';
    expect(found(src)).toEqual(['4:1 CAN0001 expected a declaration, found `}`', '6:16 CAN0005 expected int, found string']);
  });

  test('names from a dropped declaration are unknown, not missing', () => {
    const src = 'module m\nstruct P {\n  x int\n}\nfn f( -> int {\n  return 1\n}\nfn main() uses io {\n  let p = P { x: 1 }\n  io.println("${f() + p.x}")\n  io.println(nope)\n}\n';
    expect(found(src)).toEqual(['3:5 CAN0001 expected `:`, found `int`', '5:7 CAN0001 expected a name, found `->`', '11:14 CAN0002 cannot find `nope`']);
    // A dropped `main` is not a missing one.
    expect(found('module m\nfn main( {\n}\n')).toEqual(['2:10 CAN0001 expected a name, found `{`']);
  });

  test('names dropped in an imported module', () => {
    const files = { 'lib.candor': 'module lib\nfn twice(n: int -> int {\n  return n * 2\n}\nfn ok() -> int {\n  return "s"\n}\n' };
    const src = 'module m\nimport "lib"\nfn main() uses io {\n  io.println("${lib.twice(2)}")\n}\n';
    expect(found(src, files)).toEqual(['2:17 CAN0001 expected `)`, found `->`', '6:10 CAN0005 expected int, found string']);
  });

  test('nothing is emitted', () => {
    const r = compile('module m\nfn main() uses io {\n  io.println("a" "b")\n}\n', 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0001']);
    expect(r.go).toBeNull();
  });

  test('without a `module` line nothing else is read', () => {
    expect(found('modul m\nfn main() {\n  1 1\n}\n')).toEqual(['1:1 CAN0001 expected `module`, found `modul`']);
  });
});

describe('the lexer carries on', () => {
  test('each error is reported, in the order of the file with the parser\'s', () => {
    const src = 'module m\nfn main() uses io {\n  let a = 1 @@@ 2\n  let b = "a\\qb"\n  let c = "open\n  let d = 1_\n  let e__x = 2\n  let f = 3 3\n}\n';
    expect(found(src)).toEqual([
      '3:13 CAN0001 unexpected characters "@@@"',
      '4:13 CAN0001 unknown escape sequence `\\q`',
      '5:11 CAN0001 unterminated string literal',
      '6:11 CAN0001 `1_`: a digit separator goes between two digits, as in `60_000`',
      '7:7 CAN0001 `e__x`: names cannot contain `__`, it is reserved for generated code',
      '8:13 CAN0001 expected end of line, found the number 3',
    ]);
  });

  test('what it keeps', () => {
    const diagnostics: never[] = [];
    const toks = lex('"a\\qb" "open\n1_ x__y "${}" "${1', 't', diagnostics);
    expect(toks.map((t) => [t.kind, t.text])).toEqual([
      ['string', 'ab'],
      ['string', 'open'],
      ['newline', '\n'],
      ['int', '1'],
      ['ident', 'x__y'],
      ['string', ''],
      ['string', ''],
      ['newline', '\n'],
      ['eof', ''],
    ]);
    expect(diagnostics).toHaveLength(6);
  });

  test('without a list to report to, it throws them all at the end', () => {
    expect(() => lex('@ "a', 't')).toThrow('unexpected character "@"\nunterminated string literal');
  });
});
