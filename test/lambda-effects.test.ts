import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

// A lambda's effects are what its body does; where a function type doesn't allow
// them, the help names `uses f` when the type is a user function's parameter.

const errors = (src: string) =>
  compile(src, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

const LAMBDA_USES =
  'remove `uses ...`: a lambda uses what its body does, and the function around it must allow that. A function type writes them (`fn(string) -> string? uses sql`), and a function taking one can say `uses f` to take on whatever `f` does';

describe('effects written on a lambda', () => {
  test('after a result type, or with none, is its own error', () => {
    expect(errors('module m\nfn main() uses io {\n  let f = (id: string): string? uses io => none\n  let g = (x: int) uses io, clock => x\n}\n')).toEqual([
      [Codes.SyntaxError, 'a lambda does not write its effects', LAMBDA_USES],
      [Codes.SyntaxError, 'a lambda does not write its effects', LAMBDA_USES],
    ]);
  });

  test('a function type as the result keeps its own `uses`', () => {
    expect(errors('module m\nfn main() uses io {\n  let f = (n: int): fn() uses io => () => io.println("${n}")\n  f(1)()\n}\n')).toEqual([]);
  });
});

describe("a function with effects its parameter's type doesn't allow", () => {
  const key = 'fn key(id: string, lookup: fn(string) -> string?) -> string {\n  return lookup(id) ?? id\n}\n';
  const lambda = '(s) => {\n    io.println(s)\n    return none\n  }';

  test('the help offers `uses` on the function', () => {
    expect(errors(`module m\n${key}fn main() uses io {\n  io.println(key("a", ${lambda}))\n}\n`)).toEqual([
      [
        Codes.TypeMismatch,
        'this function uses `io`, which `fn(string) -> string?` does not allow',
        'allow it in the type: `lookup: fn(string) -> string? uses io`, or put `uses lookup` on `key`: it then takes on what each function passed does, and only its callers declare that',
      ],
    ]);
  });

  test('which then checks, and a pure caller stays pure', () => {
    const withUses = key.replace('-> string {', '-> string uses lookup {');
    expect(errors(`module m\n${withUses}fn pure() -> string {\n  return key("a", (s) => none)\n}\nfn main() uses io {\n  io.println(key("a", ${lambda}))\n}\n`)).toEqual([]);
  });
});
