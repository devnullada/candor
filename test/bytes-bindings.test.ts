import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Bytes through Go bindings, copied both ways as List<string> is.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

test('a binding takes and gives Bytes, copied each way', () => {
  const r = compileSplit('module b\nextern "bytes" {\n  fn ToUpper(s: Bytes) -> Bytes as upper\n}\nfn main() uses io {\n  io.println(upper("a".toBytes()).toHex())\n}\n', 'b.candor');
  expect(r.diagnostics).toEqual([]);
  expect(r.bindings).toContain('[A0 ~[]byte, R ~[]byte]');
  expect(r.bindings).toContain('A0(slices.Clone(a0))');
  expect(r.bindings).toContain('return slices.Clone([]byte(f(A0(slices.Clone(a0)))))');
});

const program = `module bb

import "bytes"

extern "encoding/hex" {
  fn Decode(dst: Bytes, src: Bytes) -> Result<int, GoError> as decode
}

extern "bytes" {
  fn ToUpper(s: Bytes) -> Bytes as upper
  fn CutPrefix(s: Bytes, prefix: Bytes) -> Bytes? as cutPrefix
}

extern "encoding/json" {
  fn Valid(data: Bytes) -> bool as validJson
}

extern "./native" {
  fn Keep(b: Bytes) -> Bytes as keep
  fn Scribble() as scribble
}

test "Go writing into what it was given leaves the Candor value as it was" {
  let dst = bytes.fromList([0, 0])
  assert decode(dst, "cafe".toBytes()).isOk()
  assert dst.toList() == [0, 0]
}

test "Go changing a slice it gave back later leaves the Candor value as it was" {
  let mine = "abc".toBytes()
  let back = keep(mine)
  scribble()
  assert back.toText() == "abc"
  assert mine.toText() == "abc"
}

test "Bytes in results and options" {
  assert upper("héllo".toBytes()).toText() == "HÉLLO"
  assert cutPrefix("a=b".toBytes(), "a=".toBytes()).map((b) => b.toHex()) == "62"
  assert cutPrefix("ab".toBytes(), "=".toBytes()) == none
  assert validJson("[1]".toBytes())
  assert !validJson(bytes.fromList([255]))
}
`;

const native = `// Package native keeps the slice it was given, and changes it when asked.
package native

var kept []byte

func Keep(b []byte) []byte {
\tkept = b
\treturn b
}

func Scribble() {
\tfor i := range kept {
\t\tkept[i] = 'x'
\t}
}
`;

test(
  'Go sees a copy, and Candor gets one',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'bytes-bindings');
    mkdirSync(path.join(dir, 'native'), { recursive: true });
    writeFileSync(path.join(dir, 'native', 'native.go'), native);
    const file = path.join(dir, 'bb.candor');
    writeModule(file, program);
    const r = spawnSync(process.execPath, ['--no-env-file', 'run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('3 passed, 0 failed');
  },
  120_000,
);
