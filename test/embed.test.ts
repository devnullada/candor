import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 144: `embed("path")` builds a file into the program when it compiles (Go's //go:embed):
// a string, or with `embed<Bytes>` its bytes. For fixtures in tests, and files an app serves.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'embed');

const setup = () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'testdata'), { recursive: true });
  mkdirSync(path.join(dir, 'lib', 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'testdata', 'feed.xml'), '<rss><title>café</title></rss>\n');
  writeFileSync(path.join(dir, 'testdata', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
  writeFileSync(path.join(dir, 'lib', 'assets', 'greet.txt'), 'hello from lib');
  // A module's paths are relative to its own file.
  writeModule(path.join(dir, 'lib', 'greet.candor'), 'module greet\n\npub fn greeting() -> string {\n  return embed("assets/greet.txt")\n}\n');
};

const diags = (body: string) =>
  compileSplit(`module m\n\nfn f() -> int {\n${body}\n  return 0\n}\n\nfn main() {}\n`, path.join(dir, 'm.candor'))
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.message, d.help]);

test('embed reads a file next to the program: errors when it cannot', () => {
  setup();
  expect(diags('  let a = embed("testdata/feed.xml")\n  let b: Bytes = embed<Bytes>("testdata/logo.png")\n  let n = a.length() + b.length()')).toEqual([]);
  const missing = diags('  let a = embed("testdata/nope.xml")');
  expect(missing[0][0]).toStartWith('cannot read testdata/nope.xml (');
  expect(missing[0][1]).toBe('the path is relative to this file');
  expect(diags('  let a = embed("testdata")')).toEqual([['testdata is a folder, and `embed` takes a file', 'embed each file in it']]);
  expect(diags('  let a = embed("testdata/logo.png")')).toEqual([
    ["testdata/logo.png is not UTF-8 text, so it can't be a string", 'write `embed<Bytes>("testdata/logo.png")` for its bytes'],
  ]);
  const p = 'testdata/feed.xml';
  expect(diags(`  let p = "${p}"\n  let a = embed(p)`)).toEqual([
    ['`embed` takes the path of a file, as a string literal: the file is read when the program compiles', 'write `embed("testdata/feed.xml")`, relative to this file'],
  ]);
  expect(diags('  let a = embed<int>("testdata/feed.xml")')).toEqual([['`embed` gives a file as a `string` or as `Bytes`', 'write `embed("path")` for text, `embed<Bytes>("path")` for any file']]);
  // A function of the program's own named `embed` is that function.
  expect(compileSplit('module m\n\nfn embed(s: string) -> int {\n  return s.length()\n}\n\nfn main() {\n  let n = embed("x")\n}\n', path.join(dir, 'm.candor')).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
});

test('runs: a fixture in a test, bytes, a module embedding its own file', () => {
  setup();
  writeModule(
    path.join(dir, 'app.candor'),
    `module app

import "lib/greet"

fn main() uses io {
  io.println(greet.greeting())
  io.println("\${embed<Bytes>("testdata/logo.png").toHex()}")
}

test "fixtures" {
  let feed = embed("testdata/feed.xml")
  assert feed.contains("café")
  assert embed<Bytes>("testdata/logo.png").length() == 6
  assert greet.greeting() == "hello from lib"
}
`,
  );
  const run = (cmd: string) =>
    spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'app.candor'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });
  const t = run('test');
  expect(t.stderr).toBe('');
  expect(t.stdout).toContain('1 passed, 0 failed');
  const r = run('run');
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('hello from lib\n89504e4700ff\n');
}, 300_000);
