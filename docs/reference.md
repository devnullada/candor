# Candor reference

The methods of the built-in types and the operations of the built-in effects. Generated from
`src/reference.ts` by `bun run reference`: edit that, not this. `candor doc <name>` prints a
section (`candor doc string`) or every method of a name (`candor doc split`). The standard
modules document themselves: [`std/http.candor`](../std/http.candor),
[`std/json.candor`](../std/json.candor), [`std/sql.candor`](../std/sql.candor), [`std/fs.candor`](../std/fs.candor),
[`std/net.candor`](../std/net.candor), [`std/exec.candor`](../std/exec.candor), [`std/mime.candor`](../std/mime.candor),
[`std/imap.candor`](../std/imap.candor), [`std/smtp.candor`](../std/smtp.candor), [`std/regex.candor`](../std/regex.candor),
[`std/crypto.candor`](../std/crypto.candor), [`std/html.candor`](../std/html.candor), [`std/xml.candor`](../std/xml.candor),
[`std/url.candor`](../std/url.candor), [`std/bytes.candor`](../std/bytes.candor), [`std/hash.candor`](../std/hash.candor),
[`std/time.candor`](../std/time.candor), [`std/flags.candor`](../std/flags.candor).

[int](#int) · [float](#float) · [char](#char) · [bool](#bool) · [string](#string) · [Bytes](#bytes) · [List\<T>](#listt) · [Map\<K, V>](#mapk-v) · [T?](#t) · [Result\<T, E>](#resultt-e) · [GoError](#goerror) · [Exit](#exit) · [io (effect)](#io-effect) · [clock (effect)](#clock-effect) · [env (effect)](#env-effect) · [random (effect)](#random-effect) · [tasks (effect)](#tasks-effect) · [Scope](#scope) · [Task\<T>](#taskt) · [Mutex\<T>](#mutext) · [Lock](#lock) · [Atomic\<T>](#atomict) · [Channel\<T>](#channelt)

## int

A 64-bit integer. Arithmetic that overflows panics, naming the line, as `/` by zero does; the `wrapping` methods wrap instead, and the `checked` methods give `none`. A constant expression that overflows or divides by zero is a compile error. `60_000` groups digits.

### `toString() -> string`

The decimal digits.

```
let n = -42
assert n.toString() == "-42"
```

### `toChar() -> char?`

The char with this code point, or `none` if it is not one.

```
assert 233.toChar() == 'é'
assert (-1).toChar() == none
```

### `toFloat() -> float`

The same number as a float (the nearest one, past 2^53).

```
let done = 1
let total = 4
assert done.toFloat() / total.toFloat() == 0.25
```

### `wrappingAdd(int) -> int`

The sum, wrapped around 64 bits instead of panicking: for hashes and checksums.

```
let max = 9_223_372_036_854_775_807
assert max.wrappingAdd(1) == -9_223_372_036_854_775_807 - 1
```

### `wrappingSub(int) -> int`

The difference, wrapped around 64 bits.

```
let min = -9_223_372_036_854_775_807 - 1
assert min.wrappingSub(1) == 9_223_372_036_854_775_807
```

### `wrappingMul(int) -> int`

The product, wrapped around 64 bits: `h.wrappingMul(31).wrappingAdd(c)`.

```
let big = 4_611_686_018_427_387_904
assert big.wrappingMul(2) == -9_223_372_036_854_775_807 - 1
let three = 3
assert three.wrappingMul(4) == 12
```

### `checkedAdd(int) -> int?`

The sum, or `none` if it overflows: for input that may be out of range.

```
let max = 9_223_372_036_854_775_807
assert max.checkedAdd(1) == none
assert max.checkedAdd(-1) == 9_223_372_036_854_775_806
```

### `checkedSub(int) -> int?`

The difference, or `none` if it overflows.

```
let min = -9_223_372_036_854_775_808
assert min.checkedSub(1) == none
assert min.checkedSub(-1) == -9_223_372_036_854_775_807
```

### `checkedMul(int) -> int?`

The product, or `none` if it overflows.

```
let six = 6
assert six.checkedMul(7) == 42
let big = 4_611_686_018_427_387_904
assert big.checkedMul(2) == none
```

### `checkedDiv(int) -> int?`

The quotient, or `none` for a zero divisor (or `min / -1`): `total.checkedDiv(count) ?? 0`.

```
let seven = 7
assert seven.checkedDiv(0) == none
assert seven.checkedDiv(2) == 3
let count = 0
let average = 21.checkedDiv(count) ?? 0
assert average == 0
```

### `min(int) -> int`

The smaller of the two. For a list, `xs.min()`.

```
let limit = 100
let asked = 250
assert asked.min(limit) == 100
```

### `max(int) -> int`

The larger of the two: `page.max(1)` keeps it at least 1.

```
let page = -3
assert page.max(1) == 1
assert 7.max(2) == 7
```

### `abs() -> int`

Without its sign. Panics on the one int with no positive twin, -9_223_372_036_854_775_808.

```
assert (-5).abs() == 5
assert 5.abs() == 5
```

### `pow(int) -> int`

Raised to the power `k`. Panics if it overflows, or if `k` is negative (for a fraction, use floats).

```
assert 2.pow(10) == 1024
assert 10.pow(0) == 1
assert (-3).pow(3) == -27
```

### `and(int) -> int`

The bits set in both, Go's `&`: `flags.and(mask) != 0`.

```
assert 12.and(10) == 8
let flags = 5
assert flags.and(4) != 0
```

### `or(int) -> int`

The bits set in either, Go's `|`.

```
assert 12.or(3) == 15
```

### `xor(int) -> int`

The bits set in one but not both, Go's `^`: for checksums and HMAC pads.

```
assert 12.xor(10) == 6
assert 0x36.xor(0x5c) == 106
```

### `not() -> int`

Every bit flipped, Go's unary `^`: `-n - 1`.

```
assert 0.not() == -1
assert 12.and(5.not()) == 8
```

### `shl(int) -> int`

Shifted left `k` bits, 0 to 63 (another count panics). Bits shifted out are gone: no overflow.

```
assert 1.shl(10) == 1024
assert 1.shl(63) == -9_223_372_036_854_775_807 - 1
```

### `shr(int) -> int`

Shifted right `k` bits, 0 to 63, the sign copied in: `(-8).shr(1)` is -4.

```
assert 1024.shr(3) == 128
assert (-8).shr(1) == -4
```

### `ushr(int) -> int`

Shifted right `k` bits, 0 to 63, zeros shifted in (JavaScript's `>>>`): the bits as unsigned.

```
assert 1024.ushr(3) == 128
assert (-1).ushr(60) == 15
let byte = 0x1234.shr(8).and(0xff)
assert byte == 0x12
```

## float

A 64-bit floating-point number, `1.5`, `2.0e-3`, `1e21`. Never NaN or infinite: an operation that would make one panics with the line, as int overflow does, and so does `/` by zero. So `==` and `<` order every float, lists of them sort, and they can be map keys. An int and a float never mix: `n.toFloat()` one way, `f.round()` (or `floor`, `ceil`, `truncate`) the other. `%` gives the remainder with the sign of the dividend, as on ints. Interpolates as `toString` gives; JSON is a number.

### `toString() -> string`

The shortest text that reads back as the same float, with `.0` on a whole number and an exponent only below 1e-6 or from 1e21.

```
assert (1.5).toString() == "1.5"
assert (2.0).toString() == "2.0"
assert (0.1 + 0.2).toString() == "0.30000000000000004"
assert 1e21.toString() == "1e+21"
```

### `toFixed(int) -> string`

With that many digits after the point, rounded: for display.

```
let done = 2
let total = 3
let percent = done.toFloat() / total.toFloat() * 100.0
assert "${percent.toFixed(1)}%" == "66.7%"
```

### `round() -> int`

The nearest int, halves away from zero. Panics if it doesn't fit in an int.

```
assert (2.5).round() == 3
assert (-2.5).round() == -3
assert (2.4).round() == 2
```

### `floor() -> int`

The nearest int at or below.

```
assert (2.7).floor() == 2
assert (-2.1).floor() == -3
```

### `ceil() -> int`

The nearest int at or above.

```
assert (2.1).ceil() == 3
assert (-2.7).ceil() == -2
```

### `truncate() -> int`

The int part, dropping the fraction.

```
assert (2.7).truncate() == 2
assert (-2.7).truncate() == -2
```

### `abs() -> float`

Without its sign.

```
assert (-1.5).abs() == 1.5
assert (0.1 + 0.2 - 0.3).abs() < 1e-9
```

### `sqrt() -> float`

The square root. Panics on a negative number.

```
assert (2.25).sqrt() == 1.5
```

### `pow(float) -> float`

Raised to the power `y`. Panics if the result is not a number or too large: `(-8.0).pow(0.5)`, `0.0.pow(-1.0)`.

```
assert (2.0).pow(10.0) == 1024.0
assert (9.0).pow(0.5) == 3.0
assert (2.0).pow(-1.0) == 0.5
```

### `min(float) -> float`

The smaller of the two. For a list, `xs.min()`.

```
let ratio = 1.4
assert ratio.min(1.0) == 1.0
```

### `max(float) -> float`

The larger of the two.

```
let x = -0.5
assert x.max(0.0) == 0.0
assert x.max(0.0).min(1.0) == 0.0
```

## char

One code point, `'a'`, `'é'`, `'\n'`: what `s.chars()` gives and `match` takes. Compared with `==` and `<` by code point; interpolates as itself; JSON is a one-character string. A char is not a string: `c.toString()`, or `"${c}"`.

### `toString() -> string`

A string of the one code point.

```
let c = 'é'
assert c.toString() == "é"
assert "[${c}]" == "[é]"
```

### `code() -> int`

The code point as an int.

```
let c = 'A'
assert c.code() == 65
assert 65.toChar() == 'A'
```

### `isDigit() -> bool`

Whether it is `0` to `9` (ASCII only, as `toInt` reads).

```
assert "a1b2".chars().filter((c) => c.isDigit()) == ['1', '2']
```

### `isLetter() -> bool`

Whether it is a letter, in any script.

```
let c = 'ß'
assert c.isLetter()
let d = '1'
assert !d.isLetter()
```

### `isWhitespace() -> bool`

Whether it is a space, tab, line break or other Unicode space.

```
let c = '\t'
assert c.isWhitespace()
```

### `toUpperCase() -> char`

The upper-case char, or the same one.

```
let c = 'é'
assert c.toUpperCase() == 'É'
```

### `toLowerCase() -> char`

The lower-case char, or the same one.

```
let c = 'Q'
assert c.toLowerCase() == 'q'
```

## bool

`true` or `false`, with `&&`, `||` and `!`.

### `toString() -> string`

`"true"` or `"false"`.

```
let b = true
assert b.toString() == "true"
```

## string

UTF-8 text. Lengths and indexes count code points (Go counts bytes, TypeScript UTF-16 units). `"#${id}"` interpolates; `+` joins. No `s[i]`: index `s.chars()`. Strings never change: methods give new ones.

### `length() -> int`

How many code points.

```
assert "héllo".length() == 5
```

### `byteLength() -> int`

How many UTF-8 bytes.

```
assert "héllo".byteLength() == 6
```

### `isEmpty() -> bool`

Whether it is `""`.

```
assert "".isEmpty()
assert !" ".isEmpty()
```

### `chars() -> List<char>`

Each code point, as a `char`: the list to index or loop over. `join("")` puts them back together.

```
assert "añb".chars() == ['a', 'ñ', 'b']
assert "añb".chars()[1] == 'ñ'
assert "abc".chars().filter((c) => c != 'b').join("") == "ac"
```

### `contains(string) -> bool`

Whether the text appears in it.

```
assert "banana".contains("nan")
```

### `startsWith(string) -> bool`

Whether it begins with the text.

```
assert "/todos/3".startsWith("/todos")
```

### `endsWith(string) -> bool`

Whether it ends with the text.

```
assert "notes.txt".endsWith(".txt")
```

### `indexOf(string) -> int?`

Where the text first appears, in code points; `none` if it doesn't.

```
assert "banana".indexOf("na") == 2
assert "banana".indexOf("x") == none
```

### `lastIndexOf(string) -> int?`

Where the text last appears, in code points; `none` if it doesn't.

```
let name = "song.final.wav"
assert name.slice((name.lastIndexOf(".") ?? name.length()) + 1) == "wav"
```

### `slice(int, int) -> string`

The code points from `start` up to, not including, `end`; both are clamped to the string, a negative one to 0. `slice(start)` runs to the end.

```
assert "héllo".slice(1, 3) == "él"
assert "abc".slice(1, 99) == "bc"
assert "abc".slice(-5, 2) == "ab"
assert "#tag".slice(1) == "tag"
```

### `split(string) -> List<string>`

The parts between each separator.

```
assert "a,b,,c".split(",") == ["a", "b", "", "c"]
```

### `trim() -> string`

Without whitespace at either end.

```
assert "  hi \n".trim() == "hi"
```

### `trimStart() -> string`

Without whitespace at the start.

```
assert "  hi ".trimStart() == "hi "
```

### `trimEnd() -> string`

Without whitespace at the end.

```
assert "hi\r\n".trimEnd() == "hi"
```

### `trimChars(string) -> string`

Without any of the characters in the set at either end, however many there are; the set is characters, not text to match.

```
assert "--a-b--".trimChars("-") == "a-b"
assert "\t x \n".trimChars(" \t\n") == "x"
```

### `removePrefix(string) -> string`

Without the text at the start, once; unchanged if it doesn't start with it.

```
assert "v1.2".removePrefix("v") == "1.2"
assert "1.2".removePrefix("v") == "1.2"
```

### `removeSuffix(string) -> string`

Without the text at the end, once; unchanged if it doesn't end with it.

```
assert "/api/".removeSuffix("/") == "/api"
assert "a//".removeSuffix("/") == "a/"
```

### `toUpperCase() -> string`

In upper case.

```
assert "Hello".toUpperCase() == "HELLO"
```

### `toLowerCase() -> string`

In lower case.

```
assert "HeLLo".toLowerCase() == "hello"
```

### `replaceAll(string, string) -> string`

Every occurrence of the first text replaced by the second.

```
assert "a-b-c".replaceAll("-", "+") == "a+b+c"
```

### `repeat(int) -> string`

The string `n` times over.

```
assert "ab".repeat(3) == "ababab"
```

### `toInt() -> int?`

The int it spells, or `none` unless the whole string is a decimal int (a leading `-` allowed).

```
assert "42".toInt() == 42
assert "-7".toInt() == -7
assert "4x".toInt() == none
```

### `toFloat() -> float?`

The float it spells, or `none` unless the whole string is a decimal number (`1.5`, `-2`, `3e8`).

```
assert "1.5".toFloat() == 1.5
assert "-2".toFloat() == -2.0
assert "NaN".toFloat() == none
```

### `lines() -> List<string>`

The lines, split at `\n` or `\r\n`. A final line break ends the last line; it does not start an empty one.

```
assert "a\nb\r\n".lines() == ["a", "b"]
assert "a\n\nb".lines() == ["a", "", "b"]
assert "".lines() == []
```

### `padStart(int, string) -> string`

The string with `fill` repeated before it up to `n` code points; the last copy is cut to fit. Longer strings are left as they are.

```
assert "7".padStart(3, "0") == "007"
assert "abc".padStart(2, "0") == "abc"
assert "1".padStart(4, "ab") == "aba1"
```

### `padEnd(int, string) -> string`

As `padStart`, with the fill after: for columns.

```
assert "id".padEnd(5, ".") == "id..."
```

### `toBytes() -> Bytes`

Its UTF-8 bytes.

```
assert "é".toBytes().toList() == [195, 169]
```

### `quoted() -> string`

In double quotes, with `\`, `"` and control characters escaped as Go's `%q` does: for logs that show a value exactly.

```
assert "a\tb".quoted() == "\"a\\tb\""
assert "say \"hi\"".quoted().length() == 12
assert "é".quoted() == "\"é\""
```

Names from other languages:

- `includes`: use `contains`
- `has`: use `contains`
- `find`: use `indexOf`: an `int?`, `none` when absent
- `search`: use `indexOf`: an `int?`, `none` when absent
- `rfind`: use `lastIndexOf`: an `int?`, `none` when absent
- `rindex`: use `lastIndexOf`: an `int?`, `none` when absent
- `toUpper`: use `toUpperCase()`
- `upper`: use `toUpperCase()`
- `toLower`: use `toLowerCase()`
- `lower`: use `toLowerCase()`
- `strip`: use `trim()`
- `lstrip`: use `trimStart()`
- `rstrip`: use `trimEnd()`
- `trimLeft`: use `trimStart()`
- `trimRight`: use `trimEnd()`
- `stripPrefix`: use `removePrefix(p)`: the string without `p` at the start, unchanged if absent
- `stripSuffix`: use `removeSuffix(s)`: the string without `s` at the end, unchanged if absent
- `removeprefix`: use `removePrefix(p)`
- `removesuffix`: use `removeSuffix(s)`
- `reverse`: use `chars().reversed()`, and `join("")` for a string
- `reversed`: use `chars().reversed()`, and `join("")` for a string
- `replace`: use `replaceAll(old, new)`: it replaces every occurrence, and says so
- `substring`: use `slice(start, end)`, or `slice(start)` to the end: code point indexes, `end` excluded, both clamped to the string
- `substr`: use `slice(start, end)`, or `slice(start)` to the end: code point indexes, `end` excluded, both clamped to the string
- `charAt`: index the code points: `s.chars()[i]` is a `char?`
- `len`: use `length()`: it counts code points; `byteLength()` counts bytes
- `size`: use `length()`: it counts code points; `byteLength()` counts bytes
- `count`: use `length()`: it counts code points; `byteLength()` counts bytes
- `parseInt`: use `toInt()`: an `int?`, `none` unless the whole string is a decimal int
- `toNumber`: use `toInt()` (an `int?`) or `toFloat()` (a `float?`)
- `parseFloat`: use `toFloat()`: a `float?`, `none` unless the whole string is a decimal number
- `toString`: it is a string already
- `join`: `join` is a method of `List<string>`: `parts.join(", ")`
- `concat`: use `+`
- `equals`: use `==`
- `padLeft`: use `padStart(n, fill)`
- `padRight`: use `padEnd(n, fill)`
- `ljust`: use `padEnd(n, fill)`
- `rjust`: use `padStart(n, fill)`
- `splitLines`: use `lines()`
- `isBlank`: use `trim().isEmpty()`

## Bytes

Bytes, never changed once made, like a string; a byte is an `int` 0 to 255. `s.toBytes()` gives a string's; `import "bytes"` makes them from a list (`bytes.fromList`), hex or base64. `==` compares them, and they can be map keys. In JSON they are a base64 string.

### `length() -> int`

How many bytes.

```
assert "héllo".toBytes().length() == 6
```

### `isEmpty() -> bool`

Whether there are none.

```
assert "".toBytes().isEmpty()
```

### `at(int) -> int?`

The byte at `i`, or `none` out of range.

```
let b = "hi".toBytes()
assert b.at(0) == 104
assert b.at(2) == none
```

### `slice(int, int) -> Bytes`

The bytes from `start` up to, not including, `end`; both are clamped, a negative one to 0. `slice(start)` runs to the end.

```
let b = "hello".toBytes()
assert b.slice(1, 3) == "el".toBytes()
assert b.slice(3, 99) == "lo".toBytes()
assert b.slice(2) == "llo".toBytes()
```

### `concat(Bytes) -> Bytes`

These bytes, then those: new bytes.

```
assert "ab".toBytes().concat("c".toBytes()) == "abc".toBytes()
```

### `indexOf(Bytes) -> int?`

Where the bytes first appear; `none` if they don't.

```
let b = "banana".toBytes()
assert b.indexOf("na".toBytes()) == 2
assert b.indexOf("x".toBytes()) == none
```

### `lastIndexOf(Bytes) -> int?`

Where the bytes last appear; `none` if they don't.

```
let b = "banana".toBytes()
assert b.lastIndexOf("na".toBytes()) == 4
```

### `toList() -> List<int>`

Each byte, as an int: the list to loop over.

```
assert "AB".toBytes().toList() == [65, 66]
```

### `toText() -> string?`

The bytes as a string, or `none` unless they are UTF-8.

```
let b = "é".toBytes()
assert b.toText() == "é"
assert b.slice(0, 1).toText() == none
```

### `toRawText() -> string`

The bytes in a string as they are, UTF-8 or not, as `fs.read` gives a file: `text.toBytes()` gets them back exactly. For a body or a file built byte by byte; `toText()` when it should be text.

```
let b = "é".toBytes().slice(0, 1)
assert b.toText() == none
assert b.toRawText().toBytes() == b
```

### `toHex() -> string`

Lowercase hex, two digits a byte.

```
assert "Hi".toBytes().toHex() == "4869"
```

### `toBase64() -> string`

Standard base64, padded: what JSON holds.

```
assert "Hi".toBytes().toBase64() == "SGk="
```

Names from other languages:

- `len`: use `length()`
- `size`: use `length()`
- `get`: use `at(i)`: an `int?`, `none` out of range
- `toString`: use `toText()` (a `string?`, `none` unless the bytes are UTF-8), or `toHex()`
- `decode`: use `toText()`: a `string?`, `none` unless the bytes are UTF-8
- `append`: use `concat(other)`: Bytes are never changed, so it gives new ones
- `push`: use `concat(other)`: Bytes are never changed, so it gives new ones
- `subarray`: use `slice(start, end)`, or `slice(start)` to the end: `end` excluded, both clamped
- `equals`: use `==`

## List\<T>

An ordered list, `[1, 2, 3]`. A value: assigning or passing one copies it (cheaply, on write). `xs[i]` is a `T?`; `xs[i] = v` and the changing methods need `let mut`. `for x in xs { ... }` loops; `for (i, x) in xs.enumerated()` has the index. `Show` when its items are: `"${xs}"` and `xs.toString()` give `[1, 2]`, `["a", "b"]`.

### `length() -> int`

How many items.

```
assert [1, 2, 3].length() == 3
```

### `isEmpty() -> bool`

Whether it has none.

```
let xs: List<int> = []
assert xs.isEmpty()
```

### `first() -> T?`

The first item, or `none` if empty.

```
assert [4, 5].first() == 4
let xs: List<int> = []
assert xs.first() == none
```

### `last() -> T?`

The last item, or `none` if empty.

```
assert [4, 5].last() == 5
```

### `reversed() -> List<T>`

A copy, last item first.

```
assert [1, 2, 3].reversed() == [3, 2, 1]
```

### `enumerated() -> List<(int, T)>`

Each item with its index, from 0.

```
assert ["a", "b"].enumerated() == [(0, "a"), (1, "b")]
```

### `contains(T) -> bool`

Whether an item `==` the value. `T` must be comparable.

```
assert [1, 2, 3].contains(2)
```

### `unique() -> List<T>`

Each item once, where it first appears. `T` must be comparable.

```
assert [3, 1, 3, 2, 1].unique() == [3, 1, 2]
```

### `union(List<T>) -> List<T>`

The items in either list, each once: this list's in order, then the other's new ones. `T` must be comparable.

```
assert [1, 2, 2].union([3, 2, 4]) == [1, 2, 3, 4]
```

### `intersect(List<T>) -> List<T>`

The items of this list that the other has too, each once, in this list's order. `T` must be comparable.

```
assert [5, 1, 3, 1].intersect([1, 5, 9]) == [5, 1]
assert [1, 2].intersect([]) == []
```

### `sorted() -> List<T>`

A sorted copy, smallest first, by `<`. `T` must be ordered (`T: Ord`): int, string, a type with `impl Ord`, or a tuple of those, compared item by item.

```
assert [3, 1, 2].sorted() == [1, 2, 3]
assert [(2, "a"), (1, "b"), (1, "a")].sorted() == [(1, "a"), (1, "b"), (2, "a")]
```

### `sortedBy(fn(T) -> K) -> List<T>`

A copy sorted by the key the function gives each item, smallest first; items with equal keys keep their order. `K` must be ordered: a tuple sorts by several keys.

```
let words = ["bb", "a", "ccc", "dd"]
assert words.sortedBy((w) => w.length()) == ["a", "bb", "dd", "ccc"]
assert words.sortedBy((w) => (-w.length(), w)) == ["ccc", "bb", "dd", "a"]
```

### `min() -> T?`

The smallest item by `<`, or `none` if empty; of equal ones, the first. `T` must be ordered, as for `sorted`. By a key: `xs.sortedBy((x) => x.at).first()`.

```
assert [3, 1, 2].min() == 1
let scores: List<float> = []
assert (scores.min() ?? 0.0) == 0.0
```

### `max() -> T?`

The largest item by `<`, or `none` if empty.

```
assert ["pear", "apple"].max() == "pear"
assert [2.5, 9.0].max() == 9.0
```

### `join(string) -> string`

The items with the separator between them. Only on `List<string>` and `List<char>`.

```
assert ["a", "b", "c"].join(", ") == "a, b, c"
```

### `concat(List<T>) -> List<T>`

This list followed by the other.

```
assert [1, 2].concat([3]) == [1, 2, 3]
```

### `slice(int, int) -> List<T>`

The items from `start` up to, not including, `end`; both are clamped to the list, as for strings, so `xs.slice(n - 10, n)` is at most the last ten. `xs.slice(start)` runs to the end.

```
let xs = [1, 2, 3, 4]
assert xs.slice(1, 3) == [2, 3]
assert xs.slice(2, 99) == [3, 4]
assert xs.slice(3, 1) == []
assert xs.slice(xs.length() - 10, xs.length()) == xs
assert xs.slice(1) == [2, 3, 4]
```

### `map(fn(T) -> U) -> List<U>`

The function applied to each item. It may use effects; `map` then uses them too.

```
assert [1, 2, 3].map((x) => x * 10) == [10, 20, 30]
```

### `filter(fn(T) -> bool) -> List<T>`

The items the function keeps.

```
assert [1, 2, 3, 4].filter((x) => x % 2 == 0) == [2, 4]
```

### `all(fn(T) -> bool) -> bool`

Whether the function is true for every item (`true` for an empty list). Stops at the first `false`.

```
assert [1, 2].all((x) => x > 0)
let xs: List<int> = []
assert xs.all((x) => x > 5)
```

### `any(fn(T) -> bool) -> bool`

Whether the function is true for some item (`false` for an empty list). Stops at the first `true`.

```
assert [1, 2].any((x) => x > 1)
let xs: List<int> = []
assert !xs.any((x) => x > 5)
```

### `fold(A, fn(A, T) -> A) -> A`

Starts from the first argument and combines it with each item in turn.

```
assert [1, 2, 3].fold(10, (acc, x) => acc + x) == 16
assert ["a", "b"].fold("", (acc, s) => "${acc}<${s}>") == "<a><b>"
```

### `sum() -> int`

The total of a `List<int>` (or of a `List<float>`, a float); 0 for an empty one. Overflow panics, as `+` does.

```
assert [1, 2, 3].sum() == 6
let times = [1.5, 2.5, 2.0]
assert times.sum() / times.length().toFloat() == 2.0
```

### `push(T)`

Adds the item at the end. Needs `let mut`.

```
let mut xs = [1]
xs.push(2)
assert xs == [1, 2]
```

### `pop() -> T?`

Removes and gives the last item, or `none` if empty. Needs `let mut`.

```
let mut xs = [1, 2]
assert xs.pop() == 2
assert xs == [1]
```

Names from other languages:

- `forEach`: loop instead: `for x in xs { ... }`
- `reverse`: use `reversed()`: a copy, last item first
- `distinct`: use `unique()`: each item once, in order
- `dedupe`: use `unique()`: each item once, in order
- `intersection`: use `intersect(ys)`
- `difference`: keep the items the other lacks: `xs.filter((x) => !ys.contains(x))`

## Map\<K, V>

Keys to values, `["a": 1, "b": 2]` (`[:]` is empty), in insertion order. A value, like a list. `m[k]` is a `V?`; `m[k] = v` sets a key (with `let mut`; `m[k] += 1` is refused, as the key may be missing: `m[k] = (m[k] ?? 0) + 1`). `for (k, v) in m { ... }` loops.

### `length() -> int`

How many keys.

```
assert ["a": 1, "b": 2].length() == 2
```

### `isEmpty() -> bool`

Whether it has no keys.

```
let m: Map<string, int> = [:]
assert m.isEmpty()
```

### `has(K) -> bool`

Whether the key is in it.

```
assert ["a": 1].has("a")
assert !["a": 1].has("b")
```

### `keys() -> List<K>`

The keys, in insertion order.

```
assert ["b": 1, "a": 2].keys() == ["b", "a"]
```

### `values() -> List<V>`

The values, in insertion order.

```
assert ["b": 1, "a": 2].values() == [1, 2]
```

### `entries() -> List<(K, V)>`

Each key with its value, in insertion order.

```
assert ["a": 1].entries() == [("a", 1)]
```

### `remove(K) -> V?`

Removes the key and gives its value, or `none` if it wasn't there. Needs `let mut`.

```
let mut m = ["a": 1]
assert m.remove("a") == 1
assert m.isEmpty()
```

Names from other languages:

- `get`: look a key up by index, `m[key]`: it gives a `V?`
- `set`: assign by index: `m[key] = value`
- `put`: assign by index: `m[key] = value`
- `contains`: use `has`
- `containsKey`: use `has`
- `delete`: use `remove`
- `size`: use `length()`
- `count`: use `length()`
- `forEach`: loop instead: `for (k, v) in m { ... }`

## T?

A `T` or `none`. `x ?? fallback` gives the value or the fallback (it binds looser than other operators: `(x ?? 0) > 1`), and after `if x != none` (or `== none` with an early return) `x` is a `T`. `match x { none => ..., v => ... }` names it. `Show` when `T` is: `"${x}"` gives the value as `T` shows it, or `none`.

### `map(fn(T) -> U) -> U?`

The function applied to the value, or `none` without one. A function that gives a `U?` gives it as it is, so a chain of fields that may be missing reads `a.map((x) => x.b) ?? fallback`.

```
let n: int? = 4
assert n.map((x) => x * 2) == 8
let s: string? = none
assert s.map((x) => x.length()) == none
assert n.map((x) => if x > 5 { x } else { none }) == none
```

## Result\<T, E>

`Ok(value)` or `Err(error)`; `Result<void, E>` succeeds with `Ok()`. `r?` gives the value, or returns the error from the function (whose error type must be `E`: there is no automatic conversion). `match r { Ok(v) => ..., Err(e) => ... }` reads both. `Show` when `T` and `E` are: `Ok(3)`, `Err("bad")`, `Ok()`.

### `map(fn(T) -> U) -> Result<U, E>`

The same Result with its value turned into another; an `Err` is left as it is.

```
let r: Result<int, string> = Ok(2)
assert r.map((n) => n * 10) == Ok(20)
```

### `mapErr(fn(E) -> F) -> Result<T, F>`

The same Result with its error turned into another; an `Ok` is left as it is. Makes `?` fit: `sql.exec(...).mapErr(toAppError)?`.

```
let r: Result<int, string> = Err("x")
assert r.mapErr((e) => e.length()) == Err(1)
```

### `isOk() -> bool`

Whether it is an `Ok`. To use the value, `match` it or use `?`.

```
let r: Result<int, string> = Ok(2)
assert r.isOk()
```

### `isErr() -> bool`

Whether it is an `Err`: a test that something fails, whatever the message.

```
let r: Result<int, string> = Err("not a number")
assert r.isErr()
```

### `ok() -> T?`

The value, or `none` for an `Err`, whose error is dropped. `r.ok() ?? fallback` is the value or a fallback; `??` on the Result itself is refused, so dropping the error is written where it happens.

```
let r: Result<int, string> = Err("bad")
assert (r.ok() ?? 7) == 7
let s: Result<int, string> = Ok(2)
assert s.ok() == 2
```

## GoError

An error from Go, given by a binding (`extern`) whose Go function returns one.

### `message() -> string`

Go's `Error()` text.

### `is(GoError) -> bool`

Whether it is, or wraps, the other (Go's `errors.Is`).

## Exit

Built in, no import (#6a607d39): a struct `Exit { status: int, message: string }`. A `main` returning `Result<void, Exit>` ends on an `Err` with the message on stderr (a newline added) and that status, 0 to 125 (another exits 1 and says so). Any other error type from `main` exits 1. There is no `env.exit`. A module's own `Exit` type hides this one.

### `: int`

The exit status: 2 for a usage error, as Go's flag package gives, 0 for `-h`.

```
let e = Exit { status: 2, message: "usage: hey [options] <url>" }
assert e.status == 2
```

### `: string`

Printed on stderr before the program exits; nothing if empty.

```
let e: Result<void, Exit> = Err(Exit { status: 2, message: "missing <url>" })
assert e == Err(Exit { status: 2, message: "missing <url>" })
```

## io (effect)

Standard output and input. `uses io`. In a test block it records what is printed, and reads only what `setInput` gives it.

### `println(string)`

Prints the text and a newline.

```
io.println("hi")
assert io.output() == "hi\n"
```

### `print(string)`

Prints the text.

```
io.print("a")
io.print("b")
assert io.output() == "ab"
```

### `eprintln(string)`

Prints the text and a newline on standard error.

```
io.eprintln("oops")
assert io.errorOutput() == "oops\n"
assert io.output() == ""
```

### `eprint(string)`

Prints the text on standard error.

```
io.eprint("a")
assert io.errorOutput() == "a"
```

### `readLine() -> string?`

The next line of input without its line ending (`\n` or `\r\n`), or `none` at the end.

```
io.setInput("a\r\nb")
assert io.readLine() == "a"
assert io.readLine() == "b"
assert io.readLine() == none
```

### `readAll() -> string`

The rest of the input.

```
io.setInput("x\ny\n")
assert io.readLine() == "x"
assert io.readAll() == "y\n"
```

In a test block only:

### `output() -> string`

Everything printed since the test started: each call gives all of it again, not what is new since the last.

```
io.println("a")
assert io.output() == "a\n"
io.println("b")
assert io.output() == "a\nb\n"
```

### `errorOutput() -> string`

Everything printed on standard error since the test started.

```
assert io.errorOutput() == ""
```

### `setInput(string)`

Sets the input still to read.

```
io.setInput("hi\n")
assert io.readAll() == "hi\n"
```

## clock (effect)

Time in milliseconds since the Unix epoch. `uses clock`. In a test block time is virtual: it starts at 0 and moves when told to, or when every task sleeps.

### `now() -> int`

The time now.

```
assert clock.now() == 0
```

### `sleep(int)`

Waits that many milliseconds (cancellable).

```
clock.sleep(250)
assert clock.now() == 250
```

### `nanos() -> int`

A count of nanoseconds that only goes up, for timing: `clock.nanos() - start` is how long something took, finer than `now`. Not a time of day. In a test, the virtual time × 1,000,000.

```
clock.advance(2)
assert clock.nanos() == 2000000
```

In a test block only:

### `set(int)`

Sets the virtual time.

```
clock.set(1000)
assert clock.now() == 1000
```

### `advance(int)`

Moves the virtual time on.

```
clock.advance(5)
assert clock.now() == 5
```

## env (effect)

The process environment, read only but for `env.load`. `uses env`. In a test block it starts empty.

### `get(string) -> string?`

The variable's value, or `none` if unset.

```
assert env.get("PORT") == none
```

### `args() -> List<string>`

The program's arguments, without its name (`candor run f.candor -- a b`).

```
assert env.args() == []
```

### `pid() -> int`

This process's id (1 when it runs first in a container). In a test, 1000 until `env.setPid`.

```
assert env.pid() == 1000
```

### `zone() -> time.Zone`

The zone the program runs in: `$TZ`'s, else the machine's, else UTC. On a machine whose zone has no database name (Windows) it is named "Local" and keeps the machine's rules. Needs `import "time"`. In a test, UTC until `env.setZone`.

```
assert time.zoneName(env.zone()) == "UTC"
```

### `load(string) -> Result<void, fs.FsError>`

Reads a .env file: `KEY=value` lines, `#` comments, values bare or quoted. A variable already set keeps its value, so the real environment wins. Needs `import "fs"` and `uses env, fs`; in a test it reads the memory file system into the fake.

```
assert fs.write(".env", "PORT=8080\nNAME=\"my app\" # quoted\n") == Ok()
env.set("PORT", "9000")
assert env.load(".env") == Ok()
assert env.get("NAME") == "my app"
assert env.get("PORT") == "9000"
```

### `signals(Scope, List<Signal>) -> Channel<Signal>`

A channel that gets each of those signals the process is sent, until the scope ends; then they do what they did before (Ctrl-C ends the program). `Signal` is built in: `.Interrupt` (Ctrl-C), `.Terminate`, `.Hangup`, `.User1`, `.User2`. On Windows only `.Interrupt` and `.Terminate` (a console closing) come. Up to 8 wait unread; more are dropped. Receive in a `s.background` task to act on one while the work goes on. `http.serve` handles its own.

```
let got = tasks.scope((s) => {
  let sigs = env.signals(s, [.Interrupt, .Terminate])
  env.sendSignal(.Terminate)
  return sigs.recv()
})
assert got == .Terminate
```

In a test block only:

### `set(string, string)`

Sets a variable.

```
env.set("PORT", "8080")
assert env.get("PORT") == "8080"
```

### `setArgs(List<string>)`

Sets the arguments.

```
env.setArgs(["-v"])
assert env.args() == ["-v"]
```

### `setPid(int)`

Sets the pid `env.pid()` gives.

```
env.setPid(1)
assert env.pid() == 1
```

### `setZone(time.Zone)`

Sets the zone `env.zone()` gives.

```
env.setZone(time.zone("Europe/Oslo") ?? time.utcZone())
assert time.zoneName(env.zone()) == "Europe/Oslo"
```

### `sendSignal(Signal)`

Sends a signal as if the process were sent it: each `env.signals` channel asking for it gets it.

```
tasks.scope((s) => {
  let sigs = env.signals(s, [.Hangup])
  env.sendSignal(.Interrupt)
  env.sendSignal(.Hangup)
  assert sigs.recv() == .Hangup
})
```

## random (effect)

Random numbers, ids and tokens, from the operating system's secure source (Go's `crypto/rand`), so a token can be a secret. `uses random`. In a test block the values come from a fixed seed: the same in every run, and `random.seed(n)` picks another sequence.

### `int(int, int) -> int`

A number from the first to the second, both included. Panics if the first is larger.

```
let die = random.int(1, 6)
assert die >= 1 && die <= 6
```

### `uuid() -> string`

A version 7 UUID: the time in milliseconds, then random bits, so ids made later sort later. In a test the time is the virtual clock's.

```
let id = random.uuid()
assert id.length() == 36
assert id.slice(14, 15) == "7"
```

### `uuid4() -> string`

A version 4 UUID: random bits only, so no part of it repeats between ids made together, and they don't sort by time. For ids that must not hint at when they were made.

```
let id = random.uuid4()
assert id.length() == 36
assert id.slice(14, 15) == "4"
assert id != random.uuid4()
```

### `token(int) -> string`

That many random bytes, as hex (twice as many characters): `random.token(32)` for a session token.

```
assert random.token(16).length() == 32
```

### `bytes(int) -> Bytes`

That many random bytes: a salt, a nonce, a key. Panics on a negative count.

```
let salt = random.bytes(16)
assert salt.length() == 16
assert salt != random.bytes(16)
```

### `shuffle(List<T>) -> List<T>`

The items in a random order.

```
assert random.shuffle([1, 2, 3]).sorted() == [1, 2, 3]
```

### `pick(List<T>) -> T?`

One of the items, or `none` from an empty list.

```
assert random.pick(["a"]) == "a"
let none_: List<int> = []
assert random.pick(none_) == none
```

In a test block only:

### `seed(int)`

Starts the values over from another seed.

```
random.seed(7)
let a = random.int(1, 100)
random.seed(7)
assert random.int(1, 100) == a
```

## tasks (effect)

Structured concurrency. `uses tasks`. Every task belongs to a scope and ends before it. Each takes on the effects of the functions it runs. Where a function returns a Result, the first `Err` cancels the others and becomes the result. In a test block tasks run one at a time, in an order picked by a seed, and a test whose order matters runs in 100 orders (`--runs N`), half of them PCT (random priorities with a few change points, which find races needing particular preemptions); a failure prints its seed, and `--seed` replays it.

### `scope(fn(Scope) -> T) -> T`

Runs the function with a Scope to spawn tasks in, and waits for all of them before giving its result.

```
let n = tasks.scope((s) => {
  let a = s.spawn(() => 20)
  let b = s.spawn(() => 22)
  return a.join() + b.join()
})
assert n == 42
```

### `all(List<T>, fn(T) -> U) -> List<U>`

The function run on each item at once, the results in the items' order.

```
assert tasks.all([1, 2, 3], (x) => x * 2) == [2, 4, 6]
```

### `both(fn() -> A, fn() -> B) -> (A, B)`

Both functions at once; both results.

```
assert tasks.both(() => 1, () => "a") == (1, "a")
```

### `race(List<fn() -> T>) -> T`

The functions at once; the first to finish wins and the others are cancelled. For a `Result`, an `Err` doesn't win: the race waits for the first `Ok`, and gives the last `Err` only when every function fails. So a race stays alive while one function hasn't finished.

```
let winner = tasks.race([() => {
  clock.sleep(50)
  return "slow"
}, () => "fast"])
assert winner == "fast"
```

### `timeout(int, fn() -> T) -> T?`

The function's result, or `none` if it takes longer than the milliseconds given (it is cancelled). For a function returning nothing, a `bool`: whether it finished.

```
assert tasks.timeout(100, () => 1) == 1
let late = tasks.timeout(10, () => {
  clock.sleep(50)
  return 2
})
assert late == none
```

### `select(List<Arm<T>>) -> T`

Waits until one of the arms is ready, runs its function and gives what it returned. Arms: `ch.onRecv`, `ch.onSend`, `tasks.after`, `tasks.otherwise`.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  ch.send(7)
  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.after(100, () => -1)])
  assert got == 7
})
```

### `after(int, fn() -> T) -> Arm<T>`

An arm ready once the milliseconds have passed.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.after(100, () => -1)])
  assert got == -1
})
```

### `otherwise(fn() -> T) -> Arm<T>`

An arm taken at once when no other is ready: `select` then doesn't wait.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  let got = tasks.select([ch.onRecv((v) => v ?? 0), tasks.otherwise(() => 0)])
  assert got == 0
})
```

## Scope

Given by `tasks.scope`. Tasks and shared values made with it end, or are dropped, when it does. Its methods need no `uses`: having the scope is enough.

### `spawn(fn() -> T) -> Task<T>`

Starts the function as a task. If it returns a Result, its `Err` cancels the scope, and the scope's function must return a Result with the same error.

```
let n = tasks.scope((s) => {
  let t = s.spawn(() => 2)
  return t.join()
})
assert n == 2
```

### `background(fn() -> T)`

Starts the function as a task that runs until the scope's own function has returned and its other tasks have ended, then is cancelled; the scope still waits for it to stop, its `defer`s included. For a server, a watcher or a library's manager loop beside the work. Its `Err` cancels the scope, as for `spawn`. `wait` doesn't wait for it.

```
let ticks = tasks.scope((s) => {
  let n = s.atomic(0)
  s.background(() => {
    while true {
      clock.sleep(10)
      n.add(1)
    }
  })
  clock.sleep(35)
  return n.get()
})
assert ticks == 3
```

### `mutex(T) -> Mutex<T>`

A value tasks share, changed only through functions run under its lock.

```
let n = tasks.scope((s) => {
  let m = s.mutex(0)
  tasks.all([1, 2, 3], (x) => m.update((v) => v + x))
  return m.get()
})
assert n == 6
```

### `atomic(T) -> Atomic<T>`

An int or a bool tasks share, changed in one step.

```
let n = tasks.scope((s) => {
  let a = s.atomic(0)
  tasks.all([1, 2, 3], (x) => a.add(x))
  return a.get()
})
assert n == 6
```

### `lock() -> Lock`

A lock for work that uses effects, such as a file's read-change-write: its `hold` functions run one at a time.

```
let n = tasks.scope((s) => {
  let lock = s.lock()
  let count = s.atomic(0)
  tasks.all([1, 2, 3], (x) => lock.hold(() => count.add(x)))
  return count.get()
})
assert n == 6
```

### `channel(int) -> Channel<T>`

A queue between tasks holding up to that many items. What it carries comes from where it goes: `let ch: Channel<int> = s.channel(8)`.

```
tasks.scope((s) => {
  let ch: Channel<string> = s.channel(2)
  ch.send("a")
  assert ch.recv() == "a"
})
```

### `wait()`

Waits for the tasks spawned so far, before the scope ends.

```
let n = tasks.scope((s) => {
  let a = s.atomic(0)
  s.spawn(() => a.add(1))
  s.wait()
  return a.get()
})
assert n == 1
```

## Task\<T>

A running task, from `s.spawn`.

### `join() -> T`

Waits for the task and gives its result.

```
let n = tasks.scope((s) => s.spawn(() => 5).join())
assert n == 5
```

## Mutex\<T>

From `s.mutex(v)`. Changed only by function, so no update is lost; those functions can't use effects, so the lock is never held long. State checked and changed together lives in one Mutex, with the check inside `updateWith`.

### `get() -> T`

The value now.

```
tasks.scope((s) => {
  let m = s.mutex("a")
  assert m.get() == "a"
})
```

### `update(fn(T) -> T) -> T`

Replaces the value with what the function makes of it, and gives the new value.

```
tasks.scope((s) => {
  let m = s.mutex(1)
  assert m.update((v) => v + 1) == 2
})
```

### `updateWith(fn(T) -> (T, R)) -> R`

As `update`, but the function also gives a result: `(new value, result)`.

```
tasks.scope((s) => {
  let m = s.mutex(1)
  assert m.updateWith((n) => (n + 1, n * 10)) == 10
  assert m.get() == 2
})
```

## Lock

From `s.lock()`. Holds no value: it makes what its `hold` functions do happen one task at a time, effects included, where a Mutex's functions only compute. A task holds one Lock at a time: a `hold` inside a `hold` panics, so two Locks can't deadlock. What is changed together goes under one Lock.

### `hold(fn() -> R) -> R`

Waits until no other task holds the lock, runs the function and gives its result. The lock is let go however the function ends: a return, a panic, a cancel.

```
tasks.scope((s) => {
  let lock = s.lock()
  assert lock.hold(() => 1 + 1) == 2
})
```

## Atomic\<T>

From `s.atomic(v)`: an int or a bool.

### `get() -> T`

The value now.

```
tasks.scope((s) => {
  let a = s.atomic(true)
  assert a.get()
})
```

### `set(T)`

Sets the value.

```
tasks.scope((s) => {
  let a = s.atomic(1)
  a.set(5)
  assert a.get() == 5
})
```

### `add(int) -> int`

Adds to the value and gives the new one. Ints only.

```
tasks.scope((s) => {
  let a = s.atomic(1)
  assert a.add(2) == 3
})
```

### `compareAndSet(T, T) -> bool`

Sets it to the second value if it is the first; whether it did.

```
tasks.scope((s) => {
  let a = s.atomic(1)
  assert a.compareAndSet(1, 2)
  assert !a.compareAndSet(1, 3)
  assert a.get() == 2
})
```

## Channel\<T>

From `s.channel(n)`: a queue of up to `n` items between tasks.

### `send(T)`

Adds an item, waiting while the channel is full. Sending on a closed channel panics.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  ch.send(1)
  assert ch.recv() == 1
})
```

### `recv() -> T?`

Takes the next item, waiting while there is none; `none` once the channel is closed and empty.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  ch.close()
  assert ch.recv() == none
})
```

### `close()`

No more items will come: receivers get `none` once it is empty.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(2)
  ch.send(1)
  ch.close()
  assert ch.recv() == 1
  assert ch.recv() == none
})
```

### `onRecv(fn(T?) -> R) -> Arm<R>`

An arm for `tasks.select`, ready when an item (or the close, as `none`) can be taken; the function gets it.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  ch.send(3)
  assert tasks.select([ch.onRecv((v) => v ?? 0)]) == 3
})
```

### `onSend(T, fn() -> R) -> Arm<R>`

An arm for `tasks.select`, ready when the item can be sent; it is sent, then the function runs.

```
tasks.scope((s) => {
  let ch: Channel<int> = s.channel(1)
  assert tasks.select([ch.onSend(4, () => "sent"), tasks.otherwise(() => "full")]) == "sent"
  assert ch.recv() == 4
})
```
