import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

// SQL: the `sql` effect; a string literal is a `sql.Query` whose `${...}` are parameters; rows
// come back through `impl Row`, derived.

const errors = (src: string) =>
  compileSplit(`module m\nimport "sql"\n${src}\nfn main() {}\n`, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

describe('queries', () => {
  test('are string literals, and their `${...}` are parameters', () => {
    const ok = 'fn f(id: int, note: string?) -> Result<int, sql.Error> uses sql {\n  let q: sql.Query = "DELETE FROM t WHERE id = ${id} OR note = ${note}"\n  return sql.exec(q)\n}';
    expect(errors(ok)).toEqual([]);
    expect(errors('fn f(text: string) -> Result<int, sql.Error> uses sql {\n  return sql.exec(text)\n}')).toEqual([
      [
        Codes.TypeMismatch,
        'a query is a string literal, written where it runs, and this is a string from elsewhere',
        'write the query here, with the values in `${...}`: each becomes a parameter, so the text never changes with them. To pass a query around, type it `sql.Query`',
      ],
    ]);
    expect(errors('fn f() -> Result<int, sql.Error> uses sql {\n  return sql.exec(3)\n}')).toEqual([[Codes.TypeMismatch, 'expected a query (a string literal), found int', undefined]]);
  });

  test('take int, string, bool and their optionals, unquoted', () => {
    const src = 'struct P {\n  x: int\n}\nfn f(name: string, p: P, xs: List<int>) -> Result<int, sql.Error> uses sql {\n  sql.exec("SELECT 1 WHERE a = \'${name}\'")?\n  sql.exec("SELECT ${p}")?\n  return sql.exec("SELECT ${xs}")\n}';
    expect(errors(src)).toEqual([
      [Codes.TypeMismatch, '`${ }` in a query is a parameter, and inside quotes it would be the text `?`', 'drop the quotes: `${name}`; to match part of a string, build the pattern: `LIKE ${"%${name}%"}`'],
      [Codes.TypeMismatch, '`${ }` in a query is a parameter: int, string, bool, float, Bytes or an optional of those, found P', 'pass its fields, like `${p.x}`'],
      [Codes.TypeMismatch, '`${ }` in a query is a parameter: int, string, bool, float, Bytes or an optional of those, found List<int>', 'a parameter is one value: run the query once per item'],
    ]);
  });

  test('are run, not compared', () => {
    expect(errors('fn f(q: sql.Query) -> bool {\n  return q == q\n}')).toEqual([
      [Codes.InvalidOperands, 'cannot apply `==` to sql.Query and sql.Query', 'a `sql.Query` is run, not compared: compare what it reads'],
    ]);
  });

  test('need `uses sql`', () => {
    expect(errors('fn f() -> Result<int, sql.Error> {\n  return sql.exec("DELETE FROM t")\n}').map((e) => e[0])).toEqual([Codes.UndeclaredEffect]);
  });
});

describe('impl Row', () => {
  test('is derived, for a struct of columns', () => {
    expect(errors('struct P {\n  a: int\n  b: string?\n}\nimpl Row for P')).toEqual([]);
    expect(errors('struct P {\n  a: int\n  tags: List<string>\n}\nimpl Row for P')).toEqual([
      [Codes.Bound, '`impl Row for P` needs every field to be a column, and `P.tags` is List<string>', 'a column is int, string, bool, float or Bytes, or an optional of those for one that may be NULL'],
    ]);
    expect(errors('enum K {\n  A\n  B\n}\nimpl Row for K')).toEqual([
      [Codes.BadImpl, '`impl Row` is for a struct, whose fields are the columns, and K is an enum', 'read the column as a string or int, and turn it into the enum with a `match`'],
    ]);
    expect(errors('struct P {\n  a: int\n}\nimpl Row for P {\n}')).toEqual([[Codes.BadImpl, '`Row` is derived, not written', 'write `impl Row for P` with no body: the compiler writes it from the type']]);
    expect(errors('impl Row for int')).toEqual([[Codes.BadImpl, 'int is `Row` already', undefined]]);
  });

  test('is what sql.query reads, and says what to ask for', () => {
    const q = (t: string) => `struct P {\n  a: int\n}\nfn f() -> Result<List<${t}>, sql.Error> uses sql {\n  return sql.query<${t}>("SELECT a FROM t")\n}`;
    expect(errors(q('int'))).toEqual([]);
    expect(errors(q('P'))).toEqual([[Codes.Bound, '`sql.query` needs `T: Row`, and `T` is P here: P has no `impl Row`', 'derive it: `impl Row for P`']]);
    expect(errors(q('List<int>'))).toEqual([
      [
        Codes.Bound,
        '`sql.query` needs `T: Row`, and `T` is List<int> here: List<int> is not a row: a row is a struct with `impl Row`, or int, string, bool, float or Bytes for one column',
        '`sql.query` gives a list already: ask for the item, `sql.query<int>(...)`',
      ],
    ]);
    expect(errors(q('int?'))).toEqual([[Codes.Bound, '`sql.query` needs `T: Row`, and `T` is int? here: a row is read into a value, never none: a query with no rows gives an empty list', undefined]]);
  });
});

const program = `module notes
import "sql"

struct Note {
  id: int
  body: string
  pinned: bool
  tag: string?
}
impl Row for Note

fn setup() -> Result<void, sql.Error> uses sql {
  sql.exec("""
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      tag TEXT
    )
    """)?
  return Ok()
}

fn add(body: string, tag: string?) -> Result<int, sql.Error> uses sql {
  return sql.insert("INSERT INTO notes (body, tag) VALUES (\${body}, \${tag})")
}

fn main() uses io, env, sql {
  match sql.query<int>("SELECT 1") {
    Ok(_) => io.println("open?"),
    Err(e) => io.println("before open: \${e}"),
  }
  match sql.open(env.get("DB") ?? ":memory:") {
    Ok() => {},
    Err(e) => io.println("can't open: \${e}"),
  }
  match sql.open(":memory:") {
    Ok() => {},
    Err(e) => io.println("again: \${e}"),
  }
  match setup() {
    Ok() => {},
    Err(e) => io.println("\${e}"),
  }
  match add("o'clock'); DROP TABLE notes; --", "x") {
    Ok(id) => io.println("added \${id}"),
    Err(e) => io.println("\${e}"),
  }
  match sql.query<string>("SELECT body FROM notes") {
    Ok(bodies) => io.println(bodies.join(", ")),
    Err(e) => io.println("\${e}"),
  }
}

test "rows by name, in any order, and NULL as none" {
  assert setup() == Ok()
  assert add("milk", none) == Ok(1)
  assert add("vet", "home") == Ok(2)
  assert sql.query<Note>("SELECT tag, pinned, body, id FROM notes ORDER BY id") == Ok([
    Note { id: 1, body: "milk", pinned: false, tag: none },
    Note { id: 2, body: "vet", pinned: false, tag: "home" },
  ])
  assert sql.exec("UPDATE notes SET pinned = \${true}, tag = NULL WHERE id > \${0}") == Ok(2)
  assert sql.query<int>("SELECT count(*) FROM notes WHERE pinned AND tag IS NULL") == Ok([2])
  assert sql.query<bool>("SELECT pinned FROM notes WHERE id = \${1}") == Ok([true])
  assert sql.query<Note>("SELECT id, body, pinned, tag FROM notes WHERE id = \${9}") == Ok([])
}

test "each test has a database of its own" {
  assert sql.query<int>("SELECT count(*) FROM notes") == Err(sql.Error { message: "SQL logic error: no such table: notes (1)" })
}

test "columns must be the fields" {
  assert setup() == Ok()
  assert add("milk", none) == Ok(1)
  // The compile-time check (cards 064, 091, 137, 139) reads a query written in the call; one
  // passed in as a sql.Query meets the runtime's own checks.
  let short: sql.Query = "SELECT id, body AS body FROM notes"
  let extra: sql.Query = "SELECT id, body, pinned, tag, 1 AS extra FROM notes"
  let twice: sql.Query = "SELECT id, id AS id, body, pinned, tag FROM notes"
  let null_: sql.Query = "SELECT id, tag AS body, pinned, tag FROM notes"
  let text: sql.Query = "SELECT body AS id, body, pinned, tag FROM notes"
  let two: sql.Query = "SELECT id AS id, body FROM notes"
  assert sql.query<Note>(short) == Err(sql.Error { message: "no column \\"pinned\\", \\"tag\\" for Note: select them" })
  assert sql.query<Note>(extra) == Err(sql.Error { message: "column \\"extra\\" has no field in Note: leave it out, or name it with AS" })
  assert sql.query<Note>(twice) == Err(sql.Error { message: "column \\"id\\" comes twice: name one with AS" })
  assert sql.query<Note>(null_) == Err(sql.Error { message: "column \\"body\\" is NULL, and Note.body isn't optional: make it \`?\`, or select a value" })
  assert sql.query<Note>(text) == Err(sql.Error { message: "column \\"id\\": expected an int, found \\"milk\\"" })
  assert sql.query<int>(two) == Err(sql.Error { message: "expected one column, to read as an int, found 2" })
}
`;

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const dir = path.join(tmpdir(), 'candor-test', 'sql');
mkdirSync(dir, { recursive: true });
writeModule(path.join(dir, 'notes.candor'), program);

test(
  'test blocks run the SQL, in memory',
  () => {
    const t = cli(dir, 'test', 'notes.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('3 passed, 0 failed');
  },
  120_000,
);

test(
  'main opens a file once, and parameters are never SQL',
  () => {
    const built = cli(dir, 'build', 'notes.candor', '--out', path.join(dir, 'out'));
    expect(built.stderr).toBe('');
    const db = path.join(dir, 'notes.db');
    rmSync(db, { force: true });
    const r = spawnSync(built.stdout.trim(), { env: { ...process.env, DB: db }, encoding: 'utf8' });
    expect(r.stdout).toBe(
      [
        "before open: the database isn't open: call sql.open first",
        'again: the database is open already',
        'added 1',
        "o'clock'); DROP TABLE notes; --",
        '',
      ].join('\n'),
    );
  },
  120_000,
);

const bank = `module bank
import "sql"

enum BankError {
  Insufficient,
  Db { error: sql.Error },
}

fn setup() -> Result<void, sql.Error> uses sql {
  sql.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)")?
  sql.exec("INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 0)")?
  return Ok()
}

fn balances() -> Result<List<int>, sql.Error> uses sql {
  return sql.query<int>("SELECT balance FROM accounts ORDER BY id")
}

fn transfer(from: int, to: int, n: int) -> Result<void, BankError> uses sql {
  let db = (e: sql.Error) => BankError.Db { error: e }
  return sql.transaction(() => {
    sql.exec("UPDATE accounts SET balance = balance - \${n} WHERE id = \${from}").mapErr(db)?
    let left = sql.query<int>("SELECT balance FROM accounts WHERE id = \${from}").mapErr(db)?
    if (left.first() ?? 0) < 0 {
      return Err(BankError.Insufficient)
    }
    sql.exec("UPDATE accounts SET balance = balance + \${n} WHERE id = \${to}").mapErr(db)?
    return Ok()
  }, db)
}

// Both transfers, or neither: each inner one is a savepoint.
fn both(n: int, m: int) -> Result<void, BankError> uses sql {
  return sql.transaction(() => {
    transfer(1, 2, n)?
    return transfer(1, 2, m)
  }, (e) => BankError.Db { error: e })
}

// The first that works, of two: a failed one leaves nothing behind.
fn either(n: int, m: int) -> Result<int, sql.Error> uses sql {
  return sql.transaction(() => {
    if transfer(1, 2, n) == Ok() {
      return Ok(n)
    }
    transfer(1, 2, m).mapErr((e) => sql.Error { message: "neither" })?
    return Ok(m)
  }, (e) => e)
}

fn slowAdd() -> Result<int, sql.Error> uses sql, clock {
  return sql.transaction(() => {
    let id = sql.insert("INSERT INTO accounts (balance) VALUES (5)")?
    clock.sleep(100)
    return Ok(id)
  }, (e) => e)
}

fn count() -> Result<List<int>, sql.Error> uses sql {
  return sql.query<int>("SELECT count(*) FROM accounts")
}

fn main() uses io, sql {
  match sql.open(":memory:") {
    Ok() => {},
    Err(e) => io.println("\${e}"),
  }
  match setup() {
    Ok() => {},
    Err(e) => io.println("\${e}"),
  }
  io.println("\${transfer(1, 2, 30) == Ok()} \${transfer(1, 2, 300) == Err(BankError.Insufficient)} \${balances() == Ok([70, 30])}")
}

test "Ok commits, Err rolls back" {
  assert setup() == Ok()
  assert transfer(1, 2, 30) == Ok()
  assert balances() == Ok([70, 30])
  assert transfer(1, 2, 300) == Err(BankError.Insufficient)
  assert balances() == Ok([70, 30])
}

test "inside another, a savepoint" {
  assert setup() == Ok()
  assert both(30, 300) == Err(BankError.Insufficient)
  assert balances() == Ok([100, 0])
  assert both(30, 40) == Ok()
  assert balances() == Ok([30, 70])
  assert either(300, 20) == Ok(20)
  assert balances() == Ok([10, 90])
}

test "a cancel rolls back" {
  assert setup() == Ok()
  assert tasks.timeout(50, () => slowAdd()) == none
  assert count() == Ok([2])
}

test "other tasks wait for it" {
  assert setup() == Ok()
  let r = tasks.both(() => slowAdd(), () => {
    clock.sleep(10)
    return count()
  })
  assert r == Ok((3, [3]))
}
`;

const bankDir = path.join(tmpdir(), 'candor-test', 'sql-bank');
mkdirSync(bankDir, { recursive: true });
writeModule(path.join(bankDir, 'bank.candor'), bank);

describe('sql.transaction', () => {
  test('wants the error converted', () => {
    expect(errors('fn f() -> Result<int, string> uses sql {\n  return sql.transaction<int, string>(() => Ok(1), (e) => e)\n}')).toEqual([[Codes.TypeMismatch, 'expected string, found sql.Error', undefined]]);
  });

  test(
    'commits, rolls back, nests, and makes other tasks wait',
    () => {
      const t = cli(bankDir, 'test', 'bank.candor', '--out', path.join(bankDir, 'out-test'));
      expect(t.stdout).toContain('4 passed, 0 failed');
    },
    120_000,
  );

  test(
    'runs in a built program',
    () => {
      const built = cli(bankDir, 'build', 'bank.candor', '--out', path.join(bankDir, 'out'));
      expect(built.stderr).toBe('');
      expect(spawnSync(built.stdout.trim(), { encoding: 'utf8' }).stdout).toBe('true true true\n');
    },
    120_000,
  );
});

describe('mapErr', () => {
  test('turns the error into another', () => {
    expect(errors('enum E {\n  Db { m: string }\n}\nfn f() -> Result<List<int>, E> uses sql {\n  return sql.query<int>("SELECT 1").mapErr((e) => E.Db { m: e.message })\n}')).toEqual([]);
    expect(errors('fn g(e: string) {}\nfn f(r: Result<int, string>) -> Result<int, string> {\n  return r.mapErr(g)\n}')).toEqual([
      [Codes.NoValue, 'the function given to `mapErr` returns nothing', 'return the new error: `r.mapErr((e) => AppError.Db { error: e })`'],
    ]);
    expect(errors('fn f(r: Result<int, string>) -> int {\n  return r.unwrap()\n}')).toEqual([
      [Codes.NoSuchMember, 'Result<int, string> has no method `unwrap`', 'available: map, mapErr, isOk, isErr, ok; to read it, `match` it, use `?`, or `r.ok() ?? fallback`'],
    ]);
  });
});
