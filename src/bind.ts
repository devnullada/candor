import { suggest } from './checker';
import type { ExternUse } from './compile';
import { Codes, type Diagnostic } from './diagnostics';
import { keywords } from './lexer';
import { typeToString, type OpaqueType, type Type } from './types';

// What the Go helper (tools/gotypes) reports about Go packages, and what Candor does with it:
// checking bindings against Go's own types, and drafting new bindings.

/**
 * A Go type, sorted into what a binding can pass. `int` is any integer type, named or not, and
 * `float` either float type; `named` is a declared type or a pointer to one, which a `type` item can bind.
 */
export interface GoType {
  kind: 'int' | 'float' | 'string' | 'bool' | '[]string' | '[]byte' | 'error' | 'context' | 'any' | 'named' | 'other';
  /** How Go writes it, qualified by package name. */
  text: string;
  /** For `named`: the import path of its package, its name, and whether this is a pointer to it. */
  pkg?: string;
  name?: string;
  pointer?: boolean;
}

export interface GoFunc {
  name: string;
  doc?: string;
  /** Without the variadic parameter, if there is one; `rest` is its element type. */
  params: { name: string; type: GoType }[];
  results: GoType[];
  variadic: boolean;
  rest?: GoType;
  /** How Go writes the signature: `func(s string) (int, error)`. */
  text: string;
  /** For a method: whether its receiver is a pointer. */
  pointerRecv?: boolean;
}

export interface GoValue {
  name: string;
  doc?: string;
  type: GoType;
  const: boolean;
}

/** An exported Go type. `methods` are those of a pointer to it, or an interface's own. */
export interface GoTypeDecl {
  name: string;
  doc?: string;
  kind: 'struct' | 'interface' | 'other';
  methods: GoFunc[];
}

export interface GoPackage {
  path: string;
  name: string;
  errors: string[];
  funcs: GoFunc[];
  values: GoValue[];
  types: GoTypeDecl[];
}

/** Where each Go type a binding declares lives, as the build imports it. */
type TypePaths = Map<OpaqueType, string>;

/**
 * Every binding checked against the Go function, value or type it names. `packages` is keyed
 * by import path, as the build imports it.
 */
export function checkExterns(externs: ExternUse[], packages: Map<string, GoPackage>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const paths: TypePaths = new Map(externs.flatMap((u) => (u.type.kind === 'opaque' ? [[u.type, u.importPath]] : [])));
  for (const use of externs) {
    const { item, decl } = use;
    const error = (message: string, help?: string, span = item.goNameSpan) =>
      diagnostics.push({ code: Codes.GoMismatch, severity: 'error', message, help, file: use.file, span });
    const pkg = packages.get(use.importPath);
    if (!pkg || pkg.errors.length > 0) {
      if (reported.has(use.file + use.importPath)) continue;
      reported.add(use.file + use.importPath);
      error(`cannot load the Go package \`${decl.goPath}\`${pkg ? `: ${pkg.errors[0]}` : ''}`, undefined, decl.goPathSpan);
      continue;
    }
    const where = `\`${decl.goPath}\``;
    if (item.kind === 'ExternType') {
      const t = pkg.types.find((x) => x.name === item.goName);
      if (!t) {
        error(`${where} has no type \`${item.goName}\``, near(item.goName, pkg.types.map((x) => x.name)));
      } else if (t.kind === 'interface' && item.pointer) {
        error(`\`${item.goName}\` is a Go interface, which Go passes as itself, not by pointer`, `write \`type ${item.goName}${item.name !== item.goName ? ` as ${item.name}` : ''}\``);
      }
      continue;
    }
    if (item.kind === 'ExternLet') {
      const value = pkg.values.find((v) => v.name === item.goName);
      if (!value) {
        const f = pkg.funcs.find((g) => g.name === item.goName);
        error(`${where} has no variable or constant \`${item.goName}\``, f ? `\`${item.goName}\` is a function: bind it with \`fn\`` : nearIn(item.goName, pkg));
        continue;
      }
      if (!fits(use.type, value.type, paths)) {
        const want = candorType(value.type, new Map());
        error(
          `the Go ${value.const ? 'constant' : 'variable'} \`${item.goName}\` has type \`${value.type.text}\`, which does not fit ${typeToString(use.type)}`,
          want ? `write \`let ${item.goName}: ${want}\`` : `a ${value.type.text} can't cross into Candor yet`,
        );
      }
      continue;
    }
    if (use.type.kind !== 'fn') continue;
    const ft = use.type;
    let f: GoFunc | undefined;
    const recv = item.receiver ? ft.params[0] : null;
    if (recv) {
      if (recv.kind !== 'opaque') continue;
      const t = pkg.types.find((x) => x.name === recv.goName);
      if (!t) continue; // reported at the type
      f = t.methods.find((m) => m.name === item.goName);
      if (!f) {
        error(`the Go type \`${recv.goName}\` has no method \`${item.goName}\``, near(item.goName, t.methods.map((m) => m.name)));
        continue;
      }
      if (f.pointerRecv && !recv.pointer) {
        error(`\`${recv.goName}.${item.goName}\` needs a pointer to a \`${recv.goName}\``, `declare the type as \`type *${recv.goName}\``);
        continue;
      }
    } else {
      f = pkg.funcs.find((g) => g.name === item.goName);
      if (!f) {
        const v = pkg.values.find((g) => g.name === item.goName);
        error(`${where} has no function \`${item.goName}\``, v ? `\`${item.goName}\` is a ${v.const ? 'constant' : 'variable'}: bind it with \`let\`` : nearIn(item.goName, pkg));
        continue;
      }
    }
    if (f.variadic !== (item.spread !== null)) {
      const rest = f.rest && (f.rest.kind === 'any' ? 'int' : candorType(f.rest, new Map()));
      error(
        f.variadic ? `the Go ${recv ? 'method' : 'function'} \`${f.name}\` is \`${f.text}\`: variadic` : `the Go ${recv ? 'method' : 'function'} \`${f.name}\` is \`${f.text}\`, which is not variadic`,
        f.variadic
          ? `after its other parameters, write what goes into the last one, as many as you pass: \`...(a: ${rest ?? 'T'}, b: ${rest ?? 'T'})\``
          : 'drop the `...(...)`',
      );
      continue;
    }
    const spread = item.spread?.length ?? 0;
    const params = ft.params.slice(recv ? 1 : 0);
    if (fnFits({ ...ft, params: params.slice(0, params.length - spread) }, params.slice(params.length - spread), item.spread !== null, item.ctx !== null, f, paths)) continue;
    const names: GoNames = new Map([...paths].map(([t, p]) => [`${p}.${t.goName}`, t]));
    const sig = candorSignature(f, names);
    const head = recv ? `fn (${item.receiver!.name}: ${typeToString(recv)}) ` : 'fn ';
    error(
      `the Go ${recv ? 'method' : 'function'} \`${f.name}\` is \`${f.text}\`, which does not fit this binding's signature`,
      typeof sig === 'string'
        ? sig
        : `write \`${head}${f.name}(${[...(sig.ctx ? ['ctx'] : []), ...sig.params.map((p) => `${p.name}: ${p.type}`), ...(f.variadic ? ['...(...)'] : [])].join(', ')})${sig.ret ? ` -> ${sig.ret}` : ''}\``,
    );
  }
  return diagnostics;
}

function nearIn(name: string, pkg: GoPackage): string | undefined {
  return near(name, [...pkg.funcs, ...pkg.values].map((x) => x.name));
}

function near(name: string, names: string[]): string | undefined {
  const hit = suggest(name, names);
  return hit && `did you mean \`${hit}\`?`;
}

/** Whether a Candor type and a Go type meet in a binding, as the generic adapters let them. */
function fits(t: Type, g: GoType, paths: TypePaths): boolean {
  switch (t.kind) {
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'goerror':
      return g.kind === (t.kind === 'goerror' ? 'error' : t.kind);
    case 'list':
      return t.elem.kind === 'string' && g.kind === '[]string';
    case 'bytes':
      return g.kind === '[]byte';
    case 'opaque':
      return g.kind === 'named' && g.pkg === paths.get(t) && g.name === t.goName && (g.pointer ?? false) === t.pointer;
    default:
      return false;
  }
}

/** `spread`: the Candor parameters that go into Go's variadic one (`hasSpread`: `...(...)` was written). */
function fnFits(t: Type & { kind: 'fn' }, spread: Type[], hasSpread: boolean, ctx: boolean, f: GoFunc, paths: TypePaths): boolean {
  if (f.variadic !== hasSpread) return false;
  if (f.rest && !spread.every((s) => f.rest!.kind === 'any' || fits(s, f.rest!, paths))) return false;
  const params = f.params.map((p) => p.type);
  if (ctx && params.shift()?.kind !== 'context') return false;
  if (params.length !== t.params.length || !t.params.every((p, i) => fits(p, params[i], paths))) return false;
  const ret = t.ret;
  const r = f.results;
  if (ret.kind === 'unit') return r.length === 0;
  if (ret.kind === 'result') {
    if (ret.err.kind !== 'goerror' || r.at(-1)?.kind !== 'error') return false;
    if (ret.ok.kind === 'unit') return r.length === 1;
    return r.length === 2 && fits(ret.ok, r[0], paths);
  }
  if (ret.kind === 'option') {
    // A pointer that may be nil, or `(T, bool)`.
    if (ret.inner.kind === 'opaque' && ret.inner.pointer) return r.length === 1 && fits(ret.inner, r[0], paths);
    return r.length === 2 && r[1].kind === 'bool' && fits(ret.inner, r[0], paths);
  }
  return r.length === 1 && r[0].kind !== 'error' && fits(ret, r[0], paths);
}

/**
 * How Candor writes a Go type in a binding, or null if it can't cross yet. `types`: the Go
 * types the binding declares, by Go name.
 */
function candorType(g: GoType, types: GoNames, asParam = false): string | null {
  switch (g.kind) {
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return g.kind;
    case '[]string':
      return 'List<string>';
    case '[]byte':
      return 'Bytes';
    case 'error':
      return asParam ? 'GoError' : null;
    case 'named': {
      const t = types.get(`${g.pkg}.${g.name}`);
      return t && t.pointer === (g.pointer ?? false) ? t.name : null;
    }
    default:
      return null;
  }
}

/** The Go types a binding declares, keyed by `importPath.GoName`. */
type GoNames = Map<string, { name: string; pointer: boolean }>;

/** Why `g` can't cross: not declared, or declared with the other pointer-ness. */
function cannotCross(g: GoType, types: GoNames): string {
  const t = g.kind === 'named' ? types.get(`${g.pkg}.${g.name}`) : undefined;
  if (!t) return `a ${g.text} can't cross into Candor yet`;
  return g.pointer ? `Go passes a pointer, ${g.text}: declare it as \`type *${g.name}\`` : `Go passes a ${g.text} itself: declare it as \`type ${g.name}\`, without \`*\``;
}

interface CandorSig {
  ctx: boolean;
  params: { name: string; type: string }[];
  ret: string | null;
}

/** The binding signature for a Go function, or why there is none yet. */
function candorSignature(f: GoFunc, types: GoNames): CandorSig | string {
  const goParams = [...f.params];
  const ctx = goParams[0]?.type.kind === 'context';
  if (ctx) goParams.shift();
  const params: CandorSig['params'] = [];
  for (const [i, p] of goParams.entries()) {
    const type = candorType(p.type, types, true);
    if (!type) return cannotCross(p.type, types);
    params.push({ name: paramName(p.name, i), type });
  }
  const r = f.results;
  if (r.length === 0) return { ctx, params, ret: null };
  if (r.length === 1 && r[0].kind === 'error') return { ctx, params, ret: 'Result<void, GoError>' };
  if (r.length === 2 && r[1].kind === 'error') {
    const ok = candorType(r[0], types);
    return ok ? { ctx, params, ret: `Result<${ok}, GoError>` } : cannotCross(r[0], types);
  }
  if (r.length === 2 && r[1].kind === 'bool') {
    const ok = candorType(r[0], types);
    return ok ? { ctx, params, ret: `${ok}?` } : cannotCross(r[0], types);
  }
  if (r.length > 1) return `a Go function with results (${r.map((t) => t.text).join(', ')}) can't be bound yet`;
  const ret = candorType(r[0], types);
  return ret ? { ctx, params, ret } : cannotCross(r[0], types);
}

function paramName(name: string, i: number): string {
  if (name === '' || name === '_') return `arg${i + 1}`;
  // A bare `ctx` first means a context, so a Go parameter of that name needs another.
  if (keywords.has(name) || name === 'ctx') return `${name}Value`;
  return name;
}

/** `Comma` → `comma`, `URLEncode` → `urlEncode`, `IBytes` → `iBytes`, `SI` → `si`. */
export function candorName(goName: string): string {
  const run = /^[A-Z]+/.exec(goName)?.[0] ?? '';
  let name: string;
  if (run.length === goName.length) name = goName.toLowerCase();
  else if (run.length > 1 && /[a-z]/.test(goName[run.length])) name = run.slice(0, -1).toLowerCase() + goName.slice(run.length - 1);
  else name = run.toLowerCase() + goName.slice(run.length);
  return keywords.has(name) ? `${name}Go` : name;
}

/** `DB` → `Db`, `Rows` → `Rows`, `IPNet` → `IpNet`; `Result` → `GoResult`, which Candor has already. */
function candorTypeName(goName: string): string {
  const n = candorName(goName).replace(/Go$/, '');
  const name = n[0].toUpperCase() + n.slice(1);
  return builtinTypeNames.has(name) ? `Go${name}` : name;
}

const builtinTypeNames = new Set(['Result', 'Ok', 'Err', 'Option', 'Some', 'None', 'List', 'Map', 'Scope', 'Task', 'Self', 'Eq', 'Ord', 'GoError']);

/**
 * A binding module for a Go package, for a human or an AI to finish: every function that fits
 * is `unvetted`, so the checker refuses the draft until each one is decided. Go's types, and
 * the functions and methods that take or give them, are drafted inside the effect.
 */
export function draft(pkg: GoPackage, opts: { module: string; goPath: string; version: string | null }): string {
  const spec = opts.version ? `${opts.goPath}@${opts.version}` : opts.goPath;
  const pure: string[] = [];
  const own: string[] = [];
  const skipped: string[] = [];
  const doc = (into: string[], text: string | undefined, pad: string) => {
    if (text) into.push(...wrap(text, 96 - pad.length).map((l) => `${pad}// ${l}`));
  };
  // The types a function takes or gives, and those their methods do. Structs are held by
  // pointer, as their methods mostly want; interfaces as themselves.
  const named = (f: GoFunc) => [...f.params.map((p) => p.type), ...f.results].flatMap((t) => (t.kind === 'named' && t.pkg === pkg.path ? [t.name!] : []));
  const wanted = new Set(pkg.funcs.flatMap(named));
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of pkg.types) {
      if (!wanted.has(t.name)) continue;
      for (const n of t.methods.flatMap(named)) {
        if (wanted.has(n)) continue;
        wanted.add(n);
        grew = true;
      }
    }
  }
  const declared = pkg.types.filter((t) => t.kind !== 'other' && wanted.has(t.name));
  const types: GoNames = new Map(declared.map((t) => [`${pkg.path}.${t.name}`, { name: candorTypeName(t.name), pointer: t.kind === 'struct' }]));
  const mentions = (f: GoFunc) => [...f.params.map((p) => p.type), ...f.results].some((t) => t.kind === 'named' && types.has(`${t.pkg}.${t.name}`));
  const fnLine = (f: GoFunc, sig: CandorSig, head: string, name: string) => {
    const params = [...(sig.ctx ? ['ctx'] : []), ...sig.params.map((p) => `${p.name}: ${p.type}`)].join(', ');
    return `unvetted fn ${head}${f.name}(${params})${sig.ret ? ` -> ${sig.ret}` : ''} as ${name}`;
  };
  const variadic = 'variadic: bind it at the arity you call it with, as in `...(id: int, name: string)`';
  for (const f of pkg.funcs) {
    const sig = f.variadic ? variadic : candorSignature(f, types);
    if (typeof sig === 'string') {
      skipped.push(`${f.name}${f.text.slice('func'.length)}: ${sig}`);
      continue;
    }
    const into = mentions(f) ? own : pure;
    const pad = into === own ? '    ' : '  ';
    doc(into, f.doc, pad);
    into.push(pad + fnLine(f, sig, '', candorName(f.name)));
  }
  for (const t of declared) {
    const { name, pointer } = types.get(`${pkg.path}.${t.name}`)!;
    doc(own, t.doc, '    ');
    own.push(`    type ${pointer ? '*' : ''}${t.name}${name !== t.name ? ` as ${name}` : ''}`);
    const self = candorName(t.name);
    for (const m of t.methods) {
      const sig = m.variadic ? variadic : candorSignature(m, types);
      if (typeof sig === 'string') {
        skipped.push(`${t.name}.${m.name}${m.text.slice('func'.length)}: ${sig}`);
        continue;
      }
      doc(own, m.doc, '    ');
      own.push('    ' + fnLine(m, sig, `(${self}: ${name}) `, `${self}${m.name}`));
    }
  }
  for (const v of pkg.values) {
    // A constant never changes, and an error variable is a sentinel to compare with; other
    // variables are global state.
    const crosses = v.type.kind === 'error' ? 'GoError' : candorType(v.type, new Map());
    const type = v.type.kind === 'error' || v.const ? crosses : null;
    if (!type) {
      skipped.push(`${v.name} ${v.type.text}: ${crosses ? 'a Go variable is global state; bind a function that reads it instead' : `a ${v.type.text} can't cross into Candor yet`}`);
      continue;
    }
    doc(pure, v.doc, '  ');
    pure.push(`  let ${v.name}: ${type} as ${candorName(v.name)}`);
  }
  const out = [
    `module ${opts.module}`,
    '',
    `// A draft binding for ${spec}, made by \`candor bind\`. To finish it:`,
    '// - Vet each `unvetted fn`. If the Go function does no I/O, keeps no global state, never',
    "//   blocks and can't exit the program, delete `unvetted`. Otherwise move it into",
    `//   \`effect ${opts.module} { ... }\`, with a \`fake ${opts.module}\` for tests.`,
    "// - Delete what you don't need.",
  ];
  if (own.length > 0) {
    out.push(
      "// - Go's types live inside the effect, with what takes or gives them: write operations",
      '//   there that give Candor values, and a fake with the same operations. Where Go may give',
      '//   nil, write `T?`.',
    );
  }
  if (pure.length > 0) out.push('', `pub extern "${spec}" {`, ...pure, '}');
  if (own.length > 0) out.push('', `effect ${opts.module} {`, `  extern "${spec}" {`, ...own, '  }', '}');
  if (skipped.length > 0) out.push('', "// Not bound, because they can't cross yet:", ...skipped.map((s) => `// - ${s}`));
  return out.join('\n') + '\n';
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
