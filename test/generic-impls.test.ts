import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

const errors = (src: string, files: Record<string, string> = {}) =>
  compile(`module m\n${src}\nfn main() {}\n`, 'main.candor', 'main', { read: (f) => files[f] ?? null })
    .diagnostics.filter((d) => d.severity === 'error')
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

describe('generic impls', () => {
  test('name the type parameters of their type, in order', () => {
    const box = 'struct Box<T> {\n  value: T\n}\n';
    expect(errors(`${box}impl Show for Box<int>`)).toEqual([
      [
        Codes.BadImpl,
        "an impl for Box<int> is for every `Box`, so its type arguments are the impl's own type parameters, in order",
        'write `impl<T: Show> Show for Box<T>`',
      ],
    ]);
    expect(errors(`struct Two<A, B> {\n  a: A\n  b: B\n}\nimpl<A: Show, B: Show> Show for Two<B, A>`)[0][2]).toBe('write `impl<A: Show, B: Show> Show for Two<A, B>`');
    expect(errors('struct P {\n  x: int\n}\nimpl<T> Show for P')).toEqual([[Codes.BadImpl, 'P has no type parameters, so the impl takes none', 'write `impl Show for P`']]);
    expect(errors(`${box}impl<T: Show> Show for Box<T>\nimpl<U: Show> Show for Box<U>`)).toEqual([[Codes.BadImpl, '`Box` already has `impl Show`, for every `Box`', undefined]]);
    expect(errors('struct R<T> {\n  v: T\n}\nimpl<T> Row for R<T>')[0][1]).toBe('`impl Row` is for a struct without type parameters, since its fields are the columns');
  });

  test("a use checks the impl's bounds on the type arguments", () => {
    const src =
      'struct Box<T> {\n  value: T\n}\nimpl<T: Show> Show for Box<T> {\n  fn toString(self) -> string {\n    return "box of ${self.value}"\n  }\n}\nstruct S {\n  x: int\n}\n' +
      'fn f(b: Box<S>) -> string {\n  return b.toString()\n}';
    expect(errors(src)).toEqual([
      [
        Codes.Bound,
        '`toString` needs Box<S> to be `Show`: Box<S> is `Show` when `T` is `Show`, and S has no `impl Show`',
        'derive it: `impl Show for S`, or write it: `impl Show for S { fn toString(self) -> string { ... } }`',
      ],
    ]);
  });

  test('a method may name the type parameters', () => {
    const src = 'trait Size {\n  fn size(self) -> int\n}\nstruct Box<T> {\n  items: List<T>\n}\nimpl<T> Size for Box<T> {\n  fn size(self) -> int {\n    let xs: List<T> = self.items\n    return xs.length()\n  }\n}';
    expect(errors(src)).toEqual([]);
  });

  test('lowering: a dictionary type with the type parameters and their dictionaries', () => {
    const r = compile('module m\nstruct Box<T> {\n  value: T\n}\nimpl<T: Show> Show for Box<T>\nfn main() uses io {\n  io.println("${Box { value: 1 }}")\n}\n', 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('type Show__for__m__Box[T__ any, T__Show Show__[T__]] struct{}');
    expect(r.go).toContain('(Show__for__m__Box[int64, showGo__[int64]]{}).toString(ctx__, ');
  });
});

describe('derived Show', () => {
  test('every field must be Show', () => {
    expect(errors('struct C {\n  x: int\n}\nstruct O {\n  c: C\n  f: fn() -> int\n}\nimpl Show for O')).toEqual([
      [Codes.Bound, '`impl Show for O` needs every field to be `Show`, and `O.c` is C: C has no `impl Show`', 'derive it: `impl Show for C`, or write it: `impl Show for C { fn toString(self) -> string { ... } }`'],
      [Codes.Bound, '`impl Show for O` needs every field to be `Show`, and `O.f` is fn() -> int: fn() -> int has no `impl Show`', 'a string shows int, string, bool, lists, maps, optionals and Results of those, and types with `impl Show`'],
    ]);
    expect(errors('struct Bag<T> {\n  value: T\n}\nimpl<T> Show for Bag<T>')).toEqual([
      [Codes.Bound, '`impl Show for Bag` needs every field to be `Show`, and `Bag.value` is T: `T` has no bound `Show`', 'add the bound where `T` is declared: `<T: Show>`'],
    ]);
  });
});

test(
  'runs: Show for lists, optionals and Results, derived and generic impls',
  () => {
    const src = `module shows
struct Point {
  x: int
  name: string
}
impl Show for Point

enum Tree<T> {
  Leaf
  Node { left: Tree<T>, value: T, right: Tree<T> }
}
impl<T: Show> Show for Tree<T>

struct Box<T> {
  value: T
}
impl<T: Show> Show for Box<T> {
  fn toString(self) -> string {
    return "box of \${self.value}"
  }
}

struct Order {
  id: int
}
impl Show for Order {
  fn toString(self) -> string {
    return "#\${self.id}"
  }
}

fn label<T: Show>(x: T) -> string {
  return "<\${x}>"
}

fn main() uses io {
  let some: int? = 3
  let name: string? = "ann"
  let failed: Result<int, string> = Err("bad")
  let done: Result<void, string> = Ok()
  io.println("\${[1, 2]} \${some} \${name} \${failed} \${done} \${["a", "b"]} \${[name]}")
  io.println("\${Point { x: 1, name: "ann" }} \${Tree.Node { left: Tree.Leaf, value: "x", right: Tree.Leaf }}")
  io.println("\${Box { value: [Order { id: 7 }] }} \${Box<int?> { value: none }}")
  io.println(label([Point { x: 2, name: "bo" }]) + [Order { id: 1 }].toString())
}
`;
    expect(run('generic-impls', { 'shows.candor': src })).toBe(
      [
        '[1, 2] 3 ann Err("bad") Ok() ["a", "b"] ["ann"]',
        'Point { x: 1, name: "ann" } Tree.Node { left: Tree.Leaf, value: "x", right: Tree.Leaf }',
        'box of [#7] box of none',
        '<[Point { x: 2, name: "bo" }]>[#1]',
        '',
      ].join('\n'),
    );
  },
  120_000,
);

test(
  "runs: generic Json, and another module's generic impl",
  () => {
    const page = `module page
import "json"

pub struct Page<T> {
  pub items: List<T>
  pub next: string?
}
impl<T: Json> Json for Page<T>
impl<T: Show> Show for Page<T>
`;
    const src = `module main
import "json"
import "page"

struct Todo {
  id: int
  title: string
}
impl Json for Todo
impl Show for Todo

enum Reply<T> {
  Found { value: T }
  Missing
}
impl<T: Json> Json for Reply<T>

fn main() uses io {
  let s = json.encode(page.Page { items: [Todo { id: 1, title: "milk" }], next: none })
  io.println(s)
  match json.decode<page.Page<Todo>>(s) {
    Ok(back) => io.println("\${back}")
    Err(e) => io.println("\${e}")
  }
  io.println(json.encode(Reply.Found { value: 3 }) + json.encode(Reply<int>.Missing))
}
`;
    expect(run('generic-json', { 'main.candor': src, 'page.candor': page })).toBe(
      ['{"items":[{"id":1,"title":"milk"}]}', 'Page { items: [Todo { id: 1, title: "milk" }], next: none }', '{"kind":"Found","value":3}{"kind":"Missing"}', ''].join('\n'),
    );
  },
  120_000,
);
