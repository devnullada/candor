import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

// An effect's helpers: `fn` without `pub` inside `effect`, called by its operations only.

const errors = (src: string, mode: 'main' | 'test' = 'main') =>
  compile(src, 't.candor', mode)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

// `body` goes into the effect, `fake` into the fake, `rest` after it.
const kv = (body: string, fake = '', rest = '') => `module kv
effect kv {
  extern "strconv" {
    fn Itoa(i: int) -> string as itoa
  }
  extern "strings" {
    type *Builder
    fn (b: Builder) WriteString(s: string) -> Result<int, GoError> as write
    fn (b: Builder) String() -> string as built
  }
  let mut count = 0
${body}}
fake kv {
  fn next() -> string {
    return "1"
  }
${fake}}
${rest}fn main() uses io, kv {
  io.println(kv.next())
}
`;

const counting = `  fn label(n: int) -> string {
    return "#" + itoa(n)
  }
  pub fn next() -> string {
    count = count + 1
    return label(count)
  }
`;

describe('a helper', () => {
  test('is called by the operations, and is a plain Go function', () => {
    const r = compile(kv(counting), 't.candor');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toMatch(/func \w*label\(ctx__ \*candor\.Ctx, n int64\) string \{/);
    expect(r.go).toMatch(/return \w*label\(ctx__, count\)/);
  });

  test('may take and give Go types, and call other helpers', () => {
    const body = `  fn put(b: Builder, s: string) -> Builder {
    write(b, s)
    return b
  }
  fn twice(b: Builder, s: string) -> Builder {
    return put(put(b, s), s)
  }
${counting}`;
    expect(errors(kv(body))).toEqual([]);
  });

  test("doesn't see the state: the operation passes it in", () => {
    const body = `  fn label() -> string {
    return itoa(count)
  }
  pub fn next() -> string {
    count = count + 1
    return label()
  }
`;
    expect(errors(kv(body))).toEqual([
      [Codes.UnknownName, "`count` is the state of `effect kv`, which its helpers don't see", 'take it as a parameter, and have the operation pass it in: `label(count, ...)`; if `label` is meant to be an operation, write `pub fn label`'],
    ]);
  });

  test('is not for the rest of the module, the fake or other modules', () => {
    const help = 'an operation is `pub fn`: make `label` one, or call an operation that uses it';
    const message = '`label` is a helper inside `effect kv`, so only its operations can call it';
    expect(errors(kv(counting, '', 'fn f() -> string {\n  return label(1)\n}\n'))).toEqual([[Codes.BadEffect, message, help]]);
    expect(errors(kv(counting, '  fn shown() -> string {\n    return label(2)\n  }\n'), 'test')).toEqual([[Codes.BadEffect, message, help]]);
    const main = 'module m\nimport "kv"\nfn main() {\n  let s = kv.label(1)\n}\n';
    const r = compile(main, 'm.candor', 'main', { read: (f) => (f === 'kv.candor' ? kv(counting).replace(/fn main[^]*$/, '') : null) });
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help])).toEqual([[Codes.BadEffect, message, help]]);
  });

  test('uses no other effect', () => {
    const body = counting.replace('fn label(n: int) -> string {', 'fn label(n: int) -> string uses io {');
    expect(errors(kv(body)).map((e) => e[1])).toContain("an effect's helpers cannot use other effects");
  });

  test('has nothing for the fake to stand in for', () => {
    expect(errors(kv(counting, '  fn label(n: int) -> string {\n    return ""\n  }\n'))).toEqual([
      [
        Codes.BadEffect,
        '`label` is a helper of `effect kv`, not an operation, so the fake has nothing to stand in for',
        'make it an operation with `pub fn label` in the effect, or rename this test-only function',
      ],
    ]);
  });
});

test('an operation written without `pub` says what it has become', () => {
  const old = kv('  fn next() -> string {\n    count = count + 1\n    return itoa(count)\n  }\n');
  expect(errors(old).map((e) => e[1])).toEqual([
    "`count` is the state of `effect kv`, which its helpers don't see",
    '`next` is a helper of `effect kv`, not an operation, so the fake has nothing to stand in for',
    '`next` is a helper inside `effect kv`, so only its operations can call it',
  ]);
});
