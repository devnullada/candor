import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Card 071: half the task orders a test tries are PCT runs (random priorities, d-1 change
// points), which find a bug needing particular preemptions with odds a coin flip at every step
// can't match. test/fixtures/late-reader.candor fails only if one task reads after another's
// twentieth step and before its last: uniform orders alone missed it in 9,000 tries; with PCT the
// first failure came within 20 to 170 runs.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const file = path.join(root, 'test', 'fixtures', 'late-reader.candor');
const out = path.join(tmpdir(), 'candor-test', 'pct');
const candor = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), 'test', file, '--out', out, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });

test('a race two preemptions deep is found every run, and its seed replays it', () => {
  const r = candor('--runs', '1000', '--json');
  const result = JSON.parse(r.stdout.trim().split('\n')[0]);
  expect(result.status).toBe('fail');
  expect(result.failure.parts[0].value).toBe('20');
  // Replaying the seed it printed fails the same way, in one run.
  const again = JSON.parse(candor('--seed', String(result.seed), '--json').stdout.trim().split('\n')[0]);
  expect([again.status, again.runs, again.failure.parts[0].value]).toEqual(['fail', 1, '20']);
}, 120_000);
