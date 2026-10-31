import { describe, expect, test } from 'bun:test';
import { checkExterns, draft, type GoFunc, type GoPackage, type GoType } from '../src/bind';
import { compile } from '../src/compile';

const errors = (src: string) => compile(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);

// An effect over database/sql, and its fake; `body` adds to the effect, `rest` to the module.
const store = (body = '', rest = '') => `module store
effect store {
  extern "database/sql" {
    type *DB as Db
    type *Rows
    fn Open(driver: string, source: string) -> Result<Db, GoError> as openDb
    fn (db: Db) Query(query: string, ...(id: int)) -> Result<Rows, GoError> as query
    fn (rows: Rows) Next() -> bool as next
  }
  let mut db: Db? = none
  pub fn open(path: string) -> bool {
    return match openDb("sqlite", path) {
      Ok(c) => {
        db = c
        true
      },
      Err(_) => false,
    }
  }
  pub fn has(id: int) -> bool {
    return match db {
      none => false,
      conn => match query(conn, "SELECT 1 FROM t WHERE id = ?", id) {
        Ok(rows) => next(rows),
        Err(_) => false,
      },
    }
  }
${body}}
fake store {
  fn open(path: string) -> bool {
    return true
  }
  fn has(id: int) -> bool {
    return false
  }
}
${rest}fn main() uses store {
  if store.open("x") {
    store.has(1)
  }
}
`;

describe('only the effect holds them', () => {
  test('its bindings, state and operation bodies name them', () => {
    expect(errors(store())).toEqual([]);
  });

  test('nothing else does', () => {
    const outside = (src: string) => errors(src).map(([c, m]) => [c, m]);
    expect(outside(store('', 'fn f(d: Db) {}\n'))).toEqual([['CAN0051', '`Db` is a Go type, so only the code of `effect store` can hold one']]);
    expect(errors(store('  pub fn conn() -> Db? {\n    return db\n  }\n'))[0].slice(0, 2)).toEqual(['CAN0051', '`Db` is a Go type, so only the code of `effect store` can hold one']);
    const fake = store().replace('fake store {\n', 'fake store {\n  let conn: Db? = none\n');
    expect(codes(fake)).toContain('CAN0051');
  });

  test('another module names them neither', () => {
    const main = 'module m\nimport "store"\nfn f(d: store.Db) {}\nfn main() {}\n';
    const r = compile(main, 'm.candor', 'main', { read: (f) => (f === 'store.candor' ? store().replace(/fn main[^]*$/, '') : null) });
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([['CAN0051', '`store.Db` is a Go type, so only the code of `effect store` can hold one']]);
  });

  test('a `type` outside an effect, and an empty block outside one', () => {
    expect(errors('module m\nextern "database/sql" {\n  type *DB\n}\nfn main() {}\n')[0].slice(0, 2)).toEqual(['CAN0042', 'a Go type is bound inside an effect']);
    expect(errors('module m\nextern "modernc.org/sqlite@v1.60.1" {}\nfn main() {}\n')[0].slice(0, 2)).toEqual([
      'CAN0042',
      'an empty `extern` block imports a Go package only for what it does when loaded',
    ]);
  });

  test('no `==`, and a method belongs to a type of its block', () => {
    expect(errors(store('  pub fn same() -> bool {\n    return db == db\n  }\n'))[0][2]).toBe('Db? holds a Go value, which has no `==`; compare what you read from it');
    const bad = store().replace('fn (rows: Rows) Next()', 'fn (rows: int) Next()');
    expect(errors(bad)[0].slice(0, 2)).toEqual(['CAN0042', 'a method belongs to a Go type, so its receiver is one declared in this `extern` block, not int']);
  });
});

describe('Go', () => {
  const r = compile(store(), 't');
  const bindings = r.bindings!;

  test('an alias, so the program names it without importing Go', () => {
    expect(bindings).toContain('type store__Db = *go__1.DB');
    expect(r.go).toContain('func (f__ *fx__store__real) Has(ctx__ *candor.Ctx, id int64) bool {');
  });

  test('a method by its method expression; what goes into `...` by `candor.Arg`', () => {
    expect(bindings).toContain('return store__query__go((*go__1.DB).Query, a0, a1, a2)');
    expect(bindings).toContain('f func(store__Db, A1, ...V) (store__Rows, error)');
    expect(bindings).toContain('v, err := f(a0, A1(a1), candor.Arg[V](a2))');
  });

  test('a pointer Go gives is never nil, unless the binding says `T?`', () => {
    expect(bindings).toContain('panic("candor: Open gave nil, but its binding says Db; write Db? if it can")');
    const maybe = compile(store('', '').replace('fn (rows: Rows) Next() -> bool as next', 'fn (rows: Rows) Next() -> bool as next\n    fn (db: Db) Driver() -> Rows? as driver'), 't');
    expect(maybe.bindings).toContain('v := f(a0)\n\tif v == nil {\n\t\treturn opt__[store__Rows]{}\n\t}');
  });

  test('`(T, bool)` is `T?`', () => {
    const src = 'module m\neffect m {\n  extern "os" {\n    fn LookupEnv(key: string) -> string? as lookupEnv\n  }\n  pub fn home() -> string {\n    return lookupEnv("HOME") ?? "/"\n  }\n}\nfake m {\n  fn home() -> string {\n    return "/"\n  }\n}\nfn main() uses io, m {\n  io.println(m.home())\n}\n';
    expect(compile(src, 't').bindings).toContain('f func(A0) (R, bool)');
  });

  test("a method's context comes after its receiver", () => {
    const src = store().replace('fn (rows: Rows) Next() -> bool as next', 'fn (rows: Rows) Next() -> bool as next\n    fn (db: Db) PingContext(ctx) -> Result<void, GoError> as ping');
    expect(compile(src, 't').bindings).toContain('f func(store__Db, context.Context) error');
  });

  test('an empty block is a blank import', () => {
    const src = store().replace('  extern "database/sql" {', '  extern "modernc.org/sqlite@v1.60.1" {}\n  extern "database/sql" {');
    expect(compile(src, 't').bindings).toContain('\t_ "modernc.org/sqlite"');
  });
});

describe("an effect's state", () => {
  const r = compile(store(), 't');

  test('set up when `main` starts', () => {
    expect(r.go).toContain('\tctx__ := candor.Root()\n\tstore__main(ctx__, fx__store__newReal(ctx__))');
    expect(r.go).toContain('type fx__store__real struct {\n\tmu__ sync.RWMutex\n\tdb opt__[store__Db]\n}');
  });

  test('an operation that changes it runs alone; one that reads it takes a copy', () => {
    expect(r.go).toContain('\tctx__.Op()\n\tf__.mu__.Lock()\n\tdefer f__.mu__.Unlock()\n\tvar db opt__[store__Db] = f__.db\n\tdefer func() { f__.db = db }()');
    expect(r.go).toContain('\tf__.mu__.RLock()\n\tvar db opt__[store__Db] = f__.db\n\t_ = db\n\tf__.mu__.RUnlock()');
  });

  test('state that never changes needs no lock', () => {
    const src = 'module m\neffect m {\n  let greeting = "hi"\n  pub fn hello() -> string {\n    return greeting\n  }\n}\nfake m {\n  fn hello() -> string {\n    return "hi"\n  }\n}\nfn main() uses io, m {\n  io.println(m.hello())\n}\n';
    const go = compile(src, 't').go!;
    expect(go).not.toContain('sync');
    expect(go).toContain('func (f__ *fx__m__real) Hello(ctx__ *candor.Ctx) string {\n\tctx__.Op()\n\tvar greeting string = f__.greeting');
  });

  test('warnings, as for a fake', () => {
    const src = store('  let mut count = 0\n');
    expect(compile(src, 't').diagnostics.map((d) => [d.code, d.help])).toEqual([['CAN0013', 'no operation reads it']]);
  });
});

const t = (kind: GoType['kind'], text: string = kind, extra: Partial<GoType> = {}): GoType => ({ kind, text, ...extra });
const ptr = (name: string): GoType => t('named', `*sql.${name}`, { pkg: 'database/sql', name, pointer: true });
const fn = (name: string, params: GoType[], results: GoType[], extra: Partial<GoFunc> = {}): GoFunc => ({
  name,
  params: params.map((type, i) => ({ name: `p${i}`, type })),
  results,
  variadic: false,
  text: `func(${params.map((p) => p.text).join(', ')}) (${results.map((r) => r.text).join(', ')})`,
  ...extra,
});
const sql: GoPackage = {
  path: 'database/sql',
  name: 'sql',
  errors: [],
  funcs: [fn('Open', [t('string'), t('string')], [ptr('DB'), t('error')])],
  values: [],
  types: [
    {
      name: 'DB',
      kind: 'struct',
      methods: [
        fn('Query', [t('string')], [ptr('Rows'), t('error')], { variadic: true, rest: t('any'), pointerRecv: true }),
        fn('Driver', [], [t('named', 'driver.Driver', { pkg: 'database/sql/driver', name: 'Driver' })], { pointerRecv: true }),
      ],
    },
    { name: 'Rows', kind: 'struct', methods: [fn('Next', [], [t('bool')], { pointerRecv: true }), fn('Close', [], [t('error')], { pointerRecv: true })] },
    { name: 'Result', kind: 'interface', methods: [] },
  ],
};

describe('against Go', () => {
  const check = (src: string) => {
    const r = compile(src, 't');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return checkExterns(r.externs, new Map([['database/sql', sql]])).map((d) => [d.message, d.help]);
  };

  test('types and methods that fit', () => {
    expect(check(store())).toEqual([]);
  });

  test('a pointer where Go has none, and the reverse', () => {
    expect(check(store().replace('type *Rows', 'type Rows'))).toContainEqual(['`Rows.Next` needs a pointer to a `Rows`', 'declare the type as `type *Rows`']);
    expect(check(store().replace('type *Rows', 'type *Rows\n    type *Result as Written'))[0]).toEqual([
      '`Result` is a Go interface, which Go passes as itself, not by pointer',
      'write `type Result as Written`',
    ]);
  });

  test('names Go does not have', () => {
    expect(check(store().replace('type *Rows', 'type *Row as Rows'))[0][0]).toBe('`database/sql` has no type `Row`');
    expect(check(store().replace('Next() -> bool', 'Nxt() -> bool'))[0]).toEqual(['the Go type `Rows` has no method `Nxt`', 'did you mean `Next`?']);
  });
});

describe('drafts', () => {
  const text = draft(sql, { module: 'sql', goPath: 'database/sql', version: null });

  test('Go types, and what takes or gives them, go inside the effect', () => {
    expect(text).toContain('effect sql {\n  extern "database/sql" {\n');
    expect(text).toContain('    unvetted fn Open(p0: string, p1: string) -> Result<Db, GoError> as open\n');
    expect(text).toContain('    type *DB as Db\n');
    expect(text).toContain('    unvetted fn (rows: Rows) Next() -> bool as rowsNext\n');
    expect(text).toContain('    unvetted fn (rows: Rows) Close() -> Result<void, GoError> as rowsClose\n');
  });

  test('what does not fit, and types nothing takes or gives', () => {
    expect(text).toContain('// - DB.Query(string) (*sql.Rows, error): variadic');
    expect(text).toContain("// - DB.Driver() (driver.Driver): a driver.Driver can't cross into Candor yet");
    expect(text).not.toContain('type Result');
  });
});

describe('`f()?` on its own line', () => {
  test('passes the error on and drops the value, as a call does', () => {
    const src = 'module m\nfn f() -> Result<int, string> {\n  return Ok(1)\n}\nfn g() -> Result<void, string> {\n  f()?\n  return Ok()\n}\nfn main() {\n  match g() {\n    Ok() => {},\n    Err(_) => {},\n  }\n}\n';
    expect(compile(src, 't').diagnostics).toEqual([]);
  });
});
