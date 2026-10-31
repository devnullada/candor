import { expect, test } from 'bun:test';
import { compile } from '../src/compile';

// Card 091: the schema check reads expressions and aliases, joins, and upserts.

const program = (body: string, types = '') => `module m

import "sql"

struct Stat {
  room: int
  n: int
}

impl Row for Stat
${types}
fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)")?
  sql.exec("CREATE TABLE bookings (id INTEGER PRIMARY KEY, room INTEGER NOT NULL, start INTEGER NOT NULL, finish INTEGER NOT NULL, size INTEGER)")?
  sql.exec("CREATE TABLE grants (user TEXT NOT NULL, topic TEXT NOT NULL, read BOOLEAN NOT NULL, PRIMARY KEY (user, topic))")?
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

test('counts, sums with a default, aliases and arithmetic check clean', () => {
  expect(
    diags(`  let n = sql.query<int>("SELECT count(*) FROM rooms WHERE id = \${id}")?
  let total = sql.query<int>("SELECT IFNULL(SUM(size), 0) FROM bookings WHERE room = \${id}")?
  let longest = sql.query<int>("SELECT coalesce(max(finish - start), 0) FROM bookings")?
  let stats = sql.query<Stat>("SELECT room, count(*) AS n FROM bookings GROUP BY room ORDER BY n DESC")?
  let sums = sql.query<Stat>("SELECT room, sum(finish - start) n FROM bookings GROUP BY room")?
  let shown = sql.query<string>("SELECT name || ' (' || id || ')' FROM rooms")?
  let typed = sql.query<int>("SELECT CAST(json_extract(note, '$.n') AS INTEGER) FROM rooms WHERE note IS NOT NULL")?
  let notes = sql.query<string>("SELECT note FROM rooms WHERE note IS NOT NULL AND id > \${id}")?
  let spans = sql.query<Span>("SELECT id, start, finish AS end FROM bookings")?`,
      'struct Span {\n  id: int\n  start: int\n  end: int\n}\nimpl Row for Span\n',
    ),
  ).toEqual([]);
});

test('a sum, max or average is NULL over no rows: optional, or a default', () => {
  expect(diags('  let total = sql.query<int>("SELECT sum(size) FROM bookings WHERE room = ${id}")?')).toEqual([
    ['error', '`sum(size)` is NULL when no rows match, and this query reads it into an int', 'give a default: `coalesce(sum(size), 0)`; or read it into a struct with an optional field'],
  ]);
  expect(messages('  let stats = sql.query<Stat>("SELECT room, max(start) AS n FROM bookings")?')).toEqual(['`max(start)` is NULL when no rows match, so `Stat.n` must be optional']);
  // In a group there is a row; `size` itself can be NULL, though.
  expect(messages('  let stats = sql.query<Stat>("SELECT room, max(start) AS n FROM bookings GROUP BY room")?')).toEqual([]);
  expect(messages('  let stats = sql.query<Stat>("SELECT room, sum(size) AS n FROM bookings GROUP BY room")?')).toEqual(['`sum(size)` can be NULL, so `Stat.n` must be optional']);
  expect(messages('  let n = sql.query<string>("SELECT count(*) FROM rooms")?')).toEqual(['this query reads `count(*)`, an int, into a string']);
  expect(messages('  let n = sql.query<int>("SELECT note FROM rooms")?')).toEqual(['this query reads `note`, a string column, into an int (m.candor:13)']);
  expect(diags('  let n = sql.query<string>("SELECT note FROM rooms")?')).toEqual([
    ['error', '`rooms.note` can be NULL, and this query reads it into a string (m.candor:13)', "give a default: `coalesce(note, '')`; or read it into a struct with an optional field"],
  ]);
});

test('an expression needs a name a field has; one the check cannot type is a note', () => {
  expect(diags('  let stats = sql.query<Stat>("SELECT room, count(*) FROM bookings GROUP BY room")?')).toEqual([
    ['error', 'this query selects `count(*)`, and `Stat` has no field for it', 'name it after a field: `count(*) AS n`'],
    ['error', "`Stat.n` is read from a column `n`, which this query doesn't select", "it selects room, count(*); select `n` too, which `bookings` doesn't have yet"],
  ]);
  expect(diags('  let stats = sql.query<Stat>("SELECT room, json_extract(size, \'$.n\') AS n FROM bookings")?')).toEqual([
    [
      'note',
      "this query's column `n` is not checked against the schema: the check doesn't know what `json_extract(size, '$.n')` gives",
      "a CAST names its type: `CAST(json_extract(size, '$.n') AS INTEGER)`",
    ],
  ]);
  // Its columns are still checked.
  expect(messages('  let n = sql.query<int>("SELECT count(sise) FROM bookings")?')).toEqual(['`bookings` has no column `sise`']);
});

test('joins: aliases, columns by table, and NULL from a LEFT JOIN', () => {
  expect(
    messages(`  let rows = sql.query<Stat>("""
    SELECT r.id AS room, count(b.id) AS n
    FROM rooms r LEFT JOIN bookings AS b ON b.room = r.id AND b.start > \${id}
    WHERE r.name = \${name}
    GROUP BY r.id
    """)?
  let names = sql.query<string>("SELECT rooms.name FROM bookings JOIN rooms ON rooms.id = bookings.room WHERE bookings.id = \${id}")?`),
  ).toEqual([]);
  expect(diags('  let rows = sql.query<int>("SELECT id FROM rooms JOIN bookings ON room = rooms.id")?')).toEqual([
    ['error', '`id` is a column of `rooms` and `bookings`, so the database can\'t tell which', 'name its table: `rooms.id`'],
  ]);
  expect(diags('  let rows = sql.query<int>("SELECT b.id FROM rooms r JOIN bookings b ON b.room = x.id")?')).toEqual([
    ['error', 'there is no table `x` in this query', 'it reads `rooms` as `r`, `bookings` as `b`'],
  ]);
  expect(messages('  let rows = sql.query<int>("SELECT b.sise FROM rooms r JOIN bookings b ON b.room = r.id")?')).toEqual(['`bookings` has no column `sise`']);
  expect(messages('  let rows = sql.query<int>("SELECT r.id FROM rooms r JOIN bookings b ON b.room = r.id WHERE b.start = ${name}")?')).toEqual([
    'a string goes into `bookings.start`, which holds an int (m.candor:14)',
  ]);
  expect(diags('  let rows = sql.query<int>("SELECT b.start FROM rooms r LEFT JOIN bookings b ON b.room = r.id")?')).toEqual([
    [
      'error',
      '`bookings.start` is NULL where the outer join finds no row, and this query reads it into an int (m.candor:14)',
      'give a default: `coalesce(start, 0)`; or read it into a struct with an optional field',
    ],
  ]);
});

test('upserts: the conflict columns and `excluded.col` are checked', () => {
  expect(
    messages(`  sql.exec("""
    INSERT INTO grants (user, topic, read) VALUES (\${name}, \${name}, \${true})
    ON CONFLICT (user, topic) DO UPDATE SET read = excluded.read, topic = \${name}
    """)?`),
  ).toEqual([]);
  expect(messages('  sql.exec("INSERT INTO grants (user, topic, read) VALUES (${name}, ${name}, ${true}) ON CONFLICT (usr) DO NOTHING")?')).toEqual([
    '`grants` has no column `usr`',
  ]);
  expect(messages('  sql.exec("INSERT INTO grants (user, topic, read) VALUES (${name}, ${name}, ${true}) ON CONFLICT (user, topic) DO UPDATE SET read = excluded.reed")?')).toEqual([
    '`grants` has no column `reed`',
  ]);
  expect(messages('  sql.exec("INSERT INTO grants (user, topic, read) VALUES (${name}, ${name}, ${true}) ON CONFLICT (user, topic) DO UPDATE SET read = excluded.topic")?')).toEqual([
    '`excluded.topic` is a string, and `grants.read` holds a bool (m.candor:15)',
  ]);
  expect(messages('  sql.exec("INSERT INTO grants (user, topic, read) VALUES (${name}, ${name}, ${true}) ON CONFLICT (user, topic) DO UPDATE SET read = ${name}")?')).toEqual([
    'a string goes into `grants.read`, which holds a bool (m.candor:15)',
  ]);
});
