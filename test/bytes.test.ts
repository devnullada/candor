import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// `Bytes`, built in, a Go []byte never changed once made; `import "bytes"` makes them,
// `fs.readBytes`/`writeBytes` keep them, JSON holds them as base64 (test/fixtures/bytes.candor).

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const candor = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

function diagnostics(src: string) {
  return compileSplit(src, 'f.candor', 'test').diagnostics.map((d) => `${d.code}: ${d.message}${d.help ? ` | ${d.help}` : ''}`);
}

test('a program writes a binary file, reads it back and dumps it; the same code passes in memory', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'bytes');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [to, from] of [['hexdump', 'bytes'], ['hexdump_test', 'bytes_test']]) writeFileSync(path.join(dir, `${to}.candor`), readFileSync(path.join(root, 'test', 'fixtures', `${from}.candor`), 'utf8'));
  const run = candor(dir, 'run', 'hexdump.candor');
  expect(run.stderr).toBe('');
  expect(run.stdout.replace(/\r\n/g, '\n')).toBe(
    [
      '0000  89 50 4e 47 0d 0a 1a 0a  .PNG....',
      '0008  68 69 2c 20 62 79 74 65  hi, byte',
      '0016  73 0a 00 ff              s...',
      'Ok(none)',
      '{"name":"a.bin","data":"AQID+g=="}',
      '',
    ].join('\n'),
  );
  expect(existsSync(path.join(dir, 'out.bin'))).toBe(false);

  const t = candor(dir, 'test', 'hexdump.candor');
  expect(t.stdout).toContain('4 passed, 1 failed');
  expect(t.stdout).toContain('panic: bytes.fromList: 256 at index 1 is not a byte (0 to 255)');
  expect(existsSync(path.join(dir, 'x.bin'))).toBe(false);
}, 120_000);

test('Bytes lower to []byte; == and Eq dictionaries go through candor.BytesEqual', () => {
  const r = compileSplit(
    'module m\n\nfn same<T: Eq>(a: T, b: T) -> bool {\n  return a == b\n}\n\nfn main() uses io {\n  let b: Bytes = "a".toBytes()\n  io.println("${b == b} ${same(b, b)} ${[b] == [b]}")\n}\n',
    'm.candor',
    'main',
  );
  expect(r.diagnostics).toEqual([]);
  expect(r.go).toContain('[]byte');
  expect(r.go).toContain('candor.BytesEqual(');
});

test('what other languages do with bytes gets the Candor way in the help', () => {
  const ds = diagnostics(
    'module m\n\nfn f(b: Bytes) -> int uses io {\n  io.println("${b}")\n  let c = b + b\n  io.println(b.toString())\n  for x in b {}\n  return b[0] ?? b.len()\n}\n',
  );
  expect(ds).toContainEqual(expect.stringContaining('found Bytes | show them as `${b.toHex()}`, or as text with `b.toText()`'));
  expect(ds).toContainEqual(expect.stringContaining('there is no `+` on Bytes; join them with `a.concat(b)`'));
  expect(ds).toContainEqual(expect.stringContaining('Bytes has no member `toString` | use `toText()`'));
  expect(ds).toContainEqual(expect.stringContaining('cannot loop over Bytes | loop over its bytes as ints: `for x in b.toList()`'));
  expect(ds).toContainEqual(expect.stringContaining('cannot index Bytes | use `.at(i)`'));
  expect(ds).toContainEqual(expect.stringContaining('Bytes has no member `len` | use `length()`'));
});
