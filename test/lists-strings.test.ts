import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `all`/`any`/`fold`/`sum` on lists; `lines`, `padStart`, `padEnd`; tuple items by
// position (`t.0`); ranges as values (`0..n` is a `List<int>`); and `char`, one code point.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'lists-strings', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const diags = (body: string, extra = '') =>
  compile(`module m\n${extra}\nfn main() uses io {\n${body}\n}\n`, 'm.candor').diagnostics.filter((d) => d.severity === 'error');

test('the new list methods, strings, tuples, ranges and chars run', () => {
  const r = run(
    'all',
    `module m

import "json"

struct Word { text: string, first: char }

impl Json for Word

fn kind(c: char) -> string {
  return match c {
    'a' => "a",
    '\\n' => "newline",
    _ => if c.isDigit() { "digit" } else { "other" },
  }
}

fn main() uses io, tasks {
  let xs = [3, 1, 4, 1, 5]
  io.println("\${xs.all((x) => x > 0)} \${xs.any((x) => x > 4)} \${xs.sum()} \${xs.fold(1, (acc, x) => acc * x)}")
  let empty: List<int> = []
  io.println("\${empty.all((x) => x > 0)} \${empty.any((x) => x > 0)} \${empty.sum()}")
  io.println("a\\nb\\r\\n\\nc\\n".lines().join("|"))
  io.println("[\${"7".padStart(3, "0")}] [\${"ab".padEnd(5, "xy")}] [\${"abcdef".padStart(3, "0")}] [\${"é".padStart(3, "ü")}]")
  let pair = ("k", 2)
  io.println("\${pair.0}=\${pair.1}")
  let squares = tasks.all(0..4, (i) => i * i)
  io.println(squares.map((x) => x.toString()).join(","))
  io.println("\${(0..3 + 2).length()} \${(5..5).isEmpty()}")
  let cs = "b😀a\\n7".chars()
  io.println(cs.map((c) => kind(c)).join(","))
  io.println(cs.sorted().filter((c) => c.isLetter()).join(""))
  let mut counts: Map<char, int> = [:]
  for c in "hello".chars() {
    counts[c] = (counts[c] ?? 0) + 1
  }
  io.println("\${counts['l'] ?? 0} \${counts['z'] ?? 0}")
  let w = Word { text: "émile", first: 'é' }
  let encoded = json.encode(w)
  io.println(encoded)
  match json.decode<Word>(encoded) {
    Ok(back) => io.println("\${back.first == 'é'} \${back.first.toUpperCase()} \${back.first.code()}")
    Err(e) => io.println(e.message)
  }
  match json.decode<Word>("""{"text": "x", "first": "xy"}""") {
    Ok(_) => io.println("decoded")
    Err(e) => io.println(e.message)
  }
  io.println("\${233.toChar() ?? '?'} \${(-5).toChar() ?? '?'} \${'\\''}")
}
`,
  );
  expect(r.stderr).toBe('');
  const lines = r.stdout.replace(/\r\n/g, '\n').split('\n');
  expect(lines[12]).toContain('a string of one character');
  lines[12] = '(the decode error)';
  expect(lines).toEqual([
    'true true 14 60',
    'true false 0',
    'a|b||c',
    '[007] [abxyx] [abcdef] [üüé]',
    'k=2',
    '0,1,4,9',
    '5 true',
    'other,other,a,newline,digit',
    'ab',
    '2 0',
    '{"text":"émile","first":"é"}',
    'true É 233',
    '(the decode error)',
    "é ? '",
    '',
  ]);
});

test('fold takes its type from the start value; sum needs ints', () => {
  expect(diags('  let s = ["a"].fold("", (acc, x) => acc + x)\n  io.println(s)')).toEqual([]);
  const [a] = diags('  let s = [1].fold(none, (acc, x) => acc)\n  io.println("")');
  expect(a.code).toBe('CAN0032');
  const [b] = diags('  let n = [1].fold("", (acc, x) => x)\n  io.println("")');
  expect(b.code).toBe('CAN0005');
  const [c] = diags('  let n = ["a"].sum()\n  io.println("")');
  expect(c.message).toBe('`sum` adds a List<int> or List<float>, found List<string>');
  expect(c.help).toContain('fold');
});

test('tuple items: out of range and names are errors that list the items', () => {
  const [a] = diags('  let p = (1, "a", true)\n  io.println(p.3)');
  expect(a.message).toBe('(int, string, bool) has 3 items, so no `.3`');
  expect(a.help).toBe('its items are `.0`, `.1`, `.2`, from 0; or take it apart: `let (a, b, c) = ...`');
  expect(diags('  let mut p = (1, 2)\n  p.1 = 5\n  io.println(p.1.toString())')).toEqual([]);
});

test('a range is a List<int>, binds loosest, and does not chain', () => {
  expect(diags('  let r: List<int> = 0..2 * 3\n  io.println(r.length().toString())')).toEqual([]);
  const [a] = diags('  let r = 0.."a"\n  io.println("")');
  expect(a.code).toBe('CAN0005');
  const r = compile('module m\nfn main() {\n  let r = 0..1..2\n}\n', 'm.candor');
  expect(r.diagnostics[0].message).toBe('ranges cannot be chained');
  // A `for` over one counts, without building the list.
  const go = compile('module m\nfn main() uses io {\n  for i in 0..3 {\n    io.println(i.toString())\n  }\n}\n', 'm.candor').go!;
  expect(go).not.toContain('candor.Range');
});

test('char literals: one code point, with escapes', () => {
  const lex = (lit: string) => compile(`module m\nfn main() {\n  let c = ${lit}\n}\n`, 'm.candor').diagnostics.filter((d) => d.severity === 'error');
  expect(lex("'\\n'")).toEqual([]);
  expect(lex("'😀'")).toEqual([]);
  expect(lex("'\\''")).toEqual([]);
  expect(lex("''")[0].message).toBe("`''` is an empty char");
  const [ab] = lex("'ab'");
  expect(ab.message).toBe("`'ab'` holds 2 code points, but a char is one");
  expect(ab.help).toBe('strings take double quotes: `"ab"`');
  expect(lex("'a")[0].message).toBe('unterminated char literal');
});

test('a char is not a string, and the errors say how to convert', () => {
  const [a] = diags('  let s: string = \'a\'\n  io.println(s)');
  expect(a.help).toBe('a char is not a string: `c.toString()` makes one');
  const [b] = diags('  let c: char = "a"\n  io.println(c.toString())');
  expect(b.help).toContain("single quotes, `'a'`");
  const [c] = diags('  io.println("a" + \'b\')');
  expect(c.help).toContain('interpolate the char');
  const [d] = diags('  let c = \'a\'\n  let n = c + 1\n  io.println("")');
  expect(d.code).toBe('CAN0019');
  expect(diags('  match \'x\' {\n    \'a\' => io.println("a")\n  }')[0].code).toBe('CAN0027');
});
