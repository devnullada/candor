import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// The pattern and inference friction the 2026-10-28 ports hit (buntdb, webhook,
// supercronic), each changed or given help that names the fix.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const errors = (src: string) =>
  compile(`module m\n\n${src}`, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'friction', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

test('`Err(.Variant)` and `.Variant { _ }` patterns, and the result type from an expression-body lambda, run', () => {
  const r = run(
    'patterns',
    `module patterns

enum Error {
  NotFound
  Bad { why: string, at: int }
}

struct Tx {
  n: int
}

fn find(n: int) -> Result<int, Error> {
  if n == 0 {
    return Err(.NotFound)
  }
  if n < 0 {
    return Err(.Bad { why: "negative", at: n })
  }
  return Ok(n)
}

fn label(n: int) -> string {
  return match find(n) {
    Ok(v) => "ok \${v}",
    Err(.NotFound) => "missing",
    Err(.Bad { why, _ }) => why,
  }
}

fn kind(e: Error) -> string {
  return match e {
    .NotFound => "missing",
    .Bad { _ } => "bad",
  }
}

fn viewWith<R>(f: fn(Tx) -> Result<R, string>) -> Result<R, string> {
  return f(Tx { n: 7 })
}

fn pairs(xs: List<int>) -> List<int> {
  return xs.fold([], (acc, n) => acc.concat([n / 256, n % 256]))
}

fn main() uses io {
  io.println("\${label(1)} \${label(0)} \${label(-1)} \${kind(.Bad { why: "x", at: 0 })}")
  io.println("\${viewWith((tx) => Ok(tx.n))} \${viewWith((tx) => Ok((tx.n, [tx.n]))).isOk()} \${pairs([258])}")
  let reads: List<Result<string, string>> = [Ok("a"), Err("b")]
  io.println("\${reads == [Ok("a"), Err("b")]}")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('ok 1 missing negative bad\nOk(7) true [1, 2]\ntrue\n');
}, 60_000);

test('an empty Mutex start names the annotation; a char number and an optional say their fix', () => {
  expect(errors('fn main() uses tasks {\n  tasks.scope((s) => {\n    let times = s.mutex([])\n  })\n}\n')[0]).toEqual([
    'CAN0032',
    'cannot tell what this Mutex holds',
    'annotate it: `let m: Mutex<List<int>> = s.mutex([])`',
  ]);
  expect(errors("fn main() {\n  let n = 'a'.toInt()\n}\n")[0].slice(1)).toEqual([
    'char has no member `toInt`',
    "use `code()`: the character's number (`'a'.code()` is 97); a digit's value is `c.toString().toInt()`, an `int?`",
  ]);
  expect(errors('fn main() {\n  let c: char = 97.toChar()\n}\n')[0].slice(1)).toEqual([
    'expected char, found char?',
    "this may be `none`: give a default, `x ?? ' '`, or handle it first: `if x == none { return ... }`, after which `x` is char",
  ]);
  expect(errors('fn work() -> Result<void, string> {\n  return Ok()\n}\nfn main() uses tasks {\n  tasks.scope((s) => {\n    s.spawn(() => work())\n  })\n}\n')[0].slice(1)).toEqual([
    'this task can fail with string, so its scope must return `Result<T, string>`, not void',
    "end the scope's function with `return Ok(...)`: the first failure becomes the scope's result",
  ]);
});

test("a lambda passed to a call that already failed doesn't add an error of its own", () => {
  expect(errors('fn main() {\n  let h: int? = none\n  let xs = h.items.map((a) => a.name)\n}\n').map((d) => d[1])).toEqual(['int? has no member `items`']);
  expect(errors('fn lines() -> List<string> uses io {\n  return io.errorOutput().lines().map((line) => line.trim())\n}\nfn main() {}\n').map((d) => d[0])).toEqual(['CAN0035']);
});
