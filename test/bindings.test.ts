import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

const strconv = `module strconv
pub extern "strconv" {
  fn Atoi(s: string) -> Result<int, GoError> as atoi
  fn FormatInt(i: int, base: int) -> string as formatInt
  let ErrRange: GoError as errRange
}
`;

/** Compiles `main` with the given files to import, by path. */
const program = (main: string, files: Record<string, string> = { 'lib/strconv.candor': strconv }, mode: 'main' | 'test' = 'main') =>
  compileSplit(main, 'main.candor', mode, { read: (f) => files[f] ?? null });
const diags = (main: string, files?: Record<string, string>) => program(main, files).diagnostics.map((d) => [d.code, d.help ?? d.message]);
const codes = (main: string, files?: Record<string, string>) => program(main, files).diagnostics.map((d) => d.code);
const mod = (body: string, imports = 'import "lib/strconv"\n') => `module m\n${imports}fn main() uses io {\n${body}\n}\n`;

describe('imports', () => {
  test("another file's declarations, by its module's name", () => {
    const r = program(mod('  match strconv.atoi("12") {\n    Ok(n) => io.println(strconv.formatInt(n, 2)),\n    Err(e) => io.println(e.message()),\n  }'));
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('strconv__atoi(ctx__, "12")');
    expect(r.go).toContain('strconv__formatInt(ctx__, n, 2)');
  });

  test('functions, types and effects of a Candor module', () => {
    const geo = 'module geo\npub struct Point {\n  pub x: int\n  pub y: int\n}\npub fn origin() -> Point {\n  return Point { x: 0, y: 0 }\n}\npub fn show(p: Point) uses io {\n  io.println(p.x.toString())\n}\n';
    const files = { 'geo.candor': geo };
    const r = program('module m\nimport "geo"\nfn main() uses io {\n  let p = geo.origin()\n  geo.show(p)\n  let f = geo.show\n  f(p)\n}\n', files);
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('type geo__Point struct {');
    expect(r.go).toContain('geo__show(ctx__, io, p)');
    // Calling it needs its effects.
    expect(diags('module m\nimport "geo"\nfn main() {\n  geo.show(geo.origin())\n}\n', files)).toEqual([['CAN0004', 'add `uses io` to the signature of `fn main`']]);
  });

  test('names a module does not have', () => {
    expect(diags(mod('  io.println(strconv.formatint(1, 2))'))).toEqual([['CAN0008', 'did you mean `formatInt`?']]);
  });

  test('a module is not a value, and its name is taken', () => {
    expect(diags(mod('  let s = strconv')).find(([c]) => c === 'CAN0025')).toEqual(['CAN0025', 'name one of its declarations, as in `strconv.atoi`']);
    expect(codes(mod('  let strconv = 1\n  io.println(strconv.toString())'))).toContain('CAN0016');
  });

  test('problems finding the file', () => {
    expect(diags(mod('  io.println("x")', 'import "lib/strconv"\nimport "lib/nope"\n'))).toEqual([
      ['CAN0041', 'the path is relative to this file, without `.candor`'],
    ]);
    expect(codes(mod('  io.println("x")', 'import "lib/strconv"\nimport "lib/strconv"\n'))).toEqual(['CAN0041']);
    const renamed = { 'lib/strconv.candor': strconv.replace('module strconv', 'module conv') };
    expect(diags(mod('  io.println("x")'), renamed)).toEqual([['CAN0041', 'name the file conv.candor, or the module strconv']]);
  });

  test('cycles', () => {
    const files = { 'a.candor': 'module a\nimport "b"\n', 'b.candor': 'module b\nimport "a"\n' };
    expect(diags('module m\nimport "a"\nfn main() {}\n', files)).toEqual([['CAN0041', 'move what both need into a third module']]);
    expect(codes('module m\nimport "main"\nfn main() {}\n', { 'main.candor': '' })).toEqual(['CAN0041']);
  });

  test('errors in an imported file name that file', () => {
    const r = program(mod('  io.println("x")'), { 'lib/strconv.candor': 'module strconv\nfn f() -> int {\n  return "x"\n}\n' });
    expect(r.diagnostics.map((d) => [d.code, d.file])).toEqual([['CAN0005', 'lib/strconv.candor']]);
  });

  test('imports come first', () => {
    expect(codes('module m\nfn main() {}\nimport "lib/strconv"\n')).toEqual(['CAN0001']);
  });

  test("an imported module needs no main, and its tests don't run", () => {
    const r = program('module m\nimport "lib/strconv"\ntest "t" {\n  assert strconv.formatInt(5, 2) == "101"\n}\n', { 'lib/strconv.candor': strconv, 'lib/strconv_test.candor': 'module strconv\ntest "theirs" {\n  assert true\n}\n' }, 'test');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('{Name: "t", Fn: test__1},');
    expect(r.go).not.toContain('"theirs"');
  });
});

describe('extern', () => {
  const ext = (items: string, body = '  io.println("x")') => program(mod(body, 'import "lib/b"\n'), { 'lib/b.candor': `module b\npub extern "strconv" {\n${items}\n}\n` });
  const extDiags = (items: string) => ext(items).diagnostics.map((d) => [d.code, d.help ?? d.message]);

  test('each extern becomes a Go function with the Candor signature, calling Go through an adapter', () => {
    const r = program(mod('  io.println(strconv.formatInt(1, 2))'));
    expect(r.bindings).toContain('import (\n\t"slices"'.replace('\t"slices"', '\tgo__1 "strconv"'));
    expect(r.bindings).toContain('func strconv__atoi(ctx__ *candor.Ctx, a0 string) res__[int64, candor.GoError] {');
    expect(r.bindings).toContain('func strconv__formatInt__go[A0 candor.Integer, A1 candor.Integer, R ~string](f func(A0, A1) R, a0 int64, a1 int64) string {');
    expect(r.bindings).toContain('\treturn res__[int64, candor.GoError]{err: candor.GoError{Err: err}}');
    // Go's errors about the Go function point at the `extern` line.
    expect(r.bindings).toMatch(/\/\/line .*lib\/strconv\.candor:3\n\treturn strconv__atoi__go\(go__1\.Atoi, a0\)\n\/\/line bindings\.go:\d+\n/);
    expect(r.bindings).toContain('func strconv__errRange() candor.GoError {\n//line');
  });

  test('a program without externs has no bindings file', () => {
    expect(compileSplit('module m\nfn main() {}\n', 't').bindings).toBeNull();
  });

  test('Go names must be exported', () => {
    expect(extDiags('  fn atoi(s: string) -> string')[0]).toEqual(['CAN0042', 'name the exported Go symbol, and give it a Candor name with `as`']);
  });

  test('no effects yet', () => {
    expect(extDiags('  fn Atoi(s: string) -> string uses io')[0][0]).toBe('CAN0042');
  });

  test('the types a binding can pass', () => {
    expect(extDiags('  fn Atoi(s: List<int>) -> string')[0][0]).toBe('CAN0042');
    expect(extDiags('  fn Atoi(s: string) -> Result<int, string>')).toEqual([['CAN0042', 'write `Result<int, GoError>`']]);
    expect(ext('  fn Split(s: string, sep: string) -> List<string>\n  fn ParseBool(s: string) -> Result<bool, GoError>\n  let ErrSyntax: GoError').diagnostics).toEqual([]);
  });

  test('inside its own module, an extern is an ordinary name', () => {
    const own = program(mod('  io.println(b.twice(2))', 'import "lib/b"\n'), {
      'lib/b.candor': 'module b\nextern "strconv" {\n  fn Itoa(i: int) -> string as itoa\n}\npub fn twice(n: int) -> string {\n  return itoa(n * 2)\n}\n',
    });
    expect(own.diagnostics).toEqual([]);
    expect(own.go).toContain('return b__itoa(ctx__, candor.Mul(n, 2))');
  });

  test('GoError: a message, `.is`, and no `==`', () => {
    expect(codes(mod('  match strconv.atoi("x") {\n    Ok(_) => io.println("ok"),\n    Err(e) => io.println(e.is(strconv.errRange).toString() + e.message()),\n  }'))).toEqual([]);
    expect(diags(mod('  match strconv.atoi("x") {\n    Ok(_) => io.println("ok"),\n    Err(e) => io.println((e == strconv.errRange).toString()),\n  }'))).toEqual([
      ['CAN0019', 'Go errors are compared with `.is(...)`: `e.is(strconv.errRange)`'],
    ]);
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd, env: { ...process.env, CANDOR_GO: go } });

describe('go build', () => {
  test(
    "a binding that doesn't fit its Go function is reported at the extern, in Candor's terms",
    () => {
      const dir = path.join(tmpdir(), 'candor-test', 'bad-binding');
      mkdirSync(path.join(dir, 'lib'), { recursive: true });
      writeModule(path.join(dir, 'lib', 'bad.candor'), 'module bad\npub extern "strconv" {\n  fn Atoi(s: string) -> string as atoi\n}\n');
      writeModule(path.join(dir, 'm.candor'), 'module m\nimport "lib/bad"\nfn main() uses io {\n  io.println(bad.atoi("1"))\n}\n');
      const r = cli(dir, 'build', 'm.candor', '--out', path.join(dir, 'out'));
      // Checked against Go's types before Go builds anything.
      expect(r.stderr).toContain("lib/bad.candor:3:6: error[CAN0045]: the Go function `Atoi` is `func(s string) (int, error)`, which does not fit this binding's signature");
      expect(r.stderr).toContain('help: write `fn Atoi(s: string) -> Result<int, GoError>`');
      expect(r.status).toBe(1);
    },
    60_000,
  );
});
