import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Card 104: a name on a `T?` in a pattern takes the whole value, `none` included, unless the
// arms above took `none` in its place; then it is the present value, as before.

const diags = (src: string) => compile(`module m\n${src}\nfn main() {}\n`, 'm.candor').diagnostics.map((d) => `${d.severity} ${d.message}`);

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(src: string): string {
  const dir = path.join(tmpdir(), 'candor-test', 'optional-bindings');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 't.candor'), src);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  return r.stdout.replace(/\r\n/g, '\n');
}

const check = `enum Check {
  File { path: string, bytes: int?, suffix: string? }
  Dns { name: string, expect: string? }
}`;

test('one arm takes a variant with optional fields, the names optional', () => {
  expect(
    diags(`${check}
fn f(c: Check) -> string {
  return match c {
    .File { path, bytes, suffix } => "\${path} \${bytes ?? 0} \${suffix ?? "-"}",
    .Dns { name, expect } => "\${name} \${expect ?? "any"}",
  }
}`),
  ).toEqual([]);
});

test('after arms taking `none`, a name is the present value: the four-arm form still checks', () => {
  expect(
    diags(`${check}
fn f(c: Check) -> int {
  return match c {
    .File { path: _, bytes: none, suffix: none } => 0,
    .File { path: _, bytes, suffix: none } => bytes + 1,
    .File { path: _, bytes: none, suffix } => suffix.length(),
    .File { path: _, bytes, suffix } => bytes + suffix.length(),
    .Dns { name: _, expect: none } => 0,
    .Dns { name: _, expect } => expect.length(),
  }
}`),
  ).toEqual([]);
});

test('`none => ...` then a name narrows the name; a name alone covers everything', () => {
  expect(
    diags(`fn f(t: int?) -> int {
  return match t {
    none => 0,
    t => t + 1,
  }
}
fn g(t: int?) -> int {
  return match t {
    x => x ?? 0,
  }
}
fn h(p: (int, int?)) -> int {
  return match p {
    (a, none) => a,
    (a, b) => a + b,
  }
}
fn k(r: Result<int?, string>) -> int {
  return match r {
    Ok(n) => n ?? 0,
    Err(_) => -1,
  }
}`),
  ).toEqual([]);
});

test('a name used as the present value when it may be none is an error', () => {
  const d = diags(`${check}
fn f(c: Check) -> int {
  return match c {
    .File { path: _, bytes, suffix: _ } => bytes + 1,
    .Dns { name: _, expect: _ } => 0,
  }
}`);
  expect(d.some((x) => x.startsWith('error') && x.includes('int?'))).toBe(true);
});

test('runs: whole names and present names bind the right values', () => {
  const out = run(`module m
${check}
fn one(c: Check) -> string {
  return match c {
    .File { path, bytes, suffix } => "\${path} \${bytes ?? -1} \${suffix ?? "-"}",
    .Dns { name, expect: none } => "\${name} any",
    .Dns { name, expect } => "\${name} \${expect.length()}",
  }
}
fn main() uses io {
  io.println(one(Check.File { path: "a", bytes: 3, suffix: none }))
  io.println(one(Check.File { path: "b", bytes: none, suffix: ".wav" }))
  io.println(one(Check.Dns { name: "c", expect: none }))
  io.println(one(Check.Dns { name: "d", expect: "xyz" }))
}
`);
  expect(out).toBe('a 3 -\nb -1 .wav\nc any\nd 3\n');
}, 120_000);
