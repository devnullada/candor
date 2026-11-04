import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { effectListing, formatEffects } from '../src/effect-listing';

const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');
const dir = mkdtempSync(path.join(tmpdir(), 'candor-effects-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const candor = (args: string[], cwd = dir) => spawnSync(process.execPath, ['run', cli, ...args], { cwd, encoding: 'utf8' });

const shop = `module shop

fn stamp() -> int uses clock {
  return clock.now()
}

pub fn zero() -> int {
  return 0
}

pub fn saved() -> int uses clock, io {
  io.println("saved")
  return stamp()
}

pub fn each(xs: List<int>, f: fn(int)) uses f {
  for x in xs {
    f(x)
  }
}

pub fn logged(xs: List<int>, f: fn(int)) uses io, f {
  io.println("each")
  each(xs, f)
}

test fn helper() uses io {
  io.println("only in tests")
}

fn main() uses io, clock {
  io.println(saved().toString())
}
`;

const names = (src: string, full = false) => effectListing(src, 'shop.candor', full).entries.map((e) => e.name).sort();

test('lists pub functions and main, not private ones or test code', () => {
  expect(names(shop)).toEqual(['each', 'logged', 'main', 'saved', 'zero']);
});

test('--full adds private functions, never test code', () => {
  expect(names(shop, true)).toEqual(['each', 'logged', 'main', 'saved', 'stamp', 'zero']);
});

test('a function with no effects is listed, so gaining one shows in a diff', () => {
  const { entries } = effectListing(shop, 'shop.candor');
  expect(entries.find((e) => e.name === 'zero')).toEqual({ file: 'shop.candor', line: 7, name: 'zero', effects: [], from: [] });
});

test('effects are sorted, whatever order the signature has', () => {
  const { entries } = effectListing(shop, 'shop.candor');
  expect(entries.find((e) => e.name === 'main')?.effects).toEqual(['clock', 'io']);
});

test('uses f is kept apart from effects', () => {
  const { entries } = effectListing(shop, 'shop.candor');
  expect(entries.find((e) => e.name === 'each')).toMatchObject({ effects: [], from: ['f'] });
  expect(entries.find((e) => e.name === 'logged')).toMatchObject({ effects: ['io'], from: ['f'] });
  expect(formatEffects(entries.filter((e) => e.name === 'logged'))).toBe('shop.candor:22 logged: uses f, io\n');
});

test("an effect from a private call shows on its pub caller: the checker makes it declare it", () => {
  const { entries } = effectListing(shop, 'shop.candor');
  expect(entries.find((e) => e.name === 'saved')?.effects).toContain('clock');
  const bad = `module m\n\nfn stamp() -> int uses clock {\n  return clock.now()\n}\n\npub fn saved() -> int {\n  return stamp()\n}\n`;
  writeFileSync(path.join(dir, 'undeclared.candor'), bad);
  const r = candor(['check', 'undeclared.candor']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('clock');
});

test('trait methods, impl methods, and module effect operations are listed', () => {
  const src = `module store

pub trait Saves {
  fn save(self) uses io
}

struct Doc { name: string }

impl Saves for Doc {
  fn save(self) uses io {
    io.println(self.name)
  }
}

effect store {
  pub fn put(key: string) uses clock {
    clock.sleep(1)
  }
}
`;
  const { entries, diagnostics } = effectListing(src, 'store.candor');
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(entries.map((e) => [e.name, e.effects])).toEqual([
    ['Saves.save', ['io']],
    ['Saves for Doc.save', ['io']],
    ['store.put', ['clock']],
  ]);
});

test('the CLI sorts by file then name, whatever the argument order, with forward slashes', () => {
  mkdirSync(path.join(dir, 'tree', 'sub'), { recursive: true });
  const a = 'module a\n\npub fn b() uses io {\n  io.println("b")\n}\n\npub fn a() {\n}\n';
  writeFileSync(path.join(dir, 'tree', 'sub', 'a.candor'), a);
  writeFileSync(path.join(dir, 'tree', 'z.candor'), 'module z\n\npub fn z() {\n}\n');
  writeFileSync(path.join(dir, 'tree', 'z_test.candor'), 'test "skipped" {\n}\n');
  const cwd = path.join(dir, 'tree');
  const expected = 'sub/a.candor:7 a: no effects\nsub/a.candor:3 b: uses io\nz.candor:3 z: no effects\n';
  const all = candor(['effects'], cwd);
  expect(all.stderr).toBe('');
  expect(all.status).toBe(0);
  expect(all.stdout).toBe(expected);
  expect(candor(['effects'], cwd).stdout).toBe(expected);
  expect(candor(['effects', 'z.candor', 'sub'], cwd).stdout).toBe(expected);
  expect(candor(['effects', 'sub', 'z.candor', 'z.candor'], cwd).stdout).toBe(expected);
});

test('--json is one function to a line', () => {
  const cwd = path.join(dir, 'tree');
  const r = candor(['effects', 'sub', '--json'], cwd);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([
    { file: 'sub/a.candor', line: 7, name: 'a', effects: [], from: [] },
    { file: 'sub/a.candor', line: 3, name: 'b', effects: ['io'], from: [] },
  ]);
  expect(r.stdout.split('\n').length).toBe(5);
});

test("a file with a syntax error fails, and no partial listing is printed", () => {
  mkdirSync(path.join(dir, 'broken'), { recursive: true });
  writeFileSync(path.join(dir, 'broken', 'good.candor'), 'module good\n\npub fn ok() {\n}\n');
  writeFileSync(path.join(dir, 'broken', 'bad.candor'), 'module bad\n\npub fn (\n');
  const r = candor(['effects'], path.join(dir, 'broken'));
  expect(r.status).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('bad.candor');
});
