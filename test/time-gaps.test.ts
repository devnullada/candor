import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `env.zone()` gives the zone the program runs in, `clock.nanos()` times finer than
// a millisecond. (Skipped wall times and unknown abbreviations: test/timezone.test.ts.)

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'time-gaps');

function cli(cmd: 'run' | 'test' | 'check', src: string, env: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  const args = cmd === 'check' ? [cmd, 't.candor'] : [cmd, 't.candor', '--out', path.join(dir, `out-${cmd}`)];
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
  });
}

const zoneMain = `module m

import "time"

fn main() uses io, env, clock {
  let z = env.zone()
  let a = clock.nanos()
  let b = clock.nanos()
  io.println("\${time.zoneName(z)} \${time.formatIn(0, z)} \${b >= a}")
}
`;

test('env.zone reads $TZ, with or without a colon; clock.nanos only goes up', () => {
  const r = cli('run', zoneMain, { TZ: 'America/New_York' });
  expect(r.stderr).toBe('');
  expect(r.stdout.trim()).toBe('America/New_York 1969-12-31T19:00:00.000-05:00 true');
  const colon = spawnSync(path.join(dir, 'out-run', process.platform === 'win32' ? 'm.exe' : 'm'), [], { encoding: 'utf8', env: { ...process.env, TZ: ':Asia/Tokyo' } });
  expect(colon.stdout.trim()).toBe('Asia/Tokyo 1970-01-01T09:00:00.000+09:00 true');
}, 180_000);

test('a $TZ naming no zone falls back to the machine, not an error', () => {
  const r = cli('run', zoneMain, { TZ: 'Nowhere/Atall' });
  expect(r.stderr).toBe('');
  expect(r.stdout).not.toContain('Nowhere');
  expect(r.stdout.trim()).toEndWith('true');
}, 180_000);

test('the fake: UTC until setZone; nanos follow the virtual time', () => {
  const r = cli(
    'test',
    `module m

import "time"

fn main() {}

fn localHour(t: int) -> int uses env {
  return time.partsIn(t, env.zone()).hour
}

test "zone" {
  assert time.zoneName(env.zone()) == "UTC"
  assert localHour(0) == 0
  env.setZone(time.zone("Asia/Tokyo") ?? time.utcZone())
  assert localHour(0) == 9
}

test "nanos" {
  let start = clock.nanos()
  clock.advance(3)
  assert clock.nanos() - start == 3_000_000
}
`,
  );
  expect(r.stdout + r.stderr).toContain('2 passed, 0 failed');
}, 180_000);

test('env.zone needs time imported; env.setZone is for tests', () => {
  const noImport = cli('check', 'module m\n\nfn main() uses io, env {\n  let z = env.zone()\n}\n');
  expect(noImport.stdout + noImport.stderr).toContain('`env.zone` gives a `time.Zone`, so it needs `import "time"`');
  const inMain = cli('check', 'module m\n\nimport "time"\n\nfn main() uses env {\n  env.setZone(time.utcZone())\n}\n');
  expect(inMain.stdout + inMain.stderr).toContain('`env.setZone` is for tests');
  const noUses = cli('check', 'module m\n\nimport "time"\n\nfn main() uses io {\n  io.println(time.zoneName(env.zone()))\n}\n');
  expect(noUses.stdout + noUses.stderr).toContain('env');
  expect(noUses.status).not.toBe(0);
});
