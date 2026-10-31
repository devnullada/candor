import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { lex } from '../src/lexer';

// Card 135: a line starting with `.name` continues the expression above; `.Variant` doesn't.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const src = `module chains

enum Fail {
  Empty
  Odd
}

fn check(n: int) -> Result<int, Fail> {
  if n == 0 {
    return Err(.Empty)
  }
  return if n % 2 == 1 { Err(.Odd) } else { Ok(n) }
}

fn label(f: Fail) -> string {
  return match f {
    .Empty => "empty"
    .Odd => "odd"
  }
}

fn total(xs: List<int>) -> Result<int, string> {
  let evens = xs
    .filter((x) => x > 0)

    // only the even ones
    .map((x) => check(x).mapErr(label))
  let mut sum = 0
  for e in evens {
    sum += e
      .mapErr((s) => "bad: \${s}")?
  }
  return Ok(sum)
}

fn main() uses io {
  io.println("\${total([2, 4, -1])}")
  io.println("\${total([2, 3])}")
  io.println([3, 1, 2]
    .sorted()
    .map((x) => "\${x}")
    .join(","))
}
`;

test('the newline before `.name` goes; before `.Variant` and `..` it stays', () => {
  const kinds = (s: string) => lex(s, 't.candor').map((t) => (t.kind === 'newline' ? 'NL' : t.text)).join(' ');
  expect(kinds('a\n  .b()\n')).toBe('a . b ( ) NL ');
  expect(kinds('a\n  // c\n\n  ._b\n')).toBe('a . _b NL ');
  expect(kinds('a\n.B\n')).toBe('a NL . B NL ');
  expect(kinds('a\n..b\n')).toBe('a NL .. b NL ');
});

test('chains, a comment and a blank line between, match arms of `.Variant` unchanged', () => {
  expect(compile(src, 'chains.candor').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const dir = path.join(tmpdir(), 'candor-test', 'leading-dot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'chains.candor'), src);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'chains.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('Ok(6)\nErr("bad: odd")\n1,2,3\n');
}, 120_000);
