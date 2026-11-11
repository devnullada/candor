import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// Subqueries, UNION / INTERSECT / EXCEPT, comparisons and CASE in a SELECT,
// UPDATE ... FROM, INSERT ... SELECT and RETURNING are checked against the schema.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const program = (body: string, types = '') => `module m

import "sql"

struct Stat {
  room: int
  n: int
}

impl Row for Stat

struct Named {
  id: int
  name: string
}

impl Row for Named
${types}
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

const diags = (body: string, types = '') =>
  compile(program(body, types), 'm.candor')
    .diagnostics.filter((d) => d.severity !== 'warning')
    .map((d) => [d.severity, d.message, d.help]);
const messages = (body: string, types = '') => diags(body, types).map((d) => d[1]);

test('subqueries in WHERE, in the SELECT list and in FROM check clean', () => {
  expect(
    diags(`  let a = sql.query<Named>("SELECT id, name FROM rooms WHERE id IN (SELECT room FROM bookings WHERE size > \${id})")?
  let b = sql.query<Named>("SELECT id, name FROM rooms r WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.room = r.id)")?
  let c = sql.query<Stat>("SELECT id AS room, (SELECT count(*) FROM bookings WHERE room = rooms.id) AS n FROM rooms")?
  let d = sql.query<bool>("SELECT EXISTS (SELECT 1 FROM rooms WHERE name = \${name})")?
  let e = sql.query<Stat>("SELECT room, n FROM (SELECT room, count(*) AS n FROM bookings GROUP BY room) WHERE n > 1")?
  let f = sql.query<int>("SELECT id FROM bookings WHERE finish = (SELECT max(finish) FROM bookings)")?
  sql.exec("DELETE FROM bookings WHERE room NOT IN (SELECT id FROM rooms)")?
  sql.exec("UPDATE rooms SET note = (SELECT group_concat(id) FROM bookings WHERE room = rooms.id) WHERE id = \${id}")?`),
  ).toEqual([]);
});

test('mistakes inside a subquery are errors; a subquery used as a value gives one column', () => {
  expect(messages('  sql.exec("DELETE FROM rooms WHERE id IN (SELECT rom FROM bookings)")?')).toEqual(['`bookings` has no column `rom`']);
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms WHERE id = (SELECT room, size FROM bookings LIMIT 1)")?')).toEqual([
    'this subquery is used as a value, and selects 2 columns',
  ]);
  // The enclosing query's tables are in reach, and named wrong all the same.
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms r WHERE EXISTS (SELECT 1 FROM bookings WHERE room = x.id)")?')).toEqual(['there is no table `x` in this query']);
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms WHERE size > 1")?')).toEqual(['`rooms` has no column `size`']);
  // `id` is the subquery's own: bookings has one, so rooms' isn't meant.
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms WHERE EXISTS (SELECT 1 FROM bookings WHERE id = 1)")?')).toEqual([]);
  // A subquery in FROM is a table of its columns.
  expect(diags('  let n = sql.query<int>("SELECT total FROM (SELECT room, count(*) AS n FROM bookings GROUP BY room) AS t")?')).toEqual([
    ['error', '`t` has no column `total`', 'it selects room, n'],
  ]);
});

test('a scalar subquery is NULL when it finds no row; an aggregate always finds one', () => {
  expect(diags('  let n = sql.query<string>("SELECT (SELECT name FROM rooms WHERE id = ${id})")?')).toEqual([
    ['error', '`(SELECT name FROM rooms WHERE id = ?)` can be NULL, and this query reads it into a string', "give a default: `coalesce((SELECT name FROM rooms WHERE id = ?), '')`; or read it into a struct with an optional field"],
  ]);
  expect(messages('  let n = sql.query<int>("SELECT (SELECT count(*) FROM bookings)")?')).toEqual([]);
  expect(messages('  let n = sql.query<int>("SELECT (SELECT max(size) FROM bookings)")?')).toEqual([
    '`(SELECT max(size) FROM bookings)` can be NULL, and this query reads it into an int',
  ]);
  expect(messages('  let n = sql.query<int>("SELECT (SELECT count(*) FROM bookings GROUP BY room)")?')).toEqual([
    '`(SELECT count(*) FROM bookings GROUP BY room)` can be NULL, and this query reads it into an int',
  ]);
});

test('UNION, INTERSECT, EXCEPT: as many columns, one type, NULL from any side of a UNION', () => {
  expect(
    diags(`  let a = sql.query<Named>("SELECT id, name FROM rooms UNION ALL SELECT id, 'booking' FROM bookings ORDER BY name LIMIT 5")?
  let b = sql.query<int>("SELECT room FROM bookings INTERSECT SELECT id FROM rooms")?
  let c = sql.query<int>("SELECT id FROM rooms EXCEPT SELECT size FROM bookings")?`),
  ).toEqual([]);
  expect(diags('  let n = sql.query<int>("SELECT id FROM rooms UNION SELECT id, room FROM bookings")?')).toEqual([
    ['error', 'the SELECTs on either side of UNION give 1 and 2 columns', 'each SELECT in a UNION, INTERSECT or EXCEPT selects as many columns, in the same order'],
  ]);
  expect(diags('  let n = sql.query<Named>("SELECT id, name FROM rooms UNION SELECT id, size FROM bookings")?')).toEqual([
    ['error', '`name` is a string in one SELECT of this UNION and an int (`bookings.size`) in another', 'make them one type: `CAST(bookings.size AS TEXT)`'],
  ]);
  expect(diags('  let n = sql.query<int>("SELECT id FROM rooms UNION SELECT size FROM bookings")?')).toEqual([
    ['error', '`bookings.size` can be NULL, and this query reads it into an int (m.candor:21)', 'give a default: `coalesce(size, 0)`; or read it into a struct with an optional field'],
  ]);
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms UNION SELECT room FROM bookings ORDER BY room")?')).toEqual([]);
  expect(diags('  let n = sql.query<int>("SELECT id FROM rooms UNION SELECT room FROM bookings ORDER BY start")?')).toEqual([
    ['error', 'this UNION is ordered by `start`, which isn\'t one of its columns', 'ORDER BY after a UNION names a column it gives (id) or its number'],
  ]);
  expect(messages('  let n = sql.query<int>("SELECT id FROM rooms UNION SELECT roomz FROM bookings")?')).toEqual(['`bookings` has no column `roomz`']);
});

test('comparisons, AND / OR / NOT and CASE have a type in a SELECT', () => {
  expect(
    diags(`  let a = sql.query<bool>("SELECT finish > start FROM bookings")?
  let b = sql.query<bool>("SELECT room = \${id} AND NOT (start BETWEEN 1 AND 5) FROM bookings")?
  let c = sql.query<bool>("SELECT note IS NULL FROM rooms")?
  let d = sql.query<bool>("SELECT name LIKE \${name} OR id IN (1, 2) FROM rooms")?
  let e = sql.query<string>("SELECT CASE WHEN size > 10 THEN 'big' WHEN size IS NULL THEN 'unknown' ELSE 'small' END FROM bookings")?
  let f = sql.query<float>("SELECT CASE room WHEN 1 THEN 0.5 ELSE finish - start END FROM bookings")?
  let g = sql.query<int>("SELECT iif(finish > start, finish - start, 0) FROM bookings")?`),
  ).toEqual([]);
  expect(messages('  let n = sql.query<bool>("SELECT size > 3 FROM bookings")?')).toEqual(['`size > 3` can be NULL, and this query reads it into a bool']);
  expect(messages('  let n = sql.query<string>("SELECT CASE WHEN size > 10 THEN \'big\' END FROM bookings")?')).toEqual([
    "`CASE WHEN size > 10 THEN 'big' END` can be NULL, and this query reads it into a string",
  ]);
  expect(diags('  let n = sql.query<string>("SELECT CASE WHEN size > 10 THEN \'big\' ELSE size END FROM bookings")?')).toEqual([
    [
      'note',
      "this query's column `CASE WHEN size > 10 THEN 'big' ELSE size END` is not checked against the schema: the check doesn't know what `CASE WHEN size > 10 THEN 'big' ELSE size END` gives",
      "a CAST names its type: `CAST(CASE WHEN size > 10 THEN 'big' ELSE size END AS INTEGER)`",
    ],
  ]);
});

test('RETURNING is read like a SELECT on the table written; a write read with sql.query needs it', () => {
  expect(
    diags(`  let ids = sql.query<int>("INSERT INTO rooms (name) VALUES (\${name}) RETURNING id")?
  let rows = sql.query<Named>("UPDATE rooms SET name = \${name} WHERE id = \${id} RETURNING id, name")?
  let gone = sql.queryOne<Named>("DELETE FROM rooms WHERE id = \${id} RETURNING *")?
  let up = sql.query<int>("INSERT INTO rooms (id, name) VALUES (\${id}, \${name}) ON CONFLICT (id) DO UPDATE SET name = excluded.name RETURNING id")?`),
  ).toEqual([['error', 'this query selects `note`, and `Named` has no field for it', 'leave it out, or add a field `note` to `Named`']]);
  expect(diags('  let n = sql.query<string>("INSERT INTO rooms (name) VALUES (${name}) RETURNING note")?')).toEqual([
    ['error', '`rooms.note` can be NULL, and this query reads it into a string (m.candor:20)', "give a default: `coalesce(note, '')`; or read it into a struct with an optional field"],
  ]);
  expect(messages('  let n = sql.query<int>("DELETE FROM rooms WHERE id = ${id} RETURNING idd")?')).toEqual(['`rooms` has no column `idd`']);
  expect(diags('  let n = sql.query<int>("INSERT INTO rooms (name) VALUES (${name})")?')).toEqual([
    ['error', 'this INSERT gives no rows to read', 'add `RETURNING` with the columns to read, or run it with `sql.exec`'],
  ]);
  // `sql.exec` reads no rows, so RETURNING's columns are only checked to exist.
  expect(messages('  sql.exec("INSERT INTO rooms (name) VALUES (${name}) RETURNING id, note")?')).toEqual([]);
});

test('UPDATE ... FROM reads other tables; INSERT ... SELECT fills the columns in order', () => {
  expect(
    diags(`  sql.exec("UPDATE bookings SET size = r.id FROM rooms AS r WHERE r.id = bookings.room AND r.name = \${name}")?
  sql.exec("INSERT INTO bookings (room, start, finish) SELECT id, 0, 1 FROM rooms WHERE note IS NULL")?
  sql.exec("INSERT INTO rooms (name) SELECT name FROM rooms WHERE id = \${id} RETURNING id")?`),
  ).toEqual([]);
  expect(messages('  sql.exec("UPDATE bookings SET size = r.id FROM rooms AS r WHERE r.nme = ${name}")?')).toEqual(['`rooms` has no column `nme`']);
  expect(diags('  sql.exec("UPDATE bookings SET start = r.name FROM rooms r WHERE r.id = bookings.room")?')).toEqual([
    ['error', '`r.name` is a string, and `bookings.start` holds an int (m.candor:21)', 'set it from a column of its own type'],
  ]);
  expect(messages('  sql.exec("INSERT INTO bookings (room, start) SELECT id, 0, 1 FROM rooms")?')).toEqual([
    "this INSERT's SELECT gives 3 columns for 2 columns of `bookings`",
    'this INSERT leaves out `finish`, which `bookings` requires (NOT NULL, no DEFAULT; m.candor:21)',
  ]);
  expect(diags('  sql.exec("INSERT INTO bookings (room, start, finish) SELECT name, 0, 1 FROM rooms")?')).toEqual([
    ['error', '`rooms.name` is a string, and goes into `bookings.room`, which holds an int (m.candor:21)', "select a value of the column's type, or CAST it"],
  ]);
  expect(diags('  sql.exec("INSERT INTO rooms (name) SELECT note FROM rooms")?')).toEqual([
    ['error', '`rooms.name` is NOT NULL, and `rooms.note` can be NULL (m.candor:20)', "give a default: `coalesce(rooms.note, '')`, or make the column nullable in a migration"],
  ]);
});

test('runs: RETURNING rows, a UNION, a correlated subquery and CASE', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-subqueries');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'subs.candor'),
    program('  sql.exec("DELETE FROM rooms")?').replace(
      'fn main() {}',
      `fn main() -> Result<void, sql.Error> uses sql, io {
  sql.open("subs.db")?
  migrate()?
  let ids = sql.query<int>("INSERT INTO rooms (name) VALUES (\${"blue"}), (\${"red"}) RETURNING id")?
  sql.exec("INSERT INTO bookings (room, start, finish, size) SELECT id, 1, 3, 20 FROM rooms WHERE name = \${"blue"}")?
  let busy = sql.query<Stat>("SELECT id AS room, (SELECT count(*) FROM bookings WHERE room = rooms.id) AS n FROM rooms ORDER BY id")?
  let all = sql.query<Named>("SELECT id, name FROM rooms UNION ALL SELECT id + 10, CASE WHEN size > 10 THEN 'big' ELSE 'small' END FROM bookings ORDER BY id")?
  let gone = sql.query<Named>("DELETE FROM rooms WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE room = rooms.id) RETURNING id, name")?
  io.println("\${ids} \${busy.map((s) => s.n)} \${all.map((r) => r.name)} \${gone.map((r) => r.name)}")
  return Ok()
}`,
    ),
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 'subs.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('[1, 2] [1, 0] ["blue", "red", "big"] ["red"]\n');
}, 300_000);
