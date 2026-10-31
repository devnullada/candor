import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

const point = 'struct P {\n  x: int\n}\nimpl Show for P {\n  fn toString(self) -> string {\n    return "P${self.x}"\n  }\n}\n';
const errors = (src: string, files: Record<string, string> = {}) =>
  compile(src, 'main.candor', 'main', { read: (f) => files[f] ?? null })
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

describe('the Show trait', () => {
  test('`${x}` and `x.toString()` call the impl', () => {
    const r = compile(`module m\n${point}fn main() uses io {\n  let p = P { x: 1 }\n  io.println("at \${p}: \${p.toString()}")\n}\n`, 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('(Show__for__m__P{}).toString(ctx__, p)');
  });

  test('a bound: `<T: Show>` takes int, string, bool and impls', () => {
    const src = `module m\n${point}fn label<T: Show>(v: T) -> string {\n  return "\${v}/\${v.toString()}"\n}\nfn main() uses io {\n  io.println(label(P { x: 1 }) + label(2) + label("s") + label(true))\n}\n`;
    const r = compile(src, 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('m__label[int64, showGo__[int64]](ctx__, 2)');
  });

  test('int, string and bool are Show already; the name is taken', () => {
    expect(errors('module m\nimpl Show for int {\n  fn toString(self) -> string {\n    return ""\n  }\n}\nfn main() {}\n')).toEqual([[Codes.BadImpl, 'int is `Show` already', undefined]]);
    expect(errors('module m\ntrait Show {\n  fn show(self) -> string\n}\nfn main() {}\n').map(([c]) => c)).toEqual([Codes.Duplicate]);
  });

  test('without it, interpolation says how to give it', () => {
    expect(errors('module m\nfn f<T>(v: T) -> string {\n  return "${v}"\n}\nfn main() {}\n')).toEqual([
      [Codes.TypeMismatch, '`${ }` shows a type with `Show` (string, int, bool, lists, maps, optionals and Results of those, and types with `impl Show`), found T', 'add the bound where `T` is declared: `<T: Show>`'],
    ]);
    // A list is `Show` when its items are.
    expect(errors('module m\nstruct Q {\n  x: int\n}\nfn main() uses io {\n  let qs = [Q { x: 1 }]\n  io.println("${qs}")\n}\n')[0].slice(1)).toEqual([
      '`${ }` shows a type with `Show` (string, int, bool, lists, maps, optionals and Results of those, and types with `impl Show`), found List<Q>: Q has no `impl Show`',
      'derive it: `impl Show for Q`, or write it: `impl Show for Q { fn toString(self) -> string { ... } }`',
    ]);
  });

  test("another module's impl", () => {
    const geo = `module geo\npub ${point}`;
    expect(errors('module m\nimport "geo"\nfn main() uses io {\n  io.println("${geo.P { x: 1 }}")\n}\n', { 'geo.candor': geo.replace('  x: int', '  pub x: int') })).toEqual([]);
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

test(
  'runs: impls, primitives and a bound',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'show');
    mkdirSync(dir, { recursive: true });
    const src = `module show\n${point}fn label<T: Show>(v: T) -> string {\n  return "<\${v}>"\n}\nfn main() uses io {\n  io.println("\${P { x: 1 }} \${label(P { x: 2 })}\${label(3)}\${label("s")}\${label(false)}")\n}\n`;
    writeFileSync(path.join(dir, 'show.candor'), src);
    const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'show.candor', '--out', path.join(dir, 'out')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('P1 <P2><3><s><false>\n');
  },
  120_000,
);

// Card 130: a map shows as Candor writes it. Card 162: the build goes to the cache, keyed by the
// file's folder, and leaves nothing beside the file.
test(
  'runs: maps, built in the cache',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'show-map');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const src = 'module showmap\n\nfn main() uses io {\n  let mut h: Map<string, int> = [:]\n  io.println("${h}")\n  h["b"] = 2\n  h["a"] = 1\n  let n: Map<int, List<string>?> = [1: ["x"], 2: none]\n  io.println("${h} ${n.toString()}")\n}\n';
    writeFileSync(path.join(dir, 'showmap.candor'), src);
    const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', path.join(dir, 'showmap.candor')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('[:]\n["b": 2, "a": 1] [1: ["x"], 2: none]\n');
    expect(existsSync(path.join(dir, '.candor'))).toBe(false);
  },
  120_000,
);
