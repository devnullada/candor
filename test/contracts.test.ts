import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

const diags = (src: string) => compileSplit(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message]);
const helps = (src: string) => compileSplit(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => d.help);

describe('checking contracts', () => {
  test('clauses after the signature, over the parameters and `result`', () => {
    const src = `module m
struct Account {
  balance: int
}
fn withdraw(a: Account, amount: int) -> Account
  uses io
  requires amount > 0
  requires amount <= a.balance
  ensures result.balance >= 0 && result.balance < a.balance
{
  io.println("withdraw")
  return Account { balance: a.balance - amount }
}
fn parse(s: string) -> Result<int, string>
  ensures match result {
    Ok(n) => n >= 0
    Err(_) => true
  }
{
  return Ok(1)
}
fn main() uses io {
  let requires = withdraw(Account { balance: 3 }, 1)
  let result = parse("1")
  let ensures = requires.balance
}
`;
    const r = compileSplit(src, 't');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  test('a clause is a bool', () => {
    expect(diags('module m\nfn f(n: int) -> int\n  requires n\n{\n  return n\n}\nfn main() {}\n')).toEqual([[Codes.ConditionNotBool, '`requires` needs a bool, found int']]);
  });

  test('no effects: named, called, or passed on', () => {
    const src = `module m
fn log() -> bool uses io {
  return true
}
fn f(n: int) -> int
  uses io
  requires io.println("x") == io.println("y")
  requires log()
  requires [n].map((x) => log()).length() > 0
{
  return n
}
fn main() {}
`;
    expect(diags(src)).toEqual([
      [Codes.BadContract, '`io` is an effect, but a `requires` cannot use effects'],
      [Codes.BadContract, '`io` is an effect, but a `requires` cannot use effects'],
      [Codes.BadContract, '`log` uses `io`, but a `requires` cannot use effects'],
      [Codes.BadContract, '`log` uses `io`, but a `requires` cannot use effects'],
    ]);
    expect(helps(src)[0]).toBe('a contract runs on every call and must not change anything: check this in the body of `f`, or pass in the value it needs');
  });

  test('no `?` and no `return`, outside a lambda', () => {
    const src = `module m
fn f(x: int?, r: Result<int, string>) -> int
  requires x? > 0
  requires r? > 0
  ensures if x == none { return 1 } else { true }
  ensures [1].map((n) => {
    return n
  }).length() == 1
{
  return 1
}
fn main() {}
`;
    expect(diags(src)).toEqual([
      [Codes.BadContract, '`?` would return from `f` in the middle of its `requires`'],
      [Codes.BadContract, '`?` would return from `f` in the middle of its `requires`'],
      [Codes.BadContract, 'a `ensures` cannot return from `f`'],
    ]);
    expect(helps(src).slice(0, 2)).toEqual([
      'say what holds when it is none: `x != none && ...`, or `(x ?? default) ...`',
      'say what holds for each case: `match r { Ok(v) => v > 0, Err(_) => true }`',
    ]);
  });

  test('`ensures` needs a result, and the name `result` for it', () => {
    expect(diags('module m\nfn f(n: int)\n  ensures n > 0\n{\n}\nfn main() {}\n')).toEqual([[Codes.BadContract, '`f` returns nothing, so its `ensures` has nothing to check']]);
    expect(diags('module m\nfn f(result: int) -> int\n  ensures result > 0\n{\n  return 1\n}\nfn main() {}\n')).toEqual([
      [Codes.BadContract, 'a function with an `ensures` cannot name a parameter `result`'],
    ]);
    // Only `ensures` has `result`.
    expect(diags('module m\nfn f(n: int) -> int\n  requires result > 0\n{\n  return 1\n}\nfn main() {}\n')).toEqual([[Codes.UnknownName, 'cannot find `result`']]);
  });

  test('not on trait methods, bindings, effect operations or fakes', () => {
    const trait = 'module m\ntrait Size {\n  fn size(self) -> int\n    ensures result >= 0\n}\nfn main() {}\n';
    expect(diags(trait)).toEqual([[Codes.SyntaxError, 'a trait method has no `ensures` yet']]);
    const extern = 'module m\nextern "strings" {\n  fn ToUpper(s: string) -> string\n    requires s != ""\n}\nfn main() {}\n';
    expect(diags(extern)).toEqual([[Codes.SyntaxError, 'a binding has no `requires`']]);
    const effect = 'module kv\neffect kv {\n  pub fn get(k: string) -> int\n    requires k != ""\n  {\n    return 1\n  }\n}\nfn main() uses kv {\n  let n = kv.get("a")\n}\n';
    expect(diags(effect)).toContainEqual([Codes.BadContract, '`get` is a function of an effect or a fake, which take no `requires` yet']);
  });
});

describe('emitting contracts', () => {
  test('`requires` on entry; with `ensures`, the body in a closure', () => {
    const r = compileSplit('module m\nfn f(n: int) -> int\n  requires n > 0\n  ensures result > n\n{\n  return n + 1\n}\nfn main() uses io {\n  io.println(f(1).toString())\n}\n', 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('candor.Broke("requires", "f", 3, "requires n > 0"');
    expect(r.go).toMatch(/result := func\(\) int64 \{[\s\S]*return candor\.Add\(n, 1\)[\s\S]*\}\(\)[\s\S]*candor\.Broke\("ensures", "f", 4, "ensures result > n"[\s\S]*return result/);
  });

  test('types get `Show__` when there is a contract, outside tests too', () => {
    const src = (c: string) => `module m\nstruct P {\n  x: int\n}\nfn f(p: P) -> int\n${c}{\n  return p.x\n}\nfn main() {\n  let n = f(P { x: 1 })\n}\n`;
    expect(compileSplit(src(''), 't').go).not.toContain('Show__');
    expect(compileSplit(src('  requires p.x > 0\n'), 't').go).toContain('Show__');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });

const accounts = `module bank

struct Account {
  balance: int
}

fn withdraw(a: Account, amount: int) -> Account
  requires amount <= a.balance
  ensures result.balance < a.balance
{
  return Account { balance: a.balance - amount }
}

trait Fee {
  fn fee(self) -> int
}

impl Fee for Account {
  fn fee(self) -> int
    ensures result <= self.balance
  {
    return 5
  }
}

fn main() uses io {
  let a = Account { balance: 10 }
  io.println(withdraw(a, 3).balance.toString())
  io.println(withdraw(a, 12).balance.toString())
}

test "zero" {
  let a = Account { balance: 10 }
  assert withdraw(a, 0).balance == 10
}

test "fee" {
  assert Account { balance: 1 }.fee() == 5
}
`;

describe('broken contracts', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'contracts');
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'bank.candor'), accounts);

  test(
    'in `run`: the diagram, then the frames; the caller is next to the broken `requires`',
    () => {
      const r = cli(dir, 'run', 'bank.candor', '--out', path.join(dir, 'run'));
      expect(r.stdout).toBe('7\n');
      expect(r.stderr).toBe(
        [
          'panic: `withdraw` was called with arguments that break its `requires`',
          '',
          '    requires amount <= a.balance',
          '             |      |  | |',
          '             |      |  | 10',
          '             |      |  Account { balance: 10 }',
          '             |      false',
          '             12',
          '  at bank.candor:8 in withdraw',
          '  at bank.candor:29 in main',
          '',
        ].join('\n'),
      );
      expect(r.status).toBe(2);
    },
    120_000,
  );

  test(
    'in a test, and as `--json`',
    () => {
      const r = cli(dir, 'test', 'bank.candor', '--out', path.join(dir, 'test'));
      expect(r.stdout).toContain(
        [
          'FAIL zero',
          '',
          '    `withdraw` returned a value that breaks its `ensures`',
          '',
          '    ensures result.balance < a.balance',
          '            |      |       | | |',
          '            |      |       | | 10',
          '            |      |       | Account { balance: 10 }',
          '            |      |       false',
          '            |      10',
          '            Account { balance: 10 }',
          '      at bank.candor:9 in withdraw',
          '      at bank_test.candor:34 in test "zero"',
        ].join('\n'),
      );
      // An impl's method.
      expect(r.stdout).toContain('FAIL fee\n\n    `fee` returned a value that breaks its `ensures`');
      const json = jsonLines(cli(dir, 'test', 'bank.candor', '--json', '--out', path.join(dir, 'test')).stdout);
      expect(json.tests[0].failure).toMatchObject({
        kind: 'ensures',
        fn: 'withdraw',
        line: 9,
        source: 'ensures result.balance < a.balance',
        parts: [
          { col: 8, text: 'result', value: 'Account { balance: 10 }' },
          { col: 15, text: 'result.balance', value: '10' },
          { col: 23, text: 'result.balance < a.balance', value: 'false' },
          { col: 25, text: 'a', value: 'Account { balance: 10 }' },
          { col: 27, text: 'a.balance', value: '10' },
        ],
      });
    },
    120_000,
  );

  // Card 119: the clause is shown from the imported module's own source, not the entry's.
  test(
    'a contract in an imported module shows its own text',
    () => {
      writeModule(path.join(dir, 'limits.candor'), 'module limits\n\n// Two lines down, past the end of main.candor.\npub fn half(n: int) -> int\n  requires n % 2 == 0\n{\n  return n / 2\n}\n');
      writeModule(path.join(dir, 'main.candor'), 'module main\nimport "./limits"\ntest "odd" { limits.half(3) }\n');
      const r = cli(dir, 'test', 'main.candor', '--out', path.join(dir, 'imported'));
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('    `half` was called with arguments that break its `requires`\n\n    requires n % 2 == 0\n');
      expect(r.stdout).toContain('at main_test.candor:3 in test "odd"');
    },
    120_000,
  );
});

/** `candor test --json`'s lines: a line per test as it ends, then the totals. */
function jsonLines(stdout: string) {
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  return { tests: lines.filter((l) => l.type === 'test'), summary: lines.at(-1) };
}
