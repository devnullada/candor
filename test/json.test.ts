import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codes } from '../src/diagnostics';
import { compileSplit, writeModule } from './split';

// JSON: `impl Json for T` without a body derives it; `json.encode` and `json.decode` use it.

const errors = (src: string) =>
  compileSplit(`module m\nimport "json"\n${src}\nfn main() {}\n`, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

describe('impl Json', () => {
  test('is derived: a bodyless impl, and only for Json', () => {
    expect(errors('struct P {\n  a: int\n}\nimpl Json for P')).toEqual([]);
    expect(errors('struct P {\n  a: int\n}\nimpl Json for P {\n  fn toJson(self) -> string {\n    return ""\n  }\n}')).toEqual([
      [Codes.BadImpl, '`Json` is derived, not written', 'write `impl Json for P` with no body: the compiler writes it from the type; or give its JSON form by hand: `impl Json for P via string { fn toJson(self) -> string { ... } fn fromJson(x: string) -> Result<P, string> { ... } }`'],
    ]);
    expect(errors('trait S {\n  fn s(self) -> int\n}\nstruct P {\n  a: int\n}\nimpl S for P')).toEqual([
      [Codes.BadImpl, 'only `Json`, `Row` and `Show` are derived, so `impl S for P` needs a body', 'give the methods: `impl S for P { ... }`'],
    ]);
    expect(errors('impl Json for int')).toEqual([[Codes.BadImpl, 'int is `Json` already', undefined]]);
  });

  test('needs every field to be Json, and says how', () => {
    const src = `struct Inner {\n  n: int\n}\nstruct Outer {\n  inners: List<Inner?>\n  counts: Map<int, string>\n  pair: (int, int)\n  f: fn() -> int\n  fine: Map<string, List<bool?>>\n}\nimpl Json for Outer`;
    expect(errors(src)).toEqual([
      [Codes.Bound, '`impl Json for Outer` needs every field to be `Json`, and `Outer.inners` is List<Inner?>: Inner has no `impl Json`', 'derive it: `impl Json for Inner`'],
      [
        Codes.Bound,
        '`impl Json for Outer` needs every field to be `Json`, and `Outer.counts` is Map<int, string>: JSON object keys are strings, and Map<int, string> has int keys',
        'key it by string: `Map<string, string>`',
      ],
      [Codes.Bound, '`impl Json for Outer` needs every field to be `Json`, and `Outer.pair` is (int, int): (int, int) has no JSON form', 'JSON has no tuples: use a struct, with `impl Json` for it'],
      [
        Codes.Bound,
        '`impl Json for Outer` needs every field to be `Json`, and `Outer.f` is fn() -> int: fn() -> int has no JSON form',
        'JSON holds int, string, bool, `T?`, lists, maps with string keys, and types with `impl Json`',
      ],
    ]);
  });

  test("an enum with fields names its variant with `kind`, so a field can't be called that", () => {
    expect(errors('enum Msg {\n  Hello { kind: string }\n  Bye\n}\nimpl Json for Msg')).toEqual([
      [Codes.BadImpl, '`Msg.Hello` has a field `kind`, which `impl Json` uses to say which variant a value is', 'rename the field, or give it another JSON name with `as`: `{"kind":"Hello", ...}` is how Msg reads in JSON'],
    ]);
  });
});

describe('json.encode and json.decode', () => {
  test('take Json types, through a bound too', () => {
    const src = 'struct P {\n  a: int\n}\nfn f(p: P) -> string {\n  return json.encode([p])\n}';
    expect(errors(src)).toEqual([[Codes.Bound, '`json.encode` needs `T: Json`, and `T` is List<P> here: P has no `impl Json`', 'derive it: `impl Json for P`']]);
    const generic = 'fn read<T: Json>(s: string) -> T? {\n  return match json.decode<T>(s) {\n    Ok(v) => v,\n    Err(_) => none,\n  }\n}\nfn g() -> int? {\n  return read<int>("1")\n}';
    expect(errors(generic)).toEqual([]);
  });

  test('`decode` learns its type from where the value goes, or is told it', () => {
    expect(errors('fn f() -> Result<int, json.Error> {\n  return json.decode("1")\n}')).toEqual([]);
    expect(errors('fn f() {\n  let r = json.decode("1")\n}')[0].slice(0, 2)).toEqual([Codes.TypeArgs, "the arguments of `json.decode` don't say what `T` is"]);
  });

  test('come from the standard module, which another module named json clashes with', () => {
    const read = (f: string) => (f.endsWith('lib/json.candor') ? 'module json\n' : f.endsWith('a.candor') ? 'module a\nimport "lib/json"\n' : null);
    const r = compileSplit('module m\nimport "json"\nimport "a"\nfn main() {}\n', 'm.candor', 'main', { read });
    expect(r.diagnostics.map((d) => d.help)).toEqual(['`json` is a standard module (`import "json"`): name yours differently']);
  });

  test('a dictionary per type: derived impls, and the runtime for the rest', () => {
    const go = compileSplit('module m\nimport "json"\nstruct P {\n  a: int?\n}\nimpl Json for P\nfn main() uses io {\n  io.println(json.encode(["k": [P { a: none }]]))\n}\n', 'm.candor').go!;
    expect(go).toContain('json__encode[candor.Map[string, []m__P], candor.JsonMap[[]m__P, candor.JsonList[m__P, Json__for__m__P]]](ctx__');
    expect(go).toContain('(jsonOpt__[int64, candor.JsonInt]{}).Dec(in, x, candor.JsonAt(path, "a"))');
  });
});

const program = `module shapes
import "json"

enum Status {
  Open
  Done
}
impl Json for Status

enum Shape {
  Circle { r: int }
  Rect { w: int, h: int }
  Dot
}
impl Json for Shape

enum Expr {
  Num { v: int }
  Neg { e: Expr }
}
impl Json for Expr

enum Mark {
  Seen { by: string?, at: int }
}
impl Json for Mark

struct Node {
  name: string
  next: Node?
}
impl Json for Node

struct Item {
  id: int
  title: string
  note: string?
  tags: List<string>
  status: Status
  shapes: Map<string, Shape>
  kids: List<Item>
}
impl Json for Item

fn item() -> Item {
  return Item { id: 1, title: "say \\"hi\\"\\n", note: none, tags: ["x"], status: Status.Open, shapes: ["c": Shape.Circle { r: 2 }, "d": Shape.Dot], kids: [] }
}

fn why(text: string) -> string {
  return match json.decode<Item>(text) {
    Ok(_) => "ok",
    Err(e) => "\${e}",
  }
}

fn main() uses io {
  let a = item()
  let b = Item { ...a, id: 2, note: "n", status: Status.Done, kids: [a] }
  io.println(json.encode([a, b]))
  io.println(json.encode(Expr.Neg { e: Expr.Num { v: -3 } }))
  io.println(json.encode(Node { name: "a", next: Node { name: "b", next: none } }))
  io.println(json.encode([Mark.Seen { by: none, at: 1 }, Mark.Seen { by: "x", at: 2 }]))
}

test "what encode writes, decode reads" {
  let a = item()
  let b = Item { ...a, id: 2, note: "n", kids: [a] }
  assert json.decode<List<Item>>(json.encode([a, b])) == Ok([a, b])
  let e = Expr.Neg { e: Expr.Neg { e: Expr.Num { v: 1 } } }
  assert json.decode<Expr>(json.encode(e)) == Ok(e)
  assert json.decode<Node>("{\\"name\\": \\"a\\", \\"next\\": {\\"name\\": \\"b\\", \\"next\\": null}}") == Ok(Node { name: "a", next: Node { name: "b", next: none } })
}

test "unknown fields are skipped; a missing T? is none, a missing other field an error" {
  assert why("{\\"id\\":1,\\"title\\":\\"t\\",\\"tags\\":[],\\"status\\":\\"Open\\",\\"shapes\\":{},\\"kids\\":[],\\"extra\\":{}}") == "ok"
  assert why("{\\"id\\": 1}") == "$.title: missing"
}

test "errors say where" {
  let base = "\\"id\\":1,\\"title\\":\\"t\\",\\"kids\\":[]"
  assert why("{\${base},\\"tags\\":[],\\"status\\":\\"Shut\\",\\"shapes\\":{}}") == "$.status: expected one of \\"Open\\", \\"Done\\", found \\"Shut\\""
  assert why("{\${base},\\"tags\\":[1],\\"status\\":\\"Open\\",\\"shapes\\":{}}") == "$.tags[0]: expected a string, found 1"
  assert why("{\${base},\\"tags\\":[],\\"status\\":\\"Open\\",\\"shapes\\":{\\"a b\\":{\\"kind\\":\\"Oval\\"}}}") == "$.shapes[\\"a b\\"].kind: expected one of \\"Circle\\", \\"Rect\\", \\"Dot\\", found \\"Oval\\""
  assert why("{\${base},\\"tags\\":[],\\"status\\":\\"Open\\",\\"shapes\\":{\\"r\\":{\\"kind\\":\\"Rect\\",\\"w\\":1}}}") == "$.shapes.r.h: missing"
  assert why("[1,") == "$: not JSON: it ends too soon"
  assert json.decode<int>("1.5") == Err(json.Error { path: "$", message: "expected an integer, found 1.5" })
}
`;

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

test(
  'runs: structs, both kinds of enum, recursion, optionals, lists and maps',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'json');
    mkdirSync(dir, { recursive: true });
    writeModule(path.join(dir, 'shapes.candor'), program);
    const r = cli(dir, 'run', 'shapes.candor', '--out', path.join(dir, 'out'));
    expect(r.stderr).toBe('');
    const item = (id: number, note: string, status: string, kids: string) =>
      `{"id":${id},"title":"say \\"hi\\"\\n",${note}"tags":["x"],"status":"${status}","shapes":{"c":{"kind":"Circle","r":2},"d":{"kind":"Dot"}},"kids":[${kids}]}`;
    // A field that is none is left out.
    const a = item(1, '', 'Open', '');
    expect(r.stdout).toBe(
      [
        `[${a},${item(2, '"note":"n",', 'Done', a)}]`,
        '{"kind":"Neg","e":{"kind":"Num","v":-3}}',
        '{"name":"a","next":{"name":"b"}}',
        '[{"kind":"Seen","at":1},{"kind":"Seen","by":"x","at":2}]',
        '',
      ].join('\n'),
    );
    const t = cli(dir, 'test', 'shapes.candor', '--out', path.join(dir, 'out-test'));
    expect(t.stdout).toContain('3 passed, 0 failed');
  },
  120_000,
);

// Card 122: `json.encodeIndented`, as JavaScript's `JSON.stringify(v, null, 2)`.
test(
  'encodeIndented lays the JSON out as JSON.stringify(v, null, 2) does',
  () => {
    const dir = path.join(tmpdir(), 'candor-test', 'json-indent');
    mkdirSync(dir, { recursive: true });
    const src = `module m

import "json"

struct Item {
  title: string
  tags: List<string>
  extra: Map<string, int>
  done: bool?
}
impl Json for Item

fn main() uses io {
  let items = [Item { title: "a \\"b\\"\\n", tags: ["x", "y"], extra: [:] }, Item { title: "c", tags: [], extra: ["k": 1], done: true }]
  io.println(json.encodeIndented(items))
  io.println(json.encodeIndented(1))
  io.println(json.encodeIndented<List<int>>([]))
}

test "indented" {
  assert json.encodeIndented(["a": [1, 2]]) == "{\\n  \\"a\\": [\\n    1,\\n    2\\n  ]\\n}"
}
`;
    writeModule(path.join(dir, 'main.candor'), src);
    const r = cli(dir, 'run', 'main.candor', '--out', path.join(dir, 'out'));
    expect(r.stderr).toBe('');
    const tasks = [
      { title: 'a "b"\n', tags: ['x', 'y'], extra: {} },
      { title: 'c', tags: [], extra: { k: 1 }, done: true },
    ];
    expect(r.stdout).toBe([JSON.stringify(tasks, null, 2), '1', '[]', ''].join('\n'));
    expect(cli(dir, 'test', 'main.candor', '--out', path.join(dir, 'out-test')).stdout).toContain('1 passed, 0 failed');
  },
  120_000,
);
