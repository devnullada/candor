import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Card 116: bits as methods on int (`and`, `or`, `xor`, `not`, `shl`, `shr`, `ushr`), and
// `0x` / `0b` literals for the masks.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'bits', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const errors = (body: string) =>
  compile(`module m\n\nfn main() uses io {\n${body}\n}\n`, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

test('FNV-1a in 32 bits, and the literals', () => {
  const r = run(
    'fnv',
    `module m

fn fnv1a(s: string) -> int {
  let mut h = 0x811c_9dc5
  for b in s.toBytes().toList() {
    h = h.xor(b).wrappingMul(0x0100_0193).and(0xffff_ffff)
  }
  return h
}

fn main() uses io {
  io.println(fnv1a("abc").toString())
  io.println("\${0xff} \${0XF} \${0b1010} \${0b1000_0000} \${0x7fff_ffff_ffff_ffff}")
  let n = -1
  io.println("\${n.ushr(56)} \${n.shr(56)} \${n.shl(63)} \${12.and(10)} \${12.or(3)} \${12.xor(10)} \${12.not()}")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n')).toEqual([String(0x1a47e90b), '255 15 10 128 9223372036854775807', '255 -1 -9223372036854775808 8 15 6 -13']);
}, 120_000);

test('a shift by 64 panics with the count', () => {
  const r = run('shift', `module m\n\nfn main() uses io {\n  let k = 64\n  io.println(1.shl(k).toString())\n}\n`);
  expect(r.stderr).toContain('shl(): (1).shl(64) shifts by 64; the count is 0 to 63');
}, 120_000);

test('malformed literals say how to write them', () => {
  expect(errors('  let a = 0x\n  io.println(a.toString())')[0]).toContain('`0x`: write digits after the prefix');
  expect(errors('  let a = 0x_1\n  io.println(a.toString())')[0]).toContain('a separator only between two');
  expect(errors('  let a = 0b12\n  io.println(a.toString())').length).toBeGreaterThan(0);
  expect(errors('  let a = 0x8000_0000_0000_0000\n  io.println(a.toString())')[0]).toContain('9223372036854775808');
});
