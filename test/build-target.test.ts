import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Card 157: `candor build --target linux-x64` cross-compiles, cgo off, the binary named for the
// system it is for.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'build-target');

const candor = (env: Record<string, string>, ...args: string[]) => {
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.replace(/\r\n/g, '\n') };
};

// SQLite too, which cgo off must still build.
const app = `module app

import "sql"

fn main() -> Result<void, sql.Error> uses sql, io {
  sql.open("app.db")?
  io.println("up")
  return Ok()
}
`;

const magic = (file: string) => readFileSync(file).subarray(0, 4).toString('hex');

test('build --target gives a binary for that system, named without .exe off Windows', () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.candor'), app);
  const linux = candor({}, 'build', '--target', 'linux-x64', 'app.candor');
  expect(linux.err).toBe('');
  expect(linux.out).toBe(path.resolve(dir, 'app'));
  expect(magic(linux.out)).toBe('7f454c46'); // ELF
  const mac = candor({}, 'build', 'app.candor', '--target', 'darwin-arm64', '--out', path.join(dir, 'mac'));
  expect(mac.out).toBe(path.resolve(dir, 'mac', 'app'));
  expect(magic(mac.out)).toBe('cffaedfe'); // Mach-O, 64-bit
  const win = candor({}, 'build', '--target', 'windows-x64', 'app.candor', '--out', path.join(dir, 'win'));
  expect(win.out).toBe(path.resolve(dir, 'win', 'app.exe'));
  expect(magic(win.out).slice(0, 4)).toBe('4d5a'); // MZ
  // Go's own way still works, and names the binary by GOOS too.
  const env = candor({ GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '0' }, 'build', 'app.candor', '--out', path.join(dir, 'env'));
  expect(env.out).toBe(path.resolve(dir, 'env', 'app'));
  expect(existsSync(path.join(dir, 'env', 'app.exe'))).toBe(false);
}, 600_000);

test('--target is for build, and takes a known system', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.candor'), app);
  expect(candor({}, 'run', '--target', 'linux-x64', 'app.candor').err).toContain('--target is for build: run runs the program here');
  expect(candor({}, 'build', '--target', 'linux', 'app.candor').err).toContain(
    '--target needs one of windows-x64, windows-arm64, linux-x64, linux-arm64, darwin-x64, darwin-arm64',
  );
});
