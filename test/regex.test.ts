import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 115: `regex`, Go's RE2 behind a compiled `Regex`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'regex');

function cli(src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// `#{` stands for Candor's `${`, which a JS template would take as its own.
const src = String.raw`module m

import "regex"

test "compile, matches, a bad pattern" {
  let digits = regex.compile("^[0-9]+$")
  assert digits.map((r) => regex.matches(r, "2026")) == Ok(true)
  assert digits.map((r) => regex.matches(r, "20x6")) == Ok(false)
  assert digits.map((r) => regex.source(r)) == Ok("^[0-9]+$")
  let bad = regex.compile("(a")
  assert bad.isErr()
  match bad {
    Ok(_) => assert false,
    Err(e) => {
      assert e.pattern == "(a"
      assert e.message.contains("missing closing )")
      assert "#{e}".startsWith("bad pattern (a: ")
    },
  }
  assert regex.compile("(?i)^push$").map((r) => regex.matches(r, "PUSH")) == Ok(true)
  assert regex.compile("\\bref\\b").map((r) => regex.matches(r, "a ref here")) == Ok(true)
}

test "find: groups, names, code point positions" {
  match regex.compile("(?P<year>[0-9]{4})-([0-9]{2})(x)?") {
    Err(_) => assert false,
    Ok(date) => {
      let text = "f\u{e9} 2026-10, 2026-11"
      match regex.find(date, text) {
        none => assert false,
        m => {
          assert m.text == "2026-10"
          assert m.start == 3
          assert m.end == 10
          assert text.slice(m.start, m.end) == m.text
          assert m.groups == ["2026-10", "2026", "10", ""]
          assert m.named["year"] == "2026"
        },
      }
      let all = regex.findAll(date, text)
      assert all.map((m) => m.start) == [3, 12]
      assert regex.find(date, "nothing") == none
      assert regex.findAll(date, "nothing").isEmpty()
    },
  }
}

test "replace, replaceWith, split, quote" {
  match regex.compile("(?P<year>[0-9]{4})-([0-9]{2})") {
    Err(_) => assert false,
    Ok(date) => {
      assert regex.replace(date, "on 2026-10.", "$2/\#{year}") == "on 10/2026."
      assert regex.replace(date, "2026-10", "$$") == "$"
      assert regex.replaceWith(date, "\u{e9} 2026-10 and 2027-01!", (m) => m.groups[2] ?? "") == "\u{e9} 10 and 01!"
      assert regex.replaceWith(date, "none here", (m) => "x") == "none here"
    },
  }
  assert regex.compile(",\\s*").map((r) => regex.split(r, "a, b,c")) == Ok(["a", "b", "c"])
  let lit = regex.compile(regex.quote("1+1=2"))
  assert lit.map((r) => regex.matches(r, "so 1+1=2")) == Ok(true)
  assert lit.map((r) => regex.matches(r, "11=2")) == Ok(false)
}
`.replaceAll('#{', '${');

test('regex: compile, find, replace, split', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
}, 180_000);
