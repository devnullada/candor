import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';

// A `match` that takes `none` and doesn't fall through narrows its subject below it;
// an arm may bind the subject's name again; `.Variant` names a variant of the matched enum.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'patterns', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const errors = (src: string) => compile(`${src}\nfn main() {}\n`, 'm.candor').diagnostics.filter((d) => d.severity === 'error');
const prelude = `module m

struct Todo { id: int, title: string }

enum Payment {
  Pending
  Paid { at: int }
  Refunded { at: int, reason: string }
}
`;

test('the three features compile and run', () => {
  const r = run(
    'all',
    `${prelude}
fn find(todos: List<Todo>, id: int) -> Todo? {
  for t in todos {
    if t.id == id { return t }
  }
  return none
}

fn title(todos: List<Todo>, id: int) -> string {
  let t = find(todos, id)
  match t {
    none => return "missing"
    _ => {}
  }
  return t.title
}

fn get(todos: List<Todo>, id: int) -> Result<Todo, string> {
  let t = find(todos, id)
  return match t {
    none => Err("no todo \${id}"),
    t => Ok(t),
  }
}

fn upper(todos: List<Todo>, id: int) -> string {
  let t = find(todos, id)
  match t {
    none => return "-"
    t => { if t.id == 0 { return "zero" } }
  }
  return t.title.toUpperCase()
}

fn describe(p: Payment) -> string {
  return match p {
    .Pending => "pending",
    .Paid { at } => "paid at \${at}",
    .Refunded { reason } => reason,
  }
}

fn main() uses io {
  let todos = [Todo { id: 1, title: "milk" }, Todo { id: 2, title: "eggs" }]
  io.println(title(todos, 1))
  io.println(title(todos, 9))
  match get(todos, 2) {
    Ok(t) => io.println(t.title)
    Err(e) => io.println(e)
  }
  match get(todos, 3) {
    Ok(t) => io.println(t.title)
    Err(e) => io.println(e)
  }
  io.println(upper(todos, 2))
  io.println(describe(Payment.Pending))
  io.println(describe(Payment.Paid { at: 5 }))
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.replace(/\r\n/g, '\n')).toBe(['milk', 'missing', 'eggs', 'no todo 3', 'EGGS', 'pending', 'paid at 5', ''].join('\n'));
});

test('an arm that falls through keeps the subject optional', () => {
  const [e] = errors(`${prelude}
fn f(t: Todo?) -> string {
  match t {
    none => {}
    _ => {}
  }
  return t.title
}
`);
  expect(e?.message).toContain('Todo?');
});

test('a name before any `none` arm takes the whole optional, and the arm after it is unreachable', () => {
  const src = `${prelude}
fn f(t: Todo?) -> string {
  match t {
    x => { let _n = x ?? Todo { id: 0, title: "" } }
    none => return ""
  }
  return ""
}
`;
  expect(errors(src)).toEqual([]);
  const warn = compile(`${src}\nfn main() {}\n`, 'm.candor').diagnostics.find((d) => d.code === Codes.UnreachableArm);
  expect(warn?.message).toBe('this arm can never match: the arms above cover `none`');
  expect(warn?.help).toContain('move this arm above it');
});

test('`_` after a `none` arm sees the subject narrowed', () => {
  expect(
    errors(`${prelude}
fn f(t: Todo?) -> string {
  return match t {
    none => "",
    _ => t.title,
  }
}
`),
  ).toEqual([]);
});

test('assigning `none` in an arm undoes the narrowing', () => {
  const [e] = errors(`${prelude}
fn f(start: Todo?) -> string {
  let mut t = start
  match t {
    none => return ""
    _ => { t = none }
  }
  return t.title
}
`);
  expect(e?.message).toContain('Todo?');
});

test('only the subject name may be bound again, once', () => {
  const [a] = errors(`${prelude}
fn f(t: Todo?, u: Todo?) -> string {
  return match t {
    none => "",
    u => u.title,
  }
}
`);
  expect(a.code).toBe('CAN0016');
  const [b] = errors(`${prelude}
fn f(t: (int, int)?) -> int {
  return match t {
    none => 0,
    (t, t) => t,
  }
}
`);
  expect(b.code).toBe('CAN0016');
  const [c] = errors(`${prelude}
fn f(t: Todo?) -> string {
  return match t {
    none => "",
    x => { let t = x
      t.title },
  }
}
`);
  expect(c.code).toBe('CAN0016');
});

test('`.Variant` needs an enum and one of its variants', () => {
  const [a] = errors(`${prelude}
fn f(p: Payment) -> int {
  return match p {
    .Nope => 0,
    _ => 1,
  }
}
`);
  expect(a.message).toBe('enum `Payment` has no variant `Nope`');
  expect(a.help).toBe('its variants are `Pending`, `Paid` and `Refunded`');
  const [b] = errors(`${prelude}
fn f(t: Todo) -> int {
  return match t {
    .Todo { id } => id,
  }
}
`);
  expect(b.message).toContain('names a variant of the enum being matched');
  expect(b.help).toContain('Todo { ... }');
});

test('`.Variant` covers like the full path, and works on a `T?` and inside other patterns', () => {
  const [a] = errors(`${prelude}
fn f(p: Payment) -> int {
  return match p {
    .Pending => 0,
    .Paid { at } => at,
  }
}
`);
  expect(a.message).toContain('Payment.Refunded');
  expect(
    errors(`${prelude}
fn f(p: Payment?, r: Result<Payment, string>) -> int {
  let a = match p {
    none => 0,
    .Pending => 1,
    .Paid { at } => at,
    .Refunded { at } => at,
  }
  let b = match r {
    Ok(.Paid { at }) => at,
    Ok(_) => 0,
    Err(_) => 0,
  }
  return a + b
}
`),
  ).toEqual([]);
});
