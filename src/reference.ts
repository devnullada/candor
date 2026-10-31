import { builtinEffects } from './effects';
import { bytesMisnamed, mapMisnamed, primitiveMethods, stringMisnamed } from './methods';
import { T, typeToString, type FnType, type Type } from './types';

/**
 * The reference for built-in methods and effects: `docs/reference.md` (`bun run reference`) and
 * `candor doc` are made from it, and the checker takes its method names for List, Map, tasks
 * and the handles from it. Every example is the body of a test block in test/reference.test.ts.
 */

export interface RefEntry {
  name: string;
  /** As Candor writes it, without the name. For methods with a real FnType it is printed from that. */
  sig?: string;
  doc: string;
  /** Statements, run as a test block; the last is usually an `assert`. Null only where none can run. */
  example: string | null;
  /** Only on the fake a test block gets. */
  fake?: boolean;
}

export interface RefSection {
  /** What `candor doc` takes, lowercase. */
  key: string;
  title: string;
  intro: string;
  entries: RefEntry[];
  /** Names other languages use, and what Candor does instead. */
  misnamed?: Map<string, string>;
  /** Where the real signatures live, when this section has them. */
  types?: Map<string, FnType>;
}

const prim = (t: Type) => new Map([...primitiveMethods(t)].map(([name, m]) => [name, m.type]));
const effectOps = (name: string) => {
  const def = builtinEffects.get(name)!;
  return new Map([...def.type.methods, ...def.fake.methods]);
};

export const reference: RefSection[] = [
  {
    key: 'int',
    title: 'int',
    intro:
      'A 64-bit integer. Arithmetic that overflows panics, naming the line, as `/` by zero does; the `wrapping` methods wrap instead, and the `checked` methods give `none`. A constant expression that overflows or divides by zero is a compile error. `60_000` groups digits.',
    types: prim(T.int),
    entries: [
      { name: 'toString', doc: 'The decimal digits.', example: 'let n = -42\nassert n.toString() == "-42"' },
      { name: 'toChar', doc: 'The char with this code point, or `none` if it is not one.', example: "assert 233.toChar() == 'é'\nassert (-1).toChar() == none" },
      { name: 'toFloat', doc: 'The same number as a float (the nearest one, past 2^53).', example: 'let done = 1\nlet total = 4\nassert done.toFloat() / total.toFloat() == 0.25' },
      {
        name: 'wrappingAdd',
        doc: 'The sum, wrapped around 64 bits instead of panicking: for hashes and checksums.',
        example: 'let max = 9_223_372_036_854_775_807\nassert max.wrappingAdd(1) == -9_223_372_036_854_775_807 - 1',
      },
      { name: 'wrappingSub', doc: 'The difference, wrapped around 64 bits.', example: 'let min = -9_223_372_036_854_775_807 - 1\nassert min.wrappingSub(1) == 9_223_372_036_854_775_807' },
      {
        name: 'wrappingMul',
        doc: 'The product, wrapped around 64 bits: `h.wrappingMul(31).wrappingAdd(c)`.',
        example: 'let big = 4_611_686_018_427_387_904\nassert big.wrappingMul(2) == -9_223_372_036_854_775_807 - 1\nlet three = 3\nassert three.wrappingMul(4) == 12',
      },
      {
        name: 'checkedAdd',
        doc: 'The sum, or `none` if it overflows: for input that may be out of range.',
        example: 'let max = 9_223_372_036_854_775_807\nassert max.checkedAdd(1) == none\nassert max.checkedAdd(-1) == 9_223_372_036_854_775_806',
      },
      { name: 'checkedSub', doc: 'The difference, or `none` if it overflows.', example: 'let min = -9_223_372_036_854_775_808\nassert min.checkedSub(1) == none\nassert min.checkedSub(-1) == -9_223_372_036_854_775_807' },
      { name: 'checkedMul', doc: 'The product, or `none` if it overflows.', example: 'let six = 6\nassert six.checkedMul(7) == 42\nlet big = 4_611_686_018_427_387_904\nassert big.checkedMul(2) == none' },
      {
        name: 'checkedDiv',
        doc: 'The quotient, or `none` for a zero divisor (or `min / -1`): `total.checkedDiv(count) ?? 0`.',
        example: 'let seven = 7\nassert seven.checkedDiv(0) == none\nassert seven.checkedDiv(2) == 3\nlet count = 0\nlet average = 21.checkedDiv(count) ?? 0\nassert average == 0',
      },
      { name: 'min', doc: 'The smaller of the two. For a list, `xs.min()`.', example: 'let limit = 100\nlet asked = 250\nassert asked.min(limit) == 100' },
      { name: 'max', doc: 'The larger of the two: `page.max(1)` keeps it at least 1.', example: 'let page = -3\nassert page.max(1) == 1\nassert 7.max(2) == 7' },
      { name: 'abs', doc: 'Without its sign. Panics on the one int with no positive twin, -9_223_372_036_854_775_808.', example: 'assert (-5).abs() == 5\nassert 5.abs() == 5' },
      {
        name: 'pow',
        doc: 'Raised to the power `k`. Panics if it overflows, or if `k` is negative (for a fraction, use floats).',
        example: 'assert 2.pow(10) == 1024\nassert 10.pow(0) == 1\nassert (-3).pow(3) == -27',
      },
      { name: 'and', doc: 'The bits set in both, Go\'s `&`: `flags.and(mask) != 0`.', example: 'assert 12.and(10) == 8\nlet flags = 5\nassert flags.and(4) != 0' },
      { name: 'or', doc: 'The bits set in either, Go\'s `|`.', example: 'assert 12.or(3) == 15' },
      { name: 'xor', doc: 'The bits set in one but not both, Go\'s `^`: for checksums and HMAC pads.', example: 'assert 12.xor(10) == 6\nassert 0x36.xor(0x5c) == 106' },
      { name: 'not', doc: 'Every bit flipped, Go\'s unary `^`: `-n - 1`.', example: 'assert 0.not() == -1\nassert 12.and(5.not()) == 8' },
      {
        name: 'shl',
        doc: 'Shifted left `k` bits, 0 to 63 (another count panics). Bits shifted out are gone: no overflow.',
        example: 'assert 1.shl(10) == 1024\nassert 1.shl(63) == -9_223_372_036_854_775_807 - 1',
      },
      { name: 'shr', doc: 'Shifted right `k` bits, 0 to 63, the sign copied in: `(-8).shr(1)` is -4.', example: 'assert 1024.shr(3) == 128\nassert (-8).shr(1) == -4' },
      {
        name: 'ushr',
        doc: 'Shifted right `k` bits, 0 to 63, zeros shifted in (JavaScript\'s `>>>`): the bits as unsigned.',
        example: 'assert 1024.ushr(3) == 128\nassert (-1).ushr(60) == 15\nlet byte = 0x1234.shr(8).and(0xff)\nassert byte == 0x12',
      },
    ],
  },
  {
    key: 'float',
    title: 'float',
    intro:
      'A 64-bit floating-point number, `1.5`, `2.0e-3`, `1e21`. Never NaN or infinite: an operation that would make one panics with the line, as int overflow does, and so does `/` by zero. So `==` and `<` order every float, lists of them sort, and they can be map keys. An int and a float never mix: `n.toFloat()` one way, `f.round()` (or `floor`, `ceil`, `truncate`) the other. `%` gives the remainder with the sign of the dividend, as on ints. Interpolates as `toString` gives; JSON is a number.',
    types: prim(T.float),
    entries: [
      {
        name: 'toString',
        doc: 'The shortest text that reads back as the same float, with `.0` on a whole number and an exponent only below 1e-6 or from 1e21.',
        example: 'assert (1.5).toString() == "1.5"\nassert (2.0).toString() == "2.0"\nassert (0.1 + 0.2).toString() == "0.30000000000000004"\nassert 1e21.toString() == "1e+21"',
      },
      {
        name: 'toFixed',
        doc: 'With that many digits after the point, rounded: for display.',
        example: 'let done = 2\nlet total = 3\nlet percent = done.toFloat() / total.toFloat() * 100.0\nassert "${percent.toFixed(1)}%" == "66.7%"',
      },
      { name: 'round', doc: 'The nearest int, halves away from zero. Panics if it doesn\'t fit in an int.', example: 'assert (2.5).round() == 3\nassert (-2.5).round() == -3\nassert (2.4).round() == 2' },
      { name: 'floor', doc: 'The nearest int at or below.', example: 'assert (2.7).floor() == 2\nassert (-2.1).floor() == -3' },
      { name: 'ceil', doc: 'The nearest int at or above.', example: 'assert (2.1).ceil() == 3\nassert (-2.7).ceil() == -2' },
      { name: 'truncate', doc: 'The int part, dropping the fraction.', example: 'assert (2.7).truncate() == 2\nassert (-2.7).truncate() == -2' },
      { name: 'abs', doc: 'Without its sign.', example: 'assert (-1.5).abs() == 1.5\nassert (0.1 + 0.2 - 0.3).abs() < 1e-9' },
      { name: 'sqrt', doc: 'The square root. Panics on a negative number.', example: 'assert (2.25).sqrt() == 1.5' },
      {
        name: 'pow',
        doc: 'Raised to the power `y`. Panics if the result is not a number or too large: `(-8.0).pow(0.5)`, `0.0.pow(-1.0)`.',
        example: 'assert (2.0).pow(10.0) == 1024.0\nassert (9.0).pow(0.5) == 3.0\nassert (2.0).pow(-1.0) == 0.5',
      },
      { name: 'min', doc: 'The smaller of the two. For a list, `xs.min()`.', example: 'let ratio = 1.4\nassert ratio.min(1.0) == 1.0' },
      { name: 'max', doc: 'The larger of the two.', example: 'let x = -0.5\nassert x.max(0.0) == 0.0\nassert x.max(0.0).min(1.0) == 0.0' },
    ],
  },
  {
    key: 'char',
    title: 'char',
    intro:
      "One code point, `'a'`, `'é'`, `'\\n'`: what `s.chars()` gives and `match` takes. Compared with `==` and `<` by code point; interpolates as itself; JSON is a one-character string. A char is not a string: `c.toString()`, or `\"${c}\"`.",
    types: prim(T.char),
    entries: [
      { name: 'toString', doc: 'A string of the one code point.', example: "let c = 'é'\nassert c.toString() == \"é\"\nassert \"[${c}]\" == \"[é]\"" },
      { name: 'code', doc: 'The code point as an int.', example: "let c = 'A'\nassert c.code() == 65\nassert 65.toChar() == 'A'" },
      { name: 'isDigit', doc: 'Whether it is `0` to `9` (ASCII only, as `toInt` reads).', example: "assert \"a1b2\".chars().filter((c) => c.isDigit()) == ['1', '2']" },
      { name: 'isLetter', doc: 'Whether it is a letter, in any script.', example: "let c = 'ß'\nassert c.isLetter()\nlet d = '1'\nassert !d.isLetter()" },
      { name: 'isWhitespace', doc: 'Whether it is a space, tab, line break or other Unicode space.', example: "let c = '\\t'\nassert c.isWhitespace()" },
      { name: 'toUpperCase', doc: 'The upper-case char, or the same one.', example: "let c = 'é'\nassert c.toUpperCase() == 'É'" },
      { name: 'toLowerCase', doc: 'The lower-case char, or the same one.', example: "let c = 'Q'\nassert c.toLowerCase() == 'q'" },
    ],
  },
  {
    key: 'bool',
    title: 'bool',
    intro: '`true` or `false`, with `&&`, `||` and `!`.',
    types: prim(T.bool),
    entries: [{ name: 'toString', doc: '`"true"` or `"false"`.', example: 'let b = true\nassert b.toString() == "true"' }],
  },
  {
    key: 'string',
    title: 'string',
    intro:
      'UTF-8 text. Lengths and indexes count code points (Go counts bytes, TypeScript UTF-16 units). `"#${id}"` interpolates; `+` joins. No `s[i]`: index `s.chars()`. Strings never change: methods give new ones.',
    types: prim(T.string),
    misnamed: stringMisnamed,
    entries: [
      { name: 'length', doc: 'How many code points.', example: 'assert "héllo".length() == 5' },
      { name: 'byteLength', doc: 'How many UTF-8 bytes.', example: 'assert "héllo".byteLength() == 6' },
      { name: 'isEmpty', doc: 'Whether it is `""`.', example: 'assert "".isEmpty()\nassert !" ".isEmpty()' },
      {
        name: 'chars',
        doc: 'Each code point, as a `char`: the list to index or loop over. `join("")` puts them back together.',
        example: "assert \"añb\".chars() == ['a', 'ñ', 'b']\nassert \"añb\".chars()[1] == 'ñ'\nassert \"abc\".chars().filter((c) => c != 'b').join(\"\") == \"ac\"",
      },
      { name: 'contains', doc: 'Whether the text appears in it.', example: 'assert "banana".contains("nan")' },
      { name: 'startsWith', doc: 'Whether it begins with the text.', example: 'assert "/todos/3".startsWith("/todos")' },
      { name: 'endsWith', doc: 'Whether it ends with the text.', example: 'assert "notes.txt".endsWith(".txt")' },
      {
        name: 'indexOf',
        doc: 'Where the text first appears, in code points; `none` if it doesn\'t.',
        example: 'assert "banana".indexOf("na") == 2\nassert "banana".indexOf("x") == none',
      },
      {
        name: 'lastIndexOf',
        doc: 'Where the text last appears, in code points; `none` if it doesn\'t.',
        example: 'let name = "song.final.wav"\nassert name.slice((name.lastIndexOf(".") ?? name.length()) + 1) == "wav"',
      },
      {
        name: 'slice',
        doc: 'The code points from `start` up to, not including, `end`; both are clamped to the string, a negative one to 0. `slice(start)` runs to the end.',
        example: 'assert "héllo".slice(1, 3) == "él"\nassert "abc".slice(1, 99) == "bc"\nassert "abc".slice(-5, 2) == "ab"\nassert "#tag".slice(1) == "tag"',
      },
      { name: 'split', doc: 'The parts between each separator.', example: 'assert "a,b,,c".split(",") == ["a", "b", "", "c"]' },
      { name: 'trim', doc: 'Without whitespace at either end.', example: 'assert "  hi \\n".trim() == "hi"' },
      { name: 'trimStart', doc: 'Without whitespace at the start.', example: 'assert "  hi ".trimStart() == "hi "' },
      { name: 'trimEnd', doc: 'Without whitespace at the end.', example: 'assert "hi\\r\\n".trimEnd() == "hi"' },
      {
        name: 'trimChars',
        doc: 'Without any of the characters in the set at either end, however many there are; the set is characters, not text to match.',
        example: 'assert "--a-b--".trimChars("-") == "a-b"\nassert "\\t x \\n".trimChars(" \\t\\n") == "x"',
      },
      {
        name: 'removePrefix',
        doc: 'Without the text at the start, once; unchanged if it doesn\'t start with it.',
        example: 'assert "v1.2".removePrefix("v") == "1.2"\nassert "1.2".removePrefix("v") == "1.2"',
      },
      {
        name: 'removeSuffix',
        doc: 'Without the text at the end, once; unchanged if it doesn\'t end with it.',
        example: 'assert "/api/".removeSuffix("/") == "/api"\nassert "a//".removeSuffix("/") == "a/"',
      },
      { name: 'toUpperCase', doc: 'In upper case.', example: 'assert "Hello".toUpperCase() == "HELLO"' },
      { name: 'toLowerCase', doc: 'In lower case.', example: 'assert "HeLLo".toLowerCase() == "hello"' },
      { name: 'replaceAll', doc: 'Every occurrence of the first text replaced by the second.', example: 'assert "a-b-c".replaceAll("-", "+") == "a+b+c"' },
      { name: 'repeat', doc: 'The string `n` times over.', example: 'assert "ab".repeat(3) == "ababab"' },
      {
        name: 'toInt',
        doc: 'The int it spells, or `none` unless the whole string is a decimal int (a leading `-` allowed).',
        example: 'assert "42".toInt() == 42\nassert "-7".toInt() == -7\nassert "4x".toInt() == none',
      },
      {
        name: 'toFloat',
        doc: 'The float it spells, or `none` unless the whole string is a decimal number (`1.5`, `-2`, `3e8`).',
        example: 'assert "1.5".toFloat() == 1.5\nassert "-2".toFloat() == -2.0\nassert "NaN".toFloat() == none',
      },
      {
        name: 'lines',
        doc: 'The lines, split at `\\n` or `\\r\\n`. A final line break ends the last line; it does not start an empty one.',
        example: 'assert "a\\nb\\r\\n".lines() == ["a", "b"]\nassert "a\\n\\nb".lines() == ["a", "", "b"]\nassert "".lines() == []',
      },
      {
        name: 'padStart',
        doc: 'The string with `fill` repeated before it up to `n` code points; the last copy is cut to fit. Longer strings are left as they are.',
        example: 'assert "7".padStart(3, "0") == "007"\nassert "abc".padStart(2, "0") == "abc"\nassert "1".padStart(4, "ab") == "aba1"',
      },
      { name: 'padEnd', doc: 'As `padStart`, with the fill after: for columns.', example: 'assert "id".padEnd(5, ".") == "id..."' },
      { name: 'toBytes', doc: 'Its UTF-8 bytes.', example: 'assert "é".toBytes().toList() == [195, 169]' },
      {
        name: 'quoted',
        doc: 'In double quotes, with `\\`, `"` and control characters escaped as Go\'s `%q` does: for logs that show a value exactly.',
        example: 'assert "a\\tb".quoted() == "\\"a\\\\tb\\""\nassert "say \\"hi\\"".quoted().length() == 12\nassert "é".quoted() == "\\"é\\""',
      },
    ],
  },
  {
    key: 'bytes',
    title: 'Bytes',
    intro:
      'Bytes, never changed once made, like a string; a byte is an `int` 0 to 255. `s.toBytes()` gives a string\'s; `import "bytes"` makes them from a list (`bytes.fromList`), hex or base64. `==` compares them, and they can be map keys. In JSON they are a base64 string.',
    types: prim(T.bytes),
    misnamed: bytesMisnamed,
    entries: [
      { name: 'length', doc: 'How many bytes.', example: 'assert "héllo".toBytes().length() == 6' },
      { name: 'isEmpty', doc: 'Whether there are none.', example: 'assert "".toBytes().isEmpty()' },
      { name: 'at', doc: 'The byte at `i`, or `none` out of range.', example: 'let b = "hi".toBytes()\nassert b.at(0) == 104\nassert b.at(2) == none' },
      {
        name: 'slice',
        doc: 'The bytes from `start` up to, not including, `end`; both are clamped, a negative one to 0. `slice(start)` runs to the end.',
        example: 'let b = "hello".toBytes()\nassert b.slice(1, 3) == "el".toBytes()\nassert b.slice(3, 99) == "lo".toBytes()\nassert b.slice(2) == "llo".toBytes()',
      },
      { name: 'concat', doc: 'These bytes, then those: new bytes.', example: 'assert "ab".toBytes().concat("c".toBytes()) == "abc".toBytes()' },
      {
        name: 'indexOf',
        doc: 'Where the bytes first appear; `none` if they don\'t.',
        example: 'let b = "banana".toBytes()\nassert b.indexOf("na".toBytes()) == 2\nassert b.indexOf("x".toBytes()) == none',
      },
      {
        name: 'lastIndexOf',
        doc: 'Where the bytes last appear; `none` if they don\'t.',
        example: 'let b = "banana".toBytes()\nassert b.lastIndexOf("na".toBytes()) == 4',
      },
      { name: 'toList', doc: 'Each byte, as an int: the list to loop over.', example: 'assert "AB".toBytes().toList() == [65, 66]' },
      {
        name: 'toText',
        doc: 'The bytes as a string, or `none` unless they are UTF-8.',
        example: 'let b = "é".toBytes()\nassert b.toText() == "é"\nassert b.slice(0, 1).toText() == none',
      },
      {
        name: 'toRawText',
        doc: 'The bytes in a string as they are, UTF-8 or not, as `fs.read` gives a file: `text.toBytes()` gets them back exactly. For a body or a file built byte by byte; `toText()` when it should be text.',
        example: 'let b = "é".toBytes().slice(0, 1)\nassert b.toText() == none\nassert b.toRawText().toBytes() == b',
      },
      { name: 'toHex', doc: 'Lowercase hex, two digits a byte.', example: 'assert "Hi".toBytes().toHex() == "4869"' },
      { name: 'toBase64', doc: 'Standard base64, padded: what JSON holds.', example: 'assert "Hi".toBytes().toBase64() == "SGk="' },
    ],
  },
  {
    key: 'list',
    title: 'List<T>',
    intro:
      'An ordered list, `[1, 2, 3]`. A value: assigning or passing one copies it (cheaply, on write). `xs[i]` is a `T?`; `xs[i] = v` and the changing methods need `let mut`. `for x in xs { ... }` loops; `for (i, x) in xs.enumerated()` has the index. `Show` when its items are: `"${xs}"` and `xs.toString()` give `[1, 2]`, `["a", "b"]`.',
    misnamed: new Map([
      ['forEach', 'loop instead: `for x in xs { ... }`'],
      ['reverse', 'use `reversed()`: a copy, last item first'],
      ['distinct', 'use `unique()`: each item once, in order'],
      ['dedupe', 'use `unique()`: each item once, in order'],
      ['intersection', 'use `intersect(ys)`'],
      ['difference', 'keep the items the other lacks: `xs.filter((x) => !ys.contains(x))`'],
    ]),
    entries: [
      { name: 'length', sig: 'length() -> int', doc: 'How many items.', example: 'assert [1, 2, 3].length() == 3' },
      { name: 'isEmpty', sig: 'isEmpty() -> bool', doc: 'Whether it has none.', example: 'let xs: List<int> = []\nassert xs.isEmpty()' },
      { name: 'first', sig: 'first() -> T?', doc: 'The first item, or `none` if empty.', example: 'assert [4, 5].first() == 4\nlet xs: List<int> = []\nassert xs.first() == none' },
      { name: 'last', sig: 'last() -> T?', doc: 'The last item, or `none` if empty.', example: 'assert [4, 5].last() == 5' },
      { name: 'reversed', sig: 'reversed() -> List<T>', doc: 'A copy, last item first.', example: 'assert [1, 2, 3].reversed() == [3, 2, 1]' },
      { name: 'enumerated', sig: 'enumerated() -> List<(int, T)>', doc: 'Each item with its index, from 0.', example: 'assert ["a", "b"].enumerated() == [(0, "a"), (1, "b")]' },
      { name: 'contains', sig: 'contains(T) -> bool', doc: 'Whether an item `==` the value. `T` must be comparable.', example: 'assert [1, 2, 3].contains(2)' },
      { name: 'unique', sig: 'unique() -> List<T>', doc: 'Each item once, where it first appears. `T` must be comparable.', example: 'assert [3, 1, 3, 2, 1].unique() == [3, 1, 2]' },
      {
        name: 'union',
        sig: 'union(List<T>) -> List<T>',
        doc: 'The items in either list, each once: this list\'s in order, then the other\'s new ones. `T` must be comparable.',
        example: 'assert [1, 2, 2].union([3, 2, 4]) == [1, 2, 3, 4]',
      },
      {
        name: 'intersect',
        sig: 'intersect(List<T>) -> List<T>',
        doc: 'The items of this list that the other has too, each once, in this list\'s order. `T` must be comparable.',
        example: 'assert [5, 1, 3, 1].intersect([1, 5, 9]) == [5, 1]\nassert [1, 2].intersect([]) == []',
      },
      {
        name: 'sorted',
        sig: 'sorted() -> List<T>',
        doc: 'A sorted copy, smallest first, by `<`. `T` must be ordered (`T: Ord`): int, string, a type with `impl Ord`, or a tuple of those, compared item by item.',
        example: 'assert [3, 1, 2].sorted() == [1, 2, 3]\nassert [(2, "a"), (1, "b"), (1, "a")].sorted() == [(1, "a"), (1, "b"), (2, "a")]',
      },
      {
        name: 'sortedBy',
        sig: 'sortedBy(fn(T) -> K) -> List<T>',
        doc: 'A copy sorted by the key the function gives each item, smallest first; items with equal keys keep their order. `K` must be ordered: a tuple sorts by several keys.',
        example: 'let words = ["bb", "a", "ccc", "dd"]\nassert words.sortedBy((w) => w.length()) == ["a", "bb", "dd", "ccc"]\nassert words.sortedBy((w) => (-w.length(), w)) == ["ccc", "bb", "dd", "a"]',
      },
      {
        name: 'min',
        sig: 'min() -> T?',
        doc: 'The smallest item by `<`, or `none` if empty; of equal ones, the first. `T` must be ordered, as for `sorted`. By a key: `xs.sortedBy((x) => x.at).first()`.',
        example: 'assert [3, 1, 2].min() == 1\nlet scores: List<float> = []\nassert (scores.min() ?? 0.0) == 0.0',
      },
      { name: 'max', sig: 'max() -> T?', doc: 'The largest item by `<`, or `none` if empty.', example: 'assert ["pear", "apple"].max() == "pear"\nassert [2.5, 9.0].max() == 9.0' },
      { name: 'join', sig: 'join(string) -> string', doc: 'The items with the separator between them. Only on `List<string>` and `List<char>`.', example: 'assert ["a", "b", "c"].join(", ") == "a, b, c"' },
      { name: 'concat', sig: 'concat(List<T>) -> List<T>', doc: 'This list followed by the other.', example: 'assert [1, 2].concat([3]) == [1, 2, 3]' },
      {
        name: 'slice',
        sig: 'slice(int, int) -> List<T>',
        doc: 'The items from `start` up to, not including, `end`; both are clamped to the list, as for strings, so `xs.slice(n - 10, n)` is at most the last ten. `xs.slice(start)` runs to the end.',
        example: 'let xs = [1, 2, 3, 4]\nassert xs.slice(1, 3) == [2, 3]\nassert xs.slice(2, 99) == [3, 4]\nassert xs.slice(3, 1) == []\nassert xs.slice(xs.length() - 10, xs.length()) == xs\nassert xs.slice(1) == [2, 3, 4]',
      },
      {
        name: 'map',
        sig: 'map(fn(T) -> U) -> List<U>',
        doc: 'The function applied to each item. It may use effects; `map` then uses them too.',
        example: 'assert [1, 2, 3].map((x) => x * 10) == [10, 20, 30]',
      },
      { name: 'filter', sig: 'filter(fn(T) -> bool) -> List<T>', doc: 'The items the function keeps.', example: 'assert [1, 2, 3, 4].filter((x) => x % 2 == 0) == [2, 4]' },
      {
        name: 'all',
        sig: 'all(fn(T) -> bool) -> bool',
        doc: 'Whether the function is true for every item (`true` for an empty list). Stops at the first `false`.',
        example: 'assert [1, 2].all((x) => x > 0)\nlet xs: List<int> = []\nassert xs.all((x) => x > 5)',
      },
      {
        name: 'any',
        sig: 'any(fn(T) -> bool) -> bool',
        doc: 'Whether the function is true for some item (`false` for an empty list). Stops at the first `true`.',
        example: 'assert [1, 2].any((x) => x > 1)\nlet xs: List<int> = []\nassert !xs.any((x) => x > 5)',
      },
      {
        name: 'fold',
        sig: 'fold(A, fn(A, T) -> A) -> A',
        doc: 'Starts from the first argument and combines it with each item in turn.',
        example: 'assert [1, 2, 3].fold(10, (acc, x) => acc + x) == 16\nassert ["a", "b"].fold("", (acc, s) => "${acc}<${s}>") == "<a><b>"',
      },
      {
        name: 'sum',
        sig: 'sum() -> int',
        doc: 'The total of a `List<int>` (or of a `List<float>`, a float); 0 for an empty one. Overflow panics, as `+` does.',
        example: 'assert [1, 2, 3].sum() == 6\nlet times = [1.5, 2.5, 2.0]\nassert times.sum() / times.length().toFloat() == 2.0',
      },
      { name: 'push', sig: 'push(T)', doc: 'Adds the item at the end. Needs `let mut`.', example: 'let mut xs = [1]\nxs.push(2)\nassert xs == [1, 2]' },
      { name: 'pop', sig: 'pop() -> T?', doc: 'Removes and gives the last item, or `none` if empty. Needs `let mut`.', example: 'let mut xs = [1, 2]\nassert xs.pop() == 2\nassert xs == [1]' },
    ],
  },
  {
    key: 'map',
    title: 'Map<K, V>',
    intro:
      'Keys to values, `["a": 1, "b": 2]` (`[:]` is empty), in insertion order. A value, like a list. `m[k]` is a `V?`; `m[k] = v` sets a key (with `let mut`; `m[k] += 1` is refused, as the key may be missing: `m[k] = (m[k] ?? 0) + 1`). `for (k, v) in m { ... }` loops.',
    misnamed: mapMisnamed,
    entries: [
      { name: 'length', sig: 'length() -> int', doc: 'How many keys.', example: 'assert ["a": 1, "b": 2].length() == 2' },
      { name: 'isEmpty', sig: 'isEmpty() -> bool', doc: 'Whether it has no keys.', example: 'let m: Map<string, int> = [:]\nassert m.isEmpty()' },
      { name: 'has', sig: 'has(K) -> bool', doc: 'Whether the key is in it.', example: 'assert ["a": 1].has("a")\nassert !["a": 1].has("b")' },
      { name: 'keys', sig: 'keys() -> List<K>', doc: 'The keys, in insertion order.', example: 'assert ["b": 1, "a": 2].keys() == ["b", "a"]' },
      { name: 'values', sig: 'values() -> List<V>', doc: 'The values, in insertion order.', example: 'assert ["b": 1, "a": 2].values() == [1, 2]' },
      { name: 'entries', sig: 'entries() -> List<(K, V)>', doc: 'Each key with its value, in insertion order.', example: 'assert ["a": 1].entries() == [("a", 1)]' },
      { name: 'remove', sig: 'remove(K) -> V?', doc: 'Removes the key and gives its value, or `none` if it wasn\'t there. Needs `let mut`.', example: 'let mut m = ["a": 1]\nassert m.remove("a") == 1\nassert m.isEmpty()' },
    ],
  },
  {
    key: 'optional',
    title: 'T?',
    intro:
      'A `T` or `none`. `x ?? fallback` gives the value or the fallback (it binds looser than other operators: `(x ?? 0) > 1`), and after `if x != none` (or `== none` with an early return) `x` is a `T`. `match x { none => ..., v => ... }` names it. `Show` when `T` is: `"${x}"` gives the value as `T` shows it, or `none`.',
    entries: [
      {
        name: 'map',
        sig: 'map(fn(T) -> U) -> U?',
        doc: 'The function applied to the value, or `none` without one. A function that gives a `U?` gives it as it is, so a chain of fields that may be missing reads `a.map((x) => x.b) ?? fallback`.',
        example: 'let n: int? = 4\nassert n.map((x) => x * 2) == 8\nlet s: string? = none\nassert s.map((x) => x.length()) == none\nassert n.map((x) => if x > 5 { x } else { none }) == none',
      },
    ],
  },
  {
    key: 'result',
    title: 'Result<T, E>',
    intro:
      '`Ok(value)` or `Err(error)`; `Result<void, E>` succeeds with `Ok()`. `r?` gives the value, or returns the error from the function (whose error type must be `E`: there is no automatic conversion). `match r { Ok(v) => ..., Err(e) => ... }` reads both. `Show` when `T` and `E` are: `Ok(3)`, `Err("bad")`, `Ok()`.',
    entries: [
      {
        name: 'map',
        sig: 'map(fn(T) -> U) -> Result<U, E>',
        doc: 'The same Result with its value turned into another; an `Err` is left as it is.',
        example: 'let r: Result<int, string> = Ok(2)\nassert r.map((n) => n * 10) == Ok(20)',
      },
      {
        name: 'mapErr',
        sig: 'mapErr(fn(E) -> F) -> Result<T, F>',
        doc: 'The same Result with its error turned into another; an `Ok` is left as it is. Makes `?` fit: `sql.exec(...).mapErr(toAppError)?`.',
        example: 'let r: Result<int, string> = Err("x")\nassert r.mapErr((e) => e.length()) == Err(1)',
      },
      {
        name: 'isOk',
        sig: 'isOk() -> bool',
        doc: 'Whether it is an `Ok`. To use the value, `match` it or use `?`.',
        example: 'let r: Result<int, string> = Ok(2)\nassert r.isOk()',
      },
      {
        name: 'isErr',
        sig: 'isErr() -> bool',
        doc: 'Whether it is an `Err`: a test that something fails, whatever the message.',
        example: 'let r: Result<int, string> = Err("not a number")\nassert r.isErr()',
      },
      {
        name: 'ok',
        sig: 'ok() -> T?',
        doc: 'The value, or `none` for an `Err`, whose error is dropped. `r.ok() ?? fallback` is the value or a fallback; `??` on the Result itself is refused, so dropping the error is written where it happens.',
        example: 'let r: Result<int, string> = Err("bad")\nassert (r.ok() ?? 7) == 7\nlet s: Result<int, string> = Ok(2)\nassert s.ok() == 2',
      },
    ],
  },
  {
    key: 'goerror',
    title: 'GoError',
    intro: 'An error from Go, given by a binding (`extern`) whose Go function returns one.',
    types: prim(T.goerror),
    entries: [
      { name: 'message', doc: "Go's `Error()` text.", example: null },
      { name: 'is', doc: 'Whether it is, or wraps, the other (Go\'s `errors.Is`).', example: null },
    ],
  },
  {
    key: 'exit',
    title: 'Exit',
    intro:
      'Built in, no import (#6a607d39): a struct `Exit { status: int, message: string }`. A `main` returning `Result<void, Exit>` ends on an `Err` with the message on stderr (a newline added) and that status, 0 to 125 (another exits 1 and says so). Any other error type from `main` exits 1. There is no `env.exit`. A module\'s own `Exit` type hides this one.',
    entries: [
      {
        name: 'status',
        sig: ': int',
        doc: 'The exit status: 2 for a usage error, as Go\'s flag package gives, 0 for `-h`.',
        example: 'let e = Exit { status: 2, message: "usage: hey [options] <url>" }\nassert e.status == 2',
      },
      {
        name: 'message',
        sig: ': string',
        doc: 'Printed on stderr before the program exits; nothing if empty.',
        example: 'let e: Result<void, Exit> = Err(Exit { status: 2, message: "missing <url>" })\nassert e == Err(Exit { status: 2, message: "missing <url>" })',
      },
    ],
  },
  {
    key: 'io',
    title: 'io (effect)',
    intro: 'Standard output and input. `uses io`. In a test block it records what is printed, and reads only what `setInput` gives it.',
    types: effectOps('io'),
    entries: [
      { name: 'println', doc: 'Prints the text and a newline.', example: 'io.println("hi")\nassert io.output() == "hi\\n"' },
      { name: 'print', doc: 'Prints the text.', example: 'io.print("a")\nio.print("b")\nassert io.output() == "ab"' },
      { name: 'eprintln', doc: 'Prints the text and a newline on standard error.', example: 'io.eprintln("oops")\nassert io.errorOutput() == "oops\\n"\nassert io.output() == ""' },
      { name: 'eprint', doc: 'Prints the text on standard error.', example: 'io.eprint("a")\nassert io.errorOutput() == "a"' },
      { name: 'readLine', doc: 'The next line of input without its line ending (`\\n` or `\\r\\n`), or `none` at the end.', example: 'io.setInput("a\\r\\nb")\nassert io.readLine() == "a"\nassert io.readLine() == "b"\nassert io.readLine() == none' },
      { name: 'readAll', doc: 'The rest of the input.', example: 'io.setInput("x\\ny\\n")\nassert io.readLine() == "x"\nassert io.readAll() == "y\\n"' },
      { name: 'output', doc: 'Everything printed since the test started: each call gives all of it again, not what is new since the last.', fake: true, example: 'io.println("a")\nassert io.output() == "a\\n"\nio.println("b")\nassert io.output() == "a\\nb\\n"' },
      { name: 'errorOutput', doc: 'Everything printed on standard error since the test started.', fake: true, example: 'assert io.errorOutput() == ""' },
      { name: 'setInput', doc: 'Sets the input still to read.', fake: true, example: 'io.setInput("hi\\n")\nassert io.readAll() == "hi\\n"' },
    ],
  },
  {
    key: 'clock',
    title: 'clock (effect)',
    intro: 'Time in milliseconds since the Unix epoch. `uses clock`. In a test block time is virtual: it starts at 0 and moves when told to, or when every task sleeps.',
    types: effectOps('clock'),
    entries: [
      { name: 'now', doc: 'The time now.', example: 'assert clock.now() == 0' },
      { name: 'sleep', doc: 'Waits that many milliseconds (cancellable).', example: 'clock.sleep(250)\nassert clock.now() == 250' },
      { name: 'nanos', doc: 'A count of nanoseconds that only goes up, for timing: `clock.nanos() - start` is how long something took, finer than `now`. Not a time of day. In a test, the virtual time × 1,000,000.', example: 'clock.advance(2)\nassert clock.nanos() == 2000000' },
      { name: 'set', doc: 'Sets the virtual time.', fake: true, example: 'clock.set(1000)\nassert clock.now() == 1000' },
      { name: 'advance', doc: 'Moves the virtual time on.', fake: true, example: 'clock.advance(5)\nassert clock.now() == 5' },
    ],
  },
  {
    key: 'env',
    title: 'env (effect)',
    intro: 'The process environment, read only but for `env.load`. `uses env`. In a test block it starts empty.',
    types: effectOps('env'),
    entries: [
      { name: 'get', doc: 'The variable\'s value, or `none` if unset.', example: 'assert env.get("PORT") == none' },
      { name: 'args', doc: 'The program\'s arguments, without its name (`candor run f.candor -- a b`).', example: 'assert env.args() == []' },
      { name: 'pid', doc: 'This process\'s id (1 when it runs first in a container). In a test, 1000 until `env.setPid`.', example: 'assert env.pid() == 1000' },
      {
        name: 'zone',
        sig: 'zone() -> time.Zone',
        doc: 'The zone the program runs in: `$TZ`\'s, else the machine\'s, else UTC. On a machine whose zone has no database name (Windows) it is named "Local" and keeps the machine\'s rules. Needs `import "time"`. In a test, UTC until `env.setZone`.',
        example: 'assert time.zoneName(env.zone()) == "UTC"',
      },
      {
        name: 'load',
        sig: 'load(string) -> Result<void, fs.FsError>',
        doc: 'Reads a .env file: `KEY=value` lines, `#` comments, values bare or quoted. A variable already set keeps its value, so the real environment wins. Needs `import "fs"` and `uses env, fs`; in a test it reads the memory file system into the fake.',
        example: 'assert fs.write(".env", "PORT=8080\\nNAME=\\"my app\\" # quoted\\n") == Ok()\nenv.set("PORT", "9000")\nassert env.load(".env") == Ok()\nassert env.get("NAME") == "my app"\nassert env.get("PORT") == "9000"',
      },
      {
        name: 'signals',
        doc: "A channel that gets each of those signals the process is sent, until the scope ends; then they do what they did before (Ctrl-C ends the program). `Signal` is built in: `.Interrupt` (Ctrl-C), `.Terminate`, `.Hangup`, `.User1`, `.User2`. On Windows only `.Interrupt` and `.Terminate` (a console closing) come. Up to 8 wait unread; more are dropped. Receive in a `s.background` task to act on one while the work goes on. `http.serve` handles its own.",
        example: 'let got = tasks.scope((s) => {\n  let sigs = env.signals(s, [.Interrupt, .Terminate])\n  env.sendSignal(.Terminate)\n  return sigs.recv()\n})\nassert got == .Terminate',
      },
      { name: 'set', doc: 'Sets a variable.', fake: true, example: 'env.set("PORT", "8080")\nassert env.get("PORT") == "8080"' },
      { name: 'setArgs', doc: 'Sets the arguments.', fake: true, example: 'env.setArgs(["-v"])\nassert env.args() == ["-v"]' },
      { name: 'setPid', doc: 'Sets the pid `env.pid()` gives.', fake: true, example: 'env.setPid(1)\nassert env.pid() == 1' },
      {
        name: 'setZone',
        sig: 'setZone(time.Zone)',
        doc: 'Sets the zone `env.zone()` gives.',
        fake: true,
        example: 'env.setZone(time.zone("Europe/Oslo") ?? time.utcZone())\nassert time.zoneName(env.zone()) == "Europe/Oslo"',
      },
      {
        name: 'sendSignal',
        doc: 'Sends a signal as if the process were sent it: each `env.signals` channel asking for it gets it.',
        fake: true,
        example: 'tasks.scope((s) => {\n  let sigs = env.signals(s, [.Hangup])\n  env.sendSignal(.Interrupt)\n  env.sendSignal(.Hangup)\n  assert sigs.recv() == .Hangup\n})',
      },
    ],
  },
  {
    key: 'random',
    title: 'random (effect)',
    intro:
      'Random numbers, ids and tokens, from the operating system\'s secure source (Go\'s `crypto/rand`), so a token can be a secret. `uses random`. In a test block the values come from a fixed seed: the same in every run, and `random.seed(n)` picks another sequence.',
    types: effectOps('random'),
    entries: [
      { name: 'int', doc: 'A number from the first to the second, both included. Panics if the first is larger.', example: 'let die = random.int(1, 6)\nassert die >= 1 && die <= 6' },
      {
        name: 'uuid',
        doc: 'A version 7 UUID: the time in milliseconds, then random bits, so ids made later sort later. In a test the time is the virtual clock\'s.',
        example: 'let id = random.uuid()\nassert id.length() == 36\nassert id.slice(14, 15) == "7"',
      },
      {
        name: 'uuid4',
        doc: 'A version 4 UUID: random bits only, so no part of it repeats between ids made together, and they don\'t sort by time. For ids that must not hint at when they were made.',
        example: 'let id = random.uuid4()\nassert id.length() == 36\nassert id.slice(14, 15) == "4"\nassert id != random.uuid4()',
      },
      { name: 'token', doc: 'That many random bytes, as hex (twice as many characters): `random.token(32)` for a session token.', example: 'assert random.token(16).length() == 32' },
      { name: 'bytes', doc: 'That many random bytes: a salt, a nonce, a key. Panics on a negative count.', example: 'let salt = random.bytes(16)\nassert salt.length() == 16\nassert salt != random.bytes(16)' },
      { name: 'shuffle', sig: 'shuffle(List<T>) -> List<T>', doc: 'The items in a random order.', example: 'assert random.shuffle([1, 2, 3]).sorted() == [1, 2, 3]' },
      { name: 'pick', sig: 'pick(List<T>) -> T?', doc: 'One of the items, or `none` from an empty list.', example: 'assert random.pick(["a"]) == "a"\nlet none_: List<int> = []\nassert random.pick(none_) == none' },
      { name: 'seed', doc: 'Starts the values over from another seed.', fake: true, example: 'random.seed(7)\nlet a = random.int(1, 100)\nrandom.seed(7)\nassert random.int(1, 100) == a' },
    ],
  },
  {
    key: 'tasks',
    title: 'tasks (effect)',
    intro:
      'Structured concurrency. `uses tasks`. Every task belongs to a scope and ends before it. Each takes on the effects of the functions it runs. Where a function returns a Result, the first `Err` cancels the others and becomes the result. In a test block tasks run one at a time, in an order picked by a seed, and a test whose order matters runs in 100 orders (`--runs N`), half of them PCT (random priorities with a few change points, which find races needing particular preemptions); a failure prints its seed, and `--seed` replays it.',
    entries: [
      {
        name: 'scope',
        sig: 'scope(fn(Scope) -> T) -> T',
        doc: 'Runs the function with a Scope to spawn tasks in, and waits for all of them before giving its result.',
        example: 'let n = tasks.scope((s) => {\n  let a = s.spawn(() => 20)\n  let b = s.spawn(() => 22)\n  return a.join() + b.join()\n})\nassert n == 42',
      },
      { name: 'all', sig: 'all(List<T>, fn(T) -> U) -> List<U>', doc: 'The function run on each item at once, the results in the items\' order.', example: 'assert tasks.all([1, 2, 3], (x) => x * 2) == [2, 4, 6]' },
      { name: 'both', sig: 'both(fn() -> A, fn() -> B) -> (A, B)', doc: 'Both functions at once; both results.', example: 'assert tasks.both(() => 1, () => "a") == (1, "a")' },
      {
        name: 'race',
        sig: 'race(List<fn() -> T>) -> T',
        doc: 'The functions at once; the first to finish wins and the others are cancelled. For a `Result`, an `Err` doesn\'t win: the race waits for the first `Ok`, and gives the last `Err` only when every function fails. So a race stays alive while one function hasn\'t finished.',
        example: 'let winner = tasks.race([() => {\n  clock.sleep(50)\n  return "slow"\n}, () => "fast"])\nassert winner == "fast"',
      },
      {
        name: 'timeout',
        sig: 'timeout(int, fn() -> T) -> T?',
        doc: 'The function\'s result, or `none` if it takes longer than the milliseconds given (it is cancelled). For a function returning nothing, a `bool`: whether it finished.',
        example: 'assert tasks.timeout(100, () => 1) == 1\nlet late = tasks.timeout(10, () => {\n  clock.sleep(50)\n  return 2\n})\nassert late == none',
      },
      {
        name: 'select',
        sig: 'select(List<Arm<T>>) -> T',
        doc: 'Waits until one of the arms is ready, runs its function and gives what it returned. Arms: `ch.onRecv`, `ch.onSend`, `tasks.after`, `tasks.otherwise`.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  ch.send(7)\n  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.after(100, () => -1)])\n  assert got == 7\n})',
      },
      {
        name: 'after',
        sig: 'after(int, fn() -> T) -> Arm<T>',
        doc: 'An arm ready once the milliseconds have passed.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.after(100, () => -1)])\n  assert got == -1\n})',
      },
      {
        name: 'otherwise',
        sig: 'otherwise(fn() -> T) -> Arm<T>',
        doc: 'An arm taken at once when no other is ready: `select` then doesn\'t wait.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.otherwise(() => 0)])\n  assert got == 0\n})',
      },
    ],
  },
  {
    key: 'scope',
    title: 'Scope',
    intro: 'Given by `tasks.scope`. Tasks and shared values made with it end, or are dropped, when it does. Its methods need no `uses`: having the scope is enough.',
    entries: [
      {
        name: 'spawn',
        sig: 'spawn(fn() -> T) -> Task<T>',
        doc: 'Starts the function as a task. If it returns a Result, its `Err` cancels the scope, and the scope\'s function must return a Result with the same error.',
        example: 'let n = tasks.scope((s) => {\n  let t = s.spawn(() => 2)\n  return t.join()\n})\nassert n == 2',
      },
      {
        name: 'background',
        sig: 'background(fn() -> T)',
        doc: "Starts the function as a task that runs until the scope's own function has returned and its other tasks have ended, then is cancelled; the scope still waits for it to stop, its `defer`s included. For a server, a watcher or a library's manager loop beside the work. Its `Err` cancels the scope, as for `spawn`. `wait` doesn't wait for it.",
        example: 'let ticks = tasks.scope((s) => {\n  let n = s.atomic(0)\n  s.background(() => {\n    while true {\n      clock.sleep(10)\n      n.add(1)\n    }\n  })\n  clock.sleep(35)\n  return n.get()\n})\nassert ticks == 3',
      },
      {
        name: 'mutex',
        sig: 'mutex(T) -> Mutex<T>',
        doc: 'A value tasks share, changed only through functions run under its lock.',
        example: 'let n = tasks.scope((s) => {\n  let m = s.mutex(0)\n  tasks.all([1, 2, 3], (x) => m.update((v) => v + x))\n  return m.get()\n})\nassert n == 6',
      },
      {
        name: 'atomic',
        sig: 'atomic(T) -> Atomic<T>',
        doc: 'An int or a bool tasks share, changed in one step.',
        example: 'let n = tasks.scope((s) => {\n  let a = s.atomic(0)\n  tasks.all([1, 2, 3], (x) => a.add(x))\n  return a.get()\n})\nassert n == 6',
      },
      {
        name: 'lock',
        sig: 'lock() -> Lock',
        doc: 'A lock for work that uses effects, such as a file\'s read-change-write: its `hold` functions run one at a time.',
        example: 'let n = tasks.scope((s) => {\n  let lock = s.lock()\n  let count = s.atomic(0)\n  tasks.all([1, 2, 3], (x) => lock.hold(() => count.add(x)))\n  return count.get()\n})\nassert n == 6',
      },
      {
        name: 'channel',
        sig: 'channel(int) -> Channel<T>',
        doc: 'A queue between tasks holding up to that many items. What it carries comes from where it goes: `let ch: Channel<int> = s.channel(8)`.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<string> = s.channel(2)\n  ch.send("a")\n  assert ch.recv() == "a"\n})',
      },
      {
        name: 'wait',
        sig: 'wait()',
        doc: 'Waits for the tasks spawned so far, before the scope ends.',
        example: 'let n = tasks.scope((s) => {\n  let a = s.atomic(0)\n  s.spawn(() => a.add(1))\n  s.wait()\n  return a.get()\n})\nassert n == 1',
      },
    ],
  },
  {
    key: 'task',
    title: 'Task<T>',
    intro: 'A running task, from `s.spawn`.',
    entries: [
      { name: 'join', sig: 'join() -> T', doc: 'Waits for the task and gives its result.', example: 'let n = tasks.scope((s) => s.spawn(() => 5).join())\nassert n == 5' },
    ],
  },
  {
    key: 'mutex',
    title: 'Mutex<T>',
    intro: 'From `s.mutex(v)`. Changed only by function, so no update is lost; those functions can\'t use effects, so the lock is never held long. State checked and changed together lives in one Mutex, with the check inside `updateWith`.',
    entries: [
      { name: 'get', sig: 'get() -> T', doc: 'The value now.', example: 'tasks.scope((s) => {\n  let m = s.mutex("a")\n  assert m.get() == "a"\n})' },
      { name: 'update', sig: 'update(fn(T) -> T) -> T', doc: 'Replaces the value with what the function makes of it, and gives the new value.', example: 'tasks.scope((s) => {\n  let m = s.mutex(1)\n  assert m.update((v) => v + 1) == 2\n})' },
      {
        name: 'updateWith',
        sig: 'updateWith(fn(T) -> (T, R)) -> R',
        doc: 'As `update`, but the function also gives a result: `(new value, result)`.',
        example: 'tasks.scope((s) => {\n  let m = s.mutex(1)\n  assert m.updateWith((n) => (n + 1, n * 10)) == 10\n  assert m.get() == 2\n})',
      },
    ],
  },
  {
    key: 'lock',
    title: 'Lock',
    intro:
      'From `s.lock()`. Holds no value: it makes what its `hold` functions do happen one task at a time, effects included, where a Mutex\'s functions only compute. A task holds one Lock at a time: a `hold` inside a `hold` panics, so two Locks can\'t deadlock. What is changed together goes under one Lock.',
    entries: [
      {
        name: 'hold',
        sig: 'hold(fn() -> R) -> R',
        doc: 'Waits until no other task holds the lock, runs the function and gives its result. The lock is let go however the function ends: a return, a panic, a cancel.',
        example: 'tasks.scope((s) => {\n  let lock = s.lock()\n  assert lock.hold(() => 1 + 1) == 2\n})',
      },
    ],
  },
  {
    key: 'atomic',
    title: 'Atomic<T>',
    intro: 'From `s.atomic(v)`: an int or a bool.',
    entries: [
      { name: 'get', sig: 'get() -> T', doc: 'The value now.', example: 'tasks.scope((s) => {\n  let a = s.atomic(true)\n  assert a.get()\n})' },
      { name: 'set', sig: 'set(T)', doc: 'Sets the value.', example: 'tasks.scope((s) => {\n  let a = s.atomic(1)\n  a.set(5)\n  assert a.get() == 5\n})' },
      { name: 'add', sig: 'add(int) -> int', doc: 'Adds to the value and gives the new one. Ints only.', example: 'tasks.scope((s) => {\n  let a = s.atomic(1)\n  assert a.add(2) == 3\n})' },
      {
        name: 'compareAndSet',
        sig: 'compareAndSet(T, T) -> bool',
        doc: 'Sets it to the second value if it is the first; whether it did.',
        example: 'tasks.scope((s) => {\n  let a = s.atomic(1)\n  assert a.compareAndSet(1, 2)\n  assert !a.compareAndSet(1, 3)\n  assert a.get() == 2\n})',
      },
    ],
  },
  {
    key: 'channel',
    title: 'Channel<T>',
    intro: 'From `s.channel(n)`: a queue of up to `n` items between tasks.',
    entries: [
      { name: 'send', sig: 'send(T)', doc: 'Adds an item, waiting while the channel is full. Sending on a closed channel panics.', example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  ch.send(1)\n  assert ch.recv() == 1\n})' },
      {
        name: 'recv',
        sig: 'recv() -> T?',
        doc: 'Takes the next item, waiting while there is none; `none` once the channel is closed and empty.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  ch.close()\n  assert ch.recv() == none\n})',
      },
      { name: 'close', sig: 'close()', doc: 'No more items will come: receivers get `none` once it is empty.', example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(2)\n  ch.send(1)\n  ch.close()\n  assert ch.recv() == 1\n  assert ch.recv() == none\n})' },
      {
        name: 'onRecv',
        sig: 'onRecv(fn(T?) -> R) -> Arm<R>',
        doc: 'An arm for `tasks.select`, ready when an item (or the close, as `none`) can be taken; the function gets it.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  ch.send(3)\n  assert tasks.select([ch.onRecv((v) => v ?? 0)]) == 3\n})',
      },
      {
        name: 'onSend',
        sig: 'onSend(T, fn() -> R) -> Arm<R>',
        doc: 'An arm for `tasks.select`, ready when the item can be sent; it is sent, then the function runs.',
        example: 'tasks.scope((s) => {\n  let ch: Channel<int> = s.channel(1)\n  assert tasks.select([ch.onSend(4, () => "sent"), tasks.otherwise(() => "full")]) == "sent"\n  assert ch.recv() == 4\n})',
      },
    ],
  },
];

export function section(key: string): RefSection {
  const s = reference.find((s) => s.key === key);
  if (!s) throw new Error(`no reference section ${key}`);
  return s;
}

/** The method names of a section, in its order: the checker's lists for List, Map, tasks and the handles. */
export function methodNames(key: string): string[] {
  return section(key).entries.map((e) => e.name);
}

export function signature(s: RefSection, e: RefEntry): string {
  if (e.sig) return e.sig;
  const t = s.types?.get(e.name);
  if (!t) throw new Error(`no signature for ${s.key}.${e.name}`);
  const ret = t.ret.kind === 'unit' ? '' : ` -> ${typeToString(t.ret)}`;
  return `${e.name}(${t.params.map((p) => typeToString(p)).join(', ')})${ret}`;
}

/** One section as Markdown, as `candor doc` prints it. */
export function renderSection(s: RefSection): string {
  const out = [`## ${s.title}`, '', s.intro, ''];
  const real = s.entries.filter((e) => !e.fake);
  const fake = s.entries.filter((e) => e.fake);
  const entry = (e: RefEntry) => {
    out.push(`### \`${signature(s, e)}\``, '', e.doc, '');
    if (e.example) out.push('```', e.example, '```', '');
  };
  real.forEach(entry);
  if (fake.length > 0) {
    out.push('In a test block only:', '');
    fake.forEach(entry);
  }
  if (s.misnamed && s.misnamed.size > 0) {
    out.push('Names from other languages:', '');
    for (const [name, instead] of s.misnamed) out.push(`- \`${name}\`: ${instead}`);
    out.push('');
  }
  return out.join('\n');
}

/** The whole reference, `docs/reference.md`. */
export function renderReference(): string {
  const head = [
    '# Candor reference',
    '',
    'The methods of the built-in types and the operations of the built-in effects. Generated from',
    '`src/reference.ts` by `bun run reference`: edit that, not this. `candor doc <name>` prints a',
    'section (`candor doc string`) or every method of a name (`candor doc split`). The standard',
    'modules document themselves: [`std/http.candor`](../std/http.candor),',
    '[`std/json.candor`](../std/json.candor), [`std/sql.candor`](../std/sql.candor), [`std/fs.candor`](../std/fs.candor),',
    '[`std/net.candor`](../std/net.candor), [`std/exec.candor`](../std/exec.candor), [`std/mime.candor`](../std/mime.candor),',
    '[`std/imap.candor`](../std/imap.candor), [`std/smtp.candor`](../std/smtp.candor), [`std/regex.candor`](../std/regex.candor),',
    '[`std/crypto.candor`](../std/crypto.candor), [`std/html.candor`](../std/html.candor), [`std/xml.candor`](../std/xml.candor),',
    '[`std/url.candor`](../std/url.candor), [`std/bytes.candor`](../std/bytes.candor), [`std/hash.candor`](../std/hash.candor),',
    '[`std/time.candor`](../std/time.candor), [`std/flags.candor`](../std/flags.candor).',
    '',
    reference.map((s) => `[${md(s.title)}](#${anchor(s.title)})`).join(' · '),
    '',
  ];
  // The heading's `<T>` would be read as an HTML tag; `candor doc` prints the title unescaped.
  const sections = reference.map((s) => renderSection(s).replace(/^## .*/, `## ${md(s.title)}`));
  return [...head, ...sections].join('\n').replace(/\n+$/, '\n');
}

/** A title as Markdown text: `<` escaped, so `List<T>` isn't an HTML tag. */
function md(title: string): string {
  return title.replace(/</g, '\\<');
}

/** GitHub's heading anchor. */
function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

/** `candor doc [name]`: the sections, one section, or every method of that name. */
export function doc(name: string | undefined): { text: string; ok: boolean } {
  const list = `sections: ${reference.map((s) => s.key).join(', ')}`;
  if (!name) return { text: `candor doc <section or method>\n${list}\n`, ok: true };
  const key = name.toLowerCase().replace(/<.*$/, '').replace(/\?$/, '');
  const s = reference.find((s) => s.key === key || (name.endsWith('?') && s.key === 'optional'));
  if (s) return { text: renderSection(s), ok: true };
  const hits = reference.flatMap((s) => s.entries.filter((e) => e.name === name).map((e) => ({ s, e })));
  if (hits.length > 0) {
    return { text: hits.map(({ s, e }) => [`${s.title}: \`${signature(s, e)}\``, '', e.doc, ...(e.example ? ['```', e.example, '```'] : [])].join('\n')).join('\n\n') + '\n', ok: true };
  }
  const instead = reference.flatMap((s) => (s.misnamed?.has(name) ? [`${s.title}: ${s.misnamed.get(name)}`] : []));
  if (instead.length > 0) return { text: `no method \`${name}\`\n${instead.join('\n')}\n`, ok: false };
  return { text: `no section or method \`${name}\`\n${list}\n`, ok: false };
}
