import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit } from './split';

// A user-declared effect, with its Go binding and its fake.
const kv = `module kv
effect kv {
  extern "./native" {
    fn Get(ctx, key: string) -> Result<string, GoError> as goGet
  }
  pub fn get(key: string) -> string? {
    return match goGet(key) {
      Ok(v) => v,
      Err(_) => none,
    }
  }
}
fake kv {
  let mut values: List<string> = []
  fn get(key: string) -> string? {
    return values.first()
  }
  fn put(v: string) {
    values.push(v)
  }
}
`;

const program = (main: string, files: Record<string, string> = { 'kv.candor': kv }, mode: 'main' | 'test' = 'main') =>
  compileSplit(main, 'main.candor', mode, { read: (f) => files[f] ?? null });
const diags = (main: string, files?: Record<string, string>) => program(main, files).diagnostics.map((d) => [d.code, d.message]);
const codes = (main: string, files?: Record<string, string>) => program(main, files).diagnostics.map((d) => d.code);
const uses = (body: string, effects = 'io, kv') => `module m\nimport "kv"\nfn main() uses ${effects} {\n${body}\n}\n`;
/** `kv` with `old` replaced, as the only file there is. */
const kvWith = (old: string, replacement: string) => {
  if (!kv.includes(old)) throw new Error(`not in kv: ${old}`);
  return { 'kv.candor': kv.replace(old, replacement) };
};

describe('user effects', () => {
  test('declared by a module, used by its name', () => {
    const r = program(uses('  io.println(kv.get("a") ?? "none")'));
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('type fx__kv interface {\n\tGet(ctx__ *candor.Ctx, key string) opt__[string]\n}');
    expect(r.go).toContain('m__main(candor.Root(), candor.StdIO(), fx__kv__real{})');
    expect(r.go).toContain('func (fx__kv__real) Get(ctx__ *candor.Ctx, key string) opt__[string] {\n\tctx__.Op()');
    // The fake only exists in tests.
    expect(r.go).not.toContain('fx__kv__fake');
    // The context reaches Go, and the task stops as soon as Go returns.
    expect(r.bindings).toContain('r := kv__goGet__go(go__1.Get, ctx__.Context(), a0)');
    expect(r.bindings).toContain('ctx__.Check()\n\treturn r');
  });

  test('an operation needs `uses`', () => {
    expect(program(uses('  io.println(kv.get("a") ?? "none")', 'io')).diagnostics.map((d) => [d.code, d.help])).toEqual([
      ['CAN0004', 'add `kv` to the `uses` clause of `fn main`'],
    ]);
  });

  test('the effect passes through functions that use it', () => {
    const r = program('module m\nimport "kv"\nfn lookup(k: string) -> string uses kv {\n  return kv.get(k) ?? ""\n}\nfn main() uses io, kv {\n  io.println(lookup("a"))\n}\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('func m__lookup(ctx__ *candor.Ctx, kv fx__kv, k string) string {');
    expect(r.go).toContain('m__lookup(ctx__, kv, "a")');
  });

  test("an effect's externs are its operations' alone", () => {
    expect(codes(uses('  io.println("x")', 'io'), kvWith('fake kv {', 'fn leak() {\n  let r = goGet("a")\n}\nfake kv {'))).toContain('CAN0043');
    expect(diags('module m\nimport "kv"\nfn main() {\n  let r = kv.goGet("a")\n}\n')).toContainEqual(['CAN0043', '`goGet` is bound inside `effect kv`, so only its operations can call it']);
  });

  test('only an effect binding gets a context', () => {
    const files = { 'kv.candor': 'module kv\npub extern "./native" {\n  fn Get(ctx, key: string) -> string as get\n}\n' };
    expect(diags(uses('  io.println(kv.get("a"))', 'io'), files)).toEqual([['CAN0042', "only an effect's bindings get a context"]]);
  });

  test('one effect per module, named after it, with a fake', () => {
    expect(codes(uses('  io.println("x")', 'io'), kvWith('effect kv {', 'effect store {'))).toEqual(['CAN0043', 'CAN0043']);
    const noFake = { 'kv.candor': kv.slice(0, kv.indexOf('fake kv')) };
    expect(diags(uses('  io.println("x")', 'io'), noFake)).toEqual([['CAN0043', 'effect `kv` has no fake']]);
    expect(codes(uses('  io.println("x")', 'io'), { 'kv.candor': `${kv}effect kv {\n}\n` })).toEqual(['CAN0043']);
    expect(codes(uses('  io.println("x")', 'io'), { 'kv.candor': `${kv}fake kv {\n}\n` })).toEqual(['CAN0043']);
  });

  test('a fake stands in for every operation, with its signature', () => {
    expect(diags(uses('  io.println("x")', 'io'), kvWith('  fn get(key: string) -> string? {\n    return values', '  fn fetch(key: string) -> string? {\n    return values'))).toEqual([
      ['CAN0043', 'the fake `kv` has no `get`'],
    ]);
    expect(diags(uses('  io.println("x")', 'io'), kvWith('fn get(key: string) -> string? {\n    return values.first()', 'fn get(key: int) -> string? {\n    return values.first()'))).toEqual([
      ['CAN0005', "the fake's `get` must have the operation's signature: expected fn(string) -> string?, found fn(int) -> string?"],
    ]);
  });

  test('operations cannot use other effects', () => {
    expect(diags(uses('  io.println("x")', 'io'), kvWith('  pub fn get(key: string) -> string? {', '  pub fn get(key: string) -> string? uses io {'))).toContainEqual([
      'CAN0043',
      "an effect's operations cannot use other effects (its fake's functions can)",
    ]);
  });

  test('operations share a namespace with the module', () => {
    expect(codes(uses('  io.println("x")', 'io'), { 'kv.candor': `${kv}fn get() {\n}\n` })).toContain('CAN0016');
  });

  test("the fake's own methods are for tests", () => {
    expect(codes(uses('  kv.put("a")', 'kv'))).toEqual(['CAN0035']);
    const t = program('module m\nimport "kv"\ntest "put" {\n  kv.put("a")\n  assert kv.get("x") == "a"\n}\n', undefined, 'test');
    expect(t.diagnostics).toEqual([]);
    expect(t.go).toContain('kv := fx__kv__newFake(ctx__)');
    // State is worked on in place: a function of the fake may wait while other tasks call it.
    expect(t.go).toContain('f__.values = append(f__.values, v)');
  });

  test("the fake's state", () => {
    expect(diags(uses('  io.println("x")', 'io'), kvWith('  fn put(v: string) {\n    values.push(v)\n  }\n', ''))).toEqual([
      ['CAN0039', '`values` never changes'],
    ]);
    expect(diags(uses('  io.println("x")', 'io'), kvWith('  let mut values', '  let seen = 0\n  let mut values'))).toEqual([['CAN0013', '`seen` is never used']]);
    // A lambda can't hold on to state that changes.
    const capture = kvWith('    return values.first()', '    let f = () => values.length()\n    return values.first()');
    expect(codes(uses('  io.println("x")', 'io'), capture)).toEqual(['CAN0013', 'CAN0037']);
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

describe('cancellation', () => {
  test(
    "a Go call that takes a context is cancelled with its task",
    () => {
      const fixture = path.join(import.meta.dir, 'fixtures', 'cancel');
      const out = path.join(tmpdir(), 'candor-test', 'cancel');
      const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', path.join(fixture, 'main.candor'), '--out', out], {
        encoding: 'utf8',
        env: { ...process.env, CANDOR_GO: go },
      });
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('Go saw the cancellation: context canceled\ntimed out\nwell under 10 s: true\n');
    },
    60_000,
  );
});
