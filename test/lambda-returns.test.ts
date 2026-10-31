import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function runCandor(src: string): string {
  const dir = path.join(tmpdir(), 'candor-test', 'lambda-returns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.candor'), src);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', path.join(dir, 'main.candor'), '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  return r.stdout;
}

const run = 'fn run<T>(f: fn(int) -> T) -> T {\n  return f(1)\n}\n';
const mod = (body: string) => `module m\n${run}${body}${body.includes('fn main(') ? '' : 'fn main() {}\n'}`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.message, d.help ?? '']);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);

describe("a lambda's result from all its returns (card 050)", () => {
  test('`Ok(Err(...))` and `Ok(Ok(...))` say the rest of each other', () => {
    const src = mod(
      'fn g(n: int) -> Result<Result<int, string>, bool> {\n  return run((x) => {\n    if n < 0 {\n      return Ok(Err("neg"))\n    }\n    if n == 0 {\n      return Err(false)\n    }\n    return Ok(Ok(n + x))\n  })\n}\n',
    );
    expect(diags(src)).toEqual([]);
  });

  test('`return x` and `return none` make a `T?`, in either order and inside tuples', () => {
    expect(codes(mod('fn g() -> int? {\n  return run((n) => {\n    if n > 0 {\n      return n\n    }\n    return none\n  })\n}\n'))).toEqual([]);
    expect(codes(mod('fn g() -> int? {\n  return run((n) => {\n    if n > 0 {\n      return none\n    }\n    return n\n  })\n}\n'))).toEqual([]);
    expect(codes(mod('fn g() -> (int, string?) {\n  return run((n) => {\n    if n > 0 {\n      return (n, none)\n    }\n    return (n, "x")\n  })\n}\n'))).toEqual([]);
    expect(codes(mod('fn g() -> (int, bool)? {\n  return run((n) => {\n    if n > 0 {\n      return none\n    }\n    return (n, true)\n  })\n}\n'))).toEqual([]);
  });

  test('a `let` takes the widened type', () => {
    const src = mod('fn main() uses io {\n  let a = run((n) => {\n    if n > 5 {\n      return n\n    }\n    return none\n  })\n  io.println((a ?? 7).toString())\n}\n');
    expect(diags(src)).toEqual([]);
  });

  test('`[]` and `[:]` take their item types from another return', () => {
    expect(codes(mod('fn g() -> List<int> {\n  return run((n) => {\n    if n > 0 {\n      return []\n    }\n    return [n]\n  })\n}\n'))).toEqual([]);
  });

  test('what no return says comes from where the result goes', () => {
    expect(codes(mod('fn g() -> (int, string?) {\n  return run((n) => {\n    return (n, none)\n  })\n}\n'))).toEqual([]);
  });

  test('what nothing says is an error with the annotation to add', () => {
    expect(diags(mod('fn g() {\n  let f = run((n) => {\n    return (n, none)\n  })\n}\n'))).toContainEqual([
      'CAN0032',
      'cannot tell what this lambda returns: its returns say (int, _?), where `_` is not known',
      'annotate it: `(...): (int, T?) => ...`, with `T` the type meant, or return a value that says',
    ]);
  });

  test('returns that disagree: the first says the type, the other is the error', () => {
    expect(diags(mod('fn g() {\n  let f = run((n) => {\n    if n > 0 {\n      return 1\n    }\n    return "a"\n  })\n}\n'))).toContainEqual(['CAN0005', 'expected int, found string', '']);
    expect(codes(mod('fn g() {\n  let f = run((n) => {\n    if n > 0 {\n      return\n    }\n    return 1\n  })\n}\n'))).toContain('CAN0005');
  });

  test('`?` in the body says the error type', () => {
    const src = mod('fn p(s: string) -> Result<int, string> {\n  return Err(s)\n}\nfn g() -> Result<int, string> {\n  return run((n) => {\n    let v = p("x")?\n    return Ok(v + n)\n  })\n}\n');
    expect(codes(src)).toEqual([]);
  });

  test('widened values run as optionals', () => {
    const src = mod(
      'fn main() uses io {\n  let a = run((n) => {\n    if n > 5 {\n      return (n, "big")\n    }\n    return (n, none)\n  })\n  let (k, label) = a\n  io.println("${k} ${label ?? "small"}")\n  let b = run((n) => {\n    if n > 0 {\n      return none\n    }\n    return n\n  })\n  io.println((b ?? -1).toString())\n  let r = run((n) => {\n    if n < 0 {\n      return Ok(Err("neg"))\n    }\n    if n == 0 {\n      return Err(false)\n    }\n    return Ok(Ok(n * 10))\n  })\n  match r {\n    Ok(Ok(v)) => io.println(v.toString())\n    Ok(Err(e)) => io.println(e)\n    Err(_) => io.println("err")\n  }\n}\n',
    );
    expect(runCandor(src)).toBe('1 small\n-1\n10\n');
  }, 60_000);
});

// Card 121: a result type that names a parameter inside a part (`Result<(int, T), string>`) gave
// the returns `error` for that part, which won over what they said; emitting it crashed.
describe('a result partly written with type parameters', () => {
  const change = 'fn change<T>(f: fn(int) -> Result<(int, T), string>) -> Result<T, string> {\n  let (_, x) = f(1)?\n  return Ok(x)\n}\n';
  const lambda = 'change((n) => {\n    if n < 0 {\n      return Err("negative")\n    }\n    return Ok((n + 1, "x"))\n  })';

  test('the returns say the parameter, with or without a type where it goes', () => {
    expect(diags(`module m\n${change}fn g() -> Result<string, string> {\n  return ${lambda}\n}\nfn main() {}\n`)).toEqual([]);
    expect(diags(`module m\n${change}fn main() uses io {\n  let r = ${lambda}\n  io.println(r.toString())\n}\n`)).toEqual([]);
  });

  test('a part no return says is still the error to report', () => {
    const src = `module m\n${change}fn main() {\n  let r = ${lambda.replace('"x"', 'none')}\n}\n`;
    expect(diags(src)).toContainEqual([
      'CAN0032',
      'cannot tell what this lambda returns: its returns say Result<(int, _?), string>, where `_` is not known',
      'annotate it: `(...): Result<(int, T?), string> => ...`, with `T` the type meant, or return a value that says',
    ]);
  });

  test('it runs', () => {
    expect(runCandor(`module m\n${change}fn main() uses io {\n  let r = ${lambda}\n  io.println(r.toString())\n}\n`)).toBe('Ok("x")\n');
  }, 60_000);
});

// Card 124: a body that is an `if` or `match`, `Err(...)` in one branch and `Ok(...)` in another:
// the branches say the result together, as returns do.
describe('a lambda whose body is an `if` or a `match`', () => {
  const read = 'fn read<T>(n: int, f: fn(int) -> Result<T, string>) -> Result<T, string> {\n  return f(n)\n}\n';
  const body = (b: string) => `module m\n${read}fn main() uses io {\n  let r = read(3, (n) => ${b})\n  io.println(r.toString())\n}\n`;
  const byMatch = 'match n {\n    0 => Err("zero")\n    1 => {\n      let x = n * 10\n      Ok(x)\n    }\n    _ => Ok(n * 2)\n  }';
  const byIf = 'if n == 0 { Err("zero") } else if n == 1 { Ok(10) } else { match n {\n    2 => Err("two")\n    _ => Ok(n * 2)\n  } }';

  test('the branches say the result, through nested ones', () => {
    expect(diags(body(byMatch))).toEqual([]);
    expect(diags(body(byIf))).toEqual([]);
  });

  test('an `if` without `else` is still that error', () => {
    expect(codes(body('if n == 0 { Err("zero") }'))).toContain('CAN0022');
  });

  test('it runs', () => {
    expect(runCandor(body(byIf))).toBe('Ok(6)\n');
  }, 60_000);

  // The port's four shapes, where the call's result is returned: 0.0.15 missed these.
  const four = `module m

enum Refusal {
  Missing
}

fn read<T>(n: int, f: fn(int) -> Result<T, Refusal>) -> Result<T, Refusal> {
  return f(n)
}

fn find(n: int) -> int? {
  return if n > 0 { n } else { none }
}

fn a(k: int) -> Result<string, Refusal> {
  return read(k, (n) => match find(n) {
    none => Err(Refusal.Missing),
    x => Ok("\${x}"),
  })
}

fn b(k: int) -> Result<string, Refusal> {
  return read(k, (n) => {
    let m = n * 2
    return match find(m) {
      none => Err(Refusal.Missing),
      x => Ok("\${x}"),
    }
  })
}

fn c(k: int) -> Result<string, Refusal> {
  return read(k, (n) => if n > 0 { Ok("y") } else { Err(Refusal.Missing) })
}

fn d(k: int) -> Result<string, Refusal> {
  return read(k, (n) => match n {
    1 => Ok("one"),
    _ => Err(Refusal.Missing),
  })
}

fn main() uses io {
  for k in [0, 1] {
    io.println([a(k), b(k), c(k), d(k)].map((r) => r.isOk().toString()).join(" "))
  }
}
`;

  test('where the result goes is known: an expression body, a `return match`, either arm first', () => {
    expect(diags(four)).toEqual([]);
  });

  test('the four run', () => {
    expect(runCandor(four)).toBe('false false false false\ntrue true true true\n');
  }, 60_000);
});
