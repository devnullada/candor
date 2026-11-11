import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Each query a WITH names is a table in the statement after it, checked as a
// subquery in FROM is. A recursive WITH stays a note.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const program = (body: string) => `module m

import "sql"

struct Stat {
  room: int
  n: int
}

impl Row for Stat

fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)")?
  sql.exec("CREATE TABLE bookings (id INTEGER PRIMARY KEY, room INTEGER NOT NULL, start INTEGER NOT NULL, finish INTEGER NOT NULL, size INTEGER)")?
  return Ok()
}

fn run(id: int, name: string) -> Result<void, sql.Error> uses sql {
${body}
  return Ok()
}

fn main() {}
`;

const diags = (body: string) =>
  compile(program(body), 'm.candor')
    .diagnostics.filter((d) => d.severity !== 'warning')
    .map((d) => [d.severity, d.message, d.help]);
const messages = (body: string) => diags(body).map((d) => d[1]);

test('WITH queries are tables in the statement after them', () => {
  expect(
    diags(`  let a = sql.query<Stat>("WITH busy AS (SELECT room, count(*) AS n FROM bookings GROUP BY room) SELECT room, n FROM busy WHERE n > \${id}")?
  let b = sql.query<string>("WITH r(i, label) AS (SELECT id, name FROM rooms), b AS MATERIALIZED (SELECT room FROM bookings) SELECT r.label FROM r JOIN b ON b.room = r.i")?
  let c = sql.query<int>("WITH a AS (SELECT id FROM rooms), b AS (SELECT id FROM a WHERE id > 1) SELECT id FROM b UNION SELECT room FROM bookings")?
  let d = sql.query<int>("SELECT id FROM rooms WHERE id IN (WITH t AS (SELECT room FROM bookings) SELECT room FROM t)")?
  sql.exec("WITH old AS (SELECT id FROM bookings WHERE finish < \${id}) DELETE FROM bookings WHERE id IN (SELECT id FROM old)")?
  sql.exec("WITH n AS (SELECT \${name} AS name) UPDATE rooms SET name = (SELECT name FROM n) WHERE id = \${id}")?
  sql.exec("INSERT INTO bookings (room, start, finish) WITH r AS (SELECT id FROM rooms) SELECT id, 0, 1 FROM r")?
  let e = sql.query<int>("WITH total AS (SELECT count(*) AS total FROM rooms) SELECT total FROM total")?`),
  ).toEqual([]);
});

test('mistakes in and with a WITH are errors', () => {
  expect(messages('  let n = sql.query<int>("WITH t AS (SELECT rom FROM bookings) SELECT * FROM t")?')).toEqual(['`bookings` has no column `rom`']);
  expect(diags('  let n = sql.query<int>("WITH t AS (SELECT room FROM bookings) SELECT id FROM t")?')).toEqual([['error', '`t` has no column `id`', 'it selects room']]);
  expect(diags('  let n = sql.query<string>("WITH t AS (SELECT note FROM rooms) SELECT note FROM t")?')).toEqual([
    ['error', '`t.note` can be NULL, and this query reads it into a string', "give a default: `coalesce(note, '')`; or read it into a struct with an optional field"],
  ]);
  expect(diags('  let n = sql.query<int>("WITH t(a, b) AS (SELECT room FROM bookings) SELECT a FROM t")?')).toEqual([
    ['error', '`t` names 2 columns, and its query selects 1', 'name as many as it selects (room), or leave the names out'],
  ]);
  // A WITH's names are its statement's: not the subquery's around it, nor a table of the schema.
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms WHERE id IN (WITH t AS (SELECT room FROM bookings) SELECT room FROM t) AND id IN (SELECT room FROM t)")?')).toEqual([
    'there is no table `t` in the schema the migrations make',
  ]);
  // A WITH's name hides the table it shares a name with.
  expect(messages('  let n = sql.query<int>("WITH rooms AS (SELECT room FROM bookings) SELECT id FROM rooms")?')).toEqual(['`rooms` has no column `id`']);
});

test('a recursive WITH is a note', () => {
  const recursive = 'this query is not checked against the schema: it has a recursive WITH';
  expect(diags('  let n = sql.query<int>("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x FROM c")?')).toEqual([
    ['note', recursive, 'the database checks it when it runs'],
  ]);
  // SQLite reads one that names itself as recursive without the word.
  expect(messages('  let n = sql.query<int>("WITH c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x FROM c")?')).toEqual([recursive]);
  expect(messages('  let n = sql.query<int>("WITH c(x) AS (VALUES (1)) SELECT x FROM c")?')).toEqual([
    'this query is not checked against the schema: a query of its WITH is VALUES',
  ]);
});

test('runs: WITH before a SELECT, a DELETE and inside an INSERT', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-with');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'with.candor'),
    program('  sql.exec("DELETE FROM rooms")?').replace(
      'fn main() {}',
      `fn main() -> Result<void, sql.Error> uses sql, io {
  sql.open("with.db")?
  migrate()?
  sql.exec("INSERT INTO rooms (name) VALUES (\${"blue"}), (\${"red"})")?
  sql.exec("INSERT INTO bookings (room, start, finish) WITH r AS (SELECT id FROM rooms) SELECT id, 0, id FROM r")?
  let busy = sql.query<Stat>("WITH b AS (SELECT room, count(*) AS n FROM bookings GROUP BY room) SELECT rooms.id AS room, coalesce(b.n, 0) AS n FROM rooms LEFT JOIN b ON b.room = rooms.id ORDER BY rooms.id")?
  sql.exec("WITH old AS (SELECT id FROM bookings WHERE finish < \${2}) DELETE FROM bookings WHERE id IN (SELECT id FROM old)")?
  let left = sql.query<int>("SELECT room FROM bookings")?
  io.println("\${busy.map((s) => s.n)} \${left}")
  return Ok()
}`,
    ),
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'with.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('[1, 1] [2]\n');
}, 300_000);
