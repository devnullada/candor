import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

// The `env` effect: variables and arguments, read only; the fake is set by tests.

const errors = (src: string, mode: 'main' | 'test' = 'main') =>
  compileSplit(src, 't.candor', mode)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message]);

const program = `module envy
fn greeting() -> string uses env {
  let who = env.get("WHO") ?? "world"
  return "hello, \${who}"
}
fn main() uses io, env {
  io.println(greeting())
  for a in env.args() {
    io.println("arg \${a}")
  }
  let look = env.get
  io.println(look("CANDOR_SURELY_UNSET") ?? "unset")
}
test "the fake has nothing until a test sets it" {
  assert greeting() == "hello, world"
  assert env.args() == []
  env.set("WHO", "Ada")
  env.setArgs(["-v", "x"])
  assert greeting() == "hello, Ada"
  assert env.args() == ["-v", "x"]
}
test "and starts over in every test" {
  assert env.get("WHO") == none
}
`;

describe('env', () => {
  test('is an effect like the others', () => {
    expect(errors(program)).toEqual([]);
    expect(errors('module m\nfn port() -> string? {\n  return env.get("PORT")\n}\nfn main() {}\n').map((e) => e[0])).toEqual([Codes.UndeclaredEffect]);
  });

  test('is read only: `set` and `setArgs` are the fake\'s', () => {
    const src = 'module m\nfn main() uses env {\n  env.set("PORT", "1")\n  env.setArgs(["a"])\n}\n';
    expect(errors(src)).toEqual([
      [Codes.FakeOnly, '`env.set` only exists on the fake `env` inside `test` blocks'],
      [Codes.FakeOnly, '`env.setArgs` only exists on the fake `env` inside `test` blocks'],
    ]);
  });

  test("Go's `(v, ok)` becomes `T?`, called or as a value", () => {
    const go = compileSplit(program, 't.candor').go!;
    expect(go).toContain('optOf__(env.Get(ctx__, "WHO"))');
    expect(go).toContain('func(c__ *candor.Ctx, a__0 string) opt__[string] { return optOf__(env.Get(c__, a__0)) }');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, WHO: 'there' },
  });

test(
  'runs: the real one reads the process, and what follows `--` is the arguments',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'env');
    mkdirSync(dir, { recursive: true });
    writeModule(path.join(dir, 'envy.candor'), program);
    const r = cli(dir, 'run', 'envy.candor', '--out', path.join(dir, 'out'), '--', '-v', '--json', 'two words');
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('hello, there\narg -v\narg --json\narg two words\nunset\n');
    const t = cli(dir, 'test', 'envy.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('2 passed, 0 failed');
    expect(cli(dir, 'check', 'envy.candor', '--', 'x').stderr).toContain('only run and debug pass arguments to the program');
  },
  120_000,
);
