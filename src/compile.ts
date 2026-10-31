import { readFileSync } from 'node:fs';
import path from 'node:path';
import type * as ast from './ast';
import { check, type CheckResult } from './checker';
import { Codes, type Diagnostic, type Pos, type Span } from './diagnostics';
import { emitGo, type EmbedFile } from './emit-go';
import { candorHome } from './home';
import type { Type } from './types';
import { lex } from './lexer';
import { parse } from './parser';

export interface CompileResult {
  /** The entry module. */
  module: ast.Module | null;
  /** Generated Go, or null when there were errors. Warnings do not block emission. */
  go: string | null;
  /**
   * Go for the `extern` declarations, in a file of its own: when a binding's signature doesn't
   * fit its Go function, Go's error then points at a binding, not at generated code.
   */
  bindings: string | null;
  /** Go packages next to binding files (`extern "./dir"`), to copy into the build. */
  localPackages: { dir: string; importPath: string }[];
  /** Third-party Go packages the bindings name, at their versions, for `go.mod`. */
  goRequires: { path: string; version: string }[];
  /** Every binding, for checking against Go's own types. */
  externs: ExternUse[];
  /** Card 144: the files `embed` builds in, to copy into the build. */
  embeds: EmbedFile[];
  diagnostics: Diagnostic[];
  /** #240e482c: the entry's test file, read in by `test` and `check`; its line 1 is the module's `from + 1`. */
  testFile: { file: string; from: number } | null;
  /** Every file read, for showing diagnostics. */
  sources: Map<string, string>;
}

/** A Go function or value a binding names, and the Candor type it gives it. */
export interface ExternUse {
  file: string;
  /** As the build imports it: local packages become `candorapp/local__N`. */
  importPath: string;
  decl: ast.ExternDecl;
  item: ast.ExternItem;
  /** A function type for `fn`, the value's type for `let`, the Go type itself for `type`. */
  type: Type;
}

export interface CompileOptions {
  /** Reads an imported file; null if it doesn't exist. Defaults to the file system. */
  read?: (file: string) => string | null;
}

/** The standard modules: `import "json"` reads `std/json.candor`, shipped with the compiler. */
const STD = new Set(['json', 'http', 'sql', 'time', 'fs', 'bytes', 'net', 'exec', 'hash', 'mime', 'imap', 'smtp', 'regex', 'crypto', 'html', 'xml', 'url', 'flags']);
const stdDir = () => path.join(candorHome(), 'std');

/** One module of a program, with what it imports. */
interface Unit {
  mod: ast.Module;
  file: string;
  /** A standard module, from `std/`. */
  std: boolean;
  /** Imported modules by name. */
  deps: Map<string, Unit>;
  info?: CheckResult;
}

/**
 * Compiles a file and every file it imports, transitively, into one Go program. `test` mode
 * compiles the entry's `test` blocks into a runner instead of calling `main`, which is then
 * optional. Imported modules never need a `main`, and their tests don't run.
 */
export function compile(source: string, file: string, mode: 'main' | 'test' = 'main', options: CompileOptions = {}): CompileResult {
  const read = options.read ?? readFile;
  const sources = new Map([[file, source]]);
  const diagnostics: Diagnostic[] = [];
  let tests: TestFile | null = null;
  // The test file's lines count on from the module's own; its diagnostics get its own back.
  const placed = () => (tests ? diagnostics.map((d) => place(d, file, tests!)) : diagnostics);
  const failed =(module: ast.Module | null): CompileResult => ({
    module,
    go: null,
    bindings: null,
    localPackages: [],
    goRequires: [],
    externs: [],
    embeds: [],
    diagnostics: placed(),
    testFile: tests && { file: tests.file, from: tests.from },
    sources,
  });

  const entry = parseFile(source, file, diagnostics);
  if (!entry) return failed(null);
  // #240e482c: `test` and `check` take the entry's tests from its test file, as one module with it.
  tests = mode === 'test' ? attachTests(entry, source, file, read, sources, diagnostics) : null;
  const order = loadImports(entry, file, read, sources, diagnostics);
  if (!order) return failed(entry);

  // Modules with syntax errors are checked too, for what parsed; nothing is emitted.
  const syntax = diagnostics.filter((d) => d.code === Codes.SyntaxError);
  const lost = new Set(order.flatMap((u) => u.mod.lostNames));
  for (const unit of order) {
    const isEntry = unit === order.at(-1);
    if (!unit.std) diagnostics.push(...inlineTests(unit.mod, unit.file, isEntry && tests ? tests.from : Infinity));
    const imports = new Map([...unit.deps].map(([name, dep]) => [name, dep.info!]));
    unit.info = check(unit.mod, unit.file, { requireMain: isEntry && mode === 'main', imports, imported: !isEntry, testsFrom: isEntry && tests ? tests.from : Infinity });
    // A standard module's warnings are the compiler's business: `serve`'s stub uses nothing.
    diagnostics.push(...unit.info.diagnostics.filter((d) => !cascade(d, unit.mod, syntax, lost) && !(unit.std && d.severity === 'warning')));
  }
  const goRequires = requires(order, diagnostics);
  if (diagnostics.some((d) => d.severity === 'error')) return failed(entry);
  // fsnotify only for a program that watches; a test's watch is in memory.
  const watch = mode === 'main' && order.some((u) => !u.std && [...u.info!.moduleRefs.values()].some((r) => r.module === 'fs' && r.name === 'watch'));
  if (watch && !goRequires.some((r) => r.path === fsnotify.path)) goRequires.push(fsnotify);
  // `mime`, `xml` and `bytes` read charsets with x/text: a dependency without bindings, so no `extern` names it.
  const mime = order.some((u) => u.std && (u.mod.name === 'mime' || u.mod.name === 'xml' || u.mod.name === 'bytes'));
  if (mime && !goRequires.some((r) => r.path === xtext.path)) goRequires.push(xtext);
  // `crypto`'s argon2id is x/crypto's, the same way.
  const crypto = order.some((u) => u.std && u.mod.name === 'crypto');
  if (crypto && !goRequires.some((r) => r.path === xcrypto.path)) goRequires.push(xcrypto);
  // `html` reads pages with x/net/html, the same way.
  const html = order.some((u) => u.std && u.mod.name === 'html');
  if (html && !goRequires.some((r) => r.path === xnet.path)) goRequires.push(xnet);

  const localPackages: { dir: string; importPath: string }[] = [];
  const goImport = (goPath: string, from: string) => {
    if (!goPath.startsWith('./') && !goPath.startsWith('../')) return goPath;
    const dir = path.resolve(path.dirname(from), goPath);
    let pkg = localPackages.find((p) => p.dir === dir);
    if (!pkg) {
      pkg = { dir, importPath: `candorapp/local__${localPackages.length + 1}` };
      localPackages.push(pkg);
    }
    return pkg.importPath;
  };
  const units = order.map((u, i) => {
    const own = { mod: u.mod, info: u.info!, file: normalize(path.resolve(u.file)), source: sources.get(u.file)!, std: u.std };
    // The entry with its test file: both texts, and where the second starts, for `//line`.
    return tests && i === order.length - 1 ? { ...own, source: tests.source, tests: { file: normalize(path.resolve(tests.file)), from: tests.from } } : own;
  });
  // Absolute paths, for the `//line` directives that point Go's errors in bindings at Candor source.
  const emitted = emitGo(units, { file: tests?.file ?? file, mode, watch }, goImport);
  const externs: ExternUse[] = order.flatMap((u, i) =>
    externDecls(u.mod).flatMap((decl) =>
      decl.items.map((item) => ({
        file: u.file,
        importPath: goImport(decl.goPath, units[i].file),
        decl,
        item,
        type: item.kind === 'ExternFn' ? u.info!.fns.get(item.name)!.type : item.kind === 'ExternLet' ? u.info!.values.get(item.name)!.type : u.info!.opaques.get(item.name)!,
      })),
    ),
  );
  return { module: entry, go: emitted.main, bindings: emitted.bindings, localPackages, goRequires, externs, embeds: emitted.embeds, diagnostics: placed(), testFile: tests && { file: tests.file, from: tests.from }, sources };
}

/** What std/watchgo builds on, under `fs.watch`. */
const fsnotify = { path: 'github.com/fsnotify/fsnotify', version: 'v1.9.0' };
const xtext = { path: 'golang.org/x/text', version: 'v0.43.0' };
const xcrypto = { path: 'golang.org/x/crypto/argon2', version: 'v0.58.0' };
// The x/ pins must agree: each at least what the others require (x/crypto v0.58.0 needs x/net
// v0.60.0 and x/text v0.43.0). `test/std-together.test.ts` builds them all in one program.
const xnet = { path: 'golang.org/x/net/html', version: 'v0.60.0' };

function externDecls(mod: ast.Module): ast.ExternDecl[] {
  return mod.decls.flatMap((d) => (d.kind === 'ExternDecl' ? [d] : d.kind === 'EffectDecl' ? d.externs : []));
}

/** The versioned Go packages of every binding. One package at two versions is an error. */
function requires(order: Unit[], diagnostics: Diagnostic[]): { path: string; version: string }[] {
  const seen = new Map<string, { version: string; file: string }>();
  for (const u of order) {
    for (const decl of externDecls(u.mod)) {
      if (decl.version === null) continue;
      const before = seen.get(decl.goPath);
      if (!before) {
        seen.set(decl.goPath, { version: decl.version, file: u.file });
      } else if (before.version !== decl.version) {
        diagnostics.push({
          code: Codes.ExternUnsupported,
          severity: 'error',
          message: `\`${decl.goPath}\` is bound at ${decl.version} here and at ${before.version} in ${before.file}`,
          help: 'a program uses one version of each Go package: bind the same one everywhere',
          file: u.file,
          span: decl.goPathSpan,
        });
      }
    }
  }
  return [...seen].map(([p, { version }]) => ({ path: p, version }));
}

/** Null only when the `module` line doesn't parse; other syntax errors leave out what failed. */
function parseFile(source: string, file: string, diagnostics: Diagnostic[], firstLine = 1): ast.Module | null {
  const before = diagnostics.length;
  const mod = parse(lex(source, file, diagnostics, firstLine), file, diagnostics);
  // The lexer's errors and the parser's, in the order of the file.
  const found = diagnostics.splice(before).sort((a, b) => a.span.start.line - b.span.start.line || a.span.start.col - b.span.start.col);
  diagnostics.push(...found);
  return mod;
}

/** #240e482c: `x.candor`'s tests are in `x_test.candor` beside it; null for a test file itself. */
export function testFileOf(file: string): string | null {
  return file.endsWith('.candor') && !file.endsWith('_test.candor') ? `${file.slice(0, -'.candor'.length)}_test.candor` : null;
}

/** The module file a test file holds the tests of; null for any other file. */
export function mainFileOf(file: string): string | null {
  return file.endsWith('_test.candor') ? `${file.slice(0, -'_test.candor'.length)}.candor` : null;
}

/** An entry's test file, read in as part of its module. */
interface TestFile {
  file: string;
  /** Its line 1 is the module's line `from + 1`. */
  from: number;
  /** The module's text, then the test file's: what the spans point into. */
  source: string;
}

/**
 * Reads the entry's test file, if it has one, and adds its imports and declarations to the
 * entry's module. Its lines are numbered on from the entry's last, so one module has one set of
 * spans; `place` turns them back.
 */
function attachTests(entry: ast.Module, source: string, file: string, read: (file: string) => string | null, sources: Map<string, string>, diagnostics: Diagnostic[]): TestFile | null {
  const testFile = testFileOf(file);
  const text = testFile && read(testFile);
  if (!testFile || text == null) return null;
  sources.set(testFile, text);
  const from = (source.match(/\n/g)?.length ?? 0) + (source.endsWith('\n') ? 0 : 1);
  const tests = { file: testFile, from, source: source + (source.endsWith('\n') ? '' : '\n') + text };
  const mod = parseFile(text, file, diagnostics, from + 1);
  if (!mod) return tests;
  if (mod.name !== entry.name) {
    diagnostics.push({
      code: Codes.TestFile,
      severity: 'error',
      message: `${path.basename(testFile)} says \`module ${mod.name}\`, but it holds the tests of \`module ${entry.name}\``,
      help: `start it with \`module ${entry.name}\`, the line ${path.basename(file)} starts with`,
      file,
      span: mod.nameSpan,
    });
    return tests;
  }
  // An import both files have is one import.
  const same = (a: ast.ImportDecl, b: ast.ImportDecl) => a.path === b.path && a.alias === b.alias;
  entry.imports.push(...mod.imports.filter((i) => !entry.imports.some((e) => same(e, i))));
  entry.decls.push(...mod.decls);
  entry.lostNames.push(...mod.lostNames);
  entry.dropped.push(...mod.dropped);
  return tests;
}

/** A diagnostic at a line of the entry's test file, at that file's own line. */
function place(d: Diagnostic, file: string, tests: TestFile): Diagnostic {
  if (d.file !== file || d.span.start.line <= tests.from) return d;
  const back = (p: Pos): Pos => ({ line: p.line - tests.from, col: p.col });
  return { ...d, file: tests.file, span: { start: back(d.span.start), end: back(d.span.end) } };
}

/**
 * Tests in a module's own file (before line `from`), which only its test file may hold. A `pub
 * test fn` stays: it is for other modules' tests, and they never read this one's test file.
 */
function inlineTests(mod: ast.Module, file: string, from: number): Diagnostic[] {
  const testFile = path.basename(testFileOf(file) ?? `${mod.name}_test.candor`);
  return mod.decls.flatMap((d): Diagnostic[] => {
    const test = d.kind === 'TestDecl' ? d.span : d.kind === 'FnDecl' && d.test && !d.pub ? d.test : null;
    if (!test || d.span.start.line > from) return [];
    return [
      {
        code: Codes.TestFile,
        severity: 'error',
        message: `${d.kind === 'TestDecl' ? 'a `test` block' : 'a `test fn`'} goes in ${testFile}, not in the module's own file`,
        help:
          d.kind === 'TestDecl'
            ? `move it to ${testFile} beside this file: it starts with \`module ${mod.name}\` and sees the module's private names`
            : `move it to ${testFile} beside this file, or make it \`pub test fn\` for other modules' tests`,
        file,
        span: d.kind === 'TestDecl' ? { start: d.span.start, end: d.nameSpan.end } : test,
      },
    ];
  });
}

/**
 * Whether a checker diagnostic may only follow from a syntax error (card 092): it is on the line
 * of one or in what one skipped; it is a check of the whole body (a missing return, a name never
 * used), or a type left unknown, in a declaration with one; or it names something a dropped
 * statement, item or declaration would have declared.
 */
function cascade(d: Diagnostic, mod: ast.Module, syntax: Diagnostic[], lost: Set<string>): boolean {
  if (syntax.length === 0) return false;
  // The names in a message's quoted code: `Todo.id` names `Todo` and `id`.
  const quoted = new Set([...d.message.matchAll(/`([^`]*)`/g)].flatMap((m) => m[1].split(/\W+/)));
  const names = (list: Iterable<string>) => [...list].some((name) => quoted.has(name));
  const here = syntax.filter((s) => s.file === d.file);
  if (here.some((s) => s.span.start.line === d.span.start.line)) return true;
  if (mod.dropped.some((r) => within(d.span.start, r.span))) return true;
  const decl = mod.decls.find((x) => within(d.span.start, x.span) && here.some((s) => within(s.span.start, x.span)));
  if (decl) {
    if (d.severity === 'warning' || bodyWide.includes(d.code)) return true;
    const dropped = mod.dropped.filter((r) => within(r.span.start, decl.span));
    const earlier = dropped.some((r) => !after(r.span.start, d.span.start));
    if (inference.includes(d.code) && earlier) return true;
    // A dropped `if x == none { return }` took its narrowing with it: `x` is still a `T?`.
    if (earlier && /[\w>)\]]\?(?!\w)/.test(d.message)) return true;
    if (names(dropped.flatMap((r) => r.names))) return true;
  }
  // A dropped item (a field, a variant) leaves its type part-known wherever it is used.
  if (inference.includes(d.code) && mod.lostNames.length > 0) return true;
  if (d.code === Codes.NoMain) return lost.has('main');
  return names(lost);
}

// An `extern` block whose items were all dropped looks empty.
const bodyWide: string[] = [Codes.MissingReturn, Codes.UnusedVariable, Codes.UnusedEffect, Codes.ExternUnsupported];
const inference: string[] = [Codes.NeedsAnnotation, Codes.TypeArgs];

/** Whether `a` comes after `b`. */
const after = (a: Pos, b: Pos) => a.line > b.line || (a.line === b.line && a.col > b.col);


function within(p: Pos, span: Span): boolean {
  const after = (a: Pos, b: Pos) => a.line > b.line || (a.line === b.line && a.col >= b.col);
  return after(p, span.start) && after(span.end, p);
}

/**
 * Reads every module the entry imports. Returns them dependencies first, the entry last, or null
 * after reporting why not. An import path is relative to the importing file, without `.candor`,
 * and its last part is the module's name: `import "bindings/strconv"` reads
 * `bindings/strconv.candor`, which must say `module strconv`.
 */
function loadImports(
  entry: ast.Module,
  entryFile: string,
  read: (file: string) => string | null,
  sources: Map<string, string>,
  diagnostics: Diagnostic[],
): Unit[] | null {
  const byFile = new Map<string, Unit>();
  const order: Unit[] = [];
  const loading = new Set<Unit>();
  const ok = { value: true };
  const report = (file: string, span: ast.ImportDecl['span'], message: string, help?: string) => {
    diagnostics.push({ code: Codes.BadImport, severity: 'error', message, help, file, span });
    ok.value = false;
  };

  const visit = (unit: Unit) => {
    loading.add(unit);
    for (const imp of unit.mod.imports) {
      const base = imp.path.split('/').at(-1)!;
      // What this file calls it: the alias, or the module's own name.
      const name = imp.alias ?? base;
      const nameSpan = imp.aliasSpan ?? imp.pathSpan;
      const std = STD.has(imp.path);
      const target = normalize(std ? path.join(stdDir(), `${imp.path}.candor`) : path.join(path.dirname(unit.file), `${imp.path}.candor`));
      if (unit.deps.has(name) || [...unit.deps.values()].some((d) => d.file === target)) {
        report(unit.file, imp.pathSpan, `\`${base}\` is imported twice`, 'remove one of the imports');
        continue;
      }
      if (name === unit.mod.name) {
        report(unit.file, nameSpan, `a module cannot import a module with its own name, \`${name}\``, imp.alias ? 'pick another name after `as`' : undefined);
        continue;
      }
      let dep = byFile.get(target);
      if (!dep) {
        const text = std ? readFile(target) : read(target);
        if (text === null) {
          report(unit.file, imp.pathSpan, `cannot find ${target}`, 'the path is relative to this file, without `.candor`');
          continue;
        }
        sources.set(target, text);
        const mod = parseFile(text, target, diagnostics);
        if (!mod) {
          ok.value = false;
          continue;
        }
        if (mod.name !== base) {
          report(unit.file, imp.pathSpan, `${target} declares \`module ${mod.name}\`, but its import path ends in \`${base}\``, `name the file ${mod.name}.candor, or the module ${base}`);
          continue;
        }
        const clash = [...byFile.values()].find((u) => u.mod.name === mod.name);
        if (clash) {
          const help = clash.std || std ? `\`${mod.name}\` is a standard module (\`import "${mod.name}"\`): name yours differently` : 'module names must be unique in a program';
          report(unit.file, imp.pathSpan, `two files declare \`module ${mod.name}\`: ${clash.file} and ${target}`, help);
          continue;
        }
        dep = { mod, file: target, deps: new Map(), std };
        byFile.set(target, dep);
        visit(dep);
      } else if (loading.has(dep)) {
        report(unit.file, imp.pathSpan, `\`${base}\` imports \`${unit.mod.name}\`, directly or not, so importing it back is a cycle`, 'move what both need into a third module');
        continue;
      }
      unit.deps.set(name, dep);
    }
    loading.delete(unit);
    order.push(unit);
  };

  const root: Unit = { mod: entry, file: entryFile, deps: new Map(), std: false };
  byFile.set(normalize(entryFile), root);
  visit(root);
  return ok.value ? order : null;
}

function readFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Forward slashes on every platform, so paths in messages and tests look the same everywhere. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}
