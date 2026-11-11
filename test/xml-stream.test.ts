import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `xml.elements(r, names, start, each)` reads a document from a reader, giving each
// element with one of the names to `each` as a fold, and gives back the rest of the tree
// without them. As lenient as `xml.parse`; `elementsWith` takes a charset, `elementsStrict`
// refuses what isn't well-formed.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'xml-stream');

function cli(cmd: 'run' | 'test', src: string) {
  writeModule(path.join(dir, 'm.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'm.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 200_000,
  });
}

test('elements: a fold over the matching elements, the rest as a tree', () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = cli(
    'test',
    `module m

import "bytes"
import "fs"
import "xml"

const feed = "<?xml version=\\"1.0\\"?>\\n<rss><channel><title>News &amp; more</title>\\n<item><title>a</title></item>\\n<item><title>b <item>inner</item></title></item>\\n<link>https://example.com/</link></channel></rss>"

// The titles of the elements named in names, from source read a piece of at most n bytes at a time.
fn titles(source: string, names: List<string>, n: int) -> Result<(List<string>, xml.Node), xml.Error> {
  let empty: List<string> = []
  return bytes.reading(source.toBytes(), (r) => xml.elements((k) => r(n), names, empty, (seen, item) => .Continue { value: seen.concat([item.child("title").text()]) }))
}

// titles, an Err as "error: <message>" and an empty rest, for tests that look at the Ok.
fn read(source: string, names: List<string>, n: int) -> (List<string>, xml.Node) {
  return match titles(source, names, n) {
    Ok(got) => got,
    Err(e) => (["error: \${e.message}"], xml.text("")),
  }
}

fn main() {}

test "items in order, a nested match left inside, the rest without them" {
  let (got, rest) = read(feed, ["item"], 0)
  assert got == ["a", "b inner"]
  assert rest.child("channel").child("title").text() == "News & more"
  assert rest.child("channel").children("item") == []
  assert rest.child("channel").child("link").text() == "https://example.com/"
}

test "a byte at a time reads the same" {
  assert titles(feed, ["item"], 1).map((t) => t.0) == Ok(["a", "b inner"])
}

test "several names; Atom's namespace doesn't matter" {
  let atom = "<feed xmlns=\\"http://www.w3.org/2005/Atom\\"><title>T</title><entry><title>e</title></entry></feed>"
  let (got, rest) = read(atom, ["item", "entry"], 0)
  assert got == ["e"]
  assert rest.child("title").text() == "T"
  assert rest.space() == "http://www.w3.org/2005/Atom"
}

test "Stop ends the reading there" {
  let got = bytes.reading(feed.toBytes(), (r) => xml.elements(r, ["item"], 0, (n, item) => fs.Step.Stop { value: n + 1 }))
  assert got.map((p) => p.0) == Ok(1)
  assert got.map((p) => p.1.child("channel").child("link").text()) == Ok("")
}

test "a root that matches leaves an empty rest" {
  assert titles("<item><title>x</title></item>", ["item"], 0) == Ok((["x"], xml.text("")))
}

test "lenient: entities, a bare &, control characters; a cut-off item is left out" {
  let cut = "<rss><channel><title>A&nbsp;B & C\\u{1}</title><item><title>one</title></item><item><title>tw"
  let (got, rest) = read(cut, ["item"], 3)
  assert got == ["one"]
  assert rest.child("channel").child("title").text() == "A\\u{a0}B & C"
}

test "strict: the first thing wrong is an Err with its line" {
  let empty: List<string> = []
  let bad = "<a>\\n<item><title>x</title></item>\\n<b></a>"
  let got = bytes.reading(bad.toBytes(), (r) => xml.elementsStrict(r, ["item"], empty, (seen, item) => .Continue { value: seen.concat([item.text()]) }))
  assert got.mapErr((e) => "\${e.line}: \${e.message}") == Err("3: element <b> closed by </a>")
  let cut = bytes.reading("<a><item>".toBytes(), (r) => xml.elementsStrict(r, ["item"], empty, (seen, item) => .Continue { value: seen }))
  assert cut.mapErr((e) => e.message) == Err("<item> is not closed")
}

test "no element is an Err; a reader's failure is an Err at line 0" {
  assert titles("  ", ["item"], 0).mapErr((e) => e.message) == Err("no element in the document")
  let empty: List<string> = []
  let broken = bytes.reading(feed.toBytes(), (r) => xml.elements((n) => match r(n) {
    Ok(none) => Err("the connection broke"),
    got => got,
  }, ["item"], empty, (seen, item) => .Continue { value: seen }))
  assert broken.mapErr((e) => "\${e.line}: \${e.message}") == Err("0: the connection broke")
}

test "the declaration's charset, or the one given" {
  // "café" in ISO-8859-1: é is the byte e9.
  let latin = bytes.fromHex("3c3f786d6c2076657273696f6e3d22312e302220656e636f64696e673d2249534f2d383835392d31223f3e3c613e3c6974656d3e636166e93c2f6974656d3e3c2f613e") ?? "".toBytes()
  let empty: List<string> = []
  let declared = bytes.reading(latin, (r) => xml.elements(r, ["item"], empty, (seen, item) => .Continue { value: seen.concat([item.text()]) }))
  assert declared.map((p) => p.0) == Ok(["café"])
  let plain = bytes.fromHex("3c613e3c6974656d3e636166e93c2f6974656d3e3c2f613e") ?? "".toBytes()
  let given = bytes.reading(plain, (r) => xml.elementsWith(r, "windows-1252", ["item"], empty, (seen, item) => .Continue { value: seen.concat([item.text()]) }))
  assert given.map((p) => p.0) == Ok(["café"])
  let guessed = bytes.reading(plain, (r) => xml.elements(r, ["item"], empty, (seen, item) => .Continue { value: seen.concat([item.text()]) }))
  assert guessed.map((p) => p.0) == Ok(["caf\\u{fffd}"])
}
`,
  );
  expect(r.stdout + r.stderr).toContain('9 passed, 0 failed');
}, 240_000);

test('a real file: 20 000 items read through fs.reading', () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = cli(
    'run',
    `module m

import "bytes"
import "fs"
import "xml"

fn main() -> Result<void, string> uses io, fs {
  let wrote = fs.writing("feed.xml", (w) => {
    w("<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><rss><channel><title>Big</title>".toBytes())?
    for i in 0..20000 {
      w("<item><title>item \${i}</title><description>\${"x".repeat(200)}</description></item>\\n".toBytes())?
    }
    return w("</channel></rss>".toBytes())
  })
  wrote?
  // fs.reading's errors are text, so the xml.Error is shown.
  let ((count, last), rest) = fs.reading("feed.xml", (r) => xml.elements(r, ["item"], (0, ""), (seen, item) => .Continue { value: (seen.0 + 1, item.child("title").text()) }).mapErr((e) => e.toString()))?
  io.println("\${count} \${last} \${rest.child("channel").child("title").text()} \${rest.child("channel").elements().length()}")
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('20000 item 19999 Big 1\n');
}, 240_000);
