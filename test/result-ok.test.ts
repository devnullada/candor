import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

// `r.ok()`, the value as a `T?`, so `r.ok() ?? fallback` is the value or a fallback.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const errors = (src: string) =>
  compile(src, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

describe('Result.ok()', () => {
  test('gives a `T?`', () => {
    expect(errors('module m\nfn f(r: Result<int, string>) -> int {\n  return r.ok() ?? 0\n}\nfn main() {}\n')).toEqual([]);
  });

  test('a `Result<void, E>` has no value to take', () => {
    expect(errors('module m\nfn f(r: Result<void, string>) {\n  let x = r.ok()\n}\nfn main() {}\n')).toEqual([
      [Codes.NoValue, 'Result<void, string> holds no value to take', 'use `r.isOk()` to ask whether it succeeded'],
    ]);
  });

  test('it runs', () => {
    const dir = path.join(tmpdir(), 'candor-test', 'result-ok');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'main.candor'),
      'module m\nfn parse(s: string) -> Result<int, string> {\n  return if s == "1" { Ok(1) } else { Err("not one") }\n}\nfn main() uses io {\n  io.println((parse("1").ok() ?? 0).toString())\n  io.println((parse("x").ok() ?? 0).toString())\n  let n = parse("1").ok()\n  if n != none {\n    io.println("got ${n}")\n  }\n}\n',
    );
    const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', path.join(dir, 'main.candor'), '--out', path.join(dir, 'out')], {
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('1\n0\ngot 1\n');
  }, 60_000);
});
