import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

// Card 087: `env.load(path)` for .env files, and `slice(start)` to the end.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
// A variable given as undefined is left out, so one in the developer's shell can't leak in.
function candor(dir: string, env: Record<string, string | undefined>, ...args: string[]) {
  const all: Record<string, string | undefined> = { ...process.env, CANDOR_GO: go, ...env };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  // As candor.cmd does: Bun would read the .env itself, by its own rules, before the program.
  return spawnSync(process.execPath, ['--no-env-file', 'run', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: all,
    timeout: 120_000,
  });
}

const errors = (src: string) =>
  compileSplit(src, 't.candor', 'test')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

const app = `module app

import "fs"

fn settings() -> string uses env {
  let port = env.get("PORT") ?? "-"
  let name = env.get("NAME") ?? "-"
  let token = env.get("TOKEN") ?? "-"
  return "\${port} \${name} \${token}"
}

fn main() uses io, env, fs {
  match env.load(".env") {
    Ok() => io.println(settings()),
    Err(e) => io.println("load: \${e}"),
  }
  match env.load("bad.env") {
    Ok() => io.println("bad.env loaded"),
    Err(e) => io.println("load: \${e}"),
  }
  io.println("#tag".slice(1))
  io.println("\${[1, 2, 3].slice(1)}")
  io.println("hello".toBytes().slice(3).toHex())
}

test "the file fills in what the test hasn't set" {
  assert fs.write(".env", "PORT=8080\\nNAME='my app'\\n") == Ok()
  env.set("PORT", "9000")
  assert env.load(".env") == Ok()
  assert settings() == "9000 my app -"
  assert env.load("none.env") == Err(fs.FsError.NotFound { path: "none.env" })
}
`;

test('a .env file on disk: the process environment wins; a bad line is an error naming it', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'env-load');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'app.candor'), app);
  writeFileSync(path.join(dir, '.env'), '# settings\r\nPORT=8080\r\nexport NAME="my \\"app\\"" # quoted\r\nTOKEN=from-file\r\n');
  writeFileSync(path.join(dir, 'bad.env'), 'A=1\nB 2\n');
  const run = candor(dir, { TOKEN: 'from-process', PORT: undefined, NAME: undefined }, 'run', 'app.candor');
  expect(run.stderr).toBe('');
  expect(run.stdout.replace(/\r\n/g, '\n')).toBe(
    ['8080 my "app" from-process', 'load: bad.env: line 2: expected KEY=value', 'tag', '[2, 3]', '6c6f', ''].join('\n'),
  );
  const t = candor(dir, {}, 'test', 'app.candor');
  expect(t.stdout).toContain('1 passed, 0 failed');
}, 120_000);

describe('the checker', () => {
  test('env.load needs import "fs" and uses fs', () => {
    expect(errors('module m\nfn main() uses env {\n  let r = env.load(".env")\n}\n')).toEqual([
      [Codes.BadImport, '`env.load` reads a file, so it needs `import "fs"`', 'add `import "fs"` at the top, and `uses env, fs` on the function'],
    ]);
    const noFs = errors('module m\nimport "fs"\nfn main() uses env {\n  let r = env.load(".env")\n}\n');
    expect(noFs.map(([c]) => c)).toEqual([Codes.UndeclaredEffect]);
    expect(noFs[0][1]).toContain('`env.load` uses `fs`');
    expect(errors('module m\nimport "fs"\nfn main() uses env, fs {\n  let r = env.load()\n}\n')).toEqual([
      [Codes.ArgCount, '`env.load` takes 1 argument, the file\'s path, found 0', 'write `env.load(".env")?`'],
    ]);
  });

  test('slice takes 1 or 2 arguments, and says so', () => {
    const help = '`s.slice(start)` runs to the end; `s.slice(start, end)` stops before `end`; both clamp to the length';
    expect(errors('module m\nfn f() -> string {\n  return "abc".slice()\n}\n')).toEqual([[Codes.ArgCount, '`slice` takes 1 or 2 arguments, found 0', help]]);
    expect(errors('module m\nfn f() -> List<int> {\n  return [1].slice(0, 1, 2)\n}\n')).toEqual([[Codes.ArgCount, '`slice` takes 1 or 2 arguments, found 3', help]]);
    expect(errors('module m\nfn f() -> Bytes {\n  return "a".toBytes().slice("x")\n}\n').map(([c]) => c)).toEqual([Codes.TypeMismatch]);
  });
});
