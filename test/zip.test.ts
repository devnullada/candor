import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `bytes.unzip(b, maxBytes)`, a zip archive in memory read into its files. The
// fixtures (test/fixtures/zip) are made by real tools: bsdtar (Windows' tar.exe, deflate with a
// data descriptor), PowerShell's Compress-Archive, Python's zipfile (stored, bzip2, zeros), and
// from stored.zip a flipped data byte, a cut, and the encrypted flag set.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function candorTest(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'zip', name);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(import.meta.dir, 'fixtures', 'zip'), path.join(dir, 'testdata'), { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const tests = `module m

import "bytes"

fn names(r: Result<List<bytes.ZipEntry>, string>) -> List<string> {
  return r.ok().map((es) => es.map((e) => "\${e.name} \${e.size}")) ?? []
}

fn err(r: Result<List<bytes.ZipEntry>, string>) -> string {
  return match r {
    Ok(_) => "ok",
    Err(e) => e,
  }
}

test "deflate with a data descriptor (bsdtar) and without (Compress-Archive)" {
  let report = embed<Bytes>("testdata/src/report.xml")
  for z in [embed<Bytes>("testdata/bsdtar.zip"), embed<Bytes>("testdata/dotnet.zip")] {
    let entries = bytes.unzip(z, 1_000_000).ok() ?? []
    assert entries.length() == 1
    assert entries[0].map((e) => e.name) == "report.xml"
    assert entries[0].map((e) => e.data) == report
    assert entries[0].map((e) => e.size) == report.length()
  }
}

test "stored entries, folders left out" {
  let entries = bytes.unzip(embed<Bytes>("testdata/stored.zip"), 1_000_000).ok() ?? []
  assert entries.map((e) => e.name) == ["reports/a.txt", "b.txt"]
  assert entries[0].map((e) => e.data.toText() ?? "") == "stored, not deflated\\n"
}

test "what it won't read, and why" {
  assert err(bytes.unzip(embed<Bytes>("testdata/badcrc.zip"), 1_000_000)) == "reports/a.txt doesn't match its CRC-32: the archive is damaged"
  assert err(bytes.unzip(embed<Bytes>("testdata/truncated.zip"), 1_000_000)) == "not a zip archive, or cut short"
  assert err(bytes.unzip("hello".toBytes(), 1_000_000)) == "not a zip archive, or cut short"
  assert err(bytes.unzip(embed<Bytes>("testdata/bzip2.zip"), 1_000_000)) == "a.txt uses compression method 12 (bzip2); Candor reads stored (0) and deflate (8)"
  assert err(bytes.unzip(embed<Bytes>("testdata/encrypted.zip"), 1_000_000)) == "reports/a.txt is encrypted; Candor reads unencrypted entries"
}

test "maxBytes caps what it inflates to" {
  let zeros = embed<Bytes>("testdata/zeros.zip")
  assert zeros.length() < 5000
  assert err(bytes.unzip(zeros, 1_000_000)) == "the archive inflates to more than 1000000 bytes"
  assert names(bytes.unzip(zeros, 2_000_000)) == ["zeros.bin 2000000"]
  assert err(bytes.unzip(embed<Bytes>("testdata/stored.zip"), 25)) == "the archive inflates to more than 25 bytes"
}
`;

test('bytes.unzip: stored and deflate, CRC checked, capped, errors that say why', () => {
  const r = candorTest('unzip', tests);
  expect(r.stderr).toBe('');
  expect(r.stdout).toEndWith('4 passed, 0 failed\n');
}, 120_000);
