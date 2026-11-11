import type * as ast from './ast';
import type { CheckResult, Embed, FnSig, Impl, SqlFunctionUse, StateVar, TaskCall, UserEffect } from './checker';
import { implKey } from './checker';
import { builtinEffects } from './effects';
import type { Pos, Span } from './diagnostics';
import { builtinTypes, Eq, exitType, flagField, flagName, isSqlQuery, signalType, Json, jsonName, Ord, ordered, Row, Show, shown, paramsIn, subst, T, typeKey, typeToString, type Field, type FnType, type StructType, type ParamType, type Trait, type Type, type UserType } from './types';

export interface EmitOptions {
  /** Shown in test reports. */
  file: string;
  /** `main` runs the program; `test` runs its `test` blocks instead. */
  mode: 'main' | 'test';
  /** The program calls `fs.watch`, so `main` builds std/watchgo (and fsnotify). */
  watch?: boolean;
}

/** A module to emit, with what the checker found. */
export interface EmitUnit {
  mod: ast.Module;
  info: CheckResult;
  file: string;
  /** The module's own source, for the text its contracts show. */
  source: string;
  /** The module's test file, whose line 1 is the module's line `from + 1`. */
  tests?: { file: string; from: number };
  /** A standard module, from `std/`: some of its functions get their bodies from the compiler. */
  std?: boolean;
}

/** Turns an `extern` path into a Go import path; `from` is the file declaring it. */
export type GoImportPath = (goPath: string, from: string) => string;

/**
 * Emits one Go `package main` for a whole program: every module, dependencies first, the entry
 * last. Names are prefixed with their module, so modules can't collide. The output is a compilation target, not something to read:
 * the checker has already enforced everything Candor promises, Go just has to build it.
 *
 * Candor has expressions Go lacks (`if` and `match` as values). Those are lowered into
 * statements that run before the statement containing them, collected in `pre`. Every name the
 * emitter makes up contains `__`, which Candor source cannot.
 *
 * Structs become Go structs. An enum becomes one Go struct with a `tag__` and every variant's
 * fields (`Paid__at`), so constructing and matching never allocates and every test is an
 * expression. `T?` is `opt__[T]` and `Result<T, E>` is `res__[T, E]`, both plain structs. Fields
 * that lead back to their own type are pointers. Generic types and functions are Go generics,
 * and every use spells out its type arguments, so Go never has to infer one.
 *
 * A bound is a dictionary: `fn f<T: Ord>` becomes `func f[T__ any, T__Ord Ord__[T__]]`, and
 * `a < b` on a `T` calls `compare` on the zero value of `T__Ord`. Every dictionary is a type
 * without fields: `ordGo__[int64]` for an int, `Ord__for__m__User` for an `impl`, so calls
 * pass nothing at run time. A trait is a Go interface over `Self__`.
 *
 * In test mode each `test` block becomes a function that builds its own fakes, and `main` hands
 * them all to the runtime's runner. Every type gets a `Show__` method so failures print values
 * as Candor would write them.
 */
/** A file `embed` builds in, copied from `from` to `to` in the build's module. */
export interface EmbedFile {
  from: string;
  to: string;
}

export function emitGo(units: EmitUnit[], options: EmitOptions, goImport: GoImportPath): { main: string; bindings: string | null; embeds: EmbedFile[] } {
  return new GoEmitter(units, options, goImport).emit();
}

class GoEmitter {
  /** Go standard packages the code needs; filled while emitting bodies. */
  private imports = new Set<string>();
  /** The module being emitted, what the checker found in it, its file, for `//line`, and its source. */
  private mod: ast.Module;
  private info: CheckResult;
  private file: string;
  private source: string;
  private tests: EmitUnit['tests'];
  /** Statements that must run before the statement being emitted. */
  private pre: string[] = [];
  private temps = 0;
  private needsPtr = false;
  private needsOpt = false;
  private needsRes = false;
  /** The built-in types (`Exit`, `Signal`) named somewhere: each Go type is declared once. */
  private usesBuiltin = new Set<UserType>();
  /** The return type of the function being emitted, for `?` and `return`. */
  private fnRet: Type = { kind: 'unit' };
  /** In a test's body: a Go function with no result, unlike every Candor function. */
  private goVoid = false;
  /** The callee of the call being emitted: a method of a built-in effect called directly needs no wrapper. */
  private callee: ast.Expr | null = null;
  /** While emitting an `assert`: the parts whose values a failure shows, and where they go. */
  private recording: { values: string; slots: Map<ast.Expr, number> } | null = null;
  private readonly helpers = new Set<keyof typeof goHelpers>();
  /** The Go variable of each embedded file, by `bytes:file`. */
  private readonly embedVars = new Map<string, { name: string; embed: Embed }>();
  /** `let mut` maps and lists read in place, as a lookup or method receiver: not shared (see `mapRef`, `listRef`). */
  private readonly inPlace = new Set<ast.Ident>();
  /**
   * `let mut` lists of this function that are written by index, so each has an `x__own` flag
   * next to it (see `set__`). Names can't be shadowed, so a name is one variable per function.
   */
  private tracked = new Set<string>();
  /** Inside a fake's function: its state by name, read and written in place on the fake (`f__.x`). */
  private stateRefs: Map<string, string> | null = null;
  /** Equality functions by Candor type, and their declarations. */
  private readonly eqNames = new Map<string, string>();
  private readonly eqDecls: string[] = [];
  private readonly testing: boolean;
  /** std/watchgo's import path, once `fs.watch`'s body uses it. */
  private watchGo: string | null = null;
  /** std/xmlgo's import path, once `xml.elements`' body uses it. */
  private xmlGo: string | null = null;
  /** Types get `Show__` when a failure may print them: in tests, and wherever a contract is. */
  private readonly showing: boolean;

  constructor(
    private readonly units: EmitUnit[],
    private readonly options: EmitOptions,
    private readonly goImport: GoImportPath,
  ) {
    this.testing = options.mode === 'test';
    const contracted = (d: ast.Decl) => (d.kind === 'FnDecl' ? d.contracts.length > 0 : d.kind === 'ImplDecl' && d.fns.some((f) => f.contracts.length > 0));
    this.mod = units.at(-1)!.mod;
    this.info = units.at(-1)!.info;
    this.file = units.at(-1)!.file;
    this.source = units.at(-1)!.source;
    this.tests = units.at(-1)!.tests;
    // An `Err` from `main` is printed too.
    this.showing = this.testing || units.some((u) => u.mod.decls.some(contracted)) || this.info.fns.get('main')?.ret.kind === 'result';
  }

  private enter(unit: EmitUnit) {
    this.mod = unit.mod;
    this.info = unit.info;
    this.file = unit.file;
    this.source = unit.source;
    this.tests = unit.tests;
  }

  /** `file:line` of a line of the module: its test file's own line past `tests.from`. */
  private where(line: number): string {
    return this.tests && line > this.tests.from ? `${this.tests.file}:${line - this.tests.from}` : `${this.file}:${line}`;
  }

  /**
   * Marks each of `lines` with the Candor line `span` starts on, so a panic there names it.
   * Go's `//line` directive positions the next line only, and lines after it count on from
   * there, so every line gets one; a line already marked (a nested statement's) keeps its own.
   */
  private at(span: Span, lines: string[]): string[] {
    const directive = `//line ${this.where(span.start.line)}`;
    const out: string[] = [];
    let marked = false;
    for (const l of lines) {
      if (isLineDirective(l)) {
        marked = true;
      } else if (!marked) {
        out.push(directive);
      } else {
        marked = false;
      }
      out.push(l);
    }
    return out;
  }

  /** The variable `embed` reads, one per file and kind. */
  private embedVar(embed: Embed): string {
    const key = `${embed.bytes}:${embed.file}`;
    let v = this.embedVars.get(key);
    if (!v) {
      v = { name: `embed__${this.embedVars.size + 1}`, embed };
      this.embedVars.set(key, v);
    }
    return v.name;
  }

  emit(): { main: string; bindings: string | null; embeds: EmbedFile[] } {
    const bindings = this.bindingsFile();
    const body: string[] = [];
    const inits: string[] = [];
    for (const unit of this.units) {
      this.enter(unit);
      if (this.info.effect) {
        body.push('', ...this.effectDecl(this.info.effect));
        // Helpers are plain functions: they see no state, so they need no receiver.
        for (const h of this.info.effect.decl.helpers) if (this.info.fns.get(h.name)?.decl === h) body.push('', ...this.fnDecl(h));
      }
      for (const trait of this.info.traits.values()) body.push('', ...this.traitDecl(trait));
      for (const impl of this.info.ownImpls) body.push('', ...this.implDecl(impl));
      for (const decl of this.mod.decls) if (decl.kind === 'ConstDecl') body.push('', this.constDecl(decl));
      // In the checker's order, each after the consts it names; units come after their imports.
      for (const decl of this.info.varConsts) inits.push(`\t${this.fnName(decl.name)} = ${this.expr(decl.value)}`);
      for (const decl of this.mod.decls) if (decl.kind === 'FnDecl' && (decl.test === undefined || this.testing)) body.push('', ...this.fnDecl(decl));
    }
    if (inits.length > 0) body.push('', 'func init() {', ...inits, '}');
    const tests = this.testing ? this.info.tests : [];
    tests.forEach((t, i) => body.push('', ...this.testDecl(t, i + 1)));
    const types = [...this.units.flatMap((u) => u.info.userTypes), ...builtinTypes.filter((t) => this.usesBuiltin.has(t))].flatMap((t) => ['', ...this.typeDecl(t), ...(this.showing && !isSqlQuery(t) ? this.showUserType(t) : [])]);
    const imports = [...this.imports].sort().map((p) => `\t"${p}"`);
    imports.push('\tcandor "candor.dev/runtime"');
    if (this.watchGo) imports.push(`\twatchgo "${this.watchGo}"`);
    if (this.xmlGo) imports.push(`\txmlgo "${this.xmlGo}"`);
    // Each embedded file is a variable Go fills from a copy in the build.
    const embeds = [...this.embedVars.values()];
    if (embeds.length > 0) imports.push('\t_ "embed"');
    const embedDecls = embeds.flatMap(({ name, embed }) => ['', `//go:embed ${embedPath(name)}`, `var ${name} ${embed.bytes ? '[]byte' : 'string'}`]);
    let main: string[];
    if (this.testing) {
      main = [
        `\tcandor.RunTests(${goQuote(this.options.file)}, []candor.Test{`,
        ...tests.map((t, i) => `\t\t{Name: ${goQuote(t.name)}, Fn: test__${i + 1}},`),
        '\t})',
      ];
    } else {
      // An effect with state is built when `main` starts.
      const realEffects = this.info.fns.get('main')!.uses.map(
        (u) => builtinEffects.get(u)?.go.construct ?? (runtimeEffects[u]?.real ?? (this.info.effects.get(u)!.ownState.length > 0 ? `${effectType(u)}__newReal(${CTX})` : `${effectType(u)}__real{}`)),
      );
      // A panic that gets out of `main` is reported with its Candor frames.
      main = ['\tdefer candor.Report()'];
      const call = realEffects.some((e) => e.includes(CTX))
        ? [`\t${CTX} := candor.Root()`, `${this.fnName('main')}(${[CTX, ...realEffects].join(', ')})`]
        : [`${this.fnName('main')}(${['candor.Root()', ...realEffects].join(', ')})`];
      const last = call.pop()!;
      main.push(...call);
      // `main` returning a Result: an `Err` is printed on stderr and the status is 1, or the
      // `Exit`'s own.
      const ret = this.info.fns.get('main')!.ret;
      const exit = ret.kind === 'result' && ret.err.kind === 'struct' && ret.err.origin === exitType ? 'candor.ExitWith(int(r.err.status), r.err.message)' : 'candor.ExitErr(r.err)';
      if (ret.kind === 'result') main.push(`\tif r := ${last}; !r.ok {`, `\t\t${exit}`, '\t}');
      else main.push(`\t${last}`);
    }
    const show = (recv: string, lines: string[]) => (this.showing ? ['', `func (v ${recv}) Show__() string {`, ...lines, '}'] : []);
    const helpers = [
      ...(this.needsOpt ? ['', 'type opt__[T any] struct {', '\tsome  bool', '\tvalue T', '}'] : []),
      ...(this.needsOpt
        ? show('opt__[T]', ['\tif !v.some {', '\t\treturn "none"', '\t}', '\treturn candor.Show(v.value)'])
        : []),
      ...(this.needsRes ? ['', 'type res__[T any, E any] struct {', '\tok    bool', '\tvalue T', '\terr   E', '}'] : []),
      ...(this.needsRes
        ? show('res__[T, E]', [
            '\tif _, void := any(v.value).(struct{}); void && v.ok {',
            '\t\treturn "Ok()"',
            '\t}',
            '\tif v.ok {',
            '\t\treturn "Ok(" + candor.Show(v.value) + ")"',
            '\t}',
            '\treturn "Err(" + candor.Show(v.err) + ")"',
          ])
        : []),
      ...(this.needsPtr
        ? ['', '// Values are immutable, so a shared pointer behaves like a copy.', 'func ptr__[T any](v T) *T {', '\treturn &v', '}']
        : []),
      ...[...this.helpers].sort().flatMap((h) => ['', ...goHelpers[h]]),
      ...this.eqDecls,
      ...embedDecls,
    ];
    const mainFile = [
      `// Code generated by candor from module ${this.mod.name}. DO NOT EDIT.`,
      'package main',
      '',
      ...(imports.length > 0 ? ['import (', ...imports, ')', ''] : []),
      'func main() {',
      ...main,
      '}',
      ...types,
      ...body,
      // The helpers are Go's own again.
      LINE_RESET,
      ...helpers,
      '',
    ];
    return { main: withLineDirectives(mainFile, 'main.go'), bindings, embeds: embeds.map(({ name, embed }) => ({ from: embed.file, to: embedPath(name) })) };
  }

  /**
   * Every `extern` function becomes a Go function with the Candor signature, like any other, so
   * calls and function values need nothing special. It calls the Go function through a generic
   * adapter: Go infers the adapter's type parameters from the Go function, so a Candor `int`
   * reaches a Go `int`, `int64` or `uint8` alike, and a signature that doesn't fit is a Go type
   * error in this file.
   */
  private bindingsFile(): string | null {
    const saved = this.imports;
    this.imports = new Set();
    const aliases = new Map<string, string>();
    // `extern "modernc.org/sqlite@v1.29.0" {}`: imported for what it does when loaded.
    const blank = new Set<string>();
    const lines: string[] = [];
    for (const unit of this.units) {
      this.enter(unit);
      const externs = unit.mod.decls.flatMap((d) => (d.kind === 'ExternDecl' ? [d] : d.kind === 'EffectDecl' ? d.externs : []));
      for (const decl of externs) {
        const goPath = this.goImport(decl.goPath, unit.file);
        if (decl.items.length === 0) {
          blank.add(goPath);
          continue;
        }
        let alias = aliases.get(goPath);
        if (!alias) {
          alias = `go__${aliases.size + 1}`;
          aliases.set(goPath, alias);
        }
        for (const item of decl.items) {
          const go = item.kind === 'ExternFn' ? this.externFn(item, alias) : item.kind === 'ExternLet' ? this.externLet(item, alias) : this.externType(item, alias);
          // Go's errors about the Go symbol point at the `extern` line, then the file continues as itself.
          const at = go.findIndex((l) => l.includes(`${alias}.`) && l.includes(`.${item.goName}`));
          go.splice(at, 1, `//line ${this.where(item.goNameSpan.start.line)}`, go[at], LINE_RESET);
          const recv = item.kind === 'ExternFn' && item.receiver ? `${item.receiver.type.kind === 'TypeName' ? (this.info.opaques.get(item.receiver.type.name)?.goName ?? '') : ''}.` : '';
          lines.push('', `// ${decl.goPath}.${recv}${item.goName}`, ...go);
        }
      }
    }
    const imports = [...this.imports].sort().map((p) => `\t"${p}"`);
    this.imports = saved;
    if (aliases.size === 0 && blank.size === 0) return null;
    imports.push(...[...aliases].map(([goPath, alias]) => `\t${alias} "${goPath}"`));
    imports.push(...[...blank].filter((p) => !aliases.has(p)).map((p) => `\t_ "${p}"`));
    if (lines.some((l) => l.includes('candor.'))) imports.push('\tcandor "candor.dev/runtime"');
    const file = [`// Code generated by candor: the Go side of every \`extern\`. DO NOT EDIT.`, 'package main', '', 'import (', ...imports, ')', ...lines, ''];
    return withLineDirectives(file, 'bindings.go');
  }

  /**
   * With `ctx`, the Go function gets a `context.Context` that is cancelled with the task, and
   * the task stops as soon as the call returns.
   */
  private externFn(item: ast.ExternFn, alias: string): string[] {
    const sig = this.info.fns.get(item.name)!;
    const name = this.fnName(item.name);
    const params = sig.params.map((p, i) => ({ name: `a${i}`, type: p.type }));
    const fixed = params.length - (item.spread?.length ?? 0);
    // A GoError goes in as Go's `error`, a Go type as itself; everything else through a type
    // parameter Go infers. What goes into Go's variadic parameter is converted to its type.
    const typeParams: string[] = [];
    const goParams: string[] = [];
    const goArgs: string[] = [];
    params.forEach((p, i) => {
      if (i >= fixed) {
        goArgs.push(`candor.Arg[V](${this.toGo(p.type, p.type.kind === 'goerror' ? `${p.name}.Err` : p.name)})`);
      } else if (p.type.kind === 'goerror') {
        goParams.push('error');
        goArgs.push(`${p.name}.Err`);
      } else if (p.type.kind === 'opaque') {
        goParams.push(this.goType(p.type));
        goArgs.push(p.name);
      } else {
        typeParams.push(`A${i} ${this.goConstraint(p.type)}`);
        goParams.push(`A${i}`);
        goArgs.push(`A${i}(${this.toGo(p.type, p.name)})`);
      }
    });
    if (item.spread) {
      typeParams.push('V any');
      goParams.push('...V');
    }
    const decl = params.map((p) => `${p.name} ${this.goType(p.type)}`);
    if (item.ctx) {
      this.imports.add('context');
      // Go's context comes first, after a method's receiver.
      const at = item.receiver ? 1 : 0;
      goParams.splice(at, 0, 'context.Context');
      goArgs.splice(at, 0, 'c');
      decl.unshift('c context.Context');
    }
    const ret = sig.ret;
    const goRet = ` ${this.goType(ret)}`;
    // How Go gives a value of type `t`: a Go type as itself, anything else as a type parameter.
    const result = (t: Type) => {
      if (t.kind === 'opaque') return this.goType(t);
      typeParams.push(`R ${this.goConstraint(t)}`);
      return 'R';
    };
    // A Go type held by pointer: Go must not give nil where the binding says it never does.
    const notNil = (t: Type, v: string) =>
      t.kind === 'opaque' && t.pointer
        ? [`if ${v} == nil {`, `\tpanic(${goQuote(`candor: ${item.goName} gave nil, but its binding says ${typeToString(t, this.mod.name)}; write ${typeToString(t, this.mod.name)}? if it can`)})`, '}']
        : [];
    const call = `f(${goArgs.join(', ')})`;
    let fType: string;
    let body: string[];
    if (ret.kind === 'unit') {
      fType = `func(${goParams.join(', ')})`;
      body = [call, `return ${VOID}`];
    } else if (ret.kind === 'result' && ret.ok.kind === 'unit') {
      // A Go function that returns only an `error`.
      fType = `func(${goParams.join(', ')}) error`;
      const t = this.goType(ret);
      body = [`if err := ${call}; err != nil {`, `\treturn ${t}{err: candor.GoError{Err: err}}`, '}', `return ${t}{ok: true}`];
    } else if (ret.kind === 'result') {
      fType = `func(${goParams.join(', ')}) (${result(ret.ok)}, error)`;
      const t = this.goType(ret);
      body = [
        `v, err := ${call}`,
        'if err != nil {',
        `\treturn ${t}{err: candor.GoError{Err: err}}`,
        '}',
        ...notNil(ret.ok, 'v'),
        `return ${t}{ok: true, value: ${this.fromGo(ret.ok, 'v', item.goName)}}`,
      ];
    } else if (ret.kind === 'option' && ret.inner.kind === 'opaque' && ret.inner.pointer) {
      // A pointer that may be nil.
      fType = `func(${goParams.join(', ')}) ${this.goType(ret.inner)}`;
      const t = this.goType(ret);
      body = [`v := ${call}`, 'if v == nil {', `\treturn ${t}{}`, '}', `return ${t}{some: true, value: v}`];
    } else if (ret.kind === 'option') {
      // `(T, bool)`: the value, and whether there is one.
      fType = `func(${goParams.join(', ')}) (${result(ret.inner)}, bool)`;
      const t = this.goType(ret);
      body = [`v, ok := ${call}`, 'if !ok {', `\treturn ${t}{}`, '}', `return ${t}{some: true, value: ${this.fromGo(ret.inner, 'v', item.goName)}}`];
    } else {
      fType = `func(${goParams.join(', ')}) ${result(ret)}`;
      body = notNil(ret, 'v').length > 0 ? [`v := ${call}`, ...notNil(ret, 'v'), 'return v'] : [`return ${this.fromGo(ret, call, item.goName)}`];
    }
    const generic = typeParams.length > 0 ? `[${typeParams.join(', ')}]` : '';
    // A method, by Go's method expression: `(*sql.DB).Query` is a function taking the DB first.
    const recv = sig.params[0]?.type;
    const target = item.receiver && recv.kind === 'opaque' ? `(${recv.pointer ? '*' : ''}${alias}.${recv.goName}).${item.goName}` : `${alias}.${item.goName}`;
    const adapt = `${name}__go(${[target, ...(item.ctx ? [`${CTX}.Context()`] : []), ...params.map((p) => p.name)].join(', ')})`;
    const wrapper = !item.ctx ? [`return ${adapt}`] : [`r := ${adapt}`, `${CTX}.Check()`, 'return r'];
    return [
      `func ${name}(${[`${CTX} *candor.Ctx`, ...params.map((p) => `${p.name} ${this.goType(p.type)}`)].join(', ')})${goRet} {`,
      ...indent(wrapper),
      '}',
      '',
      `func ${name}__go${generic}(${[`f ${fType}`, ...decl].join(', ')})${goRet} {`,
      ...indent(body),
      '}',
    ];
  }

  /** `type *DB as Db`: a Go alias, so the rest of the program names it without importing Go's package. */
  private externType(item: ast.ExternType, alias: string): string[] {
    const t = this.info.opaques.get(item.name)!;
    return [`type ${this.goType(t)} = ${item.pointer ? '*' : ''}${alias}.${item.goName}`];
  }

  /** A Go package variable, read each time: Go code may change it. */
  private externLet(item: ast.ExternLet, alias: string): string[] {
    const v = this.info.values.get(item.name)!;
    const go = `${alias}.${item.goName}`;
    const value = v.type.kind === 'goerror' ? `candor.GoError{Err: ${go}}` : this.fromGo(v.type, go, item.goName);
    return [`func ${this.fnName(item.name)}() ${this.goType(v.type)} {`, `\treturn ${value}`, '}'];
  }

  /** What a Go type must be like to stand for a Candor type in a binding. */
  private goConstraint(t: Type): string {
    switch (t.kind) {
      case 'int':
        return 'candor.Integer';
      case 'float':
        return 'candor.Float';
      case 'list':
        return '~[]string';
      default:
        return `~${this.goType(t)}`;
    }
  }

  /** A Candor value on its way into Go. Lists and Bytes are copied: Go code may change them. */
  private toGo(t: Type, v: string): string {
    if (t.kind !== 'list' && t.kind !== 'bytes') return v;
    this.imports.add('slices');
    return `slices.Clone(${v})`;
  }

  /** A Go value on its way into Candor, from the Go function or variable `goName`. */
  private fromGo(t: Type, v: string, goName: string): string {
    if (t.kind === 'opaque') return v;
    // A Candor float is never NaN or infinite.
    if (t.kind === 'float') return `candor.FromGoFloat(float64(${v}), ${goQuote(goName)})`;
    // Go keeps its slice and may change it later; Bytes never change.
    if (t.kind === 'list' || t.kind === 'bytes') {
      this.imports.add('slices');
      return `slices.Clone(${this.goType(t)}(${v}))`;
    }
    return `${this.goType(t)}(${v})`;
  }

  private typeDecl(t: UserType): string[] {
    const name = `${this.typeName(t)}${typeParamList(t.params)}`;
    // Made by the compiler from a string literal: its text and parameters.
    if (isSqlQuery(t)) return [`type ${name} = candor.SQLQuery`];
    if (t.kind === 'struct') {
      return [
        `type ${name} struct {`,
        ...t.fields.map((f) => `\t${goIdent(f.name)} ${f.boxed ? '*' : ''}${this.goType(f.type)}`),
        '}',
      ];
    }
    const fields = t.variants.flatMap((v) =>
      v.fields.map((f) => `\t${variantField(v.name, f.name)} ${f.boxed ? '*' : ''}${this.goType(f.type)}`),
    );
    return [
      `// enum ${t.name}: ${t.variants.map((v) => `${v.index} ${v.name}`).join(', ')}`,
      `type ${name} struct {`,
      '\ttag__ uint16',
      ...fields,
      '}',
    ];
  }

  /** `Show__`: the value as Candor source would write it, for test failures. */
  private showUserType(t: UserType): string[] {
    const fields = (prefix: string, fs: { name: string; boxed: boolean }[], goName: (f: string) => string) => {
      if (fs.length === 0) return goQuote(prefix);
      const parts = fs.map((f, i) => {
        const label = goQuote(`${i === 0 ? `${prefix} { ` : ', '}${f.name}: `);
        return `${label} + candor.Show(${f.boxed ? '*' : ''}v.${goName(f.name)})`;
      });
      return `${parts.join(' + ')} + " }"`;
    };
    const lines =
      t.kind === 'struct'
        ? [`\treturn ${t.fields.length === 0 ? goQuote(`${t.name} {}`) : fields(t.name, t.fields, goIdent)}`]
        : [
            '\tswitch v.tag__ {',
            ...t.variants.flatMap((variant, i) => [
              i === t.variants.length - 1 ? '\tdefault:' : `\tcase ${variant.index}:`,
              `\t\treturn ${fields(`${t.name}.${variant.name}`, variant.fields, (f) => variantField(variant.name, f))}`,
            ]),
            '\t}',
          ];
    return ['', `func (v ${this.goType(t)}) Show__() string {`, ...lines, '}'];
  }

  /** A `test` block: a function that builds a fresh fake for every effect. The runner gives it a test scheduler. */
  private testDecl(t: ast.TestDecl, n: number): string[] {
    this.temps = 0;
    this.tracked.clear();
    this.fnRet = { kind: 'unit' };
    this.goVoid = true;
    const fakes = [
      ...[...builtinEffects].map(([name, def]) => [name, def.fake.construct]),
      ...[...this.info.effects.keys()].map((name) => [name, runtimeEffects[name]?.fake ?? `${effectType(name)}__newFake(${CTX})`]),
    ].flatMap(([name, construct]) => [`${goIdent(name)} := ${construct}`, `_ = ${goIdent(name)}`]);
    // A fake that uses other effects gets this test's fakes of them.
    for (const [name, fx] of this.info.effects) {
      if (runtimeEffects[name]) continue;
      for (const u of fakeUses(fx)) fakes.push(`${goIdent(name)}.uses__${u} = ${goIdent(u)}`);
    }
    const body = this.block(t.body, null);
    this.goVoid = false;
    return [`// test ${goQuote(t.name)}`, `func test__${n}(${CTX} *candor.Ctx) {`, ...indent([...fakes, ...body]), '}'];
  }

  private fnDecl(decl: ast.FnDecl): string[] {
    const sig = this.info.fns.get(decl.name)!;
    // The context, then effects, as hidden parameters; a `test fn` gets the test's fakes as they are.
    const params = [
      `${CTX} *candor.Ctx`,
      ...sig.uses.map((u) => `${goIdent(u)} ${decl.test ? fakeType(u) : capType(u)}`),
      ...sig.params.map((p) => `${goIdent(p.name)} ${this.goType(p.type)}`),
    ];
    this.temps = 0;
    this.tracked.clear();
    this.fnRet = sig.ret;
    const given = this.unitStd() ? this.stdBody(decl.name, sig) : null;
    const body = given ?? this.contracted(decl, decl.name, sig.ret, this.fnBody(this.block(decl.body, null), sig.ret));
    return [`func ${this.fnName(decl.name)}${this.fnTypeParams(sig.typeParams)}(${params.join(', ')}) ${this.goType(sig.ret)} {`, ...indent(body), '}'];
  }

  private unitStd(): boolean {
    return this.units.find((u) => u.mod === this.mod)?.std === true;
  }

  /** The bodies of standard functions written in Go: `json.encode`, `json.decode`, `http.serve`, `sql`'s. */
  private stdBody(name: string, sig: FnSig): string[] | null {
    if (this.mod.name === 'http') return this.httpBody(name, sig);
    if (this.mod.name === 'sql') return this.sqlBody(name, sig);
    if (this.mod.name === 'fs') return this.fsBody(name, sig);
    if (this.mod.name === 'bytes') return this.bytesBody(name, sig);
    if (this.mod.name === 'hash') return this.hashBody(name, sig);
    if (this.mod.name === 'time') return this.timeBody(name, sig);
    if (this.mod.name === 'xml') return name === 'scan' ? this.xmlScan(sig) : null;
    if (this.mod.name === 'exec') return name === 'rawText' ? [`return string(${goIdent(sig.params[0].name)})`] : null;
    if (this.mod.name !== 'json') return null;
    const [t] = sig.typeParams;
    const args = `[${typeParamName(t)}, ${dictParam(t, Json)}]`;
    if (name === 'encode') return [`return candor.JsonEncode${args}(${CTX}, ${goIdent(sig.params[0].name)})`];
    if (name === 'encodeIndented') return [`return candor.JsonIndent(candor.JsonEncode${args}(${CTX}, ${goIdent(sig.params[0].name)}))`];
    const res = this.goType(sig.ret);
    if (name === 'decodeFrom') {
      // The reader to its end, then `decode`; both errors as text, as `Error` shows one.
      return [
        `all, rerr := candor.ReadAll(${CTX}, ${this.pullOf(goIdent(sig.params[0].name))})`,
        'if rerr != nil {',
        `\treturn ${res}{err: rerr.Error()}`,
        '}',
        `v, err := candor.JsonDecode${args}(${CTX}, string(all), false)`,
        'if err != nil {',
        `\treturn ${res}{err: err.Path + ": " + err.Message}`,
        '}',
        `return ${res}{ok: true, value: v}`,
      ];
    }
    if (name !== 'decode' && name !== 'decodeStrict') return null;
    const error = sig.ret.kind === 'result' ? this.goType(sig.ret.err) : '';
    return [
      `v, err := candor.JsonDecode${args}(${CTX}, ${goIdent(sig.params[0].name)}, ${name === 'decodeStrict'})`,
      'if err != nil {',
      `\treturn ${res}{err: ${error}{${goIdent('path')}: err.Path, ${goIdent('message')}: err.Message}}`,
      '}',
      `return ${res}{ok: true, value: v}`,
    ];
  }

  /**
   * `http`'s functions written in Go. `serveWith`: `candor.Serve` with the handler converted to
   * the runtime's request and response; tests don't serve (their tasks run on the scheduler, and
   * a handler is called directly). A streamed body's function lives in the runtime's table
   * (`candor.PutStream`), and the struct holds its id, so requests and responses stay values `==`
   * compares. `streamResponse` keeps `write` there, effects and all: Go's function types don't
   * carry them, and the handler that calls it has them.
   */
  private httpBody(name: string, sig: FnSig): string[] | null {
    const f = (n: string) => goIdent(n);
    const [a, b, c] = sig.params.map((p) => goIdent(p.name));
    const res = this.goType(sig.ret);
    // A Candor `fn(fn(string))` as the runtime's `func(*Ctx, func(string))`.
    const toGo = (s: string) => `func(c *candor.Ctx, w func(string)) { ${s}(c, func(_ *candor.Ctx, x string) struct{} { w(x); return struct{}{} }) }`;
    const streamType = this.goType({ kind: 'option', inner: T.int });
    // The private `queryAll`, `headersAll` and `more`: `Map<string, List<string>>?`.
    const repeats = this.goType({ kind: 'option', inner: { kind: 'map', key: T.string, value: { kind: 'list', elem: T.string } } as Type });
    switch (name) {
      case 'serveWith': {
        if (this.testing) return [`return ${res}{err: "tests don't serve: call the handler with an http.Request"}`];
        return [
          `grace := int64(10_000)`,
          `if ${b}.${f('graceMs')}.some {`,
          `\tgrace = ${b}.${f('graceMs')}.value`,
          '}',
          `why := candor.Serve(ctx__, ${a}, ${b}.${f('largeBodies')}.value, grace, !${b}.${f('gzip')}.some || ${b}.${f('gzip')}.value, func(ctx__ *candor.Ctx, q candor.HttpRequest) candor.HttpResponse {`,
          `\treq := http__Request{${f('method')}: q.Method, ${f('path')}: q.Path, ${f('query')}: q.Query, ${f('headers')}: q.Headers, ${f('body')}: q.Body, ${f('remote')}: ${this.goType({ kind: 'option', inner: T.string })}{some: true, value: q.Remote}, ${f('remotePort')}: ${this.goType({ kind: 'option', inner: T.int })}{some: q.RemotePort > 0, value: q.RemotePort}}`,
          `\treq.${f('queryAll')} = ${repeats}{some: q.QueryAll.Len() > 0, value: q.QueryAll}`,
          `\treq.${f('headersAll')} = ${repeats}{some: q.HeadersAll.Len() > 0, value: q.HeadersAll}`,
          '\tif q.Stream != nil {',
          '\t\tid := candor.PutPull(q.Stream, nil)',
          '\t\tdefer candor.TakeStream(id)',
          `\t\treq.${f('stream')} = ${streamType}{some: true, value: id}`,
          '\t}',
          `\tr := ${c}(ctx__, req)`,
          `\tout := candor.HttpResponse{Status: r.${f('status')}, Headers: r.${f('headers')}, More: r.${f('more')}.value, Body: r.${f('body')}}`,
          `\tif r.${f('stream')}.some {`,
          `\t\tout.Writer = candor.WriterOf(r.${f('stream')}.value)`,
          `\t\tout.Stream = candor.TakeStream(r.${f('stream')}.value)`,
          `\t\tout.Upgrade = candor.TakeUpgrade(r.${f('stream')}.value)`,
          `\t\tout.File = candor.TakeFile(r.${f('stream')}.value)`,
          '\t}',
          '\treturn out',
          '})',
          'if why != "" {',
          `\treturn ${res}{err: why}`,
          '}',
          `return ${res}{ok: true, value: ${VOID}}`,
        ];
      }
      case 'streamResponse':
        return [`return http__Response{${f('status')}: ${a}, ${f('headers')}: ${b}, ${f('stream')}: ${streamType}{some: true, value: candor.PutStream(${toGo(c)})}}`];
      case 'writing': {
        // The body's Err as text for stderr; `ok` says whether it ended whole.
        const given = (sig.params[2].type as FnType).params[0] as FnType;
        return [
          `id := candor.PutWriter(func(c *candor.Ctx, w candor.Push) (string, bool) {`,
          `\tgot := ${c}(c, ${this.writerOf('w', given)})`,
          '\tif got.ok {',
          '\t\treturn "", false',
          '\t}',
          '\treturn candor.ErrText(got.err), true',
          '})',
          `return http__Response{${f('status')}: ${a}, ${f('headers')}: ${b}, ${f('stream')}: ${streamType}{some: true, value: id}}`,
        ];
      }
      case 'reading':
      case 'readingResponse': {
        // A body held whole is read from memory; a response's leaves the table once read.
        const given = (sig.params[1].type as FnType).params[0] as FnType;
        return [
          `var got ${res}`,
          `use := func(r candor.Pull) { got = ${b}(${CTX}, ${this.readerOf('r', given)}) }`,
          `if !${a}.${f('stream')}.some {`,
          `\tuse(candor.PullBytes([]byte(${a}.${f('body')})))`,
          '\treturn got',
          '}',
          ...(name === 'readingResponse' ? [`defer candor.TakeStream(${a}.${f('stream')}.value)`] : []),
          `candor.Reading(${CTX}, ${a}.${f('stream')}.value, use)`,
          'return got',
        ];
      }
      case 'streamed':
        return [
          `${a}.${f('body')} = ""`,
          `${a}.${f('stream')} = ${streamType}{some: true, value: candor.PutStream(candor.Pieces(${b}))}`,
          `return ${a}`,
        ];
      case 'rawText':
        return [`return string(${a})`];
      case 'gunzipText':
        return [`v, ok := candor.Gunzip([]byte(${a}))`, `return ${res}{some: ok, value: string(v)}`];
      case 'fileStream':
        return [
          `if ${goIdent('fs')}.(*candor.FS).IsMemory() {`,
          `\treturn ${res}{}`,
          '}',
          `return ${res}{some: true, value: candor.PutFile(${a})}`,
        ];
      case 'memoryFile':
        return [`return ${res}{some: true, value: candor.PutMemFile(string(${a}), ${b})}`];
      case 'served':
        // A file goes through ServeContent as `serve` sends it, any other body through gzip as
        // `serve` would; `HEAD` gets no body either way.
        return [
          `if ${b}.${f('status')} == 200 && ${b}.${f('stream')}.some {`,
          `\tif out, ok := candor.ServeMemFile(${b}.${f('stream')}.value, ${a}.${f('method')}, ${a}.${f('headers')}, ${a}.${f('headersAll')}.value, candor.HttpResponse{Headers: ${b}.${f('headers')}, More: ${b}.${f('more')}.value}); ok {`,
          `\t\treturn ${res}{${f('status')}: out.Status, ${f('headers')}: out.Headers, ${f('body')}: out.Body, ${f('more')}: ${repeats}{some: out.More.Len() > 0, value: out.More}}`,
          '\t}',
          '}',
          `h, body, gzipped := candor.ServedGzip(${CTX}, ${a}.${f('method')}, ${a}.${f('headers')}, ${a}.${f('headersAll')}.value, ${b}.${f('status')}, ${b}.${f('headers')}, ${b}.${f('body')}, ${b}.${f('stream')}.some, ${b}.${f('stream')}.value)`,
          `${b}.${f('headers')} = h`,
          'if gzipped {',
          `\t${b}.${f('body')} = body`,
          `\t${b}.${f('stream')} = ${streamType}{}`,
          '}',
          `if ${a}.${f('method')} == "HEAD" {`,
          `\t${b}.${f('body')} = ""`,
          `\t${b}.${f('stream')} = ${streamType}{}`,
          '}',
          `return ${b}`,
        ];
      case 'bodyOf':
        return [
          `if !${a}.${f('stream')}.some {`,
          `\treturn ${a}.${f('body')}`,
          '}',
          `return candor.StreamText(${CTX}, ${a}.${f('stream')}.value)`,
        ];
      case 'readBody':
        return [
          `acc := ${b}`,
          `if !${a}.${f('stream')}.some {`,
          `\treturn ${res}{ok: true, value: ${c}(${CTX}, acc, ${a}.${f('body')})}`,
          '}',
          `if why := candor.ReadBody(${CTX}, ${a}.${f('stream')}.value, func(c *candor.Ctx, x string) { acc = ${c}(c, acc, x) }); why != "" {`,
          `\treturn ${res}{err: why}`,
          '}',
          `return ${res}{ok: true, value: acc}`,
        ];
      case 'readForm': {
        // `candor.ReadForm` parses; its files become FormFiles, its failure a FormError.
        return [
          `ct, _ := ${a}.${f('headers')}.Get("content-type")`,
          `fields, files, kind, why := candor.ReadForm(${CTX}, ${a}.${f('body')}, ${a}.${f('stream')}.some, ${a}.${f('stream')}.value, ct, ${b})`,
          'if kind >= 0 {',
          `\treturn ${res}{err: ${this.fnName('formError')}(${CTX}, int64(kind), why, ${b})}`,
          '}',
          `out := make([]http__FormFile, len(files))`,
          'for i, x := range files {',
          `\tout[i] = http__FormFile{${f('field')}: x.Field, ${f('name')}: x.Name, ${f('contentType')}: x.ContentType, ${f('bytes')}: x.Data}`,
          '}',
          `return ${res}{ok: true, value: http__Form{${f('fields')}: fields.Share(), ${f('files')}: out}}`,
        ];
      }
      case 'formBody': {
        return [
          `files := make([]candor.FormFile, len(${a}.${f('files')}))`,
          `for i, x := range ${a}.${f('files')} {`,
          `\tfiles[i] = candor.FormFile{Field: x.${f('field')}, Name: x.${f('name')}, ContentType: x.${f('contentType')}, Data: x.${f('bytes')}}`,
          '}',
          `return candor.FormBody(${a}.${f('fields')}, files)`,
        ];
      }
      case 'upgrade': {
        // The response holds `talk` in the runtime's table, as `streamResponse` holds `write`.
        const ws = ((sig.params[1].type as FnType).params[0]);
        return [`return http__Response{${f('status')}: 101, ${f('stream')}: ${streamType}{some: true, value: candor.PutUpgrade(func(c *candor.Ctx, s candor.Socket) { ${b}(c, ${this.webSocket(ws, 's')}) })}}`];
      }
      case 'socketOf':
        return [`return ${this.webSocket(sig.ret, `candor.SocketPair(${CTX}, ${a}, ${b}.${f('stream')}.value)`)}`];
      case 'talkOver': {
        const ws = (sig.params[1].type as FnType).params[0];
        return [`candor.Talk(${CTX}, ${a}.${f('id')}, func(c *candor.Ctx, s candor.Socket) { ${b}(c, ${this.webSocket(ws, 's')}) })`, `return ${VOID}`];
      }
      case 'readResponse': {
        // As `readBody`, but a break keeps what was read, and the body leaves the table once read.
        const broken = sig.ret.kind === 'result' ? this.goType(sig.ret.err) : '';
        return [
          `acc := ${b}`,
          `if !${a}.${f('stream')}.some {`,
          `\treturn ${res}{ok: true, value: ${c}(${CTX}, acc, ${a}.${f('body')})}`,
          '}',
          `defer candor.TakeStream(${a}.${f('stream')}.value)`,
          `if why := candor.ReadBody(${CTX}, ${a}.${f('stream')}.value, func(c *candor.Ctx, x string) { acc = ${c}(c, acc, x) }); why != "" {`,
          `\treturn ${res}{err: ${broken}{${f('sofar')}: acc, ${f('message')}: why}}`,
          '}',
          `return ${res}{ok: true, value: acc}`,
        ];
      }
      default:
        return null;
    }
  }

  /** An `http.WebSocket` over the runtime's `candor.Socket` `s`: its fields call the socket. */
  private webSocket(t: Type, s: string): string {
    const fields = t.kind === 'struct' ? t.fields : [];
    const fnRet = (name: string) => this.goType((fields.find((x) => x.name === name)!.type as FnType).ret);
    const opt = fnRet('receive');
    const msg = fnRet('receiveMessage');
    const unit = fnRet('close');
    return [
      `func(s candor.Socket) ${this.goType(t)} { return ${this.goType(t)}{`,
      `${goIdent('send')}: func(c *candor.Ctx, x string) bool { return s.Send(c, candor.SocketMessage{Data: x}) }, `,
      `${goIdent('sendBytes')}: func(c *candor.Ctx, x []byte) bool { return s.Send(c, candor.SocketMessage{Data: string(x), Binary: true}) }, `,
      `${goIdent('receive')}: func(c *candor.Ctx) ${opt} { v, ok := candor.ReceiveText(c, s); return ${opt}{some: ok, value: v} }, `,
      `${goIdent('receiveMessage')}: func(c *candor.Ctx) ${msg} { m, ok := s.Receive(c); if !ok { return ${msg}{} }; return ${msg}{some: true, value: ${this.fnName('messageOf')}(c, m.Binary, m.Data)} }, `,
      `${goIdent('close')}: func(c *candor.Ctx) ${unit} { s.Close(c); return ${VOID} }`,
      `} }(${s})`,
    ].join('');
  }

  /** A runtime `candor.Pull` as a Candor reader of type `t`, `fn(int) -> Result<Bytes?, string>`. */
  private readerOf(pull: string, t: FnType): string {
    const res = this.goType(t.ret);
    const opt = t.ret.kind === 'result' ? this.goType(t.ret.ok) : '';
    return `func(c *candor.Ctx, n int64) ${res} { b, more, err := ${pull}(c, n); if err != nil { return ${res}{err: err.Error()} }; return ${res}{ok: true, value: ${opt}{some: more, value: b}} }`;
  }

  /** A runtime `candor.Push` as a Candor writer of type `t`, `fn(Bytes) -> Result<void, string>`. */
  private writerOf(push: string, t: FnType): string {
    const res = this.goType(t.ret);
    return `func(c *candor.Ctx, b []byte) ${res} { if err := ${push}(c, b); err != nil { return ${res}{err: err.Error()} }; return ${res}{ok: true, value: ${VOID}} }`;
  }

  /** A Candor reader as a `candor.Pull`. */
  private pullOf(r: string): string {
    return `candor.Pull(func(c *candor.Ctx, n int64) ([]byte, bool, error) { x := ${r}(c, n); if !x.ok { return nil, false, candor.StreamErr(x.err) }; return x.value.value, x.value.some, nil })`;
  }

  /** A Candor writer as a `candor.Push`. */
  private pushOf(w: string): string {
    return `candor.Push(func(c *candor.Ctx, b []byte) error { if x := ${w}(c, b); !x.ok { return candor.StreamErr(x.err) }; return nil })`;
  }

  /** `bytes`' functions, in the runtime's bytes.go; readers and writers in stream.go. */
  private bytesBody(name: string, sig: FnSig): string[] | null {
    const arg = goIdent(sig.params[0].name);
    const res = this.goType(sig.ret);
    const failed = (v: string) => ['if err != nil {', `\treturn ${res}{err: err.Error()}`, '}', `return ${res}{ok: true, value: ${v}}`];
    switch (name) {
      case 'reading': {
        const given = (sig.params[1].type as FnType).params[0] as FnType;
        return [`pull := candor.PullBytes(${arg})`, `return ${goIdent(sig.params[1].name)}(${CTX}, ${this.readerOf('pull', given)})`];
      }
      case 'collect': {
        const fn = sig.params[0].type as FnType;
        return [
          `var got ${this.goType(fn.ret)}`,
          `v := candor.Collect(func(w candor.Push) { got = ${arg}(${CTX}, ${this.writerOf('w', fn.params[0] as FnType)}) })`,
          'if !got.ok {',
          `\treturn ${res}{err: got.err}`,
          '}',
          `return ${res}{ok: true, value: v}`,
        ];
      }
      case 'readAll':
        return [`v, err := candor.ReadAll(${CTX}, ${this.pullOf(arg)})`, ...failed('v')];
      case 'copy':
        return [`v, err := candor.Copy(${CTX}, ${this.pullOf(arg)}, ${this.pushOf(goIdent(sig.params[1].name))})`, ...failed('v')];
      case 'readLines': {
        const [start, each] = sig.params.slice(1).map((p) => goIdent(p.name));
        return [`acc := ${start}`, `err := candor.ReadLines(${CTX}, ${this.pullOf(arg)}, func(c *candor.Ctx, line string) { acc = ${each}(c, acc, line) })`, ...failed('acc')];
      }
    }
    if (name === 'fromList') return [`return candor.BytesFromList(${arg})`];
    if (name === 'gzip') return [`return candor.Gzip(${arg})`];
    if (name === 'gunzip') return [`v, ok := candor.Gunzip(${arg})`, `return ${this.goType(sig.ret)}{some: ok, value: v}`];
    if (name !== 'fromHex' && name !== 'fromBase64') return null;
    return [`v, ok := candor.Bytes${exported(name)}(${arg})`, `return ${this.goType(sig.ret)}{some: ok, value: v}`];
  }

  /**
   * Xml's `scan`, std/xmlgo's Elements over the reader. Each element crosses as JSON
   * to `each`; the module's own `nodeOf`, `goesOn`, `valueOf` and `finish` do the Candor side.
   */
  private xmlScan(sig: FnSig): string[] {
    this.xmlGo ??= this.goImport('./xmlgo', this.file);
    const [r, names, strict, charset, start, each] = sig.params.map((p) => goIdent(p.name));
    const f = (n: string) => this.fnName(n);
    return [
      `acc := ${start}`,
      `rest := xmlgo.Elements(candor.PullReader(${CTX}, ${this.pullOf(r)}), ${names}, ${strict}, ${charset}, func(s string) bool {`,
      `\tstep := ${each}(${CTX}, acc, ${f('nodeOf')}(${CTX}, s))`,
      `\tacc = ${f('valueOf')}(${CTX}, step)`,
      `\treturn ${f('goesOn')}(${CTX}, step)`,
      '})',
      `return ${f('finish')}(${CTX}, acc, rest)`,
    ];
  }

  /** `env.zone()` and `env.setZone(z)`, sent to std/time's `envZone` and `setEnvZone`. */
  private timeBody(name: string, sig: FnSig): string[] | null {
    const field = goIdent('name');
    if (name === 'envZone') return [`return ${this.goType(sig.ret)}{${field}: ${goIdent('env')}.Zone(${CTX})}`];
    if (name === 'setEnvZone') return [`${goIdent('env')}.(*candor.FakeEnv).SetZone(${CTX}, ${goIdent(sig.params[0].name)}.${field})`, `return ${VOID}`];
    return null;
  }

  /** `hash`'s functions, in the runtime's hash.go; the `File` ones read through `candor.FS`. */
  private hashBody(name: string, sig: FnSig): string[] | null {
    const args = sig.params.map((p) => goIdent(p.name));
    if (name === 'equal') return [`return candor.HashEqual(${args.join(', ')})`];
    if (name.startsWith('hmac')) return [`return candor.Hmac("${name.slice(4).toLowerCase()}", ${args.join(', ')})`];
    if (!name.endsWith('File')) return [`return candor.Hash("${name}", ${args[0]})`];
    const res = this.goType(sig.ret);
    return [
      `v, e := ${goIdent('fs')}.(*candor.FS).HashFile(${CTX}, ${args[0]}, "${name.slice(0, -4)}")`,
      'if e != nil {',
      `\treturn ${res}{err: ${this.fnName('fsError', 'fs')}(${CTX}, e.Kind, e.Path, e.Message)}`,
      '}',
      `return ${res}{ok: true, value: v}`,
    ];
  }

  /** `fs`'s functions: the runtime's `candor.FS`, the disk or a test's memory. */
  private fsBody(name: string, sig: FnSig): string[] | null {
    const files = `${goIdent('fs')}.(*candor.FS)`;
    const args = sig.params.map((p) => goIdent(p.name));
    const res = this.goType(sig.ret);
    // The runtime's *FsErr as an `FsError`, by the module's own `fsError`.
    const fail = (e: string) => `${res}{err: ${this.fnName('fsError')}(${CTX}, ${e}.Kind, ${e}.Path, ${e}.Message)}`;
    const ok = (v: string) => [`if e != nil {`, `\treturn ${fail('e')}`, '}', `return ${res}{ok: true, value: ${v}}`];
    switch (name) {
      case 'read':
      case 'readBytes':
      case 'readRange':
      case 'list':
        return [`v, e := ${files}.${exported(name)}(${[CTX, ...args].join(', ')})`, ...ok('v')];
      case 'write':
      case 'writeBytes':
      case 'append':
      case 'sync':
      case 'truncate':
      case 'remove':
      case 'makeDir':
        return [`e := ${files}.${exported(name)}(${[CTX, ...args].join(', ')})`, ...ok(VOID)];
      case 'exists':
        return [`return ${files}.Exists(${CTX}, ${args[0]})`];
      case 'rename':
      case 'copy':
      case 'removeAll':
        return [`e := ${files}.${exported(name)}(${[CTX, ...args].join(', ')})`, ...ok(VOID)];
      case 'within':
        return [`v, ok := candor.Within(${args.join(', ')})`, `return ${res}{some: ok, value: v}`];
      case 'join':
        return [`return candor.Join(${args.join(', ')})`];
      case 'loadEnv':
        return [`e := ${files}.LoadEnv(${CTX}, ${goIdent('env')}, ${args[0]})`, ...ok(VOID)];
      case 'info': {
        const info = sig.ret.kind === 'result' ? this.goType(sig.ret.ok) : '';
        const fields = `${goIdent('size')}: v.Size, ${goIdent('modified')}: v.Modified, ${goIdent('isDir')}: v.IsDir`;
        return [`v, e := ${files}.Info(${CTX}, ${args[0]})`, ...ok(`${info}{${fields}}`)];
      }
      case 'readLines': {
        const [path, start, each] = args;
        return [`acc := ${start}`, `e := ${files}.ReadLines(${CTX}, ${path}, func(c *candor.Ctx, line string) { acc = ${each}(c, acc, line) })`, ...ok('acc')];
      }
      case 'reading':
      case 'writing': {
        // `f`'s Result is kept from the closure: for `writing`, `ok` says whether to keep the file.
        const [path, f] = args;
        const given = (sig.params[1].type as FnType).params[0] as FnType;
        const call = name === 'reading'
          ? `func(r candor.Pull) { got = ${f}(${CTX}, ${this.readerOf('r', given)}) }`
          : `func(w candor.Push) bool { got = ${f}(${CTX}, ${this.writerOf('w', given)}); return got.ok }`;
        return [`var got ${res}`, `e := ${files}.${exported(name)}(${CTX}, ${path}, ${call})`, 'if e != nil {', `\treturn ${res}{err: e.Text()}`, '}', 'return got'];
      }
      case 'startWatch':
      case 'nextChange':
      case 'stopWatch':
        return this.watchBody(name, args[0], res, fail);
      default:
        return null;
    }
  }

  /**
   * `fs.watch`'s steps: a test's memory fs, or in `main` std/watchgo, built only when the
   * program calls `fs.watch` (it brings fsnotify). Without the call nothing reaches them.
   */
  private watchBody(name: string, arg: string, res: string, fail: (e: string) => string): string[] {
    const files = `${goIdent('fs')}.(*candor.FS)`;
    if (this.testing) {
      if (name === 'startWatch') return [`v, e := ${files}.StartWatch(${CTX}, ${arg})`, 'if e != nil {', `\treturn ${fail('e')}`, '}', `return ${res}{ok: true, value: v}`];
      if (name === 'nextChange') return [`return ${files}.NextChange(${CTX}, ${arg})`];
      return [`${files}.StopWatch(${arg})`, `return ${VOID}`];
    }
    if (!this.options.watch) return ['panic("unreachable: the program has no fs.watch")'];
    this.watchGo ??= this.goImport('./watchgo', this.file);
    if (name === 'startWatch') {
      return [`v, err := watchgo.Start(${arg})`, 'if err != nil {', `\te := candor.FsErrOf(${arg}, err)`, `\treturn ${fail('e')}`, '}', `return ${res}{ok: true, value: v}`];
    }
    // A cancelled task's Next gives "": the task stops here.
    if (name === 'nextChange') return [`s := watchgo.Next(${CTX}.Context(), ${arg})`, `${CTX}.Check()`, 'return s'];
    return [`watchgo.Stop(${arg})`, `return ${VOID}`];
  }

  /** `sql.open`, `exec`, `insert` and `query`: the runtime's `candor.SQL`, which `main` or the test gave as the effect. */
  private sqlBody(name: string, sig: FnSig): string[] {
    const res = this.goType(sig.ret);
    const error = sig.ret.kind === 'result' ? this.goType(sig.ret.err) : '';
    const arg = goIdent(sig.params[0].name);
    const db = `${goIdent('sql')}.(*candor.SQL)`;
    if (name === 'function') {
      // Each call gives a `candor.SQLFunction` for `f` (sqlFunction below). The
      // database gets a driver of its own with them, made here and not in the runtime, which
      // doesn't import the driver.
      this.imports.add('database/sql/driver');
      this.imports.add('modernc.org/sqlite');
      const f = goIdent(sig.params[1].name);
      return [
        `why := ${db}.Function(${CTX}, ${arg}, any(${f}).(candor.SQLFunction), func(source string, fns []candor.NamedSQLFunction) (driver.Connector, error) {`,
        '\td := &sqlite.Driver{}',
        '\tfor _, f := range fns {',
        '\t\tif err := d.RegisterFunction(f.Name, &sqlite.FunctionImpl{NArgs: int32(f.Args), Deterministic: true, Scalar: func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) { return f.Run(args) }}); err != nil {',
        '\t\t\treturn nil, err',
        '\t\t}',
        '\t}',
        '\treturn candor.DriverConnector(d, source), nil',
        '})',
        'if why != "" {',
        `\treturn ${res}{err: ${error}{${goIdent('message')}: why}}`,
        '}',
        `return ${res}{ok: true, value: ${VOID}}`,
      ];
    }
    if (name === 'transaction') {
      // The function's Result, kept from the closure: `ok` says whether to commit.
      const wrap = sig.params[1];
      const sqlError = this.goType((wrap.type as FnType).params[0]);
      return [
        `var got ${res}`,
        `why := ${db}.Transaction(${CTX}, func() bool { got = ${arg}(${CTX}); return got.ok })`,
        'if why != "" {',
        `\treturn ${res}{err: ${goIdent(wrap.name)}(${CTX}, ${sqlError}{${goIdent('message')}: why})}`,
        '}',
        'return got',
      ];
    }
    if (name === 'queryOne') {
      this.imports.add('fmt');
      const one = sig.ret.kind === 'result' ? this.goType(sig.ret.ok) : '';
      return [
        `v, why := candor.SQLRows[${typeParamName(sig.typeParams[0])}, ${dictParam(sig.typeParams[0], Row)}](${CTX}, ${db}, ${arg})`,
        'if why == "" && len(v) > 1 {',
        '\twhy = fmt.Sprintf("expected at most one row, got %d", len(v))',
        '}',
        'if why != "" {',
        `\treturn ${res}{err: ${error}{${goIdent('message')}: why}}`,
        '}',
        'if len(v) == 0 {',
        `\treturn ${res}{ok: true}`,
        '}',
        `return ${res}{ok: true, value: ${one}{some: true, value: v[0]}}`,
      ];
    }
    const call =
      name === 'open'
        ? `why := ${db}.Open(${CTX}, ${arg})`
        : name === 'attach'
          ? `why := ${db}.Attach(${CTX}, ${arg}, ${goIdent(sig.params[1].name)})`
          : name === 'query'
            ? `v, why := candor.SQLRows[${typeParamName(sig.typeParams[0])}, ${dictParam(sig.typeParams[0], Row)}](${CTX}, ${db}, ${arg})`
            : `v, why := ${db}.${name === 'exec' ? 'Exec' : 'Insert'}(${CTX}, ${arg})`;
    return [
      call,
      'if why != "" {',
      `\treturn ${res}{err: ${error}{${goIdent('message')}: why}}`,
      '}',
      `return ${res}{ok: true, value: ${name === 'open' || name === 'attach' ? VOID : 'v'}}`,
    ];
  }

  /** A function's body. One returning `void` returns Go's `struct{}{}`, so it fits `fn() -> T` too. */
  private fnBody(lines: string[], ret: Type): string[] {
    if (ret.kind !== 'unit' || lines.at(-1)?.startsWith('return')) return lines;
    return [...lines, `return ${VOID}`];
  }

  /** `[T__ any, T__Ord Ord__[T__]]`: each type parameter, then a dictionary per bound. */
  private fnTypeParams(ps: ParamType[]): string {
    if (ps.length === 0) return '';
    const list = ps.flatMap((p) => [`${typeParamName(p)} any`, ...p.bounds.map((b) => `${dictParam(p, b)} ${this.constraint(b)}[${typeParamName(p)}]`)]);
    return `[${list.join(', ')}]`;
  }

  /** The Go interface a dictionary for `trait` satisfies. */
  private constraint(trait: Trait): string {
    if (trait === Eq) return this.helper('Eq');
    if (trait === Ord) return this.helper('Ord');
    if (trait === Show) return this.helper('Show');
    if (trait === Json) return 'candor.Json';
    if (trait === Row) return 'candor.Row';
    return traitGo(trait);
  }

  /** Type arguments of a call: each type, then its dictionaries, as `fnTypeParams` lists them. */
  private typeArgList(ps: ParamType[], args: Type[]): string {
    return `[${ps.flatMap((p, i) => [this.goType(args[i]), ...p.bounds.map((b) => this.dictType(args[i], b))]).join(', ')}]`;
  }

  /** The dictionary type giving `t` the trait. */
  private dictType(t: Type, trait: Trait): string {
    if (t.kind === 'param') return dictParam(t, trait);
    if (trait === Eq) return this.eqDict(t);
    if (trait === Ord && ordered(t)) {
      this.imports.add('cmp');
      return `${this.helper('ordGo')}[${this.goType(t)}]`;
    }
    if (trait === Ord && t.kind === 'tuple') return this.ordTupleDict(t);
    if (trait === Show && shown(t)) {
      this.imports.add('strconv');
      return `${this.helper('showGo')}[${this.goType(t)}]`;
    }
    if (trait === Show && t.kind === 'list') return `${this.helper('showList')}[${this.goType(t.elem)}, ${this.dictType(t.elem, Show)}]`;
    if (trait === Show && t.kind === 'map') return `${this.helper('showMap')}[${this.goType(t.key)}, ${this.goType(t.value)}, ${this.dictType(t.key, Show)}, ${this.dictType(t.value, Show)}]`;
    if (trait === Show && t.kind === 'option') return `${this.helper('showOpt')}[${this.goType(t.inner)}, ${this.dictType(t.inner, Show)}]`;
    if (trait === Show && t.kind === 'result') {
      const ok = t.ok.kind === 'unit' ? this.helper('showVoid') : this.dictType(t.ok, Show);
      return `${this.helper('showRes')}[${this.goType(t.ok)}, ${this.goType(t.err)}, ${ok}, ${this.dictType(t.err, Show)}]`;
    }
    if (trait === Json) return this.jsonDict(t);
    if (trait === Row && (t.kind === 'int' || t.kind === 'string' || t.kind === 'bool' || t.kind === 'float' || t.kind === 'bytes')) return `candor.RowOf${t.kind[0].toUpperCase()}${t.kind.slice(1)}`;
    return this.implRef(trait, t);
  }

  /** An impl's dictionary type, given a generic type's arguments and their dictionaries: `Show__for__m__Box[int64, showGo__[int64]]`. */
  private implRef(trait: Trait, t: Type): string {
    const impl = this.info.impls.get(implKey(trait, t));
    if (!impl || impl.params.length === 0 || (t.kind !== 'struct' && t.kind !== 'enum')) return implName(trait, t);
    return `${implName(trait, t)}${this.typeArgList(impl.params, t.args)}`;
  }

  /** `type m__Show__for__m__Box[T__ any, T__Show Show__[T__]] struct{}`, and the receiver its methods name. */
  private implType(impl: Impl): { decl: string; recv: string } {
    const name = implName(impl.trait, impl.type);
    const recv = impl.params.length > 0 ? `${name}${this.typeArgList(impl.params, impl.params)}` : name;
    return { decl: `type ${name}${this.fnTypeParams(impl.params)} struct{}`, recv };
  }

  /** `Json` reaches through optionals, lists and maps to the impls inside. */
  private jsonDict(t: Type): string {
    switch (t.kind) {
      case 'int':
        return 'candor.JsonInt';
      case 'string':
        return 'candor.JsonString';
      case 'bool':
        return 'candor.JsonBool';
      case 'char':
        return 'candor.JsonChar';
      case 'bytes':
        return 'candor.JsonBytes';
      case 'float':
        return 'candor.JsonFloat';
      case 'option':
        return `${this.helper('jsonOpt')}[${this.goType(t.inner)}, ${this.dictType(t.inner, Json)}]`;
      case 'list':
        return `candor.JsonList[${this.goType(t.elem)}, ${this.dictType(t.elem, Json)}]`;
      case 'map':
        return `candor.JsonMap[${this.goType(t.value)}, ${this.dictType(t.value, Json)}]`;
      default:
        return this.implRef(Json, t);
    }
  }

  /**
   * A value of the dictionary type, to call its methods on. In parentheses: a bare `T{}` in a
   * `for`, `if` or `switch` header is read by Go as the start of the block.
   */
  private dictValue(t: Type, trait: Trait): string {
    const d = this.dictType(t, trait);
    return t.kind === 'param' ? `(*new(${d}))` : `(${d}{})`;
  }

  /**
   * `trait Show`: a Go interface over the type that has it. A method's effects come after the
   * context, in sorted order. A default body is a generic function over `Self` and its dictionary.
   */
  private traitDecl(trait: Trait): string[] {
    const methods = [...trait.methods].map(([name, t]) => {
      return `\t${goIdent(name)}(${['*candor.Ctx', ...t.uses.map(capType), ...t.params.map((p) => this.goType(p))].join(', ')}) ${this.goType(t.ret)}`;
    });
    const lines = [`// trait ${trait.name}`, `type ${traitGo(trait)}[${typeParamName(trait.self)} any] interface {`, ...methods, '}'];
    for (const [m, sig] of this.info.traitBodies.get(trait) ?? []) {
      const params = [`${CTX} *candor.Ctx`, ...sig.uses.map((u) => `${goIdent(u)} ${capType(u)}`), ...sig.params.map((p) => `${goIdent(p.name)} ${this.goType(p.type)}`)];
      this.temps = 0;
      this.tracked.clear();
      this.fnRet = sig.ret;
      const body = this.fnBody(this.block((sig.decl as unknown as ast.TraitMethod).body!, null), sig.ret);
      lines.push('', `func ${defaultName(trait, m)}${this.fnTypeParams([trait.self])}(${params.join(', ')}) ${this.goType(sig.ret)} {`, ...indent(body), '}');
    }
    return lines;
  }

  /** `impl Show for Point`: a dictionary type whose methods are the impl's. */
  private implDecl(impl: Impl): string[] {
    if (impl.trait === Json && !impl.via) return this.jsonImpl(impl);
    if (impl.trait === Row) return this.rowImpl(impl);
    if (impl.trait === Show && impl.decl.derived) return this.showImpl(impl);
    const { decl: typeDecl, recv: name } = this.implType(impl);
    const lines = [`// impl ${impl.trait.name} for ${typeToString(impl.type)}`, typeDecl];
    for (const [m, sig] of impl.methods) {
      // Every effect the trait's method has, as the interface wants; those this one doesn't use are `_`.
      const caps = (impl.trait.methods.get(m)?.uses ?? []).map((u) => `${sig.uses.includes(u) ? goIdent(u) : '_'} ${capType(u)}`);
      const params = [`${CTX} *candor.Ctx`, ...caps, ...sig.params.map((p) => `${goIdent(p.name)} ${this.goType(p.type)}`)];
      this.temps = 0;
      this.tracked.clear();
      this.fnRet = sig.ret;
      const decl = sig.decl as ast.FnDecl;
      const body = this.contracted(decl, m, sig.ret, this.fnBody(this.block(decl.body, null), sig.ret));
      lines.push('', `func (${name}) ${goIdent(m)}(${params.join(', ')}) ${this.goType(sig.ret)} {`, ...indent(body), '}');
    }
    // A method left out takes the trait's default body.
    for (const [m, t] of impl.trait.methods) {
      if (impl.methods.has(m) || !impl.trait.defaults.has(m)) continue;
      const self = subst(t, (p) => (p === impl.trait.self ? impl.type : p)) as FnType;
      const caps = t.uses.map((u) => ({ name: goIdent(u), type: capType(u) }));
      const args = self.params.map((p, i) => ({ name: `a${i}`, type: this.goType(p) }));
      const params = [`${CTX} *candor.Ctx`, ...[...caps, ...args].map((a) => `${a.name} ${a.type}`)];
      const call = `${defaultName(impl.trait, m)}${this.typeArgList([impl.trait.self], [impl.type])}(${[CTX, ...caps.map((c) => c.name), ...args.map((a) => a.name)].join(', ')})`;
      lines.push('', `func (${name}) ${goIdent(m)}(${params.join(', ')}) ${this.goType(self.ret)} {`, `\treturn ${call}`, '}');
    }
    if (impl.via) lines.push(...this.viaMethods(impl, impl.via, name));
    // Inside a list, optional or Result a written impl reads as it says.
    if (impl.trait === Show) lines.push('', `func (d ${name}) literal(c *candor.Ctx, a ${this.goType(impl.type)}) string {`, '\treturn d.toString(c, a)', '}');
    return lines;
  }

  /** `impl Show for Point`, derived: the literal form, `Point { x: 1, name: "ann" }`, each field as a literal. */
  private showImpl(impl: Impl): string[] {
    const t = impl.type as UserType;
    const { decl, recv } = this.implType(impl);
    const fields = (prefix: string, fs: Field[], goName: (f: string) => string) => {
      if (fs.length === 0) return goQuote(prefix);
      const parts = fs.map((f, i) => {
        const label = goQuote(`${i === 0 ? `${prefix} { ` : ', '}${f.name}: `);
        return `${label} + ${this.dictValue(f.type, Show)}.literal(c, ${f.boxed ? '*' : ''}a.${goName(f.name)})`;
      });
      return `${parts.join(' + ')} + " }"`;
    };
    const body =
      t.kind === 'struct'
        ? [`\treturn ${t.fields.length === 0 ? goQuote(`${t.name} {}`) : fields(t.name, t.fields, goIdent)}`]
        : [
            '\tswitch a.tag__ {',
            ...t.variants.flatMap((v, i) => [
              i === t.variants.length - 1 ? '\tdefault:' : `\tcase ${v.index}:`,
              `\t\treturn ${fields(`${t.name}.${v.name}`, v.fields, (f) => variantField(v.name, f))}`,
            ]),
            '\t}',
          ];
    const go = this.goType(t);
    return [
      `// impl Show for ${typeToString(t)}, derived`,
      decl,
      '',
      `func (${recv}) toString(c *candor.Ctx, a ${go}) string {`,
      ...body,
      '}',
      '',
      `func (d ${recv}) literal(c *candor.Ctx, a ${go}) string {`,
      '\treturn d.toString(c, a)',
      '}',
    ];
  }

  /** `impl Row for Todo`, derived: the columns are the fields, by name, in any order. */
  private rowImpl(impl: Impl): string[] {
    const t = impl.type as UserType & { kind: 'struct' };
    const name = implName(Row, t);
    const go = this.goType(t);
    const read = (f: Field): string[] => {
      const opt = f.type.kind === 'option';
      const kind = (opt ? (f.type as Type & { kind: 'option' }).inner : f.type).kind;
      const fn = `candor.Row${kind[0].toUpperCase()}${kind.slice(1)}`;
      return [
        `case ${goQuote(f.name)}:`,
        `\tx, ok, why := ${fn}(vals[i], col)`,
        '\tif why != "" {',
        '\t\treturn v, why',
        '\t}',
        ...(opt
          ? [`\tv.${goIdent(f.name)} = ${this.goType(f.type)}{some: ok, value: x}`]
          : ['\tif !ok {', `\t\treturn v, candor.RowNull(col, ${goQuote(`${t.name}.${f.name}`)})`, '\t}', `\tv.${goIdent(f.name)} = x`]),
      ];
    };
    const cols = [goQuote(t.name), ...t.fields.map((f) => goQuote(f.name))].join(', ');
    const loop = t.fields.length === 0 ? [] : ['for i, col := range cols {', '\tswitch col {', ...indent(t.fields.flatMap(read)), '\t}', '}'];
    return [
      `// impl Row for ${typeToString(t)}, derived`,
      `type ${name} struct{}`,
      '',
      `func (${name}) FromRow(cols []string, vals []any) (${go}, string) {`,
      `\tvar v ${go}`,
      `\tif why := candor.RowColumns(cols, ${cols}); why != "" {`,
      '\t\treturn v, why',
      '\t}',
      ...indent(loop),
      '\treturn v, ""',
      '}',
    ];
  }

  /**
   * `impl Json for Todo`, derived: `Enc` writes the fields in order, `Dec` reads them by name.
   * An enum without fields is a string; any other is an object whose `kind` names the variant.
   */
  private jsonImpl(impl: Impl): string[] {
    const t = impl.type as UserType;
    const { decl, recv: name } = this.implType(impl);
    const go = this.goType(t);
    if (this.mod.name === 'json' && t.kind === 'enum' && t.name === 'Value') return this.jsonValueImpl(t, decl, name, go);
    const rule = impl.decl.rule?.name ?? null;
    const wire = (x: { name: string; wire?: string }) => jsonName(x, rule);
    const enc: string[] = [];
    const dec: string[] = [];
    // A field that is none is left out, so the comma before a key is decided as it is written;
    // with `impl Json(nulls)` it is `null`.
    const nulls = impl.decl.nulls !== null;
    const encField = (f: Field, goName: string) => {
      const value = f.boxed ? `(*v.${goName})` : `v.${goName}`;
      const write = [`o.Key(${goQuote(`${JSON.stringify(wire(f))}:`)})`, `${this.dictValue(f.type, Json)}.Enc(o, ${value})`];
      if (f.type.kind === 'option' && !nulls) enc.push(`if ${value}.some {`, ...indent(write), '}');
      else enc.push(...write);
    };
    // Reads one field of `obj` into `v`.
    const decField = (f: Field, goName: string): string[] => {
      const key = goQuote(wire(f));
      const read = [
        `\tf, err := ${this.dictValue(f.type, Json)}.Dec(in, x, candor.JsonAt(path, ${key}))`,
        '\tif err != nil {',
        '\t\treturn v, err',
        '\t}',
        `\tv.${goName} = ${f.boxed ? this.ptr('f') : 'f'}`,
      ];
      const absent =
        f.type.kind !== 'option'
          ? ['} else {', `\treturn v, candor.JsonMissing(path, ${key})`]
          : f.boxed
            ? ['} else {', `\tv.${goName} = ${this.ptr(`${this.goType(f.type)}{}`)}`]
            : [];
      return [`if x, ok := obj.Get(${key}); ok {`, ...read, ...absent, '}'];
    };
    const objectOf = ['obj, err := candor.JsonObjectOf(j, path)', 'if err != nil {', '\treturn v, err', '}'];
    // `json.decodeStrict`: a key the type doesn't know is an error, checked before the fields
    // so a misspelt one is named rather than the field it was meant to be.
    const strict = (keys: string[]) => ['if in.Strict {', `\tif err := candor.JsonUnknown(${['obj', 'path', ...keys.map(goQuote)].join(', ')}); err != nil {`, '\t\treturn v, err', '\t}', '}'];
    if (t.kind === 'struct') {
      enc.push('o.Raw("{")');
      for (const f of t.fields) encField(f, goIdent(f.name));
      enc.push('o.Raw("}")');
      dec.push(...objectOf, ...strict(t.fields.map(wire)));
      for (const f of t.fields) dec.push(...decField(f, goIdent(f.name)));
      dec.push('return v, nil');
    } else {
      const names = goQuote(`one of ${t.variants.map((v) => JSON.stringify(wire(v))).join(', ')}`);
      const tagged = t.variants.some((v) => v.fields.length > 0);
      enc.push('switch v.tag__ {');
      for (const v of t.variants) {
        enc.push(`case ${v.index}:`);
        if (!tagged) {
          enc.push(`\to.Raw(${goQuote(JSON.stringify(wire(v)))})`);
          continue;
        }
        const before = enc.length;
        enc.push(`o.Raw(${goQuote(`{"kind":${JSON.stringify(wire(v))}`)})`);
        for (const f of v.fields) encField(f, variantField(v.name, f.name));
        enc.push('o.Raw("}")');
        enc.splice(before, enc.length - before, ...enc.slice(before).map((l) => `\t${l}`));
      }
      enc.push('}');
      if (!tagged) {
        dec.push('s, err := candor.JsonString{}.Dec(in, j, path)', 'if err != nil {', `\treturn v, candor.JsonBad(path, ${names}, j)`, '}', 'switch s {');
        for (const v of t.variants) dec.push(`case ${goQuote(wire(v))}:`, `\treturn ${go}{tag__: ${v.index}}, nil`);
        dec.push('}', `return v, candor.JsonBad(path, ${names}, j)`);
      } else {
        dec.push(
          ...objectOf,
          'k, ok := obj.Get("kind")',
          'if !ok {',
          '\treturn v, candor.JsonMissing(path, "kind")',
          '}',
          'kind, _ := k.(string)',
          'switch kind {',
        );
        for (const v of t.variants) {
          dec.push(`case ${goQuote(wire(v))}:`, `\tv.tag__ = ${v.index}`, ...indent(strict(['kind', ...v.fields.map(wire)])));
          for (const f of v.fields) dec.push(...decField(f, variantField(v.name, f.name)).map((l) => `\t${l}`));
          dec.push('\treturn v, nil');
        }
        dec.push('}', `return v, candor.JsonBad(candor.JsonAt(path, "kind"), ${names}, k)`);
      }
    }
    return [
      `// impl Json for ${typeToString(t)}, derived`,
      decl,
      '',
      `func (${name}) Enc(o *candor.JsonOut, v ${go}) {`,
      ...indent(enc),
      '}',
      '',
      `func (${name}) Dec(in *candor.JsonIn, j any, path string) (${go}, *candor.JsonErr) {`,
      `\tvar v ${go}`,
      ...indent(dec),
      '}',
    ];
  }

  /** `json.Value`: written as the JSON it holds, and read from any. */
  private jsonValueImpl(t: UserType & { kind: 'enum' }, decl: string, name: string, go: string): string[] {
    const tag = (v: string) => t.variants.find((x) => x.name === v)!.index;
    const field = (v: string) => variantField(v, t.variants.find((x) => x.name === v)!.fields[0].name);
    const text = (v: string) => variantField(v, 'text');
    return [
      '// impl Json for json.Value: the JSON it holds',
      decl,
      '',
      `func (d ${name}) Enc(o *candor.JsonOut, v ${go}) {`,
      '\tswitch v.tag__ {',
      `\tcase ${tag('Null')}:`,
      '\t\to.Raw("null")',
      `\tcase ${tag('Bool')}:`,
      `\t\tcandor.JsonBool{}.Enc(o, v.${field('Bool')})`,
      `\tcase ${tag('Int')}:`,
      `\t\tif v.${text('Int')}.some {`,
      `\t\t\to.Raw(v.${text('Int')}.value)`,
      '\t\t} else {',
      `\t\t\tcandor.JsonInt{}.Enc(o, v.${field('Int')})`,
      '\t\t}',
      `\tcase ${tag('Float')}:`,
      `\t\tif v.${text('Float')}.some {`,
      `\t\t\to.Raw(v.${text('Float')}.value)`,
      '\t\t} else {',
      `\t\t\tcandor.JsonFloat{}.Enc(o, v.${field('Float')})`,
      '\t\t}',
      `\tcase ${tag('Text')}:`,
      `\t\to.Str(v.${field('Text')})`,
      `\tcase ${tag('List')}:`,
      `\t\tcandor.JsonList[${go}, ${name}]{}.Enc(o, v.${field('List')})`,
      `\tcase ${tag('Object')}:`,
      `\t\tcandor.JsonMap[${go}, ${name}]{}.Enc(o, v.${field('Object')})`,
      '\t}',
      '}',
      '',
      `func (d ${name}) Dec(in *candor.JsonIn, j any, path string) (${go}, *candor.JsonErr) {`,
      '\tswitch x := j.(type) {',
      '\tcase nil:',
      `\t\treturn ${go}{tag__: ${tag('Null')}}, nil`,
      '\tcase bool:',
      `\t\treturn ${go}{tag__: ${tag('Bool')}, ${field('Bool')}: x}, nil`,
      '\tcase string:',
      `\t\treturn ${go}{tag__: ${tag('Text')}, ${field('Text')}: x}, nil`,
      '\tcase []any:',
      `\t\titems, err := candor.JsonList[${go}, ${name}]{}.Dec(in, x, path)`,
      `\t\treturn ${go}{tag__: ${tag('List')}, ${field('List')}: items}, err`,
      '\tcase *candor.JsonObject:',
      `\t\tfields, err := candor.JsonMap[${go}, ${name}]{}.Dec(in, x, path)`,
      `\t\treturn ${go}{tag__: ${tag('Object')}, ${field('Object')}: fields}, err`,
      '\t}',
      '\ti, f, isInt, written, err := candor.JsonNumberOf(j, path)',
      `\ttext := ${this.goType({ kind: 'option', inner: T.string })}{some: written != "", value: written}`,
      '\tif isInt {',
      `\t\treturn ${go}{tag__: ${tag('Int')}, ${field('Int')}: i, ${text('Int')}: text}, err`,
      '\t}',
      `\treturn ${go}{tag__: ${tag('Float')}, ${field('Float')}: f, ${text('Float')}: text}, err`,
      '}',
    ];
  }

  /** `impl Json for Money via string`: through the form's own dictionary, converting on the way. */
  private viaMethods(impl: Impl, via: Type, recv: string): string[] {
    const go = this.goType(impl.type);
    const form = this.dictValue(via, Json);
    return [
      '',
      `func (d ${recv}) Enc(o *candor.JsonOut, v ${go}) {`,
      `\t${form}.Enc(o, d.toJson(o.Ctx, v))`,
      '}',
      '',
      `func (d ${recv}) Dec(in *candor.JsonIn, j any, path string) (${go}, *candor.JsonErr) {`,
      `\tx, err := ${form}.Dec(in, j, path)`,
      '\tif err != nil {',
      `\t\treturn *new(${go}), err`,
      '\t}',
      '\tr := d.fromJson(in.Ctx, x)',
      '\tif !r.ok {',
      '\t\treturn r.value, &candor.JsonErr{Path: path, Message: r.err}',
      '\t}',
      '\treturn r.value, nil',
      '}',
    ];
  }

  /**
   * `effect http`: a Go interface of its operations, and the real implementation, whose
   * methods are the operations' bodies. In test mode also the fake: a struct of its state,
   * built fresh for every test. A fake method works on copies of the state and writes the
   * mutable ones back when it returns, so state behaves like `let mut` variables.
   *
   * The real effect's state works the same way, but tasks call its operations at once: one that
   * changes the state holds a lock while it runs, so no change is lost; one that only reads it
   * takes a copy under a read lock, and runs alongside the others.
   */
  private effectDecl(fx: UserEffect): string[] {
    const t = effectType(fx.name);
    const sigOf = (name: string, sig: FnSig) => {
      const params = [`${CTX} *candor.Ctx`, ...sig.params.map((p) => `${goIdent(p.name)} ${this.goType(p.type)}`)];
      return `${exported(name)}(${params.join(', ')}) ${this.goType(sig.ret)}`;
    };
    // Every operation is a place where a cancelled task stops and, in tests, where another task may run.
    const method = (recv: string, name: string, sig: FnSig, prologue: string[], tracked: string[] = []) => {
      this.temps = 0;
      this.tracked = new Set(tracked);
      this.fnRet = sig.ret;
      const body = this.fnBody(this.block((sig.decl as ast.FnDecl).body, null), sig.ret);
      return ['', `func ${recv} ${sigOf(name, sig)} {`, ...indent([`${CTX}.Op()`, ...prologue, ...body]), '}'];
    };
    const lines = [`// effect ${fx.name}`, `type ${t} interface {`, ...[...fx.ops].map(([n, sig]) => `\t${sigOf(n, sig)}`), '}'];
    // The state as fields, a constructor that sets it up, and each method's copies of it.
    const holder = (struct: string, ctor: string, state: StateVar[], extra: string[]) => {
      const fields = state.map((s) => goIdent(s.name));
      this.temps = 0;
      this.tracked.clear();
      this.fnRet = { kind: 'unit' };
      const init = state.flatMap((s) => this.stmt(s.decl));
      // State written by index: each operation's copy gets its own flag, so a loop of writes
      // copies the list once, and the holder's own array is never written in place.
      const tracked = state.filter((s) => this.info.indexed.has(s.decl)).map((s) => s.name);
      lines.push(
        '',
        `type ${struct} struct {`,
        ...extra,
        ...state.map((s, i) => `\t${fields[i]} ${this.goType(s.type)}`),
        '}',
        '',
        `func ${ctor}(${CTX} *candor.Ctx) *${struct} {`,
        ...indent([...init, `return &${struct}{${fields.map((f) => `${f}: ${f}`).join(', ')}}`]),
        '}',
      );
      const copies = (writes: boolean) =>
        state.flatMap((s, i) => {
          const f = fields[i];
          const value = writes && s.mutable && s.type.kind === 'list' ? this.owned(`f__.${f}`) : `f__.${f}`;
          const flag = tracked.includes(s.name) ? [`var ${f}__own bool`, `_ = ${f}__own`] : [];
          return [`var ${f} ${this.goType(s.type)} = ${value}`, ...(writes && s.mutable ? [`defer func() { f__.${f} = ${f} }()`] : []), `_ = ${f}`, ...flag];
        });
      return { copies, tracked };
    };
    if (fx.ownState.length === 0) {
      lines.push('', `type ${t}__real struct{}`);
      for (const [n, sig] of fx.ops) lines.push(...method(`(${t}__real)`, n, sig, []));
    } else {
      const locked = fx.ownState.some((s) => s.mutable);
      if (locked) this.imports.add('sync');
      const { copies, tracked } = holder(`${t}__real`, `${t}__newReal`, fx.ownState, locked ? ['\tmu__ sync.RWMutex'] : []);
      for (const [n, sig] of fx.ops) {
        const writes = fx.writers.has(n);
        const prologue = !locked
          ? copies(false)
          : writes
            ? ['f__.mu__.Lock()', 'defer f__.mu__.Unlock()', ...copies(true)]
            : ['f__.mu__.RLock()', ...copies(false), 'f__.mu__.RUnlock()'];
        lines.push(...method(`(f__ *${t}__real)`, n, sig, prologue, tracked));
      }
    }
    if (!this.testing || !fx.fake) return lines;
    lines.push('', `// fake ${fx.name}`, ...this.fakeDecl(fx, method));
    return lines;
  }

  /**
   * A fake: a struct of its state and of the effects it uses, which the test fills in. Its
   * functions work on the state in place, not on copies: one that uses another effect may wait
   * in it (a fake http sleeping on the clock) while other tasks call the fake. A list written by
   * index keeps its `__own` flag on the fake too.
   */
  private fakeDecl(fx: UserEffect, method: (recv: string, name: string, sig: FnSig, prologue: string[], tracked: string[]) => string[]): string[] {
    const t = effectType(fx.name);
    const uses = fakeUses(fx);
    const tracked = fx.state.filter((s) => this.info.indexed.has(s.decl)).map((s) => s.name);
    this.temps = 0;
    this.tracked.clear();
    this.fnRet = { kind: 'unit' };
    const init = fx.state.flatMap((s) => this.stmt(s.decl));
    const fields = [...fx.state.map((s) => goIdent(s.name)), ...tracked.map((n) => `${goIdent(n)}__own`)];
    const lines = [
      `type ${t}__fake struct {`,
      ...uses.map((u) => `\tuses__${u} ${capType(u)}`),
      ...fx.state.map((s) => `\t${goIdent(s.name)} ${this.goType(s.type)}`),
      ...tracked.map((n) => `\t${goIdent(n)}__own bool`),
      '}',
      '',
      `func ${t}__newFake(${CTX} *candor.Ctx) *${t}__fake {`,
      ...indent([...init, `return &${t}__fake{${fields.map((f) => `${f}: ${f}`).join(', ')}}`]),
      '}',
    ];
    this.stateRefs = new Map(fx.state.map((s) => [s.name, `f__.${goIdent(s.name)}`]));
    for (const [n, sig] of [...fx.fakeOps, ...fx.steering]) {
      const given = sig.uses.flatMap((u) => [`var ${goIdent(u)} ${capType(u)} = f__.uses__${u}`, `_ = ${goIdent(u)}`]);
      lines.push(...method(`(f__ *${t}__fake)`, n, sig, given, tracked));
    }
    this.stateRefs = null;
    return lines;
  }

  /** A block's statements. With `assignTo`, its last expression is assigned to that variable. */
  private block(b: ast.Block, assignTo: string | null): string[] {
    const lines: string[] = [];
    b.stmts.forEach((s, i) => {
      if (assignTo !== null && i === b.stmts.length - 1 && s.kind === 'ExprStmt') {
        lines.push(...this.at(s.span, this.withPre(() => [`${assignTo} = ${this.expr(s.expr)}`])));
      } else {
        lines.push(...this.stmt(s));
      }
    });
    return lines;
  }

  /** A statement, every line of it marked with the statement's Candor line. */
  private stmt(s: ast.Stmt): string[] {
    return this.at(s.span, this.stmtLines(s));
  }

  private stmtLines(s: ast.Stmt): string[] {
    switch (s.kind) {
      case 'Let':
        return this.withPre(() => {
          // Always spell the type: `x := 1` would make a Go `int`, and Candor's int is int64.
          const type = this.finalType(s.value);
          let value = this.expr(s.value);
          if (s.mutable && type.kind === 'list') value = this.owned(value);
          const lines = [`var ${goIdent(s.name)} ${this.goType(type)} = ${value}`];
          if (this.info.unused.has(s)) lines.push(`_ = ${goIdent(s.name)}`);
          if (this.info.indexed.has(s)) {
            // Written by index somewhere: the flag says whether the variable owns its items.
            this.tracked.add(s.name);
            lines.push(`var ${goIdent(s.name)}__own = ${fresh(s.value)}`, `_ = ${goIdent(s.name)}__own`);
          } else {
            this.tracked.delete(s.name);
          }
          return lines;
        });
      case 'LetTuple':
        return this.withPre(() => {
          const type = this.finalType(s.value);
          const value = this.expr(s.value);
          const t = this.temp();
          const binds: string[] = [];
          this.patternParts(s.pattern, t, type, [], binds);
          return [`var ${t} ${this.goType(type)} = ${value}`, ...(binds.length > 0 ? binds : [`_ = ${t}`])];
        });
      case 'Return':
        return this.withPre(() => [s.value ? `return ${this.expr(s.value)}` : this.goVoid ? 'return' : `return ${VOID}`]);
      case 'ExprStmt':
        if (s.expr.kind === 'If') return this.ifChain(s.expr, null);
        if (s.expr.kind === 'Match') return this.matchChain(s.expr, null);
        if (s.expr.kind === 'Call' && this.info.listCalls.get(s.expr) === 'push') return this.withPre(() => [this.push(s.expr as ast.Call)]);
        // `save(x)?`: the early return is all there is; the `void` left over is dropped.
        if (s.expr.kind === 'Try') return this.withPre(() => (this.expr(s.expr), []));
        return this.withPre(() => [this.expr(s.expr)]);
      case 'Assert':
        return this.assert(s);
      case 'Assign':
        return this.withPre(() => {
          if (s.target.kind === 'Index') return this.setIndex(s.target, s.op, s.value);
          let value = this.expr(s.value);
          const target = this.place(s.target);
          const lines = [];
          if (s.op === '=' && s.target.kind === 'Ident' && this.info.types.get(s.target)!.kind === 'list') {
            value = this.owned(value);
            if (this.tracked.has(s.target.name)) lines.push(`${target}__own = ${fresh(s.value)}`);
          }
          const t = this.info.types.get(s.target)!;
          if (s.op !== '=' && (trapping(t, s.op.slice(0, -1)) || t.kind === 'float')) return [`${target} = ${arith(t, s.op.slice(0, -1), target, value)}`];
          return [`${target} ${s.op} ${value}`, ...lines];
        });
      case 'For':
        return this.forStmt(s);
      case 'While': {
        const body = [CHECK, ...this.block(s.body, null)];
        // Go counts `for {` without a `break` as the end of a function; `for true {` it doesn't.
        if (s.cond.kind === 'Bool' && s.cond.value) return ['for {', ...indent(body), '}'];
        const cond = this.capture(s.cond);
        if (cond.pre.length === 0) return [`for ${cond.value} {`, ...indent(body), '}'];
        // The condition needs statements first: run them at the top of every iteration.
        return ['for {', ...indent([...cond.pre, `if !(${cond.value}) {`, '\tbreak', '}', ...body]), '}'];
      }
      case 'Break':
        return ['break'];
      case 'Continue':
        return ['continue'];
      case 'Defer':
        // Go's `defer` runs on return and while a panic unwinds, cancellation's too; the body
        // gets a context of its own that is never cancelled.
        return [`defer candor.Deferred(${CTX}, func(${CTX} *candor.Ctx) {`, ...indent(this.block(s.body, null)), '})'];
    }
  }

  private forStmt(s: ast.ForStmt): string[] {
    const name = s.name === '_' || this.info.unused.has(s) ? '_' : goIdent(s.name);
    return this.withPre(() => {
      // Every iteration is a place where a cancelled task stops, so even pure loops end.
      const body = () => indent([CHECK, ...this.block(s.body, null)]);
      if (s.end) {
        // Both ends are evaluated once, before the loop, as Candor reads left to right.
        const [from, to] = this.operands([s.iterable, s.end]);
        const i = name === '_' ? this.temp() : name;
        const end = this.temp();
        return [`for ${i}, ${end} := int64(${from}), int64(${to}); ${i} < ${end}; ${i}++ {`, ...body(), '}'];
      }
      const xs = this.expr(s.iterable);
      const iterable = this.info.types.get(s.iterable)!;
      if (iterable.kind === 'handle') {
        // A channel: each value received, until it is closed and empty.
        const ch = this.temp();
        const ok = this.temp();
        const v = s.pattern ? this.temp() : name;
        const binds: string[] = [];
        if (s.pattern) this.patternParts(s.pattern, v, iterable.arg, [], binds);
        const loop = indent([`${v}, ${ok} := ${ch}.Recv(${CTX})`, `if !${ok} {`, '\tbreak', '}', ...binds]);
        return [`${ch} := ${xs}`, 'for {', ...loop, ...body(), '}'];
      }
      if (s.pattern) {
        const entry = this.temp();
        const binds: string[] = [];
        if (iterable.kind === 'map') {
          // Over a copy: a change to the map in the body is not seen by the loop.
          const [k, v] = s.pattern.items;
          this.patternParts(k, `${entry}.Key`, iterable.key, [], binds);
          this.patternParts(v, `${entry}.Value`, iterable.value, [], binds);
        } else {
          this.patternParts(s.pattern, entry, (iterable as Type & { kind: 'list' }).elem, [], binds);
        }
        const range = iterable.kind === 'map' ? `${xs}.Entries()` : xs;
        const head = binds.length === 0 ? `for range ${range} {` : `for _, ${entry} := range ${range} {`;
        return [head, ...indent(binds), ...body(), '}'];
      }
      return [name === '_' ? `for range ${xs} {` : `for _, ${name} := range ${xs} {`, ...body(), '}'];
    });
  }

  /**
   * A list a `let mut` variable holds. Lists are values, but Go slices share their backing
   * array. Clipping the capacity makes the variable's first `push` copy, so pushes never write
   * into memory another value can see.
   */
  /** A variable's Go name; inside a fake's function, its state is the fake's field. */
  private varName(name: string): string {
    return this.stateRefs?.get(name) ?? goIdent(name);
  }

  private owned(list: string): string {
    this.imports.add('slices');
    return `slices.Clip(${list})`;
  }

  /** Where an assignment or `push` writes: a variable, or a path of struct fields and tuple items from one. */
  private place(e: ast.Expr): string {
    const at = (p: string) => (this.info.narrowed.has(e) ? `${p}.value` : p);
    if (e.kind === 'Ident') return at(this.varName(e.name));
    if (e.kind === 'Member') {
      const field = this.info.types.get(e.object)?.kind === 'tuple' ? `V${e.name}` : goIdent(e.name);
      return at(`${this.place(e.object)}.${field}`);
    }
    throw new Error(`not a place: ${e.kind}`);
  }

  /**
   * `xs[i] = v`, `xs[i] += v`. On a variable, `set__` copies the list unless the variable owns
   * its items, then writes in place. A list inside a struct may share its array with copies of
   * the struct, so `setCopy__` copies every time. Out of range is a panic.
   */
  private setIndex(target: ast.Index, op: ast.AssignOp, value: ast.Expr): string[] {
    if (this.info.types.get(target.object)!.kind === 'map') {
      // `m[k] = v` (the checker refuses `op=`): in place on a variable while it owns its data; a
      // map inside a struct may be shared with copies of the struct, so it is copied first.
      const [k, v] = this.operands([target.index, value]);
      return [`${this.place(target.object)}.${target.object.kind === 'Ident' ? 'Set' : 'SetCopy'}(${k}, ${v})`];
    }
    this.imports.add('slices');
    const list = this.place(target.object);
    const own = target.object.kind === 'Ident' && this.tracked.has(target.object.name) ? `&${list}__own` : null;
    const write = (i: string, v: string) => (own ? `${this.helper('set')}(&${list}, ${own}, ${i}, ${v})` : `${list} = ${this.helper('setCopy')}(${list}, ${i}, ${v})`);
    if (op === '=') {
      const [i, v] = this.operands([target.index, value]);
      return [write(i, v)];
    }
    // The index once, as Candor reads it: before the value, then the item is read and written.
    const [i0] = this.operands([target.index]);
    const i = this.temp();
    this.pre.push(`var ${i} int64 = ${i0}`);
    const [v] = this.operands([value]);
    const listType = this.info.types.get(target.object)!;
    return [write(i, arith(listType.kind === 'list' ? listType.elem : listType, op.slice(0, -1), `${this.helper('get')}(${list}, ${i})`, v))];
  }

  /** A list that is indexed, compared or a method's receiver, not passed on: a `let mut` one keeps owning its items. */
  private listRef(e: ast.Expr): ast.Expr {
    if (e.kind === 'Ident') this.inPlace.add(e);
    return e;
  }

  /**
   * `xs.push(v)`. On a variable it appends in place: the variable owns its spare capacity.
   * A list inside a struct may share its array with copies of the struct, so it is copied first.
   */
  private push(e: ast.Call): string {
    const callee = e.callee as ast.Member;
    const [value] = this.operands(e.args);
    const target = this.place(callee.object);
    if (callee.object.kind === 'Ident') return `${target} = append(${target}, ${value})`;
    return `${target} = append(${this.owned(target)}, ${value})`;
  }

  /**
   * `assert c` → `if !(c) { candor.Fail(...) }`, with each interesting part of `c` wrapped in
   * `candor.Rec`, which notes its value as it passes through. Evaluation order and
   * short-circuiting are untouched; parts that never ran show nothing.
   */
  private assert(s: ast.AssertStmt): string[] {
    return this.recorded(s.expr, s.span, (args) => `candor.Fail(${args})`);
  }

  /**
   * `if !(c) { fail }` for an `assert` or a contract: `span` is the whole statement or clause,
   * shown as written; `fail` gets the arguments describing the failure.
   */
  private recorded(e: ast.Expr, span: Span, fail: (args: string) => string): string[] {
    const { text, column } = flatten(this.source, span);
    const parts = this.assertParts(e);
    const values = this.temp();
    const saved = this.recording;
    this.recording = { values, slots: new Map(parts.map((p, i) => [p.e, i])) };
    const lines = this.withPre(() => {
      const cond = this.expr(e);
      const cols = parts.map((p) => column(p.at));
      // Each part's own source, for `--json`: a reader needs no column arithmetic.
      const texts = parts.map((p) => goQuote(flatten(this.source, p.e.span).text));
      return [`if !(${cond}) {`, `\t${fail(`${this.tests && span.start.line > this.tests.from ? span.start.line - this.tests.from : span.start.line}, ${goQuote(text)}, []int{${cols.join(', ')}}, []string{${texts.join(', ')}}, ${values}`)}`, '}'];
    });
    this.recording = saved;
    return [`${values} := make([]string, ${parts.length})`, ...lines];
  }

  /**
   * A body with its contracts: each `requires` checked on entry; with an `ensures`, the body
   * runs in a closure, so every `return` and `?` in it hands its value to the checks.
   */
  private contracted(decl: ast.FnDecl, name: string, ret: Type, body: string[]): string[] {
    if (decl.contracts.length === 0) return body;
    const check = (c: ast.Contract) =>
      this.at(c.span, this.recorded(c.expr, c.span, (args) => `candor.Broke(${goQuote(c.clause)}, ${goQuote(name)}, ${args})`));
    const requires = decl.contracts.filter((c) => c.clause === 'requires').flatMap(check);
    const ensures = decl.contracts.filter((c) => c.clause === 'ensures');
    if (ensures.length === 0) return [...requires, ...body];
    const result = goIdent('result');
    return [
      ...requires,
      ...this.at(decl.body.span, [`${result} := func() ${this.goType(ret)} {`]),
      ...indent(body),
      ...this.at(decl.body.span, ['}()']),
      ...ensures.flatMap(check),
      `return ${result}`,
    ];
  }

  /** The parts of an asserted expression worth showing, each with the column its value goes under. */
  private assertParts(root: ast.Expr): { e: ast.Expr; at: Pos }[] {
    const out: { e: ast.Expr; at: Pos }[] = [];
    const add = (e: ast.Expr, at: Pos) => {
      const kind = this.info.types.get(e)?.kind;
      if (kind && !['unit', 'effect', 'fn', 'error', 'none', 'scope', 'task', 'handle'].includes(kind)) out.push({ e, at });
    };
    const visit = (e: ast.Expr) => {
      switch (e.kind) {
        case 'Ident':
          if (this.info.refs.get(e) === 'local') add(e, e.span.start);
          return;
        case 'Member':
          if (this.info.variantRefs.has(e)) return;
          visit(e.object);
          add(e, e.nameSpan.start);
          return;
        case 'Call':
          if (e.callee.kind === 'Member') visit(e.callee.object);
          e.args.forEach(visit);
          if (this.info.resultCtors.has(e)) return;
          add(e, e.callee.kind === 'Member' ? e.callee.nameSpan.start : e.callee.span.start);
          return;
        case 'Unary':
          visit(e.operand);
          add(e, e.opSpan.start);
          return;
        case 'Binary':
        case 'Range':
          visit(e.kind === 'Binary' ? e.left : e.start);
          visit(e.kind === 'Binary' ? e.right : e.end);
          add(e, e.opSpan.start);
          return;
        case 'Try':
          visit(e.operand);
          add(e, e.opSpan.start);
          return;
        case 'Index':
          visit(e.object);
          visit(e.index);
          add(e, e.bracketSpan.start);
          return;
        case 'ListLit':
        case 'TupleLit':
          e.items.forEach(visit);
          return;
        case 'Interp':
          // Each part's value, then the string they make.
          for (const p of e.parts) if (typeof p !== 'string') visit(p);
          add(e, e.span.start);
          return;
        case 'MapLit':
          for (const x of e.entries) {
            visit(x.key);
            visit(x.value);
          }
          return;
        case 'If':
        case 'Match':
          // The condition or subject always runs; of the branches, the result is enough.
          visit(e.kind === 'If' ? e.cond : e.subject);
          add(e, e.keywordSpan.start);
          return;
        default:
          // Literals already say what they are.
          return;
      }
    };
    visit(root);
    return out;
  }

  /** `e` as Go, wrapped when the checker recorded a `T` or `none` going where a `T?` is expected. */
  private expr(e: ast.Expr): string {
    const udf = this.info.sqlFunctions.get(e);
    if (udf) return this.sqlFunction(this.rawExpr(e), udf);
    let raw = this.rawExpr(e);
    // `m[k]` on a `Map<K, int?>`: the Go value is an option of an option.
    if (this.info.flattened.has(e)) raw = `${this.helper('flat')}(${raw})`;
    // A `T?` a test proved present: its value.
    if (this.info.narrowed.has(e)) raw = `${raw}.value`;
    const slot = this.recording?.slots.get(e);
    if (slot !== undefined) {
      raw = `candor.Rec[${this.goType(this.info.types.get(e)!)}](${this.recording!.values}, ${slot}, ${raw})`;
    }
    const to = this.info.coercions.get(e);
    if (to?.kind !== 'option') return raw;
    return e.kind === 'None' ? `${this.goType(to)}{}` : `${this.goType(to)}{some: true, value: ${raw}}`;
  }

  /**
   * The function `f` given to `sql.function`, as a `candor.SQLFunction`: its
   * arguments read from SQLite's values (NULL only into a `T?`), its result given back as one.
   */
  private sqlFunction(f: string, udf: SqlFunctionUse): string {
    const name = goQuote(udf.name);
    const reader = (t: Type) => {
      const k = t.kind as 'int' | 'float' | 'string' | 'bool' | 'bytes';
      const want = { int: 'an int', float: 'a float', string: 'a string', bool: 'a bool (0 or 1)', bytes: 'Bytes' }[k];
      return [goQuote(want), `candor.Row${k === 'bytes' ? 'Bytes' : k[0].toUpperCase() + k.slice(1)}`];
    };
    const lines: string[] = [];
    const args = udf.type.params.map((p, i) => {
      const one = p.kind === 'option' ? p.inner : p;
      const [want, read] = reader(one);
      lines.push(`x${i}, ok${i}, why := candor.SQLArg(${name}, ${i}, args[${i}], ${want}, ${read})`, 'if why != "" { return nil, why }');
      if (p.kind === 'option') return `${this.goType(p)}{some: ok${i}, value: x${i}}`;
      lines.push(`if !ok${i} { return nil, candor.SQLArgNull(${name}, ${i}, ${goQuote(udf.params[i])}) }`);
      return `x${i}`;
    });
    lines.push(`r := (${f})(candor.Root()${args.map((a) => ', ' + a).join('')})`);
    let ret = udf.type.ret;
    let v = 'r';
    if (ret.kind === 'result') {
      lines.push('if !r.ok { return nil, r.err }');
      ret = ret.ok;
      v = 'r.value';
    }
    if (ret.kind === 'option') {
      lines.push(`if !${v}.some { return nil, "" }`);
      v = `${v}.value`;
    }
    lines.push(`return candor.SQLOut(${v}), ""`);
    return `candor.SQLFunction{Args: ${udf.type.params.length}, Call: func(args []any) (any, string) { ${lines.join('; ')} }}`;
  }

  /** The Go type of `e` as used, after any wrapping. */
  private finalType(e: ast.Expr): Type {
    return this.info.coercions.get(e) ?? this.info.types.get(e)!;
  }

  private rawExpr(e: ast.Expr): string {
    switch (e.kind) {
      case 'None':
        // Always wrapped by `expr`: the checker gives every `none` a `T?` to become.
        return '';
      case 'String':
        return this.info.queries.has(e) ? `candor.SQLQuery{Text: ${goQuote(e.value)}}` : goQuote(e.value);
      case 'Interp': {
        if (this.info.queries.has(e)) return this.query(e);
        const exprs = e.parts.filter((p) => typeof p !== 'string');
        const values = this.operands(exprs);
        const pieces = e.parts.flatMap((p) => {
          if (typeof p === 'string') return p === '' ? [] : [goQuote(p)];
          const v = values[exprs.indexOf(p)];
          const t = this.finalType(p);
          if (t.kind === 'string') return [v];
          if (!shown(t)) return [`${this.dictValue(t, Show)}.toString(${CTX}, ${v})`];
          if (t.kind === 'char') return [`string(${v})`];
          if (t.kind === 'float') return [`candor.FloatString(${v})`];
          this.imports.add('strconv');
          return [t.kind === 'int' ? `strconv.FormatInt(${v}, 10)` : `strconv.FormatBool(${v})`];
        });
        return pieces.length === 0 ? '""' : `(${pieces.join(' + ')})`;
      }
      case 'Int':
        return e.value;
      case 'Char':
        return goRune(e.value);
      case 'Float':
        return `float64(${e.value})`;
      case 'Bool':
        return String(e.value);
      case 'Ident': {
        const ref = this.info.refs.get(e);
        if (ref === 'fn') return this.fnValue(this.info.fns.get(e.name)!, this.mod.name);
        if (ref === 'value') return this.valueRef(this.mod.name, e.name);
        const name = this.varName(e.name);
        // A `let mut` map read as a whole value: from here on, it may be shared.
        if (this.info.mutMapReads.has(e) && !this.inPlace.has(e)) return `${name}.Share()`;
        // The same for a list written by index: the next write copies first.
        if (this.info.mutListReads.has(e) && this.tracked.has(e.name) && !this.inPlace.has(e)) this.pre.push(`${name}__own = false`);
        return name;
      }
      case 'Lambda':
        return this.lambda(e);
      case 'ListLit':
        return `${this.goType(this.info.types.get(e)!)}{${this.operands(e.items).join(', ')}}`;
      case 'TupleLit': {
        const parts = this.operands(e.items);
        return `${this.goType(this.info.types.get(e)!)}{${parts.map((p, i) => `V${i}: ${p}`).join(', ')}}`;
      }
      case 'MapLit': {
        const t = this.goType(this.info.types.get(e)!);
        if (e.entries.length === 0) return `${t}{}`;
        const parts = this.operands(e.entries.flatMap((x) => [x.key, x.value]));
        const entries = e.entries.map((_, i) => `{Key: ${parts[2 * i]}, Value: ${parts[2 * i + 1]}}`);
        return `candor.MapOf([]${t.replace('candor.Map[', 'candor.MapEntry[')}{${entries.join(', ')}})`;
      }
      case 'Index': {
        if (this.info.types.get(e.object)!.kind === 'map') {
          const [m, k] = this.operands([this.mapRef(e.object), e.index]);
          return `${this.helper('optOf')}(${m}.Get(${k}))`;
        }
        const [xs, i] = this.operands([this.listRef(e.object), e.index]);
        return `${this.helper('at')}(${xs}, ${i})`;
      }
      case 'Unary':
        // Negating an int traps on overflow; a literal stays a Go constant (`-9_223_372_036_854_775_808` fits).
        if (e.op === '-' && e.operand.kind !== 'Int' && this.info.types.get(e.operand)!.kind === 'int') return `candor.Neg(${this.expr(e.operand)})`;
        // Parenthesized so `- -x` never becomes Go's `--x`.
        return `${e.op}(${this.expr(e.operand)})`;
      case 'Try':
        return this.tryExpr(e);
      case 'Range': {
        const [a, b] = this.operands([e.start, e.end]);
        return `candor.Range(${a}, ${b})`;
      }
      case 'Binary': {
        if (e.op === '??') return this.coalesce(e);
        if (e.op === '&&' || e.op === '||') return this.shortCircuit(e);
        // Comparing lists shares nothing.
        if (this.finalType(e.left).kind === 'list') [e.left, e.right].forEach((x) => this.listRef(x));
        if ((e.op === '==' || e.op === '!=') && (e.left.kind === 'None' || e.right.kind === 'None')) {
          const [x] = this.operands([e.left.kind === 'None' ? e.right : e.left]);
          return `(${e.op === '==' ? '!' : ''}${x}.some)`;
        }
        const [l, r] = this.operands([e.left, e.right]);
        if (e.op === '==' || e.op === '!=') {
          const t = this.finalType(e.left);
          if (goComparable(t)) return `(${l} ${e.op} ${r})`;
          return `${e.op === '!=' ? '!' : ''}${this.eqExpr(t, l, r)}`;
        }
        const operand = this.info.types.get(e.left)!;
        if ((e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=') && !ordered(operand)) {
          return `(${this.dictValue(operand, Ord)}.compare(${CTX}, ${l}, ${r}) ${e.op} 0)`;
        }
        return arith(operand, e.op, l, r);
      }
      case 'Member': {
        const ref = this.info.moduleRefs.get(e);
        if (ref?.kind === 'fn') return this.fnValue(this.unit(ref.module).info.fns.get(ref.name)!, ref.module);
        if (ref?.kind === 'value') return this.valueRef(ref.module, ref.name);
        const variant = this.info.variantRefs.get(e);
        if (variant?.kind === 'variant') return `${this.goType(variant.type)}{tag__: ${variant.variant.index}}`;
        const state = this.info.fakeState.get(e);
        if (state) {
          // `http.requests` in a test: the fake's own field, from then on shared.
          const field = `${this.expr(e.object)}.${goIdent(e.name)}`;
          if (state.mutable && state.type.kind === 'map') return `${field}.Share()`;
          if (this.unit((this.info.types.get(e.object) as { name: string }).name).info.indexed.has(state.decl)) this.pre.push(`${field}__own = false`);
          return field;
        }
        const objType = this.info.types.get(e.object)!;
        const name = objType.kind === 'effect' ? exported(e.name) : objType.kind === 'tuple' ? `V${e.name}` : goIdent(e.name);
        const method = this.info.types.get(e)!;
        if (objType.kind === 'effect' && builtinEffects.has(objType.name) && this.callee !== e && method.kind === 'fn' && (method.ret.kind === 'unit' || method.ret.kind === 'option')) {
          // The runtime's methods return nothing, or Go's `(v, ok)`; as a value, one must fit `fn(...) -> void` or `fn(...) -> T?`.
          const params = method.params.map((p, i) => `a__${i} ${this.goType(p)}`);
          const call = `${this.expr(e.object)}.${name}(${['c__', ...method.params.map((_, i) => `a__${i}`)].join(', ')})`;
          const body = method.ret.kind === 'unit' ? `${call}; return ${VOID}` : `return ${this.helper('optOf')}(${call})`;
          return `func(${[`c__ *candor.Ctx`, ...params].join(', ')}) ${this.goType(method.ret)} { ${body} }`;
        }
        const boxed = objType.kind === 'struct' && objType.fields.find((f) => f.name === e.name)?.boxed;
        return boxed ? `(*${this.expr(e.object)}.${name})` : `${this.expr(e.object)}.${name}`;
      }
      case 'Call': {
        const embed = this.info.embeds.get(e);
        if (embed) return this.embedVar(embed);
        const signals = this.info.signalCalls.get(e);
        if (signals && e.callee.kind === 'Member') {
          // The runtime knows signals by tag, so it is told how to read and make one.
          const [env, ...args] = this.operands([e.callee.object, ...e.args]);
          const t = this.typeName(signalType);
          if (signals === 'send') return `candor.SendSignal(${CTX}, ${env}, ${args[0]}.tag__)`;
          return `candor.Signals(${CTX}, ${env}, ${args[0]}, ${args[1]}, func(v ${t}) uint16 { return v.tag__ }, func(tag uint16) ${t} { return ${t}{tag__: tag} })`;
        }
        const flags = this.info.flagCalls.get(e);
        if (flags) return this.flagsParse(e, flags);
        const ctor = this.info.resultCtors.get(e);
        if (ctor) {
          const [value = VOID] = this.operands(e.args);
          const t = this.goType(this.info.types.get(e)!);
          return ctor === 'Ok' ? `${t}{ok: true, value: ${value}}` : `${t}{err: ${value}}`;
        }
        const listMethod = this.info.listCalls.get(e);
        if (listMethod) return this.listCall(e, listMethod);
        const mapMethod = this.info.mapCalls.get(e);
        if (mapMethod) return this.mapCall(e, mapMethod);
        const random = this.info.randomCalls.get(e);
        if (random) {
          const [r, xs] = this.operands([(e.callee as ast.Member).object, e.args[0]]);
          return random === 'shuffle' ? `candor.Shuffle(${CTX}, ${r}, ${xs})` : `${this.helper('optOf')}(candor.Pick(${CTX}, ${r}, ${xs}))`;
        }
        const check = this.info.resultChecks.get(e);
        if (check === 'ok') {
          const r = this.info.types.get((e.callee as ast.Member).object) as Type & { kind: 'result' };
          const from = this.goType(r);
          const to = this.goType({ kind: 'option', inner: r.ok });
          return `func(r ${from}) ${to} { if !r.ok { return ${to}{} }; return ${to}{some: true, value: r.value} }(${this.expr((e.callee as ast.Member).object)})`;
        }
        if (check !== undefined) return `${check === 'isOk' ? '' : '!'}${this.expr((e.callee as ast.Member).object)}.ok`;
        const mapped = this.info.wrapMaps.get(e);
        if (mapped) {
          const [r, f] = this.operands([(e.callee as ast.Member).object, e.args[0]]);
          const from = this.goType(this.info.types.get((e.callee as ast.Member).object)!);
          const to = this.goType(mapped.type);
          const body =
            mapped.side === 'err'
              ? `if r.ok { return ${to}{ok: true, value: r.value} }; return ${to}{err: ${f}(${CTX}, r.err)}`
              : mapped.side === 'ok'
                ? `if !r.ok { return ${to}{err: r.err} }; return ${to}{ok: true, value: ${f}(${CTX}, r.value)}`
                : `if !r.some { return ${to}{} }; return ${mapped.flat ? `${f}(${CTX}, r.value)` : `${to}{some: true, value: ${f}(${CTX}, r.value)}`}`;
          return `func(r ${from}) ${to} { ${body} }(${r})`;
        }
        const traitCall = this.info.traitCalls.get(e);
        if (traitCall) {
          const callee = e.callee as ast.Member;
          const [receiver, ...args] = this.operands([callee.object, ...e.args]);
          const caps = traitCall.trait.methods.get(callee.name)!.uses.map(goIdent);
          return `${this.dictValue(traitCall.self, traitCall.trait)}.${goIdent(callee.name)}(${[CTX, ...caps, receiver, ...args].join(', ')})`;
        }
        const taskCall = this.info.taskCalls.get(e);
        if (taskCall) return this.taskCall(e, taskCall);
        if (e.callee.kind === 'Member') {
          const method = this.info.methods.get(e.callee);
          if (method) {
            for (const p of method.imports) this.imports.add(p);
            const [receiver, ...args] = this.operands([e.callee.object, ...e.args]);
            const call = method.go(receiver, args);
            // A method that may have no answer gives Go's `(v, ok)`; the `T?` is built here.
            return method.type.ret.kind === 'option' ? `${this.helper('optOf')}(${call})` : call;
          }
        }
        const direct =
          e.callee.kind === 'Ident' && this.info.refs.get(e.callee) === 'fn'
            ? { module: this.mod.name, name: e.callee.name }
            : e.callee.kind === 'Member' && this.info.moduleRefs.get(e.callee)?.kind === 'fn'
              ? this.info.moduleRefs.get(e.callee)!
              : null;
        if (direct) {
          // Pass our own capabilities along; the checker guaranteed we have them.
          const sig = this.unit(direct.module).info.fns.get(direct.name)!;
          const args = this.operands(e.args);
          const typeArgs = this.info.callTypeArgs.get(e);
          // `sql.function`'s F is the function as SQLite takes it, `candor.SQLFunction`.
          const udf = e.args[1] && this.info.sqlFunctions.has(e.args[1]);
          const generic = udf ? '[candor.SQLFunction]' : typeArgs ? this.typeArgList(sig.typeParams, typeArgs) : '';
          return `${this.fnName(direct.name, direct.module)}${generic}(${[CTX, ...sig.uses.map(goIdent), ...args].join(', ')})`;
        }
        // An effect method, or a function value: the callee is evaluated first, like any operand.
        this.callee = e.callee;
        const [callee, ...args] = this.operands([e.callee, ...e.args]);
        const call = `${callee}(${[CTX, ...args].join(', ')})`;
        // A built-in effect's `T?` comes from Go as `(v, ok)`.
        const objType = e.callee.kind === 'Member' ? this.info.types.get(e.callee.object) : undefined;
        const builtinOpt = objType?.kind === 'effect' && builtinEffects.has(objType.name) && this.info.types.get(e)?.kind === 'option';
        return builtinOpt ? `${this.helper('optOf')}(${call})` : call;
      }
      case 'If': {
        // Go's `if` is a statement: declare a temporary and assign it in each branch.
        const t = this.temp();
        const lines = this.ifChain(e, t);
        this.pre.push(`var ${t} ${this.goType(this.info.types.get(e)!)}`, ...lines);
        return t;
      }
      case 'Match': {
        const t = this.temp();
        const lines = this.matchChain(e, t);
        this.pre.push(`var ${t} ${this.goType(this.info.types.get(e)!)}`, ...lines);
        return t;
      }
      case 'StructLit':
        return this.structLit(e);
    }
  }

  private structLit(e: ast.StructLit): string {
    const target = this.info.structLits.get(e)!;
    const values = this.operands([...(e.spread ? [e.spread] : []), ...e.fields.map((f) => f.value)]);
    if (e.spread) {
      // `{ ...base, x: 1 }`: copy, then overwrite. Go structs are values, so the copy is real.
      const [base, ...rest] = values;
      const t = this.temp();
      const fields = target.kind === 'struct' ? target.type.fields : [];
      this.pre.push(
        `var ${t} ${this.goType(target.type)} = ${base}`,
        ...e.fields.map((f, i) => {
          const boxed = fields.find((x) => x.name === f.name)?.boxed;
          return `${t}.${goIdent(f.name)} = ${boxed ? this.ptr(rest[i]) : rest[i]}`;
        }),
      );
      return t;
    }
    // An optional field left out is Go's zero value, `none`; a boxed one needs a pointer to it.
    const omitted = (fields: Field[], name: (f: Field) => string) =>
      fields.filter((f) => f.boxed && !e.fields.some((x) => x.name === f.name)).map((f) => `${name(f)}: ${this.ptr(`${this.goType(f.type)}{}`)}`);
    if (target.kind === 'struct') {
      const inits = e.fields.map((f, i) => {
        const boxed = target.type.fields.find((x) => x.name === f.name)!.boxed;
        return `${goIdent(f.name)}: ${boxed ? this.ptr(values[i]) : values[i]}`;
      });
      return `${this.goType(target.type)}{${[...inits, ...omitted(target.type.fields, (f) => goIdent(f.name))].join(', ')}}`;
    }
    const v = target.variant;
    const inits = e.fields.map((f, i) => {
      const boxed = v.fields.find((x) => x.name === f.name)!.boxed;
      return `${variantField(v.name, f.name)}: ${boxed ? this.ptr(values[i]) : values[i]}`;
    });
    return `${this.goType(target.type)}{${[`tag__: ${v.index}`, ...inits, ...omitted(v.fields, (f) => variantField(v.name, f.name))].join(', ')}}`;
  }

  /**
   * Arms become an `if`/`else if` chain, each testing its pattern with plain expressions. The
   * checker proved the match exhaustive, so the last arm needs no test.
   */
  private matchChain(e: ast.Match, assignTo: string | null): string[] {
    const subject = this.capture(e.subject);
    const type = this.info.types.get(e.subject)!;
    const lines = [...subject.pre];
    let path = subject.value;
    if (!/^[A-Za-z_]\w*$/.test(path)) {
      // Evaluate the subject once. `_ =` in case no arm looks at it.
      const t = this.temp();
      lines.push(`var ${t} ${this.goType(type)} = ${path}`, `_ = ${t}`);
      path = t;
    }
    // An arm with several patterns is one branch, or one per pattern when they bind names, as
    // each takes them from its own place.
    const branches: { cond: string; body: string[] }[] = [];
    for (const arm of e.arms) {
      const parts = arm.patterns.map((p) => {
        const conds: string[] = [];
        const binds: string[] = [];
        this.patternParts(p, path, type, conds, binds);
        return { cond: conds.length > 0 ? conds.join(' && ') : 'true', binds };
      });
      if (parts.every((x) => x.binds.length === 0)) {
        const cond = parts.length === 1 ? parts[0].cond : parts.map((x) => `(${x.cond})`).join(' || ');
        branches.push({ cond, body: this.block(arm.body, assignTo) });
      } else {
        for (const x of parts) branches.push({ cond: x.cond, body: [...x.binds, ...this.block(arm.body, assignTo)] });
      }
    }
    branches.forEach(({ cond, body }, i) => {
      const first = i === 0;
      const last = i === branches.length - 1;
      if (first && last) lines.push('{', ...indent(body), '}');
      else if (first) lines.push(`if ${cond} {`, ...indent(body));
      else if (last) lines.push('} else {', ...indent(body), '}');
      else lines.push(`} else if ${cond} {`, ...indent(body));
    });
    return lines;
  }

  /** The tests under which `p` matches the value at `path`, and the `var`s for its names. A name on a `T?` takes it whole unless the checker found `none` taken above. */
  private patternParts(p: ast.Pattern, path: string, t: Type, conds: string[], binds: string[]) {
    if (t.kind === 'option' && p.kind !== 'None' && p.kind !== 'Wildcard' && (p.kind !== 'Binding' || this.info.presentBindings.has(p))) {
      // Any other pattern on a `T?` is about the present value.
      conds.push(`${path}.some`);
      this.patternParts(p, `${path}.value`, t.inner, conds, binds);
      return;
    }
    switch (p.kind) {
      case 'Wildcard':
        return;
      case 'None':
        conds.push(`(!${path}.some)`);
        return;
      case 'Result': {
        if (t.kind !== 'result') return;
        const ok = p.variant === 'Ok';
        conds.push(ok ? `${path}.ok` : `(!${path}.ok)`);
        this.patternParts(p.inner, ok ? `${path}.value` : `${path}.err`, ok ? t.ok : t.err, conds, binds);
        return;
      }
      case 'Binding':
        binds.push(`var ${goIdent(p.name)} ${this.goType(t)} = ${path}`);
        if (this.info.unused.has(p)) binds.push(`_ = ${goIdent(p.name)}`);
        return;
      case 'Tuple':
        if (t.kind === 'tuple') p.items.forEach((x, i) => this.patternParts(x, `${path}.V${i}`, t.elems[i], conds, binds));
        return;
      case 'Literal': {
        const v = p.value;
        if (v.kind === 'Bool') conds.push(v.value ? path : `(!${path})`);
        else if (v.kind === 'Int') conds.push(`(${path} == ${p.negative ? '-' : ''}${v.value})`);
        else if (v.kind === 'Char') conds.push(`(${path} == ${goRune(v.value)})`);
        else conds.push(`(${path} == ${goQuote(v.value)})`);
        return;
      }
      case 'Ctor': {
        const target = this.info.patterns.get(p)!;
        if (target.kind === 'variant') conds.push(`(${path}.tag__ == ${target.variant.index})`);
        const fields = target.kind === 'struct' ? target.type.fields : target.variant.fields;
        for (const fp of p.fields) {
          const field = fields.find((f) => f.name === fp.name)!;
          let sub =
            target.kind === 'struct'
              ? `${path}.${goIdent(field.name)}`
              : `${path}.${variantField(target.variant.name, field.name)}`;
          // Safe to dereference: the tag test before it in `&&` makes sure this variant is set.
          if (field.boxed) sub = `(*${sub})`;
          this.patternParts(fp.pattern, sub, field.type, conds, binds);
        }
        return;
      }
    }
  }

  /**
   * Emits operands left to right. When a later operand needs statements hoisted before it,
   * earlier operands that call something are hoisted into temporaries first, so `f() + if ...`
   * still calls `f` before evaluating the `if`.
   */
  /**
   * `flags.parse(args, defaults)` for the struct it is given: a `candor.Flag` per
   * field, whose Set writes that field of a copy of the defaults.
   */
  private flagsParse(e: ast.Call, opts: StructType): string {
    const [args, defaults] = this.operands(e.args);
    const ret = this.finalType(e);
    const res = this.goType(ret);
    const ok = ret.kind === 'result' ? this.goType(ret.ok) : '';
    const exit = this.typeName(exitType);
    const fresh: string[] = [];
    const specs = opts.fields.map((f, i) => {
      const ff = flagField(f.type)!;
      const field = `o__.${goIdent(f.name)}`;
      const one = f.type.kind === 'option' ? f.type.inner : f.type.kind === 'list' ? f.type.elem : f.type;
      const ms = goIdent('ms');
      const read =
        ff.kind === 'string' ? 'v, why := s, ""'
        : ff.kind === 'duration' ? `n, why := candor.FlagDuration(s); v := ${this.goType(one)}{${ms}: n}`
        : `v, why := candor.Flag${ff.kind[0].toUpperCase()}${ff.kind.slice(1)}(s)`;
      let write: string;
      let dflt: string;
      if (ff.shape === 'option') {
        write = `${field} = ${this.goType(f.type)}{some: true, value: v}`;
        dflt = 'nil';
      } else if (ff.shape === 'list') {
        // The first use replaces the default; each adds one.
        fresh.push(`fresh${i}__ := true`);
        write = `if fresh${i}__ { ${field} = ${this.goType(f.type)}{}; fresh${i}__ = false }; ${field} = append(${field}, v)`;
        dflt = ff.kind === 'duration' ? `func() []int64 { ns := []int64{}; for _, d := range ${field} { ns = append(ns, d.${ms}) }; return ns }()` : field;
      } else {
        write = `${field} = v`;
        dflt = ff.kind === 'duration' ? `${field}.${ms}` : field;
      }
      const set = `func(s string) string { ${read}; if why == "" { ${write} }; return why }`;
      return `{Name: ${goQuote(flagName(f))}, Kind: "${ff.kind}", Help: ${goQuote(flagHelp(f.doc))}, Default: ${dflt}, Set: ${set}}`;
    });
    const header = opts.origin.doc ?? 'Usage:';
    return [
      `func() ${res} { o__ := ${defaults}; ${fresh.map((x) => x + '; ').join('')}`,
      `rest__, status__, message__ := candor.ParseFlags(${args}, ${goQuote(header)}, []candor.Flag{${specs.join(', ')}}); `,
      `if status__ >= 0 { return ${res}{err: ${exit}{${goIdent('status')}: int64(status__), ${goIdent('message')}: message__}} }; `,
      `return ${res}{ok: true, value: ${ok}{o__, rest__}} }()`,
    ].join('');
  }

  private operands(exprs: ast.Expr[]): string[] {
    const out: string[] = [];
    let pending: number[] = [];
    exprs.forEach((e, i) => {
      let c = this.capture(e);
      // A `void` expression as a value, as in `id(log())`: run it, then pass Go's one `struct{}`.
      if (this.finalType(e).kind === 'unit') c = { pre: [...c.pre, c.value], value: VOID };
      if (c.pre.length > 0) {
        for (const j of pending) {
          const t = this.temp();
          this.pre.push(`var ${t} ${this.goType(this.finalType(exprs[j]))} = ${out[j]}`);
          out[j] = t;
        }
        pending = [];
        this.pre.push(...c.pre);
      }
      out.push(c.value);
      if (callsSomething(e)) pending.push(i);
    });
    return out;
  }

  /** `x?`: hold `x`, return early if it has no value, and carry on with the value. */
  private tryExpr(e: ast.Try): string {
    const value = this.expr(e.operand);
    const operand = this.info.types.get(e.operand)!;
    const t = this.temp();
    const ret = this.goType(this.fnRet);
    this.pre.push(`var ${t} ${this.goType(operand)} = ${value}`);
    if (operand.kind === 'result') this.pre.push(`if !${t}.ok {`, `\treturn ${ret}{err: ${t}.err}`, '}');
    else this.pre.push(`if !${t}.some {`, `\treturn ${ret}{}`, '}');
    return `${t}.value`;
  }

  /** `x ?? d`: `d` is evaluated only when `x` is `none`. */
  private coalesce(e: ast.Binary): string {
    const left = this.expr(e.left);
    const right = this.capture(e.right);
    const resultType = this.goType(this.info.types.get(e)!);
    const leftType = this.goType(this.info.types.get(e.left)!);
    const o = this.temp();
    const t = this.temp();
    this.pre.push(
      `var ${o} ${leftType} = ${left}`,
      `var ${t} ${resultType}`,
      `if ${o}.some {`,
      // `x ?? y` with `y` a `T?` too keeps the option; otherwise it is the value.
      `\t${t} = ${resultType === leftType ? o : `${o}.value`}`,
      '} else {',
      ...indent(right.pre),
      `\t${t} = ${right.value}`,
      '}',
    );
    return t;
  }

  /** `a && b` where `b` needs hoisted statements: those may only run when `a` allows. */
  private shortCircuit(e: ast.Binary): string {
    const l = this.expr(e.left);
    const r = this.capture(e.right);
    if (r.pre.length === 0) return `(${l} ${e.op} ${r.value})`;
    const t = this.temp();
    this.pre.push(
      `var ${t} bool = ${l}`,
      `if ${e.op === '&&' ? t : `!${t}`} {`,
      ...indent(r.pre),
      `\t${t} = ${r.value}`,
      '}',
    );
    return t;
  }

  private ifChain(e: ast.If, assignTo: string | null): string[] {
    const cond = this.capture(e.cond);
    return [...cond.pre, ...this.ifFrom(e, cond.value, assignTo)];
  }

  /** `if <cond> { ... } else ...`, with the condition already emitted. */
  private ifFrom(e: ast.If, cond: string, assignTo: string | null): string[] {
    const lines = [`if ${cond} {`, ...indent(this.block(e.then, assignTo))];
    if (e.else === null) {
      lines.push('}');
    } else if (e.else.kind === 'If') {
      const next = this.capture(e.else.cond);
      const rest = this.ifFrom(e.else, next.value, assignTo);
      if (next.pre.length === 0) {
        // The condition is evaluated on the `else if` line, which may be lines below the `if`.
        lines.push(...this.at(e.else.cond.span, [`} else ${rest[0]}`]), ...rest.slice(1));
      } else {
        // The condition needs statements first, and `else if` has no room for them.
        lines.push('} else {', ...indent([...this.at(e.else.cond.span, next.pre), ...rest]), '}');
      }
    } else {
      lines.push('} else {', ...indent(this.block(e.else, assignTo)), '}');
    }
    return lines;
  }

  /** Runs `f` with an empty `pre`, and returns the hoisted statements followed by `f`'s lines. */
  private withPre(f: () => string[]): string[] {
    const saved = this.pre;
    this.pre = [];
    const lines = f();
    const out = [...this.pre, ...lines];
    this.pre = saved;
    return out;
  }

  /** Emits `e` with an empty `pre`, and hands back what it hoisted instead of keeping it. */
  private capture(e: ast.Expr): { pre: string[]; value: string } {
    const saved = this.pre;
    this.pre = [];
    const value = this.expr(e);
    const pre = this.pre;
    this.pre = saved;
    return { pre, value };
  }

  /**
   * A named function used as a value. One with effects is wrapped in a closure that passes our
   * capabilities, so every function value has the same Go type as its Candor type. The context
   * is the caller's: a function value runs in whichever task calls it.
   */
  private fnValue(sig: FnSig, module: string): string {
    const name = this.fnName(sig.name, module);
    if (sig.uses.length === 0) return name;
    const params = [`${CTX} *candor.Ctx`, ...sig.params.map((p, i) => `a__${i} ${this.goType(p.type)}`)];
    const args = [CTX, ...sig.uses.map(goIdent), ...sig.params.map((_, i) => `a__${i}`)];
    return `func(${params.join(', ')}) ${this.goType(sig.ret)} { return ${name}(${args.join(', ')}) }`;
  }

  /** A lambda becomes a Go closure in a temporary. It captures only values that never change. */
  private lambda(e: ast.Lambda): string {
    const t = this.info.types.get(e) as Type & { kind: 'fn' };
    const params = [`${CTX} *candor.Ctx`, ...e.params.map((p, i) => `${goIdent(p.name)} ${this.goType(t.params[i])}`)];
    const savedRet = this.fnRet;
    const savedPre = this.pre;
    const savedVoid = this.goVoid;
    this.fnRet = t.ret;
    this.goVoid = false;
    this.pre = [];
    let body: string[];
    const b = e.body;
    if (b.kind === 'Block') body = this.block(b, null);
    else if (t.ret.kind !== 'unit') body = this.withPre(() => [`return ${this.expr(b)}`]);
    else if (b.kind === 'If') body = this.ifChain(b, null);
    else if (b.kind === 'Match') body = this.matchChain(b, null);
    else body = this.withPre(() => [this.expr(b)]);
    body = this.fnBody(body, t.ret);
    // An expression body is no statement, so it marks its own lines.
    if (b.kind !== 'Block') body = this.at(b.span, body);
    this.fnRet = savedRet;
    this.goVoid = savedVoid;
    this.pre = savedPre;
    const name = this.temp();
    this.pre.push(`${name} := func(${params.join(', ')}) ${this.goType(t.ret)} {`, ...indent(body), '}');
    return name;
  }

  /** A map that is looked into or changed, not passed on: a `let mut` one stays its variable's own. */
  private mapRef(e: ast.Expr): ast.Expr {
    if (e.kind === 'Ident') this.inPlace.add(e);
    return e;
  }

  /**
   * Methods on maps (runtime/go/maps.go). `remove` on a variable changes it in place
   * while it owns its data; a map inside a struct may be shared with copies of the struct, so it
   * is copied first.
   */
  private mapCall(e: ast.Call, method: string): string {
    const callee = e.callee as ast.Member;
    if (method === 'remove') {
      const args = this.operands(e.args);
      const target = this.place(callee.object);
      return `${this.helper('optOf')}(${target}.${callee.object.kind === 'Ident' ? 'Remove' : 'RemoveCopy'}(${args.join(', ')}))`;
    }
    const [m, ...args] = this.operands([this.mapRef(callee.object), ...e.args]);
    switch (method) {
      case 'length':
        return `${m}.Len()`;
      case 'isEmpty':
        return `(${m}.Len() == 0)`;
      case 'has':
        return `${m}.Has(${args[0]})`;
      case 'keys':
        return `${m}.Keys()`;
      case 'values':
        return `${m}.Values()`;
      case 'entries':
        return `${this.helper('entries')}(${m})`;
      default:
        throw new Error(`no Go for map method ${method}`);
    }
  }

  private listCall(e: ast.Call, method: string): string {
    const callee = e.callee as ast.Member;
    const list = this.info.types.get(callee.object) as Type & { kind: 'list' };
    if (method === 'push') return this.push(e);
    if (method === 'pop') return `${this.helper('pop')}(&${this.place(callee.object)})`;
    // No method hands the receiver's array on: `concat`, `sorted` and `reversed` copy, the rest read.
    const [xs, ...args] = this.operands([this.listRef(callee.object), ...e.args]);
    switch (method) {
      case 'length':
        return `int64(len(${xs}))`;
      case 'isEmpty':
        return `(len(${xs}) == 0)`;
      case 'first':
        return `${this.helper('at')}(${xs}, 0)`;
      case 'last':
        return `${this.helper('last')}(${xs})`;
      case 'enumerated':
        return `${this.helper('enumerated')}(${xs})`;
      case 'contains':
        if (goComparable(list.elem)) {
          this.imports.add('slices');
          return `slices.Contains(${xs}, ${args[0]})`;
        }
        return `${this.helper('contains')}(${xs}, ${args[0]}, ${list.elem.kind === 'param' ? `${this.dictValue(list.elem, Eq)}.eq` : this.eqFn(list.elem)})`;
      case 'unique':
      case 'union':
      case 'intersect': {
        // By a Go map when `==` does; else by the type's own equality, pair by pair.
        const fn = method[0].toUpperCase() + method.slice(1);
        if (goComparable(list.elem)) return `candor.${fn}(${[xs, ...args].join(', ')})`;
        const eq = list.elem.kind === 'param' ? `${this.dictValue(list.elem, Eq)}.eq` : list.elem.kind === 'bytes' ? 'candor.BytesEqual' : this.eqFn(list.elem);
        return `candor.${fn}Eq(${[xs, ...args, eq].join(', ')})`;
      }
      case 'sorted':
        this.imports.add('cmp');
        this.imports.add('slices');
        return `${this.helper('sorted')}(${CTX}, ${xs}, ${this.dictValue(list.elem, Ord)}.compare)`;
      case 'min':
      case 'max':
        return `${this.helper('extreme')}(${CTX}, ${xs}, ${this.dictValue(list.elem, Ord)}.compare, ${method === 'min' ? -1 : 1})`;
      case 'join':
        if (list.elem.kind === 'char') return `candor.JoinChars(${xs}, ${args[0]})`;
        this.imports.add('strings');
        return `strings.Join(${xs}, ${args[0]})`;
      case 'reversed':
        return `candor.Reversed(${xs})`;
      case 'concat':
        // A fresh array: the result shares nothing.
        this.imports.add('slices');
        return `slices.Concat(${xs}, ${args[0]})`;
      case 'slice':
        if (args.length === 1) this.imports.add('math');
        return `candor.SliceList(${xs}, ${args[0]}, ${args[1] ?? 'math.MaxInt64'})`;
      case 'map':
        return `${this.helper('map')}(${CTX}, ${xs}, ${args[0]})`;
      case 'filter':
        return `${this.helper('filter')}(${CTX}, ${xs}, ${args[0]})`;
      case 'all':
        return `${this.helper('all')}(${CTX}, ${xs}, ${args[0]})`;
      case 'any':
        return `${this.helper('any')}(${CTX}, ${xs}, ${args[0]})`;
      case 'fold':
        return `${this.helper('fold')}(${CTX}, ${xs}, ${args[0]}, ${args[1]})`;
      case 'sum':
        return (this.info.types.get(e) as Type).kind === 'float' ? `candor.SumFloats(${xs})` : `${this.helper('sum')}(${xs})`;
      case 'sortedBy': {
        const key = (this.info.types.get(e.args[0]) as FnType).ret;
        this.imports.add('cmp');
        this.imports.add('slices');
        return `${this.helper('sortedBy')}(${CTX}, ${xs}, ${args[0]}, ${this.dictValue(key, Ord)}.compare)`;
      }
      default:
        throw new Error(`no Go for list method ${method}`);
    }
  }

  /** Calls on `tasks`, a `Scope` or a `Task`: generic functions in the runtime. */
  private taskCall(e: ast.Call, call: TaskCall): string {
    const callee = e.callee as ast.Member;
    if (call.kind === 'join') return `${this.expr(callee.object)}.Join(${CTX})`;
    if (call.kind === 'wait') return `${this.expr(callee.object)}.Wait(${CTX})`;
    const failed = (t: Type) => (t.kind === 'result' ? `func(r ${this.goType(t)}) bool { return !r.ok }` : 'nil');
    switch (call.kind) {
      case 'scope': {
        const [f] = this.operands(e.args);
        return `candor.RunScope(${CTX}, ${f}, ${failed(call.ret)})`;
      }
      case 'spawn': {
        const [s, f] = this.operands([callee.object, ...e.args]);
        // A failure becomes the scope's result: the same error, in the scope's Result type.
        const scopeRet = call.scope?.ret;
        const fail =
          call.ret.kind === 'result' && scopeRet?.kind === 'result'
            ? `func(v ${this.goType(call.ret)}) (any, bool) { return ${this.goType(scopeRet)}{err: v.err}, !v.ok }`
            : 'nil';
        return `candor.${call.background ? 'Background' : 'Spawn'}(${CTX}, ${s}, ${f}, ${fail})`;
      }
      case 'all': {
        const [xs, f] = this.operands(e.args);
        if (call.ret.kind === 'result') return `${this.helper('allRes')}(candor.All(${CTX}, ${xs}, ${f}, ${failed(call.ret)}))`;
        return `candor.AllValues(${CTX}, ${xs}, ${f})`;
      }
      case 'race': {
        const [fs] = this.operands(e.args);
        return `candor.Race(${CTX}, ${fs}, ${failed(call.ret)})`;
      }
      case 'timeout': {
        const [ms, f] = this.operands(e.args);
        // Nothing to give back: whether it finished in time.
        if (call.ret.kind === 'unit') return `candor.TimeoutDone(${CTX}, ${ms}, ${f})`;
        return `${this.helper('optOf')}(candor.Timeout(${CTX}, ${ms}, ${f}))`;
      }
      case 'both':
        return this.both(e, call);
      case 'make': {
        const [s, v] = this.operands([callee.object, ...e.args]);
        const t = call.type;
        if (t.handle === 'Lock') return `candor.NewLock(${CTX}, ${s})`;
        if (t.handle === 'Atomic') return `candor.NewAtomic${t.arg.kind === 'bool' ? 'Bool' : 'Int'}(${CTX}, ${s}, ${v})`;
        // Explicit, so a constant doesn't make Go pick its own type.
        return `candor.New${t.handle}[${this.goType(t.arg)}](${CTX}, ${s}, ${v})`;
      }
      case 'shared': {
        const [h, ...args] = this.operands([callee.object, ...e.args]);
        if (call.method === 'updateWith') return `candor.UpdateWith(${CTX}, ${h}, ${args[0]})`;
        if (call.method === 'hold') return `candor.Hold(${CTX}, ${h}, ${args[0]})`;
        const go = `${h}.${call.method[0].toUpperCase()}${call.method.slice(1)}(${[CTX, ...args].join(', ')})`;
        return call.method === 'recv' ? `${this.helper('optOf')}(${go})` : go;
      }
      case 'arm': {
        if (call.method === 'after' || call.method === 'otherwise') {
          const args = this.operands(e.args);
          return call.method === 'after' ? `candor.After(${CTX}, ${args[0]}, ${args[1]})` : `candor.Otherwise(${CTX}, ${args[0]})`;
        }
        const [ch, ...args] = this.operands([callee.object, ...e.args]);
        if (call.method === 'onSend') return `candor.OnSend(${CTX}, ${ch}, ${args[0]}, ${args[1]})`;
        // The runtime hands over the value and whether there was one; the function takes a `T?`.
        return `candor.OnRecv(${CTX}, ${ch}, func(c *candor.Ctx, v ${this.goType(call.elem!)}, ok bool) ${this.goType(call.ret)} { return ${args[0]}(c, ${this.helper('optOf')}(v, ok)) })`;
      }
      case 'select': {
        const [arms] = this.operands(e.args);
        return `candor.Select(${CTX}, ${arms})`;
      }
    }
  }

  /** `tasks.both(a, b)`: the runtime gives both results and which failed first; this makes the tuple, or the Result of one. */
  private both(e: ast.Call, call: TaskCall & { kind: 'both' }): string {
    const [fa, fb] = this.operands(e.args);
    const failed = (t: Type) => (t.kind === 'result' ? `func(r ${this.goType(t)}) bool { return !r.ok }` : 'nil');
    const ret = this.goType(call.ret);
    const both = `a__, b__, failed__ := candor.Both(${CTX}, ${fa}, ${fb}, ${failed(call.a)}, ${failed(call.b)})`;
    const part = (t: Type, v: string) => (t.kind === 'result' ? `${v}.value` : v);
    const pair = `${this.goType(call.ret.kind === 'result' ? call.ret.ok : call.ret)}{${part(call.a, 'a__')}, ${part(call.b, 'b__')}}`;
    const lines = [both];
    if (call.a.kind === 'result') lines.push(`if failed__ == 1 { return ${ret}{err: a__.err} }`);
    if (call.b.kind === 'result') lines.push(`if failed__ == 2 { return ${ret}{err: b__.err} }`);
    lines.push(call.ret.kind === 'result' ? `return ${ret}{ok: true, value: ${pair}}` : `_ = failed__; return ${pair}`);
    return `func() ${ret} { ${lines.join('; ')} }()`;
  }

  /** A string literal that is a `sql.Query`: `?` where each `${...}` was, and the values apart. */
  private query(e: ast.Interp): string {
    const exprs = e.parts.filter((p) => typeof p !== 'string');
    const values = this.operands(exprs);
    // `${none}` is NULL; a `T?` is NULL when none.
    const args = exprs.map((p, i) => (p.kind === 'None' ? 'nil' : this.finalType(p).kind === 'option' ? `${this.helper('sqlArg')}(${values[i]})` : values[i]));
    const text = e.parts.map((p) => (typeof p === 'string' ? p : '?')).join('');
    return `candor.SQLQuery{Text: ${goQuote(text)}, Args: []any{${args.join(', ')}}}`;
  }

  /** A generic Go helper, emitted once if used. */
  private helper(name: keyof typeof goHelpers): string {
    if (name === 'extreme') this.imports.add('cmp');
    if (name === 'at' || name === 'last' || name === 'extreme' || name === 'pop' || name === 'optOf' || name === 'flat' || name === 'jsonOpt' || name === 'sqlArg' || name === 'showOpt') this.needsOpt = true;
    if (name === 'allRes' || name === 'showRes') this.needsRes = true;
    if (name === 'showList' || name === 'showMap' || name === 'showOpt' || name === 'showRes' || name === 'showVoid') this.helper('Show');
    if (name === 'last') this.helper('at');
    this.helpers.add(name);
    return `${name}__`;
  }

  /** `a == b` on values of `t`, as a Go expression. */
  private eqExpr(t: Type, a: string, b: string): string {
    if (goComparable(t)) return `${a} == ${b}`;
    if (t.kind === 'bytes') return `candor.BytesEqual(${a}, ${b})`;
    if (t.kind === 'param') return `${this.dictValue(t, Eq)}.eq(${a}, ${b})`;
    return `${this.eqFn(t)}(${a}, ${b})`;
  }

  /**
   * A function comparing two values of `t` by value, for types Go's `==` can't do: those with
   * lists, fields behind pointers, or type parameters. Generated once per type; one holding
   * type parameters is generic over them and their `Eq` dictionaries. Returns what to call.
   */
  private eqFn(t: Type): string {
    const ps = [...paramsIn(t)];
    const call = (name: string) => (ps.length > 0 ? `${name}${this.typeArgList(ps, ps)}` : name);
    const key = typeKey(t);
    const existing = this.eqNames.get(key);
    if (existing) return call(existing);
    const name = `eq__${this.eqNames.size + 1}`;
    this.eqNames.set(key, name);
    const eq = (ft: Type, a: string, b: string, boxed = false): string => {
      const [x, y] = boxed ? [`*${a}`, `*${b}`] : [a, b];
      return this.eqExpr(ft, x, y);
    };
    const fieldsEqual = (fs: { name: string; type: Type; boxed: boolean }[], goName: (f: string) => string) =>
      fs.length === 0 ? 'true' : fs.map((f) => eq(f.type, `a.${goName(f.name)}`, `b.${goName(f.name)}`, f.boxed)).join(' && ');
    let body: string[];
    switch (t.kind) {
      case 'struct':
        body = [`return ${fieldsEqual(t.fields, goIdent)}`];
        break;
      case 'enum':
        body = [
          'if a.tag__ != b.tag__ {',
          '\treturn false',
          '}',
          'switch a.tag__ {',
          ...t.variants
            .filter((v) => v.fields.length > 0)
            .flatMap((v) => [`case ${v.index}:`, `\treturn ${fieldsEqual(v.fields, (f) => variantField(v.name, f))}`]),
          '}',
          'return true',
        ];
        break;
      case 'option':
        body = [`return a.some == b.some && (!a.some || ${eq(t.inner, 'a.value', 'b.value')})`];
        break;
      case 'tuple':
        body = [`return ${t.elems.map((x, i) => eq(x, `a.V${i}`, `b.V${i}`)).join(' && ')}`];
        break;
      case 'result':
        body = [
          'if a.ok != b.ok {',
          '\treturn false',
          '}',
          'if a.ok {',
          `\treturn ${eq(t.ok, 'a.value', 'b.value')}`,
          '}',
          `return ${eq(t.err, 'a.err', 'b.err')}`,
        ];
        break;
      case 'list':
        body = [
          'if len(a) != len(b) {',
          '\treturn false',
          '}',
          'for i := range a {',
          `\tif !(${eq(t.elem, 'a[i]', 'b[i]')}) {`,
          '\t\treturn false',
          '\t}',
          '}',
          'return true',
        ];
        break;
      case 'map': {
        const v = this.goType(t.value);
        const eqValue = goComparable(t.value) ? `func(x, y ${v}) bool { return x == y }` : t.value.kind === 'param' ? `${this.dictValue(t.value, Eq)}.eq` : this.eqFn(t.value);
        body = [`return candor.MapEq(a, b, ${eqValue})`];
        break;
      }
      case 'bytes':
        body = ['return candor.BytesEqual(a, b)'];
        break;
      default:
        throw new Error(`no equality for ${t.kind}`);
    }
    const goT = this.goType(t);
    this.eqDecls.push('', `// == on ${typeToString(t)}`, `func ${name}${this.fnTypeParams(ps)}(a, b ${goT}) bool {`, ...indent(body), '}');
    return call(name);
  }

  /**
   * The `Eq` dictionary of `t`: Go's `==` where it compares as Candor does, otherwise a type
   * whose `eq` calls the generated equality function.
   */
  private eqDict(t: Type): string {
    if (goComparable(t)) return `${this.helper('eqGo')}[${this.goType(t)}]`;
    const key = `dict ${typeKey(t)}`;
    const ps = [...paramsIn(t)];
    const args = ps.length > 0 ? this.typeArgList(ps, ps) : '';
    const existing = this.eqNames.get(key);
    if (existing) return `${existing}${args}`;
    const name = `eqd__${this.eqNames.size + 1}`;
    this.eqNames.set(key, name);
    const fnCall = this.eqFn(t);
    this.eqDecls.push('', `type ${name}${this.fnTypeParams(ps)} struct{}`, '', `func (${name}${args}) eq(a, b ${this.goType(t)}) bool {`, `\treturn ${fnCall}(a, b)`, '}');
    return `${name}${args}`;
  }

  /** Ord for a tuple: item by item, the first that differs decides. */
  private ordTupleDict(t: Type & { kind: 'tuple' }): string {
    const key = `ord ${typeKey(t)}`;
    const ps = [...paramsIn(t)];
    const args = ps.length > 0 ? this.typeArgList(ps, ps) : '';
    const existing = this.eqNames.get(key);
    if (existing) return `${existing}${args}`;
    const name = `ordd__${this.eqNames.size + 1}`;
    this.eqNames.set(key, name);
    const items = t.elems.flatMap((x, i) => [`\tif d := (${this.dictValue(x, Ord)}).compare(c, a.V${i}, b.V${i}); d != 0 {`, '\t\treturn d', '\t}']);
    this.eqDecls.push('', `type ${name}${this.fnTypeParams(ps)} struct{}`, '', `func (${name}${args}) compare(c *candor.Ctx, a, b ${this.goType(t)}) int64 {`, ...items, '\treturn 0', '}');
    return `${name}${args}`;
  }

  private ptr(value: string): string {
    this.needsPtr = true;
    return `ptr__(${value})`;
  }

  private temp(): string {
    return `t__${++this.temps}`;
  }

  /**
   * `const limit = 20`, folded by the checker; a list, map or record is a Go variable
   * that `init` sets, so a function it names may read it without Go seeing a cycle.
   */
  private constDecl(decl: ast.ConstDecl): string {
    const v = this.info.values.get(decl.name)!;
    if (v.value === undefined) return `var ${this.fnName(decl.name)} ${this.goType(v.type)}`;
    const value = v.type.kind === 'string' ? goQuote(v.value as string) : v.type.kind === 'char' ? goRune(v.value as string) : String(v.value);
    return `const ${this.fnName(decl.name)} ${this.goType(v.type)} = ${value}`;
  }

  /** An extern `let` is read through a function; a const is a Go const. */
  private valueRef(module: string, name: string): string {
    const v = this.unit(module).info.values.get(name)!;
    return v.decl.kind === 'ConstDecl' ? this.fnName(name, module) : `${this.fnName(name, module)}()`;
  }

  private fnName(name: string, module = this.mod.name): string {
    return `${module}__${name}`;
  }

  private typeName(t: UserType): string {
    if (builtinTypes.includes(t.origin)) this.usesBuiltin.add(t.origin);
    return `${t.module}__${t.name}`;
  }

  private unit(module: string): EmitUnit {
    return this.units.find((u) => u.mod.name === module)!;
  }

  private goType(t: Type): string {
    switch (t.kind) {
      case 'string':
        return 'string';
      case 'int':
        return 'int64';
      case 'bool':
        return 'bool';
      case 'char':
        return 'rune';
      case 'float':
        return 'float64';
      case 'bytes':
        return '[]byte';
      case 'goerror':
        return 'candor.GoError';
      case 'effect':
        return builtinEffects.get(t.name)?.go.type ?? effectType(t.name);
      case 'struct':
      case 'enum':
        return `${this.typeName(t)}${t.args.length > 0 ? `[${t.args.map((a) => this.goType(a)).join(', ')}]` : ''}`;
      case 'param':
        return typeParamName(t);
      case 'option':
        this.needsOpt = true;
        return `opt__[${this.goType(t.inner)}]`;
      case 'result':
        this.needsRes = true;
        return `res__[${this.goType(t.ok)}, ${this.goType(t.err)}]`;
      case 'list':
        return `[]${this.goType(t.elem)}`;
      case 'map':
        return `candor.Map[${this.goType(t.key)}, ${this.goType(t.value)}]`;
      case 'tuple':
        // Exported fields, so the runtime can show them; Go's `==` works when the parts' does.
        return `struct{ ${t.elems.map((x, i) => `V${i} ${this.goType(x)}`).join('; ')} }`;
      case 'fn': {
        return `func(${['*candor.Ctx', ...t.params.map((p) => this.goType(p))].join(', ')}) ${this.goType(t.ret)}`;
      }
      case 'scope':
        return '*candor.Scope';
      case 'task':
        return `*candor.Task[${this.goType(t.result)}]`;
      case 'handle':
        if (t.handle === 'Atomic') return t.arg.kind === 'bool' ? '*candor.AtomicBool' : '*candor.AtomicInt';
        if (t.handle === 'Lock') return '*candor.Lock';
        return `*candor.${t.handle}[${this.goType(t.arg)}]`;
      case 'unit':
        return 'struct{}';
      case 'opaque':
        // An alias declared in bindings.go.
        return `${t.module}__${t.name}`;
      default:
        throw new Error(`no Go type for ${t.kind}`);
    }
  }
}

const goHelpers = {
  at: [
    '// xs[i]: none when out of range.',
    'func at__[T any](xs []T, i int64) opt__[T] {',
    '\tif i < 0 || i >= int64(len(xs)) {',
    '\t\treturn opt__[T]{}',
    '\t}',
    '\treturn opt__[T]{some: true, value: xs[i]}',
    '}',
  ],
  last: ['func last__[T any](xs []T) opt__[T] {', '\treturn at__(xs, int64(len(xs))-1)', '}'],
  enumerated: [
    '// xs.enumerated(): each item with its index.',
    'func enumerated__[T any](xs []T) []struct{ V0 int64; V1 T } {',
    '\tout := make([]struct{ V0 int64; V1 T }, len(xs))',
    '\tfor i, x := range xs {',
    '\t\tout[i].V0, out[i].V1 = int64(i), x',
    '\t}',
    '\treturn out',
    '}',
  ],
  entries: [
    '// m.entries(): each key with its value, in order.',
    'func entries__[K, V any](m candor.Map[K, V]) []struct{ V0 K; V1 V } {',
    '\tes := m.Entries()',
    '\tout := make([]struct{ V0 K; V1 V }, len(es))',
    '\tfor i, e := range es {',
    '\t\tout[i].V0, out[i].V1 = e.Key, e.Value',
    '\t}',
    '\treturn out',
    '}',
  ],
  map: [
    'func map__[T, U any](c *candor.Ctx, xs []T, f func(*candor.Ctx, T) U) []U {',
    '\tout := make([]U, len(xs))',
    '\tfor i, x := range xs {',
    '\t\tout[i] = f(c, x)',
    '\t}',
    '\treturn out',
    '}',
  ],
  all: [
    'func all__[T any](c *candor.Ctx, xs []T, f func(*candor.Ctx, T) bool) bool {',
    '\tfor _, x := range xs {',
    '\t\tif !f(c, x) {',
    '\t\t\treturn false',
    '\t\t}',
    '\t}',
    '\treturn true',
    '}',
  ],
  any: [
    'func any__[T any](c *candor.Ctx, xs []T, f func(*candor.Ctx, T) bool) bool {',
    '\tfor _, x := range xs {',
    '\t\tif f(c, x) {',
    '\t\t\treturn true',
    '\t\t}',
    '\t}',
    '\treturn false',
    '}',
  ],
  fold: [
    'func fold__[T, A any](c *candor.Ctx, xs []T, acc A, f func(*candor.Ctx, A, T) A) A {',
    '\tfor _, x := range xs {',
    '\t\tacc = f(c, acc, x)',
    '\t}',
    '\treturn acc',
    '}',
  ],
  sum: [
    'func sum__(xs []int64) int64 {',
    '\tvar total int64',
    '\tfor _, x := range xs {',
    '\t\ttotal = candor.Add(total, x)',
    '\t}',
    '\treturn total',
    '}',
  ],
  filter: [
    'func filter__[T any](c *candor.Ctx, xs []T, f func(*candor.Ctx, T) bool) []T {',
    '\tout := []T{}',
    '\tfor _, x := range xs {',
    '\t\tif f(c, x) {',
    '\t\t\tout = append(out, x)',
    '\t\t}',
    '\t}',
    '\treturn out',
    '}',
  ],
  contains: [
    'func contains__[T any](xs []T, x T, eq func(a, b T) bool) bool {',
    '\tfor _, y := range xs {',
    '\t\tif eq(x, y) {',
    '\t\t\treturn true',
    '\t\t}',
    '\t}',
    '\treturn false',
    '}',
  ],
  set: [
    '// xs[i] = v on a variable: copies the list first unless the variable owns its items.',
    'func set__[T any](xs *[]T, own *bool, i int64, v T) {',
    '\tcandor.CheckIndex(i, len(*xs))',
    '\tif !*own {',
    '\t\t*xs = slices.Clone(*xs)',
    '\t\t*own = true',
    '\t}',
    '\t(*xs)[i] = v',
    '}',
  ],
  setCopy: [
    '// xs[i] = v on a list inside a struct: it may be shared with copies of the struct, so it is copied.',
    'func setCopy__[T any](xs []T, i int64, v T) []T {',
    '\tcandor.CheckIndex(i, len(xs))',
    '\tout := slices.Clone(xs)',
    '\tout[i] = v',
    '\treturn out',
    '}',
  ],
  get: [
    '// xs[i] for `xs[i] op= v`: out of range is the same bug as for the write.',
    'func get__[T any](xs []T, i int64) T {',
    '\tcandor.CheckIndex(i, len(xs))',
    '\treturn xs[i]',
    '}',
  ],
  pop: [
    '// Clips what is left, so a later push copies instead of overwriting what other values see.',
    'func pop__[T any](xs *[]T) opt__[T] {',
    '\tn := len(*xs)',
    '\tif n == 0 {',
    '\t\treturn opt__[T]{}',
    '\t}',
    '\tv := (*xs)[n-1]',
    '\t*xs = (*xs)[: n-1 : n-1]',
    '\treturn opt__[T]{some: true, value: v}',
    '}',
  ],
  Eq: ['// `T: Eq`: a dictionary comparing two values of T.', 'type Eq__[T any] interface {', '\teq(a, b T) bool', '}'],
  Ord: ['// `T: Ord`: a dictionary ordering two values of T.', 'type Ord__[T any] interface {', '\tcompare(c *candor.Ctx, a, b T) int64', '}'],
  Show: [
    '// `T: Show`: a dictionary reading a value of T as a string. `literal` is how it reads inside a',
    '// list, optional or Result: as Candor writes it, strings quoted.',
    'type Show__[T any] interface {',
    '\ttoString(c *candor.Ctx, a T) string',
    '\tliteral(c *candor.Ctx, a T) string',
    '}',
  ],
  showGo: [
    '// Show for int, string, bool, char and float: how interpolation reads them.',
    'type showGo__[T int64 | string | bool | rune | float64] struct{}',
    '',
    'func (showGo__[T]) toString(_ *candor.Ctx, a T) string {',
    '\tswitch v := any(a).(type) {',
    '\tcase int64:',
    '\t\treturn strconv.FormatInt(v, 10)',
    '\tcase bool:',
    '\t\treturn strconv.FormatBool(v)',
    '\tcase rune:',
    '\t\treturn string(v)',
    '\tcase float64:',
    '\t\treturn candor.FloatString(v)',
    '\t}',
    '\treturn any(a).(string)',
    '}',
    '',
    'func (d showGo__[T]) literal(c *candor.Ctx, a T) string {',
    '\tswitch v := any(a).(type) {',
    '\tcase string:',
    '\t\treturn strconv.Quote(v)',
    '\tcase rune:',
    '\t\treturn strconv.QuoteRune(v)',
    '\t}',
    '\treturn d.toString(c, a)',
    '}',
  ],
  showList: [
    '// Show for List<T>: its items as literals, `[1, 2]`.',
    'type showList__[T any, D Show__[T]] struct{}',
    '',
    'func (showList__[T, D]) toString(c *candor.Ctx, a []T) string {',
    '\ts := "["',
    '\tfor i, v := range a {',
    '\t\tif i > 0 {',
    '\t\t\ts += ", "',
    '\t\t}',
    '\t\ts += (*new(D)).literal(c, v)',
    '\t}',
    '\treturn s + "]"',
    '}',
    '',
    'func (d showList__[T, D]) literal(c *candor.Ctx, a []T) string {',
    '\treturn d.toString(c, a)',
    '}',
  ],
  showMap: [
    '// Show for Map<K, V>: its entries as literals in insertion order, `["a": 1]`, or `[:]`.',
    'type showMap__[K any, V any, DK Show__[K], DV Show__[V]] struct{}',
    '',
    'func (showMap__[K, V, DK, DV]) toString(c *candor.Ctx, a candor.Map[K, V]) string {',
    '\tif a.Len() == 0 {',
    '\t\treturn "[:]"',
    '\t}',
    '\ts := "["',
    '\tfor i, e := range a.Entries() {',
    '\t\tif i > 0 {',
    '\t\t\ts += ", "',
    '\t\t}',
    '\t\ts += (*new(DK)).literal(c, e.Key) + ": " + (*new(DV)).literal(c, e.Value)',
    '\t}',
    '\treturn s + "]"',
    '}',
    '',
    'func (d showMap__[K, V, DK, DV]) literal(c *candor.Ctx, a candor.Map[K, V]) string {',
    '\treturn d.toString(c, a)',
    '}',
  ],
  showOpt: [
    '// Show for T?: the value as T reads, or `none`.',
    'type showOpt__[T any, D Show__[T]] struct{}',
    '',
    'func (showOpt__[T, D]) toString(c *candor.Ctx, a opt__[T]) string {',
    '\tif !a.some {',
    '\t\treturn "none"',
    '\t}',
    '\treturn (*new(D)).toString(c, a.value)',
    '}',
    '',
    'func (showOpt__[T, D]) literal(c *candor.Ctx, a opt__[T]) string {',
    '\tif !a.some {',
    '\t\treturn "none"',
    '\t}',
    '\treturn (*new(D)).literal(c, a.value)',
    '}',
  ],
  showRes: [
    '// Show for Result<T, E>: `Ok(...)` or `Err(...)`, a literal inside.',
    'type showRes__[T any, E any, DT Show__[T], DE Show__[E]] struct{}',
    '',
    'func (showRes__[T, E, DT, DE]) toString(c *candor.Ctx, a res__[T, E]) string {',
    '\tif a.ok {',
    '\t\treturn "Ok(" + (*new(DT)).literal(c, a.value) + ")"',
    '\t}',
    '\treturn "Err(" + (*new(DE)).literal(c, a.err) + ")"',
    '}',
    '',
    'func (d showRes__[T, E, DT, DE]) literal(c *candor.Ctx, a res__[T, E]) string {',
    '\treturn d.toString(c, a)',
    '}',
  ],
  showVoid: [
    '// Show for the nothing inside `Ok()`.',
    'type showVoid__ struct{}',
    '',
    'func (showVoid__) toString(*candor.Ctx, struct{}) string {',
    '\treturn ""',
    '}',
    '',
    'func (showVoid__) literal(*candor.Ctx, struct{}) string {',
    '\treturn ""',
    '}',
  ],
  jsonOpt: [
    '// Json for T?: null for none, and none for null.',
    'type jsonOpt__[T any, D candor.Json[T]] struct{}',
    '',
    'func (jsonOpt__[T, D]) Enc(o *candor.JsonOut, v opt__[T]) {',
    '\tif !v.some {',
    '\t\to.Raw("null")',
    '\t\treturn',
    '\t}',
    '\t(*new(D)).Enc(o, v.value)',
    '}',
    '',
    'func (jsonOpt__[T, D]) Dec(in *candor.JsonIn, j any, path string) (opt__[T], *candor.JsonErr) {',
    '\tif j == nil {',
    '\t\treturn opt__[T]{}, nil',
    '\t}',
    '\tv, err := (*new(D)).Dec(in, j, path)',
    '\tif err != nil {',
    '\t\treturn opt__[T]{}, err',
    '\t}',
    '\treturn opt__[T]{some: true, value: v}, nil',
    '}',
  ],
  eqGo: [
    "// Eq where Go's `==` compares as Candor does.",
    'type eqGo__[T comparable] struct{}',
    '',
    'func (eqGo__[T]) eq(a, b T) bool {',
    '\treturn a == b',
    '}',
  ],
  ordGo: [
    "// Ord for int and string: Go's order.",
    'type ordGo__[T cmp.Ordered] struct{}',
    '',
    'func (ordGo__[T]) compare(_ *candor.Ctx, a, b T) int64 {',
    '\treturn int64(cmp.Compare(a, b))',
    '}',
  ],
  sorted: [
    '// A sorted copy; items that compare equal keep their order.',
    'func sorted__[T any](c *candor.Ctx, xs []T, compare func(*candor.Ctx, T, T) int64) []T {',
    '\tout := slices.Clone(xs)',
    '\tslices.SortStableFunc(out, func(a, b T) int { return cmp.Compare(compare(c, a, b), 0) })',
    '\treturn out',
    '}',
  ],
  extreme: [
    '// xs.min() (want -1) or xs.max() (want 1): the first of the smallest or largest items.',
    'func extreme__[T any](c *candor.Ctx, xs []T, compare func(*candor.Ctx, T, T) int64, want int64) opt__[T] {',
    '\tif len(xs) == 0 {',
    '\t\treturn opt__[T]{}',
    '\t}',
    '\tbest := xs[0]',
    '\tfor _, x := range xs[1:] {',
    '\t\tif cmp.Compare(compare(c, x, best), 0) == int(want) {',
    '\t\t\tbest = x',
    '\t\t}',
    '\t}',
    '\treturn opt__[T]{some: true, value: best}',
    '}',
  ],
  sortedBy: [
    '// A copy sorted by each item\'s key, worked out once per item; equal keys keep their order.',
    'func sortedBy__[T, K any](c *candor.Ctx, xs []T, key func(*candor.Ctx, T) K, compare func(*candor.Ctx, K, K) int64) []T {',
    '\ttype keyed struct {',
    '\t\tk K',
    '\t\tv T',
    '\t}',
    '\tks := make([]keyed, len(xs))',
    '\tfor i, x := range xs {',
    '\t\tks[i] = keyed{key(c, x), x}',
    '\t}',
    '\tslices.SortStableFunc(ks, func(a, b keyed) int { return cmp.Compare(compare(c, a.k, b.k), 0) })',
    '\tout := make([]T, len(xs))',
    '\tfor i, k := range ks {',
    '\t\tout[i] = k.v',
    '\t}',
    '\treturn out',
    '}',
  ],
  sqlArg: [
    '// A `T?` parameter of a query: its value, or nil for NULL.',
    'func sqlArg__[T any](o opt__[T]) any {',
    '\tif !o.some {',
    '\t\treturn nil',
    '\t}',
    '\treturn o.value',
    '}',
  ],
  optOf: [
    '// A value, and whether there was one: from tasks.timeout, a map lookup, or s.toInt(). Whatever',
    '// Go handed back with ok == false is dropped, so every none is the same value and `==` holds.',
    'func optOf__[T any](v T, ok bool) opt__[T] {',
    '\tif !ok {',
    '\t\treturn opt__[T]{}',
    '\t}',
    '\treturn opt__[T]{some: true, value: v}',
    '}',
  ],
  flat: [
    '// A built-in\'s T? of an item that is a U? itself: one U?.',
    'func flat__[T any](o opt__[opt__[T]]) opt__[T] {',
    '\treturn o.value',
    '}',
  ],
  allRes: [
    '// tasks.all over functions that can fail: every value, or the first error.',
    'func allRes__[T, E any](rs []res__[T, E], failed int) res__[[]T, E] {',
    '\tif failed >= 0 {',
    '\t\treturn res__[[]T, E]{err: rs[failed].err}',
    '\t}',
    '\tout := make([]T, len(rs))',
    '\tfor i, r := range rs {',
    '\t\tout[i] = r.value',
    '\t}',
    '\treturn res__[[]T, E]{ok: true, value: out}',
    '}',
  ],
};

/** Placeholder for a `//line` directive that returns positions to the Go file itself. */
const LINE_RESET = '//line ?';

function isLineDirective(l: string): boolean {
  return l.trimStart().startsWith('//line ');
}

/**
 * Joins a Go file's lines, with its `//line` directives in force: Go reads one only at the
 * start of a line, so the indentation of nested statements is taken off, and a reset names the
 * Go file and the line after it.
 */
function withLineDirectives(lines: string[], goFile: string): string {
  return lines.map((l, i) => (l === LINE_RESET ? `//line ${goFile}:${i + 2}` : isLineDirective(l) ? l.trimStart() : l)).join('\n');
}

/** The hidden first parameter of every function: the task it runs in (see runtime/go/ctx.go). */
/** Standard effects the runtime implements in Go: what `main` gets, and what a test gets. */
const runtimeEffects: Record<string, { real: string; fake: string }> = {
  sql: { real: 'candor.RealSQL()', fake: 'candor.MemorySQL()' },
  fs: { real: 'candor.RealFS()', fake: 'candor.MemoryFS()' },
};

const CTX = 'ctx__';
/** At the top of every loop body: a cancelled task stops here. */
const CHECK = `${CTX}.Check()`;
/** The value of `void`. */
const VOID = 'struct{}{}';

const TRAPS: Record<string, string> = { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' };

/** Whether `op` on `t` traps on overflow: int's `+ - * /`. `%` can't overflow. */
function trapping(t: Type, op: string): boolean {
  return t.kind === 'int' && op in TRAPS;
}

/** `l op r` on values of `t`. Fully parenthesized: Go's precedence differs (it puts `==` and `<` on one level). */
function arith(t: Type, op: string, l: string, r: string): string {
  // A float result that is NaN or infinite panics, so every operation is checked (and never a
  // Go constant expression, which Go would compute exactly rather than as floats do).
  if (t.kind === 'float' && op in TRAPS) return `candor.F${TRAPS[op]}(${l}, ${r})`;
  if (t.kind === 'float' && op === '%') return `candor.FMod(${l}, ${r})`;
  return trapping(t, op) ? `candor.${TRAPS[op]}(${l}, ${r})` : `(${l} ${op} ${r})`;
}

/** Whether Go's `==` compares values of `t` exactly as Candor does: no lists, no pointers. */
function goComparable(t: Type): boolean {
  switch (t.kind) {
    case 'string':
    case 'int':
    case 'bool':
    case 'char':
    case 'float':
    case 'unit':
      return true;
    case 'struct':
      return t.fields.every((f) => !f.boxed && goComparable(f.type));
    case 'enum':
      return t.variants.every((v) => v.fields.every((f) => !f.boxed && goComparable(f.type)));
    case 'option':
      return goComparable(t.inner);
    case 'result':
      return goComparable(t.ok) && goComparable(t.err);
    case 'tuple':
      return t.elems.every(goComparable);
    default:
      return false;
  }
}

/** Whether evaluating `e` could observe or cause a side effect. `if` and `match` become temporaries, so they can't. */
function callsSomething(e: ast.Expr): boolean {
  switch (e.kind) {
    case 'Call':
      return true;
    case 'Unary':
      return callsSomething(e.operand);
    case 'Binary':
      return callsSomething(e.left) || callsSomething(e.right);
    case 'Range':
      return callsSomething(e.start) || callsSomething(e.end);
    case 'Member':
      return callsSomething(e.object);
    case 'StructLit':
      return (e.spread !== null && callsSomething(e.spread)) || e.fields.some((f) => callsSomething(f.value));
    case 'ListLit':
      return e.items.some(callsSomething);
    case 'MapLit':
      return e.entries.some((x) => callsSomething(x.key) || callsSomething(x.value));
    case 'TupleLit':
      return e.items.some(callsSomething);
    case 'Interp':
      return e.parts.some((p) => typeof p !== 'string' && callsSomething(p));
    case 'Index':
      return callsSomething(e.object) || callsSomething(e.index);
    default:
      return false;
  }
}

/**
 * The source text of `span` on one line (each line break and the indentation after it become one
 * space), and a function from a position inside it to a column. Columns count code points, as
 * the Go runtime does.
 */
function flatten(source: string, span: { start: Pos; end: Pos }): { text: string; column: (p: Pos) => number } {
  const lines = source.split('\n');
  let text = '';
  // Per source line: where its text starts in `text`, and the 0-based column it was cut from.
  const starts = new Map<number, { at: number; from: number }>();
  for (let l = span.start.line; l <= span.end.line; l++) {
    const line = lines[l - 1].replace(/\r$/, '');
    const from = l === span.start.line ? span.start.col - 1 : line.length - line.trimStart().length;
    const to = l === span.end.line ? span.end.col - 1 : line.trimEnd().length;
    if (l > span.start.line) text += ' ';
    starts.set(l, { at: text.length, from });
    text += line.slice(from, to);
  }
  const column = (p: Pos) => {
    const s = starts.get(p.line)!;
    return [...text.slice(0, s.at + p.col - 1 - s.from)].length;
  };
  return { text, column };
}

/** Whether a value is a list nobody else holds yet, so a `let mut` taking it owns its items. */
function fresh(e: ast.Expr): boolean {
  return e.kind === 'ListLit';
}

/** `T` → `T__`: never a Candor name, which can't contain `__`, so a local can't hide it. */
function typeParamName(p: ParamType): string {
  return `${p.name}__`;
}

/** `T__Ord`: the dictionary type parameter giving `p` the trait. */
function dictParam(p: ParamType, trait: Trait): string {
  return `${typeParamName(p)}${traitGo(trait)}`;
}

/** A trait's Go name: `Ord`, `m__Show`. */
function traitGo(trait: Trait): string {
  return trait.module === null ? trait.name : `${trait.module}__${trait.name}`;
}

/** The dictionary type of an impl: `m__Show__for__m__Point`, `Ord__for__int`. */
function implName(trait: Trait, t: Type): string {
  const type = t.kind === 'struct' || t.kind === 'enum' ? `${t.module}__${t.name}` : t.kind;
  return `${traitGo(trait)}__for__${type}`;
}

/** `[T__ any, U__ any]`, after the name of a generic type. */
function typeParamList(ps: ParamType[]): string {
  return ps.length > 0 ? `[${ps.map((p) => `${typeParamName(p)} any`).join(', ')}]` : '';
}

function variantField(variant: string, field: string): string {
  return `${variant}__${field}`;
}

// Go keywords and predeclared identifiers, plus every package name we import.
const goReserved = new Set(
  `break default func interface select case defer go map struct chan else goto package switch const
   fallthrough if range type continue for import return var bool byte complex64 complex128 error
   float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr
   true false iota nil any comparable append cap clear close complex copy delete imag len make max
   min new panic print println real recover candor errors slices strconv strings`.split(/\s+/),
);

function goIdent(name: string): string {
  return goReserved.has(name) ? `${name}__` : name;
}

function indent(lines: string[]): string[] {
  return lines.map((l) => `\t${l}`);
}

/** `println` → `Println`: effect methods are exported Go interface methods. */
function exported(name: string): string {
  return name[0].toUpperCase() + name.slice(1);
}

/** The Go type of an effect's capability, as a hidden parameter. */
function capType(name: string): string {
  return builtinEffects.get(name)?.go.type ?? effectType(name);
}

/** The Go type of an effect's fake, as a test builds it: what a `test fn` takes. */
function fakeType(name: string): string {
  const builtin = builtinEffects.get(name);
  if (builtin) return builtin.fake.construct.replace(/^&(.*)\{\}$/, '*$1');
  if (name === 'sql') return '*candor.SQL';
  if (name === 'fs') return '*candor.FS';
  return `*${effectType(name)}__fake`;
}

/** A trait method's default body: `m__Describe__describe__default`. */
function defaultName(trait: Trait, method: string): string {
  return `${traitGo(trait)}__${method}__default`;
}

/** The effects a fake's functions use, each once. */
function fakeUses(fx: UserEffect): string[] {
  return [...new Set([...fx.fakeOps.values(), ...fx.steering.values()].flatMap((sig) => sig.uses))];
}

/** A user effect's Go interface; `__real`, `__fake` and `__newFake` are added to it. */
function effectType(name: string): string {
  return `fx__${name}`;
}

/** JSON string syntax is a subset of Go's interpreted string literal syntax. */
// Go refuses a byte order mark anywhere but at the start of a file, so U+FEFF is escaped.
const BOM = String.fromCharCode(0xfeff);

/** A field's comment as its flag's help: lines joined, a blank line between paragraphs kept. */
function flagHelp(doc: string | undefined): string {
  return (doc ?? '').split(/\n\s*\n/).map((p) => p.split('\n').join(' ').trim()).join('\n');
}

function goQuote(s: string): string {
  return JSON.stringify(s).split(BOM).join('\\ufeff');
}

/** Where an embedded file's copy sits in the build, `embed/1` for `embed__1`. */
const embedPath = (name: string) => name.replace('embed__', 'embed/');

/** A Go rune literal for one code point: printable ASCII as itself, anything else by number. */
function goRune(c: string): string {
  const cp = c.codePointAt(0)!;
  if (cp >= 0x20 && cp < 0x7f && c !== "'" && c !== '\\') return `'${c}'`;
  return `rune(${cp})`;
}
