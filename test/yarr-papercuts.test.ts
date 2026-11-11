import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// What the yarr port tripped over: `[]` in one branch, `/* */`, `x!`, `int??`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const errors = (src: string) =>
  compile(src, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.message, d.help]);
const body = (b: string) => errors(`module m\n\nfn f(n: int, m: Map<string, int?>, xs: List<int?>, r: Result<int?, string>) -> int {\n${b}\n  return 0\n}\n\nfn main() {}\n`);

describe('an empty literal', () => {
  test('takes its type from the other branches', () => {
    expect(body('  let a = if n > 0 { [1] } else { [] }\n  let b: List<int> = a')).toEqual([]);
    expect(body('  let a = match n {\n    0 => [],\n    _ => ["x"],\n  }\n  let b: List<string> = a')).toEqual([]);
    expect(body('  let a = if n > 0 { [:] } else { ["k": 1] }\n  let b: Map<string, int> = a')).toEqual([]);
    expect(body('  let a: List<int>? = []\n  let b: List<int>? = if n > 0 { [] } else { none }')).toEqual([]);
  });

  test('every branch empty still needs a type', () => {
    expect(body('  let a = if n > 0 { [] } else { [] }').length).toBe(1);
  });
});

describe('block comments and `!`', () => {
  test('`/* */` is an error with help', () => {
    expect(errors('module m\n\n/* a\n   b */\nfn main() {}\n')).toEqual([['Candor has no block comments', 'write `//` at the start of each line of the comment']]);
  });

  test('`x!` names what to write instead', () => {
    const got = body('  let a = m["k"]!\n  let b = n + a');
    expect(got[0][1]).toBe('Candor has no `!` to unwrap: give a default with `x ?? 0`, handle `none` with `if x == none { ... }` or `match`, or pass an error on with `?`');
  });
});

describe('`T??` from built-ins is `T?`', () => {
  test('lookups, first, pop, remove, ok() of an optional item', () => {
    expect(
      body(
        '  let a: int? = m["k"]\n  let b: int? = xs[0]\n  let c: int? = xs.first()\n  let d: int? = xs.last()\n  let e: int? = r.ok()\n  let mut ys = xs\n  let g: int? = ys.pop()\n  let mut mm = m\n  let h: int? = mm.remove("k")',
      ),
    ).toEqual([]);
  });

  test('a generic function of the program still gives `T??`', () => {
    const src = (ret: string) => `module m\n\nfn get<T>(x: T) -> T? {\n  return x\n}\n\nfn f(v: int?) -> int? {\n  return ${ret}\n}\n\nfn main() {}\n`;
    expect(errors(src('get(v)'))).toEqual([
      ['`get(...)` gives int??, but where it goes expects int?', '`T` is int?, from `x` (line 8), so it gives an option of an option; write `get(...) ?? none` for one int?'],
    ]);
    expect(errors(src('get(v) ?? none'))).toEqual([]);
  });

  test('it runs', () => {
    const dir = path.join(tmpdir(), 'candor-test', 'yarr-papercuts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'main.candor'),
      `module m

fn parse(s: string) -> Result<int?, string> {
  return if s == "" { Ok(none) } else { Ok(s.length()) }
}

fn get<T>(x: T, keep: bool) -> T? {
  return if keep { x } else { none }
}

fn main() uses io {
  let one: int? = 1
  let gone: int? = none
  let g1: int? = get(one, true) ?? none
  let g2: int? = get(gone, true) ?? none
  let g3: int? = get(one, false) ?? none
  io.println("\${g1} \${g2} \${g3}")
  let m: Map<string, int?> = ["a": 1, "b": none]
  let xs: List<int?> = [none, 2]
  let mut ys = xs
  let mut mm = m
  io.println("\${m["a"]} \${m["b"]} \${m["c"]} \${xs.first()} \${xs.last()} \${xs[5]}")
  io.println("\${ys.pop()} \${mm.remove("a")} \${parse("").ok()} \${parse("ab").ok()}")
  let n = (m["a"] ?? 0) + (xs.last() ?? 0)
  let empty = if n > 0 { [] } else { [n] }
  io.println("\${n} \${empty.length()}")
}
`,
    );
    const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', path.join(dir, 'main.candor'), '--out', path.join(dir, 'out')], {
      encoding: 'utf8',
      env: { ...process.env, CANDOR_GO: go },
    });
    expect(r.stderr).toBe('');
    expect(r.stdout.replace(/\r\n/g, '\n')).toBe('1 none none\n1 none none none 2 none\n2 1 none 2\n3 0\n');
  }, 300_000);
});
