import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompileResult } from '../src/compile';
import { prepareModule } from '../src/go';
import { writeModule } from './split';

// Every std module with Go dependencies in one program: their pins have to agree, or `go get`
// refuses the lot (the console port, 0.0.19: x/crypto v0.58.0 needs x/text v0.43.0, `mime` pinned v0.42.0).

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'std-together');

const src = `module together

import "crypto"
import "fs"
import "html"
import "http"
import "imap"
import "mime"
import "smtp"
import "sql"
import "xml"

fn main() -> Result<void, string> uses io {
  let key = crypto.deriveKey("pass", "saltsaltsaltsalt".toBytes(), crypto.Argon2 { time: 1, memoryKiB: 64, threads: 1 })
  io.println("\${key.length()} \${html.toText("<p>ok</p>")} \${xml.parse("<a>x</a>").map((n) => n.text())}")
  let m = mime.parse("Subject: hi\\r\\n\\r\\nbody".toBytes()).mapErr((e) => "\${e}")?
  io.println(mime.header(m, "Subject").join(","))
  return Ok()
}

// Never called: here so the program needs fs.watch's fsnotify too.
fn watching(p: string) -> Result<int, fs.FsError> uses fs {
  return fs.watch(p, 0, (n, c) => fs.Step.Stop { value: n })
}

test "builds in a test too" {
  assert html.toText("<b>x</b>") == "x"
}
`;

function cli(cmd: 'run' | 'test') {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'together.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'together.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

test('crypto, fs.watch, html, http, imap, mime, smtp, sql and xml build and run together', () => {
  const r = cli('run');
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('32 ok Ok("x")\nhi\n');
}, 300_000);

test('and test together', () => {
  const r = cli('test');
  expect(r.stdout).toContain('1 passed, 0 failed');
}, 300_000);

// A failed `go get` leaves go.mod without requirements; the stamp of the last good get must go
// with it, or going back to those pins skips the get and the build can't find the packages.
test('a failed get leaves no stamp behind', () => {
  const out = path.join(dir, 'stamp');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'go.requires'), 'from a good get');
  writeFileSync(path.join(out, 'go.mod'), 'module candorapp\n');
  const result = { localPackages: [], embeds: [], goRequires: [{ path: 'example.com/nope', version: 'v1.0.0' }] } as unknown as CompileResult;
  expect(prepareModule(path.join(dir, 'no-such-go'), result, out)).toContain('cannot get the Go packages');
  expect(existsSync(path.join(out, 'go.requires'))).toBe(false);
});
