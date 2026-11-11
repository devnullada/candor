import { expect, test } from 'bun:test';
import { compileSplit } from './split';

// A `"""` string written as in Python, text after the opening `"""`, is one error, and
// its lines aren't read as code.

const errors = (body: string) =>
  compileSplit(`module m\n\nfn main() {}\n\ntest "t" {\n${body}\n}\n`, 't.candor', 'test')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.span.start.line}: ${d.message}`);

const message = 'this `"""` string runs over several lines, but text follows its opening `"""`, so it had to end on that line';

test('closed after the last text: one error, and the code after it is checked', () => {
  expect(errors('  let s = """status: 5xx 1\nerrors: 100.0%\ntop paths:"""\n  let n: int = "x"')).toEqual([
    `6: ${message}`,
    '9: expected int, found string',
  ]);
});

test('closed on a line of its own: one error', () => {
  expect(errors('  let s = """a: 1\n  b: 2\n  """\n  assert s != ""')).toEqual([`6: ${message}`]);
});

test('the next `"""` opening a string is not taken as the close', () => {
  const found = errors('  let s = """a: 1\n  let t = """\n    b\n    """\n  assert t == "b"');
  expect(found[0]).toBe('6: unterminated `"""` string');
  expect(found).not.toContain(`6: ${message}`);
});
