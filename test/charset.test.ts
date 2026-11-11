import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `bytes.decode` / `bytes.encode` in a named charset, and `xml.parseWith`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\Program Files\Go\bin\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'charset');

function cli(src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const src = String.raw`module m

import "bytes"
import "xml"

test "decode" {
  // "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}" in windows-1251, as yarr's Russian feeds send it.
  let privet = bytes.fromList([207, 240, 232, 226, 229, 242])
  assert bytes.decode(privet, "windows-1251") == "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}"
  assert bytes.decode(privet, "CP1251") == "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}"
  assert bytes.decode(bytes.fromList([99, 97, 102, 233]), "ISO-8859-1") == "caf\u{e9}"
  assert bytes.decode(bytes.fromList([128]), "latin1") == "\u{20ac}"
  assert bytes.decode(bytes.fromList([240, 210, 201, 215, 197, 212]), "koi8-r") == "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}"
  assert bytes.decode(bytes.fromList([147, 250, 150, 123]), "shift_jis") == "\u{65e5}\u{672c}"
  assert bytes.decode(bytes.fromList([104, 0, 105, 0]), "utf-16le") == "hi"
  assert bytes.decode(bytes.fromList([104, 105, 255]), "utf-8") == "hi\u{fffd}"
  assert bytes.decode(privet, "no-such-charset") == none
}

test "encode" {
  assert bytes.encode("caf\u{e9}", "iso-8859-1") == bytes.fromList([99, 97, 102, 233])
  assert bytes.encode("\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}", "windows-1251") == bytes.fromList([207, 240, 232, 226, 229, 242])
  assert bytes.encode("\u{20ac}", "koi8-r") == none
  assert bytes.encode("x", "no-such-charset") == none
  for cs in ["gbk", "big5", "euc-kr", "euc-jp", "utf-8"] {
    let s = match cs { "big5" => "\u{4e2d}\u{6587}", "euc-kr" => "\u{d55c}\u{ad6d}\u{c5b4}", "euc-jp" => "\u{65e5}\u{672c}\u{8a9e}", _ => "\u{4e2d}\u{6587} ok" }
    match bytes.encode(s, cs) {
      none => assert false,
      b => assert bytes.decode(b, cs) == s,
    }
  }
}

test "charset names" {
  assert bytes.charset("latin1") == "windows-1252"
  assert bytes.charset("UTF8") == "utf-8"
  assert bytes.charset(" Windows-1251 ") == "windows-1251"
  assert bytes.charset("no-such-charset") == none
}

test "xml in the header's charset" {
  // Declared ISO-8859-1, but the server's header says windows-1251, as yarr met it.
  let head = "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><t>"
  let body = head.toBytes().concat(bytes.fromList([207, 240, 232, 226, 229, 242])).concat("</t>".toBytes()).toRawText()
  match xml.parseWith(body, "windows-1251") {
    Ok(doc) => assert doc.text() == "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}",
    Err(e) => assert false,
  }
  match xml.parse(body) {
    Ok(doc) => assert doc.text() == "\u{cf}\u{f0}\u{e8}\u{e2}\u{e5}\u{f2}",
    Err(e) => assert false,
  }
  // UTF-8 text under a wrong declaration.
  match xml.parseWith("<?xml version=\"1.0\" encoding=\"windows-1252\"?><t>\u{e9}</t>", "utf-8") {
    Ok(doc) => assert doc.text() == "\u{e9}",
    Err(e) => assert false,
  }
  // A charset no one knows leaves the declaration's.
  match xml.parseWith(body, "no-such-charset") {
    Ok(doc) => assert doc.text() == "\u{cf}\u{f0}\u{e8}\u{e2}\u{e5}\u{f2}",
    Err(e) => assert false,
  }
}
`;

test('bytes.decode / encode / charset, xml.parseWith', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('4 passed, 0 failed');
}, 180_000);
