import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// `test fn`, a helper for tests: it may `assert` and use the fakes' own functions, and
// only tests and other test fns call it.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'test-fns');

function cli(cmd: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(files)) writeModule(path.join(dir, name), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'deploy.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// A shared helper module, as a program's tests would import it.
const fixtures = `module fixtures

import "exec"

// Scripts git to answer, and says what it answered.
pub test fn gitAnswers(text: string) -> string uses exec {
  exec.script("git", [exec.out(text)], 0)
  return text
}
`;

const deploy = `module deploy

import "exec"
import "./fixtures"

fn version() -> Result<string, string> uses exec {
  let out = exec.output(exec.command("git", ["--version"])).mapErr((e) => "\${e}")?
  return Ok(out.stdout.trim())
}

fn main() uses io, exec {
  match version() {
    Ok(v) => io.println(v),
    Err(e) => io.println(e),
  }
}

// Runs version() and checks it ran git once, with the arguments given.
test fn ranGit(args: List<string>) -> string uses exec {
  let v = match version() {
    Ok(v) => v,
    Err(e) => e,
  }
  let ran = exec.ran()
  assert ran.length() == 1
  assert ran.map((c) => c.args) == [args]
  return v
}

test fn printed() -> string uses io {
  return io.output()
}

test "the version is git's" {
  let said = fixtures.gitAnswers("git version 2.49")
  assert ranGit(["--version"]) == said
  io.print("x")
  assert printed() == "x"
}

test "a helper's assert fails the test" {
  fixtures.gitAnswers("git version 2.49")
  assert ranGit(["--help"]) == "git version 2.49"
}
`;

test('test fns: shared across files, fakes and assert, a failure inside one', () => {
  const r = cli('test', { 'fixtures.candor': fixtures, 'deploy.candor': deploy });
  const out = r.stdout + r.stderr;
  expect(out).toContain('1 passed, 1 failed');
  expect(out).toContain('assert ran.map((c) => c.args) == [args]');
}, 180_000);

test('a program with test fns builds without them', () => {
  const r = cli('build', { 'fixtures.candor': fixtures, 'deploy.candor': deploy });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
}, 180_000);

const errors = (src: string) =>
  compileSplit(src, 'm.candor', 'test')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.message}`);

test('only tests and test fns call a test fn', () => {
  const src = `module m

test fn helper() -> int {
  assert 1 == 1
  return 1
}

test fn other() -> int {
  return helper() + 1
}

fn main() uses io {
  io.println(helper().toString())
  let f = helper
}

test "calls it" {
  assert other() == 2
}
`;
  const errs = errors(src);
  expect(errs.length).toBe(2);
  expect(errs[0]).toBe('CAN0035 `helper` is a `test fn`, which only tests and other test fns can call');
  expect(errors('module m\n\ntest fn main() uses io {\n  io.println("hi")\n}\n')[0]).toContain('`main` cannot be a `test fn`');
});
