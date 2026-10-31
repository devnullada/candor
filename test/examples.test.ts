import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every example with a `.out` file must compile, build with Go, and print exactly that.
const root = path.join(import.meta.dir, '..');
const examples = path.join(root, 'examples');

describe('examples', () => {
  for (const file of readdirSync(examples).filter((f) => f.endsWith('.candor') && !f.endsWith('_test.candor'))) {
    const expected = path.join(examples, file.replace(/\.candor$/, '.out'));
    if (!existsSync(expected)) continue;
    test(
      file,
      () => {
        const out = path.join(tmpdir(), 'candor-test', file);
        const cli = path.join(root, 'src', 'cli.ts');
        const r = spawnSync(process.execPath, ['run', cli, 'run', path.join(examples, file), '--out', out], {
          encoding: 'utf8',
        });
        expect(r.stderr).toBe('');
        expect(r.stdout).toBe(readFileSync(expected, 'utf8'));
        expect(r.status).toBe(0);
      },
      60_000,
    );
  }
});

// Every example with `test` blocks must pass them.
describe('example tests', () => {
  for (const file of readdirSync(examples).filter((f) => f.endsWith('.candor') && !f.endsWith('_test.candor'))) {
    if (!existsSync(path.join(examples, file.replace(/.candor$/, '_test.candor')))) continue;
    test(
      file,
      () => {
        const out = path.join(tmpdir(), 'candor-test', `${file}.test`);
        const cli = path.join(root, 'src', 'cli.ts');
        const r = spawnSync(process.execPath, ['run', cli, 'test', path.join(examples, file), '--out', out], {
          encoding: 'utf8',
        });
        expect(r.stderr).toBe('');
        expect(r.stdout).toMatch(/\n\d+ passed, 0 failed\n$/);
        expect(r.status).toBe(0);
      },
      60_000,
    );
  }
});
