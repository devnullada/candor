import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 105: `import "hash"`, digests and HMACs as Bytes, and files hashed a piece at a time,
// on disk for `main` and in memory in a test.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(cmd: 'run' | 'test' | 'check', src: string) {
  const dir = path.join(tmpdir(), 'candor-test', `hash-${cmd}`);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const fox = 'The quick brown fox jumps over the lazy dog';

const src = `module m

import "fs"
import "hash"

fn main() uses io, fs {
  let data = "abc".toBytes()
  io.println(hash.sha1(data).toHex())
  io.println(hash.sha256(data).toHex())
  io.println(hash.sha512(data).toHex())
  io.println(hash.md5(data).toHex())
  let key = "key".toBytes()
  let msg = "${fox}".toBytes()
  io.println(hash.hmacSha256(key, msg).toHex())
  io.println(hash.hmacSha512(key, msg).toBase64())
  io.println(hash.hmacSha1(key, msg).toHex())
  let sig = hash.hmacSha256(key, msg)
  io.println("\${hash.equal(sig, hash.hmacSha256(key, msg))} \${hash.equal(sig, hash.hmacSha256("kez".toBytes(), msg))} \${hash.equal(sig, sig.slice(0, 4))}")
  match fs.write("big.txt", "abc".repeat(100_000)) {
    Ok() => {},
    Err(e) => io.println(e.toString()),
  }
  match hash.sha256File("big.txt") {
    Ok(d) => io.println(d.toHex()),
    Err(e) => io.println(e.toString()),
  }
  match hash.md5File("missing.txt") {
    Ok(d) => io.println(d.toHex()),
    Err(e) => io.println(e.toString()),
  }
}

test "a file in memory hashes as its bytes" {
  assert fs.write("a.wav", "RIFF") == Ok()
  assert hash.sha1File("a.wav") == Ok(hash.sha1("RIFF".toBytes()))
  assert hash.sha512File("nope") == Err(fs.FsError.NotFound { path: "nope" })
}
`;

const hex = (algo: string, s: string) => createHash(algo).update(s).digest('hex');

test('digests, HMACs and files match Node', () => {
  const r = cli('run', src);
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n').map((l) => l.trim())).toEqual([
    hex('sha1', 'abc'),
    hex('sha256', 'abc'),
    hex('sha512', 'abc'),
    hex('md5', 'abc'),
    createHmac('sha256', 'key').update(fox).digest('hex'),
    createHmac('sha512', 'key').update(fox).digest('base64'),
    createHmac('sha1', 'key').update(fox).digest('hex'),
    'true false false',
    hex('sha256', 'abc'.repeat(100_000)),
    'missing.txt: not found',
  ]);
}, 120_000);

test('in a test, files hash from memory', () => {
  const r = cli('test', src);
  expect(r.stdout + r.stderr).toContain('1 passed');
}, 120_000);
