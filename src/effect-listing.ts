import type * as ast from './ast';
import type { Diagnostic, Span } from './diagnostics';
import { lex } from './lexer';
import { parse } from './parser';

// Card #b64daaed: `candor effects`, what each function's signature says it may do, as a list that
// a lock file can be diffed against. It parses and doesn't check: `uses` is the whole of it, since
// the checker makes every caller declare what it calls. `candor check` is what vouches for that.

export interface EffectEntry {
  file: string;
  line: number;
  name: string;
  /** Sorted effect names: `io`, `net.payments`. */
  effects: string[];
  /** Sorted `uses f` names: the function takes on whatever that parameter does. */
  from: string[];
}

interface Signature {
  params: ast.Param[];
  uses: ast.EffectRef[];
}

/**
 * The functions of one file: `pub` ones, `main`, trait methods and effect operations, since code
 * elsewhere can reach those. Private functions show up in what their callers must declare; `full`
 * lists them too. Test code and fakes never run in the program, so they aren't listed.
 */
export function effectListing(source: string, file: string, full = false): { entries: EffectEntry[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const module = parse(lex(source, file, diagnostics), file, diagnostics);
  const entries: EffectEntry[] = [];
  if (!module || diagnostics.some((d) => d.severity === 'error')) return { entries, diagnostics };
  const text = (s: Span) => {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const at = (p: Span['start']) => starts[p.line - 1] + p.col - 1;
    return source.slice(at(s.start), at(s.end)).replace(/\s+/g, ' ').trim();
  };
  const add = (name: string, s: Signature, span: Span) => {
    // As the checker reads it: a parameter's name wins, and it refuses one that isn't a function.
    const params = new Set(s.params.map((p) => p.name));
    const names = s.uses.map((u) => u.path.join('.'));
    const sorted = (xs: string[]) => [...new Set(xs)].sort(byCodeUnit);
    entries.push({
      file,
      line: span.start.line,
      name,
      effects: sorted(names.filter((n) => !params.has(n))),
      from: sorted(names.filter((n) => params.has(n))),
    });
  };
  const externs = (d: ast.ExternDecl, shown: boolean) => {
    for (const item of d.items) if (item.kind === 'ExternFn' && (shown || item.pub)) add(item.name, { params: item.params, uses: item.uses }, item.span);
  };
  for (const d of module.decls) {
    switch (d.kind) {
      case 'FnDecl':
        if (!d.test && (d.pub || d.name === 'main' || full)) add(d.name, d, d.span);
        break;
      case 'ImplDecl':
        for (const f of d.fns) add(`${d.trait} for ${text(d.target.span)}.${f.name}`, f, f.span);
        break;
      case 'TraitDecl':
        if (d.pub || full) for (const m of d.methods) add(`${d.name}.${m.name}`, m, m.span);
        break;
      case 'EffectDecl':
        for (const f of d.ops) add(`${d.name}.${f.name}`, f, f.span);
        if (full) {
          for (const f of d.helpers) add(`${d.name}.${f.name}`, f, f.span);
          for (const e of d.externs) externs(e, true);
        }
        break;
      case 'ExternDecl':
        externs(d, full);
        break;
    }
  }
  return { entries, diagnostics };
}

/** Not `localeCompare`: the order mustn't depend on the machine that printed it. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** By file, then name, so moving a function within its file changes only its line. */
export function sortEntries(entries: EffectEntry[]): EffectEntry[] {
  return [...entries].sort((a, b) => byCodeUnit(a.file, b.file) || byCodeUnit(a.name, b.name) || a.line - b.line);
}

export function formatEffects(entries: EffectEntry[]): string {
  return entries
    .map((e) => {
      const uses = [...e.effects, ...e.from].sort(byCodeUnit);
      return `${e.file}:${e.line} ${e.name}: ${uses.length > 0 ? `uses ${uses.join(', ')}` : 'no effects'}\n`;
    })
    .join('');
}

/** One function to a line, so two listings diff by function. */
export function formatEffectsJson(entries: EffectEntry[]): string {
  if (entries.length === 0) return '[]\n';
  return `[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`;
}
