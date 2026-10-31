import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { compileSplit, writeModule } from './split';

// Card 090: Bytes in `sql`. `${b}` binds a BLOB; a BLOB column reads as Bytes, in a row or alone.
// The check keeps TEXT and BLOB apart; at run time Bytes read a TEXT value too.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const program = (body: string, rest = '') => `module m

import "sql"
import "bytes"

struct File {
  name: string
  data: Bytes
  thumb: Bytes?
}

impl Row for File

fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BLOB NOT NULL, thumb BLOB, loose)")?
  return Ok()
}

fn run(b: Bytes, s: string) -> Result<void, sql.Error> uses sql {
${body}
  return Ok()
}

fn main() {}
${rest}`;

const diags = (body: string) =>
  compileSplit(program(body), 'm.candor').diagnostics.filter((d) => d.severity !== 'warning').map((d) => [d.message, d.help]);

test('Bytes go into a BLOB column and come out of one', () => {
  expect(
    diags(`  let thumb: Bytes? = none
  sql.exec("INSERT INTO files (name, data, thumb) VALUES (\${s}, \${b}, \${thumb})")?
  let all = sql.query<File>("SELECT name, data, thumb FROM files")?
  let one = sql.queryOne<Bytes>("SELECT data FROM files WHERE name = \${s}")?
  sql.exec("UPDATE files SET loose = \${b} WHERE data = \${b}")?`),
  ).toEqual([]);
});

test('TEXT and BLOB are kept apart by the check, with the way across', () => {
  expect(diags('  sql.exec("UPDATE files SET name = ${b}")?')).toEqual([
    [
      'Bytes goes into `files.name`, which holds a string (m.candor:15)',
      'a TEXT column holds strings: store `b.toText()` if the bytes are UTF-8, or make the column BLOB in a migration',
    ],
  ]);
  expect(diags('  sql.exec("UPDATE files SET data = ${s}")?')).toEqual([
    ['a string goes into `files.data`, which holds Bytes (m.candor:15)', 'a BLOB column holds Bytes: store `s.toBytes()`, or make the column TEXT in a migration'],
  ]);
  expect(diags('  let x = sql.query<string>("SELECT data FROM files")?')).toEqual([
    ['this query reads `data`, a BLOB column, into a string (m.candor:15)', 'read it as `Bytes`, then `.toText()` gives the string if it is UTF-8'],
  ]);
  expect(diags('  let x = sql.query<Bytes>("SELECT name FROM files")?')).toEqual([
    ['this query reads `name`, a string column, into Bytes (m.candor:15)', 'read it as a `string`; `.toBytes()` gives its bytes'],
  ]);
});

test('every byte goes in and comes out; NULL, empty, and TEXT read as Bytes', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-bytes');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'blobs.candor');
  writeModule(
    file,
    program(
      '  sql.exec("DELETE FROM files")?',
      `
test "bytes round trip" {
  assert migrate() == Ok()
  let mut xs: List<int> = []
  for i in 0..256 {
    xs.push(i)
  }
  let all = bytes.fromList(xs)
  let none_: Bytes? = none
  assert sql.exec("INSERT INTO files (name, data, thumb, loose) VALUES (\${"a"}, \${all}, \${none_}, \${"héllo"})") == Ok(1)
  assert sql.exec("INSERT INTO files (name, data, thumb) VALUES (\${"b"}, \${bytes.fromList([])}, \${all.slice(0, 2)})") == Ok(1)
  assert sql.queryOne<Bytes>("SELECT data FROM files WHERE name = \${"a"}") == Ok(all)
  assert sql.query<File>("SELECT name, data, thumb FROM files ORDER BY name") == Ok([
    File { name: "a", data: all, thumb: none },
    File { name: "b", data: bytes.fromList([]), thumb: bytes.fromList([0, 1]) },
  ])
  assert sql.queryOne<Bytes>("SELECT loose FROM files WHERE name = \${"a"} AND loose IS NOT NULL") == Ok("héllo".toBytes())
  assert sql.query<int>("SELECT length(data) FROM files ORDER BY name") == Ok([256, 0])
  // Passed in, so the compile-time check doesn't see it.
  let one: sql.Query = "SELECT 1"
  assert sql.query<Bytes>(one) == Err(sql.Error { message: "column \\"1\\": expected Bytes, found 1" })
}`,
    ),
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('1 passed, 0 failed');
}, 120_000);
