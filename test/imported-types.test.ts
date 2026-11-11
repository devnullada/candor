import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { plain } from './plain';

const geo = `module geo
pub struct Point {
  pub x: int
  pub y: int
}
pub enum Shape {
  Dot
  Circle { center: Point, radius: int }
}
pub fn origin() -> Point {
  return Point { x: 0, y: 0 }
}
`;

const program = (main: string, mode: 'main' | 'test' = 'main') =>
  compile(main, 'main.candor', mode, { read: (f) => ({ 'geo.candor': geo })[f] ?? null });
const diags = (main: string) => program(main).diagnostics.map((d) => [d.code, d.message, d.help]);
const mod = (decls: string, body = '  io.println("x")') =>
  `module m\nimport "geo"\n${decls}\nfn main()${body.includes('io.') ? ' uses io' : ''} {\n${body}\n}\n`;

describe('imported types', () => {
  test('written with their module, in every type position', () => {
    const r = program(
      mod(
        'fn flip(p: geo.Point) -> geo.Point {\n  return geo.Point { x: p.y, y: p.x }\n}\nfn all(ps: List<geo.Point>, s: geo.Shape?) -> Result<geo.Point, geo.Shape> {\n  return Ok(ps.first() ?? geo.origin())\n}',
        '  let p: geo.Point = flip(geo.origin())\n  let f: fn(geo.Point) -> geo.Point = flip\n  io.println(f(p).x.toString())\n  io.println(match all([p], none) {\n    Ok(q) => q.y.toString(),\n    Err(_) => "no",\n  })',
      ),
    );
    expect(r.diagnostics).toEqual([]);
    expect(plain(r.go)).toContain('func m__flip(ctx__ *candor.Ctx, p geo__Point) geo__Point {\n\treturn geo__Point{x: p.y, y: p.x}');
  });

  test('variants are constructed and matched with their module', () => {
    const r = program(
      mod(
        'fn area(s: geo.Shape) -> int {\n  return match s {\n    geo.Shape.Dot => 0,\n    geo.Shape.Circle { radius } => 3 * radius * radius,\n  }\n}',
        '  io.println(area(geo.Shape.Circle { center: geo.origin(), radius: 2 }).toString())\n  io.println(area(geo.Shape.Dot).toString())',
      ),
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('geo__Shape{tag__: 1, Circle__center: geo__origin(ctx__), Circle__radius: 2}');
  });

  test('a match on an imported enum must be exhaustive', () => {
    expect(diags(mod('fn area(s: geo.Shape) -> int {\n  return match s {\n    geo.Shape.Dot => 0,\n  }\n}')).map(([c]) => c)).toEqual(['CAN0027']);
  });

  test('messages name imported types as they are written', () => {
    expect(diags(mod('', '  let p: geo.Point = geo.Shape.Dot'))).toEqual([['CAN0005', 'expected geo.Point, found geo.Shape', undefined]]);
    expect(diags(mod('', '  let s = geo.Shape.Circle { radius: 1 }')).find(([c]) => c === 'CAN0026')).toEqual([
      'CAN0026',
      '`geo.Shape.Circle` is missing field `center`',
      expect.anything(),
    ]);
  });

  test('a bare imported type name says where it lives', () => {
    expect(diags(mod('fn f(p: Point) {\n}'))).toEqual([
      ['CAN0015', 'unknown type `Point`', '`Point` is declared in module `geo`; write `geo.Point`'],
    ]);
    expect(diags(mod('', '  let p = Point { x: 1, y: 2 }'))[0]).toEqual([
      'CAN0015',
      'unknown type `Point`',
      '`Point` is declared in module `geo`; write `geo.Point`',
    ]);
  });

  test('two modules may each have a type of the same name', () => {
    const files: Record<string, string> = { 'geo.candor': 'module geo\npub struct Path {\n  steps: List<int>\n}\n' };
    const main = 'module m\nimport "geo"\nstruct Path {\n  names: List<string>\n}\nfn same(a: geo.Path, b: Path) -> bool {\n  return a == a && b == b\n}\n';
    const r = compile(main, 'main.candor', 'test', { read: (f) => files[f] ?? null });
    expect(r.diagnostics).toEqual([]);
    // Each gets its own comparison.
    expect(r.go).toContain('return (eq__1(a, a) && eq__3(b, b))');
  });

  test('names that are not types of the module', () => {
    expect(diags(mod('fn f(p: geo.Pont) {\n}'))).toEqual([['CAN0015', 'module `geo` has no type `Pont`', 'did you mean `Point`?']]);
    expect(diags(mod('fn f(p: geo) {\n}'))).toEqual([['CAN0015', '`geo` is a module, not a type', 'name one of its types, as in `geo.Point`']]);
    expect(diags(mod('fn f(p: geo.Shape.Dot) {\n}'))).toEqual([['CAN0015', '`geo.Shape.Dot` is not a type', 'write `geo.Shape`']]);
    expect(diags(mod('', '  let p = geo.Point'))).toEqual([['CAN0025', '`geo.Point` is a type, not a value', 'construct one with `geo.Point { ... }`']]);
  });
});
