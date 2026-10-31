import type * as ast from './ast';
import type { Diagnostic, Pos, Span } from './diagnostics';
import { lex } from './lexer';
import { parse } from './parser';

// Card #917237b1: `candor outline <file>`, a module's declarations with their line ranges and no
// bodies, so an agent finds what to read before reading it. Before their first edit, agents read
// Candor ports whole (code and tests in one big file) where they grepped into Go's smaller files.
// Tests are counted, not listed, unless asked for: they are most of a port's lines.

// Card #7de8b2de: a private function shows only its name; its signature is in the range read
// next. `full` shows every signature.

/**
 * The outline of one file's source; `tests` lists each test and test fn instead of counting them,
 * as a test file's always does (#240e482c).
 */
export function outline(source: string, file: string, tests = false, full = false): string {
  const diagnostics: Diagnostic[] = [];
  const module = parse(lex(source, file, diagnostics), file, diagnostics);
  tests ||= file.endsWith('_test.candor');
  const lines = source.split('\n');
  const total = lines.length - (lines.at(-1) === '' ? 1 : 0);
  if (!module) return `${file}: no module line; \`candor check ${file}\` says why\n`;
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const at = (p: Pos) => starts[p.line - 1] + p.col - 1;
  /** The source between two positions, on one line. */
  const text = (from: Pos, to: Pos) => source.slice(at(from), at(to)).replace(/\s*\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const whole = (s: Span) => text(s.start, s.end);
  const width = String(total).length;
  const range = (s: Span) => `${String(s.start.line).padStart(width)}-${String(s.end.line).padEnd(width)}`;
  const out: string[] = [`${file}: module ${module.name}, ${total} lines`];
  if (module.imports.length > 0) out.push(`imports ${module.imports.map((i) => (i.alias ? `${i.path} as ${i.alias}` : i.path)).join(', ')}`);
  const row = (s: Span, what: string, indent = '') => out.push(`${range(s)}  ${indent}${what}`);
  const head = (f: { span: Span; body: ast.Block | null }) => (f.body ? text(f.span.start, f.body.span.start) : whole(f.span));
  const short = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const testCode: (ast.TestDecl | ast.FnDecl)[] = [];
  for (const d of module.decls) {
    if (d.kind === 'TestDecl' || (d.kind === 'FnDecl' && d.test)) {
      testCode.push(d);
      if (tests) row(d.span, d.kind === 'TestDecl' ? `test ${JSON.stringify(d.name)}` : head(d));
      continue;
    }
    switch (d.kind) {
      case 'FnDecl':
        row(d.span, d.pub || full ? head(d) : `fn ${d.name}`);
        break;
      case 'StructDecl':
      case 'EnumDecl': {
        // Fields and variants are what a reader needs of a type: all of them, one line.
        const items = d.kind === 'StructDecl' ? d.fields : d.variants;
        const name = d.kind === 'StructDecl' ? d.fields[0]?.span : d.variants[0]?.span;
        const open = name ? text(d.span.start, name.start).replace(/\s*\{$/, '') : whole(d.span).replace(/\s*\{\s*\}$/, '');
        row(d.span, short(`${open} { ${items.map((i) => whole(i.span).replace(/,$/, '')).join(', ')} }`, 600));
        break;
      }
      case 'ConstDecl':
        // Its span runs to the next token; the value ends it.
        row({ start: d.span.start, end: d.value.span.end }, short(text(d.span.start, d.value.span.end)));
        break;
      case 'TraitDecl':
        row(d.span, `${d.pub ? 'pub ' : ''}trait ${d.name}`);
        for (const m of d.methods) row(m.span, head(m), '  ');
        break;
      case 'ImplDecl':
        row(d.span, d.fns.length === 0 ? whole(d.span) : text(d.span.start, d.fns[0].span.start).replace(/\s*\{$/, ''));
        for (const f of d.fns) row(f.span, head(f), '  ');
        break;
      case 'EffectDecl':
      case 'FakeDecl': {
        row(d.span, `${d.kind === 'EffectDecl' ? 'effect' : 'fake'} ${d.name}`);
        for (const s of d.state) row(s.span, short(whole(s.span)), '  ');
        const fns = d.kind === 'EffectDecl' ? [...d.ops, ...d.helpers].sort((a, b) => a.span.start.line - b.span.start.line) : d.fns;
        for (const f of fns) row(f.span, head(f), '  ');
        break;
      }
      case 'ExternDecl':
        row(d.span, `${d.pub ? 'pub ' : ''}extern ${JSON.stringify(d.goPath + (d.version ? `@${d.version}` : ''))}`);
        for (const item of d.items) row(item.span, whole(item.span), '  ');
        break;
    }
  }
  if (!tests && testCode.length > 0) {
    const named = testCode.filter((t) => t.kind === 'TestDecl').length;
    const helpers = testCode.length - named;
    const lineCount = testCode.reduce((n, t) => n + t.span.end.line - t.span.start.line + 1, 0);
    const first = Math.min(...testCode.map((t) => t.span.start.line));
    const last = Math.max(...testCode.map((t) => t.span.end.line));
    const what = `${named} test${named === 1 ? '' : 's'}${helpers > 0 ? ` and ${helpers} test fn${helpers === 1 ? '' : 's'}` : ''}`;
    out.push(`${what}: ${lineCount} lines, between lines ${first} and ${last} (\`candor outline --tests ${file}\` lists them)`);
  }
  return `${out.join('\n')}\n`;
}
