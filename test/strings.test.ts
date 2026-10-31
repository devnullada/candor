import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);

describe('strings', () => {
  test('every method, with its type', () => {
    const body = [
      '  let s = "héllo"',
      '  let n: int = s.length() + s.byteLength()',
      '  let b: bool = s.isEmpty() || s.contains("l") || s.startsWith("h") || s.endsWith("o")',
      '  let cs: List<string> = s.chars().map((c) => c.toString()).concat(s.split("l")).concat(s.lines())',
      '  let p: string = s.padStart(8, "-") + s.padEnd(8, "-")',
      '  let i: int? = s.indexOf("llo")',
      '  let t: string = s.slice(1, 3) + s.trim() + s.toUpperCase() + s.toLowerCase() + s.replaceAll("l", "L") + s.repeat(2)',
      '  let v: int = s.toInt() ?? 0',
      '  io.println(n.toString() + b.toString() + cs.join("") + (i ?? 0).toString() + t + v.toString() + p)',
    ].join('\n');
    const r = compile(mod(body), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('int64(utf8.RuneCountInString(s))');
    expect(r.go).toContain('optOf__(candor.IndexOf(s, "llo"))');
    expect(r.go).toContain('optOf__(candor.ParseInt(s))');
    expect(r.go).toContain('candor.Slice(s, 1, 3)');
  });

  test('methods are called; habits from other languages get the Candor name', () => {
    expect(diags(mod('  let n = "a".length\n  io.println("x")'))[0]).toEqual([Codes.MethodNotCalled, 'write `.length()`']);
    expect(diags(mod('  io.println("a".toUpper())'))).toEqual([[Codes.NoSuchMember, 'use `toUpperCase()`']]);
    expect(diags(mod('  io.println("a".replace("a", "b"))'))).toEqual([
      [Codes.NoSuchMember, 'use `replaceAll(old, new)`: it replaces every occurrence, and says so'],
    ]);
    expect(diags(mod('  io.println("a".substring(0, 1))'))).toEqual([
      [Codes.NoSuchMember, 'use `slice(start, end)`, or `slice(start)` to the end: code point indexes, `end` excluded, both clamped to the string'],
    ]);
    expect(diags(mod('  io.println("a".includes("a").toString())'))[0]).toEqual([Codes.NoSuchMember, 'use `contains`']);
    expect(diags(mod('  io.println("a".frobnicate())'))[0]).toEqual([
      Codes.NoSuchMember,
      'available: length, byteLength, isEmpty, chars, contains, startsWith, endsWith, indexOf, lastIndexOf, slice, split, trim, trimStart, trimEnd, trimChars, removePrefix, removeSuffix, toUpperCase, toLowerCase, replaceAll, repeat, toInt, toFloat, lines, padStart, padEnd, toBytes, quoted',
    ]);
  });

  test('arguments are checked like any call', () => {
    expect(codes(mod('  io.println("a".slice(1, 2, 3))'))).toEqual([Codes.ArgCount]);
    expect(codes(mod('  io.println("a".repeat("x"))'))).toEqual([Codes.TypeMismatch]);
    // indexOf and toInt are optionals: there is no -1 and no NaN.
    expect(codes(mod('  let i: int = "a".indexOf("a")\n  io.println(i.toString())'))).toEqual([Codes.TypeMismatch]);
    expect(codes(mod('  let n: int = "4".toInt()\n  io.println(n.toString())'))).toEqual([Codes.TypeMismatch]);
  });

  test('a trait cannot give string a method it has', () => {
    const src = 'module m\ntrait Sized {\n  fn length(self) -> int\n}\nimpl Sized for string {\n  fn length(self) -> int {\n    return 0\n  }\n}\nfn main() {}\n';
    expect(diags(src)).toEqual([[Codes.BadImpl, 'rename the method in `trait Sized`']]);
  });
});
