import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 068: `import "fs"`, files as text. The disk for `main`; in a test a file system in memory,
// so the same code runs against both (test/fixtures/fs-notes.candor).

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

function errors(src: string) {
  return compileSplit(src, 'f.candor', 'test').diagnostics.map((d) => `${d.code}: ${d.message}`);
}

test('a program writes, reads back and lists files; the same code passes against the fake', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'fs', 'notes');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [to, from] of [['notes', 'fs-notes'], ['notes_test', 'fs-notes_test']]) writeFileSync(path.join(dir, `${to}.candor`), readFileSync(path.join(root, 'test', 'fixtures', `${from}.candor`), 'utf8'));
  const run = candor(dir, 'run', 'notes.candor');
  expect(run.stderr).toBe('');
  const lines = run.stdout.split('\n');
  expect(lines.slice(0, 6)).toEqual(['a.txt: 2 lines, b.txt: 3 lines', 'one', 'end', '', 'false true', 'out/missing.txt: not found']);
  // The operating system's words.
  expect(lines[6]).toStartWith('out/notes: ');
  expect(run.status).toBe(0);
  // It cleaned up after itself; `out` stays.
  expect(existsSync(path.join(dir, 'out', 'notes'))).toBe(false);
  expect(existsSync(path.join(dir, 'out'))).toBe(true);

  const t = candor(dir, 'test', 'notes.candor');
  expect(t.stdout).toBe('PASS same code against memory\n\n1 passed, 0 failed\n');
  // The test touched no disk.
  expect(existsSync(path.join(dir, 'out', 'notes'))).toBe(false);
}, 120_000);

test('the fake: fresh per test, directories and errors like the disk', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'fs', 'fake');
  mkdirSync(dir, { recursive: true });
  writeModule(
    path.join(dir, 'fake.candor'),
    `module fake

import "fs"

test "starts empty" {
  assert fs.list(".") == Ok([])
  assert fs.write("a.txt", "x") == Ok()
  assert fs.exists("a.txt")
}

test "and fresh" {
  assert !fs.exists("a.txt")
  assert fs.makeDir("x/y/z") == Ok()
  assert fs.makeDir("x/y") == Ok()
  assert fs.list("x") == Ok(["y"])
  assert fs.write("x/y/f.txt", "a\\r\\nb\\n") == Ok()
  assert fs.readLines<List<string>>("x/y/f.txt", [], (seen, line) => seen.concat([line])) == Ok(["a", "b"])
  assert fs.list("x/y") == Ok(["f.txt", "z"])
  assert fs.list("x/y/f.txt") == Err(fs.FsError.Failed { path: "x/y/f.txt", message: "not a directory" })
  assert fs.read("x") == Err(fs.FsError.Failed { path: "x", message: "is a directory" })
  assert fs.makeDir("x/y/f.txt/w") == Err(fs.FsError.Failed { path: "x/y/f.txt/w", message: "not a directory" })
  assert fs.remove("nope") == Err(fs.FsError.NotFound { path: "nope" })
  assert fs.append("x/y/f.txt", "c") == Ok()
  assert fs.read("./x//y/f.txt") == Ok("a\\r\\nb\\nc")
  assert fs.remove("x/y/z") == Ok()
  assert fs.readLines("gone.txt", 0, (n, line) => n + 1) == Err(fs.FsError.NotFound { path: "gone.txt" })
}
`,
  );
  const t = candor(dir, 'test', 'fake.candor');
  expect(t.stdout).toEndWith('2 passed, 0 failed\n');
}, 120_000);

test('fs is an effect', () => {
  expect(errors('module f\nimport "fs"\nfn peek() -> bool {\n  return fs.exists("x")\n}\n')[0]).toContain('fs');
});
