import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { compileSplit, writeModule } from './split';

// `sql.function(name, f)` registers a Candor function with SQLite, before `sql.open`;
// the schema check knows its arguments and its result.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const fns = `fn shout(s: string) -> string {
  return s.toUpperCase()
}

fn half(n: int?) -> float? {
  if n == none {
    return none
  }
  return n.toFloat() / 2.0
}

fn strictLen(s: string) -> Result<int, string> {
  if s == "" {
    return Err("empty")
  }
  return Ok(s.length())
}

fn isLong(s: string) -> bool {
  return s.length() > 2
}

struct R {
  loud: string
  h: float?
}

impl Row for R

fn setup() -> Result<void, sql.Error> uses sql {
  sql.function("shout", shout)?
  sql.function("half", half)?
  sql.function("strict_len", strictLen)?
  sql.function("is_long", isLong)?
  sql.open(":memory:")?
  sql.exec("CREATE TABLE IF NOT EXISTS t (x TEXT NOT NULL, n INTEGER, up TEXT)")?
  sql.exec("CREATE TRIGGER IF NOT EXISTS t_ai AFTER INSERT ON t BEGIN UPDATE t SET up = shout(new.x) WHERE rowid = new.rowid; END")?
  return Ok()
}
`;

test('a registered function runs in queries and triggers, with NULL, bool and Err', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-function', 'run');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'm.candor'),
    `module m

import "sql"

${fns}
fn main() -> Result<void, sql.Error> uses sql, io {
  setup()?
  sql.insert("INSERT INTO t (x, n) VALUES (\${"hi"}, \${3})")?
  sql.insert("INSERT INTO t (x, n) VALUES (\${"yes"}, \${none})")?
  for r in sql.query<R>("SELECT shout(x) AS loud, half(n) AS h FROM t ORDER BY x")? {
    io.println("\${r.loud} \${r.h}")
  }
  io.println("\${sql.query<string>("SELECT coalesce(up, '') FROM t ORDER BY x")?}")
  io.println("\${sql.query<bool>("SELECT is_long(x) FROM t ORDER BY x")?}")
  io.println("\${sql.exec("SELECT strict_len(\${""})")}")
  io.println("\${sql.exec("SELECT shout(n) FROM t WHERE n IS NULL")}")
  io.println("\${sql.function("late", shout)}")
  return Ok()
}
`,
  );
  const r = cli(dir, 'run', 'm.candor', '--out', path.join(dir, 'out'));
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r/g, '').split('\n')).toEqual([
    'HI 1.5',
    'YES none',
    '["HI", "YES"]',
    '[false, true]',
    'Err(SQL logic error: empty (1))',
    "Err(SQL logic error: shout's argument 1 is NULL, and its parameter `s` isn't optional: make it `T?`, or give a value with coalesce (1))",
    'Err(sql.function("late", ...) comes after sql.open: SQLite gives a function to a database as it opens, so register it first)',
    '',
  ]);
});

test('each test registers its own, before its first query', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-function', 'tests');
  mkdirSync(dir, { recursive: true });
  writeModule(
    path.join(dir, 'm.candor'),
    `module m

import "sql"

${fns}
fn main() {}

test "one" {
  assert setup() == Ok()
  assert sql.insert("INSERT INTO t (x) VALUES (\${"a"})") == Ok(1)
  assert sql.query<string>("SELECT coalesce(up, '') FROM t") == Ok(["A"])
}

test "two" {
  assert setup() == Ok()
  assert sql.query<string>("SELECT shout(\${"b"})") == Ok(["B"])
}

test "a test that registers nothing has nothing, whatever ran before it" {
  assert sql.query<string>("SELECT shout(\${"c"})") == Err(sql.Error { message: "SQL logic error: no such function: shout (1)" })
}

test "after a query" {
  assert sql.exec("CREATE TABLE u (x TEXT)") == Ok(0)
  assert sql.function("shout", shout) == Err(sql.Error { message: "sql.function(\\"shout\\", ...) comes after the test's first query: SQLite gives a function to a database as it opens, so register it before anything runs a query" })
}
`,
  );
  const r = cli(dir, 'test', 'm.candor', '--out', path.join(dir, 'out'));
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('4 passed, 0 failed');
});

const diags = (register: string, body = '', extra = '') =>
  compileSplit(
    `module m

import "sql"

${fns}
${extra}
fn run() -> Result<void, sql.Error> uses sql {
${register}
${body}
  return Ok()
}

fn main() {}
`,
    'm.candor',
  )
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

test('the function must be named, pure, and of types SQLite holds', () => {
  expect(diags('  setup()?')).toEqual([]);
  expect(diags('  sql.function("f", (s: string) => s)?')[0].slice(0, 2)).toEqual([
    'CAN0005',
    '`sql.function` takes a named function: the compiler writes how SQLite calls it, and a lambda or a variable could be anything',
  ]);
  const name = 'fn` and pass its name';
  expect(diags('  let f = shout\n  sql.function("f", f)?')[0][2]).toContain(name);
  expect(diags('  sql.function("now", stamp)?', '', 'fn stamp() -> int uses clock {\n  return clock.now()\n}\n').find((d) => d[0] === 'CAN0005')!.slice(0, 2)).toEqual([
    'CAN0005',
    '`stamp` uses `clock`, and SQLite may call a SQL function anywhere: in a query, a trigger, an index',
  ]);
  expect(diags('  sql.function("f", same)?', '', 'fn same<T>(x: T) -> T {\n  return x\n}\n')[0][1]).toBe('`same` has type parameters, and SQLite calls one function with values of its own');
  expect(diags('  sql.function("f", count)?', '', 'fn count(xs: List<int>) -> int {\n  return xs.length()\n}\n')[0][1]).toBe("`count`'s parameter `xs` is a List<int>, which SQLite has no value for");
  expect(diags('  sql.function("f", nothing)?', '', 'fn nothing(s: string) {\n}\n')[0][1]).toBe('`nothing` gives a void, which SQLite has no value for');
  expect(diags('  sql.function("f", bad)?', '', 'fn bad(s: string) -> Result<int, int> {\n  return Ok(1)\n}\n')[0][1]).toBe('`bad` gives a Result<int, int>, which SQLite has no value for');
});

test('the name is a literal, a SQL name, and not one SQLite has', () => {
  expect(diags('  let n = "f"\n  sql.function(n, shout)?')[0].slice(0, 2)).toEqual(['CAN0059', "`sql.function`'s name is a string literal: the schema check reads it when the program compiles"]);
  expect(diags('  sql.function("strip-html", shout)?')[0][1]).toBe("`strip-html` isn't a name SQL can call");
  expect(diags('  sql.function("Lower", shout)?')[0].slice(1)).toEqual(['SQLite has a function `Lower` already', 'give yours a name of its own, e.g. `app_lower`, and call that in the SQL']);
  // The same function twice is one registration; another under the same name isn't.
  expect(diags('  setup()?\n  sql.function("shout", shout)?')).toEqual([]);
  expect(diags('  setup()?\n  sql.function("SHOUT", isLong)?')[0].slice(0, 2)).toEqual(['CAN0016', 'the SQL function `SHOUT` is `m.shout` already, registered at m.candor:35']);
});

test('the schema check knows how many arguments a function takes, their types and its result', () => {
  expect(diags('  setup()?', '  sql.exec("UPDATE t SET up = shout(x, n)")?')[0].slice(1)).toEqual([
    '`shout` takes 1 argument, and is given 2',
    'it is `m.shout(s)`, registered with `sql.function`',
  ]);
  // In a trigger too, which the schema check doesn't otherwise read.
  expect(diags('  setup()?', '  sql.exec("CREATE TRIGGER t_bu BEFORE UPDATE ON t BEGIN SELECT half(); END")?')[0][1]).toBe('`half` takes 1 argument, and is given 0');
  expect(diags('  setup()?', '  sql.exec("SELECT shout(${3})")?')[0].slice(1)).toEqual(["`shout`'s parameter `s` is a string, and is given an int", 'pass a string, as `m.shout` takes']);
  expect(diags('  setup()?', '  let s: string? = none\n  sql.exec("SELECT shout(${s})")?')[0][1]).toBe("`shout`'s parameter `s` isn't optional, and is given a `T?`");
  expect(diags('  setup()?', '  sql.exec("SELECT half(${none}), half(${2}), shout(${"a"})")?')).toEqual([]);
  // What it gives: `half` is a `float?`, `strict_len` an int (its Err fails the statement).
  const rows = 'struct H {\n  h: float\n}\nimpl Row for H\n';
  expect(diags('  setup()?', '  let a = sql.query<H>("SELECT half(n) AS h FROM t")?', rows)[0][1]).toBe('`half(n)` can be NULL, so `H.h` must be optional');
  expect(diags('  setup()?', '  let a = sql.query<int>("SELECT strict_len(x) FROM t")?\n  let b = sql.query<bool>("SELECT is_long(x) FROM t")?')).toEqual([]);
  expect(diags('  setup()?', '  let a = sql.query<string>("SELECT strict_len(x) FROM t")?')[0][1]).toContain('an int');
});

test('a function registered in an imported module is known to the importer', () => {
  const store = `module store

import "sql"

fn plain(s: string) -> string {
  return s.trim()
}

pub fn open() -> Result<void, sql.Error> uses sql {
  sql.function("plain_text", plain)?
  sql.open("x.db")?
  sql.exec("CREATE TABLE IF NOT EXISTS items (body TEXT NOT NULL)")?
  sql.exec("CREATE TRIGGER IF NOT EXISTS i_ai AFTER INSERT ON items BEGIN SELECT plain_text(new.body); END")?
  return Ok()
}
`;
  const main = (q: string) => `module m

import "sql"
import "store"

fn main() -> Result<void, sql.Error> uses sql {
  store.open()?
  let a = sql.query<string>("${q}")?
  return Ok()
}
`;
  const read = (f: string) => (f.replace(/\\/g, '/').endsWith('/store.candor') ? store : null);
  const errs = (q: string) => compile(main(q), path.join(tmpdir(), 'm.candor'), 'main', { read }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  expect(errs('SELECT plain_text(body) FROM items')).toEqual([]);
  expect(errs('SELECT plain_text() FROM items')).toEqual(['`plain_text` takes 1 argument, and is given 0']);
});
