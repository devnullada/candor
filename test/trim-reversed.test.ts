import { expect, test } from 'bun:test';
import { compile } from '../src/compile';

// Card 159: `trimStart`/`trimEnd` remove whitespace at one end, `removePrefix`/`removeSuffix` given
// text, and `xs.reversed()` is a copy last item first. (The reference examples run them.)

const errors = (body: string) =>
  compile(`module m\n\nfn f(s: string, xs: List<int>) -> string {\n${body}\n}\n\nfn main() {}\n`, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.message} | ${d.help ?? ''}`);

test('the new methods check', () => {
  expect(errors('  let ys: List<int> = xs.reversed()\n  return s.trimStart().trimEnd().removePrefix("v").removeSuffix("/") + "${ys}"')).toEqual([]);
});

test('a trim given text points at removePrefix and removeSuffix', () => {
  expect(errors('  return s.trimEnd("/")')).toEqual([
    "`trimEnd` takes no arguments: it removes whitespace | to remove given text, `removeSuffix(text)`; it gives the string unchanged if the text isn't there. For any of a set of characters from both ends, `trimChars(\" \\t\")`",
  ]);
  expect(errors('  return s.trimStart("v")')[0]).toContain('`removePrefix(text)`');
  expect(errors('  return s.trim("x")')[0]).toContain('`removePrefix(text)`');
});

test('names from other languages get the Candor name', () => {
  expect(errors('  return s.stripSuffix("/")')[0]).toContain('use `removeSuffix(s)`');
  expect(errors('  return s.rstrip()')[0]).toContain('use `trimEnd()`');
  expect(errors('  return s.reverse()')[0]).toContain('`chars().reversed()`');
  expect(errors('  let ys = xs.reverse()\n  return ""')[0]).toContain('reversed');
});
