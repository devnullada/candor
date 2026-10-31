import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSql, readSchema } from '../src/sqlcheck';
import { compileSplit, writeModule } from './split';

// Card 134: a second SQLite file through `sql.attach`; its tables named `vault.secrets` in
// migrations and queries, and checked like the main database's.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

const program = (body: string) => `module m

import "sql"

struct Secret {
  name: string
  value: string
}

impl Row for Secret

struct Owned {
  who: string
  value: string
}

impl Row for Owned

fn migrate() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, who TEXT NOT NULL)")?
  sql.exec("CREATE TABLE IF NOT EXISTS vault.secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, owner INTEGER)")?
  return Ok()
}

fn run() -> Result<void, sql.Error> uses sql {
${body}
  return Ok()
}

fn main() {}
`;

const diags = (body: string) =>
  compileSplit(program(body), 'm.candor').diagnostics.filter((d) => d.severity !== 'warning').map((d) => [d.severity, d.message, d.help]);

test('an attached table is checked by its qualified name', () => {
  expect(
    diags(`  sql.attach("vault.db", "vault")?
  sql.exec("INSERT INTO vault.secrets (name, value, owner) VALUES (\${"k"}, \${"v"}, \${1})")?
  let all = sql.query<Secret>("SELECT name, value FROM vault.secrets WHERE owner = \${1}")?
  let bare = sql.query<Secret>("SELECT name, value FROM secrets")?
  let three = sql.query<string>("SELECT vault.secrets.value FROM vault.secrets")?
  let joined = sql.query<Owned>("SELECT p.who, s.value FROM people p JOIN vault.secrets s ON s.owner = p.id")?
  let ours = sql.query<string>("SELECT who FROM main.people")?
  sql.exec("UPDATE vault.secrets SET value = \${"w"} WHERE name = \${"k"}")?
  sql.exec("DELETE FROM vault.secrets WHERE name = \${"k"}")?`),
  ).toEqual([]);
});

test('and its mistakes are errors as in the main database', () => {
  expect(diags('  sql.exec("DELETE FROM vault.secret")?')[0].slice(1)).toEqual([
    'there is no table `vault.secret` in the schema the migrations make',
    'the tables are `people`, `vault.secrets`',
  ]);
  expect(diags('  sql.exec("UPDATE vault.secrets SET valu = ${"x"}")?')[0][1]).toBe('`vault.secrets` has no column `valu`');
  expect(diags('  sql.exec("INSERT INTO vault.secrets (name, value) VALUES (${"k"}, ${3})")?')[0][1]).toBe(
    'an int goes into `vault.secrets.value`, which holds a string (m.candor:21)',
  );
  expect(diags('  let n = sql.query<int>("SELECT value FROM vault.secrets")?')[0][1]).toBe('this query reads `value`, a string column, into an int (m.candor:21)');
});

test('ATTACH and DETACH by hand are errors', () => {
  expect(diags('  sql.exec("ATTACH DATABASE ${"v.db"} AS vault")?')[0].slice(1)).toEqual([
    'a database is attached with `sql.attach`, not ATTACH in a query',
    '`sql.attach("data/vault.db", "vault")` keeps it attached for the program; in a test it attaches a fresh one in memory',
  ]);
  expect(diags('  sql.exec("detach vault")?')[0][1]).toBe('a database is attached with `sql.attach`, not DETACH in a query');
});

test('the schema reader: qualified create, alter, rename, drop; main is the main database', () => {
  const s = readSchema([
    { text: 'CREATE TABLE v.a (x TEXT); CREATE TABLE main.b (y INTEGER); CREATE TABLE a (z TEXT)', where: 'f:1' },
    { text: 'ALTER TABLE v.a ADD COLUMN w BLOB; ALTER TABLE v.a RENAME TO c; DROP TABLE IF EXISTS main.b', where: 'f:2' },
  ]);
  expect([...s.keys()]).toEqual(['a', 'v.c']);
  expect(s.get('v.c')!.columns.filter((c) => !c.hidden).map((c) => c.name)).toEqual(['x', 'w']);
  // A bare name is the main database's table first.
  expect(checkSql('SELECT x FROM a', [], s, null)[0].message).toBe('`a` has no column `x`');
  expect(checkSql('SELECT x FROM c', [], s, null)).toEqual([]);
});

test('runs: two files, a join across them, and a test with the attached one in memory', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'sql-attach');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'two.candor');
  writeModule(
    file,
    program('  sql.exec("DELETE FROM people")?')
      .replace(
        'fn main() {}',
        `fn seed() -> Result<List<Owned>, sql.Error> uses sql {
  migrate()?
  let id = sql.insert("INSERT INTO people (who) VALUES (\${"ada"})")?
  sql.exec("INSERT OR REPLACE INTO vault.secrets (name, value, owner) VALUES (\${"zoho"}, \${"hunter2"}, \${id})")?
  return sql.query<Owned>("SELECT p.who, s.value FROM people p JOIN vault.secrets s ON s.owner = p.id")
}

fn main() -> Result<void, sql.Error> uses sql, io {
  sql.open("main.db")?
  sql.attach("vault.db", "vault")?
  // The same file again, by another spelling, changes nothing.
  sql.attach("./vault.db", "VAULT")?
  for o in seed()? {
    io.println("\${o.who} \${o.value}")
  }
  return Ok()
}

test "attached in memory" {
  assert sql.attach("vault.db", "vault") == Ok()
  assert seed() == Ok([Owned { who: "ada", value: "hunter2" }])
  assert sql.transaction(() => sql.attach("x.db", "x"), (e) => e) == Err(sql.Error { message: "sql.attach can't run inside a transaction" })
}

test "a restart attaches again and finds what the first start left" {
  assert sql.attach("vault.db", "vault") == Ok()
  assert seed().isOk()
  assert sql.open("main.db") == Ok()
  assert sql.attach("vault.db", "vault") == Ok()
  assert sql.query<string>("SELECT value FROM vault.secrets") == Ok(["hunter2"])
  let other = match sql.attach("other.db", "vault") {
    Ok() => "",
    Err(e) => e.message,
  }
  assert other.startsWith("vault is attached already, to ")
  assert other.endsWith("vault.db: one name, one file")
}`,
      )
      .replace('module m\n', 'module two\n'),
  );
  const cli = (cmd: string) =>
    spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'two.candor', '--out', path.join(dir, `out-${cmd}`)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
  const r = cli('run');
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe('ada hunter2\n');
  expect(existsSync(path.join(dir, 'main.db')) && existsSync(path.join(dir, 'vault.db'))).toBe(true);
  // The test attaches memory: no file of its own, and the real one is left as it was.
  rmSync(path.join(dir, 'vault.db'));
  const t = cli('test');
  expect(t.stdout).toContain('2 passed, 0 failed');
  expect(existsSync(path.join(dir, 'vault.db'))).toBe(false);
}, 300_000);
