import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `checked*` give `none` where the operators panic; constant expressions that overflow
// or divide by zero are compile errors (CAN0017, CAN0018) with help that names the run-time way.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'checked-ints', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const diags = (body: string) => compile(`module m\n\nfn main() uses io {\n${body}\n}\n`, 'm.candor').diagnostics.filter((d) => d.severity === 'error');

test('checked methods give none on overflow and a zero divisor', () => {
  const r = run(
    'checked',
    `module m

fn show(v: int?) -> string {
  match v {
    none => return "none"
    n => return n.toString()
  }
}

fn main() uses io {
  let max = 9_223_372_036_854_775_807
  let min = -9_223_372_036_854_775_808
  let zero = 0
  let minusOne = -1
  io.println(show(max.checkedAdd(1)))
  io.println(show(max.checkedAdd(-1)))
  io.println(show(min.checkedSub(1)))
  io.println(show(min.checkedAdd(max)))
  io.println(show(6.checkedMul(7)))
  io.println(show(max.checkedMul(2)))
  io.println(show(min.checkedMul(minusOne)))
  io.println(show(zero.checkedMul(max)))
  io.println(show(7.checkedDiv(zero)))
  io.println(show(min.checkedDiv(minusOne)))
  io.println(show((-7).checkedDiv(2)))
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe(
    ['none', '9223372036854775806', 'none', '-1', '42', 'none', 'none', '0', 'none', 'none', '-3', ''].join('\n'),
  );
}, 120_000);

test('constant overflow and division by zero are compile errors with help', () => {
  const [over] = diags('  let x = 9_223_372_036_854_775_807 + 1\n  io.println(x.toString())');
  expect(over.code).toBe('CAN0017');
  expect(over.message).toContain('9223372036854775808');
  expect(over.help).toContain('wrappingAdd');
  const [div] = diags('  let y = 1 / 0\n  io.println(y.toString())');
  expect(div.code).toBe('CAN0018');
  expect(div.message).toContain('always 0');
  expect(div.help).toContain('checkedDiv');
  const [rem] = diags('  let y = 1 % (2 - 2)\n  io.println(y.toString())');
  expect(rem.code).toBe('CAN0018');
  expect(rem.help).toContain('b != 0');
});

test('names are not folded; the smallest int is a valid literal', () => {
  expect(diags('  let n = 9_223_372_036_854_775_807\n  let z = n + 1\n  io.println(z.toString())')).toEqual([]);
  expect(diags('  let m = -9_223_372_036_854_775_808\n  io.println(m.toString())')).toEqual([]);
  expect(diags('  let w = -(4_611_686_018_427_387_903 * 2 + 1) - 1\n  io.println(w.toString())')).toEqual([]);
});
