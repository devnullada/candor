import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candorHome, removeOlder, version } from '../src/home';

test('from a clone, the home is the repo', () => {
  expect(existsSync(path.join(candorHome(), 'std', 'json.candor'))).toBe(true);
  expect(existsSync(path.join(candorHome(), 'runtime', 'go', 'go.mod'))).toBe(true);
});

test('a release writes its embedded files out once, under the version', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'candor-home-'));
  const script = [
    `globalThis.__candorAssets = { 'std/a.candor': 'module a\\n', 'runtime/go/go.mod': 'module x\\n' };`,
    `const { candorHome } = await import(${JSON.stringify(path.join(import.meta.dir, '..', 'src', 'home.ts'))});`,
    `console.log(candorHome());`,
  ].join('\n');
  const run = () => spawnSync('bun', ['-e', script], { env: { ...process.env, CANDOR_HOME: home }, encoding: 'utf8' });
  const first = run();
  expect(first.stderr).toBe('');
  const dir = first.stdout.trim();
  expect(dir).toBe(path.join(home, version));
  expect(readFileSync(path.join(dir, 'std', 'a.candor'), 'utf8')).toBe('module a\n');
  expect(existsSync(path.join(dir, '.complete'))).toBe(true);
  expect(run().stdout.trim()).toBe(dir);
});

// Card 136: older versions' folders go when a new one unpacks; nothing else does.
test('unpacking a new version removes the older ones', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'candor-home-'));
  for (const d of ['0.0.0', 'bin', 'marketplace', '99.0.0']) mkdirSync(path.join(home, d));
  writeFileSync(path.join(home, 'bin', 'candor.exe'), '');
  const script = [
    `globalThis.__candorAssets = { 'std/a.candor': 'module a\\n' };`,
    `const { candorHome } = await import(${JSON.stringify(path.join(import.meta.dir, '..', 'src', 'home.ts'))});`,
    `candorHome();`,
  ].join('\n');
  expect(spawnSync('bun', ['-e', script], { env: { ...process.env, CANDOR_HOME: home }, encoding: 'utf8' }).stderr).toBe('');
  expect(readdirSync(home).sort()).toEqual([version, '99.0.0', 'bin', 'marketplace'].sort());
  expect(existsSync(path.join(home, 'bin', 'candor.exe'))).toBe(true);
});

test('versions compare by number, not text', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'candor-home-'));
  for (const d of ['0.0.9', '0.0.10', '0.0.11', '0.1.0', '0.0.9.tmp', '0.0.2.123.tmp']) mkdirSync(path.join(home, d));
  removeOlder(home, '0.0.10');
  expect(readdirSync(home).sort()).toEqual(['0.0.10', '0.0.11', '0.0.2.123.tmp', '0.0.9.tmp', '0.1.0']);
});
