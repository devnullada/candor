import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

const diags = (src: string, severity = 'error') =>
  compile(`module m\n${src}\n`, 'main.candor', 'main', { read: () => null })
    .diagnostics.filter((d) => d.severity === severity)
    .map((d) => [d.code, d.message, d.help]);

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

/** Runs `files` (the first is the program) and gives its output. */
function run(name: string, files: Record<string, string>): string {
  const dir = path.join(tmpdir(), 'candor-test', name);
  mkdirSync(dir, { recursive: true });
  for (const [f, src] of Object.entries(files)) writeFileSync(path.join(dir, f), src);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', Object.keys(files)[0], '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  return r.stdout;
}

const greet = `trait Greet {
  fn name(self) -> string
  fn greet(self) uses io {
    io.println("hello, \${self.name()}\${self.mark()}")
  }
  fn mark(self) -> string {
    return "!"
  }
}
`;

const store = `trait Store {
  fn save(self) uses io
}
struct A {}
`;

describe('default method bodies', () => {
  test('may be left out of an impl; the others may not', () => {
    const p = 'struct P {}\n';
    expect(diags(`${greet}${p}impl Greet for P {\n  fn mark(self) -> string {\n    return "?"\n  }\n}\nfn main() {}`)).toEqual([
      [Codes.BadImpl, '`impl Greet for P` has no `name`', 'an impl gives every method of its trait'],
    ]);
    const all = 'trait Hi {\n  fn hi(self) -> string {\n    return "hi"\n  }\n}\n';
    expect(diags(`${all}${p}impl Hi for P\nfn main() {}`)).toEqual([
      [Codes.BadImpl, 'only `Json`, `Row` and `Show` are derived, so `impl Hi for P` needs a body', 'every method of `Hi` has a default: write `impl Hi for P {}`'],
    ]);
    expect(diags(`${all}${p}impl Hi for P {}\nfn main() {}`)).toEqual([]);
  });

  test('see `self` through the trait, and do only their method\'s effects', () => {
    const t = (body: string) => `trait T {\n  fn name(self) -> string\n  fn go(self) -> string {\n    ${body}\n  }\n}\nfn main() {}`;
    expect(diags(t('return self.name()'))).toEqual([]);
    expect(diags(t('return self.size'))[0][1]).toContain('size');
    expect(diags(t('io.println("x")\n    return ""'))).toEqual([
      [Codes.UndeclaredEffect, '`io` is used here but `go` does not declare it', 'add `uses io` to the signature of `fn go`'],
    ]);
  });

  test('declaring an effect they do not use is no slip: the trait says it for every impl', () => {
    const t = 'trait T {\n  fn go(self) uses io {\n  }\n}\nfn main() {}';
    expect(diags(t, 'warning')).toEqual([]);
  });
});

describe('trait methods with effects', () => {
  test('an impl may do fewer, never more', () => {
    expect(diags(`${store}impl Store for A {\n  fn save(self) {\n  }\n}\nfn main() {}`)).toEqual([]);
    expect(diags(`${store}impl Store for A {\n  fn save(self) uses io, clock {\n    io.println("\${clock.now()}")\n  }\n}\nfn main() {}`)).toEqual([
      [
        Codes.BadImpl,
        '`save` uses `clock`, which `Store.save` does not declare',
        "an impl's method may do fewer effects than its trait says, not more: add `clock` to `uses` of `save` in `trait Store`, or do it in the function that calls `save`",
      ],
    ]);
  });

  test("every caller declares the trait's effects, through a bound or on a known type", () => {
    const impl = 'impl Store for A {\n  fn save(self) {\n  }\n}\n';
    expect(diags(`${store}${impl}fn put<T: Store>(x: T) {\n  x.save()\n}\nfn main() {}`)).toEqual([
      [Codes.UndeclaredEffect, '`save` uses `io`, which `put` does not declare', 'add `uses io` to the signature of `fn put`'],
    ]);
    expect(diags(`${store}${impl}fn main() {\n  A {}.save()\n}`)).toEqual([
      [Codes.UndeclaredEffect, '`save` uses `io`, which `main` does not declare', 'add `uses io` to the signature of `fn main`'],
    ]);
    expect(diags(`${store}${impl}fn put<T: Store>(x: T) uses io {\n  x.save()\n}\nfn main() uses io {\n  put(A {})\n}`)).toEqual([]);
  });

  test('name effects, not parameters', () => {
    expect(diags('trait S {\n  fn s(self, f: fn()) uses f\n}\nfn main() {}')).toEqual([
      [Codes.BadImpl, "a method's `uses` names effects, and `f` is a parameter", 'methods take no `uses f` yet: call `f` in a plain function with `uses f`'],
    ]);
  });

  test('lower to hidden parameters; a default to a generic function an impl forwards to', () => {
    const src = `module m\n${greet}struct P {}\nimpl Greet for P {\n  fn name(self) -> string {\n    return "p"\n  }\n}\nfn main() uses io {\n  P {}.greet()\n}\n`;
    const r = compile(src, 'main.candor', 'main', { read: () => null });
    expect(r.diagnostics).toEqual([]);
    const out = r.go!;
    expect(out).toContain('\tgreet(*candor.Ctx, candor.IO, Self__) struct{}');
    expect(out).toContain('func m__Greet__greet__default[Self__ any, Self__m__Greet m__Greet[Self__]](ctx__ *candor.Ctx, io candor.IO, self Self__) struct{} {');
    expect(out).toContain('\treturn m__Greet__greet__default[m__P, m__Greet__for__m__P](ctx__, io, a0)');
    expect(out).toContain('(m__Greet__for__m__P{}).greet(ctx__, io, m__P{})');
  });
});

describe('running', () => {
  test('a default runs where an impl leaves it out, an override wins, through bounds and generic impls', () => {
    const src = `module t
${greet}
struct Dog {
  n: string
}
impl Greet for Dog {
  fn name(self) -> string {
    return self.n
  }
}

struct Cat {}
impl Greet for Cat {
  fn name(self) -> string {
    return "cat"
  }
  fn greet(self) {}
  fn mark(self) -> string {
    return "?"
  }
}

struct Box<T> {
  v: T
}
impl<T: Show> Greet for Box<T> {
  fn name(self) -> string {
    return "box of \${self.v}"
  }
}

fn all<T: Greet>(xs: List<T>) uses io {
  for x in xs {
    x.greet()
  }
}

fn main() uses io {
  Dog { n: "rex" }.greet()
  Cat {}.greet()
  all([Dog { n: "a" }, Dog { n: "b" }])
  Box { v: 3 }.greet()
  io.println(Cat {}.mark())
}
`;
    expect(run('trait-defaults', { 't.candor': src })).toBe('hello, rex!\nhello, a!\nhello, b!\nhello, box of 3!\n?\n');
  });

  test("an impl in another module takes the trait's default", () => {
    const lib = `module greet\n\npub ${greet}`;
    const main = `module t
import "greet"

struct Dog {}
impl greet.Greet for Dog {
  fn name(self) -> string {
    return "dog"
  }
}

fn main() uses io {
  Dog {}.greet()
}
`;
    expect(run('trait-defaults-modules', { 't.candor': main, 'greet.candor': lib })).toBe('hello, dog!\n');
  });
});
