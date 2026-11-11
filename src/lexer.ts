import { CandorError, Codes, type Diagnostic, type Pos, type Span } from './diagnostics';

export type TokenKind = 'ident' | 'keyword' | 'string' | 'template' | 'int' | 'float' | 'char' | 'punct' | 'newline' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text, except for strings and chars (the decoded value) and numbers (digit separators dropped). */
  text: string;
  span: Span;
  /**
   * A `template` (a string with `${ }` in it): decoded text and the tokens of each `${ }`, which
   * end in an `eof` at its `}`. Text and token lists alternate, starting and ending with text.
   */
  parts?: (string | Token[])[];
  /** The `//` lines directly above, when the token starts its line: a struct's or field's help. */
  doc?: string;
}

export const keywords = new Set([
  'module', 'fn', 'uses', 'let', 'return', 'true', 'false', 'if', 'else', 'match', 'struct', 'enum',
  'none', 'assert', 'mut', 'for', 'in', 'while', 'break', 'continue', 'defer',
]);

// Longest first, so `->` is never read as `-` `>`. `===` and `!==` are lexed only so the
// parser can say they don't exist.
// `..` is lexed only so patterns can say it doesn't exist.
const puncts = [
  '===', '!==', '...', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '..',
  '+=', '-=', '*=', '/=', '%=', '++', '--',
  '(', ')', '{', '}', '[', ']', ',', '.', ':', '=', '+', '-', '*', '/', '%', '<', '>', '!', '?', '|',
];

// A line ending in one of these continues on the next: `let x = a +` newline `b`.
// Not `?`: `let x = f()?` ends its line.
const continuesLine = new Set([
  '===', '!==', '...', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '..',
  '+=', '-=', '*=', '/=', '%=',
  ',', '.', ':', '=', '+', '-', '*', '/', '%', '<', '>', '!', '|',
]);

const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', $: '$' };

const isIdentStart = (c: string) => /^[A-Za-z_]$/.test(c);
const isIdentPart = (c: string) => /^[A-Za-z0-9_]$/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Errors don't stop the lexer: each is reported and the bad stretch skipped or kept, so the parser
 * still sees the rest. Without `diagnostics`, they are thrown together at the end. `firstLine`:
 * a module's test file counts its lines on from the module's own.
 */
export function lex(source: string, file: string, diagnostics?: Diagnostic[], firstLine = 1): Token[] {
  const found: Diagnostic[] = diagnostics ?? [];
  // Both are swapped out while lexing the inside of a `${ }`.
  let tokens: Token[] = [];
  // Open brackets. A newline ends a statement at top level and directly inside `{ }`;
  // inside `( )` and `[ ]` it is whitespace, so calls and parameter lists can span lines.
  let nesting: string[] = [];
  // The indent of the line each of them opened on, and of the line being read.
  let indents: number[] = [];
  let indent = 0;
  let i = 0;
  let line = firstLine;
  let col = 1;
  let badRun: { diag: Diagnostic; from: number } | null = null;

  const pos = (): Pos => ({ line, col });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  const last = () => tokens[tokens.length - 1];
  // Comment lines on their own, directly above the line being read.
  let doc: { lines: string[]; end: number } | null = null;
  const push = (kind: TokenKind, text: string, start: Pos) => {
    const t: Token = { kind, text, span: { start, end: pos() } };
    if (kind !== 'newline') {
      if (doc && doc.end === start.line - 1) t.doc = doc.lines.join('\n');
      doc = null;
    }
    tokens.push(t);
  };
  const fail = (message: string, start: Pos, help?: string) => {
    found.push({ code: Codes.SyntaxError, severity: 'error', message, file, span: { start, end: pos() }, ...(help ? { help } : {}) });
  };

  /** Pushes a `string`, or a `template` when `parts` (text and `${ }` tokens) holds any tokens. */
  const pushString = (parts: (string | Token[])[], start: Pos, startIndex: number) => {
    const merged: (string | Token[])[] = [''];
    for (const p of parts) {
      if (typeof p === 'string' && typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] += p;
      else if (typeof p === 'string') merged.push(p);
      else {
        if (typeof merged[merged.length - 1] !== 'string') merged.push('');
        merged.push(p);
      }
    }
    if (typeof merged[merged.length - 1] !== 'string') merged.push('');
    if (merged.length === 1) push('string', merged[0] as string, start);
    else tokens.push({ kind: 'template', text: source.slice(startIndex, i), parts: merged, span: { start, end: pos() } });
  };

  /** An escape, `i` at its backslash: `\n` and friends, or `\u{1b}`. Undefined (reported) if bad. */
  const escape = (quote: string): string | undefined => {
    const escStart = pos();
    const escaped = source[i + 1] ?? '';
    if (escaped === 'u') {
      const m = /^\\u\{([0-9a-fA-F]{1,6})\}/.exec(source.slice(i, i + 10));
      const cp = m ? parseInt(m[1], 16) : -1;
      advance(m ? m[0].length : 2);
      if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        fail(
          m ? `\`\\u{${m[1]}}\` is not a code point` : 'malformed `\\u` escape',
          escStart,
          'write a code point as 1 to 6 hex digits in braces, `\\u{1b}`; surrogates (d800–dfff) are not code points',
        );
        return undefined;
      }
      return String.fromCodePoint(cp);
    }
    const decoded = escaped === quote ? quote : escapes[escaped];
    advance(2);
    if (decoded === undefined) fail(`unknown escape sequence \`\\${escaped}\``, escStart, 'the escapes are `\\n \\t \\r \\0 \\\\ \\" \\$` and `\\u{1b}` for any code point');
    return decoded;
  };

  /** `'a'`, `'\n'`, `'\''`: one code point, `i` at the opening quote. Pushes a `char` holding it. */
  const charLiteral = (start: Pos, startIndex: number) => {
    advance();
    let value = '';
    while (i < source.length && source[i] !== "'" && source[i] !== '\n') {
      if (source[i] === '\\') {
        value += escape("'") ?? '';
        continue;
      }
      const cp = String.fromCodePoint(source.codePointAt(i)!);
      value += cp;
      advance(cp.length);
    }
    if (source[i] !== "'") {
      fail('unterminated char literal', start, "a char is one code point in single quotes, `'a'`; a string takes double quotes");
      return;
    }
    advance();
    const n = [...value].length;
    if (n !== 1) {
      const text = source.slice(startIndex, i);
      fail(
        n === 0 ? '`\'\'` is an empty char' : `\`${text}\` holds ${n} code points, but a char is one`,
        start,
        `strings take double quotes: \`"${value.replaceAll('"', '\\"')}"\``,
      );
      push('string', value, start);
      return;
    }
    push('char', value, start);
  };

  /**
   * At a run of quotes inside a `"""` string: true (and past it) when it closes the string. The
   * last three quotes of a run close it, so `"""say "hi""""` ends in a quote.
   */
  const closesRaw = (): { closes: boolean; extra: string } => {
    let n = 0;
    while (source[i + n] === '"') n++;
    if (n < 3) return { closes: false, extra: '' };
    advance(n);
    return { closes: true, extra: '"'.repeat(n - 3) };
  };

  /**
   * A `"""` string, `i` past its opening quotes. Raw: a backslash is text, `${ }` interpolates.
   * On one line, it ends at the next `"""`. When the opening `"""` ends its line, the string is
   * the lines after it, up to a line holding only the closing `"""`; that line's indent is
   * removed from every line, and the newline before it is not part of the string.
   */
  const rawString = (start: Pos, startIndex: number) => {
    let k = i;
    while (source[k] === ' ' || source[k] === '\t' || source[k] === '\r') k++;
    const multiLine = source[k] === '\n' || k >= source.length;
    // Each line's segments, and where it starts.
    const lines: { at: Pos; parts: (string | Token[])[] }[] = [{ at: pos(), parts: [] }];
    let closed = false;
    while (i < source.length) {
      const ch = source[i];
      const cur = lines[lines.length - 1];
      if (ch === '\n') {
        if (!multiLine) break;
        advance();
        lines.push({ at: pos(), parts: [] });
        continue;
      }
      if (ch === '"') {
        const { closes, extra } = closesRaw();
        if (closes) {
          cur.parts.push(extra);
          closed = true;
          break;
        }
        cur.parts.push(ch);
        advance();
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        const open = pos();
        advance(2);
        const { inner, closed: shut } = interpolation(open);
        if (inner) cur.parts.push(inner);
        if (!shut) return;
        continue;
      }
      if (ch !== '\r') cur.parts.push(ch);
      advance();
    }
    if (!closed) {
      if (multiLine) fail('unterminated `"""` string', start, 'end it with `"""` on a line of its own, indented as far as its text');
      else if (spansLines(start, startIndex)) return;
      else fail('unterminated `"""` string', start, 'a `"""` string that starts with text on its line ends on that line; for several lines, start the text on the line after the opening `"""`');
      return;
    }
    if (!multiLine) return pushString(lines[0].parts, start, startIndex);

    const text = (parts: (string | Token[])[]) => (parts.every((p) => typeof p === 'string') ? parts.join('') : null);
    const closing = lines[lines.length - 1];
    const margin = text(closing.parts.slice(0, -1));
    if (margin === null || margin.trim() !== '' || closing.parts[closing.parts.length - 1] !== '') {
      fail('the closing `"""` of a multi-line string goes on a line of its own', closing.at, 'end the last line of text, then write `"""` on the next line, indented as far as the text');
      return pushString(lines.slice(1).flatMap((l, n) => (n === 0 ? l.parts : ['\n', ...l.parts])), start, startIndex);
    }
    const body = lines.slice(1, -1);
    const out: (string | Token[])[] = [];
    body.forEach((l, n) => {
      if (n > 0) out.push('\n');
      const blank = text(l.parts);
      if (blank !== null && blank.trim() === '') return;
      // Parts are one character each up to the first `${ }`.
      let lead = 0;
      while (typeof l.parts[lead] === 'string') lead++;
      const first = l.parts.slice(0, lead).join('');
      if (!first.startsWith(margin)) {
        const shown = /^ *$/.test(margin) ? `${margin.length} spaces` : JSON.stringify(margin);
        fail(
          'a line of this multi-line string starts left of its closing `"""`',
          l.at,
          `indent every line at least as far as the closing \`"""\` (${shown}), or move the closing \`"""\` left; its indent is what is removed from each line`,
        );
        out.push(...l.parts);
        return;
      }
      out.push(first.slice(margin.length), ...l.parts.slice(lead));
    });
    pushString(out, start, startIndex);
  };

  /**
   * A one-line `"""` string reaching the end of its line, `i` there: written as in Python, with
   * text after the opening `"""` and more lines up to `text"""`. When the next `"""` looks like
   * that close and not like another string's opening, report it once, take the lines up to it as
   * the string, and go on after it, so its lines aren't read as code. False if it doesn't.
   */
  const spansLines = (start: Pos, startIndex: number): boolean => {
    const j = source.indexOf('"""', i);
    if (j < 0) return false;
    const lineStart = source.lastIndexOf('\n', j) + 1;
    let lineEnd = source.indexOf('\n', j);
    if (lineEnd < 0) lineEnd = source.length;
    let after = j;
    while (source[after] === '"') after++;
    // `x = """`, `f("""`, `== """` and a one-line `"""a"""` open a string. Not `: """`: text
    // ends in a colon more often (`top paths:"""`) than a field starts a multi-line string.
    const before = source.slice(lineStart, j).trimEnd();
    const opens = source.slice(after, lineEnd).includes('"""') || (source.slice(after, lineEnd).trim() === '' && /[=([,{]$/.test(before));
    if (opens) return false;
    fail(
      'this `"""` string runs over several lines, but text follows its opening `"""`, so it had to end on that line',
      start,
      'end the opening line with `"""` and start the text on the next; put the closing `"""` on a line of its own: its indent is removed from every line, and the newline before it is dropped',
    );
    const value = source.slice(startIndex + 3, j).replaceAll('\r', '');
    advance(after - i);
    push('string', value, start);
    return true;
  };

  /**
   * The tokens of a `${ }` whose `${` started at `open`, up to and including its `}`: null if it
   * is empty or not closed, which is reported. `closed` is false when the string ends with it.
   */
  const interpolation = (open: Pos): { inner: Token[] | null; closed: boolean } => {
    const [outerTokens, outerNesting, outerIndents] = [tokens, nesting, indents];
    tokens = [];
    nesting = [];
    indents = [];
    const closed = scan(open);
    const inner = tokens;
    [tokens, nesting, indents] = [outerTokens, outerNesting, outerIndents];
    if (!closed) return { inner: null, closed };
    if (inner.length === 0) {
      fail('`${}` is empty: put the value to show between the braces', open);
      return { inner: null, closed };
    }
    inner.push({ kind: 'eof', text: '', span: { start: pos(), end: pos() } });
    return { inner, closed };
  };

  /**
   * Lexes into `tokens`: to the end of the source, or, inside a `${` at `open`, to its `}`.
   * Returns whether that `}` was found.
   */
  const scan = (open: Pos | null): boolean => {
    while (i < source.length) {
      const c = source[i];
      const start = pos();
      const startIndex = i;

      if (open !== null && (c === '\n' || (c === '}' && nesting.length === 0))) {
        if (c === '\n') {
          fail('`${` is not closed on its line: a string, and what it interpolates, stays on one line', open);
          return false;
        }
        advance();
        return true;
      }
      if (c === '\n') {
        advance();
        let j = i;
        while (source[j] === ' ' || source[j] === '\t') j++;
        const blank = j >= source.length || source[j] === '\n' || source[j] === '\r' || source.startsWith('//', j);
        if (!blank) indent = j - i;
        const prev = last();
        const continued = prev !== undefined && prev.kind === 'punct' && (continuesLine.has(prev.text) || prev.text === '(' || prev.text === '[');
        // A `(` or `[` was never closed when a line ends what it was on, and the next starts no
        // further in than the line the bracket opened on (and not with its `)`): it ends there,
        // so the next statement is one.
        const at = nesting.length - 1;
        if (!blank && !continued && at >= 0 && nesting[at] !== '{' && indent <= indents[at] && !')]}'.includes(source[j])) {
          nesting.length = indents.length = nesting.lastIndexOf('{') + 1;
        }
        const top = nesting[nesting.length - 1];
        const significant = top === undefined || top === '{';
        if (significant && prev !== undefined && prev.kind !== 'newline' && !continued) push('newline', '\n', start);
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        advance();
        continue;
      }
      if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') advance();
        // Newlines are never pushed twice in a row.
        const real = last()?.kind === 'newline' ? tokens[tokens.length - 2] : last();
        if (!real || real.span.end.line < start.line) {
          const text = source.slice(startIndex + 2, i).replace(/^ /, '').trimEnd();
          if (doc && doc.end === start.line - 1) doc.lines.push(text);
          else doc = { lines: [text], end: start.line };
          doc.end = start.line;
        }
        continue;
      }
      // One way to write a comment. A block comment is skipped as one, so the rest of
      // the file reads as it would.
      if (c === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2);
        advance((close < 0 ? source.length : close + 2) - i);
        fail('Candor has no block comments', start, 'write `//` at the start of each line of the comment');
        continue;
      }
      if (isIdentStart(c)) {
        while (i < source.length && isIdentPart(source[i])) advance();
        const text = source.slice(startIndex, i);
        if (text.includes('__')) fail(`\`${text}\`: names cannot contain \`__\`, it is reserved for generated code`, start);
        push(keywords.has(text) ? 'keyword' : 'ident', text, start);
        continue;
      }
      // `0xff`, `0b1010`: pushed as their decimal digits, so nothing downstream sees another base.
      if (c === '0' && /^[xXbB]$/.test(source[i + 1] ?? '')) {
        const digit = /^[xX]$/.test(source[i + 1]) ? /^[0-9A-Fa-f_]$/ : /^[01_]$/;
        advance(2);
        while (i < source.length && digit.test(source[i])) advance();
        const text = source.slice(startIndex, i);
        const digits = text.slice(2);
        if (digits === '' || digits.startsWith('_') || digits.endsWith('_') || digits.includes('__')) {
          fail(`\`${text}\`: write digits after the prefix, a separator only between two: \`0xff_ff\`, \`0b1010\``, start);
          push('int', '0', start);
        } else push('int', BigInt(`${text.slice(0, 2).toLowerCase()}${digits.replaceAll('_', '')}`).toString(), start);
        continue;
      }
      if (isDigit(c)) {
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) advance();
        const text = source.slice(startIndex, i);
        if (text.endsWith('_') || text.includes('__')) fail(`\`${text}\`: a digit separator goes between two digits, as in \`60_000\``, start);
        // `1.5`, `2.0e-3`, `1e21`: a float. Not after a `.`, so `pair.0.1` stays two tuple items,
        // and `0..n` and `1.toString()` stay ints.
        const prev = last();
        const afterDot = prev !== undefined && prev.kind === 'punct' && prev.text === '.';
        const exponent = () =>
          (source[i] === 'e' || source[i] === 'E') && (isDigit(source[i + 1] ?? '') || ((source[i + 1] === '-' || source[i + 1] === '+') && isDigit(source[i + 2] ?? '')));
        const fraction = source[i] === '.' && isDigit(source[i + 1] ?? '');
        if (!afterDot && (fraction || exponent())) {
          if (fraction) advance();
          while (i < source.length && (isDigit(source[i]) || source[i] === '_')) advance();
          if (exponent()) {
            advance(source[i + 1] === '-' || source[i + 1] === '+' ? 2 : 1);
            while (i < source.length && isDigit(source[i])) advance();
          }
          const ftext = source.slice(startIndex, i);
          if (/_\.|\._|_e|_$|__/i.test(ftext)) fail(`\`${ftext}\`: a digit separator goes between two digits, as in \`1_000.5\``, start);
          push('float', ftext.replaceAll('_', ''), start);
          continue;
        }
        // Downstream sees digits only: `BigInt`, patterns and the emitted Go never meet a `_`.
        push('int', text.replaceAll('_', ''), start);
        continue;
      }
      if (source.startsWith('"""', i)) {
        advance(3);
        rawString(start, startIndex);
        continue;
      }
      if (c === '"') {
        advance();
        const parts: (string | Token[])[] = [];
        let value = '';
        for (;;) {
          if (i >= source.length || source[i] === '\n') {
            fail('unterminated string literal', start);
            break;
          }
          const ch = source[i];
          if (ch === '"') {
            advance();
            break;
          }
          if (ch === '\\') {
            value += escape('"') ?? '';
            continue;
          }
          if (ch === '$' && source[i + 1] === '{') {
            const open = pos();
            advance(2);
            const { inner, closed } = interpolation(open);
            if (inner) {
              parts.push(value, inner);
              value = '';
            }
            if (!closed) break;
            continue;
          }
          value += ch;
          advance();
        }
        if (parts.length === 0) {
          push('string', value, start);
        } else {
          parts.push(value);
          tokens.push({ kind: 'template', text: source.slice(startIndex, i), parts, span: { start, end: pos() } });
        }
        continue;
      }
      if (c === "'") {
        charLiteral(start, startIndex);
        continue;
      }
      const punct = puncts.find((p) => source.startsWith(p, i));
      if (punct) {
        advance(punct.length);
        if (punct === '(' || punct === '[' || punct === '{') {
          nesting.push(punct);
          indents.push(indent);
        } else if (punct === ')' || punct === ']' || punct === '}') {
          // Back to its own opener, so a `(` left open ends at the `}` around it.
          const opener = punct === ')' ? '(' : punct === ']' ? '[' : '{';
          const at = nesting.lastIndexOf(opener);
          nesting.length = indents.length = at < 0 ? Math.max(0, nesting.length - 1) : at;
        }
        // A line starting with `.name` continues the one above, blank and comment lines between
        // too: `.mapErr(...)` under its call. `.Variant` starts an expression of its own.
        if (punct === '.' && last()?.kind === 'newline' && /[a-z_]/.test(source[i] ?? '')) tokens.pop();
        push('punct', punct, start);
        continue;
      }
      advance();
      // A run of them is one error.
      const before = found.at(-1);
      if (badRun && before === badRun.diag && before.span.end.line === start.line && before.span.end.col === start.col) {
        before.message = `unexpected characters ${JSON.stringify(source.slice(badRun.from, i))}`;
        before.span.end = pos();
      } else {
        fail(`unexpected character ${JSON.stringify(c)}`, start);
        badRun = { diag: found.at(-1)!, from: startIndex };
      }
    }
    if (open !== null) fail('`${` is not closed before the end of the file', open);
    return false;
  };

  scan(null);
  // A trailing newline makes "statement ends at newline" uniform for the parser.
  if (tokens.length > 0 && last().kind !== 'newline') push('newline', '\n', pos());
  push('eof', '', pos());
  if (!diagnostics && found.length > 0) throw new CandorError(found);
  return tokens;
}
