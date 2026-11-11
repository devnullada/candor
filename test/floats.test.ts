import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lex } from '../src/lexer';
import { compileSplit, writeModule } from './split';

// `float`, 64-bit, never NaN or infinite (an operation that would make one panics),
// no mixing with int, JSON numbers and SQL REAL columns.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(command: string, name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'floats', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), command, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

function errors(src: string) {
  return compileSplit(src, 'f.candor', 'test').diagnostics.map((d) => `${d.code}: ${d.message}${d.help ? ` (${d.help})` : ''}`);
}

test('literals: a point or an exponent makes a float; tuple items and ranges stay ints', () => {
  const kinds = (s: string) => lex(s, 'f.candor').filter((t) => t.kind !== 'eof' && t.kind !== 'newline').map((t) => `${t.kind}:${t.text}`);
  expect(kinds('1.5 2.0e-3 1e21 1_000.25')).toEqual(['float:1.5', 'float:2.0e-3', 'float:1e21', 'float:1000.25']);
  expect(kinds('t.0.1')).toEqual(['ident:t', 'punct:.', 'int:0', 'punct:.', 'int:1']);
  expect(kinds('0..n')).toEqual(['int:0', 'punct:..', 'ident:n']);
  expect(kinds('1.toString()')).toEqual(['int:1', 'punct:.', 'ident:toString', 'punct:(', 'punct:)']);
});

test('an int and a float never mix; the help says which way to convert', () => {
  const body = (expr: string) => errors(`module f\nfn f(n: int, x: float) -> float {\n  return ${expr}\n}\n`);
  expect(body('x * n')).toEqual([
    'CAN0019: cannot apply `*` to float and int (an int and a float never mix; convert the int: `n.toFloat()` (or the float to an int with `.round()`))',
  ]);
  expect(body('x + 2')).toEqual(['CAN0019: cannot apply `+` to float and int (an int and a float never mix; write the int as a float: `2.0`)']);
  expect(body('x % 2.0')).toEqual([]);
  expect(errors('module f\nfn f(x: float) -> bool {\n  return x > 1\n}\n')[0]).toContain('write the int as a float: `1.0`');
  expect(errors('module f\nfn f() -> float {\n  return 1e999\n}\n')).toEqual(['CAN0017: 1e999 does not fit in a float (64-bit) (a float reaches about 1.8e308)']);
  expect(errors('module f\nfn f(x: float) -> int {\n  return match x {\n    1.5 => 1,\n    _ => 0,\n  }\n}\n')[0]).toContain('a pattern cannot be a float');
});

const program = `module stats

import "json"
import "sql"

struct Reading {
  sensor: string
  value: float
}

impl Json for Reading
impl Row for Reading

fn percent(part: int, total: int) -> string {
  return "\${(part.toFloat() / total.toFloat() * 100.0).toFixed(1)}%"
}

fn mean(xs: List<float>) -> float {
  return xs.sum() / xs.length().toFloat()
}

test "arithmetic and comparison" {
  assert 0.1 + 0.2 != 0.3
  assert (0.1 + 0.2 - 0.3).abs() < 1e-9
  assert 1.5 * 2.0 == 3.0
  assert -(2.5) < 0.0
  let mut acc = 1.0
  acc += 0.5
  acc *= 4.0
  acc /= 2.0
  acc -= 1.0
  assert acc == 2.0
  assert [3.5, -1.0, 2.0].sorted() == [-1.0, 2.0, 3.5]
  assert mean([1.0, 2.0, 4.5]) == 2.5
  let m: Map<float, string> = [0.5: "half"]
  assert m[0.5] == "half"
}

test "conversions" {
  assert 7.toFloat() == 7.0
  assert (2.5).round() == 3 && (-2.5).round() == -3
  assert (2.7).floor() == 2 && (2.1).ceil() == 3 && (-2.7).truncate() == -2
  assert "3.25".toFloat() == 3.25
  assert "Inf".toFloat() == none && "0x10".toFloat() == none && "".toFloat() == none
}

test "formatting" {
  assert "\${1.5} \${2.0} \${0.1 + 0.2} \${1e21} \${0.0000001} \${-3.0}" == "1.5 2.0 0.30000000000000004 1e+21 1e-07 -3.0"
  assert percent(1, 3) == "33.3%"
  assert (2.0).toFixed(2) == "2.00"
}

test "json" {
  assert json.encode(Reading { sensor: "a", value: 2.0 }) == """{"sensor":"a","value":2}"""
  assert json.decode<Reading>("""{"sensor":"b","value":1.5e2}""") == Ok(Reading { sensor: "b", value: 150.0 })
  assert json.decode<Reading>("""{"sensor":"b","value":7}""") == Ok(Reading { sensor: "b", value: 7.0 })
}

test "sql" {
  assert sql.exec("CREATE TABLE readings (sensor TEXT NOT NULL, value REAL NOT NULL)") == Ok(0)
  assert sql.exec("INSERT INTO readings (sensor, value) VALUES ('a', \${1.25}), ('b', 3)") == Ok(2)
  assert sql.query<Reading>("SELECT sensor, value FROM readings ORDER BY sensor") == Ok([Reading { sensor: "a", value: 1.25 }, Reading { sensor: "b", value: 3.0 }])
  assert sql.queryOne<float>("SELECT coalesce(avg(value), 0.0) FROM readings") == Ok(2.125)
}

test "division by zero panics" {
  let zero = 0.0
  assert 1.0 / zero > 0.0
}

test "overflow panics" {
  let big = 1e308
  assert big * 10.0 > 0.0
}

test "round out of range panics" {
  assert 1e19.round() > 0
}
`;

test('floats run: arithmetic, conversions, formatting, JSON and SQL', () => {
  const r = candor('test', 'stats', program);
  expect(r.stdout).toContain('panic: division by zero: 1.0 / 0.0');
  expect(r.stdout).toContain("panic: float overflow: 1e+308 * 10.0 doesn't fit in a float");
  expect(r.stdout).toContain("panic: round(): 10000000000000000000.0 doesn't fit in an int");
  expect(r.stdout).toEndWith('5 passed, 3 failed\n');
}, 120_000);

test('a failing assert shows floats as they print', () => {
  const r = candor('test', 'shown', 'module shown\n\ntest "t" {\n  assert 1.5 * 2.0 == 4.0\n}\n');
  expect(r.stdout).toContain('3.0');
}, 120_000);
