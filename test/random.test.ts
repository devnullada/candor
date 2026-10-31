import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 067: the `random` effect. crypto/rand for real; in tests a fixed seed, so the values are
// the same in every run, whatever the task scheduler's seed.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(name: string, src: string, ...args: string[]) {
  const dir = path.join(tmpdir(), 'candor-test', 'random', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

function errors(src: string) {
  return compileSplit(src, 'r.candor', 'test').diagnostics.map((d) => `${d.code}: ${d.message}${d.help ? ` (${d.help})` : ''}`);
}

const tests = `module dice

fn roll() -> int uses random {
  return random.int(1, 6)
}

test "a die stays in range and shows every face" {
  let rolls = (0..600).map((i) => roll())
  assert rolls.all((n) => n >= 1 && n <= 6)
  assert (1..7).all((face) => rolls.contains(face))
  assert random.int(5, 5) == 5
  assert random.int(-3, -1) < 0
}

test "the same values in every run" {
  assert random.int(1, 100) == 23
  assert random.token(4) == "fdb19cc2"
  random.seed(7)
  assert random.int(1, 100) == 27
}

test "a uuid carries the virtual clock" {
  clock.set(1_000)
  let id = random.uuid()
  assert id.slice(0, 13) == "00000000-03e8"
  assert id.slice(14, 15) == "7"
  assert ["8", "9", "a", "b"].contains(id.slice(19, 20))
}

test "shuffle and pick" {
  let xs = random.shuffle([1, 2, 3, 4, 5])
  assert xs == [1, 3, 4, 5, 2]
  assert xs.sorted() == [1, 2, 3, 4, 5]
  let empty: List<string> = []
  assert random.shuffle(empty) == []
  assert random.pick(empty) == none
  let pet: string? = random.pick(["cat", "dog"])
  assert pet != none
}

test "low above high panics" {
  random.int(6, 1)
}
`;

test('random in tests: in range, and the same values whatever the seed', () => {
  for (const seed of ['1', '2']) {
    const r = candor('dice', tests, 'test', '--seed', seed);
    expect(r.stdout).toContain('random.int(6, 1): low is above high');
    expect(r.stdout).toEndWith('4 passed, 1 failed\n');
  }
}, 120_000);

test('the real random: crypto values, a v7 uuid with the time now', () => {
  const r = candor(
    'real',
    `module real

fn main() uses io, random, clock {
  let before = clock.now()
  let a = random.uuid()
  let b = random.uuid()
  io.println(a)
  io.println("\${a != b} \${random.token(32).length()} \${before}")
  let rolls = (0..200).map((i) => random.int(1, 6))
  io.println("\${rolls.all((n) => n >= 1 && n <= 6)} \${random.shuffle([1, 2, 3]).sorted() == [1, 2, 3]}")
}
`,
    'run',
  );
  expect(r.stderr).toBe('');
  const [id, line2, line3] = r.stdout.trim().split('\n');
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const [different, length, before] = line2.split(' ');
  expect([different, length]).toEqual(['true', '64']);
  // The first 48 bits are the time in milliseconds.
  const ms = parseInt(id.replace('-', '').slice(0, 12), 16);
  expect(Math.abs(ms - Number(before))).toBeLessThan(5_000);
  expect(line3).toBe('true true');
}, 120_000);

test('random is an effect: a function without `uses random` cannot draw', () => {
  expect(errors('module r\nfn roll() -> int {\n  return random.int(1, 6)\n}\n')[0]).toContain('random');
});

test('shuffle and pick take a list, and are called', () => {
  expect(errors('module r\nfn f() -> int? uses random {\n  return random.pick(3)\n}\n')).toEqual([
    'CAN0005: `random.pick` takes a list, found int (for a number in a range, `random.int(low, high)`)',
  ]);
  expect(errors('module r\nfn f() uses random {\n  let g = random.shuffle\n}\n')).toEqual([
    'CAN0020: `random.shuffle` is generic and must be called (write `random.shuffle(xs)`)',
  ]);
  expect(errors('module r\nfn f() uses random {\n  random.float()\n}\n')[0]).toContain('available: int, uuid, uuid4, token, bytes, shuffle, pick');
});
