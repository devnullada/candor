import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `fold`'s `[]`, `[:]` or `none` start takes its type from the lambda's annotated `acc`;
// so does an empty argument to a generic function, from a lambda argument's annotated parameter.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const diagnostics = (src: string) =>
  compile(src, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.message} | ${d.help ?? ''}`);

const program = `module folds

struct Report {
  name: string,
  size: int,
}

fn apply<A>(start: A, f: fn(A) -> A) -> A {
  return f(start)
}

fn main() uses io {
  io.println("\${apply([], (acc: List<int>) => acc.concat([7])).length()}")
  let xs = ["a", "bb", "ccc", "bb"]
  let reports = xs.fold([], (acc: List<Report>, x) => acc.concat([Report { name: x, size: x.length() }]))
  io.println("\${reports.length()} \${reports[2].map((r) => r.name) ?? "-"}")
  let counts = xs.fold([:], (acc: Map<string, int>, x) => {
    let mut m = acc
    m[x] = (m[x] ?? 0) + 1
    return m
  })
  io.println("\${counts["bb"] ?? 0} \${counts.length()}")
  let longest = xs.fold(none, (acc: string?, x) => if x.length() > (acc ?? "").length() { x } else { acc })
  io.println(longest ?? "-")
}
`;

test('an annotated acc gives the empty start its type, and it runs', () => {
  expect(diagnostics(program)).toEqual([]);
  const dir = path.join(tmpdir(), 'candor-test', 'fold-start');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'folds.candor');
  writeFileSync(file, program);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('1\n4 ccc\n2 3\nccc\n');
}, 300_000);

const fold = (call: string) => `module m

fn f(xs: List<int>) -> int {
  let r = ${call}
  return 0
}

fn main() {}
`;

test('without an annotation the empty start is still CAN0032, with help to annotate acc', () => {
  expect(diagnostics(fold('xs.fold([], (acc, x) => acc.concat([x]))'))).toEqual([
    "CAN0032 cannot tell what this empty list holds | annotate the lambda's `acc`: `xs.fold([], (acc: List<int>, x) => ...)`",
  ]);
  expect(diagnostics(fold('xs.fold([:], (acc, x) => acc)'))[0]).toContain('`xs.fold([:], (acc: Map<string, int>, x) => ...)`');
  expect(diagnostics(fold('xs.fold(none, (acc, x) => acc)'))[0]).toContain("`none` doesn't say what the result holds");
});

test('a wrong acc annotation is reported once, by the lambda', () => {
  const errs = diagnostics(fold('xs.fold([], (acc: List<Nope>, x) => acc)'));
  expect(errs.length).toBe(1);
  expect(errs[0]).toContain('Nope');
  expect(diagnostics(fold('xs.fold([], (acc: List<string>, x) => acc.concat([x]))')).length).toBe(1);
});
