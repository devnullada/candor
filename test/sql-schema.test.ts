import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSql, readSchema } from '../src/sqlcheck';
import { compileSplit, writeModule } from './split';

// Card 064: queries checked against the schema the program's migrations make; `sql.queryOne`;
// `${none}` as NULL.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const migrate = `fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("""
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      note TEXT
    )
    """)?
  sql.exec("ALTER TABLE todos ADD COLUMN due INTEGER")?
  return Ok()
}`;

const program = (body: string, types = '') => `module m

import "sql"

struct Todo {
  id: int
  title: string
  done: bool
  note: string?
}

impl Row for Todo
${types}
${migrate}

fn run() -> Result<void, sql.Error> uses sql {
${body}
  return Ok()
}

fn main() {}
`;

const diags = (body: string, types = '') =>
  compileSplit(program(body, types), 'm.candor').diagnostics.filter((d) => d.severity !== 'warning').map((d) => [d.severity, d.code, d.message, d.help]);

test('queries that fit the schema check clean', () => {
  expect(
    diags(`  let all = sql.query<Todo>("SELECT id, title, done, note FROM todos WHERE done = \${false} ORDER BY id")?
  let titles = sql.query<string>("SELECT title FROM todos WHERE id IN (\${1}, \${2})")?
  let one = sql.queryOne<Todo>("SELECT id, title, done, note FROM todos WHERE id = \${3}")?
  let id = sql.insert("INSERT INTO todos (title) VALUES (\${"milk"})")?
  let note: string? = none
  sql.exec("UPDATE todos SET note = \${note}, due = \${none} WHERE id = \${id}")?
  sql.exec("UPDATE todos SET title = coalesce(\${note}, title) WHERE id = \${id}")?
  sql.exec("DELETE FROM todos WHERE id = \${id}")?`),
  ).toEqual([]);
});

test('a misspelt column, a wrong value type and a non-optional field for a nullable column are errors', () => {
  const [a] = diags('  sql.exec("UPDATE todos SET titel = ${"x"}")?');
  expect(a.slice(0, 3)).toEqual(['error', 'CAN0056', '`todos` has no column `titel`']);
  expect(a[3]).toBe('its columns are id, title, done, note, due, as the migration at m.candor:15 makes them');
  const [b] = diags('  sql.exec("INSERT INTO todos (title, done) VALUES (${"x"}, ${"yes"})")?');
  expect(b[2]).toBe('a string goes into `todos.done`, which holds an int (m.candor:15)');
  const [c] = diags('  let rows = sql.query<Loose>("SELECT id, note FROM todos")?', 'struct Loose {\n  id: int\n  note: string\n}\nimpl Row for Loose\n');
  // The migration is five lines further down, after `Loose`.
  expect(c[2]).toBe('`todos.note` can be NULL, so `Loose.note` must be optional (m.candor:20)');
  expect(c[3]).toBe('make the field `note: string?`, or the column NOT NULL in a migration');
});

test('tables, required columns, NULL into NOT NULL, rows against what is selected', () => {
  expect(diags('  sql.exec("DELETE FROM todo")?')[0][2]).toBe('there is no table `todo` in the schema the migrations make');
  expect(diags('  let n = sql.insert("INSERT INTO todos (note) VALUES (${"x"})")?')[0][2]).toBe(
    'this INSERT leaves out `title`, which `todos` requires (NOT NULL, no DEFAULT; m.candor:15)',
  );
  expect(diags('  let t: string? = none\n  sql.exec("UPDATE todos SET title = ${t}")?')[0][2]).toBe('`todos.title` is NOT NULL, and this value can be none (m.candor:15)');
  expect(diags('  let rows = sql.query<Todo>("SELECT id, title FROM todos")?')[0][2]).toBe("`Todo.done` is read from a column `done`, which this query doesn't select");
  expect(diags('  let n = sql.query<int>("SELECT id, title FROM todos")?')[0][2]).toBe('this query selects 2 columns, but reads each row into one int');
  expect(diags('  let rows = sql.query<Todo>("SELECT id, title, done, note, due FROM todos")?')[0][2]).toBe('this query selects `due`, and `Todo` has no field for it');
  expect(diags('  let rows = sql.query<Todo>("SELECT * FROM todos")?')[0][2]).toBe('this query selects `due`, and `Todo` has no field for it');
  expect(diags('  let n = sql.query<int>("SELECT title FROM todos")?')[0][2]).toBe('this query reads `title`, a string column, into an int (m.candor:15)');
  expect(diags('  let n = sql.query<int>("SELECT due FROM todos WHERE title = ${3}")?')[0][2]).toBe('an int goes into `todos.title`, which holds a string (m.candor:15)');
});

test('SQL it does not understand is a note, not an error', () => {
  const [n] = diags('  let n = sql.query<int>("WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM t WHERE x < 3) SELECT x FROM t")?');
  expect(n.slice(0, 3)).toEqual(['note', 'CAN0057', 'this query is not checked against the schema: it has a recursive WITH']);
  expect(diags('  sql.exec("DELETE FROM todos WHERE id IN (WITH RECURSIVE t(x) AS (SELECT 1) SELECT x FROM t)")?').map((d) => d[2])).toEqual([
    'this query is not checked against the schema: it has a recursive WITH',
  ]);
  expect(diags('  let n = sql.query<string>("SELECT value FROM json_each(${"[1]"})")?').map((d) => d[2])).toEqual([
    'this query is not checked against the schema: it reads a table-valued function',
  ]);
  // Card 077: one SELECT inside a DELETE or UPDATE is a subquery, not columns named SELECT; card 137 checks it.
  expect(diags('  sql.exec("DELETE FROM todos WHERE id NOT IN (SELECT id FROM todos ORDER BY id DESC LIMIT 20)")?')).toEqual([]);
});

test('the schema reader: create, alter, drop, rename; table-level primary keys', () => {
  const s = readSchema([
    { text: 'CREATE TABLE a (x TEXT, y VARCHAR(20), PRIMARY KEY (x)); CREATE TABLE b (z BOOLEAN NOT NULL)', where: 'f:1' },
    { text: 'ALTER TABLE a RENAME COLUMN y TO w; ALTER TABLE b RENAME TO c; DROP TABLE IF EXISTS gone', where: 'f:2' },
  ]);
  expect([...s.keys()]).toEqual(['a', 'c']);
  expect(s.get('a')!.columns.filter((c) => !c.hidden)).toEqual([
    { name: 'x', type: 'string', nullable: false, required: false },
    { name: 'w', type: 'string', nullable: true, required: false },
  ]);
  expect(s.get('c')!.columns[0]).toEqual({ name: 'z', type: 'bool', nullable: false, required: true });
  expect(checkSql('SELECT x FROM a WHERE w = ?', [{ type: 'int', optional: false }], s, null)[0].message).toBe('an int goes into `a.w`, which holds a string (f:1)');
});

test('queryOne gives the row, none, or an Err for more than one; ${none} is NULL', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-schema');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'one.candor');
  writeModule(
    file,
    program('  sql.exec("DELETE FROM todos")?').replace(
      'fn main() {}',
      `fn main() {}

test "queryOne" {
  assert migrate() == Ok()
  assert sql.exec("INSERT INTO todos (title, note) VALUES (\${"a"}, \${none})") == Ok(1)
  assert sql.exec("INSERT INTO todos (title, note) VALUES (\${"b"}, \${"x"})") == Ok(1)
  let a = Todo { id: 1, title: "a", done: false, note: none }
  assert sql.queryOne<Todo>("SELECT id, title, done, note FROM todos WHERE title = \${"a"}") == Ok(a)
  assert sql.queryOne<Todo>("SELECT id, title, done, note FROM todos WHERE title = \${"zzz"}") == Ok(none)
  assert sql.queryOne<Todo>("SELECT id, title, done, note FROM todos") == Err(sql.Error { message: "expected at most one row, got 2" })
}`,
    ),
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('1 passed, 0 failed');
});
