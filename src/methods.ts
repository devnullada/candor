import { T, fn, type FnType, type Type } from './types';

/** A method on a built-in type, like `n.toString()`. It must be called; it is not a value. */
export interface MethodDef {
  type: FnType;
  /** Go packages the expression needs. */
  imports: string[];
  /**
   * Builds the Go expression from the receiver and arguments, already emitted. For a method that
   * returns a `T?`, the expression is Go's `(value, ok)` pair; the emitter builds the optional.
   */
  go: (receiver: string, args: string[]) => string;
}

const option = (inner: Type): Type => ({ kind: 'option', inner });
const strings: Type = { kind: 'list', elem: T.string };
const chars: Type = { kind: 'list', elem: T.char };
const ints: Type = { kind: 'list', elem: T.int };

const intMethods = new Map<string, MethodDef>([
  ['toString', { type: fn([], T.string), imports: ['strconv'], go: (r) => `strconv.FormatInt(${r}, 10)` }],
  // Functions, not Go's operators: on constants Go would refuse the overflow at compile time.
  ['toChar', { type: fn([], option(T.char)), imports: [], go: (r) => `candor.ToChar(${r})` }],
  ['toFloat', { type: fn([], T.float), imports: [], go: (r) => `float64(${r})` }],
  ['wrappingAdd', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `candor.WrappingAdd(${r}, ${b})` }],
  ['wrappingSub', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `candor.WrappingSub(${r}, ${b})` }],
  ['wrappingMul', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `candor.WrappingMul(${r}, ${b})` }],
  ['checkedAdd', { type: fn([T.int], option(T.int)), imports: [], go: (r, [b]) => `candor.CheckedAdd(${r}, ${b})` }],
  ['checkedSub', { type: fn([T.int], option(T.int)), imports: [], go: (r, [b]) => `candor.CheckedSub(${r}, ${b})` }],
  ['checkedMul', { type: fn([T.int], option(T.int)), imports: [], go: (r, [b]) => `candor.CheckedMul(${r}, ${b})` }],
  ['checkedDiv', { type: fn([T.int], option(T.int)), imports: [], go: (r, [b]) => `candor.CheckedDiv(${r}, ${b})` }],
  // Typed: Go would make `candor.Min(3, 5)` an int, not an int64.
  ['min', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `candor.Min[int64](${r}, ${b})` }],
  ['max', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `candor.Max[int64](${r}, ${b})` }],
  ['abs', { type: fn([], T.int), imports: [], go: (r) => `candor.AbsInt(${r})` }],
  ['pow', { type: fn([T.int], T.int), imports: [], go: (r, [k]) => `candor.PowInt(${r}, ${k})` }],
  // Bits, as methods: no operators to learn the precedence of.
  ['and', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `int64(${r} & ${b})` }],
  ['or', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `int64(${r} | ${b})` }],
  ['xor', { type: fn([T.int], T.int), imports: [], go: (r, [b]) => `int64(${r} ^ ${b})` }],
  ['not', { type: fn([], T.int), imports: [], go: (r) => `int64(^${r})` }],
  ['shl', { type: fn([T.int], T.int), imports: [], go: (r, [k]) => `candor.Shl(${r}, ${k})` }],
  ['shr', { type: fn([T.int], T.int), imports: [], go: (r, [k]) => `candor.Shr(${r}, ${k})` }],
  ['ushr', { type: fn([T.int], T.int), imports: [], go: (r, [k]) => `candor.Ushr(${r}, ${k})` }],
]);

// 64-bit, never NaN or infinite. Whole-number conversions give an int and panic out of its range.
const floatMethods = new Map<string, MethodDef>([
  ['toString', { type: fn([], T.string), imports: [], go: (r) => `candor.FloatString(${r})` }],
  ['toFixed', { type: fn([T.int], T.string), imports: [], go: (r, [n]) => `candor.ToFixed(${r}, ${n})` }],
  ['round', { type: fn([], T.int), imports: [], go: (r) => `candor.Round(${r})` }],
  ['floor', { type: fn([], T.int), imports: [], go: (r) => `candor.Floor(${r})` }],
  ['ceil', { type: fn([], T.int), imports: [], go: (r) => `candor.Ceil(${r})` }],
  ['truncate', { type: fn([], T.int), imports: [], go: (r) => `candor.Truncate(${r})` }],
  ['abs', { type: fn([], T.float), imports: ['math'], go: (r) => `math.Abs(${r})` }],
  ['sqrt', { type: fn([], T.float), imports: [], go: (r) => `candor.Sqrt(${r})` }],
  ['pow', { type: fn([T.float], T.float), imports: [], go: (r, [y]) => `candor.Pow(${r}, ${y})` }],
  ['min', { type: fn([T.float], T.float), imports: [], go: (r, [b]) => `candor.Min[float64](${r}, ${b})` }],
  ['max', { type: fn([T.float], T.float), imports: [], go: (r, [b]) => `candor.Max[float64](${r}, ${b})` }],
]);

// One code point. `isDigit` is ASCII 0-9 only; `isLetter` and `isWhitespace` follow Unicode.
const charMethods = new Map<string, MethodDef>([
  ['toString', { type: fn([], T.string), imports: [], go: (r) => `string(${r})` }],
  ['code', { type: fn([], T.int), imports: [], go: (r) => `int64(${r})` }],
  ['isDigit', { type: fn([], T.bool), imports: [], go: (r) => `candor.IsDigit(${r})` }],
  ['isLetter', { type: fn([], T.bool), imports: ['unicode'], go: (r) => `unicode.IsLetter(${r})` }],
  ['isWhitespace', { type: fn([], T.bool), imports: ['unicode'], go: (r) => `unicode.IsSpace(${r})` }],
  ['toUpperCase', { type: fn([], T.char), imports: ['unicode'], go: (r) => `unicode.ToUpper(${r})` }],
  ['toLowerCase', { type: fn([], T.char), imports: ['unicode'], go: (r) => `unicode.ToLower(${r})` }],
]);

const boolMethods = new Map<string, MethodDef>([
  ['toString', { type: fn([], T.string), imports: ['strconv'], go: (r) => `strconv.FormatBool(${r})` }],
]);

// Strings are UTF-8, as in Go. `length`, `chars`, `indexOf` and `slice` count code points, as
// Python's `len` does; Go counts bytes (`byteLength` here), TypeScript UTF-16 units. Nothing
// counts grapheme clusters. There is no `s[i]`: `chars()` is the list to index, of `char`s.
const stringMethods = new Map<string, MethodDef>([
  ['length', { type: fn([], T.int), imports: ['unicode/utf8'], go: (r) => `int64(utf8.RuneCountInString(${r}))` }],
  ['byteLength', { type: fn([], T.int), imports: [], go: (r) => `int64(len(${r}))` }],
  ['isEmpty', { type: fn([], T.bool), imports: [], go: (r) => `(${r} == "")` }],
  ['chars', { type: fn([], chars), imports: [], go: (r) => `[]rune(${r})` }],
  ['contains', { type: fn([T.string], T.bool), imports: ['strings'], go: (r, [sub]) => `strings.Contains(${r}, ${sub})` }],
  ['startsWith', { type: fn([T.string], T.bool), imports: ['strings'], go: (r, [p]) => `strings.HasPrefix(${r}, ${p})` }],
  ['endsWith', { type: fn([T.string], T.bool), imports: ['strings'], go: (r, [p]) => `strings.HasSuffix(${r}, ${p})` }],
  ['indexOf', { type: fn([T.string], option(T.int)), imports: [], go: (r, [sub]) => `candor.IndexOf(${r}, ${sub})` }],
  ['lastIndexOf', { type: fn([T.string], option(T.int)), imports: [], go: (r, [sub]) => `candor.LastIndexOf(${r}, ${sub})` }],
  ['slice', { type: fn([T.int, T.int], T.string), imports: [], go: (r, [a, b]) => `candor.Slice(${r}, ${a}, ${b})` }],
  ['split', { type: fn([T.string], strings), imports: ['strings'], go: (r, [sep]) => `strings.Split(${r}, ${sep})` }],
  ['trim', { type: fn([], T.string), imports: ['strings'], go: (r) => `strings.TrimSpace(${r})` }],
  ['trimStart', { type: fn([], T.string), imports: ['strings', 'unicode'], go: (r) => `strings.TrimLeftFunc(${r}, unicode.IsSpace)` }],
  ['trimEnd', { type: fn([], T.string), imports: ['strings', 'unicode'], go: (r) => `strings.TrimRightFunc(${r}, unicode.IsSpace)` }],
  // #c9d1ab04: any of the characters in the set, from both ends (Go's `strings.Trim`).
  ['trimChars', { type: fn([T.string], T.string), imports: ['strings'], go: (r, [set]) => `strings.Trim(${r}, ${set})` }],
  ['removePrefix', { type: fn([T.string], T.string), imports: ['strings'], go: (r, [p]) => `strings.TrimPrefix(${r}, ${p})` }],
  ['removeSuffix', { type: fn([T.string], T.string), imports: ['strings'], go: (r, [p]) => `strings.TrimSuffix(${r}, ${p})` }],
  ['toUpperCase', { type: fn([], T.string), imports: ['strings'], go: (r) => `strings.ToUpper(${r})` }],
  ['toLowerCase', { type: fn([], T.string), imports: ['strings'], go: (r) => `strings.ToLower(${r})` }],
  ['replaceAll', { type: fn([T.string, T.string], T.string), imports: ['strings'], go: (r, [old, by]) => `strings.ReplaceAll(${r}, ${old}, ${by})` }],
  ['repeat', { type: fn([T.int], T.string), imports: [], go: (r, [n]) => `candor.Repeat(${r}, ${n})` }],
  ['toInt', { type: fn([], option(T.int)), imports: [], go: (r) => `candor.ParseInt(${r})` }],
  ['toFloat', { type: fn([], option(T.float)), imports: [], go: (r) => `candor.ParseFloat(${r})` }],
  ['lines', { type: fn([], strings), imports: [], go: (r) => `candor.Lines(${r})` }],
  ['padStart', { type: fn([T.int, T.string], T.string), imports: [], go: (r, [n, fill]) => `candor.PadStart(${r}, ${n}, ${fill})` }],
  ['padEnd', { type: fn([T.int, T.string], T.string), imports: [], go: (r, [n, fill]) => `candor.PadEnd(${r}, ${n}, ${fill})` }],
  ['toBytes', { type: fn([], T.bytes), imports: [], go: (r) => `[]byte(${r})` }],
  // #c9d1ab04: Go's `%q`, for logs that show a value exactly.
  ['quoted', { type: fn([], T.string), imports: ['strconv'], go: (r) => `strconv.Quote(${r})` }],
]);

// Bytes are never changed once made, like strings; a byte is an `int` 0 to 255. `slice` clamps
// like a string's. `std/bytes` makes them from a list, hex or base64.
const bytesMethods = new Map<string, MethodDef>([
  ['length', { type: fn([], T.int), imports: [], go: (r) => `int64(len(${r}))` }],
  ['isEmpty', { type: fn([], T.bool), imports: [], go: (r) => `(len(${r}) == 0)` }],
  ['at', { type: fn([T.int], option(T.int)), imports: [], go: (r, [i]) => `candor.ByteAt(${r}, ${i})` }],
  ['slice', { type: fn([T.int, T.int], T.bytes), imports: [], go: (r, [a, b]) => `candor.SliceBytes(${r}, ${a}, ${b})` }],
  ['concat', { type: fn([T.bytes], T.bytes), imports: [], go: (r, [b]) => `candor.ConcatBytes(${r}, ${b})` }],
  ['indexOf', { type: fn([T.bytes], option(T.int)), imports: [], go: (r, [sub]) => `candor.IndexBytes(${r}, ${sub})` }],
  ['lastIndexOf', { type: fn([T.bytes], option(T.int)), imports: [], go: (r, [sub]) => `candor.LastIndexBytes(${r}, ${sub})` }],
  ['toList', { type: fn([], ints), imports: [], go: (r) => `candor.BytesToList(${r})` }],
  ['toText', { type: fn([], option(T.string)), imports: [], go: (r) => `candor.BytesText(${r})` }],
  ['toRawText', { type: fn([], T.string), imports: [], go: (r) => `string(${r})` }],
  ['toHex', { type: fn([], T.string), imports: [], go: (r) => `candor.BytesHex(${r})` }],
  ['toBase64', { type: fn([], T.string), imports: [], go: (r) => `candor.BytesBase64(${r})` }],
]);

/** Names other languages give byte methods, and what Candor does instead. */
export const bytesMisnamed = new Map([
  ['len', 'use `length()`'],
  ['size', 'use `length()`'],
  ['get', 'use `at(i)`: an `int?`, `none` out of range'],
  ['toString', 'use `toText()` (a `string?`, `none` unless the bytes are UTF-8), or `toHex()`'],
  ['decode', 'use `toText()`: a `string?`, `none` unless the bytes are UTF-8'],
  ['append', 'use `concat(other)`: Bytes are never changed, so it gives new ones'],
  ['push', 'use `concat(other)`: Bytes are never changed, so it gives new ones'],
  ['subarray', 'use `slice(start, end)`, or `slice(start)` to the end: `end` excluded, both clamped'],
  ['equals', 'use `==`'],
]);

/** #a64e87fe: a char's number is `code()`; from a number back, `toChar()` is an optional. */
const charToNumber = "use `code()`: the character's number (`'a'.code()` is 97); a digit's value is `c.toString().toInt()`, an `int?`";
export const charMisnamed = new Map([
  ['toInt', charToNumber],
  ['ord', charToNumber],
  ['charCode', charToNumber],
  ['codePoint', charToNumber],
  ['value', charToNumber],
]);

/** Names other languages give string methods, and what Candor does instead. */
export const stringMisnamed = new Map([
  ['includes', 'use `contains`'],
  ['has', 'use `contains`'],
  ['find', 'use `indexOf`: an `int?`, `none` when absent'],
  ['search', 'use `indexOf`: an `int?`, `none` when absent'],
  ['rfind', 'use `lastIndexOf`: an `int?`, `none` when absent'],
  ['rindex', 'use `lastIndexOf`: an `int?`, `none` when absent'],
  ['toUpper', 'use `toUpperCase()`'],
  ['upper', 'use `toUpperCase()`'],
  ['toLower', 'use `toLowerCase()`'],
  ['lower', 'use `toLowerCase()`'],
  ['strip', 'use `trim()`'],
  ['lstrip', 'use `trimStart()`'],
  ['rstrip', 'use `trimEnd()`'],
  ['trimLeft', 'use `trimStart()`'],
  ['trimRight', 'use `trimEnd()`'],
  ['stripPrefix', 'use `removePrefix(p)`: the string without `p` at the start, unchanged if absent'],
  ['stripSuffix', 'use `removeSuffix(s)`: the string without `s` at the end, unchanged if absent'],
  ['removeprefix', 'use `removePrefix(p)`'],
  ['removesuffix', 'use `removeSuffix(s)`'],
  ['reverse', 'use `chars().reversed()`, and `join("")` for a string'],
  ['reversed', 'use `chars().reversed()`, and `join("")` for a string'],
  ['replace', 'use `replaceAll(old, new)`: it replaces every occurrence, and says so'],
  ['substring', 'use `slice(start, end)`, or `slice(start)` to the end: code point indexes, `end` excluded, both clamped to the string'],
  ['substr', 'use `slice(start, end)`, or `slice(start)` to the end: code point indexes, `end` excluded, both clamped to the string'],
  ['charAt', 'index the code points: `s.chars()[i]` is a `char?`'],
  ['len', 'use `length()`: it counts code points; `byteLength()` counts bytes'],
  ['size', 'use `length()`: it counts code points; `byteLength()` counts bytes'],
  ['count', 'use `length()`: it counts code points; `byteLength()` counts bytes'],
  ['parseInt', 'use `toInt()`: an `int?`, `none` unless the whole string is a decimal int'],
  ['toNumber', 'use `toInt()` (an `int?`) or `toFloat()` (a `float?`)'],
  ['parseFloat', 'use `toFloat()`: a `float?`, `none` unless the whole string is a decimal number'],
  ['toString', 'it is a string already'],
  ['join', '`join` is a method of `List<string>`: `parts.join(", ")`'],
  ['concat', 'use `+`'],
  ['equals', 'use `==`'],
  ['padLeft', 'use `padStart(n, fill)`'],
  ['padRight', 'use `padEnd(n, fill)`'],
  ['ljust', 'use `padEnd(n, fill)`'],
  ['rjust', 'use `padStart(n, fill)`'],
  ['splitLines', 'use `lines()`'],
  ['isBlank', 'use `trim().isEmpty()`'],
]);

/** Names other languages use for map methods, and what Candor does instead. */
export const mapMisnamed = new Map([
  ['get', 'look a key up by index, `m[key]`: it gives a `V?`'],
  ['set', 'assign by index: `m[key] = value`'],
  ['put', 'assign by index: `m[key] = value`'],
  ['contains', 'use `has`'],
  ['containsKey', 'use `has`'],
  ['delete', 'use `remove`'],
  ['size', 'use `length()`'],
  ['count', 'use `length()`'],
  ['forEach', 'loop instead: `for (k, v) in m { ... }`'],
]);

// Go's own error, opaque: its message, and whether it is (or wraps) a known one, like `strconv.errRange`.
const goErrorMethods = new Map<string, MethodDef>([
  ['message', { type: fn([], T.string), imports: [], go: (r) => `${r}.Err.Error()` }],
  ['is', { type: fn([T.goerror], T.bool), imports: ['errors'], go: (r, [target]) => `errors.Is(${r}.Err, ${target}.Err)` }],
]);

const none = new Map<string, MethodDef>();

/** `s.slice(start)`: to the end, as TypeScript and Python have it. The end is clamped anyway. */
export function sliceToEnd(t: Type): MethodDef | undefined {
  if (t.kind === 'string') return { type: fn([T.int], T.string), imports: ['math'], go: (r, [a]) => `candor.Slice(${r}, ${a}, math.MaxInt64)` };
  if (t.kind === 'bytes') return { type: fn([T.int], T.bytes), imports: ['math'], go: (r, [a]) => `candor.SliceBytes(${r}, ${a}, math.MaxInt64)` };
  return undefined;
}

export function primitiveMethods(t: Type): Map<string, MethodDef> {
  switch (t.kind) {
    case 'int':
      return intMethods;
    case 'bool':
      return boolMethods;
    case 'char':
      return charMethods;
    case 'float':
      return floatMethods;
    case 'string':
      return stringMethods;
    case 'bytes':
      return bytesMethods;
    case 'goerror':
      return goErrorMethods;
    default:
      return none;
  }
}

/** For a name that is no method of `t`: the Candor way, when the name is usual elsewhere. */
export function primitiveMisnamed(t: Type, name: string): string | undefined {
  return t.kind === 'string' ? stringMisnamed.get(name) : t.kind === 'bytes' ? bytesMisnamed.get(name) : t.kind === 'char' ? charMisnamed.get(name) : undefined;
}
