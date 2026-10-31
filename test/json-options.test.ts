import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';
import { jsonName } from '../src/types';

// JSON options: renamed fields (`impl Json(snake)`, `as "type"`), a form by hand (`via`), and
// `json.decodeStrict`.

const errors = (src: string) =>
  compile(`module m\nimport "json"\n${src}\nfn main() {}\n`, 't.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message, d.help]);

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function run(name: string, src: string): string {
  const dir = path.join(tmpdir(), 'candor-test', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 't.candor'), src);
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
  expect(r.stderr).toBe('');
  return r.stdout;
}

const money = `struct Money {
  cents: int
}
impl Json for Money via string {
  fn toJson(self) -> string {
    let c = self.cents % 100
    return "\${self.cents / 100}.\${if c < 10 { "0\${c}" } else { "\${c}" }}"
  }
  fn fromJson(s: string) -> Result<Money, string> {
    let parts = s.split(".")
    let whole = (parts[0] ?? "").toInt() ?? -1
    let frac = (parts[1] ?? "").toInt() ?? -1
    if parts.length() != 2 || whole < 0 || frac < 0 || (parts[1] ?? "").length() != 2 {
      return Err("expected an amount like \\"12.50\\", found \\"\${s}\\"")
    }
    return Ok(Money { cents: whole * 100 + frac })
  }
}
`;

describe('names in JSON', () => {
  test('words break at `_` and capitals; a rule joins them, `as` overrides it', () => {
    const names = (rule: string) => ['createdAt', 'created_at', 'userID', 'HTTPServer', 'v2Count', 'InProgress', 'id'].map((name) => jsonName({ name }, rule));
    expect(names('snake')).toEqual(['created_at', 'created_at', 'user_id', 'http_server', 'v2_count', 'in_progress', 'id']);
    expect(names('kebab')).toEqual(['created-at', 'created-at', 'user-id', 'http-server', 'v2-count', 'in-progress', 'id']);
    expect(names('camel')).toEqual(['createdAt', 'createdAt', 'userID', 'httpServer', 'v2Count', 'inProgress', 'id']);
    expect(names('pascal')).toEqual(['CreatedAt', 'CreatedAt', 'UserID', 'HTTPServer', 'V2Count', 'InProgress', 'Id']);
    expect(jsonName({ name: 'kind_', wire: 'type' }, 'snake')).toBe('type');
    expect(jsonName({ name: 'createdAt' }, null)).toBe('createdAt');
  });

  test('a rule is for `impl Json`, and one of four', () => {
    expect(errors('struct P {\n  a: int\n}\nimpl Show(snake) for P')).toEqual([[Codes.BadImpl, 'a naming rule is for `impl Json`, whose fields have names in JSON', 'write `impl Show for P`']]);
    expect(errors('struct P {\n  a: int\n}\nimpl Json(snak) for P')).toEqual([
      [Codes.BadImpl, '`snak` is not a naming rule', 'did you mean `snake`? the rules are `snake` (created_at), `kebab` (created-at), `camel` (createdAt) and `pascal` (CreatedAt); `nulls` writes a none field as `null`'],
    ]);
  });

  test('each is used once, and a tagged variant leaves `kind` free', () => {
    expect(errors('struct P {\n  createdAt: int\n  created_at: int\n}\nimpl Json(snake) for P')).toEqual([
      [Codes.BadImpl, "P's fields `createdAt` and `created_at` are both `\"created_at\"` in JSON", 'give one of them another name with `as`: `created_at: ... as "created_at2"`'],
    ]);
    expect(errors('enum S {\n  Open as "x"\n  Shut as "x"\n}\nimpl Json for S')[0][1]).toBe("S's variants `Open` and `Shut` are both `\"x\"` in JSON");
    expect(errors('enum M {\n  Hi { sort: string as "kind" }\n}\nimpl Json for M')).toEqual([
      [
        Codes.BadImpl,
        '`M.Hi` has a field `sort`, `"kind"` in JSON, which `impl Json` uses to say which variant a value is',
        'rename the field, or give it another JSON name with `as`: `{"kind":"Hi", ...}` is how M reads in JSON',
      ],
    ]);
  });

  test('`as` needs a derived `impl Json` to mean something', () => {
    expect(errors('struct P {\n  a: int as "b"\n}')).toEqual([[Codes.BadImpl, '`as "b"` names `a` in JSON, and P has no `impl Json`', 'derive it: `impl Json for P`, or drop `as "b"` (it also names a flag of a struct this module gives `flags.parse`)']]);
    expect(errors('enum S {\n  Open as "open"\n}')[0][1]).toBe('`as "open"` names `Open` in JSON, and S has no `impl Json`');
    expect(errors('struct P {\n  a: int as "b"\n}\nimpl Json for P via int {\n  fn toJson(self) -> int {\n    return self.a\n  }\n  fn fromJson(a: int) -> Result<P, string> {\n    return Ok(P { a })\n  }\n}')).toEqual([
      [Codes.BadImpl, '`as "b"` names `a` in JSON, and P writes its JSON by hand, with `via`', 'drop `as "b"`: `toJson` decides the form'],
    ]);
  });
});

describe('impl Json ... via', () => {
  const p = 'struct P {\n  a: int\n}\n';
  test('gives toJson and fromJson, of the right types, without effects', () => {
    expect(errors(`${p}impl Json for P via int`)).toEqual([
      [Codes.BadImpl, '`impl Json for P via int` needs a body', 'give the two conversions: `impl Json for P via int { fn toJson(self) -> int { ... } fn fromJson(x: int) -> Result<P, string> { ... } }`'],
    ]);
    expect(errors(`${p}impl Json for P via int {\n  fn toJson(self) -> int {\n    return self.a\n  }\n}`)).toEqual([
      [Codes.BadImpl, '`impl Json for P` has no `fromJson`', '`via int` writes P as int and reads it back: give both, `{ fn toJson(self) -> int { ... } fn fromJson(x: int) -> Result<P, string> { ... } }`'],
    ]);
    expect(errors(`${p}impl Json for P via int {\n  fn toJson(self) -> string {\n    return ""\n  }\n  fn fromJson(self) -> Result<P, string> {\n    return Ok(self)\n  }\n}`)).toEqual([
      [Codes.TypeMismatch, '`toJson` must have the signature `Json` gives it: expected fn(P) -> int, found fn(P) -> string', undefined],
      [Codes.BadImpl, '`fromJson` makes a value, so it takes the JSON form, not `self`', 'write `fn fromJson(x: int) -> Result<P, string>`'],
    ]);
    expect(errors(`${p}impl Json for P via int {\n  fn toJson(self) -> int uses io {\n    io.println("x")\n    return self.a\n  }\n  fn fromJson(a: int) -> Result<Self, string> {\n    return Ok(P { a })\n  }\n}`)).toEqual([
      [Codes.BadImpl, '`toJson` uses `io`, and a JSON form takes no effects', '`toJson` and `fromJson` only convert: do what needs `io` before encoding or after decoding'],
    ]);
  });

  test('goes via a Json type other than itself, for Json only', () => {
    expect(errors(`${p}impl Json for P via P {\n}`)[0][1]).toBe("P can't be written via itself");
    expect(errors(`struct Q {\n  b: int\n}\n${p}impl Json for P via Q {\n  fn toJson(self) -> Q {\n    return Q { b: self.a }\n  }\n  fn fromJson(q: Q) -> Result<P, string> {\n    return Ok(P { a: q.b })\n  }\n}`)).toEqual([
      [Codes.Bound, '`via Q` needs Q to be `Json`: Q has no `impl Json`', 'derive it: `impl Json for Q`'],
    ]);
    expect(errors(`${p}impl Show for P via string {\n}`)).toEqual([[Codes.BadImpl, '`via` is for `impl Json`, to write a type\'s JSON form by hand', 'write `impl Show for P`']]);
    expect(errors(`${p}impl Json(snake) for P via int {\n}`)[0][1]).toBe('`impl Json ... via` writes the JSON form by hand, so no rule names its fields');
  });

  test('lowers to Enc and Dec through the form\'s dictionary', () => {
    const r = compile(`module m\nimport "json"\n${money}fn main() uses io {\n  io.println(json.encode(Money { cents: 5 }))\n}\n`, 't.candor');
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.go!).toContain('(candor.JsonString{}).Enc(o, d.toJson(o.Ctx, v))');
    expect(r.go!).toContain('r := d.fromJson(in.Ctx, x)');
  });
});

const program = `module t
import "json"

${money}
enum Status {
  InProgress
  Done as "finished"
}
impl Json(snake) for Status

enum Event {
  Created { atMs: int }
  Moved { fromCol: string, toCol: string as "to" }
}
impl Json(kebab) for Event

struct Item {
  itemID: int
  createdAt: int
  kind_: string as "type"
  price: Money
  prices: List<Money>
  refund: Money?
  status: Status
  events: List<Event>
  tags: Map<string, int>
}
impl Json(snake) for Item

struct Page<T> {
  items: List<T>
  nextCursor: string?
}
impl<T: Json> Json(snake) for Page<T>

struct Wrap<T> {
  v: T
}
impl<T: Json> Json for Wrap<T> via T {
  fn toJson(self) -> T {
    return self.v
  }
  fn fromJson(v: T) -> Result<Wrap<T>, string> {
    return Ok(Wrap { v })
  }
}

struct Empty {}
impl Json for Empty

fn show<T: Json>(r: Result<T, json.Error>) -> string {
  return match r {
    Ok(v) => "ok \${json.encode(v)}",
    Err(e) => "\${e}",
  }
}

fn main() uses io {
  let it = Item { itemID: 1, createdAt: 5, kind_: "x", price: Money { cents: 1250 }, prices: [Money { cents: 7 }], refund: none, status: .InProgress, events: [Event.Created { atMs: 3 }, Event.Moved { fromCol: "a", toCol: "b" }], tags: ["k": 1] }
  let text = json.encode(it)
  io.println(text)
  io.println("\${json.decode<Item>(text) == Ok(it)} \${json.decodeStrict<Item>(text) == Ok(it)}")
  io.println(json.encode(Page { items: [Status.Done], nextCursor: "c" }))
  io.println(show(json.decode<Page<Status>>("{\\"items\\":[\\"finished\\",\\"in_progress\\"]}")))
  io.println(json.encode([Wrap { v: 3 }]))
  io.println(show(json.decode<List<Wrap<Money>>>("[\\"1.00\\", \\"2.5\\"]")))
  io.println(show(json.decode<Status>("\\"Done\\"")))
  let bad = "{\\"item_id\\":1,\\"created_at\\":5,\\"type\\":\\"x\\",\\"price\\":\\"1.00\\",\\"prices\\":[],\\"status\\":\\"finished\\",\\"events\\":[{\\"kind\\":\\"moved\\",\\"from-col\\":\\"a\\",\\"to\\":\\"b\\",\\"by\\":\\"me\\"}],\\"tags\\":{\\"any\\":2},\\"extra\\":1}"
  io.println(show(json.decode<Item>(bad)))
  io.println(show(json.decodeStrict<Item>(bad)))
  io.println(show(json.decodeStrict<Item>(bad.replaceAll(",\\"extra\\":1", ""))))
  io.println(show(json.decodeStrict<Empty>("{\\"a\\":1}")))
  io.println(show(json.decodeStrict<Map<string, int>>("{\\"a\\":1}")))
}
`;

describe('running', () => {
  test('renamed fields, forms by hand and strict decoding round-trip', () => {
    expect(run('json-options', program).split('\n')).toEqual([
      '{"item_id":1,"created_at":5,"type":"x","price":"12.50","prices":["0.07"],"status":"in_progress","events":[{"kind":"created","at-ms":3},{"kind":"moved","from-col":"a","to":"b"}],"tags":{"k":1}}',
      'true true',
      '{"items":["finished"],"next_cursor":"c"}',
      'ok {"items":["finished","in_progress"]}',
      '[3]',
      '$[1]: expected an amount like "12.50", found "2.5"',
      '$: expected one of "in_progress", "finished", found "Done"',
      'ok {"item_id":1,"created_at":5,"type":"x","price":"1.00","prices":[],"status":"finished","events":[{"kind":"moved","from-col":"a","to":"b"}],"tags":{"any":2}}',
      '$.extra: unknown field; expected one of "item_id", "created_at", "type", "price", "prices", "refund", "status", "events", "tags"',
      '$.events[0].by: unknown field; expected one of "kind", "from-col", "to"',
      '$.a: unknown field; expected no fields',
      'ok {"a":1}',
      '',
    ]);
  });
});

describe('impl Json(nulls)', () => {
  test('is for Json, once, and not with via', () => {
    const p = 'struct P {\n  a: int?\n}\n';
    expect(errors(`${p}impl Show(nulls) for P {\n  fn toString(self) -> string {\n    return ""\n  }\n}`)[0][1]).toBe('`nulls` is for `impl Json`: it writes a none field as `null`');
    expect(errors(`${p}impl Json(nulls, nulls) for P`)[0][1]).toBe('`nulls` is given twice');
    expect(errors(`${p}impl Json(snake, camel) for P`)[0]).toEqual([
      Codes.BadImpl,
      '`camel` comes after the naming rule `snake`',
      'an impl takes one naming rule and `nulls`, at most: `impl Json(snake, nulls) for P`',
    ]);
    expect(errors(`${p}impl Json(nulls) for P via int {\n}`)[0][1]).toBe('`impl Json ... via` writes the JSON form by hand, so `nulls` has no fields to write');
    expect(errors(`${p}impl Json(snake, nulls) for P`)).toEqual([]);
    expect(errors(`${p}impl Json(nulls, snake) for P`)).toEqual([]);
  });

  test('writes a none field as null, in structs and variants, and reads it back', () => {
    const src = `module m
import "json"

struct Quote {
  total: int
  couponCode: string?
}
impl Json(snake, nulls) for Quote

enum Event {
  Paid { by: string? }
}
impl Json(nulls) for Event

struct Plain {
  note: string?
}
impl Json for Plain

fn main() uses io {
  io.println(json.encode(Quote { total: 9 }))
  io.println(json.encode(Quote { total: 9, couponCode: "X" }))
  io.println(json.encode(Event.Paid { by: none }))
  io.println(json.encode(Plain { note: none }))
  io.println("\${json.decode<Quote>(json.encode(Quote { total: 9 })) == Ok(Quote { total: 9 })}")
}
`;
    expect(run('json-nulls', src).split('\n')).toEqual([
      '{"total":9,"coupon_code":null}',
      '{"total":9,"coupon_code":"X"}',
      '{"kind":"Paid","by":null}',
      '{}',
      'true',
      '',
    ]);
  });
});
