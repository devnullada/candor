import { expect, test } from 'bun:test';
import { compile } from '../src/compile';

// A column type that names text but has NUMERIC affinity in SQLite (`string`, `json`)
// stores "50" as the integer 50, and a read into a `string` fails at run time; the migration
// is an error (Pal, 2026-10-27).

const program = (ddl: string) => `module m

import "sql"

fn migrate() -> Result<void, sql.Error> uses sql {
${ddl}
  return Ok()
}

fn main() {}
`;

const diags = (ddl: string) =>
  compile(program(ddl), 'm.candor')
    .diagnostics.filter((d) => d.severity !== 'warning')
    .map((d) => [d.severity, d.message, d.help]);

test('a text-like type SQLite reads as NUMERIC is an error, in CREATE TABLE and ADD COLUMN', () => {
  expect(diags('  sql.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, guid string NOT NULL, title TEXT)")?')).toEqual([
    [
      'error',
      '`guid string`: SQLite reads string as NUMERIC, so text that looks like a number ("50") is stored and read back as one',
      'write `guid TEXT` for text; a type name SQLite reads as text has TEXT, CHAR or CLOB in it',
    ],
  ]);
  expect(diags('  sql.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)")?\n  sql.exec("ALTER TABLE a ADD COLUMN meta json")?').map((d) => d[1])).toEqual([
    '`meta json`: SQLite reads json as NUMERIC, so text that looks like a number ("50") is stored and read back as one',
  ]);
});

test('text, numbers, dates, booleans, blobs and untyped columns are fine', () => {
  expect(
    diags(
      '  sql.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, n TEXT, v VARCHAR(20), c CLOB, x REAL, d DATETIME, t TIMESTAMP, p NUMERIC, q DECIMAL(10, 2), b BOOLEAN, raw BLOB, loose, CONSTRAINT u UNIQUE (n), PRIMARY KEY (id))")?',
    ),
  ).toEqual([]);
});
