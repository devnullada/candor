import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// candorlanguage.org's example (site/src/examples) compiles and its test passes: the page shows
// the files as they are.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

test("the site's example passes its test", () => {
  const dir = path.join(tmpdir(), 'candor-test', 'site');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(import.meta.dir, '..', 'site', 'src', 'examples'), dir, { recursive: true });
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 'rooms.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 200_000,
  });
  expect(r.stdout + r.stderr).toContain('1 passed, 0 failed');
}, 240_000);
