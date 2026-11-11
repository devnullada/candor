import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { compile, type CompileOptions } from '../src/compile';
import type { Diagnostic } from '../src/diagnostics';
import { lex } from '../src/lexer';
import { parse } from '../src/parser';

// A module's tests live in x_test.candor. Fixtures are written whole, the tests below
// the code, for reading; these split them out as a project would have them.

/** `source` without its `test` blocks and private `test fn`s, and a test file holding them (null if none). */
export function split(source: string): { main: string; tests: string | null } {
  const diagnostics: Diagnostic[] = [];
  const mod = parse(lex(source, 'x.candor', diagnostics), 'x.candor', diagnostics);
  if (!mod) return { main: source, tests: null };
  const lines = source.split('\n');
  const taken = mod.decls.filter((d) => d.kind === 'TestDecl' || (d.kind === 'FnDecl' && d.test && !d.pub));
  if (taken.length === 0) return { main: source, tests: null };
  const gone = new Set(taken.flatMap((d) => Array.from({ length: d.span.end.line - d.span.start.line + 1 }, (_, i) => d.span.start.line - 1 + i)));
  const main = lines.map((l, i) => (gone.has(i) ? '' : l)).join('\n');
  // Blank lines where the module's were, so a test's line is the same in either file.
  const tests = lines.map((l, i) => (gone.has(i) ? l : i === 0 ? `module ${mod.name}` : '')).join('\n');
  return { main, tests };
}

/** Writes `file` and, when the source has tests, its test file; an old test file goes. */
export function writeModule(file: string, source: string) {
  const { main, tests } = split(source);
  writeFileSync(file, main);
  const testFile = file.replace(/\.candor$/, '_test.candor');
  if (tests) writeFileSync(testFile, tests);
  else rmSync(testFile, { force: true });
}

/** `compile` of a whole fixture as `file` and its test file. */
export function compileSplit(source: string, file: string, mode: 'main' | 'test' = 'main', options: CompileOptions = {}) {
  const { main, tests } = split(source);
  if (!tests) return compile(source, file, mode, options);
  const name = file.endsWith('.candor') ? file : `${file}.candor`;
  const testFile = name.replace(/\.candor$/, '_test.candor');
  const read = (f: string) => (f === testFile ? tests : (options.read ?? fromDisk)(f));
  return compile(main, name, mode, { ...options, read });
}

function fromDisk(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
