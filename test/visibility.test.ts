import { describe, expect, test } from 'bun:test';
import { Codes } from '../src/diagnostics';
import { compileSplit } from './split';

const bank = `module bank
pub struct Account {
  pub owner: string
  balance: int
}
pub fn open(owner: string) -> Account {
  return Account { owner, balance: 0 }
}
pub fn balance(a: Account) -> int {
  return a.balance
}
fn audit(a: Account) -> bool {
  return a.balance >= 0
}
struct Ledger {
  entries: List<int>
}
pub enum Kind {
  Checking
  Savings { rate: int }
}
trait Secret {
  fn secret(self) -> int
}
impl Secret for Account {
  fn secret(self) -> int {
    return self.balance
  }
}
pub trait Named {
  fn name(self) -> string
}
pub extern "strconv" {
  fn Itoa(i: int) -> string as itoa
}
extern "strconv" {
  fn Quote(s: string) -> string as quote
  pub let ErrRange: GoError as errRange
}
`;

const program = (main: string, files: Record<string, string> = { 'bank.candor': bank }) =>
  compileSplit(main, 'main.candor', 'main', { read: (f) => files[f] ?? null });
const errors = (main: string, files?: Record<string, string>) =>
  program(main, files)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);
const body = (stmts: string, decls = '') => `module m\nimport "bank"\n${decls}fn main() uses io {\n${stmts}\n}\n`;

describe('private by default', () => {
  test('what has `pub` is usable from another module', () => {
    const r = program(
      body(
        '  let a = bank.open("Grace")\n  io.println(a.owner + bank.balance(a).toString() + bank.itoa(1))\n  let k = bank.Kind.Savings { rate: 2 }\n  match k {\n    bank.Kind.Checking => io.println("c")\n    bank.Kind.Savings { rate } => io.println(rate.toString())\n  }\n  let e = bank.errRange',
        'struct P {\n  n: int\n}\nimpl bank.Named for P {\n  fn name(self) -> string {\n    return "n"\n  }\n}\n',
      ),
    );
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('a function, extern, type or trait without `pub` is not', () => {
    const offers = '`bank` offers `itoa`, `open`, `balance`, `errRange`; or add `pub` to it in `bank`';
    expect(errors(body('  let ok = bank.audit(bank.open("Grace"))'))).toEqual([[Codes.Private, '`audit` is private to module `bank`', offers]]);
    expect(errors(body('  let q = bank.quote("x")'))).toEqual([[Codes.Private, '`quote` is private to module `bank`', offers]]);
    expect(errors(body('', 'fn f(l: bank.Ledger) {\n}\n'))).toEqual([
      [Codes.Private, 'type `bank.Ledger` is private to module `bank`', '`bank` offers `Account`, `Kind`; or add `pub` to it in `bank`'],
    ]);
    expect(errors(body('', 'fn f<T: bank.Secret>(x: T) {\n}\n'))).toEqual([[Codes.Private, 'trait `bank.Secret` is private to module `bank`', '`bank` offers `Named`; or add `pub` to it in `bank`']]);
  });

  test("a private trait's methods can't be called from outside", () => {
    expect(errors(body('  let n = bank.open("Grace").secret()'))).toEqual([
      [Codes.Private, '`secret` is a method of trait `bank.Secret`, which is private to module `bank`', 'only `bank` can call it: use a `pub fn` of `bank`, or add `pub` to the trait'],
    ]);
  });

  test('private names stay out of suggestions', () => {
    expect(errors(body('  let ok = bank.audt(1)'))[0][2]).not.toContain('audit');
    expect(errors(body('', 'fn f(l: Ledger) {\n}\n'))[0][2]).toBe('module `bank` declares a `Ledger`, but keeps it private');
  });
});

describe('fields', () => {
  test('a private field is not read, matched or written from outside', () => {
    const help = 'only `bank` can read it: use a `pub fn` of `bank` that gives what you need, or add `pub` to the field';
    const msg = 'field `balance` of `bank.Account` is private to module `bank`';
    expect(errors(body('  io.println(bank.open("Grace").balance.toString())'))).toEqual([[Codes.Private, msg, help]]);
    const matching = (fields: string) => body(`  match bank.open("Grace") {\n    bank.Account { ${fields} } => io.println(owner)\n  }`);
    expect(errors(matching('owner, balance'))).toEqual([[Codes.Private, msg, help]]);
    expect(errors(body('  let mut a = bank.open("Grace")\n  a.balance = 10\n  io.println(a.owner)'))).toEqual([[Codes.Private, msg, help]]);
    // Its public fields are fine.
    expect(errors(matching('owner'))).toEqual([]);
  });

  test('a struct with private fields is built only by its module', () => {
    const msg = '`bank.Account` has private field `balance`, so only module `bank` can build one';
    expect(errors(body('  let a = bank.Account { owner: "Grace", balance: 5 }'))).toEqual([[Codes.Private, msg, 'call `bank.open(...)`']]);
    // A copy with changes builds one too.
    expect(errors(body('  let a = bank.Account { ...bank.open("Grace"), owner: "Ada" }'))).toEqual([[Codes.Private, msg, 'call `bank.open(...)`']]);
    const lone = { 'bank.candor': 'module bank\npub struct Account {\n  balance: int\n}\n' };
    expect(errors(body('  let a = bank.Account { balance: 5 }'), lone)[0][2]).toBe('`bank` has no `pub fn` that returns one: add one there, or make the fields `pub`');
  });
});

describe('what `pub` exposes must be `pub`', () => {
  const check = (src: string) =>
    compileSplit(src, 't.candor', 'test')
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => [d.code, d.message, d.help]);

  test('signatures, fields and variants', () => {
    const src = `module m
struct Secret {
  n: int
}
trait Hidden {
  fn h(self) -> int
}
pub fn make() -> List<Secret> {
  return []
}
pub fn bounded<T: Hidden>(x: T) {
}
pub struct Bag<T: Hidden> {
  pub items: List<T>
}
pub struct Box {
  pub inside: Secret
  fine: Secret
}
pub enum Wrap {
  One { s: Secret? }
}
pub trait Pretty {
  fn show(self, s: Secret) -> string
}
`;
    expect(check(src)).toEqual([
      [Codes.Exposed, '`make` is public, but names `Secret`, which is private', 'add `pub` to `struct Secret`, or remove `pub` from `make`'],
      [Codes.Exposed, '`bounded` is public, but names `Hidden`, which is private', 'add `pub` to `trait Hidden`, or remove `pub` from `bounded`'],
      [Codes.Exposed, '`Bag` is public, but names `Hidden`, which is private', 'add `pub` to `trait Hidden`, or remove `pub` from `struct Bag`'],
      [Codes.Exposed, 'field `inside` of `Box` is public, but names `Secret`, which is private', 'add `pub` to `struct Secret`, or remove `pub` from the field'],
      [Codes.Exposed, 'field `s` of `Wrap.One` is public, but names `Secret`, which is private', 'add `pub` to `struct Secret`, or remove `pub` from `enum Wrap`'],
      [Codes.Exposed, 'method `show` of trait `Pretty` is public, but names `Secret`, which is private', 'add `pub` to `struct Secret`, or remove `pub` from `trait Pretty`'],
    ]);
  });

  test("an effect's operations are always public", () => {
    const src = `module kv
enum KvError {
  Missing
}
effect kv {
  pub fn get(k: string) -> Result<string, KvError> {
    return Err(KvError.Missing)
  }
}
fake kv {
  fn get(k: string) -> Result<string, KvError> {
    return Err(KvError.Missing)
  }
}
`;
    expect(check(src)).toEqual([
      [Codes.Exposed, 'operation `get` of effect `kv` is public, but names `KvError`, which is private', 'add `pub` to `enum KvError`'],
    ]);
  });

  test('a program with `main` exposes nothing, until something imports it', () => {
    const src = `module kv
enum KvError {
  Missing
}
effect kv {
  pub fn get(k: string) -> Result<string, KvError> {
    return Err(KvError.Missing)
  }
}
fake kv {
  fn get(k: string) -> Result<string, KvError> {
    return Err(KvError.Missing)
  }
}
fn main() {
}
`;
    expect(check(src)).toEqual([]);
    const read = (f: string) => (f.endsWith('kv.candor') ? src : null);
    const app = compileSplit('module app\nimport "kv"\nfn main() {\n}\n', 'app.candor', 'main', { read });
    expect(app.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([Codes.Exposed]);
  });
});

describe('where `pub` goes', () => {
  const syntax = (src: string) =>
    compileSplit(`module m\n${src}\nfn main() {\n}\n`, 't.candor', 'test')
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => [d.message, d.help]);

  test('not on what is as public as something else; the rest still parses', () => {
    expect(syntax('trait T {\n  fn t(self) -> int\n}\npub impl T for int {\n  pub fn t(self) -> int {\n    return 1\n  }\n}')).toEqual([
      ['an `impl` takes no `pub`', 'it can be used wherever its trait and its type can'],
      ["an `impl`'s method takes no `pub`", 'it can be called wherever the trait and the type can'],
    ]);
    expect(syntax('pub trait T {\n  pub fn t(self) -> int\n}')).toEqual([["a trait's method takes no `pub`", 'it is as public as the trait: write `pub trait`']]);
    expect(syntax('pub enum E {\n  pub A\n  B { pub n: int }\n}')).toEqual([
      ['a variant takes no `pub`', 'it is as public as the enum: write `pub enum`'],
      ["a variant's field takes no `pub`", 'it is as public as the enum: write `pub enum`'],
    ]);
    expect(syntax('pub test "t" {\n  assert true\n}')).toEqual([['a test takes no `pub`', '`candor test` runs it; nothing calls it']]);
    expect(syntax('pub extern "strconv" {\n  pub fn Itoa(i: int) -> string as itoa\n}')).toEqual([['an item of a `pub extern` takes no `pub`', 'every item of the block is already `pub`']]);
  });

  test('in an effect and its fake', () => {
    const src = 'module kv\npub effect kv {\n  pub extern "./native" {\n    fn Get(ctx) -> string as goGet\n  }\n  pub fn get() -> string {\n    return goGet()\n  }\n}\npub fake kv {\n  pub fn get() -> string {\n    return ""\n  }\n}\nfn main() {\n}\n';
    expect(compileSplit(src, 't.candor', 'main').diagnostics.map((d) => d.message)).toEqual([
      'an effect takes no `pub`',
      "an effect's `extern` takes no `pub`",
        'a fake takes no `pub`',
      "a fake's function takes no `pub`",
    ]);
  });

  test('`pub` is a name everywhere else', () => {
    const r = compileSplit('module m\npub struct P {\n  pub: int\n  pub name: int\n}\nfn f(pub: int) -> int {\n  return P { pub, name: 1 }.pub\n}\nfn main() {\n}\n', 't.candor', 'main');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.go).toContain('pub int64');
    expect(syntax('pub let x = 1')).toEqual([['expected a declaration after `pub`, found `let`', '`pub` goes before `fn`, `test fn`, `struct`, `enum`, `trait`, `const` or `extern`']]);
  });
});
