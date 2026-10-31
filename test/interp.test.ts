import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';
import { lex } from '../src/lexer';

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const messages = (src: string) => compile(src, 't').diagnostics.map((d) => d.message);

describe('string interpolation', () => {
  test('strings, ints and bools, concatenated in Go', () => {
    const r = compile(mod('  let n = 3\n  let name = "Ada"\n  io.println("${name} has ${n} and ${n > 2}")'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('(name + " has " + strconv.FormatInt(n, 10) + " and " + strconv.FormatBool((n > 2)))');
  });

  test('a string without `${` stays a plain literal; `\\$` and a lone `$` are text', () => {
    expect(lex('"a $ b"', 't')[0]).toMatchObject({ kind: 'string', text: 'a $ b' });
    expect(lex('"\\${n}"', 't')[0]).toMatchObject({ kind: 'string', text: '${n}' });
    const t = lex('"a${n}$"', 't')[0];
    expect(t.kind).toBe('template');
    expect(t.parts!.map((p) => (typeof p === 'string' ? p : p.map((x) => x.kind)))).toEqual(['a', ['ident', 'eof'], '$']);
  });

  test('any expression inside, nested strings and struct literals too', () => {
    const extra = 'struct P {\n  name: string\n}\n';
    const r = compile(mod('  let e: string? = none\n  io.println("${e ?? "none"} ${"in ${1 + 2}"} ${P { name: "x" }.name}")', extra), 't');
    expect(r.diagnostics).toEqual([]);
  });

  test('a narrowed optional reads as its value', () => {
    const r = compile(mod('  let e: string? = none\n  if e != none {\n    io.println("mail ${e}")\n  }'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('("mail " + e.value)');
  });

  test('parts run left to right, even when a later one needs statements first', () => {
    const extra = 'fn f() -> string {\n  return "f"\n}\nfn g() -> Result<int, string> {\n  return Ok(1)\n}\nfn h() -> Result<string, string> {\n  return Ok("${f()} ${g()?}")\n}\n';
    const r = compile(mod('  io.println((h() == Ok("f 1")).toString())', extra), 't');
    expect(r.diagnostics).toEqual([]);
    // `f()` is held in a temporary before `g()?` returns early or not.
    expect(r.go).toMatch(/var (\w+) string = m__f\(ctx__\)[\s\S]*m__g\(ctx__\)[\s\S]*\(\1 \+ " " \+ strconv\.FormatInt/);
  });

  test('other types are refused, with a fix that fits', () => {
    const extra = 'struct U {\n  name: string\n}\nenum C {\n  Red\n}\n';
    const body = '  let u = U { name: "a" }\n  let o: U? = none\n  let xs = [1]\n  io.println("${u}${o}${xs}${C.Red}${main}")';
    expect(diags(mod(body, extra))).toEqual([
      [Codes.TypeMismatch, 'derive it: `impl Show for U`, or write it: `impl Show for U { fn toString(self) -> string { ... } }`, or interpolate its fields, like `${u.name}`'],
      [Codes.TypeMismatch, 'derive it: `impl Show for U`, or write it: `impl Show for U { fn toString(self) -> string { ... } }`'],
      [Codes.TypeMismatch, 'derive it: `impl Show for C`, or write it: `impl Show for C { fn toString(self) -> string { ... } }`, or turn it into a string with a `match` first'],
      [Codes.TypeMismatch, '`${ }` shows a type with `Show` (string, int, bool, lists, maps, optionals and Results of those, and types with `impl Show`), found fn() uses io'],
    ]);
  });

  test('`+` with an int points to interpolation', () => {
    expect(diags(mod('  let n = 1\n  io.println("n: " + n)'))).toEqual([
      [Codes.InvalidOperands, '`+` never converts implicitly; interpolate the int, as in `"...${n}"`, or call `.toString()` on it'],
    ]);
  });

  test('syntax errors', () => {
    expect(messages(mod('  io.println("a ${}")'))).toEqual(['`${}` is empty: put the value to show between the braces']);
    expect(messages(mod('  io.println("a ${1 2}")'))).toEqual(['expected `}` to close `${`, found the number 2']);
    expect(messages(mod('  io.println("a ${1)'))).toEqual(['`${` is not closed on its line: a string, and what it interpolates, stays on one line']);
    expect(messages('module m\nfn main() {\n  let s = "${1')).toEqual(['this `{` is never closed', '`${` is not closed before the end of the file']);
    expect(messages('module m\nfn main() {}\ntest "n ${1}" {\n  assert true\n}\n')).toEqual(['`test` takes a fixed string, so it cannot interpolate']);
    const pattern = 'module m\nfn f(s: string) -> int {\n  return match s {\n    "a${s}" => 1\n    _ => 2\n  }\n}\nfn main() {}\n';
    expect(messages(pattern)).toEqual(['a pattern matches a fixed string, so it cannot interpolate']);
  });
});
