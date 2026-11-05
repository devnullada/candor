import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDir, pruneBuilds } from '../src/home';
import { writeModule } from './split';

// Card 162: builds go to a cache out of the project; `build`'s binary goes beside the file.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const exe = process.platform === 'win32' ? '.exe' : '';

const candor = (dir: string, cache: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, CANDOR_CACHE: cache },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.replace(/\r\n/g, '\n') };
};

const hello = 'module hello\n\nfn main() uses io {\n  io.println("hi")\n}\n\ntest "adds" {\n  assert 1 + 1 == 2\n}\n';

test('run and test leave nothing in the project; build puts the binary beside the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'candor-builddir-'));
  const cache = path.join(dir, 'cache');
  const project = path.join(dir, 'project');
  mkdirSync(project);
  writeModule(path.join(project, 'main.candor'), hello);

  expect(candor(project, cache, 'run', 'main.candor').out).toBe('hi');
  expect(candor(project, cache, 'test', 'main.candor').out).toContain('1 passed');
  expect(readdirSync(project).sort()).toEqual(['main.candor', 'main_test.candor']);
  const [folder] = readdirSync(cache).filter((f) => !f.startsWith('.'));
  expect(folder).toMatch(/^project-[0-9a-f]{10}$/);
  expect(readdirSync(path.join(cache, folder)).sort()).toEqual(['hello', 'hello.test']);

  const built = candor(project, cache, 'build', 'main.candor');
  expect(built.out).toBe(path.join(project, `hello${exe}`));
  expect(existsSync(built.out)).toBe(true);
  const named = candor(project, cache, 'build', 'main.candor', '-o', path.join('bin', `hi${exe}`));
  expect(named.out).toBe(path.join(project, 'bin', `hi${exe}`));
  expect(existsSync(named.out)).toBe(true);
}, 300_000);

test('a folder named for the module says to use -o; -o is for build', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'candor-builddir-'));
  writeModule(path.join(dir, 'main.candor'), hello);
  mkdirSync(path.join(dir, `hello${exe}`));
  const r = candor(dir, path.join(dir, '.cache'), 'build', 'main.candor');
  expect(r.status).toBe(1);
  expect(r.err).toContain(`hello${exe} is a folder, so the binary can't go there; name it with -o`);
  expect(candor(dir, path.join(dir, '.cache'), 'run', 'main.candor', '-o', 'x').err).toContain('-o is for build');
}, 120_000);

test('two folders with the same module name build apart', () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'candor-cache-'));
  const before = process.env.CANDOR_CACHE;
  process.env.CANDOR_CACHE = cache;
  try {
    expect(buildDir(path.join('a', 'main.candor'), 'app')).not.toBe(buildDir(path.join('b', 'main.candor'), 'app'));
    expect(buildDir(path.join('a', 'main.candor'), 'app')).toBe(buildDir(path.join('a', 'other.candor'), 'app'));
  } finally {
    process.env.CANDOR_CACHE = before;
  }
});

test('builds unused for 30 days go, checked once a day', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'candor-cache-'));
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const make = (at: string, daysAgo: number) => {
    mkdirSync(path.join(root, at), { recursive: true });
    writeFileSync(path.join(root, at, '.used'), '');
    const t = (now - daysAgo * day) / 1000;
    utimesSync(path.join(root, at, '.used'), t, t);
  };
  make('old-1/app', 40);
  make('mixed-2/app', 40);
  make('mixed-2/app.test', 1);
  pruneBuilds(root, now);
  expect(existsSync(path.join(root, 'old-1'))).toBe(false);
  expect(readdirSync(path.join(root, 'mixed-2'))).toEqual(['app.test']);

  // Within a day of the last look, nothing is looked at.
  make('later-3/app', 40);
  pruneBuilds(root, now + 1000);
  expect(existsSync(path.join(root, 'later-3', 'app'))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
