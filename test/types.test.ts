import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { plain } from './plain';

const decls = `struct Point {
  x: int
  y: int
}

struct Vec {
  x: int
  y: int
}

enum Status {
  Pending
  Paid { at: int }
  Refunded { amount: int, reason: string }
}
`;

/** A module with the declarations above, `extra` declarations, and `body` as `main`. */
const mod = (body: string, extra = '') => `module m\n${decls}${extra}\nfn main() uses io {\n${body}\n}\n`;
const diags = (src: string) => compile(src, 't').diagnostics.map((d) => [d.code, d.message]);
const codes = (src: string) => compile(src, 't').diagnostics.map((d) => d.code);

describe('structs', () => {
  test('a field whose type ends in `>` ends its line', () => {
    expect(codes('module m\nstruct S {\n  xs: List<int>\n  y: int\n}\nfn main() {}\n')).toEqual([]);
  });

  test('literal, field access, Go output', () => {
    const r = compile(mod('  let p = Point { x: 1, y: 2 }\n  io.println(p.x.toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('type m__Point struct {\n\tx int64\n\ty int64\n}');
    expect(r.go).toContain('var p m__Point = m__Point{x: 1, y: 2}');
    expect(r.go).toContain('strconv.FormatInt(p.x, 10)');
  });

  test('field shorthand', () => {
    expect(codes(mod('  let x = 1\n  let y = 2\n  let p = Point { x, y }\n  io.println(p.y.toString())'))).toEqual([]);
  });

  test('nominal: same fields, different types', () => {
    expect(diags(mod('  let v: Vec = Point { x: 1, y: 2 }\n  io.println(v.x.toString())'))).toEqual([
      ['CAN0005', 'expected Vec, found Point'],
    ]);
  });

  test('every field is required', () => {
    expect(diags(mod('  let p = Point { x: 1 }\n  io.println(p.x.toString())'))).toEqual([
      ['CAN0026', '`Point` is missing field `y`'],
    ]);
  });

  test('an unknown field suggests the right one', () => {
    const r = compile(mod('  let p = Point { x: 1, yy: 2 }\n  io.println(p.x.toString())'), 't');
    const d = r.diagnostics.find((d) => d.message.includes('no field'));
    expect(d?.help).toBe('did you mean `y`?');
  });

  test('spread copies, then overwrites, in order', () => {
    const r = compile(mod('  let p = Point { x: 1, y: 2 }\n  let q = Point { ...p, y: 3 }\n  io.println(q.y.toString())'), 't');
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('var t__1 m__Point = p\n\tt__1.y = 3\n\tvar q m__Point = t__1');
  });

  test('a struct that contains itself is an error', () => {
    expect(codes(mod('  io.println("x")', 'struct Node {\n  next: Node\n}\n'))).toEqual(['CAN0029']);
  });

  test('type names must be uppercase', () => {
    expect(codes(mod('  io.println("x")', 'struct point {\n  x: int\n}\n'))).toEqual(['CAN0030']);
  });

  test('a type is not a value', () => {
    expect(codes(mod('  let p = Point\n  io.println("x")'))).toEqual(['CAN0025']);
  });
});

describe('enums', () => {
  test('variants: without fields as values, with fields as literals', () => {
    const r = compile(mod('  let a = Status.Pending\n  let b = Status.Paid { at: 5 }\n  io.println("x")'), 't');
    expect(r.go).toContain('var a m__Status = m__Status{tag__: 0}');
    expect(r.go).toContain('var b m__Status = m__Status{tag__: 1, Paid__at: 5}');
  });

  test('a variant with fields needs them', () => {
    const r = compile(mod('  let a = Status.Paid\n  io.println("x")'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([['CAN0025', 'write `Status.Paid { at: ... }`']]);
  });

  test('unknown variant', () => {
    const r = compile(mod('  let a = Status.Payd { at: 1 }\n  io.println("x")'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([['CAN0008', 'did you mean `Paid`?']]);
  });

  test('a recursive field is a pointer in Go', () => {
    const extra = 'enum Chain {\n  Nil\n  Cons { head: int, tail: Chain }\n}\n';
    const r = compile(mod('  let l = Chain.Cons { head: 1, tail: Chain.Nil }\n  io.println("x")', extra), 't');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['CAN0013']);
    expect(r.go).toContain('\tCons__tail *m__Chain');
    expect(r.go).toContain('Cons__tail: ptr__(m__Chain{tag__: 0})');
  });

  test('enum fields need match', () => {
    expect(codes(mod('  let s = Status.Paid { at: 1 }\n  io.println(s.at.toString())'))).toEqual(['CAN0008']);
  });
});

describe('match', () => {
  const on = (arms: string) => mod(`  let s = Status.Pending\n  let label = match s {\n${arms}\n  }\n  io.println(label)`);

  test('exhaustive over an enum', () => {
    expect(codes(on('    Status.Pending => "p"\n    Status.Paid { at } => at.toString()\n    Status.Refunded => "r"'))).toEqual(
      [],
    );
  });

  test('lists every missing variant', () => {
    expect(diags(on('    Status.Pending => "p"'))).toEqual([
      ['CAN0027', 'this `match` does not cover `Status.Paid` and `Status.Refunded`'],
    ]);
  });

  test('a catch-all covers the rest', () => {
    expect(codes(on('    Status.Pending => "p"\n    _ => "other"'))).toEqual([]);
  });

  test('nested patterns: the missing case is named precisely', () => {
    const src = on('    Status.Paid { at: 0 } => "free"\n    Status.Pending => "p"\n    Status.Refunded => "r"');
    expect(diags(src)).toEqual([['CAN0027', 'this `match` does not cover `Status.Paid`']]);
  });

  test('bool is covered by true and false', () => {
    expect(codes(mod('  let b = true\n  let s = match b {\n    true => "y"\n    false => "n"\n  }\n  io.println(s)'))).toEqual([]);
  });

  test('int needs a catch-all', () => {
    expect(diags(mod('  let n = 1\n  let s = match n {\n    0 => "zero"\n    -1 => "minus one"\n  }\n  io.println(s)'))).toEqual([
      ['CAN0027', 'this `match` does not cover every int'],
    ]);
  });

  test('unreachable arms are warned about', () => {
    expect(diags(on('    _ => "any"\n    Status.Pending => "p"'))).toEqual([
      ['CAN0028', 'this arm can never match: the arms above cover it'],
    ]);
  });

  test('arms must agree on a type', () => {
    expect(codes(on('    Status.Pending => "p"\n    _ => 1'))).toEqual(['CAN0023']);
  });

  test('a pattern of the wrong type', () => {
    expect(codes(on('    Point { x } => "p"\n    _ => "o"'))).toEqual(['CAN0005']);
  });

  test('bindings are scoped to their arm', () => {
    const src = mod('  let s = Status.Paid { at: 1 }\n  match s {\n    Status.Paid { at } => io.println(at.toString())\n    _ => io.println(at.toString())\n  }');
    expect(codes(src)).toEqual(['CAN0002']);
  });

  test('.. gets a targeted error', () => {
    const r = compile(on('    Status.Paid { .. } => "p"\n    _ => "o"'), 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([['CAN0001', 'leave out the fields you do not need, or write `_` for them: `.Bad { why, _ }`']]);
  });

  test('lowers to an if chain; the last arm needs no test', () => {
    const r = compile(on('    Status.Paid { at } => at.toString()\n    _ => "other"'), 't');
    expect(plain(r.go)).toContain('if (s.tag__ == 1) {\n\t\tvar at int64 = s.Paid__at');
    expect(plain(r.go)).toContain('} else {\n\t\tt__1 = "other"\n\t}');
  });

  test('a struct literal in an if condition needs parentheses', () => {
    expect(codes(mod('  if Point { x: 1, y: 2 }.x == 1 {\n    io.println("x")\n  }'))).toEqual(['CAN0001']);
    expect(codes(mod('  if (Point { x: 1, y: 2 }).x == 1 {\n    io.println("x")\n  }'))).toEqual([]);
  });
});
