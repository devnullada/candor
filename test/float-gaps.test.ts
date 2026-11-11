import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

// `min`/`max` on numbers and lists, `pow`, `int.abs`, float `%`, floats in Go bindings.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'float-gaps', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['--no-env-file', 'run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const diags = (src: string) =>
  compileSplit(src, 'f.candor', 'test')
    .diagnostics.filter((d) => d.code !== Codes.UnusedEffect)
    .map((d) => [d.code, d.message, d.help ?? '']);
const body = (stmts: string) => `module f\nfn f(xs: List<float>, x: float, n: int) -> int uses io {\n${stmts}\n  return 0\n}\n`;

test('types: number min/max keep their type; a list gives an optional; `%` and `%=` take floats', () => {
  expect(diags(body('  let a: int = n.max(3).min(9).abs().pow(2)\n  let b: float = x.max(1.0).min(2.0).pow(0.5) % 2.0\n  let c: float? = xs.max()\n  let mut d = x\n  d %= 3.0\n  io.println("${a}${b}${c ?? d}")'))).toEqual([]);
  expect(diags(body('  io.println(n.max(1.5).toString())'))[0][0]).toBe(Codes.TypeMismatch);
});

test('a list min/max needs ordered items, and says how to go by a key', () => {
  const src = 'module f\nstruct Job {\n  at: int\n}\nfn f(jobs: List<Job>) -> Job? {\n  return jobs.min()\n}\n';
  expect(diags(src)).toEqual([[Codes.InvalidOperands, expect.stringContaining('`min` compares items with `<`'), expect.stringContaining('impl Ord')]]);
  expect(diags(body('  let m = xs.max(1.0)'))[0][1]).toBe('`max` takes 0 arguments, found 1');
});

test('habits from other languages point at the methods', () => {
  expect(diags(body('  let m = Math.max(x, 1.0)'))).toEqual([
    [Codes.UnknownName, 'Candor has no `Math`', 'numbers have the methods: `a.max(b)`, `a.min(b)`, `x.pow(y)`, `x.abs()`, `x.sqrt()`, `x.floor()`; a list has `xs.max()`'],
  ]);
  expect(diags(body('  let m = max(n, 3)'))[0].slice(0, 2)).toEqual([Codes.UnknownName, 'there is no `max` function']);
  expect(diags(body('  let m = pow(x, 2.0)'))[0][2]).toBe('call it on the base: `x.pow(y)`');
  // A function of the program's own by that name is just that.
  expect(diags('module f\nfn max(a: int, b: int) -> int {\n  return a\n}\nfn main() uses io {\n  io.println(max(1, 2).toString())\n}\n')).toEqual([]);
});

test('a binding takes and gives floats, through any Go float type', () => {
  const r = compileSplit('module f\nextern "math" {\n  fn Hypot(p: float, q: float) -> float as hypot\n}\nfn main() uses io {\n  io.println(hypot(3.0, 4.0).toString())\n}\n', 'f.candor');
  expect(r.diagnostics).toEqual([]);
  expect(r.bindings).toContain('[A0 candor.Float, A1 candor.Float, R candor.Float]');
  expect(r.bindings).toContain('return candor.FromGoFloat(float64(f(A0(a0), A1(a1))), "Hypot")');
});

const program = `module gaps

extern "math" {
  fn Hypot(p: float, q: float) -> float as hypot
  fn Inf(sign: int) -> float as inf
  fn Float32frombits(b: int) -> float as float32frombits
  let Pi: float as pi
}

struct Job {
  name: string
  at: int
}

test "min and max" {
  assert 3.max(5) == 5 && 3.min(5) == 3
  assert (2.5).max(-1.0) == 2.5 && (2.5).min(-1.0) == -1.0
  assert [2.5, 1.0, 4.0].min() == 1.0
  assert ["b", "c", "a"].max() == "c"
  assert [(1, "b"), (1, "a")].min() == (1, "a")
  let empty: List<int> = []
  assert empty.max() == empty.min()
  assert empty.max() == none
  let jobs = [Job { name: "late", at: 9 }, Job { name: "early", at: 2 }]
  assert jobs.sortedBy((j) => j.at).first().map((j) => j.name) == "early"
}

test "pow and abs" {
  assert 2.pow(10) == 1024 && 7.pow(0) == 1 && (-2).pow(3) == -8
  assert 3.pow(39) == 4_052_555_153_018_976_267
  assert (-7).abs() == 7
  assert (2.0).pow(0.5) == (2.0).sqrt()
  assert (10.0).pow(-2.0) == 0.01
}

test "float remainder" {
  assert 7.5 % 2.0 == 1.5
  assert -7.5 % 2.0 == -1.5
  assert 7.5 % -2.0 == 1.5
  let mut angle = 370.0
  angle %= 360.0
  assert angle == 10.0
}

test "bindings" {
  assert hypot(3.0, 4.0) == 5.0
  assert float32frombits(1_065_353_216) == 1.0
  assert pi > 3.14 && pi < 3.15
}

test "int pow overflow panics" {
  assert 3.pow(40) > 0
}

test "negative exponent panics" {
  assert 2.pow(-1) > 0
}

test "float pow NaN panics" {
  assert (-8.0).pow(0.5) > 0.0
}

test "float pow overflow panics" {
  assert (10.0).pow(400.0) > 0.0
}

test "remainder by zero panics" {
  let zero = 0.0
  assert 1.0 % zero == 0.0
}

test "infinity from Go panics" {
  assert inf(1) > 0.0
}

test "abs of the smallest int panics" {
  let smallest = -9_223_372_036_854_775_807 - 1
  assert smallest.abs() > 0
}
`;

test('they run: min/max, pow, abs, %, bindings, and the panics', () => {
  const r = candor('gaps', program);
  expect(r.stdout).toContain("panic: integer overflow: 3.pow(40) doesn't fit in an int");
  expect(r.stdout).toContain('panic: pow(): 2.pow(-1) has a negative exponent');
  expect(r.stdout).toContain('panic: pow(): (-8.0).pow(0.5) is not a number');
  expect(r.stdout).toContain("panic: pow(): (10.0).pow(400.0) doesn't fit in a float");
  expect(r.stdout).toContain('panic: division by zero: 1.0 % 0.0');
  expect(r.stdout).toContain('panic: candor: the Go function Inf gave +Inf, which a Candor float never is');
  expect(r.stdout).toContain("panic: integer overflow: (-9223372036854775808).abs() doesn't fit in an int");
  expect(r.stdout).toEndWith('4 passed, 7 failed\n');
}, 120_000);
