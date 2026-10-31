import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 145: `candor test` and `candor check` over several files, folders, or the current one,
// with one total; other commands refuse a second file instead of ignoring it.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'cli-many');

const candor = (...args: string[]) => {
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  return { status: r.status, raw: r.stdout, out: r.stdout.replace(/\r\n/g, '\n').replaceAll('\\', '/'), err: r.stderr.replace(/\r\n/g, '\n') };
};

const setup = () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  mkdirSync(path.join(dir, '.candor'), { recursive: true });
  writeModule(path.join(dir, 'a.candor'), 'module a\n\ntest "one" {\n  assert 1 + 1 == 2\n}\n\ntest "two" {\n  assert "x".length() == 1\n}\n');
  writeModule(path.join(dir, 'sub', 'b.candor'), 'module b\n\ntest "three" {\n  assert true\n}\n\ntest "four" {\n  assert 2 > 3\n}\n');
  // No tests; `test "` only in a string.
  writeModule(path.join(dir, 'c.candor'), 'module c\n\nconst s = """\ntest "not one" {}\n"""\n');
  // A build folder: never read.
  writeModule(path.join(dir, '.candor', 'x.candor'), 'module x\n\ntest "hidden" {\n  assert false\n}\n');
};

test('test with no file runs every test file under the folder, and totals them', () => {
  setup();
  const r = candor('test');
  expect(r.err).toBe('');
  expect(r.status).toBe(1);
  expect(r.out).toContain('== a.candor\nPASS one\nPASS two\n\n2 passed, 0 failed\n');
  expect(r.out).toContain('== sub/b.candor\nPASS three\nFAIL four');
  expect(r.out).toContain('no tests in c.candor');
  expect(r.out).not.toContain('hidden');
  expect(r.out).toContain('\ntotal: 3 passed, 1 failed, in 2 files\nfailed: sub/b.candor\n');
}, 300_000);

test('test takes several files and folders; --only picks across them; --json ends with a total', () => {
  setup();
  const r = candor('test', 'a.candor', 'sub', '--only', 't');
  expect(r.status).toBe(0);
  // "two" and "three"; "one" and the failing "four" are filtered out.
  expect(r.out).toContain('total: 2 passed, 0 failed, 2 filtered out, in 2 files');
  // A file with no test of that name isn't built.
  expect(candor('test', 'a.candor', 'sub', '--only', 'one').out).toContain('total: 1 passed, 0 failed, 1 filtered out, in 1 file\n');
  const j = candor('test', 'a.candor', 'sub/b.candor', '--json');
  const lines = j.raw.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.type === 'summary').length).toBe(2);
  expect(lines[lines.length - 1]).toEqual({ type: 'total', files: 2, passed: 3, failed: 1, filtered: 0 });
}, 300_000);

test('check with no file checks every file; a broken one fails it', () => {
  setup();
  expect(candor('check').out).toBe('checked 3 files: no errors\n');
  writeModule(path.join(dir, 'sub', 'd.candor'), 'module d\n\nfn f() -> int {\n  return "x"\n}\n');
  const r = candor('check', '.');
  expect(r.status).toBe(1);
  expect(r.err).toContain('sub');
  expect(r.out.replaceAll('\\', '/')).toBe('checked 4 files; errors in sub/d.candor\n');
});

test('other commands refuse a second file; several files take no --out or file:line', () => {
  setup();
  expect(candor('run', 'a.candor', 'c.candor').err).toContain('candor: run takes one file; only test, check and outline take several');
  expect(candor('test', 'a.candor', 'sub', '--out', 'x').err).toContain('--out is for one file');
  expect(candor('test', 'a.candor:3', 'sub').err).toContain('`file:line` picks a test in one file');
  expect(candor('test', 'nope.candor', 'a.candor').err).toContain('cannot find nope.candor');
});
