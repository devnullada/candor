import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { argon2Sync, createDecipheriv, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 119: `random.bytes`, and `crypto`: AES-256-GCM `seal`/`open`, argon2id `deriveKey`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'crypto');

function cli(src: string, ...args: string[]) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const tests = `module m

import "crypto"

fn cheap() -> crypto.Argon2 {
  return crypto.Argon2 { time: 1, memoryKiB: 64, threads: 1 }
}

test "seal and open" {
  let key = random.bytes(32)
  let sealed = crypto.seal(key, "hunter2".toBytes())
  assert sealed.length() == 7 + 28
  assert crypto.open(key, sealed).map((b) => b.toText()) == Ok("hunter2")
  assert crypto.seal(key, "hunter2".toBytes()) != sealed
  assert crypto.open(key, crypto.seal(key, "".toBytes())).map((b) => b.length()) == Ok(0)
}

test "a wrong key, a changed byte, too few bytes" {
  let key = random.bytes(32)
  let sealed = crypto.seal(key, "hunter2".toBytes())
  assert crypto.open(random.bytes(32), sealed) == Err("wrong key, or the bytes were changed")
  let mut xs = sealed.toList()
  xs[20] = ((xs[20] ?? 0) + 1) % 256
  assert crypto.open(key, bytes.fromList(xs)) == Err("wrong key, or the bytes were changed")
  assert crypto.open(key, sealed.slice(0, 27)) == Err("too short to be sealed")
}

test "the seeded fake seals the same bytes every run" {
  let key = random.bytes(32)
  random.seed(3)
  let a = crypto.seal(key, "x".toBytes())
  random.seed(3)
  assert crypto.seal(key, "x".toBytes()) == a
  assert random.bytes(0).length() == 0
}

test "deriveKey: the same inputs, the same key" {
  let salt = random.bytes(16)
  let key = crypto.deriveKey("correct horse", salt, cheap())
  assert key.length() == 32
  assert crypto.deriveKey("correct horse", salt, cheap()) == key
  assert crypto.deriveKey("correct horse", random.bytes(16), cheap()) != key
  assert crypto.deriveKey("correct horse", salt, crypto.Argon2 { ...cheap(), time: 2 }) != key
  assert crypto.open(key, crypto.seal(key, "x".toBytes())).isOk()
}

test "a short key panics, and doesn't show the key" {
  crypto.seal(random.bytes(16), "x".toBytes())
}
`;

test(
  'seal, open and deriveKey in test blocks; a short key panics',
  () => {
    const r = cli(tests.replace('import "crypto"', 'import "crypto"\nimport "bytes"'), 'test');
    expect(r.stdout).toContain('4 passed, 1 failed');
    expect(r.stdout).toContain("a short key panics, and doesn't show the key");
    expect(r.stdout + r.stderr).toContain('crypto.seal: the key is 16 bytes; it must be 32');
  },
  120_000,
);

// What Candor seals, Node opens; the key Candor derives, Node derives too.
const program = `module m

import "crypto"
import "hash"

fn main() uses io, random {
  let costs = crypto.Argon2 { time: 2, memoryKiB: 64, threads: 1 }
  io.println(crypto.deriveKey("password", "somesalt".toBytes(), costs).toHex())
  let key = hash.sha256("k".toBytes())
  io.println(crypto.seal(key, "the vault".toBytes()).toHex())
}
`;

test(
  'interoperates: Node opens what Candor sealed, and derives the same argon2id key',
  () => {
    const r = cli(program, 'run');
    expect(r.stderr).toBe('');
    const [derived, sealedHex] = r.stdout.trim().split(/\r?\n/);
    const want = argon2Sync('argon2id', { message: 'password', nonce: 'somesalt', parallelism: 1, tagLength: 32, memory: 64, passes: 2 });
    expect(derived).toBe(want.toString('hex'));

    const sealed = Buffer.from(sealedHex, 'hex');
    const key = createHash('sha256').update('k').digest();
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
    expect(plain.toString()).toBe('the vault');
  },
  120_000,
);
