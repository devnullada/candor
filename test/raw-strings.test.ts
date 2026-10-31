import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compile';
import { Codes } from '../src/diagnostics';
import { lex } from '../src/lexer';

// `"""` strings: raw (a backslash is text), `${...}` interpolates, and a multi-line one loses the
// closing `"""`'s indent from every line.

const str = (src: string) => lex(src, 't')[0];
const errors = (src: string) => {
  const found: { message: string; help?: string; span: { start: { line: number } } }[] = [];
  lex(src, 't', found as never);
  return found.map((d) => [d.span.start.line, d.message, d.help]);
};

describe('raw strings', () => {
  test('on one line: quotes and backslashes are text', () => {
    expect(str('"""say "hi" \\n"""')).toMatchObject({ kind: 'string', text: 'say "hi" \\n' });
    expect(str('""""""')).toMatchObject({ kind: 'string', text: '' });
    // The last three quotes of a run close it.
    expect(str('"""a "b""""')).toMatchObject({ kind: 'string', text: 'a "b"' });
  });

  test('`${...}` interpolates', () => {
    const t = str('"""a "${n}" b"""');
    expect(t.kind).toBe('template');
    expect(t.parts!.map((p) => (typeof p === 'string' ? p : p.map((x) => x.kind)))).toEqual(['a "', ['ident', 'eof'], '" b']);
  });

  test('over several lines: the closing indent goes, and the newline before it', () => {
    const src = 'let q = """\n    SELECT "end"\n      FROM t\n\n    WHERE x = 1\n    """\nlet y = 1';
    expect(lex(src, 't')[3]).toMatchObject({ kind: 'string', text: 'SELECT "end"\n  FROM t\n\nWHERE x = 1' });
    // Lines after it are counted right.
    expect(lex(src, 't').find((t) => t.text === 'y')!.span.start.line).toBe(7);
    const t = str('"""\n  ${a} and ${b}\n  """');
    expect(t.parts!.map((p) => (typeof p === 'string' ? p : 'X'))).toEqual(['', 'X', ' and ', 'X', '']);
  });

  test('mistakes say how the closing `"""` decides', () => {
    expect(errors('"""\n    ok\n  bad\n    """')).toEqual([
      [
        3,
        'a line of this multi-line string starts left of its closing `"""`',
        'indent every line at least as far as the closing `"""` (4 spaces), or move the closing `"""` left; its indent is what is removed from each line',
      ],
    ]);
    expect(errors('"""\n  text"""')).toEqual([
      [2, 'the closing `"""` of a multi-line string goes on a line of its own', 'end the last line of text, then write `"""` on the next line, indented as far as the text'],
    ]);
    expect(errors('"""one line\nx')).toEqual([
      [
        1,
        'unterminated `"""` string',
        'a `"""` string that starts with text on its line ends on that line; for several lines, start the text on the line after the opening `"""`',
      ],
    ]);
    expect(errors('"""\n  text\n')).toEqual([[1, 'unterminated `"""` string', 'end it with `"""` on a line of its own, indented as far as its text']]);
  });

  test('a query: written without escapes, its `${...}` still parameters', () => {
    const src = `module m
import "sql"
fn f(id: int, name: string) -> Result<int, sql.Error> uses sql {
  return sql.exec("""
    UPDATE t SET "end" = 1
    WHERE id = \${id} AND body = '\${name}'
    """)
}
fn main() {}
`;
    expect(compile(src, 't.candor').diagnostics.map((d) => [d.code, d.message])).toEqual([
      [Codes.TypeMismatch, '`${ }` in a query is a parameter, and inside quotes it would be the text `?`'],
    ]);
  });
});
