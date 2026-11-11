import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `json.Value`, JSON of any shape: decoded from anything, encoded as what it holds,
// inside typed structs too, read by `match` or by `Lookup`'s chain.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(cmd: 'run' | 'test', src: string) {
  const dir = path.join(tmpdir(), 'candor-test', `json-value-${cmd}`);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const src = `module m

import "json"

// What RDAP gives, trimmed: the registrar's name is the fourth item of a vcard entry.
const rdap = """{"handle": "X1", "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar"]]]}], "port43": null}"""

struct Domain {
  handle: string
  entities: List<json.Value>
}
impl Json for Domain

fn registrar(text: string) -> string? {
  return match json.decode<json.Value>(text) {
    Ok(v) => v.get("entities").at(0).get("vcardArray").at(1).at(1).at(3).text(),
    Err(_) => none,
  }
}

fn kind(v: json.Value) -> string {
  return match v {
    .Null => "null",
    .Bool { value } => "bool \${value}",
    .Int { value } => "int \${value}",
    .Float { value } => "float \${value}",
    .Text { value } => "text \${value}",
    .List { items } => "list of \${items.length()}",
    .Object { fields } => "object of \${fields.length()}",
  }
}

fn main() uses io {
  io.println(registrar(rdap) ?? "?")
  for text in ["null", "true", "12", "1.5", "1e3", "9223372036854775807", "92233720368547758070", "1.50", "\\"é\\"", "[1, [2]]", """{"b": 1, "a": 2}"""] {
    match json.decode<json.Value>(text) {
      Ok(v) => io.println("\${kind(v)}: \${v}"),
      Err(e) => io.println("error \${e}"),
    }
  }
  match json.decode<Domain>(rdap) {
    Ok(d) => io.println(json.encode(d)),
    Err(e) => io.println("error \${e}"),
  }
  io.println("\${json.decode<json.Value>("{") }")
}

test "a chain gives none for what isn't there" {
  let v = json.Value.Object { fields: ["a": json.Value.List { items: [json.Value.Int { value: 1 }] }] }
  assert v.get("a").at(0).int() == 1
  assert v.get("a").at(0).float() == 1.0
  assert v.get("a").at(5) == json.Value.Null
  assert v.get("b").get("c").text() == none
  assert v.at(0) == json.Value.Null
  assert v.get("a").items().length() == 1 && v.fields().length() == 1
  assert v.get("a").fields().length() == 0
  assert "\${v}" == """{"a":[1]}"""
}

test "a number keeps its text only when it writes differently" {
  assert json.decode<json.Value>("12").ok() == json.Value.Int { value: 12 }
  assert json.decode<json.Value>("1.5").ok() == json.Value.Float { value: 1.5 }
  assert json.decode<json.Value>("1.50").ok() == json.Value.Float { value: 1.5, text: "1.50" }
  assert json.encode(json.decode<json.Value>("[1.50, 1E3, -0, 7]").ok() ?? json.Value.Null) == "[1.50,1E3,-0,7]"
}
`;

test('decodes any JSON, encodes it back, and reads RDAP in one chain', () => {
  const r = cli('run', src);
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n').split('\n')).toEqual([
    'Example Registrar',
    'null: null',
    'bool true: true',
    'int 12: 12',
    'float 1.5: 1.5',
    'float 1000.0: 1e3',
    'int 9223372036854775807: 9223372036854775807',
    'float 92233720368547760000.0: 92233720368547758070',
    'float 1.5: 1.50',
    'text é: "é"',
    'list of 2: [1,[2]]',
    'object of 2: {"b":1,"a":2}',
    '{"handle":"X1","entities":[{"roles":["registrar"],"vcardArray":["vcard",[["version",{},"text","4.0"],["fn",{},"text","Example Registrar"]]]}]}',
    'Err($: not JSON: it ends too soon)',
    '',
  ]);
}, 120_000);

test('the methods, in a test block', () => {
  const r = cli('test', src);
  expect(r.stdout).toContain('2 passed, 0 failed');
}, 120_000);

// From the sound library port's log: a trait method's call in a `for` header was `T{}.fields(...)`, which
// Go read as the loop's body starting.
test('a Lookup method in a for header builds', () => {
  const r = cli(
    'run',
    `module m

import "json"

fn main() uses io {
  let body = match json.decode<json.Value>("""{"a": "x", "b": 1}""") {
    Ok(v) => v,
    Err(_) => json.Value.Null,
  }
  for (name, value) in body.fields() {
    if value.text() != none {
      io.println(name)
    }
  }
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('a\n');
}, 120_000);
