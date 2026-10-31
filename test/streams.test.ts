import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// #6ea8241a: readers and writers are functions, `fn(int) -> Result<Bytes?, string>` and
// `fn(Bytes) -> Result<void, string>`. fs opens them in a callback; bytes keeps them in memory.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'streams');

function cli(cmd: 'run' | 'test', files: Record<string, string>) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(files)) writeModule(path.join(dir, name), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'm.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const errors = (src: string) => compileSplit(src, 'm.candor', 'main').diagnostics.map((d) => `${d.code}: ${d.message}`);

// One save and one load, for the disk, the fake and memory alike.
const lib = `module m

import "bytes"
import "fs"
import "json"

struct Item {
  name: string
  n: int
}
impl Json for Item

fn save(items: List<Item>, w: fn(Bytes) -> Result<void, string>) -> Result<void, string> uses w {
  for it in items {
    w("\${it.name},\${it.n}\\n".toBytes())?
  }
  return Ok()
}

fn load(r: fn(int) -> Result<Bytes?, string>) -> Result<List<Item>, string> uses r {
  return bytes.readLines(r, [], (acc: List<Item>, line) => {
    let parts = line.split(",")
    return acc.concat([Item { name: parts[0] ?? "", n: (parts[1] ?? "").toInt() ?? 0 }])
  })
}

// Pure: the writer and the reader are in memory.
fn roundTrip(items: List<Item>) -> Result<List<Item>, string> {
  let b = bytes.collect((w) => save(items, w))?
  return bytes.reading(b, (r) => load(r))
}
`;

test('a program writes and reads files through them; a failed write leaves the file as it was', () => {
  const main = `${lib}
fn main() -> Result<void, string> uses io, fs {
  let items = [Item { name: "a", n: 1 }, Item { name: "b", n: 2 }]
  fs.writing("data.txt", (w) => save(items, w))?
  io.println("\${fs.reading("data.txt", (r) => load(r)) == Ok(items)}")
  fs.writing("data.json", (w) => json.encodeTo(items, w))?
  io.println("\${fs.reading("data.json", (r) => json.decodeFrom<List<Item>>(r)) == Ok(items)}")
  io.println("\${roundTrip(items) == Ok(items)}")
  let failed = fs.writing("data.txt", (w): Result<void, string> => {
    w("half".toBytes())?
    return Err("stopped")
  })
  io.println("\${failed} \${fs.read("data.txt") == Ok("a,1\\nb,2\\n")}")
  match fs.reading("missing.txt", (r) => bytes.readAll(r)) {
    Err(e) => io.println(e),
    Ok(_) => io.println("read"),
  }
  // #02cd3f5b: a log appended, synced, and its torn tail cut.
  fs.append("data.txt", "c,").mapErr((e) => "\${e}")?
  fs.sync("data.txt").mapErr((e) => "\${e}")?
  fs.sync(".").mapErr((e) => "\${e}")?
  fs.truncate("data.txt", 8).mapErr((e) => "\${e}")?
  io.println("\${fs.read("data.txt") == Ok("a,1\\nb,2\\n")} \${fs.truncate("missing.txt", 0)}")
  return Ok()
}
`;
  const r = cli('run', { 'm.candor': main });
  expect(r.stderr).toBe('');
  expect(r.stdout.split('\n')).toEqual(['true', 'true', 'true', 'Err("stopped") true', 'missing.txt: not found', 'true Err(missing.txt: not found)', '']);
  // Nothing left beside the files written.
  expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  expect(readFileSync(path.join(dir, 'data.json'), 'utf8')).toBe('[{"name":"a","n":1},{"name":"b","n":2}]');
}, 240_000);

test("the fake fs; copy, readAll, readLines; the caller's own error type through bytes", () => {
  const r = cli('test', {
    // writeModule puts the tests in m_test.candor.
    'm.candor': `${lib}
fn main() {}

test "fake" {
  let items = [Item { name: "x", n: 3 }]
  assert fs.writing("d.txt", (w) => save(items, w)) == Ok()
  assert fs.writing("d.txt", (w): Result<void, string> => Err("no")) == Err("no")
  assert fs.read("d.txt") == Ok("x,3\\n")
  assert fs.reading("d.txt", (r) => load(r)) == Ok(items)
  assert fs.reading("nope", (r) => bytes.readAll(r)) == Err("nope: not found")
  assert fs.writing("no/such.txt", (w) => w("x".toBytes())) == Err("no/such.txt: not found")
  assert roundTrip(items) == Ok(items)
  // #02cd3f5b: sync only checks the file is there; truncate cuts and pads.
  assert fs.sync("d.txt") == Ok()
  assert fs.sync("gone.txt") == Err(.NotFound { path: "gone.txt" })
  assert fs.truncate("d.txt", 2) == Ok()
  assert fs.read("d.txt") == Ok("x,")
  assert fs.truncate("d.txt", 3) == Ok()
  assert fs.readBytes("d.txt") == Ok("x,\\u{0}".toBytes())
  assert fs.truncate("d.txt", -1) == Err(.Failed { path: "d.txt", message: "invalid argument" })
}

test "copy and readAll" {
  let copied = bytes.reading("abcdef".toBytes(), (r) => bytes.collect((w): Result<void, string> => {
    assert bytes.copy(r, w) == Ok(6)
    return Ok()
  }))
  assert copied == Ok("abcdef".toBytes())
  assert bytes.reading("".toBytes(), (r) => bytes.readAll(r)) == Ok("".toBytes())
  assert bytes.reading("no newline".toBytes(), (r) => bytes.readLines(r, 0, (n, line) => n + line.length())) == Ok(10)
}

enum Problem {
  Bad
}

test "an error of the caller's own type passes through bytes" {
  let b: Result<Bytes, Problem> = bytes.collect((w) => Err(.Bad))
  assert b == Err(.Bad)
  let got: Result<int, Problem> = bytes.reading("x".toBytes(), (r) => Err(.Bad))
  assert got == Err(.Bad)
}
`,
  });
  expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
}, 240_000);

test('a function that calls a reader declares it, and takes on fs from fs.reading', () => {
  const head = 'module m\n\nimport "bytes"\nimport "fs"\n\n';
  // Without `uses r` the reader's type allows no effect, so fs.reading's can't be passed; the help says so.
  const pure = errors(`${head}fn size(r: fn(int) -> Result<Bytes?, string>) -> Result<int, string> {\n  return bytes.readAll(r).map((b) => b.length())\n}\n\nfn main() -> Result<void, string> uses fs {\n  fs.reading("x", (r) => size(r))?\n  return Ok()\n}\n`);
  expect(pure).toEqual(['CAN0005: this function uses `fs`, which `fn(int) -> Result<Bytes?, string>` does not allow']);
  // fs.reading's reader does fs: a function without it can't open one.
  const noFs = errors(`${head}fn first(path: string) -> Result<Bytes, string> {\n  return fs.reading(path, (r) => bytes.readAll(r))\n}\n\nfn main() {}\n`);
  expect(noFs.join('\n')).toContain('fs');
  // With `uses fs` it is fine, and so is a pure use of memory.
  expect(errors(`${head}fn first(path: string) -> Result<Bytes, string> uses fs {\n  return fs.reading(path, (r) => bytes.readAll(r))\n}\n\nfn pure(b: Bytes) -> Result<Bytes, string> {\n  return bytes.reading(b, (r) => bytes.readAll(r))\n}\n\nfn main() {}\n`)).toEqual([]);
});
