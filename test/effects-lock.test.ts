import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffLock, parseLock } from '../src/effect-listing';

const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');
const root = mkdtempSync(path.join(tmpdir(), 'candor-lock-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A project of its own, with one file, its lock written. */
function project(source: string): { cwd: string; run: (...args: string[]) => ReturnType<typeof spawnSync> & { stdout: string; stderr: string }; edit: (s: string) => void } {
  const cwd = path.join(root, `p${count++}`);
  mkdirSync(cwd);
  const edit = (s: string) => writeFileSync(path.join(cwd, 'pay.candor'), s);
  edit(source);
  const run = (...args: string[]) => spawnSync(process.execPath, ['run', cli, 'effects', ...args], { cwd, encoding: 'utf8' });
  expect(run('--write').status).toBe(0);
  return { cwd, run, edit };
}

const before = `module pay

fn stamp() -> int uses clock {
  return clock.now()
}

pub fn charge() -> int uses clock {
  return stamp()
}

pub fn zero() -> int {
  return 0
}
`;

test('the lock holds functions with effects, grouped by file, without line numbers', () => {
  const p = project(before);
  const lock = readFileSync(path.join(p.cwd, 'effects.lock'), 'utf8');
  expect(lock).toEndWith('\npay.candor\n  charge: uses clock\n');
  expect(lock).not.toContain('zero');
  expect(lock).not.toContain('stamp');
});

test('a clean run exits 0', () => {
  const p = project(before);
  const r = p.run('--check');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('effects match effects.lock');
});

test('a new effect fails, naming the function and the effect, with how to accept it', () => {
  const p = project(before);
  p.edit(before.replace('uses clock {\n  return stamp()', 'uses clock, net {\n  return stamp()'));
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('pay.candor:7 charge: gained net');
  expect(r.stderr).toContain('candor effects --write');
});

test('a function that had no effects gaining one fails', () => {
  const p = project(before);
  p.edit(before.replace('pub fn zero() -> int {', 'pub fn zero() -> int uses exec {'));
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('zero: gained exec');
});

test('a removed effect fails too', () => {
  const p = project(before);
  p.edit(before.replace('pub fn charge() -> int uses clock {\n  return stamp()', 'pub fn charge() -> int {\n  return 1'));
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('charge: lost clock');
});

test('a function with effects going away fails and says so', () => {
  const p = project(before);
  p.edit(before.replace(/pub fn charge[\s\S]*?\n}\n/, ''));
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('pay.candor charge: lost clock (the function is gone)');
});

test('what is no change in reach passes: a moved function, a new one with no effects, a private effect', () => {
  const p = project(before);
  p.edit(`module pay

pub fn added() -> int {
  return 1
}

pub fn zero() -> int {
  return 0
}

fn other() uses io {
  io.println("x")
}

fn stamp() -> int uses clock {
  return clock.now()
}

pub fn charge() -> int uses clock {
  return stamp()
}
`);
  expect(p.run('--check').status).toBe(0);
});

test('--write accepts a change', () => {
  const p = project(before);
  p.edit(before.replace('pub fn zero() -> int {', 'pub fn zero() -> int uses exec {'));
  expect(p.run('--check').status).toBe(1);
  expect(p.run('--write').status).toBe(0);
  expect(p.run('--check').status).toBe(0);
});

test('--json gives the changes on stdout', () => {
  const p = project(before);
  p.edit(before.replace('uses clock {\n  return stamp()', 'uses io {\n  return stamp()'));
  const r = p.run('--check', '--json');
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout)).toEqual({ changes: [{ file: 'pay.candor', line: 7, name: 'charge', gained: ['io'], lost: ['clock'] }] });
});

test('no lock file fails and says how to make one', () => {
  const p = project(before);
  rmSync(path.join(p.cwd, 'effects.lock'));
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('no effects.lock');
  expect(r.stderr).toContain('--write');
});

test('a merge left in the lock fails with its line', () => {
  const p = project(before);
  const file = path.join(p.cwd, 'effects.lock');
  writeFileSync(file, `${readFileSync(file, 'utf8')}<<<<<<< HEAD\n`);
  const r = p.run('--check');
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/effects\.lock:\d+: not a line/);
});

test('a syntax error writes nothing', () => {
  const p = project(before);
  rmSync(path.join(p.cwd, 'effects.lock'));
  p.edit('module pay\n\npub fn (\n');
  expect(p.run('--write').status).toBe(1);
  expect(existsSync(path.join(p.cwd, 'effects.lock'))).toBe(false);
});

test('a lock with CRLF line endings reads the same', () => {
  expect(parseLock('# header\r\n\r\na.candor\r\n  f: uses io, net\r\n')).toEqual({ fns: [{ file: 'a.candor', name: 'f', uses: ['io', 'net'] }] });
});

test('an impl method, whose name has spaces, survives the round trip', () => {
  const parsed = parseLock('a.candor\n  Saves for Box<int>.save: uses io\n');
  expect(parsed).toEqual({ fns: [{ file: 'a.candor', name: 'Saves for Box<int>.save', uses: ['io'] }] });
});

test('--write and --check are for effects, and take no --full', () => {
  const p = project(before);
  expect(p.run('--write', '--full').stderr).toContain('leave out --full');
  expect(p.run('--write', '--check').stderr).toContain('one at a time');
  const r = spawnSync(process.execPath, ['run', cli, 'check', '--write', 'pay.candor'], { cwd: p.cwd, encoding: 'utf8' });
  expect(r.stderr).toContain('--write is for effects');
});

test('the same change is found whichever order the lock lists things', () => {
  expect(diffLock([{ file: 'b.candor', name: 'g', uses: ['net'] }, { file: 'a.candor', name: 'f', uses: ['io'] }], [])).toEqual([
    { file: 'a.candor', line: null, name: 'f', gained: [], lost: ['io'] },
    { file: 'b.candor', line: null, name: 'g', gained: [], lost: ['net'] },
  ]);
});
