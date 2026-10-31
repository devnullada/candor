import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Card 158: `continue` and `break` leave a match arm or an if branch as `return` does, so the
// other arms give the value: `let v = match r { Ok(v) => v, Err(_) => continue }`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const errors = (src: string) =>
  compile(src, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

const program = `module loops

enum Op {
  Add { n: int },
  Skip,
  Stop,
}

fn parse(s: string) -> Result<int, string> {
  return if s == "x" { Err("bad") } else { Ok(s.length()) }
}

fn twice(n: int) -> int {
  return n * 2
}

// A match arm and an if branch, in a let.
fn total(xs: List<string>) -> int {
  let mut sum = 0
  for s in xs {
    let v = match parse(s) {
      Ok(v) => v,
      Err(_) => continue,
    }
    let w = if v > 5 { break } else { v * 2 }
    sum = sum + w
  }
  return sum
}

// Inside an argument, after \`&&\`, in interpolation; \`break\` from an enum's arm.
fn run(ops: List<Op>) -> int {
  let mut sum = 0
  for op in ops {
    let n = match op {
      Op.Add { n } => n,
      Op.Skip => continue,
      Op.Stop => break,
    }
    sum = sum + twice(match n { 0 => continue, _ => n })
    let big = n > 100 && if n > 1000 { break } else { true }
    let label = "\${if big { "big" } else { continue }}"
    sum = sum + label.length()
  }
  return sum
}

// In a while, an if nested in an arm.
fn spin(xs: List<int>) -> int {
  let mut i = 0
  let mut seen = 0
  while i < xs.length() {
    i = i + 1
    let x = xs[i - 1] ?? 0
    seen = seen + match x {
      1 => 1,
      _ => if x > 50 { break } else { 2 },
    }
  }
  return seen
}

fn main() uses io {
  io.println("\${total(["ab", "x", "abc", "abcdefg", "a"])}")
  io.println("\${run([Op.Add { n: 1 }, Op.Skip, Op.Add { n: 0 }, Op.Add { n: 200 }, Op.Add { n: 5000 }, Op.Add { n: 3 }])}")
  io.println("\${run([Op.Add { n: 2 }, Op.Stop, Op.Add { n: 3 }])}")
  io.println("\${spin([1, 3, 1, 99, 1])}")
}
`;

test('continue and break arms check, and run as the loop says', () => {
  expect(errors(program)).toEqual([]);
  const dir = path.join(tmpdir(), 'candor-test', 'loop-arms');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'loops.candor');
  writeFileSync(file, program);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('10\n10405\n4\n4\n');
}, 300_000);

test('outside a loop they are still errors, and arms that all leave give no value', () => {
  expect(
    errors(`module m

fn f(xs: List<int>) -> int {
  for x in xs {
    let y = match x {
      1 => continue,
      _ => break,
    }
    let z = if x > 2 { continue } else { break }
  }
  return 0
}

fn g() -> int {
  let v = if true { continue } else { 2 }
  return v
}

fn main() {}
`),
  ).toEqual([
    'every arm of this `match` returns, breaks or continues, so it has no value',
    'every branch of this `if` returns, breaks or continues, so it has no value',
    '`continue` outside a loop',
  ]);
});
