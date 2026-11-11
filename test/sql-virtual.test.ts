import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// SQL the schema check refused though SQLite runs it (from the yarr port): virtual
// tables (fts5, rtree), rowid, row values, window functions, SQLite's own tables and pragmas.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const program = (body: string, ddl = '') => `module m

import "sql"

struct Hit {
  rowid: int
  title: string?
}

impl Row for Hit

fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, feed INTEGER NOT NULL, date INTEGER NOT NULL, title TEXT NOT NULL)")?
  sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title, content, tokenize = 'porter')")?
  sql.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID")?
${ddl}  return Ok()
}

fn run(id: int, q: string) -> Result<void, sql.Error> uses sql {
${body}
  return Ok()
}

fn main() {}
`;

const diags = (body: string, ddl = '') =>
  compile(program(body, ddl), 'm.candor')
    .diagnostics.filter((d) => d.severity !== 'warning')
    .map((d) => [d.severity, d.message, d.help]);
const messages = (body: string, ddl = '') => diags(body, ddl).map((d) => d[1]);

test('an fts5 table has its columns, the hidden one named after it, rank and rowid', () => {
  expect(
    diags(`  let a = sql.query<Hit>("SELECT rowid, title FROM search WHERE search MATCH \${q} ORDER BY rank")?
  let b = sql.query<int>("SELECT i.id FROM items i JOIN search s ON s.rowid = i.id WHERE s.title MATCH \${q}")?
  sql.exec("INSERT INTO search (rowid, title, content) VALUES (\${id}, \${q}, \${q})")?
  sql.exec("DELETE FROM search WHERE rowid = \${id}")?`),
  ).toEqual([]);
  // `*` and an INSERT without columns leave the hidden ones out; a mistake is still one.
  expect(messages('  let a = sql.query<Hit>("SELECT * FROM search")?')).toEqual([
    'this query selects `content`, and `Hit` has no field for it',
    '`Hit.rowid` is read from a column `rowid`, which this query doesn\'t select',
  ]);
  expect(messages('  sql.exec("INSERT INTO search VALUES (${q}, ${q}, ${q})")?')).toEqual(['this INSERT gives 3 values for 2 columns of `search`']);
  expect(diags('  let a = sql.query<string>("SELECT body FROM search")?')).toEqual([
    ['error', '`search` has no column `body`', 'its columns are title, content, as the migration at m.candor:14 makes them'],
  ]);
  // Its columns have no type, and can be NULL.
  expect(messages('  let a = sql.query<string>("SELECT title FROM search")?')).toEqual(['`search.title` can be NULL, and this query reads it into a string (m.candor:14)']);
});

test('fts4 and fts3 are errors; another module is a note', () => {
  expect(diags('', '  sql.exec("CREATE VIRTUAL TABLE old USING fts4(title)")?\n')).toEqual([
    ['error', 'the SQLite Candor runs on has no fts4 module, so this migration fails', 'write `USING fts5(...)`: same columns, and `MATCH` queries the same way'],
  ]);
  expect(diags('  let a = sql.query<int>("SELECT minx FROM geo WHERE id = ${id}")?\n  let b = sql.query<float>("SELECT minx FROM geo")?', '  sql.exec("CREATE VIRTUAL TABLE geo USING rtree(id, minx, maxx)")?\n')).toEqual([
    ['error', 'this query reads `minx`, a float column, into an int (m.candor:16)', undefined],
  ]);
  expect(messages('  let a = sql.query<int>("SELECT x FROM st")?', '  sql.exec("CREATE VIRTUAL TABLE st USING dbstat")?\n')).toEqual([
    "this query is not checked against the schema: `st` is a dbstat virtual table, whose columns the check doesn't know",
  ]);
});

test('rowid on a rowid table; not on one WITHOUT ROWID', () => {
  expect(diags('  let a = sql.query<int>("SELECT rowid FROM items WHERE _rowid_ = ${id} OR oid = ${id}")?')).toEqual([]);
  expect(messages('  let a = sql.query<int>("SELECT rowid FROM kv")?')).toEqual(['`kv` has no column `rowid`']);
});

test('row values compare with a subquery of as many columns', () => {
  expect(
    diags(`  let a = sql.query<int>("SELECT id FROM items WHERE (date, id) < (SELECT date, id FROM items WHERE id = \${id}) ORDER BY date DESC, id DESC")?
  let b = sql.query<int>("SELECT id FROM items WHERE (feed, date) IN (SELECT feed, max(date) FROM items GROUP BY feed)")?
  let c = sql.query<int>("SELECT id FROM items WHERE (SELECT feed, date FROM items WHERE id = \${id}) = (feed, date)")?`),
  ).toEqual([]);
  expect(diags('  let a = sql.query<int>("SELECT id FROM items WHERE (date, id) < (SELECT date FROM items WHERE id = ${id})")?')).toEqual([
    ['error', 'this subquery is compared with a row of 2 values, and selects 1 column', 'select 2 columns, one for each value in the row'],
  ]);
  // A function's parentheses are no row.
  expect(messages('  let a = sql.query<int>("SELECT id FROM items WHERE lower(title) = (SELECT title, id FROM items)")?')).toEqual([
    'this subquery is used as a value, and selects 2 columns',
  ]);
});

test('window functions: their spec, their types, WINDOW', () => {
  expect(
    diags(`  let a = sql.query<int>("SELECT row_number() OVER (PARTITION BY feed ORDER BY date DESC) AS n FROM items")?
  let b = sql.query<int>("SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY feed ORDER BY date DESC) AS n FROM items) WHERE n <= \${id}")?
  let c = sql.query<int>("SELECT count(*) OVER (PARTITION BY feed ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM items")?
  let d = sql.query<int>("SELECT lag(date, 1, 0) OVER w FROM items WINDOW w AS (PARTITION BY feed ORDER BY date)")?
  let e = sql.query<float>("SELECT sum(date) FILTER (WHERE feed > 1) OVER (ORDER BY id) FROM items")?`),
  ).toEqual([]);
  expect(messages('  let a = sql.query<int>("SELECT lag(date) OVER (ORDER BY date) AS prev FROM items")?')).toEqual([
    '`lag(date) OVER (ORDER BY date)` can be NULL, and this query reads it into an int',
  ]);
  expect(messages('  let a = sql.query<int>("SELECT id FROM items WINDOW w AS (PARTITION BY fed)")?')).toEqual(['`items` has no column `fed`']);
  // Over a window, count(*) gives a row for each row: no "one row" for the query.
  expect(messages('  let a = sql.query<string>("SELECT count(*) OVER () FROM items")?')).toEqual([
    'this query reads `count(*) OVER ()`, an int, into a string',
  ]);
});

test("SQLite's own tables and pragmas read as tables", () => {
  expect(
    diags(`  let a = sql.query<int>("SELECT user_version FROM pragma_user_version")?
  let b = sql.query<string>("SELECT name FROM sqlite_schema WHERE type = 'table'")?
  let c = sql.query<string>("SELECT journal_mode FROM pragma_journal_mode")?`),
  ).toEqual([]);
  expect(diags('  let a = sql.query<string>("SELECT sql FROM sqlite_master")?')).toEqual([
    ['error', '`sqlite_master.sql` can be NULL, and this query reads it into a string', "give a default: `coalesce(sql, '')`; or read it into a struct with an optional field"],
  ]);
  expect(messages('  let a = sql.query<int>("SELECT x FROM pragma_wal_checkpoint")?')).toEqual([
    "this query is not checked against the schema: the check doesn't know the columns of `pragma_wal_checkpoint`",
  ]);
});

test('a `${}` in a pragma is an error: SQLite takes no parameter there', () => {
  expect(diags('  sql.exec("pragma user_version = ${id}")?')).toEqual([
    [
      'error',
      "a pragma can't take a `${}`: it is passed as a parameter, and SQLite takes none in a pragma",
      'write the value in the text, e.g. `match v { 1 => sql.exec("PRAGMA user_version = 1"), ... }`',
    ],
  ]);
  expect(diags('  sql.exec("PRAGMA user_version = 3")?')).toEqual([]);
});

test('runs: fts5 MATCH, a row value, a window, a pragma', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-virtual');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'virtual.candor'),
    program('  sql.exec("DELETE FROM items")?').replace(
      'fn main() {}',
      `fn main() -> Result<void, sql.Error> uses sql, io {
  sql.open("virtual.db")?
  migrate()?
  sql.exec("INSERT INTO items (feed, date, title) VALUES (1, 10, 'red sails'), (1, 20, 'blue sky'), (2, 30, 'red sky')")?
  sql.exec("INSERT INTO search (rowid, title) SELECT id, title FROM items")?
  let hits = sql.query<Hit>("SELECT rowid, title FROM search WHERE search MATCH \${"red"} ORDER BY rank, rowid")?
  let older = sql.query<int>("SELECT id FROM items WHERE (date, id) < (SELECT date, id FROM items WHERE id = \${3}) ORDER BY id")?
  let latest = sql.query<int>("SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY feed ORDER BY date DESC) AS n FROM items) WHERE n = 1 ORDER BY id")?
  let version = sql.query<int>("SELECT user_version FROM pragma_user_version")?
  io.println("\${hits.map((h) => h.rowid)} \${older} \${latest} \${version}")
  return Ok()
}`,
    ),
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'virtual.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('[1, 3] [1, 2] [2, 3] [0]\n');
}, 300_000);
