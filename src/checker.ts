import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkDdl, checkFunctionCalls, checkSql, isDdl, readSchema, sqliteHasFunction, type RowShape, type SqlFns, type SqlParam, type SqlType } from './sqlcheck';
import type * as ast from './ast';
import { Codes, type Code, type Diagnostic, type Span } from './diagnostics';
import { builtinEffects, fakeType } from './effects';
import { formatWitness, useful, wild, type Pat } from './exhaustive';
import { mapMisnamed, primitiveMethods, primitiveMisnamed, sliceToEnd, type MethodDef } from './methods';
import { methodNames } from './reference';
import {
  Eq,
  Json,
  Ord,
  Row,
  Show,
  T,
  isSqlQuery,
  flagField,
  flagName,
  jsonName,
  jsonRules,
  assignable,
  builtinTraits,
  effect,
  children,
  comparable,
  declareUserType,
  fn,
  handleNames,
  instantiate,
  isSum,
  hasError,
  ordered,
  shown,
  param,
  paramsIn,
  resolveTypeName,
  builtinTypes,
  exitType,
  signalType,
  sameShape,
  sameType,
  subst,
  traitName,
  typeKey,
  typeNames,
  typeToString,
  unify,
  type EffectType,
  type EnumType,
  type Field,
  type FnType,
  type HandleType,
  type OptionType,
  type ParamType,
  type ResultType,
  type OpaqueType,
  type TupleType,
  type ScopeType,
  type StructType,
  type TaskType,
  type Trait,
  type Type,
  type UserType,
  type Variant,
} from './types';

export interface FnSig {
  name: string;
  params: { name: string; type: Type }[];
  ret: Type;
  /** Effects declared with `uses`, in declaration order. */
  uses: string[];
  /** `uses f`: parameters that are functions, whose effects a call takes on. */
  effectParams: string[];
  /** `fn first<T>`: each call says what they stand for. */
  typeParams: ParamType[];
  type: FnType;
  decl: ast.FnDecl | ast.ExternFn;
  /** An `extern` or helper inside an effect: only that effect's operations (and helpers) may call it. */
  privateTo?: string;
}

/**
 * A module's own effect, `effect http { ... }`, and its fake. Named after the module, so its
 * name is unique in a program.
 */
export interface UserEffect {
  name: string;
  /** The operations, as callers see them. */
  type: EffectType;
  ops: Map<string, FnSig>;
  /** `fn` without `pub`: functions only the operations call. They don't see the state. */
  helpers: Map<string, FnSig>;
  /** The fake's versions of the operations. */
  fakeOps: Map<string, FnSig>;
  /** Methods only the fake has, for tests to steer and inspect it. */
  steering: Map<string, FnSig>;
  /** The fake's state, in order: fresh for every test. */
  state: StateVar[];
  /** The effect's own state, set up when `main` starts. */
  ownState: StateVar[];
  /** Operations that change the effect's state: they run one at a time. */
  writers: Set<string>;
  decl: ast.EffectDecl;
  fake: ast.FakeDecl | null;
}

export interface StateVar {
  name: string;
  type: Type;
  mutable: boolean;
  decl: ast.LetStmt;
}

/**
 * `let ErrRange: GoError as errRange` in an `extern` block, a Go variable, or `const limit = 20`,
 * read as a value. A const's `value` is what it folds to: an int is a bigint, a float a number, a
 * char a one-character string.
 */
export interface ExternValue {
  name: string;
  type: Type;
  decl: ast.ExternLet | ast.ConstDecl;
  value?: ConstValue;
}

export type ConstValue = bigint | number | string | boolean;

/** A default to write after `??` in a help line. */
function defaultOf(t: Type): string {
  const known: Partial<Record<Type['kind'], string>> = { int: '0', float: '0.0', string: '""', bool: 'false', char: "' '", list: '[]', map: '[:]' };
  return known[t.kind] ?? '...';
}

/** A const of this type is folded to a Go `const`; any other is a Go variable (#8a5f2239). */
function scalarConst(t: Type): boolean {
  return ['int', 'float', 'string', 'bool', 'char'].includes(t.kind);
}

/** What an identifier in expression position resolved to. `value`: an extern `let` or a const. */
export type RefKind = 'local' | 'effect' | 'fn' | 'value';

/** `strconv.atoi`: a declaration of an imported module. */
export interface ModuleRef {
  module: string;
  name: string;
  kind: 'fn' | 'value';
}

/** A `tasks.scope` call: what its function returns, once known. */
export interface ScopeFrame {
  ret: Type | null;
  /** The lambda given to it, while it is being checked. */
  body: LambdaFrame | null;
  /** Tasks spawned on it that can fail, with their error types. */
  fallible: { err: Type; span: Span }[];
}

/** Calls on `tasks`, a `Scope` or a `Task`, with what the emitter needs to know. */
export type TaskCall =
  | { kind: 'scope'; ret: Type }
  /** `scope` is null for a `Scope` that came in as a parameter. */
  | { kind: 'spawn'; ret: Type; scope: ScopeFrame | null; background: boolean }
  | { kind: 'join' }
  /** `s.wait()`. */
  | { kind: 'wait' }
  /** `ret`: what the function given returns, per item or per racer. */
  | { kind: 'all'; ret: Type }
  | { kind: 'race'; ret: Type }
  | { kind: 'timeout'; ret: Type }
  /** `tasks.both(a, b)`: what each returns, and what `both` gives. */
  | { kind: 'both'; a: Type; b: Type; ret: Type }
  /** `s.mutex(v)`, `s.atomic(v)`, `s.channel(n)`. */
  | { kind: 'make'; type: HandleType }
  /** A method of a Mutex, Atomic or Channel. */
  | { kind: 'shared'; type: HandleType; method: string }
  /** An arm for `tasks.select`: `ret` is what its function gives; `elem` is what `onRecv` receives. */
  | { kind: 'arm'; method: ArmMethod; ret: Type; elem: Type | null }
  | { kind: 'select'; ret: Type };

export type ArmMethod = 'onRecv' | 'onSend' | 'after' | 'otherwise';

/**
 * `impl Show for Point`: one per trait and type in a program, in the module of the trait or of
 * the type, so there is one place to look for it. `impl<T: Show> Show for Box<T>` covers every
 * `Box` whose argument has the bounds.
 */
export interface Impl {
  trait: Trait;
  /** `Box<T>`, its arguments the impl's own type parameters, in order. */
  type: Type;
  /** `T` in `impl<T: Show>`: one per type argument of the target; none for most. */
  params: ParamType[];
  module: string;
  /** The methods, `self` first. */
  methods: Map<string, FnSig>;
  decl: ast.ImplDecl;
  /** `string` in `impl Json for Money via string`: `toJson` and `fromJson` convert to and from it. */
  via: Type | null;
}

/** Tells impls apart: one per trait and type, and a generic type's impl is for all its instances. */
export function implKey(trait: Trait, t: Type): string {
  return `${trait.module ?? ''}.${trait.name} for ${implTypeKey(t)}`;
}

/** `Box`, not `Box<int>`: what an impl is for. */
function implTypeKey(t: Type): string {
  return typeKey(t.kind === 'struct' || t.kind === 'enum' ? t.origin : t);
}

/** The functions and extern values other modules can use: those with `pub`. */
function publicNames(mod: CheckResult): string[] {
  return [...[...mod.fns.values()].filter((s) => s.decl.pub), ...[...mod.values.values()].filter((v) => v.decl.pub)].map((d) => d.name);
}

/** What a struct literal, constructor pattern or `Status.Pending` names. */
export type CtorTarget = { kind: 'struct'; type: StructType } | { kind: 'variant'; type: EnumType; variant: Variant };

/** Card 144: a file `embed` builds into the program. */
export interface Embed {
  /** Absolute, with forward slashes. */
  file: string;
  bytes: boolean;
}

/** Whether `data` is valid UTF-8. */
function utf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** #b29bfb64: a function given to `sql.function`: its SQL name, its parameters' names, its type. */
export interface SqlFunctionUse {
  name: string;
  /** `module.fn`, the Candor function. */
  fn: string;
  params: string[];
  type: FnType;
  /** `file:line` of the `sql.function` call. */
  where: string;
}

export interface CheckResult {
  /** The DDL in this module's `sql.exec` calls, for modules importing it to build the schema from. */
  sqlDdl: { text: string; where: string }[];
  /** #b29bfb64: the SQL functions this module and its imports register, for the schema check. */
  sqlFunctionDecls: SqlFunctionUse[];
  /** The module's name, which prefixes its names in Go. */
  module: string;
  fns: Map<string, FnSig>;
  /** Extern `let`s and consts. */
  values: Map<string, ExternValue>;
  /** #8a5f2239: the consts that aren't scalars (Go variables), each after the consts it names. */
  varConsts: ast.ConstDecl[];
  /** Members naming a declaration of an imported module. */
  moduleRefs: Map<ast.Member, ModuleRef>;
  /** This module's own effect. */
  effect: UserEffect | null;
  /** `type *DB as Db` in the effect's bindings, by Candor name. */
  opaques: Map<string, OpaqueType>;
  /** Every user effect this module can name: its own, and those of its imports, transitively. */
  effects: Map<string, UserEffect>;
  /** Structs and enums, in declaration order. */
  userTypes: UserType[];
  /** The traits this module declares. */
  traits: Map<string, Trait>;
  /** The default bodies of this module's traits' methods, `self` a `Self` with the trait. */
  traitBodies: Map<Trait, Map<string, FnSig>>;
  /** Every impl this module can use: its own, and those of its imports, transitively. By `implKey`. */
  impls: Map<string, Impl>;
  /** This module's own impls, in declaration order. */
  ownImpls: Impl[];
  /** `x.show()`: calls of trait methods, with the trait and the type of `x`. */
  traitCalls: Map<ast.Call, { trait: Trait; self: Type }>;
  /** The type of every expression. */
  types: Map<ast.Expr, Type>;
  refs: Map<ast.Ident, RefKind>;
  /** Members that resolved to a method on a built-in type, like `n.toString`. */
  methods: Map<ast.Member, MethodDef>;
  /** Members that name a variant without fields, like `Status.Pending`. */
  variantRefs: Map<ast.Member, CtorTarget>;
  structLits: Map<ast.StructLit, CtorTarget>;
  patterns: Map<ast.CtorPattern, CtorTarget>;
  /** `Ok(x)` and `Err(e)` calls. Their type is in `types`. */
  resultCtors: Map<ast.Call, 'Ok' | 'Err'>;
  /** Card 144: `embed("path")` calls: the file, absolute, and whether it is read as Bytes. */
  embeds: Map<ast.Call, Embed>;
  /** #cb18c33b: `env.signals(s, [...])` and a test's `env.sendSignal(.X)`. */
  signalCalls: Map<ast.Call, 'listen' | 'send'>;
  /** #0c2dc168: `flags.parse(args, defaults)` calls, with the struct they read flags into. */
  flagCalls: Map<ast.Call, StructType>;
  /** #b29bfb64: the `f` in `sql.function(name, f)`, which the emitter wraps for SQLite. */
  sqlFunctions: Map<ast.Expr, SqlFunctionUse>;
  /**
   * Expressions whose value is wrapped on the way to where it is used: a `T` or `none` going
   * where a `T?` is expected. Maps to the `T?`.
   */
  coercions: Map<ast.Expr, Type>;
  /**
   * Reads of a `T?` that a test proved present (`if x != none { x }`): their type is the `T`,
   * and the emitter reads the value out.
   */
  narrowed: Set<ast.Expr>;
  /**
   * Card 148: built-ins that give a `T?` of an item that is itself optional (`m[k]` on a
   * `Map<K, int?>`, `xs.first()`, `r.ok()`): the type is `int?`, not `int??`, and the emitter
   * flattens the Go value.
   */
  flattened: Set<ast.Expr>;
  /** Names bound but never read. Go refuses unused locals, so the emitter adds `_ = x`. */
  unused: Set<ast.LetStmt | ast.BindingPattern | ast.ForStmt>;
  /** Names on a `T?` in `match` patterns that take the present value: the arms above took `none`. */
  presentBindings: Set<ast.BindingPattern>;
  /** Method calls on lists, like `xs.map(f)`, by method name. */
  listCalls: Map<ast.Call, string>;
  /** Method calls on maps, like `m.remove(k)`, by method name. */
  mapCalls: Map<ast.Call, string>;
  /**
   * `r.map(f)`, `r.mapErr(f)` and `x.map(f)` on a `T?`: which side `f` takes, and the type given.
   * `flat`: on a `T?`, `f` gives a `U?` itself.
   */
  wrapMaps: Map<ast.Call, { side: 'ok' | 'err' | 'some'; type: Type; flat: boolean }>;
  /** `r.isOk()`, `r.isErr()` and `r.ok()` on a Result. */
  resultChecks: Map<ast.Call, 'isOk' | 'isErr' | 'ok'>;
  /**
   * Reads of a `let mut` map variable. Read as a whole value (passed, stored, returned, looped
   * over), one ends the variable's sole ownership of its data (see runtime/go/maps.go); a
   * lookup or a method call on it doesn't.
   */
  mutMapReads: Set<ast.Ident>;
  /** Reads of a `let mut` list variable, told apart the same way (see `indexed`). */
  mutListReads: Set<ast.Ident>;
  /** `http.requests` in a test: a read of the fake's state. */
  fakeState: Map<ast.Member, StateVar>;
  /**
   * `let mut` lists written by index somewhere. Each gets a flag saying whether the variable
   * owns its items: a write copies the list first unless it does, and a read of the variable as
   * a whole value clears it, so no copy ever sees the write (see `set__` in emit-go.ts).
   */
  indexed: Set<ast.LetStmt>;
  /** String literals that are a `sql.Query`: each `${...}` is a parameter. */
  queries: Set<ast.StringLit | ast.Interp>;
  taskCalls: Map<ast.Call, TaskCall>;
  /** `random.shuffle(xs)` and `random.pick(xs)`, which the effect's Go interface can't hold. */
  randomCalls: Map<ast.Call, 'shuffle' | 'pick'>;
  /** Calls of generic functions, with what each type parameter stands for there. */
  callTypeArgs: Map<ast.Call, Type[]>;
  /** Test blocks with distinct names, in source order. */
  tests: ast.TestDecl[];
  diagnostics: Diagnostic[];
}

export interface CheckOptions {
  /** `candor test` runs files without a `main`, and imported modules have none. */
  requireMain?: boolean;
  /** Modules this one imports, already checked, by the name this file calls them (`import ... as`). */
  imports?: Map<string, CheckResult>;
  /** Checked because another module imports it: its `pub` signatures are checked even with a `main`. */
  imported?: boolean;
  /** #79ce004a: the module's last line; what comes after is its test file's. */
  testsFrom?: number;
}

export function check(mod: ast.Module, file: string, options: CheckOptions = {}): CheckResult {
  return new Checker(mod, file, options.requireMain ?? true, options.imports ?? new Map(), options.imported ?? false, options.testsFrom ?? Infinity).run();
}

interface Binding {
  kind: RefKind;
  type: Type;
  used: boolean;
  /** Where a local was introduced, for unused warnings. Parameters have none. */
  decl?: ast.LetStmt | ast.BindingPattern | ast.ForStmt;
  /** The same name in an arm's other patterns: `.A { x } | .B { x }`. Unused with it. */
  twins?: ast.BindingPattern[];
  /** `let mut`, and whether anything changes it. */
  mutable?: boolean;
  mutated?: boolean;
}

/** The lambda being checked. Lambdas nest; `parent` is the enclosing one. */
export interface LambdaFrame {
  /** Its result: from the context, else from the first `return` or the expression body. */
  ret: Type | null;
  /**
   * While `ret` is unknown: the error type a `?` or a failing task has shown, so `return Ok(x)`
   * can complete it to `Result<typeof x, E>`.
   */
  errHint: Type | null;
  /** While `ret` is unknown: what a `return Ok(x)` said, so a later `return Err(e)` can complete it. */
  okHint: Type | null;
  /**
   * The `return`s seen while `ret` was unknown, checked once their shapes, merged at the end of
   * the body, say it. `shape`: what the value says of the type, with `hole` where it says nothing
   * (`Ok(x)` is `Result<X, hole>`); `leaves`: the parts checked already, with their types.
   */
  pending: { value: ast.Expr | null; span: Span; shape: Type; leaves: Map<ast.Expr, Type> }[];
  /** What the place its result goes to says, used for what its returns leave open. */
  retHint: Type | null;
  /** What decided `ret`, when it was inferred: "the `return` on line 12". */
  retFrom: string | null;
  /** `?`s seen while `ret` was unknown, checked against it at the end. */
  tries: { span: Span; operand: ResultType | OptionType }[];
  /** Effects its body performs, directly (not those of lambdas inside it). */
  used: Set<string>;
  /** `scopes.length` when it started: bindings below that index are captured. */
  scopeDepth: number;
  parent: LambdaFrame | null;
}

/**
 * How a block's last expression is treated.
 * - `value`: it is the block's value (the branches of an `if` used as an expression).
 * - `statement`: it is discarded, like any other statement.
 * - `tail`: the end of a function that returns a value. It still needs `return`, but a trailing
 *   expression is checked as a value, so the error can say "add `return`" rather than "unused value".
 */
type BlockMode = 'value' | 'statement' | 'tail';

interface BlockResult {
  type: Type;
  /** Every path through the block ends in `return`. */
  diverges: boolean;
}

class Checker {
  private readonly fns = new Map<string, FnSig>();
  private readonly values = new Map<string, ExternValue>();
  private readonly moduleRefs = new Map<ast.Member, ModuleRef>();
  private readonly types = new Map<ast.Expr, Type>();
  private readonly refs = new Map<ast.Ident, RefKind>();
  private readonly methods = new Map<ast.Member, MethodDef>();
  private readonly userTypes = new Map<string, UserType>();
  private readonly declTypes = new Map<ast.StructDecl | ast.EnumDecl, UserType>();
  private readonly variantRefs = new Map<ast.Member, CtorTarget>();
  private readonly structLits = new Map<ast.StructLit, CtorTarget>();
  private readonly patterns = new Map<ast.CtorPattern, CtorTarget>();
  private readonly resultCtors = new Map<ast.Call, 'Ok' | 'Err'>();
  private readonly coercions = new Map<ast.Expr, Type>();
  /** Narrowed reads, each with its `T?` type before narrowing. */
  private readonly narrowed = new Map<ast.Expr, Type>();
  private readonly flattened = new Set<ast.Expr>();
  /**
   * Paths (`x`, `u.manager`) of `T?` values known to be present here. Replaced, never changed
   * in place, so a saved set stays as it was.
   */
  private facts: Facts = new Set();
  /** Int expressions whose value is known at compile time. */
  private readonly consts = new Map<ast.Expr, bigint>();
  private readonly constState = new Map<ast.ConstDecl, 'checking' | 'done'>();
  private readonly varConsts: ast.ConstDecl[] = [];
  private readonly unused = new Set<ast.LetStmt | ast.BindingPattern | ast.ForStmt>();
  private readonly presentBindings = new Set<ast.BindingPattern>();
  /** Names bound by `match` patterns, for help that talks about arms. */
  private readonly armNames = new Set<ast.BindingPattern>();
  /** While a `match` arm's pattern is checked: its names on a `T?`, for `settleName`. */
  private unsettled: { p: ast.BindingPattern; t: Type & { kind: 'option' } }[] | null = null;
  private readonly listCalls = new Map<ast.Call, string>();
  private readonly mapCalls = new Map<ast.Call, string>();
  private readonly wrapMaps = new Map<ast.Call, { side: 'ok' | 'err' | 'some'; type: Type; flat: boolean }>();
  private readonly resultChecks = new Map<ast.Call, 'isOk' | 'isErr' | 'ok'>();
  /** Arguments given for a user function's parameters: which function and parameter. */
  private readonly argFor = new Map<ast.Expr, { fn: string; name: string }>();
  /** While a `match` arm's pattern is checked: the subject's name, which the pattern may bind again. */
  private rebindable: string | null = null;
  /** Whether the arm's pattern did. */
  private rebound = false;
  private readonly mutMapReads = new Set<ast.Ident>();
  private readonly mutListReads = new Set<ast.Ident>();
  private readonly fakeState = new Map<ast.Member, StateVar>();
  private readonly indexed = new Set<ast.LetStmt>();
  private readonly queries = new Set<ast.StringLit | ast.Interp>();
  /** Calls of `sql.exec`, `insert`, `query` and `queryOne`, checked against the schema at the end. */
  private readonly sqlCalls: { call: ast.Call; name: string; ret: Type }[] = [];
  private readonly taskCalls = new Map<ast.Call, TaskCall>();
  private readonly randomCalls = new Map<ast.Call, 'shuffle' | 'pick'>();
  private readonly embeds = new Map<ast.Call, Embed>();
  private readonly signalCalls = new Map<ast.Call, 'listen' | 'send'>();
  private readonly flagCalls = new Map<ast.Call, StructType>();
  private readonly sqlFunctions = new Map<ast.Expr, SqlFunctionUse>();
  private readonly ownSqlFunctions: SqlFunctionUse[] = [];
  /**
   * Card 148: `[]` and `[:]` that are a branch's value, with nothing else to say what they hold:
   * the other branches decide, in `join`. `waiting` holds those whose type is still open.
   */
  private readonly emptyBranches = new Set<ast.Expr>();
  private readonly waiting = new Set<ast.Expr>();
  private readonly callTypeArgs = new Map<ast.Call, Type[]>();
  private readonly traits = new Map<string, Trait>();
  private readonly traitDecls = new Map<ast.TraitDecl, Trait>();
  private readonly traitBodies = new Map<Trait, Map<string, FnSig>>();
  private readonly impls = new Map<string, Impl>();
  private readonly ownImpls: Impl[] = [];
  private readonly traitCalls = new Map<ast.Call, { trait: Trait; self: Type }>();
  /** What `Self` means here: the trait's own parameter in a trait, the type in an impl. */
  private selfType: Type | null = null;
  /** The type parameters of the declaration being checked, by name. */
  private typeParams = new Map<string, ParamType>();
  /** The generic type whose fields are being resolved: inside, it is only itself. */
  private defining: UserType | null = null;
  /**
   * Where a generic function of this module passes its type parameters to one, here or in
   * itself: `grows` when inside another type, as in `f<List<T>>`. Go must be able to build a
   * finite set of versions of each function.
   */
  private readonly flows: { from: ParamType; to: ParamType; grows: boolean; span: Span; callee: string; arg: Type }[] = [];
  /** `uses f` parameters the current function has called. */
  private effectParamsUsed = new Set<string>();
  /**
   * The type a call, struct literal or variant is checked against, for its help when nothing
   * in it says what a type parameter is. It never decides the type: that comes from arguments.
   */
  private hint: Type | null = null;
  private readonly scopeFrames = new Map<number, ScopeFrame>();
  private lambda: LambdaFrame | null = null;
  /** Loops around the current statement, within the current function or lambda. */
  private loops = 0;
  /** The body of the current function, test or block lambda: where a `defer` may stand. */
  private body: ast.Block | null = null;
  /** Inside a `defer`: the index of the scope holding the function's locals, which it can't assign. */
  private deferFrame: { bodyScope: number } | null = null;
  private readonly diagnostics: Diagnostic[] = [];
  /** `if`s and `match`es where every branch returns. */
  private readonly divergent = new Set<ast.If | ast.Match>();
  /** Innermost last. The first holds the function's effects and parameters; each block adds one. */
  private scopes: Map<string, Binding>[] = [];
  private fn!: FnSig;
  /** While checking a `requires` or `ensures`: no effects, no early return. */
  private contract: ast.Contract | null = null;
  /** Inside a `test` block: `assert` and the fakes' extra methods are allowed. */
  private inTest = false;
  /**
   * #79ce004a: checking test code (a test, a test fn, anything in the test file). Program code
   * never sees the test-only names, so its locals may reuse them.
   */
  private testSide = false;
  private readonly testOnly = new Set<string>();
  private readonly tests: ast.TestDecl[] = [];
  /** This module's effect, and every user effect it can name. */
  private effect: UserEffect | null = null;
  private readonly userEffects = new Map<string, UserEffect>();
  /** While checking an effect's operations: its name, so its `extern`s can be called. */
  private inOps: string | null = null;
  /** The Go types this module's effect binds. */
  private readonly opaques = new Map<string, OpaqueType>();
  /** While checking the effect's bindings, state and operation bodies: its Go types can be named. */
  private inEffectCode = false;
  /** Checking a helper of this effect, which doesn't see its state. */
  private helperOf: UserEffect | null = null;
  private stateSeen = new Set<string>();
  /** The imports by their own module name, for types and refs, which carry it. */
  private readonly byModule = new Map<string, CheckResult>();

  constructor(
    private readonly mod: ast.Module,
    private readonly file: string,
    private readonly requireMain: boolean,
    private readonly imports: Map<string, CheckResult>,
    private readonly imported: boolean,
    private readonly testsFrom: number,
  ) {
    for (const dep of imports.values()) {
      this.byModule.set(dep.module, dep);
      for (const [name, fx] of dep.effects) this.userEffects.set(name, fx);
      for (const [key, impl] of dep.impls) this.impls.set(key, impl);
    }
  }

  run(): CheckResult {
    // Names first, then definitions, so declarations can refer to each other in any order.
    const typeDecls = this.mod.decls.filter((d) => d.kind === 'StructDecl' || d.kind === 'EnumDecl');
    const fnDecls = this.mod.decls.filter((d) => d.kind === 'FnDecl');
    const testDecls = this.mod.decls.filter((d) => d.kind === 'TestDecl');
    const externs = this.mod.decls.filter((d) => d.kind === 'ExternDecl');
    const effects = this.mod.decls.filter((d) => d.kind === 'EffectDecl');
    const fakes = this.mod.decls.filter((d) => d.kind === 'FakeDecl');
    const traitDecls = this.mod.decls.filter((d) => d.kind === 'TraitDecl');
    const implDecls = this.mod.decls.filter((d) => d.kind === 'ImplDecl');
    const constDecls = this.mod.decls.filter((d) => d.kind === 'ConstDecl');
    for (const d of [...typeDecls, ...fnDecls, ...constDecls]) {
      if (d.span.start.line > this.testsFrom || (d.kind === 'FnDecl' && d.test !== undefined)) this.testOnly.add(d.name);
    }
    for (const decl of traitDecls) this.declareTrait(decl);
    for (const decl of typeDecls) this.declareType(decl);
    // #6a607d39, #cb18c33b: the built-in `Exit` and `Signal`, unless the module has its own;
    // before fields, so a field may be one (#142ecc59: exec's `Stop`).
    for (const t of builtinTypes) if (!this.userTypes.has(t.name)) this.userTypes.set(t.name, t);
    // Bounds before fields: a field's type may need its type arguments to have them.
    for (const decl of typeDecls) this.boundTypeParams(decl);
    for (const decl of typeDecls) this.defineType(decl);
    this.checkRecursion();
    for (const decl of traitDecls) this.defineTrait(decl);
    for (const decl of effects) this.declareEffect(decl);
    for (const decl of externs) this.declareExtern(decl);
    for (const decl of constDecls) if (this.nameFree(decl.name, decl.nameSpan)) this.values.set(decl.name, { name: decl.name, type: T.error, decl });
    for (const decl of fakes) this.declareFake(decl);
    for (const decl of fnDecls) this.declare(decl, decl);
    for (const decl of implDecls) this.declareImpl(decl);
    for (const decl of constDecls) this.checkConst(decl);
    for (const decl of fnDecls) if (decl.test === undefined) this.checkFn(decl);
    for (const impl of this.ownImpls) this.checkImpl(impl);
    for (const decl of traitDecls) this.checkDefaults(decl);
    this.checkInstantiation();
    if (this.effect) this.checkEffect(this.effect);
    // After the fake, as tests are: a test fn may read its state.
    for (const decl of fnDecls) if (decl.test !== undefined) this.checkTestFn(decl);
    for (const decl of testDecls) this.checkTest(decl);
    // After every body: a struct `flags.parse` reads may name its flags with `as`.
    for (const decl of typeDecls) this.checkWireNames(decl);
    // A program's own module is imported by nothing, so what it exposes reaches no one.
    if (this.imported || !this.fns.has('main')) this.checkExposure(typeDecls, traitDecls);
    if (this.requireMain) this.checkMain();
    const sqlFunctionDecls = this.sqlFunctionDecls();
    const sqlDdl = this.checkSqlCalls(sqlFunctionDecls);
    this.diagnostics.sort((a, b) => a.span.start.line - b.span.start.line || a.span.start.col - b.span.start.col);
    return {
      sqlDdl,
      sqlFunctionDecls,
      module: this.mod.name,
      fns: this.fns,
      values: this.values,
      varConsts: this.varConsts,
      moduleRefs: this.moduleRefs,
      effect: this.effect,
      opaques: this.opaques,
      effects: this.userEffects,
      userTypes: [...this.userTypes.values()].filter((t) => !builtinTypes.includes(t)),
      traits: this.traits,
      traitBodies: this.traitBodies,
      impls: this.impls,
      ownImpls: this.ownImpls,
      traitCalls: this.traitCalls,
      types: this.types,
      refs: this.refs,
      methods: this.methods,
      variantRefs: this.variantRefs,
      structLits: this.structLits,
      patterns: this.patterns,
      resultCtors: this.resultCtors,
      coercions: this.coercions,
      narrowed: new Set(this.narrowed.keys()),
      flattened: this.flattened,
      unused: this.unused,
      presentBindings: this.presentBindings,
      listCalls: this.listCalls,
      mapCalls: this.mapCalls,
      wrapMaps: this.wrapMaps,
      resultChecks: this.resultChecks,
      mutMapReads: this.mutMapReads,
      mutListReads: this.mutListReads,
      fakeState: this.fakeState,
      indexed: this.indexed,
      queries: this.queries,
      taskCalls: this.taskCalls,
      randomCalls: this.randomCalls,
      embeds: this.embeds,
      signalCalls: this.signalCalls,
      flagCalls: this.flagCalls,
      sqlFunctions: this.sqlFunctions,
      callTypeArgs: this.callTypeArgs,
      tests: this.tests,
      diagnostics: this.diagnostics,
    };
  }

  /**
   * What other modules can use must not name what they can't: a `pub` function, field or trait
   * method, a `pub enum`'s fields, or an operation of the effect, whose types name a type or
   * trait of this module without `pub`.
   */
  private checkExposure(typeDecls: (ast.StructDecl | ast.EnumDecl)[], traitDecls: ast.TraitDecl[]) {
    const hidden = (t: Type): string | null => {
      const first = (ts: Type[]) => ts.reduce<string | null>((found, u) => found ?? hidden(u), null);
      switch (t.kind) {
        case 'struct':
        case 'enum':
          return t.module === this.mod.name && !t.pub ? t.name : first(t.args);
        case 'list':
          return hidden(t.elem);
        case 'map':
          return first([t.key, t.value]);
        case 'tuple':
          return first(t.elems);
        case 'option':
          return hidden(t.inner);
        case 'result':
          return first([t.ok, t.err]);
        case 'task':
          return hidden(t.result);
        case 'handle':
          return hidden(t.arg);
        case 'fn':
          return first([...t.params, t.ret]);
        default:
          return null;
      }
    };
    // A declaration's type parameters name their bounds; elsewhere a type parameter names nothing.
    const bounds = (ps: ParamType[], decls: ast.TypeParam[], at: Span) => ps.map((p, i) => ({ type: p as Type, span: decls[i]?.span ?? at, bound: true }));
    const expose = (who: string, undo: string | null, parts: { type: Type; span: Span; bound?: boolean }[]) => {
      for (const { type, span, bound } of parts) {
        const name = bound && type.kind === 'param' ? (type.bounds.find((b) => b.module === this.mod.name && !b.pub)?.name ?? null) : hidden(type);
        if (!name) continue;
        const kind = this.userTypes.get(name)?.kind ?? 'trait';
        this.error(Codes.Exposed, span, `${who} is public, but names \`${name}\`, which is private`, `add \`pub\` to \`${kind} ${name}\`${undo ? `, or remove \`pub\` from ${undo}` : ''}`);
      }
    };
    /** A function's parameters, result and bounds, each where it is written. */
    const signature = (sig: FnSig) => {
      const d = sig.decl;
      if (d.kind === 'ExternFn') return [{ type: sig.type as Type, span: d.nameSpan }];
      return [
        ...sig.params.map((p, i) => ({ type: p.type, span: d.params[i]?.type.span ?? d.nameSpan })),
        { type: sig.ret, span: d.returnType?.span ?? d.nameSpan },
        ...bounds(sig.typeParams, d.typeParams, d.nameSpan),
      ];
    };
    for (const sig of this.fns.values()) {
      if (sig.decl.pub) expose(`\`${sig.name}\``, `\`${sig.name}\``, signature(sig));
    }
    for (const v of this.values.values()) {
      // A const is a scalar, which names nothing.
      if (v.decl.pub && v.decl.kind === 'ExternLet') expose(`\`${v.name}\``, `\`${v.name}\``, [{ type: v.type, span: v.decl.type.span }]);
    }
    for (const decl of typeDecls) {
      const t = this.declTypes.get(decl);
      if (!t?.pub) continue;
      expose(`\`${t.name}\``, `\`${decl.kind === 'StructDecl' ? 'struct' : 'enum'} ${t.name}\``, bounds(t.params, decl.typeParams, decl.nameSpan));
      if (t.kind === 'struct' && decl.kind === 'StructDecl') {
        for (const f of decl.fields) {
          const field = t.fields.find((x) => x.name === f.name);
          if (field?.pub) expose(`field \`${f.name}\` of \`${t.name}\``, 'the field', [{ type: field.type, span: f.type.span }]);
        }
      } else if (t.kind === 'enum' && decl.kind === 'EnumDecl') {
        for (const v of decl.variants) {
          const variant = t.variants.find((x) => x.name === v.name);
          for (const f of v.fields) {
            const field = variant?.fields.find((x) => x.name === f.name);
            if (field) expose(`field \`${f.name}\` of \`${t.name}.${v.name}\``, `\`enum ${t.name}\``, [{ type: field.type, span: f.type.span }]);
          }
        }
      }
    }
    for (const decl of traitDecls) {
      const trait = this.traitDecls.get(decl);
      if (!trait?.pub) continue;
      for (const m of decl.methods) {
        const type = trait.methods.get(m.name);
        if (!type) continue;
        const parts = [...type.params.map((p, i) => ({ type: p, span: m.params[i]?.type.span ?? m.nameSpan })), { type: type.ret, span: m.returnType?.span ?? m.nameSpan }];
        expose(`method \`${m.name}\` of trait \`${trait.name}\``, `\`trait ${trait.name}\``, parts);
      }
    }
    if (this.effect) {
      for (const [what, sigs] of [['operation', this.effect.ops], ['test method', this.effect.steering]] as const) {
        for (const sig of sigs.values()) expose(`${what} \`${sig.name}\` of effect \`${this.effect.name}\``, null, signature(sig));
      }
    }
  }

  private declareType(decl: ast.StructDecl | ast.EnumDecl) {
    this.checkTypeName(decl.name, decl.nameSpan);
    if (builtinNames.has(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `\`${decl.name}\` is built in`, 'pick another name');
      return;
    }
    if (this.userTypes.has(decl.name) || resolveTypeName(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `type \`${decl.name}\` is already defined`);
      return;
    }
    if (this.traits.has(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `\`${decl.name}\` is already a trait`);
      return;
    }
    const t = declareUserType(decl.kind === 'StructDecl' ? 'struct' : 'enum', decl.name, this.mod.name, decl.pub !== null, decl.typeParams.map((p) => param(p.name)));
    this.userTypes.set(decl.name, t);
    this.declTypes.set(decl, t);
  }

  private defineType(decl: ast.StructDecl | ast.EnumDecl) {
    const t = this.declTypes.get(decl);
    if (!t) return; // a duplicate; already reported
    this.checkTypeParams(decl.typeParams);
    this.typeParams = new Map(t.params.map((p) => [p.name, p]));
    this.defining = t;
    try {
      this.defineFields(t, decl);
    } finally {
      this.typeParams = new Map();
      this.defining = null;
    }
  }

  private defineFields(t: UserType, decl: ast.StructDecl | ast.EnumDecl) {
    if (t.kind === 'struct' && decl.kind === 'StructDecl') {
      t.fields = this.fieldList(decl.fields, null);
      if (decl.doc) t.doc = decl.doc;
      return;
    }
    if (t.kind !== 'enum' || decl.kind !== 'EnumDecl') return;
    if (decl.variants.length === 0) {
      this.error(Codes.EmptyEnum, decl.nameSpan, `enum \`${decl.name}\` has no variants`, 'add at least one');
    }
    for (const v of decl.variants) {
      this.checkTypeName(v.name, v.nameSpan);
      if (t.variants.some((x) => x.name === v.name)) {
        this.error(Codes.Duplicate, v.nameSpan, `variant \`${v.name}\` is listed twice`);
        continue;
      }
      t.variants.push({ name: v.name, index: t.variants.length, fields: this.fieldList(v.fields, decl.pub !== null), ...(v.wire ? { wire: v.wire.name } : {}) });
    }
  }

  /** `pub`: what a variant's fields are, as public as their enum; null for a struct's, each its own. */
  private fieldList(decls: ast.FieldDecl[], pub: boolean | null): Field[] {
    const fields: Field[] = [];
    for (const f of decls) {
      if (fields.some((x) => x.name === f.name)) {
        this.error(Codes.Duplicate, f.nameSpan, `field \`${f.name}\` is listed twice`);
        continue;
      }
      fields.push({ name: f.name, type: this.resolveType(f.type), pub: pub ?? f.pub !== null, boxed: false, ...(f.wire ? { wire: f.wire.name } : {}), ...(f.doc ? { doc: f.doc } : {}) });
    }
    return fields;
  }

  /** Type parameters are named like types, and like every name, mean one thing where they are visible. */
  private checkTypeParams(decls: ast.TypeParam[]) {
    decls.forEach((d, i) => {
      this.checkTypeName(d.name, d.span);
      if (decls.slice(0, i).some((x) => x.name === d.name)) {
        this.error(Codes.Duplicate, d.span, `type parameter \`${d.name}\` is listed twice`);
      } else if (this.userTypes.has(d.name) || this.traits.has(d.name) || resolveTypeName(d.name) || builtinNames.has(d.name)) {
        this.error(Codes.Duplicate, d.span, `\`${d.name}\` is already a type`, 'pick another name for the type parameter; one letter, like `T`, is usual');
      }
    });
  }

  /** `f` with the type parameters `ps` in scope, beside an impl's. */
  private withTypeParams<R>(ps: ParamType[], f: () => R): R {
    const saved = this.typeParams;
    this.typeParams = new Map([...saved, ...ps.map((p) => [p.name, p] as const)]);
    try {
      return f();
    } finally {
      this.typeParams = saved;
    }
  }

  /** `f` with `Self` meaning `t`. */
  private withSelf<R>(t: Type, f: () => R): R {
    const saved = this.selfType;
    this.selfType = t;
    try {
      return f();
    } finally {
      this.selfType = saved;
    }
  }

  /** `trait Show { ... }`: the name now, so types and bounds can use it; the methods later. */
  private declareTrait(decl: ast.TraitDecl) {
    this.checkTypeName(decl.name, decl.nameSpan);
    if (builtinNames.has(decl.name) || builtinTraits.has(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `\`${decl.name}\` is built in`, 'pick another name');
      return;
    }
    if (this.traits.has(decl.name) || resolveTypeName(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `\`${decl.name}\` is already defined`);
      return;
    }
    const self = param('Self');
    const trait: Trait = { name: decl.name, module: this.mod.name, pub: decl.pub !== null, self, methods: new Map(), defaults: new Set() };
    self.bounds = [trait];
    this.traits.set(decl.name, trait);
    this.traitDecls.set(decl, trait);
  }

  /**
   * A trait's methods: each takes `self` first. They become methods of a Go interface, which
   * can't be generic. Their `uses` is what every caller declares; a body is the default.
   */
  private defineTrait(decl: ast.TraitDecl) {
    const trait = this.traitDecls.get(decl);
    if (!trait) return; // a duplicate; already reported
    const bodies = new Map<string, FnSig>();
    for (const m of decl.methods) {
      if (trait.methods.has(m.name)) {
        this.error(Codes.Duplicate, m.nameSpan, `\`${m.name}\` is listed twice`);
        continue;
      }
      if (!this.methodShape(m, `\`${trait.name}\``)) continue;
      const sig = this.withSelf(trait.self, () => this.signatureOf(m, m as unknown as ast.FnDecl));
      trait.methods.set(m.name, sig.type);
      if (m.body) {
        trait.defaults.add(m.name);
        bodies.set(m.name, sig);
      }
    }
    if (bodies.size > 0) this.traitBodies.set(trait, bodies);
  }

  /** Default bodies, over `Self`: they call the trait's methods on `self`, and do the method's effects. */
  private checkDefaults(decl: ast.TraitDecl) {
    const trait = this.traitDecls.get(decl);
    const bodies = trait && this.traitBodies.get(trait);
    if (!bodies) return;
    for (const m of decl.methods) {
      const sig = bodies.get(m.name);
      if (!sig || !m.body) continue;
      // The trait's `uses` is for every impl, so a default that does less is no slip: no warning.
      const fnDecl: ast.FnDecl = { ...m, kind: 'FnDecl', pub: null, uses: [], contracts: [], body: m.body };
      this.withSelf(trait.self, () => this.checkBody(sig, fnDecl, null));
    }
  }

  /** What every method in a trait or impl must be. Reports and returns false otherwise. */
  private methodShape(m: Pick<ast.FnDecl, 'name' | 'nameSpan' | 'typeParams' | 'params' | 'uses'>, owner: string): boolean {
    if (m.params[0]?.name !== 'self' || m.params[0].type.kind !== 'TypeName' || m.params[0].type.name !== 'Self') {
      this.error(Codes.BadImpl, m.nameSpan, `\`${m.name}\` in ${owner} takes \`self\` first`, `write \`fn ${m.name}(self${m.params.length > 0 ? ', ...' : ''})\`; for a function that needs no value, declare a plain \`fn\` outside`);
      return false;
    }
    if (m.typeParams.length > 0) {
      this.error(Codes.BadImpl, m.typeParams[0].span, 'a method cannot be generic yet', 'it becomes a method of a Go interface, which cannot have type parameters');
      return false;
    }
    const named = m.uses.find((u) => u.path.length === 1 && m.params.some((p) => p.name === u.path[0]));
    if (named) {
      this.error(
        Codes.BadImpl,
        named.span,
        `a method's \`uses\` names effects, and \`${named.path[0]}\` is a parameter`,
        `methods take no \`uses ${named.path[0]}\` yet: call \`${named.path[0]}\` in a plain function with \`uses ${named.path[0]}\``,
      );
      return false;
    }
    return true;
  }

  /** A struct's or enum's type parameters get their bounds once every trait is known. */
  private boundTypeParams(decl: ast.StructDecl | ast.EnumDecl) {
    const t = this.declTypes.get(decl);
    if (t) this.resolveBounds(decl.typeParams, t.params);
  }

  private resolveBounds(decls: ast.TypeParam[], params: ParamType[]) {
    decls.forEach((d, i) => {
      for (const b of d.bounds) {
        const trait = this.resolveTrait(b.name, b.span);
        if (!trait) continue;
        if (params[i].bounds.includes(trait)) this.error(Codes.Duplicate, b.span, `\`${b.name}\` is listed twice`);
        else params[i].bounds.push(trait);
      }
    });
  }

  /** `Eq`, `Show`, `geo.Show`. Reports and returns null if it isn't a trait. */
  private resolveTrait(name: string, span: Span): Trait | null {
    const found = this.traitNamed(name);
    const path = name.split('.');
    if (found && !found.pub && found.module !== this.mod.name) {
      const mod = this.imports.get(path[0])!;
      this.privateDecl(span, `trait \`${name}\``, mod, [...mod.traits.values()].filter((t) => t.pub).map((t) => t.name));
      return null;
    }
    if (found) return found;
    const isType = path.length === 1 ? this.userTypes.has(name) || resolveTypeName(name) !== null : this.imports.get(path[0])?.userTypes.some((t) => t.name === path[1]);
    if (isType) {
      this.error(Codes.UnknownType, span, `\`${name}\` is a type, not a trait`, 'a bound is a trait: `Eq`, `Ord`, or one declared with `trait`');
      return null;
    }
    const mod = path.length === 2 ? this.imports.get(path[0]) : undefined;
    if (mod) {
      const names = [...mod.traits.keys()];
      this.error(Codes.UnknownType, span, `module \`${path[0]}\` has no trait \`${path[1]}\``, names.length > 0 ? choices(path[1], names) : `\`${path[0]}\` declares no traits`);
      return null;
    }
    const imported = [...this.imports.values()].find((m) => m.traits.get(name)?.pub);
    const near = suggest(name, [...builtinTraits.keys(), ...this.traits.keys()]);
    this.error(
      Codes.UnknownType,
      span,
      `unknown trait \`${name}\``,
      imported ? `\`${name}\` is declared in module \`${imported.module}\`; write \`${imported.module}.${name}\`` : near ? `did you mean \`${near}\`?` : 'bounds are `Eq`, `Ord`, or traits declared with `trait`',
    );
    return null;
  }

  private traitNamed(name: string): Trait | null {
    const path = name.split('.');
    if (path.length === 2) return this.imports.get(path[0])?.traits.get(path[1]) ?? null;
    return builtinTraits.get(name) ?? this.traits.get(name) ?? null;
  }

  /** Every trait this module can name. */
  private visibleTraits(): Trait[] {
    return [...builtinTraits.values(), ...this.traits.values(), ...[...this.imports.values()].flatMap((m) => [...m.traits.values()].filter((t) => t.pub))];
  }

  /**
   * `impl Show for Point { ... }`: for a struct or enum, or int, string or bool, in the module of
   * the trait or of the type, with every method of the trait. A generic type's impl names its
   * parameters: `impl<T: Show> Show for Box<T>`.
   */
  private declareImpl(decl: ast.ImplDecl) {
    const trait = this.resolveTrait(decl.trait, decl.traitSpan);
    this.checkTypeParams(decl.typeParams);
    const params = decl.typeParams.map((p) => param(p.name));
    this.resolveBounds(decl.typeParams, params);
    const target = this.withTypeParams(params, () => this.resolveType(decl.target));
    if (!trait || target.kind === 'error') return;
    const name = traitName(trait, this.mod.name);
    const typeName = this.show(target);
    const fail = (span: Span, message: string, help?: string) => {
      this.error(Codes.BadImpl, span, message, help);
    };
    if (trait === Eq) {
      fail(decl.traitSpan, '`Eq` cannot be implemented', '`==` always compares by value, field by field: every type whose fields can be compared is `Eq` already');
      return;
    }
    if (decl.rule && trait !== Json) {
      fail(decl.rule.span, `a naming rule is for \`impl Json\`, whose fields have names in JSON`, `write \`impl ${name} for ${typeName}\``);
      return;
    }
    if (decl.nulls && trait !== Json) {
      fail(decl.nulls, '`nulls` is for `impl Json`: it writes a none field as `null`', `write \`impl ${name} for ${typeName}\``);
      return;
    }
    if (decl.extra.length > 0) {
      const x = decl.extra[0];
      fail(
        x.span,
        x.name === 'nulls' ? '`nulls` is given twice' : `\`${x.name}\` comes after the naming rule \`${decl.rule!.name}\``,
        `an impl takes one naming rule and \`nulls\`, at most: \`impl Json(${decl.rule?.name ?? 'snake'}, nulls) for ${typeName}\``,
      );
      return;
    }
    if (decl.via && trait !== Json) {
      fail(decl.via.span, `\`via\` is for \`impl Json\`, to write a type's JSON form by hand`, `write \`impl ${name} for ${typeName}\``);
      return;
    }
    if (decl.rule && !jsonRules[decl.rule.name]) {
      const near = suggest(decl.rule.name, Object.keys(jsonRules));
      fail(decl.rule.span, `\`${decl.rule.name}\` is not a naming rule`, `${near ? `did you mean \`${near}\`? ` : ''}the rules are \`snake\` (created_at), \`kebab\` (created-at), \`camel\` (createdAt) and \`pascal\` (CreatedAt); \`nulls\` writes a none field as \`null\``);
      return;
    }
    if (decl.rule && decl.via) {
      fail(decl.rule.span, `\`impl Json ... via\` writes the JSON form by hand, so no rule names its fields`, `drop \`(${decl.rule.name})\`, or \`via\` to derive it`);
      return;
    }
    if (decl.nulls && decl.via) {
      fail(decl.nulls, '`impl Json ... via` writes the JSON form by hand, so `nulls` has no fields to write', '`toJson` gives the form, nulls and all; drop `(nulls)`, or `via` to derive it');
      return;
    }
    const via = trait === Json && decl.via ? this.withTypeParams(params, () => this.resolveType(decl.via!)) : null;
    if (via?.kind === 'error') return;
    const derived = (trait === Json && !via) || trait === Row;
    if (derived && !decl.derived) {
      const byHand = trait === Json ? `; or give its JSON form by hand: \`impl Json for ${typeName} via string {${this.viaSample(target, T.string)}}\`` : '';
      fail(decl.traitSpan, `\`${trait.name}\` is derived, not written`, `write \`impl ${trait.name} for ${typeName}\` with no body: the compiler writes it from the type${byHand}`);
      return;
    }
    if (via && decl.derived) {
      fail(decl.traitSpan, `\`impl Json for ${typeName} via ${this.show(via)}\` needs a body`, `give the two conversions: \`impl Json for ${typeName} via ${this.show(via)} {${this.viaSample(target, via)}}\``);
      return;
    }
    if (via && sameType(via, target)) {
      fail(decl.via!.span, `${typeName} can't be written via itself`, 'name the type its JSON form is: `via string`, `via int`, or a struct with `impl Json`');
      return;
    }
    if (decl.derived && !derived && trait !== Show && [...trait.methods.keys()].every((m) => trait.defaults.has(m))) {
      fail(decl.traitSpan, `only \`Json\`, \`Row\` and \`Show\` are derived, so \`impl ${name} for ${typeName}\` needs a body`, `every method of \`${name}\` has a default: write \`impl ${name} for ${typeName} {}\``);
      return;
    }
    if (decl.derived && !derived && trait !== Show) {
      fail(decl.traitSpan, `only \`Json\`, \`Row\` and \`Show\` are derived, so \`impl ${name} for ${typeName}\` needs a body`, `give the methods: \`impl ${name} for ${typeName} {${this.methodSample(trait, target)}}\``);
      return;
    }
    if ((trait === Ord && ordered(target)) || (trait === Show && shown(target)) || (trait === Json && jsonPrimitive(target)) || (trait === Row && rowPrimitive(target))) {
      fail(decl.target.span, `${typeName} is \`${trait.name}\` already`);
      return;
    }
    const user = target.kind === 'struct' || target.kind === 'enum';
    if (!user && target.kind !== 'int' && target.kind !== 'string' && target.kind !== 'bool') {
      fail(decl.target.span, `an \`impl\` is for one struct or enum, or int, string or bool, not ${typeName}`);
      return;
    }
    // One impl covers every instance of a generic type, so it names the type's arguments as its own.
    const generic = user && target.params.length > 0;
    if (generic ? target.args.length !== params.length || target.args.some((a, i) => a !== params[i]) : params.length > 0) {
      const head = generic ? this.implHead(trait, target.origin) : `impl ${name} for ${typeName}`;
      fail(
        generic ? decl.target.span : decl.typeParams[0].span,
        generic
          ? `an impl for ${typeName} is for every \`${target.name}\`, so its type arguments are the impl's own type parameters, in order`
          : `${typeName} has no type parameters, so the impl takes none`,
        `write \`${head}\``,
      );
      return;
    }
    if (generic && trait === Row) {
      fail(decl.target.span, `\`impl Row\` is for a struct without type parameters, since its fields are the columns`);
      return;
    }
    if (trait.module !== this.mod.name && (!user || target.module !== this.mod.name)) {
      fail(
        decl.traitSpan,
        `\`impl ${name} for ${typeName}\` belongs in the module of \`${name}\` or of ${typeName}`,
        'so there is one place to look for it, and two modules cannot give the same type the same trait',
      );
      return;
    }
    const key = implKey(trait, target);
    if (this.impls.has(key)) {
      fail(decl.traitSpan, generic ? `\`${target.name}\` already has \`impl ${name}\`, for every \`${target.name}\`` : `${typeName} already has \`impl ${name}\``);
      return;
    }
    const methods = new Map<string, FnSig>();
    // `via string`: the two conversions take the trait's methods' place.
    const wanted: Map<string, FnType> = via
      ? new Map([
          ['toJson', fn([target], via)],
          ['fromJson', fn([via], { kind: 'result', ok: target, err: T.string })],
        ])
      : trait.methods;
    // Given but broken: reported already, so not missing as well.
    const given = new Set(decl.fns.map((f) => f.name));
    for (const f of decl.fns) {
      const want = wanted.get(f.name);
      if (!want) {
        const names = [...wanted.keys()];
        const owner = via ? `\`impl Json ... via\`` : `\`${name}\``;
        fail(f.nameSpan, `${owner} has no method \`${f.name}\``, names.length > 0 ? choices(f.name, names) : `\`${name}\` has no methods`);
        continue;
      }
      if (methods.has(f.name)) {
        this.error(Codes.Duplicate, f.nameSpan, `\`${f.name}\` is already defined`);
        continue;
      }
      if (via && f.name === 'fromJson') {
        if (f.params[0]?.name === 'self') {
          fail(f.nameSpan, '`fromJson` makes a value, so it takes the JSON form, not `self`', `write \`fn fromJson(x: ${this.show(via)}) -> Result<${typeName}, string>\``);
          continue;
        }
        if (f.typeParams.length > 0) {
          fail(f.typeParams[0].span, 'a method cannot be generic yet', 'it becomes a method of a Go interface, which cannot have type parameters');
          continue;
        }
      } else if (!this.methodShape(f, `an \`impl\``)) continue;
      if (target.kind === 'struct' && target.fields.some((x) => x.name === f.name)) {
        fail(f.nameSpan, `${typeName} has a field \`${f.name}\`, so a method cannot have that name`, `rename the method in \`trait ${trait.name}\`, or the field`);
        continue;
      }
      if (primitiveMethods(target).has(f.name)) {
        fail(f.nameSpan, `${typeName} has a method \`${f.name}\` already`, `rename the method in \`trait ${trait.name}\``);
        continue;
      }
      const sig = this.withTypeParams(params, () => this.withSelf(target, () => this.signatureOf(f, f)));
      const expected = subst(want, (p) => (p === trait.self ? target : p)) as FnType;
      // Effects aside: an impl may do fewer than its trait allows.
      if (!sameType(fn(sig.type.params, sig.ret), fn(expected.params, expected.ret)) && sig.type.params.every((p) => p.kind !== 'error') && sig.ret.kind !== 'error') {
        this.error(Codes.TypeMismatch, f.nameSpan, `\`${f.name}\` must have the signature \`${name}\` gives it: expected ${this.show(fn(expected.params, expected.ret))}, found ${this.show(fn(sig.type.params, sig.ret))}`);
      }
      for (const u of sig.uses.filter((u) => !want.uses.includes(u))) {
        const ref = f.uses.find((r) => r.path.join('.') === u)!;
        if (via) {
          fail(ref.span, `\`${f.name}\` uses \`${u}\`, and a JSON form takes no effects`, `\`toJson\` and \`fromJson\` only convert: do what needs \`${u}\` before encoding or after decoding`);
          continue;
        }
        fail(
          ref.span,
          `\`${f.name}\` uses \`${u}\`, which \`${name}.${f.name}\` does not declare`,
          `an impl's method may do fewer effects than its trait says, not more: add \`${u}\` to \`uses\` of \`${f.name}\` in \`trait ${trait.name}\`, or do it in the function that calls \`${f.name}\``,
        );
      }
      methods.set(f.name, sig);
    }
    const missing = [...wanted.keys()].filter((m) => !given.has(m) && !trait.defaults.has(m));
    if (missing.length > 0 && !decl.derived) {
      fail(
        decl.traitSpan,
        `\`impl ${name} for ${typeName}\` has no ${missing.map((m) => `\`${m}\``).join(', ')}`,
        via ? `\`via ${this.show(via)}\` writes ${typeName} as ${this.show(via)} and reads it back: give both, \`{${this.viaSample(target, via)}}\`` : 'an impl gives every method of its trait',
      );
    }
    const impl: Impl = { trait, type: target, params, module: this.mod.name, methods, decl, via };
    this.impls.set(key, impl);
    this.ownImpls.push(impl);
  }

  private checkImpl(impl: Impl) {
    this.withTypeParams(impl.params, () => {
      if (impl.trait === Json && impl.via) this.checkVia(impl, impl.via);
      else if (impl.trait === Json) this.checkDerivedJson(impl);
      if (impl.trait === Row) this.checkDerivedRow(impl);
      if (impl.trait === Show && impl.decl.derived) this.checkDerivedFields(impl, Show, 'a string shows int, string, bool, lists, maps, optionals and Results of those, and types with `impl Show`');
      for (const sig of impl.methods.values()) this.withSelf(impl.type, () => this.checkBody(sig, sig.decl as ast.FnDecl, null));
    });
  }

  /** A derived impl of `trait`: every field has it too. */
  private checkDerivedFields(impl: Impl, trait: Trait, help: string) {
    const t = impl.type;
    if (t.kind !== 'struct' && t.kind !== 'enum') return;
    const fields =
      t.kind === 'struct'
        ? t.fields.map((f) => ({ label: `${t.name}.${f.name}`, field: f }))
        : t.variants.flatMap((v) => v.fields.map((f) => ({ label: `${t.name}.${v.name}.${f.name}`, field: f })));
    for (const { label, field } of fields) {
      const why = this.lacks(field.type, trait);
      if (!why) continue;
      this.error(
        Codes.Bound,
        impl.decl.target.span,
        `\`impl ${trait.name} for ${t.name}\` needs every field to be \`${trait.name}\`, and \`${label}\` is ${this.show(field.type)}: ${why}`,
        this.boundHelp(field.type, trait) ?? help,
      );
    }
  }

  /**
   * `impl Json for T`: every field is `Json`, and a variant's JSON names it with `kind`. Names in
   * JSON, after the rule and `as`, are each used once.
   */
  private checkDerivedJson(impl: Impl) {
    const t = impl.type;
    if (t.kind !== 'struct' && t.kind !== 'enum') return;
    const span = impl.decl.target.span;
    const rule = impl.decl.rule?.name ?? null;
    this.checkDerivedFields(impl, Json, 'JSON holds int, string, bool, `T?`, lists, maps with string keys, and types with `impl Json`');
    // Two names that read the same in JSON: the second can't be told from the first.
    const once = (items: { name: string; wire?: string }[], owner: string, what: string) => {
      const seen = new Map<string, string>();
      for (const x of items) {
        const wire = jsonName(x, rule);
        const first = seen.get(wire);
        if (first === undefined) {
          seen.set(wire, x.name);
          continue;
        }
        this.error(
          Codes.BadImpl,
          span,
          `${owner}'s ${what}s \`${first}\` and \`${x.name}\` are both \`"${wire}"\` in JSON`,
          `give one of them another name with \`as\`: \`${x.name}${what === 'field' ? ': ...' : ''} as "${wire}2"\``,
        );
      }
    };
    if (t.kind === 'struct') {
      once(t.fields, t.name, 'field');
      return;
    }
    once(t.variants, t.name, 'variant');
    if (!t.variants.some((v) => v.fields.length > 0)) return;
    for (const v of t.variants) {
      once(v.fields, `${t.name}.${v.name}`, 'field');
      const kind = v.fields.find((f) => jsonName(f, rule) === 'kind');
      if (!kind) continue;
      this.error(
        Codes.BadImpl,
        span,
        `\`${t.name}.${v.name}\` has a field ${kind.name === 'kind' ? '`kind`,' : `\`${kind.name}\`, \`"kind"\` in JSON,`} which \`impl Json\` uses to say which variant a value is`,
        `rename the field, or give it another JSON name with \`as\`: \`{"kind":"${jsonName(v, rule)}", ...}\` is how ${t.name} reads in JSON`,
      );
    }
  }

  /** `as "type"` names a field in derived JSON, so a type with one has `impl Json`, derived. */
  private checkWireNames(decl: ast.StructDecl | ast.EnumDecl) {
    const t = this.declTypes.get(decl);
    if (!t) return;
    const impl = this.impls.get(implKey(Json, t));
    if (impl && !impl.via) return;
    if ([...this.flagCalls.values()].some((x) => x.origin === t)) return;
    const items = decl.kind === 'StructDecl' ? decl.fields : decl.variants.flatMap((v) => [v, ...v.fields]);
    for (const x of items) {
      if (!x.wire) continue;
      this.error(
        Codes.BadImpl,
        x.wire.span,
        `\`as "${x.wire.name}"\` names \`${x.name}\` in JSON, and ${decl.name} ${impl ? 'writes its JSON by hand, with `via`' : 'has no `impl Json`'}`,
        impl ? `drop \`as "${x.wire.name}"\`: \`toJson\` decides the form` : `derive it: \`impl Json for ${decl.name}\`, or drop \`as "${x.wire.name}"\` (it also names a flag of a struct this module gives \`flags.parse\`)`,
      );
    }
  }

  /** `impl Json for Money via string`: the form it goes via is `Json` itself. */
  private checkVia(impl: Impl, via: Type) {
    const why = this.lacks(via, Json);
    if (!why) return;
    this.error(
      Codes.Bound,
      impl.decl.via!.span,
      `\`via ${this.show(via)}\` needs ${this.show(via)} to be \`Json\`: ${why}`,
      this.boundHelp(via, Json) ?? 'JSON holds int, string, bool, `T?`, lists, maps with string keys, and types with `impl Json`',
    );
  }

  /** `impl Row for T`: a struct whose fields are columns, int, string, bool, float or Bytes, or optionals of those. */
  private checkDerivedRow(impl: Impl) {
    const t = impl.type;
    const span = impl.decl.target.span;
    if (t.kind === 'enum') {
      this.error(Codes.BadImpl, span, `\`impl Row\` is for a struct, whose fields are the columns, and ${t.name} is an enum`, 'read the column as a string or int, and turn it into the enum with a `match`');
      return;
    }
    if (t.kind !== 'struct') return;
    for (const f of t.fields) {
      if (column(f.type)) continue;
      this.error(
        Codes.Bound,
        span,
        `\`impl Row for ${t.name}\` needs every field to be a column, and \`${t.name}.${f.name}\` is ${this.show(f.type)}`,
        'a column is int, string, bool, float or Bytes, or an optional of those for one that may be NULL',
      );
    }
  }

  /** Why `t` doesn't have `trait`, or null when it does. */
  private lacks(t: Type, trait: Trait): string | null {
    if (t.kind === 'error') return null;
    const name = traitName(trait, this.mod.name);
    if (t.kind === 'param') return t.bounds.includes(trait) ? null : `\`${t.name}\` has no bound \`${name}\``;
    if (trait === Eq) return comparable(t) ? null : this.whyNotEq(t);
    if (trait === Ord && ordered(t)) return null;
    // A tuple is ordered item by item, so each item must be (card 052).
    if (trait === Ord && t.kind === 'tuple') {
      for (const x of t.elems) {
        const why = this.lacks(x, Ord);
        if (why) return `${this.show(t)} is ordered item by item, and ${why}`;
      }
      return null;
    }
    if (trait === Show && shown(t)) return null;
    if (trait === Show && showInner(t).length > 0) {
      for (const x of showInner(t)) {
        const why = this.lacks(x, Show);
        if (why) return why;
      }
      return null;
    }
    if (trait === Json) return this.whyNotJson(t);
    if (trait === Row && rowPrimitive(t)) return null;
    const impl = this.impls.get(implKey(trait, t));
    if (impl) return this.implArgsLack(impl, t);
    if (trait === Row && t.kind === 'option') return 'a row is read into a value, never none: a query with no rows gives an empty list';
    if (trait === Row && t.kind !== 'struct') return `${this.show(t)} is not a row: a row is a struct with \`impl Row\`, or int, string, bool, float or Bytes for one column`;
    return `${this.show(t)} has no \`impl ${name}\``;
  }

  /** `Json` reaches through optionals, lists and maps with string keys to the impls inside. */
  private whyNotJson(t: Type): string | null {
    const inner = jsonInner(t);
    if (inner) return this.lacks(inner, Json);
    if (t.kind === 'map') return `JSON object keys are strings, and ${this.show(t)} has ${this.show(t.key)} keys`;
    if (jsonPrimitive(t)) return null;
    const impl = this.impls.get(implKey(Json, t));
    if (impl) return this.implArgsLack(impl, t);
    if (t.kind === 'struct' || t.kind === 'enum') return `${this.show(t)} has no \`impl Json\``;
    return `${this.show(t)} has no JSON form`;
  }

  /** Why an impl doesn't give `t` its trait: a type argument without a bound the impl asks for. Null when it does. */
  private implArgsLack(impl: Impl, t: Type): string | null {
    if (t.kind !== 'struct' && t.kind !== 'enum') return null;
    for (const [i, p] of impl.params.entries()) {
      for (const b of p.bounds) {
        const why = this.lacks(t.args[i], b);
        if (why) return `${this.show(t)} is \`${traitName(impl.trait, this.mod.name)}\` when \`${p.name}\` is \`${traitName(b, this.mod.name)}\`, and ${why}`;
      }
    }
    return null;
  }

  /** The type argument of `t` that its impl of `trait` needs a bound on, and the bound. */
  private lackingArg(trait: Trait, t: Type): { arg: Type; bound: Trait } | null {
    const impl = this.impls.get(implKey(trait, t));
    if (!impl || (t.kind !== 'struct' && t.kind !== 'enum')) return null;
    for (const [i, p] of impl.params.entries()) for (const b of p.bounds) if (this.lacks(t.args[i], b)) return { arg: t.args[i], bound: b };
    return null;
  }

  /** `impl Show for Point`, `impl<T: Show> Show for Box<T>`: how an impl of `trait` for `t` starts. */
  private implHead(trait: Trait, t: Type): string {
    const name = traitName(trait, this.mod.name);
    if ((t.kind !== 'struct' && t.kind !== 'enum') || t.params.length === 0) return `impl ${name} for ${this.show(t)}`;
    const ps = t.origin.params.map((p) => p.name);
    const bound = trait === Eq || trait === Row ? '' : `: ${name}`;
    return `impl<${ps.map((p) => `${p}${bound}`).join(', ')}> ${name} for ${this.show(t.origin)}`;
  }

  /** What to do about `lacks(t, trait)`. */
  private boundHelp(t: Type, trait: Trait): string | undefined {
    const name = traitName(trait, this.mod.name);
    if (t.kind === 'param') return `add the bound where \`${t.name}\` is declared: \`<${t.name}: ${name}>\``;
    if (trait === Eq) return undefined;
    const inner = trait === Json ? jsonInner(t) : trait === Show ? (showInner(t).find((x) => this.lacks(x, Show)) ?? null) : null;
    if (inner) return this.boundHelp(inner, trait);
    const arg = this.lackingArg(trait, t);
    if (arg) return this.boundHelp(arg.arg, arg.bound);
    const own = (t.kind === 'struct' || t.kind === 'enum') && t.module === this.mod.name;
    const head = this.implHead(trait, t);
    if (trait === Json && t.kind === 'map') return `key it by string: \`Map<string, ${this.show(t.value)}>\``;
    if (trait === Json && t.kind === 'tuple') return 'JSON has no tuples: use a struct, with `impl Json` for it';
    if (trait === Json) return own ? `derive it: \`${head}\`` : undefined;
    if (trait === Row && t.kind === 'list') return `\`sql.query\` gives a list already: ask for the item, \`sql.query<${this.show(t.elem)}>(...)\``;
    if (trait === Row) return own && t.kind === 'struct' ? `derive it: \`${head}\`` : undefined;
    if (!own && trait.module !== this.mod.name) return undefined;
    if (trait === Show && own) return `derive it: \`${head}\`, or write it: \`${head} {${this.methodSample(trait, t)}}\``;
    return `give it one: \`${head} {${this.methodSample(trait, t)}}\``;
  }

  /** ` fn toString(self) -> string { ... } `: the methods an impl of `trait` for `t` gives. */
  private methodSample(trait: Trait, t: Type): string {
    if (trait === Ord) return ` fn compare(self, other: ${this.show(t)}) -> int { ... } `;
    if (trait === Show) return ' fn toString(self) -> string { ... } ';
    return ' ... ';
  }

  /** The two methods of `impl Json for T via V`. */
  private viaSample(t: Type, via: Type): string {
    return ` fn toJson(self) -> ${this.show(via)} { ... } fn fromJson(x: ${this.show(via)}) -> Result<${this.show(t)}, string> { ... } `;
  }

  /** Why values of `t` can't be compared with `==`. */
  private whyNotEq(t: Type): string {
    const shown = this.show(t);
    if (t.kind === 'fn') return 'functions cannot be compared';
    if (t.kind === 'goerror') return 'Go errors are compared with `.is(...)`: `e.is(strconv.errRange)`';
    if (isSqlQuery(t)) return 'a `sql.Query` is run, not compared: compare what it reads';
    if (holdsOpaque(t)) return `${t.kind === 'opaque' ? 'a Go value has' : `${shown} holds a Go value, which has`} no \`==\`; compare what you read from it`;
    const held = heldHandle(t);
    if (held) {
      const why = held.handle === 'Arm' ? 'is a choice for `tasks.select`, not a value' : 'is shared by tasks, not a value: compare what you read from it';
      return `${t === held ? `${article(held.handle)} ${held.handle}` : `${shown} holds ${article(held.handle)} ${held.handle}, which`} ${why}`;
    }
    const p = [...paramsIn(t)].find((x) => !x.bounds.includes(Eq));
    if (p) return `${t.kind === 'param' ? '' : `${shown} holds \`${p.name}\`, and `}\`${p.name}\` has no bound \`Eq\``;
    if (shown.includes('GoError')) return `${shown} holds a GoError, which only \`.is(...)\` compares; \`match\` it instead`;
    return `${shown} holds functions, which cannot be compared`;
  }

  /** Whether `key` can key a map, which compares keys with `==`; reports it if not. */
  private checkKey(key: Type, span: Span): boolean {
    const why = this.lacks(key, Eq);
    if (!why) return true;
    this.error(Codes.Bound, span, `map keys are compared with \`==\`, but ${why}`, this.boundHelp(key, Eq));
    return false;
  }

  /** Whether each argument has what its type parameter's bounds ask; reports those that don't. */
  private checkBounds(params: ParamType[], args: Type[], span: Span, what: string): boolean {
    let ok = true;
    params.forEach((p, i) => {
      for (const b of p.bounds) {
        const why = this.lacks(args[i], b);
        if (!why) continue;
        ok = false;
        const arg = args[i];
        const shown = arg.kind === 'param' ? `\`${arg.name}\`` : this.show(arg);
        this.error(Codes.Bound, span, `${what} needs \`${p.name}: ${traitName(b, this.mod.name)}\`, and \`${p.name}\` is ${shown} here: ${why}`, this.boundHelp(arg, b));
      }
    });
    return ok;
  }

  /** The trait methods called `name` that values of `t` have: from its bounds, or the impls for it. */
  private traitMethods(t: Type, name: string): { trait: Trait; type: FnType }[] {
    if (t.kind === 'error') return [];
    let traits: Trait[];
    if (t.kind === 'param') {
      traits = t.bounds;
    } else {
      const key = implTypeKey(t);
      traits = [...this.impls.values()].filter((i) => implTypeKey(i.type) === key).map((i) => i.trait);
      if (ordered(t) || (t.kind === 'tuple' && !this.lacks(t, Ord))) traits.push(Ord);
      if (showInner(t).length > 0) traits.push(Show);
    }
    return traits
      .filter((tr) => tr.methods.has(name))
      .map((tr) => ({ trait: tr, type: subst(tr.methods.get(name)!, (p) => (p === tr.self ? t : p)) as FnType }));
  }

  /** `x.show()`: a trait method, through an impl or a bound. The caller declares the trait method's effects. */
  private traitCall(e: ast.Call, callee: ast.Member, self: Type, found: { trait: Trait; type: FnType }[]): Type {
    if (found.length > 1) {
      for (const a of e.args) this.checkExpr(a);
      const names = found.map((f) => `\`${traitName(f.trait, this.mod.name)}\``);
      this.error(Codes.NoSuchMember, callee.nameSpan, `\`${callee.name}\` is a method of both ${names.join(' and ')}, so it is unclear which one this calls`, 'rename the method in one of the traits');
      return T.error;
    }
    const { trait, type } = found[0];
    if (!trait.pub && trait.module !== this.mod.name) {
      for (const a of e.args) this.checkExpr(a);
      this.error(
        Codes.Private,
        callee.nameSpan,
        `\`${callee.name}\` is a method of trait \`${trait.module}.${trait.name}\`, which is private to module \`${trait.module}\``,
        `only \`${trait.module}\` can call it: use a \`pub fn\` of \`${trait.module}\`, or add \`pub\` to the trait`,
      );
      return T.error;
    }
    // `Box<T>`'s impl asks its argument for bounds.
    const why = self.kind === 'param' ? null : this.lacks(self, trait);
    if (why) {
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.Bound, callee.nameSpan, `\`${callee.name}\` needs ${this.show(self)} to be \`${traitName(trait, this.mod.name)}\`: ${why}`, this.boundHelp(self, trait));
      return T.error;
    }
    const params = type.params.slice(1);
    this.types.set(callee, fn(params, type.ret));
    // The trait's effects, whichever impl runs: the trait is the contract.
    this.perform(type.uses, callee.nameSpan, `\`${callee.name}\``);
    if (!this.arity(e, callee.name, params.length)) return T.error;
    e.args.forEach((a, i) => this.checkAgainst(a, params[i]));
    this.traitCalls.set(e, { trait, self });
    return type.ret;
  }

  private checkTypeName(name: string, span: Span) {
    if (!/^[A-Z]/.test(name)) {
      this.error(
        Codes.Naming,
        span,
        `\`${name}\` must start with an uppercase letter`,
        `type and variant names are uppercase, so \`${name[0].toUpperCase() + name.slice(1)}\``,
      );
    }
  }

  /**
   * A field that leads back to its own type, through an enum, `T?` or Result where the
   * recursion can end, is boxed: a pointer in Go. Values are immutable, so sharing one is
   * indistinguishable from copying it. A cycle through plain structs alone has nothing to end
   * it: such a value would contain itself forever.
   */
  private checkRecursion() {
    for (const t of this.userTypes.values()) {
      const fields = t.kind === 'struct' ? t.fields : t.variants.flatMap((v) => v.fields);
      for (const f of fields) f.boxed = reaches(f.type, t, { needSum: t.kind === 'struct', byValueOnly: false });
    }
    for (const [decl, t] of this.declTypes) {
      const byValue = (f: Field) => !f.boxed && reaches(f.type, t, { needSum: false, byValueOnly: true });
      if (t.kind === 'struct' && t.fields.some(byValue)) {
        this.error(
          Codes.RecursiveType,
          decl.nameSpan,
          `struct \`${t.name}\` contains itself`,
          'a struct cannot hold itself; put the recursion in an enum with a variant that ends it',
        );
      }
    }
  }

  /** Whether a module-level name is free; reports why not. */
  private nameFree(name: string, span: Span): boolean {
    const clash = builtinNames.has(name)
      ? 'is built in'
      : this.userTypes.has(name)
        ? 'is already a type'
        : this.fns.has(name) || this.values.has(name) || this.effect?.ops.has(name) || this.effect?.steering.has(name)
          ? 'is already defined'
          : this.imports.has(name)
            ? 'is the name of an imported module'
            : this.effectType(name)
              ? 'is the name of an effect'
              : null;
    if (clash) this.error(Codes.Duplicate, span, `\`${name}\` ${clash}`, clash === 'is built in' ? 'pick another name' : undefined);
    return clash === null;
  }

  /**
   * An `extern` block. Its signatures can't be checked against Go here (Go's type checker does
   * that when it builds), and what a Go function does can't be checked at all: the binding is
   * trusted to be pure. One inside an `effect` (`privateTo`) may do anything: only that
   * effect's operations call it, and tests get the fake instead.
   */
  private declareExtern(decl: ast.ExternDecl, privateTo?: string) {
    if (decl.goPath === '') this.error(Codes.ExternUnsupported, decl.goPathSpan, 'an `extern` block needs a Go import path', 'as in `extern "strconv" { ... }`');
    else this.checkVersion(decl);
    if (decl.items.length === 0 && !privateTo) {
      this.error(
        Codes.ExternUnsupported,
        decl.goPathSpan,
        'an empty `extern` block imports a Go package only for what it does when loaded',
        `that is a side effect, like registering a database driver: put the block inside \`effect ${this.mod.name} { ... }\``,
      );
    }
    for (const item of decl.items) {
      if (!/^[A-Z]/.test(item.goName)) {
        this.error(
          Codes.ExternUnsupported,
          item.goNameSpan,
          `Go only exports names that start with an uppercase letter, so \`${item.goName}\` can't be reached`,
          'name the exported Go symbol, and give it a Candor name with `as`',
        );
      }
      if (item.kind === 'ExternType') {
        if (!privateTo) {
          this.error(
            Codes.ExternUnsupported,
            item.span,
            'a Go type is bound inside an effect',
            `move it into \`effect ${this.mod.name} { extern "${decl.goPath}" { ... } }\`: a Go value is a reference, so only an effect, with a fake for tests, may hold one`,
          );
        }
        continue;
      }
      if (item.kind === 'ExternLet') {
        if (!this.nameFree(item.name, item.nameSpan)) continue;
        const type = this.resolveType(item.type);
        if (type.kind !== 'error' && !externValueType(type) && type.kind !== 'goerror') this.externTypeError(item.type.span, type);
        this.values.set(item.name, { name: item.name, type, decl: item });
        continue;
      }
      if (item.uses.length > 0) {
        this.error(
          Codes.ExternUnsupported,
          item.uses[0].span,
          'a binding has no `uses`',
          `a Go function that does I/O belongs inside \`effect ${this.mod.name} { ... }\`, where only the effect's operations can call it`,
        );
      }
      if (item.unvetted) {
        this.error(
          Codes.Unvetted,
          item.unvetted,
          `nobody has decided yet whether the Go function \`${item.goName}\` is pure`,
          privateTo
            ? 'it is bound inside an effect, where only operations call it: delete `unvetted`'
            : `if it does no I/O, keeps no global state, never blocks and can't exit the program, delete \`unvetted\`; otherwise move it into \`effect ${this.mod.name} { ... }\`, where only the effect's operations call it`,
        );
      }
      if (item.ctx && !privateTo && !item.unvetted) {
        this.error(
          Codes.ExternUnsupported,
          item.ctx,
          'only an effect\'s bindings get a context',
          `a Go function that takes a \`context.Context\` blocks or does I/O: bind it inside \`effect ${this.mod.name} { ... }\``,
        );
      }
      const params = [...(item.receiver ? [item.receiver] : []), ...item.params, ...(item.spread ?? [])];
      const sig = this.declare({ ...item, params, uses: [] }, item);
      if (!sig) continue;
      if (privateTo) sig.privateTo = privateTo;
      params.forEach((p, i) => {
        const t = sig.params[i].type;
        if (t.kind !== 'error' && t.kind !== 'goerror' && !externValueType(t) && t.kind !== 'opaque') this.externTypeError(p.type.span, t);
      });
      const receiver = sig.params[0]?.type;
      if (item.receiver && receiver.kind !== 'error' && !(receiver.kind === 'opaque' && decl.items.some((x) => x.kind === 'ExternType' && x.name === receiver.name))) {
        this.error(
          Codes.ExternUnsupported,
          item.receiver.type.span,
          `a method belongs to a Go type, so its receiver is one declared in this \`extern\` block, not ${this.show(receiver)}`,
          `declare the type first, as in \`type *T as Name\`, then write \`fn (x: Name) ${item.goName}(...)\``,
        );
      }
      const spread = item.spread ?? [];
      spread.forEach((p, i) => {
        const t = sig.params[params.length - spread.length + i].type;
        if (t.kind === 'list') this.error(Codes.ExternUnsupported, p.type.span, "a list can't go into Go's variadic parameter", 'pass each value as a parameter of its own');
      });
      const ret = sig.ret;
      const value = (t: Type) => externValueType(t) || t.kind === 'opaque';
      const ok =
        ret.kind === 'unit' ||
        ret.kind === 'error' ||
        value(ret) ||
        (ret.kind === 'option' && value(ret.inner)) ||
        (ret.kind === 'result' && (value(ret.ok) || ret.ok.kind === 'unit') && ret.err.kind === 'goerror');
      if (!ok && item.returnType) {
        if (ret.kind === 'result' && ret.err.kind !== 'goerror') {
          this.error(
            Codes.ExternUnsupported,
            item.returnType.span,
            `a Go function fails with a Go \`error\`, so its Result is \`Result<T, GoError>\`, not ${this.show(ret)}`,
            `write \`Result<${this.show(ret.ok)}, GoError>\``,
          );
        } else {
          this.externTypeError(item.returnType.span, ret);
        }
      }
    }
  }

  /**
   * A third-party Go package names the version of its Go module, `@v1.0.1`; the standard
   * library and Go packages next to the binding have none.
   */
  private checkVersion(decl: ast.ExternDecl) {
    const local = decl.goPath.startsWith('./') || decl.goPath.startsWith('../');
    const std = !local && !decl.goPath.split('/')[0].includes('.');
    const v = decl.version;
    if (v === null) {
      if (!local && !std) {
        this.error(
          Codes.ExternUnsupported,
          decl.goPathSpan,
          `\`${decl.goPath}\` is not in Go's standard library, so the binding names its version`,
          `as in \`extern "${decl.goPath}@v1.2.3"\`: the version the binding was written against (\`go list -m -versions\` lists them)`,
        );
      }
      return;
    }
    if (local || std) {
      this.error(
        Codes.ExternUnsupported,
        decl.goPathSpan,
        local ? 'a Go package next to the binding has no version' : `\`${decl.goPath}\` comes with Go, so it has no version`,
        `write \`extern "${decl.goPath}"\``,
      );
    } else if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v)) {
      this.error(
        Codes.ExternUnsupported,
        decl.goPathSpan,
        `\`${v}\` is not an exact version`,
        'name one, as in `@v1.2.3`, so every build gets the Go code the binding was written against',
      );
    }
  }

  private externTypeError(span: Span, t: Type) {
    this.error(
      Codes.ExternUnsupported,
      span,
      `a binding cannot pass ${this.show(t)} to or from Go yet`,
      "bindings take and give int, float, string, bool, Bytes, List<string> and the effect's Go types (`type *DB as Db`), take GoError, and give `Result<T, GoError>` for Go functions that return `(T, error)` (`Result<void, GoError>` for just an `error`), and `T?` for `(T, bool)` or a pointer that may be nil; for anything else, write a Go function next to the binding (`extern \"./dir\"`)",
    );
  }

  private declare(decl: SigDecl & Pick<ast.FnDecl, 'nameSpan'>, source: ast.FnDecl | ast.ExternFn): FnSig | null {
    if (!this.nameFree(decl.name, decl.nameSpan)) return null;
    const sig = this.signatureOf(decl, source);
    this.fns.set(decl.name, sig);
    return sig;
  }

  private signatureOf(decl: SigDecl, source: ast.FnDecl | ast.ExternFn): FnSig {
    const typeParamDecls = decl.typeParams ?? [];
    this.checkTypeParams(typeParamDecls);
    const typeParams = typeParamDecls.map((p) => param(p.name));
    this.resolveBounds(typeParamDecls, typeParams);
    return this.withTypeParams(typeParams, () => this.signatureWith(decl, source, typeParams));
  }

  private signatureWith(decl: SigDecl, source: ast.FnDecl | ast.ExternFn, typeParams: ParamType[]): FnSig {
    const params = decl.params.map((p) => ({ name: p.name, type: this.resolveType(p.type) }));
    const ret = this.resolveReturn(decl.returnType);
    const uses: string[] = [];
    const effectParams: string[] = [];
    for (const ref of decl.uses) {
      const name = ref.path.join('.');
      const p = ref.path.length === 1 ? params.find((x) => x.name === name) : undefined;
      if (p) {
        // `uses f`: the parameter's type allows any effect, and a call takes on its argument's.
        if (p.type.kind !== 'fn') {
          if (p.type.kind !== 'error') {
            this.error(
              Codes.BadEffect,
              ref.span,
              `\`uses ${name}\` takes on what the function \`${name}\` does, but \`${name}\` is ${this.show(p.type)}`,
              'name an effect, or a parameter that is a function',
            );
          }
        } else if (effectParams.includes(name)) {
          this.error(Codes.Duplicate, ref.span, `\`${name}\` is listed twice`);
        } else {
          effectParams.push(name);
          p.type = fn(p.type.params, p.type.ret, [...p.type.uses, name]);
        }
        continue;
      }
      if (!this.effectType(name)) {
        this.error(Codes.UnknownEffect, ref.span, `unknown effect \`${name}\``, `known effects: ${this.effectNames().join(', ')}`);
      } else if (uses.includes(name)) {
        this.error(Codes.Duplicate, ref.span, `\`${name}\` is listed twice`);
      } else {
        uses.push(name);
      }
    }
    const type = fn(
      params.map((p) => p.type),
      ret,
      uses,
    );
    return { name: decl.name, params, ret, uses, effectParams, typeParams, type, decl: source };
  }

  /** The effects a name can mean: built in, or a module's own. */
  private effectType(name: string): EffectType | null {
    return builtinEffects.get(name)?.type ?? this.userEffects.get(name)?.type ?? null;
  }

  private effectNames(): string[] {
    return [...builtinEffects.keys(), ...this.userEffects.keys()];
  }

  /** The effect as a `test` block sees it: its operations, plus the fake's own methods. */
  private fakeEffectType(name: string): EffectType {
    const builtin = builtinEffects.get(name);
    if (builtin) return fakeType(builtin);
    const fx = this.userEffects.get(name)!;
    return effect(name, [...fx.type.methods, ...[...fx.steering].map(([n, sig]): [string, FnType] => [n, sig.type])]);
  }

  /** Whether `method` exists only on the fake of effect `name`. */
  private fakeOnly(name: string, method: string): boolean {
    const builtin = builtinEffects.get(name);
    if (builtin) return builtin.fake.methods.some(([n]) => n === method);
    return this.userEffects.get(name)?.steering.has(method) ?? false;
  }

  /** `type *DB as Db` in an effect's `extern` block. */
  private declareOpaques(decl: ast.ExternDecl) {
    for (const item of decl.items) {
      if (item.kind !== 'ExternType') continue;
      this.checkTypeName(item.name, item.nameSpan);
      if (builtinNames.has(item.name) || resolveTypeName(item.name)) {
        this.error(Codes.Duplicate, item.nameSpan, `\`${item.name}\` is built in`, 'give it another name with `as`');
      } else if (this.userTypes.has(item.name) || this.traits.has(item.name) || this.opaques.has(item.name)) {
        this.error(Codes.Duplicate, item.nameSpan, `\`${item.name}\` is already declared`, 'give it another name with `as`');
      } else {
        this.opaques.set(item.name, { kind: 'opaque', name: item.name, module: this.mod.name, goName: item.goName, pointer: item.pointer, goPath: decl.goPath });
      }
    }
  }

  /** `effect http { ... }`: one per module, named after it. */
  private declareEffect(decl: ast.EffectDecl) {
    if (this.effect) {
      this.error(Codes.BadEffect, decl.nameSpan, `module \`${this.mod.name}\` already has an effect`, 'a module declares at most one effect; put another one in a module of its own');
      return;
    }
    if (decl.name !== this.mod.name) {
      this.error(
        Codes.BadEffect,
        decl.nameSpan,
        `an effect is named after its module, so this one is \`${this.mod.name}\`, not \`${decl.name}\``,
        `write \`effect ${this.mod.name}\`, or move it to \`module ${decl.name}\``,
      );
      return;
    }
    if (builtinEffects.has(decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `\`${decl.name}\` is a built-in effect`, 'rename the module');
      return;
    }
    const fx: UserEffect = {
      name: decl.name,
      type: effect(decl.name, []),
      ops: new Map(),
      helpers: new Map(),
      fakeOps: new Map(),
      steering: new Map(),
      state: [],
      ownState: [],
      writers: new Set(),
      decl,
      fake: null,
    };
    this.effect = fx;
    this.userEffects.set(fx.name, fx);
    for (const ext of decl.externs) this.declareOpaques(ext);
    this.inEffectCode = true;
    for (const ext of decl.externs) this.declareExtern(ext, fx.name);
    this.inEffectCode = false;
    for (const op of decl.ops) {
      this.noUses(op);
      if (!this.nameFree(op.name, op.nameSpan)) continue;
      const sig = this.signatureOf({ ...op, uses: [] }, op);
      fx.ops.set(op.name, sig);
      fx.type.methods.set(op.name, sig.type);
    }
    // Helpers may take and give Go's types: only the effect's own code calls them.
    this.inEffectCode = true;
    for (const h of decl.helpers) {
      if (h.uses.length > 0) {
        this.error(Codes.BadEffect, h.uses[0].span, "an effect's helpers cannot use other effects", 'call the other effect from the function that calls the operation');
      }
      const sig = this.declare({ ...h, uses: [] }, h);
      if (!sig) continue;
      sig.privateTo = fx.name;
      fx.helpers.set(h.name, sig);
    }
    this.inEffectCode = false;
  }

  /** Operations work on their own: they can't use other effects, or be generic. */
  private noUses(decl: ast.FnDecl) {
    this.noTypeParams(decl);
    if (decl.uses.length === 0) return;
    this.error(
      Codes.BadEffect,
      decl.uses[0].span,
      "an effect's operations cannot use other effects (its fake's functions can)",
      'call the other effect from the function that calls this one',
    );
  }

  private noTypeParams(decl: ast.FnDecl) {
    if (decl.typeParams.length > 0) {
      this.error(
        Codes.BadEffect,
        decl.typeParams[0].span,
        "an effect's operations and its fake cannot be generic",
        'they become methods of a Go interface, which cannot have type parameters',
      );
    }
  }

  /**
   * A fake's function may use other effects: a fake http sleeping on the fake clock. Not its
   * own, which it stands in for, and not a callback's (`uses f`), which would make it generic.
   */
  private fakeSignature(f: ast.FnDecl, fx: UserEffect): FnSig {
    this.noTypeParams(f);
    const uses = f.uses.filter((ref) => {
      const name = ref.path.join('.');
      if (name === fx.name) {
        this.error(
          Codes.BadEffect,
          ref.span,
          `the fake \`${fx.name}\` stands in for \`${fx.name}\`, so it cannot use it`,
          'call its own functions directly, or keep what they share in its state',
        );
        return false;
      }
      if (ref.path.length === 1 && f.params.some((p) => p.name === name)) {
        this.error(
          Codes.BadEffect,
          ref.span,
          `a fake's function cannot take on a callback's effects with \`uses ${name}\``,
          `name the effects in the parameter's type instead: \`${name}: fn(...) -> ... uses clock\``,
        );
        return false;
      }
      return true;
    });
    return this.signatureOf({ ...f, uses }, f);
  }

  /** `fake http { ... }`: every operation, with the same signature, plus test-only methods. */
  private declareFake(decl: ast.FakeDecl) {
    const fx = this.effect;
    if (!fx || fx.name !== decl.name) {
      this.error(
        Codes.BadEffect,
        decl.nameSpan,
        `there is no \`effect ${decl.name}\` in this module to fake`,
        fx ? `this module's effect is \`${fx.name}\`` : 'a fake sits next to the effect it stands in for',
      );
      return;
    }
    if (fx.fake) {
      this.error(Codes.BadEffect, decl.nameSpan, `effect \`${fx.name}\` already has a fake`);
      return;
    }
    fx.fake = decl;
    for (const f of decl.fns) {
      const op = fx.ops.get(f.name);
      if (!op && fx.helpers.has(f.name)) {
        this.error(
          Codes.BadEffect,
          f.nameSpan,
          `\`${f.name}\` is a helper of \`effect ${fx.name}\`, not an operation, so the fake has nothing to stand in for`,
          `make it an operation with \`pub fn ${f.name}\` in the effect, or rename this test-only function`,
        );
        continue;
      }
      if (!op) {
        if (!this.nameFree(f.name, f.nameSpan)) continue;
        fx.steering.set(f.name, this.fakeSignature(f, fx));
        continue;
      }
      if (fx.fakeOps.has(f.name)) {
        this.error(Codes.Duplicate, f.nameSpan, `\`${f.name}\` is already defined`);
        continue;
      }
      const sig = this.fakeSignature(f, fx);
      const generic = sig.typeParams.length > 0 || op.typeParams.length > 0; // reported already
      // What it uses is the fake's business: callers of the operation don't see it.
      const shape = fn(sig.type.params, sig.ret, []);
      if (!generic && !sameType(shape, op.type) && sig.type.params.every((p) => p.kind !== 'error') && sig.ret.kind !== 'error') {
        this.error(
          Codes.TypeMismatch,
          f.nameSpan,
          `the fake's \`${f.name}\` must have the operation's signature: expected ${this.show(op.type)}, found ${this.show(shape)}`,
        );
      }
      fx.fakeOps.set(f.name, sig);
    }
    const missing = [...fx.ops.keys()].filter((n) => !fx.fakeOps.has(n));
    if (missing.length > 0) {
      this.error(
        Codes.BadEffect,
        decl.nameSpan,
        `the fake \`${fx.name}\` has no ${missing.map((n) => `\`${n}\``).join(', ')}`,
        'a fake stands in for every operation',
      );
    }
  }

  /** The operations' bodies, then the fake's state and functions. */
  private checkEffect(fx: UserEffect) {
    this.inEffectCode = true;
    const own = this.checkState(fx.decl.state, `effect ${fx.name}`, fx.decl.nameSpan, fx.decl.span, fx.ownState);
    // Which operations change the state: those run one at a time (see `effectDecl`).
    const written = new Set<string>();
    this.inOps = fx.name;
    for (const sig of fx.ops.values()) {
      for (const b of own.values()) b.mutated = false;
      this.checkBody(sig, sig.decl as ast.FnDecl, own);
      const changed = [...own].filter(([, b]) => b.mutated).map(([n]) => n);
      if (changed.length > 0) fx.writers.add(sig.name);
      for (const n of changed) written.add(n);
    }
    for (const [n, b] of own) b.mutated = written.has(n);
    // Helpers see no state: each operation holds it, under its own lock, so it is passed in.
    this.helperOf = fx;
    for (const sig of fx.helpers.values()) this.checkBody(sig, sig.decl as ast.FnDecl, new Map());
    this.helperOf = null;
    this.inOps = null;
    this.inEffectCode = false;
    this.stateWarnings(own, 'no operation reads it');
    const fake = fx.fake;
    if (!fake) {
      this.error(
        Codes.BadEffect,
        fx.decl.nameSpan,
        `effect \`${fx.name}\` has no fake`,
        `tests always run against fakes: add \`fake ${fx.name} { ... }\` with every operation`,
      );
      return;
    }
    const state = this.checkState(fake.state, `fake ${fx.name}`, fake.nameSpan, fake.span, fx.state);
    for (const sig of [...fx.fakeOps.values(), ...fx.steering.values()]) this.checkBody(sig, sig.decl as ast.FnDecl, state);
    this.stateWarnings(state, 'no function of the fake reads it');
  }

  /** An effect's or a fake's state: checked like the start of a function with no effects and no parameters. */
  private checkState(stmts: ast.LetStmt[], name: string, nameSpan: Span, span: Span, into: StateVar[]): Map<string, Binding> {
    const body: ast.Block = { kind: 'Block', stmts, span };
    const decl: ast.FnDecl = { kind: 'FnDecl', pub: null, name, nameSpan, typeParams: [], params: [], returnType: null, uses: [], contracts: [], body, span };
    this.fn = { name, params: [], ret: T.unit, uses: [], effectParams: [], typeParams: [], type: fn([], T.unit), decl };
    const state = new Map<string, Binding>();
    this.scopes = [new Map(), state];
    this.facts = new Set();
    for (const s of stmts) {
      this.checkStmt(s);
      const b = state.get(s.name);
      if (b) into.push({ name: s.name, type: b.type, mutable: s.mutable, decl: s });
    }
    for (const b of state.values()) b.used = false;
    return state;
  }

  private stateWarnings(state: Map<string, Binding>, unread: string) {
    for (const [name, b] of state) {
      if (b.decl?.kind !== 'Let' || b.type.kind === 'error') continue;
      if (!b.used) this.warn(Codes.UnusedVariable, b.decl.nameSpan, `\`${name}\` is never used`, unread);
      else if (b.mutable && !b.mutated) this.warn(Codes.NeedlessMut, b.decl.nameSpan, `\`${name}\` never changes`, 'declare it with `let`, without `mut`');
    }
  }

  private checkFn(decl: ast.FnDecl) {
    const sig = this.fns.get(decl.name);
    if (!sig || sig.decl !== decl) return; // a duplicate; already reported
    this.checkBody(sig, decl, null);
  }

  private checkTestFn(decl: ast.FnDecl) {
    if (decl.name === 'main') {
      this.error(Codes.FakeOnly, decl.test!, '`main` cannot be a `test fn`: only `candor test` builds those', 'drop `test`');
    }
    this.checkFn(decl);
  }

  /** `outer`: a fake's state, visible to its functions. */
  private checkBody(sig: FnSig, decl: ast.FnDecl, outer: Map<string, Binding> | null) {
    this.withTypeParams(sig.typeParams, () => this.checkBodyWith(sig, decl, outer));
  }

  private checkBodyWith(sig: FnSig, decl: ast.FnDecl, outer: Map<string, Binding> | null) {
    this.fn = sig;
    this.effectParamsUsed = new Set();
    const top = new Map<string, Binding>();
    this.scopes = outer ? [top, outer, new Map()] : [top];
    this.facts = new Set();
    // A `test fn` works on the test's fakes, as the test itself does.
    const test = decl.test !== undefined;
    for (const name of sig.uses) {
      top.set(name, { kind: 'effect', type: test ? this.fakeEffectType(name) : this.effectType(name)!, used: false });
    }
    this.inTest = test;
    this.testSide = test || decl.span.start.line > this.testsFrom;
    decl.params.forEach((p, i) => {
      // Unused parameters are allowed: they are part of the signature, not a slip.
      this.bind(p.name, { kind: 'local', type: sig.params[i].type, used: true }, p.span);
    });
    if (outer) this.refuseContracts(decl);
    else this.checkContracts(sig, decl);

    const returnsValue = sig.ret.kind !== 'unit';
    this.body = decl.body;
    const body = this.checkBlock(decl.body, returnsValue ? 'tail' : 'statement');
    this.body = null;
    this.inTest = false;
    if (returnsValue && !body.diverges) {
      const endsInValue = body.type.kind !== 'unit' && body.type.kind !== 'error' && sameType(body.type, sig.ret);
      this.error(
        Codes.MissingReturn,
        decl.nameSpan,
        `\`${decl.name}\` returns ${this.show(sig.ret)} but not every path ends in \`return\``,
        endsInValue
          ? 'add `return` before the last expression: a function body does not yield its last expression, only `if` and `match` branches do'
          : undefined,
      );
    }
    for (const ref of decl.uses) {
      const name = ref.path.join('.');
      if (sig.effectParams.includes(name) && !this.effectParamsUsed.has(name)) {
        this.warn(Codes.UnusedEffect, ref.span, `\`${decl.name}\` declares \`uses ${name}\` but never calls \`${name}\``, 'remove it from the `uses` clause');
      }
      const b = top.get(name);
      if (b?.kind === 'effect' && !b.used) {
        this.warn(
          Codes.UnusedEffect,
          ref.span,
          `\`${decl.name}\` declares \`uses ${name}\` but never uses it`,
          'remove it from the `uses` clause',
        );
      }
    }
  }

  /**
   * Each clause is a bool over the parameters, and `result` in an `ensures`. They are checked
   * as a function of their own: no effects in scope, nothing to return from.
   */
  private checkContracts(sig: FnSig, decl: ast.FnDecl) {
    if (decl.contracts.length === 0) return;
    const saved = { fn: this.fn, scopes: this.scopes, facts: this.facts };
    const params = new Map<string, Binding>();
    decl.params.forEach((p, i) => params.set(p.name, { kind: 'local', type: sig.params[i].type, used: true }));
    const results = new Map<string, Binding>();
    const ensures = decl.contracts.find((c) => c.clause === 'ensures');
    if (ensures && sig.ret.kind === 'unit') {
      this.error(
        Codes.BadContract,
        ensures.keywordSpan,
        `\`${decl.name}\` returns nothing, so its \`ensures\` has nothing to check`,
        'parameters never change, so a promise about them is a `requires`; or give the function a result',
      );
    } else if (ensures && params.has('result')) {
      const p = decl.params.find((q) => q.name === 'result')!;
      this.error(Codes.BadContract, p.span, 'a function with an `ensures` cannot name a parameter `result`', 'rename the parameter: in an `ensures`, `result` is the value the function returns');
    } else {
      results.set('result', { kind: 'local', type: sig.ret, used: true });
    }
    this.fn = { ...sig, uses: [], effectParams: [] };
    for (const c of decl.contracts) {
      this.contract = c;
      this.scopes = [c.clause === 'ensures' ? new Map([...params, ...results]) : params];
      this.facts = new Set();
      const t = this.checkExpr(c.expr);
      if (t.kind !== 'bool' && t.kind !== 'error') {
        this.error(Codes.ConditionNotBool, c.expr.span, `\`${c.clause}\` needs a bool, found ${this.show(t)}`);
      }
    }
    this.contract = null;
    ({ fn: this.fn, scopes: this.scopes, facts: this.facts } = saved);
  }

  /** Effect operations and fakes take no contracts yet. */
  private refuseContracts(decl: ast.FnDecl) {
    const c = decl.contracts[0];
    if (!c) return;
    this.error(
      Codes.BadContract,
      c.keywordSpan,
      `\`${decl.name}\` is a function of an effect or a fake, which take no \`${c.clause}\` yet`,
      'check the condition in a function that calls the operation, and put the contract there',
    );
  }

  /** A test is checked like a function that returns nothing and has every effect, all of them fakes. */
  private checkTest(decl: ast.TestDecl) {
    if (this.tests.some((t) => t.name === decl.name)) {
      this.error(Codes.Duplicate, decl.nameSpan, `there is already a test named ${JSON.stringify(decl.name)}`);
    } else {
      this.tests.push(decl);
    }
    const name = `test ${JSON.stringify(decl.name)}`;
    const uses = this.effectNames();
    const fnDecl: ast.FnDecl = {
      kind: 'FnDecl',
      pub: null,
      name,
      nameSpan: decl.nameSpan,
      typeParams: [],
      params: [],
      returnType: null,
      uses: [],
      contracts: [],
      body: decl.body,
      span: decl.span,
    };
    this.fn = { name, params: [], ret: T.unit, uses, effectParams: [], typeParams: [], type: fn([], T.unit, uses), decl: fnDecl };
    const top = new Map<string, Binding>();
    for (const effectName of uses) top.set(effectName, { kind: 'effect', type: this.fakeEffectType(effectName), used: true });
    this.scopes = [top];
    this.facts = new Set();
    this.inTest = true;
    this.testSide = true;
    this.body = decl.body;
    this.checkBlock(decl.body, 'statement');
    this.body = null;
    this.inTest = false;
  }

  /** `expected`: the type the block's value must have, when the context says (value mode only). */
  private checkBlock(block: ast.Block, mode: BlockMode, expected?: Type): BlockResult {
    // In a lambda nothing has said the result of, `return match ...` whose arms each say half
    // (`Err(...)`, `Ok(...)`) becomes a `match` whose arms return, as for a body that is one.
    if (this.lambda && this.lambda.ret === null) {
      block.stmts.forEach((s, i) => {
        if (s.kind === 'Return' && (s.value?.kind === 'If' || s.value?.kind === 'Match') && returnsInBranches(s.value)) {
          block.stmts[i] = { kind: 'ExprStmt', expr: s.value, span: s.span };
        }
      });
    }
    this.scopes.push(new Map());
    let type: Type = T.unit;
    let diverges = false;
    block.stmts.forEach((stmt, i) => {
      const last = i === block.stmts.length - 1;
      const isValue =
        last &&
        mode !== 'statement' &&
        stmt.kind === 'ExprStmt' &&
        // In a function's tail, `if c { return 1 }` is a statement that fails to return on every path.
        !(mode === 'tail' && stmt.expr.kind === 'If' && stmt.expr.else === null);
      if (isValue && stmt.kind === 'ExprStmt') {
        const e = stmt.expr;
        if (expected) type = this.checkAgainst(e, expected);
        else if (e.kind === 'If') type = this.checkIf(e, mode);
        else if (e.kind === 'Match') type = this.checkMatch(e, mode);
        else type = this.checkExpr(e);
      } else {
        this.checkStmt(stmt);
      }
      if (last) {
        diverges =
          stmt.kind === 'Return' ||
          // Card 158: leaving the loop leaves the arm too: `Err(_) => continue`.
          stmt.kind === 'Break' ||
          stmt.kind === 'Continue' ||
          // `while true` without a `break` leaves only by `return`.
          (stmt.kind === 'While' && stmt.cond.kind === 'Bool' && stmt.cond.value && !breaks(stmt.body)) ||
          (stmt.kind === 'ExprStmt' &&
            (stmt.expr.kind === 'If' || stmt.expr.kind === 'Match') &&
            this.divergent.has(stmt.expr));
      }
    });
    this.popScope();
    return { type, diverges };
  }

  private checkIf(e: ast.If, mode: BlockMode, expected?: Type): Type {
    const t = this.ifType(e, mode, expected);
    this.types.set(e, t);
    return t;
  }

  private ifType(e: ast.If, mode: BlockMode, expected?: Type): Type {
    const cond = this.checkExpr(e.cond);
    if (cond.kind !== 'bool' && cond.kind !== 'error') {
      const example = cond.kind === 'int' ? 'n != 0' : cond.kind === 'string' ? 's != ""' : null;
      this.error(
        Codes.ConditionNotBool,
        e.cond.span,
        `condition must be bool, found ${this.show(cond)}`,
        example ? `there is no truthiness; compare explicitly, as in \`${example}\`` : undefined,
      );
    }
    const proved = this.proves(e.cond);
    const before = this.facts;
    if (mode === 'value' && !expected) this.markEmpty([e.then, ...(e.else?.kind === 'Block' ? [e.else] : [])]);
    this.facts = withAll(before, proved.yes);
    const then = this.checkBlock(e.then, mode, expected);
    const afterThen = this.facts;
    this.facts = withAll(before, proved.no);
    if (e.else === null) {
      // After `if x == none { return }`, `x` is present.
      if (!exits(e.then)) this.facts = intersect(afterThen, this.facts);
      if (mode !== 'value') return T.unit;
      this.error(Codes.MissingElse, e.keywordSpan, '`if` without `else` has no value', 'add an `else` branch');
      return T.error;
    }
    const other: BlockResult =
      e.else.kind === 'If'
        ? { type: this.checkIf(e.else, mode, expected), diverges: false }
        : this.checkBlock(e.else, mode, expected);
    if (e.else.kind === 'If') other.diverges = this.divergent.has(e.else);
    const elseExits = e.else.kind === 'If' ? exprExits(e.else) : exits(e.else);
    if (elseExits) this.facts = afterThen;
    else if (!exits(e.then)) this.facts = intersect(afterThen, this.facts);

    if (then.diverges && other.diverges) {
      this.divergent.add(e);
      if (mode !== 'value') return T.unit;
      this.error(
        Codes.NoValue,
        e.keywordSpan,
        'every branch of this `if` returns, breaks or continues, so it has no value',
        'use it as a statement',
      );
      return T.error;
    }
    if (mode === 'statement') return T.unit;
    if (expected) return expected;
    const elseValue = e.else.kind === 'If' ? e.else : valueExpr(e.else);
    return this.join(
      [
        { ...then, value: valueExpr(e.then) },
        { ...other, value: elseValue },
      ],
      (a, b) => [e.keywordSpan, `the branches of this \`if\` have different types: ${a} and ${b}`],
    );
  }

  /**
   * The common type of branch values: equal types, or `T`, `none` and `T?` mixed, which makes
   * `T?` (the plain values are then wrapped). Branches that return don't take part.
   */
  private join(
    branches: (BlockResult & { value: ast.Expr | null })[],
    mismatch: (a: string, b: string, i: number) => [Span, string],
  ): Type {
    // Card 148: a `[]` or `[:]` branch takes its type from the others.
    const open = (b: { value: ast.Expr | null }) => b.value !== null && this.waiting.has(b.value);
    const live = branches.filter((b) => !b.diverges && b.type.kind !== 'error' && !open(b));
    const empties = branches.filter((b) => !b.diverges && open(b));
    if (live.length === 0 && empties.length > 0 && !branches.some((b) => !b.diverges && b.type.kind === 'error')) {
      // One error: annotating the whole fixes every branch.
      for (const b of empties) this.waiting.delete(b.value!);
      this.stillEmpty(empties[0].value!);
      return T.error;
    }
    // A branch whose type isn't known, after an error, leaves the whole one unknown.
    if (live.length === 0 || branches.some((b) => !b.diverges && b.type.kind === 'error')) {
      for (const b of empties) this.waiting.delete(b.value!);
      return T.error;
    }
    let joined = live[0].type;
    for (const [i, b] of branches.entries()) {
      if (b.diverges || b.type.kind === 'error' || open(b)) continue;
      // `none` isn't assignable to itself (only to optionals), and joined starts as live[0].
      if (b.type.kind === 'none' && joined.kind === 'none') continue;
      if (assignable(b.type, joined)) continue;
      if (assignable(joined, b.type)) {
        joined = b.type;
      } else if (joined.kind === 'none' && b.type.kind !== 'option') {
        joined = { kind: 'option', inner: b.type };
      } else if (b.type.kind === 'none' && joined.kind !== 'option') {
        joined = { kind: 'option', inner: joined };
      } else {
        const [span, message] = mismatch(this.show(joined), this.show(b.type), i);
        this.error(Codes.BranchMismatch, span, message);
        return T.error;
      }
    }
    for (const b of live) if (b.value) this.coerce(b.value, b.type, joined);
    for (const b of empties) {
      const value = b.value!;
      this.waiting.delete(value);
      const shape = joined.kind === 'option' ? joined.inner : joined;
      if (value.kind === 'ListLit' ? shape.kind !== 'list' : shape.kind !== 'map') {
        const [span, message] = mismatch(this.show(joined), value.kind === 'ListLit' ? 'a list' : 'a map', branches.indexOf(b));
        this.error(Codes.BranchMismatch, span, message);
        return T.error;
      }
      this.types.set(value, shape);
      this.coerce(value, shape, joined);
    }
    return joined;
  }

  /** Card 148: the empty literals among `blocks`' values, to wait for their branches' types. */
  private markEmpty(blocks: ast.Block[]) {
    for (const b of blocks) {
      const v = valueExpr(b);
      if ((v?.kind === 'ListLit' && v.items.length === 0) || (v?.kind === 'MapLit' && v.entries.length === 0)) this.emptyBranches.add(v);
    }
  }

  /** An empty literal nothing gave a type to. */
  private stillEmpty(e: ast.Expr) {
    this.waiting.delete(e);
    if (e.kind === 'MapLit') this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this empty map holds', 'annotate it: `let m: Map<string, int> = [:]`');
    else this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this empty list holds', 'annotate it: `let xs: List<int> = []`');
  }

  private checkMatch(e: ast.Match, mode: BlockMode, expected?: Type): Type {
    const t = this.matchType(e, mode, expected);
    this.types.set(e, t);
    return t;
  }

  private matchType(e: ast.Match, mode: BlockMode, expected?: Type): Type {
    const subject = this.checkExpr(e.subject);
    if (e.arms.length === 0) {
      if (!e.dropped) this.error(Codes.NonExhaustive, e.keywordSpan, '`match` needs at least one arm');
      return T.error;
    }
    let patternsOk = true;
    const before = this.facts;
    const ends: Facts[] = [];
    // On a `T?` local, an arm proves it present when its pattern matches only present values, or
    // when a `none` arm above took absence: `match x { none => return, _ => {} }` narrows `x`.
    const path = subject.kind === 'option' ? this.localPath(e.subject) : null;
    const present = path === null ? new Set<string>() : new Set([path]);
    let noneTaken = false;
    // Each arm's rows, for deciding what a name on a `T?` takes; null once an arm is broken.
    let rows: Pat[][] | null = subject.kind === 'error' ? null : [];
    if (mode === 'value' && !expected) this.markEmpty(e.arms.map((a) => a.body));
    const results = e.arms.map((arm) => {
      const proves = noneTaken || arm.patterns.every((p) => p.kind !== 'None' && p.kind !== 'Wildcard' && p.kind !== 'Binding');
      this.facts = proves ? withAll(before, present) : before;
      this.scopes.push(new Map());
      // `t => Ok(t)` on a `t: Todo?`: the arm's `t` is the present value, the one name it may reuse.
      this.rebindable = e.subject.kind === 'Ident' ? e.subject.name : null;
      this.rebound = false;
      const armOk = this.checkArmPatterns(arm, subject, rows);
      patternsOk = armOk && patternsOk;
      if (rows !== null && armOk) for (const p of arm.patterns) rows.push([this.toPat(p, subject)]);
      else rows = null;
      this.rebindable = null;
      const rebound = this.rebound;
      const r = this.checkBlock(arm.body, mode, expected);
      this.popScope();
      // The arm's own `t` took the facts about `t` with it, but hid the subject, which is unchanged.
      if (!exits(arm.body)) ends.push(proves && rebound ? withAll(this.facts, present) : this.facts);
      if (arm.patterns.some((p) => p.kind === 'None')) noneTaken = true;
      return r;
    });
    this.facts = ends.length === 0 ? before : ends.reduce(intersect);
    // With an arm left out for a syntax error, coverage and the match's type are unknown.
    if (e.dropped) return mode === 'statement' ? T.unit : T.error;
    // A broken pattern would make coverage wrong; it is reported already.
    if (subject.kind !== 'error' && patternsOk) this.checkCoverage(e, subject);

    if (results.every((r) => r.diverges)) {
      this.divergent.add(e);
      if (mode !== 'value') return T.unit;
      this.error(
        Codes.NoValue,
        e.keywordSpan,
        'every arm of this `match` returns, breaks or continues, so it has no value',
        'use it as a statement',
      );
      return T.error;
    }
    if (mode === 'statement') return T.unit;
    if (expected) return expected;
    return this.join(
      results.map((r, i) => ({ ...r, value: valueExpr(e.arms[i].body) })),
      (a, b, i) => [e.arms[i].patternSpan, `the arms of this \`match\` have different types: ${a} and ${b}`],
    );
  }

  private checkCoverage(e: ast.Match, t: Type) {
    const rows: Pat[][] = [];
    for (const arm of e.arms) {
      // Each of an arm's patterns is a row of its own.
      for (const [i, pattern] of arm.patterns.entries()) {
        const p = this.toPat(pattern, t);
        if (rows.length > 0 && !useful(rows, [p], [t])) {
          if (arm.patterns.length === 1 && pattern.kind === 'None') {
            this.warn(
              Codes.UnreachableArm,
              pattern.span,
              'this arm can never match: the arms above cover `none`',
              'a name or `_` above takes the whole optional, `none` included: move this arm above it (a name after a `none` arm takes the present value), or remove it',
            );
          } else if (arm.patterns.length === 1) {
            this.warn(Codes.UnreachableArm, pattern.span, 'this arm can never match: the arms above cover it', 'remove it, or move it above the arm that covers it');
          } else {
            this.warn(Codes.UnreachableArm, pattern.span, `this pattern can never match: ${i === 0 ? 'the arms above cover' : 'the patterns before it cover'} it`, 'remove it');
          }
        }
        rows.push([p]);
      }
    }
    // Each missing case found is added as a row, so the next search finds a different one.
    const missing: string[] = [];
    for (let w = useful(rows, [wild], [t]); w && missing.length < 8; w = useful(rows, [wild], [t])) {
      missing.push(formatWitness(w[0], t));
      rows.push(w);
    }
    if (missing.length === 0) return;
    if (missing.length === 1 && missing[0] === '_') {
      this.error(
        Codes.NonExhaustive,
        e.keywordSpan,
        `this \`match\` does not cover every ${this.show(t)}`,
        'add a final `_ =>` arm',
      );
      return;
    }
    const list = missing.map((m) => `\`${m}\``);
    const listed = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    this.error(
      Codes.NonExhaustive,
      e.keywordSpan,
      `this \`match\` does not cover ${listed}`,
      `add ${missing.length === 1 ? 'an arm' : 'arms'} for ${missing.length === 1 ? 'it' : 'them'}, or a final \`_ =>\` arm`,
    );
  }

  /**
   * An arm's patterns. With several, each is checked apart, and each must bind the same names with
   * the same types: the arm's scope gets the first one's, and the others' are its twins.
   */
  private checkArmPatterns(arm: ast.Arm, t: Type, above: Pat[][] | null): boolean {
    // The rows before each pattern: the arms above, then this arm's patterns before it.
    const rows = above === null ? null : [...above];
    const one = (p: ast.Pattern) => {
      this.unsettled = [];
      const ok = this.checkPattern(p, t);
      const names = this.unsettled;
      this.unsettled = null;
      if (!ok || rows === null) return ok;
      for (const n of names) this.settleName(n.p, n.t, p, t, rows);
      rows.push([this.toPat(p, t)]);
      return ok;
    };
    if (arm.patterns.length === 1) return one(arm.patterns[0]);
    let ok = true;
    const scopes = arm.patterns.map((p) => {
      this.scopes.push(new Map());
      ok = one(p) && ok;
      return this.scopes.pop()!;
    });
    const [first, ...rest] = scopes;
    const quoted = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');
    rest.forEach((s, i) => {
      const p = arm.patterns[i + 1];
      const missing = [...first.keys()].filter((n) => !s.has(n));
      const extra = [...s.keys()].filter((n) => !first.has(n));
      if (missing.length > 0 || extra.length > 0) {
        ok = false;
        this.error(
          Codes.OrBindings,
          p.span,
          missing.length > 0 ? `this pattern does not bind ${quoted(missing)}, which the first one does` : `this pattern binds ${quoted(extra)}, which the first one does not`,
          'every pattern of an arm binds the same names, so the arm can use them whichever matched; match the rest with `_`, or give it an arm of its own',
        );
        return;
      }
      for (const [name, b] of s) {
        const a = first.get(name)!;
        if (a.type.kind === 'error' || b.type.kind === 'error' || sameType(a.type, b.type)) continue;
        ok = false;
        this.error(
          Codes.TypeMismatch,
          (b.decl as ast.BindingPattern).span,
          `\`${name}\` is ${this.show(b.type)} here, but ${this.show(a.type)} in the first pattern`,
          'every pattern of an arm gives its names the same types; give this one an arm of its own',
        );
      }
    });
    const scope = this.scopes.at(-1)!;
    for (const [name, b] of first) {
      const twins = rest.flatMap((s) => (s.get(name)?.decl ? [s.get(name)!.decl as ast.BindingPattern] : []));
      scope.set(name, { ...b, twins });
    }
    return ok;
  }

  /** Help for a `T?` used as its `T`: check it, default it, or for a name from an arm, take `none` above. */
  private optionalHelp(e: ast.Expr): string {
    const x = e.kind === 'Ident' || e.kind === 'Member' ? exprText(e) : 'x';
    const b = e.kind === 'Ident' ? this.lookup(e.name) : undefined;
    if (b && b.kind === 'local' && b.decl?.kind === 'Binding' && this.armNames.has(b.decl)) {
      return `a name in a pattern takes the whole optional, \`none\` included: put an arm for \`none\` above this one (then \`${x}\` is the present value here), or use \`${x} ?? fallback\``;
    }
    return `\`${x}\` may be \`none\`: check \`if ${x} != none { ... }\` first, or use \`${x} ?? fallback\``;
  }

  /**
   * A name on a `T?` in an arm's pattern takes the present value when the rows above cover
   * `none` in its place (`{ expect: none } => ..., { expect } => ...`), else the whole value.
   */
  private settleName(name: ast.BindingPattern, t: Type & { kind: 'option' }, pattern: ast.Pattern, whole: Type, rows: Pat[][]) {
    if (rows.length === 0 || useful(rows, [this.toPat(pattern, whole, name)], [whole])) return;
    this.presentBindings.add(name);
    const scope = this.scopes.at(-1)!;
    const b = scope.get(name.name);
    if (b && b.decl === name) scope.set(name.name, { ...b, type: t.inner });
  }

  /**
   * The pattern as constructors and wildcards, for `useful`. Only called once patterns checked
   * out. `asNone`: a name read as `none`, to ask whether the arms above cover that.
   */
  private toPat(p: ast.Pattern, t: Type, asNone?: ast.BindingPattern): Pat {
    if (t.kind === 'option') {
      if (p.kind === 'Wildcard') return wild;
      if (p.kind === 'None' || p === asNone) return { kind: 'ctor', ctor: { kind: 'variant', index: 0 }, args: [] };
      // A name takes the whole value, unless the arms above took `none` there.
      if (p.kind === 'Binding' && !this.presentBindings.has(p)) return wild;
      // Any other pattern on a `T?` matches a present value; a name matches every present value.
      const inner = p.kind === 'Binding' ? wild : this.toPat(p, t.inner, asNone);
      return { kind: 'ctor', ctor: { kind: 'variant', index: 1 }, args: [inner] };
    }
    switch (p.kind) {
      case 'Wildcard':
      case 'Binding':
      case 'None':
        return wild;
      case 'Result': {
        if (t.kind !== 'result') return wild;
        const inner = this.toPat(p.inner, p.variant === 'Ok' ? t.ok : t.err, asNone);
        return { kind: 'ctor', ctor: { kind: 'variant', index: p.variant === 'Ok' ? 0 : 1 }, args: [inner] };
      }
      case 'Tuple':
        if (t.kind !== 'tuple') return wild;
        return { kind: 'ctor', ctor: { kind: 'tuple' }, args: p.items.map((x, i) => this.toPat(x, t.elems[i], asNone)) };
      case 'Literal':
        if (p.value.kind === 'Bool') return { kind: 'ctor', ctor: { kind: 'bool', value: p.value.value }, args: [] };
        return { kind: 'ctor', ctor: { kind: 'literal', value: literalKey(p) }, args: [] };
      case 'Ctor': {
        const target = this.patterns.get(p)!;
        const fields = target.kind === 'struct' ? target.type.fields : target.variant.fields;
        const args = fields.map((f) => {
          const fp = p.fields.find((x) => x.name === f.name);
          return fp ? this.toPat(fp.pattern, f.type, asNone) : wild;
        });
        return {
          kind: 'ctor',
          ctor: target.kind === 'struct' ? { kind: 'struct' } : { kind: 'variant', index: target.variant.index },
          args,
        };
      }
    }
  }

  /** Checks `p` against the matched type and binds its names. False if it is broken. */
  private checkPattern(p: ast.Pattern, t: Type): boolean {
    // On a `T?`, every pattern but `none`, `_` and a name is about the present value. A name
    // takes the whole value, or, in a `match` arm whose arms above took `none` there, the present
    // one: `settleName` decides once the arm's pattern is checked.
    if (t.kind === 'option' && p.kind !== 'None' && p.kind !== 'Wildcard' && p.kind !== 'Binding') return this.checkPattern(p, t.inner);
    switch (p.kind) {
      case 'Wildcard':
        return true;
      case 'None':
        if (t.kind === 'error' || t.kind === 'option') return true;
        this.error(
          Codes.TypeMismatch,
          p.span,
          `\`none\` only matches optional values, but the value matched is ${this.show(t)}`,
        );
        return false;
      case 'Result':
        if (t.kind === 'result' && p.bare && t.ok.kind !== 'unit' && t.ok.kind !== 'error') {
          this.error(Codes.TypeMismatch, p.span, `\`Ok()\` matches a Result<void, E>, but the value matched is ${this.show(t)}`, 'write `Ok(x)`, or `Ok(_)`');
          return false;
        }
        if (t.kind === 'result') return this.checkPattern(p.inner, p.variant === 'Ok' ? t.ok : t.err);
        if (t.kind !== 'error') {
          this.error(
            Codes.TypeMismatch,
            p.span,
            `\`${p.variant}(...)\` matches a Result, but the value matched is ${this.show(t)}`,
          );
        }
        this.bindAsError(p.inner);
        return t.kind === 'error';
      case 'Binding':
        if (this.unsettled !== null) this.armNames.add(p);
        if (t.kind === 'option' && this.unsettled !== null) this.unsettled.push({ p, t });
        this.bind(p.name, { kind: 'local', type: t, used: false, decl: p }, p.span);
        return true;
      case 'Tuple': {
        if (t.kind === 'tuple' && t.elems.length === p.items.length) {
          let ok = true;
          p.items.forEach((x, i) => (ok = this.checkPattern(x, t.elems[i]) && ok));
          return ok;
        }
        if (t.kind !== 'error') {
          this.error(
            Codes.TypeMismatch,
            p.span,
            t.kind === 'tuple'
              ? `this pattern has ${p.items.length} parts, but the value matched is ${this.show(t)}`
              : `\`(...)\` matches a tuple, but the value matched is ${this.show(t)}`,
          );
        }
        this.bindAsError(p);
        return t.kind === 'error';
      }
      case 'Literal': {
        const lt = p.value.kind === 'String' ? T.string : p.value.kind === 'Int' ? T.int : p.value.kind === 'Char' ? T.char : T.bool;
        if (p.value.kind === 'Int') {
          const v = BigInt(literalKey(p));
          if (v < INT_MIN || v > INT_MAX) {
            this.error(Codes.IntegerOverflow, p.span, `${v} does not fit in int (64-bit)`);
            return false;
          }
        }
        if (!sameType(lt, t)) {
          this.error(
            Codes.TypeMismatch,
            p.span,
            `this pattern is ${this.show(lt)}, but the value matched is ${this.show(t)}`,
          );
          return false;
        }
        return true;
      }
      case 'Ctor': {
        let target = p.short ? this.resolveShort(p, t) : this.resolveCtor(p.path, p.pathSpan);
        if (!target) {
          this.bindAsError(p);
          return false;
        }
        const origin = t.kind === 'struct' || t.kind === 'enum' ? t.origin : null;
        if (t.kind !== 'error' && target.type !== origin) {
          this.error(
            Codes.TypeMismatch,
            p.pathSpan,
            `this pattern matches ${target.type.name}, but the value matched is ${this.show(t)}`,
          );
          this.bindAsError(p);
          return false;
        }
        // On a `Tree<int>`, the fields are the `Tree<int>`'s.
        if (t.kind === 'struct' || t.kind === 'enum') target = withType(target, t);
        this.patterns.set(p, target);
        const fields = target.kind === 'struct' ? target.type.fields : target.variant.fields;
        let ok = true;
        const seen = new Set<string>();
        for (const fp of p.fields) {
          const field = fields.find((f) => f.name === fp.name);
          if (!field) {
            this.unknownField(target, fp.name, fp.nameSpan);
            this.bindAsError(fp.pattern);
            ok = false;
          } else if (seen.has(fp.name)) {
            this.error(Codes.Duplicate, fp.nameSpan, `field \`${fp.name}\` is matched twice`);
            ok = false;
          } else {
            seen.add(fp.name);
            if (target.kind === 'struct') this.fieldVisible(target.type, field, fp.nameSpan);
            ok = this.checkPattern(fp.pattern, field.type) && ok;
          }
        }
        return ok;
      }
    }
  }

  /** Binds every name in a broken pattern, so uses of them don't cascade into more errors. */
  private bindAsError(p: ast.Pattern) {
    if (p.kind === 'Binding') this.bind(p.name, { kind: 'local', type: T.error, used: true }, p.span);
    if (p.kind === 'Ctor') for (const f of p.fields) this.bindAsError(f.pattern);
    if (p.kind === 'Result') this.bindAsError(p.inner);
    if (p.kind === 'Tuple') for (const x of p.items) this.bindAsError(x);
  }

  /**
   * `let (a, b) = ...` and `for (k, v) in ...`: the pattern must match every value, as there is
   * no other arm to go to. A name takes its part whole, `T?` included, as in a `match` with no
   * arm above taking `none`.
   */
  private destructure(p: ast.Pattern, t: Type, what: string) {
    if (this.checkPattern(p, t)) this.checkIrrefutable(p, t, what);
  }

  private checkIrrefutable(p: ast.Pattern, t: Type, what: string) {
    if (t.kind === 'error') return;
    const w = useful([[this.toPat(p, t)]], [wild], [t]);
    if (w) {
      this.error(
        Codes.NonExhaustive,
        p.span,
        `this pattern does not match every ${this.show(t)}: not \`${formatWitness(w[0], t)}\``,
        `${what} cannot skip a value; use \`match\``,
      );
    }
  }

  /** `['Point']` → the struct, `['Status', 'Paid']` → the variant; reports and returns null otherwise. */
  /** `.Paid { at }`: a variant of the enum being matched, which must be known. */
  private resolveShort(p: ast.CtorPattern, t: Type): CtorTarget | null {
    const name = p.path[0];
    if (t.kind === 'error') return null;
    if (t.kind !== 'enum') {
      this.error(
        Codes.TypeMismatch,
        p.pathSpan,
        `\`.${name}\` names a variant of the enum being matched, but the value matched is ${this.show(t)}`,
        t.kind === 'struct' ? `write the struct's name: \`${this.show(t)} { ... }\`` : 'match an enum, or write the full path: `Type.Variant`',
      );
      return null;
    }
    const variant = t.origin.variants.find((v) => v.name === name);
    if (!variant) {
      const names = t.origin.variants.map((v) => `\`${v.name}\``);
      this.error(
        Codes.NoSuchMember,
        p.pathSpan,
        `enum \`${this.show(t)}\` has no variant \`${name}\``,
        `its variants are ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`,
      );
      return null;
    }
    return { kind: 'variant', type: t.origin, variant };
  }

  /**
   * `const limit = 20`: literals, other consts and operators on them, folded here; or (#8a5f2239)
   * lists, maps, tuples and records of constants and function names, which become Go variables. A
   * const that names another checks that one first, so the order they are written in doesn't matter.
   */
  private checkConst(decl: ast.ConstDecl) {
    const v = this.values.get(decl.name);
    if (v?.decl !== decl || this.constState.has(decl)) return;
    this.constState.set(decl, 'checking');
    const declared = decl.type ? this.resolveType(decl.type) : null;
    if (this.constant(decl.value)) {
      const side = this.testSide;
      this.testSide = decl.span.start.line > this.testsFrom;
      const t = declared ? this.checkAgainst(decl.value, declared) : this.checkExpr(decl.value);
      this.testSide = side;
      if (t.kind !== 'error' && !hasError(t) && !scalarConst(t)) {
        v.type = t;
        this.varConsts.push(decl);
      } else if (t.kind !== 'error' && !hasError(t)) {
        v.type = t;
        v.value = this.fold(decl.value);
        if (typeof v.value === 'number' && !Number.isFinite(v.value)) {
          this.error(Codes.IntegerOverflow, decl.value.span, `\`${decl.name}\` does not fit in a float (64-bit)`, 'a float reaches about 1.8e308');
          v.type = T.error;
          v.value = undefined;
        }
      }
    }
    this.constState.set(decl, 'done');
  }

  /**
   * Whether `e` can be worked out while compiling; reports the first part that can't. `scalar`:
   * under an operator, where only the scalars Go folds will do.
   */
  private constant(e: ast.Expr, scalar = false): boolean {
    const help = 'a const holds literals, other consts, operators on them, lists, maps and records of these, and function names; for anything else, write a function: `fn name() -> T { ... }`';
    const refused = (span: Span, what: string, fix = help) => {
      this.error(Codes.NotConstant, span, `a const's value is worked out while compiling, and ${what} is not known until the program runs`, fix);
      return false;
    };
    const notScalar = (span: Span, what: string) => {
      this.error(
        Codes.NotConstant,
        span,
        `an operator in a const works on ints, floats, strings, bools and chars, and ${what} is not one`,
        'build lists, maps and records from constants as they are, `[a, b]`; for a value worked out from them, write a function: `fn name() -> T { ... }`',
      );
      return false;
    };
    const all = (es: ast.Expr[], what: string) => (scalar ? notScalar(e.span, what) : es.every((x) => this.constant(x)));
    switch (e.kind) {
      case 'Int':
      case 'Float':
      case 'String':
      case 'Bool':
      case 'Char':
        return true;
      case 'Unary':
        return this.constant(e.operand, true);
      case 'Binary':
        if (e.op === '??') return refused(e.span, '`??`');
        return this.constant(e.left, true) && this.constant(e.right, true);
      case 'None':
        return scalar ? notScalar(e.span, '`none`') : true;
      case 'ListLit':
        return all(e.items, 'a list');
      case 'TupleLit':
        return all(e.items, 'a tuple');
      case 'MapLit':
        return all(e.entries.flatMap((x) => [x.key, x.value]), 'a map');
      case 'StructLit':
        return all([...(e.spread ? [e.spread] : []), ...e.fields.map((f) => f.value)], `\`${exprText(e)}\``);
      case 'Lambda':
        return refused(e.span, 'a lambda', 'a const can name a function but not hold a lambda: write it as `fn name(...) { ... }` and give the const its name');
      case 'Ident':
      case 'Member': {
        const mod = e.kind === 'Member' && e.object.kind === 'Ident' ? this.imports.get(e.object.name) : undefined;
        const named = e.kind === 'Ident' ? this.values.get(e.name) : mod?.values.get(e.name);
        if (named?.decl.kind === 'ConstDecl') {
          if (e.kind === 'Ident' && this.constState.get(named.decl) === 'checking') {
            this.error(Codes.ConstCycle, e.span, `\`${e.name}\` is worked out from itself: its value names it, here or through other consts`, 'give one of these consts a value that does not depend on the others');
            return false;
          }
          if (e.kind === 'Ident') this.checkConst(named.decl);
          if (scalar && named.value === undefined && named.type.kind !== 'error') return notScalar(e.span, `\`${exprText(e)}\``);
          return true;
        }
        const sig = e.kind === 'Ident' ? this.fns.get(e.name) : mod?.fns.get(e.name);
        if (sig && (e.kind === 'Member' || !named)) {
          if (scalar) return notScalar(e.span, `the function \`${exprText(e)}\``);
          const why = sig.uses.length > 0 ? `it uses ${sig.uses.map((u) => `\`${u}\``).join(', ')}` : sig.typeParams.length > 0 ? 'it is generic' : null;
          if (!why) return true;
          this.error(
            Codes.NotConstant,
            e.span,
            `a const can't name \`${exprText(e)}\`: ${why}`,
            sig.uses.length > 0
              ? 'a const names only functions without effects; take the function as a parameter where it is needed instead'
              : `Go needs a generic function's type arguments: write a function for the types you need, \`fn name(...) { return ${exprText(e)}(...) }\`, and name that`,
          );
          return false;
        }
        // `Color.Red`: a variant without fields.
        if (e.kind === 'Member' && !mod && this.typeNamed(e.object)) return scalar ? notScalar(e.span, `\`${exprText(e)}\``) : true;
        return refused(e.span, `\`${exprText(e)}\``);
      }
      case 'Interp':
        return refused(e.span, 'an interpolated string');
      case 'Call':
        return refused(e.span, 'a call');
      default:
        return refused(e.span, 'this');
    }
  }

  /** What a checked constant expression is; see `ExternValue.value`. */
  private fold(e: ast.Expr): ConstValue {
    switch (e.kind) {
      case 'Int':
        return BigInt(e.value.replaceAll('_', ''));
      case 'Float':
        return Number(e.value.replaceAll('_', ''));
      case 'String':
      case 'Char':
      case 'Bool':
        return e.value;
      case 'Ident':
        return this.values.get(e.name)!.value!;
      case 'Member':
        return this.imports.get((e.object as ast.Ident).name)!.values.get(e.name)!.value!;
      case 'Unary': {
        const v = this.fold(e.operand);
        return e.op === '!' ? !v : -(v as number);
      }
      case 'Binary': {
        // Checked already, so both sides are of one type that has the operator.
        const l = this.fold(e.left) as any;
        const r = this.fold(e.right) as any;
        switch (e.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          // BigInt division truncates toward zero and `%` takes the dividend's sign, as in Go.
          case '/': return l / r;
          case '%': return l % r;
          case '==': return l === r;
          case '!=': return l !== r;
          case '<': return l < r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '>=': return l >= r;
          case '&&': return l && r;
          case '||': return l || r;
        }
      }
    }
    throw new Error(`not a constant: ${e.kind}`);
  }

  /** `.Forbidden` in an expression: a variant of the enum expected where it goes (`hint`), through a `T?`. */
  private resolveShortLit(e: ast.StructLit, hint: Type | null): CtorTarget | null {
    const name = e.path[0];
    const t = hint?.kind === 'option' ? hint.inner : hint;
    if (t?.kind === 'error') return null;
    if (t?.kind === 'enum') {
      const variant = t.variants.find((v) => v.name === name);
      if (variant) return { kind: 'variant', type: t, variant };
      const names = t.variants.map((v) => `\`${v.name}\``);
      this.error(
        Codes.NoSuchMember,
        e.pathSpan,
        `enum \`${this.show(t)}\` has no variant \`${name}\``,
        `its variants are ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`,
      );
      return null;
    }
    // The enums this module can name that have such a variant, written the long way.
    const own = [...this.userTypes.values()].filter((u) => u.kind === 'enum' && u.variants.some((v) => v.name === name)).map((u) => `${u.name}.${name}`);
    const imported = [...this.imports].flatMap(([as, mod]) =>
      mod.userTypes.filter((u) => u.pub && u.kind === 'enum' && u.variants.some((v) => v.name === name)).map((u) => `${as}.${u.name}.${name}`),
    );
    const braces = e.span.end.line !== e.pathSpan.end.line || e.span.end.col !== e.pathSpan.end.col;
    const long = [...own, ...imported].map((x) => `\`${x}${braces ? ' { ... }' : ''}\``);
    const help = long.length > 0 ? `write it the long way: ${long.join(' or ')}` : "write the enum's name too: `Type." + name + '`';
    if (t) {
      this.error(Codes.TypeMismatch, e.pathSpan, `\`.${name}\` names a variant of the enum expected here, but ${this.show(t)} is expected`, help);
    } else {
      this.error(Codes.NeedsAnnotation, e.pathSpan, `cannot tell which enum \`.${name}\` is a variant of: nothing here expects an enum`, help);
    }
    return null;
  }

  private resolveCtor(path: string[], span: Span): CtorTarget | null {
    const found = this.typeAt(path, span);
    if (!found) return null;
    const { ty, rest } = found;
    const name = this.show(ty);
    if (rest.length === 0) {
      if (ty.kind === 'struct') return { kind: 'struct', type: ty };
      this.error(
        Codes.NotAValue,
        span,
        `\`${name}\` is an enum; name one of its variants`,
        `as in \`${name}.${ty.variants[0]?.name ?? 'Variant'}\``,
      );
      return null;
    }
    if (ty.kind === 'struct' || rest.length > 1) {
      this.error(Codes.NoSuchMember, span, `\`${path.join('.')}\` is not an enum variant`);
      return null;
    }
    const variant = ty.variants.find((v) => v.name === rest[0]);
    if (!variant) {
      this.error(
        Codes.NoSuchMember,
        span,
        `enum \`${name}\` has no variant \`${rest[0]}\``,
        choices(rest[0], ty.variants.map((v) => v.name)),
      );
      return null;
    }
    return { kind: 'variant', type: ty, variant };
  }

  /**
   * The type `path` starts with, `Point`, or `geo.Point` from an imported module, and the rest
   * of the path. Reports and returns null when there is none.
   */
  private typeAt(path: string[], span: Span): { ty: UserType; rest: string[] } | null {
    const mod = this.imports.get(path[0]);
    if (mod) {
      const types = mod.userTypes.filter((t) => t.pub).map((t) => t.name);
      if (path.length === 1) {
        this.error(Codes.UnknownType, span, `\`${path[0]}\` is a module, not a type`, types.length > 0 ? `name one of its types, as in \`${path[0]}.${types[0]}\`` : undefined);
        return null;
      }
      const ty = mod.userTypes.find((t) => t.name === path[1]);
      if (!ty && mod.opaques.has(path[1])) {
        this.error(
          Codes.GoTypeOutside,
          span,
          `\`${path[0]}.${path[1]}\` is a Go type, so only the code of \`effect ${path[0]}\` can hold one`,
          `call its operations instead, as in \`${path[0]}.${[...(this.userEffects.get(path[0])?.ops.keys() ?? [])][0] ?? 'op'}(...)\``,
        );
        return null;
      }
      if (!ty) {
        this.error(
          Codes.UnknownType,
          span,
          `module \`${path[0]}\` has no type \`${path[1]}\``,
          types.length > 0 ? choices(path[1], types) : `\`${path[0]}\` declares no types`,
        );
        return null;
      }
      if (!ty.pub) {
        this.privateDecl(span, `type \`${path[0]}.${path[1]}\``, mod, types);
        return null;
      }
      return { ty, rest: path.slice(2) };
    }
    const ty = this.userTypes.get(path[0]);
    if (ty) return { ty, rest: path.slice(1) };
    const near = suggest(path[0], [...this.userTypes.keys()]);
    this.error(Codes.UnknownType, span, `unknown type \`${path[0]}\``, this.importedType(path[0]) ?? (near && `did you mean \`${near}\`?`));
    return null;
  }

  /** Help for a bare `HttpError` that an imported module declares: write `http.HttpError`. */
  private importedType(name: string): string | undefined {
    const mod = [...this.imports.values()].find((m) => m.userTypes.some((t) => t.name === name));
    if (mod && !mod.userTypes.find((t) => t.name === name)!.pub) return `module \`${mod.module}\` declares a \`${name}\`, but keeps it private`;
    return mod && `\`${name}\` is declared in module \`${mod.module}\`; write \`${mod.module}.${name}\``;
  }

  /** The type `e` names: `Point`, or `geo.Point` from an imported module. */
  private typeNamed(e: ast.Expr): string[] | null {
    if (e.kind === 'Ident') return !this.lookup(e.name) && this.userTypes.has(e.name) ? [e.name] : null;
    if (e.kind !== 'Member' || e.object.kind !== 'Ident') return null;
    const mod = this.imports.get(e.object.name);
    return mod?.userTypes.some((t) => t.name === e.name) ? [e.object.name, e.name] : null;
  }

  /** `Tree.Leaf`: a generic enum's variant without fields, which only where it goes can complete. */
  private bareVariant(e: ast.Expr): boolean {
    if (e.kind !== 'Member' || ((e.object.kind === 'Ident' || e.object.kind === 'Member') && e.object.typeArgs)) return false;
    const path = this.typeNamed(e.object);
    if (!path) return false;
    const ty = path.length === 1 ? this.userTypes.get(path[0]) : this.imports.get(path[0])?.userTypes.find((t) => t.name === path[1]);
    return ty?.kind === 'enum' && ty.params.length > 0 && ty.variants.some((v) => v.name === e.name && v.fields.length === 0);
  }

  /** Whether this module can see `field` of `t`: its own types' fields, or another's `pub` ones. Reports why not. */
  private fieldVisible(t: UserType, field: Field, span: Span): boolean {
    if (field.pub || t.module === this.mod.name) return true;
    this.error(
      Codes.Private,
      span,
      `field \`${field.name}\` of \`${this.declName(t)}\` is private to module \`${t.module}\``,
      `only \`${t.module}\` can read it: use a \`pub fn\` of \`${t.module}\` that gives what you need, or add \`pub\` to the field`,
    );
    return false;
  }

  /** A struct literal of another module's struct needs every field `pub`. Reports why not. */
  /** `given`: the fields a literal names. A private optional one it leaves out is `none` (or copied by `...`), which is fine. */
  private buildable(t: StructType, span: Span, given: Set<string>) {
    if (t.module === this.mod.name) return;
    const hidden = t.fields.filter((f) => !f.pub && (f.type.kind !== 'option' || given.has(f.name))).map((f) => `\`${f.name}\``);
    if (hidden.length === 0) return;
    const mod = this.byModule.get(t.module);
    const makers = [...(mod?.fns.values() ?? [])].filter((s) => s.decl.pub && s.ret.kind === 'struct' && s.ret.origin === t.origin).map((s) => `\`${t.module}.${s.name}(...)\``);
    this.error(
      Codes.Private,
      span,
      `\`${this.declName(t)}\` has private ${hidden.length === 1 ? 'field' : 'fields'} ${hidden.join(', ')}, so only module \`${t.module}\` can build one`,
      makers.length > 0 ? `call ${makers.join(' or ')}` : `\`${t.module}\` has no \`pub fn\` that returns one: add one there, or make the fields \`pub\``,
    );
  }

  /** A declaration of another module without `pub`: only that module can use it. */
  private privateDecl(span: Span, what: string, mod: CheckResult, offered: string[]) {
    this.error(
      Codes.Private,
      span,
      `${what} is private to module \`${mod.module}\``,
      offered.length > 0
        ? `\`${mod.module}\` offers ${offered.map((n) => `\`${n}\``).join(', ')}; or add \`pub\` to it in \`${mod.module}\``
        : `add \`pub\` to it in \`${mod.module}\``,
    );
  }

  private unknownField(target: CtorTarget, name: string, span: Span) {
    const fields = target.kind === 'struct' ? target.type.fields : target.variant.fields;
    this.error(
      Codes.NoSuchMember,
      span,
      `\`${this.ctorName(target)}\` has no field \`${name}\``,
      fields.length > 0 ? choices(name, fields.map((f) => f.name)) : `\`${this.ctorName(target)}\` has no fields`,
    );
  }

  private inferStructLit(e: ast.StructLit): Type {
    const hint = this.takeHint();
    let target = e.short ? this.resolveShortLit(e, hint) : this.resolveCtor(e.path, e.pathSpan);
    if (!target) {
      if (e.spread) this.checkExpr(e.spread);
      for (const f of e.fields) this.checkExpr(f.value);
      return T.error;
    }
    const origin = target.type;
    const spread = e.spread ? this.checkExpr(e.spread) : null;
    // A generic type's arguments: written, from the copied value, or else from the fields.
    let known: Map<ParamType, Type> | null = null;
    if (e.typeArgs) {
      const at = this.imports.has(e.path[0]) ? 1 : 0;
      if (e.typeArgs.at !== at) {
        this.error(Codes.TypeArgs, e.typeArgs.span, 'type arguments go right after the name of the type', `write \`${this.declName(origin)}<...>.${e.path.at(-1)} { ... }\``);
        return T.error;
      }
      const inst = this.applyTypeArgs(origin, e.typeArgs.types, e.typeArgs.span, this.declName(origin));
      if (inst.kind !== 'struct' && inst.kind !== 'enum') return T.error;
      target = withType(target, inst);
    } else if (origin.params.length > 0 && !e.short) {
      if (target.kind === 'struct' && spread?.kind === 'struct' && spread.origin === origin) target = withType(target, spread);
      else known = new Map();
    }
    const fields = target.kind === 'struct' ? target.type.fields : target.variant.fields;
    if (e.spread && spread) {
      if (target.kind === 'variant') {
        this.error(Codes.TypeMismatch, e.spread.span, '`...` copies a struct; enum variants cannot be copied this way');
      } else if (!sameType(spread, target.type)) {
        this.mismatch(e.spread.span, target.type, spread);
      }
    }
    const seen = new Set<string>();
    const items: InferItem[] = [];
    for (const f of e.fields) {
      const field = fields.find((x) => x.name === f.name);
      if (!field) {
        this.checkExpr(f.value);
        this.unknownField(target, f.name, f.nameSpan);
      } else if (seen.has(f.name)) {
        this.checkExpr(f.value);
        this.error(Codes.Duplicate, f.nameSpan, `field \`${f.name}\` is given twice`);
      } else {
        seen.add(f.name);
        if (known) items.push({ expr: f.value, type: field.type, effect: false, label: `field \`${f.name}\`` });
        else this.checkAgainst(f.value, field.type);
      }
    }
    let failed = false;
    if (known) {
      const from = this.inferArgs(origin.params, items, known, { declared: origin, hint });
      const name = this.ctorName(target).replace(/<.*>/, '');
      if (!this.fromHint(e.pathSpan, `\`${name} { ... }\``, origin.params, known, from, origin, hint)) {
        failed = true;
      } else if (!this.allKnown(e.pathSpan, `the fields of \`${name}\` don't say`, origin.params, known, origin, hint, (args) => `${this.declName(origin)}<${args}>${target!.kind === 'variant' ? `.${target!.variant.name}` : ''} { ... }`)) {
        failed = true;
      } else {
        const args = origin.params.map((p) => known!.get(p)!);
        if (this.checkBounds(origin.params, args, e.pathSpan, `\`${this.declName(origin)}\``)) target = withType(target, instantiate(origin, args));
        else failed = true;
      }
    }
    this.structLits.set(e, target);
    if (target.kind === 'struct') this.buildable(target.type, e.pathSpan, seen);
    if (!e.spread) {
      // An optional field left out is `none`; every other field must be given.
      const missing = fields.filter((f) => !seen.has(f.name) && f.type.kind !== 'option').map((f) => `\`${f.name}\``);
      if (missing.length > 0) {
        this.error(
          Codes.MissingField,
          e.pathSpan,
          `\`${this.ctorName(target)}\` is missing ${missing.length === 1 ? 'field' : 'fields'} ${missing.join(', ')}`,
          'every field must be given, except optional ones (`T?`), which are `none` when left out',
        );
      }
    }
    return failed ? T.error : target.type;
  }

  /**
   * Checks values given for parts declared with `params` (a generic function's arguments, a
   * generic struct's fields), learning what the parameters stand for from them. Values that need
   * context (lambdas, `none`, `Ok(...)`, `[]`) go last, so the others have said what they can.
   * `wants`: the type the whole gives, written with the parameters, and the type expected where it
   * goes; a lambda uses that for what its returns leave open. Returns where each parameter was
   * learned.
   */
  private inferArgs(params: ParamType[], items: InferItem[], known: Map<ParamType, Type>, wants?: { declared: Type; hint: Type | null }): Map<ParamType, string> {
    const open = (t: Type) => [...paramsIn(t)].some((p) => params.includes(p) && !known.has(p));
    // What is known so far; the rest is `error`, which fits anything and reports nothing.
    const sure = (t: Type) => subst(t, (p) => known.get(p) ?? (params.includes(p) ? T.error : p));
    const from = new Map<ParamType, string>();
    // What is known, with what where the whole goes says for the rest.
    const guess = () => {
      const g = new Map(known);
      if (wants?.hint) unify(wants.declared, wants.hint, params, g);
      return g;
    };
    let frame: LambdaFrame | null = null;
    // A lambda whose result is open: what is known of it, and what where the call goes says.
    const hintFrame = (ret: Type) => (f: LambdaFrame) => {
      frame = f;
      // Unknowns as holes, not `error`: merged with the returns, an `error` would win over what
      // they say (`(int, T)` and `(n, x)`), leaving an error type with nothing reported.
      const part = subst(ret, (p) => known.get(p) ?? (params.includes(p) ? hole : p));
      if (part.kind === 'result') {
        if (part.ok !== hole) f.okHint = part.ok;
        if (part.err !== hole) f.errHint = part.err;
      }
      if (wants?.hint) f.retHint = sure(subst(ret, (p) => guess().get(p) ?? p));
    };
    for (const late of [false, true]) {
      for (const { expr, type, effect, label, param } of items) {
        if ((needsContext(expr) || this.bareVariant(expr)) !== late) continue;
        if (param) this.argFor.set(expr, param);
        const before = new Set(known.keys());
        frame = null;
        if (effect && type.kind === 'fn') {
          this.effectArg(expr, type, (t) => unify(type, t, params, known), sure, open, hintFrame(type.ret));
        } else if (!open(type)) {
          this.checkAgainst(expr, sure(type));
        } else if (expr.kind === 'Lambda' && type.kind === 'fn') {
          const t = this.checkLambda(expr, type.params.map(sure), open(type.ret) ? null : sure(type.ret), hintFrame(type.ret));
          unify(type, t, params, known);
          const unknown = open(type);
          // With a type parameter still unknown, that is the error to report.
          if (!unknown) this.coerce(expr, t, sure(type));
        } else if (late) {
          // `[]`, `none`, `Ok(...)` say nothing themselves: a lambda's annotated parameters may
          // (card 161), and where the whole goes.
          for (const other of items) {
            if (other.expr.kind !== 'Lambda' || other.type.kind !== 'fn') continue;
            const fnType = other.type;
            other.expr.params.forEach((_, i) => {
              const t = this.annotatedParam(other.expr, i);
              if (t && t.kind !== 'error' && fnType.params[i] && open(fnType.params[i])) unify(fnType.params[i], t, params, known);
            });
          }
          const t = this.checkAgainst(expr, sure(subst(type, (p) => guess().get(p) ?? p)));
          unify(type, t, params, known);
        } else {
          const t = this.checkExpr(expr);
          unify(type, t, params, known);
          this.coerce(expr, t, sure(type));
        }
        const at = (frame as LambdaFrame | null)?.retFrom ?? `${label} (line ${expr.span.start.line})`;
        for (const p of known.keys()) if (!before.has(p)) from.set(p, at);
      }
    }
    return from;
  }

  /**
   * A function passed for a `uses f` parameter: any effects are allowed, and the call performs
   * them, so the caller must have them.
   */
  private effectArg(
    expr: ast.Expr,
    type: FnType,
    learn: (t: Type) => void,
    sure: (t: Type) => Type,
    open: (t: Type) => boolean,
    onFrame?: (frame: LambdaFrame) => void,
  ) {
    const t = expr.kind === 'Lambda' ? this.checkLambda(expr, type.params.map(sure), open(type.ret) ? null : sure(type.ret), open(type.ret) ? onFrame : undefined) : this.checkExpr(expr);
    if (t.kind === 'error') return;
    learn(t);
    const want = sure(type) as FnType;
    if (t.kind !== 'fn' || !sameShape(t, want)) {
      this.error(Codes.TypeMismatch, expr.span, `expected a function ${this.show(fn(want.params, want.ret))}, found ${this.show(t)}`);
      return;
    }
    // A lambda's or a named function's missing effects were reported where they were captured.
    const reported = expr.kind === 'Lambda' || (expr.kind === 'Ident' && this.refs.get(expr) === 'fn');
    this.perform(t.uses, expr.span, 'the function passed here', !reported);
  }

  /**
   * Whether every type parameter is known; reports the ones that aren't, after `what`, as in
   * "the arguments of `f` don't say". `declared` is what the
   * expression gives, written with the parameters: matched against `hint`, the type expected
   * where it goes, it makes the help concrete.
   */
  private allKnown(
    span: Span,
    what: string,
    params: ParamType[],
    known: Map<ParamType, Type>,
    declared: Type,
    hint: Type | null,
    form: (args: string) => string,
  ): boolean {
    const missing = params.filter((p) => !known.has(p));
    if (missing.length === 0) return true;
    const guess = new Map(known);
    if (hint) unify(declared, hint, params, guess);
    const names = missing.map((p) => `\`${p.name}\``);
    const args = params.map((p) => (guess.has(p) ? this.show(guess.get(p)!) : p.name)).join(', ');
    const sure = missing.every((p) => guess.has(p));
    this.error(
      Codes.TypeArgs,
      span,
      `${what} what ${names.join(' and ')} ${missing.length === 1 ? 'is' : 'are'}`,
      sure ? `write \`${form(args)}\`` : `write ${missing.length === 1 ? 'it' : 'them'}: \`${form(args)}\`, with the type${missing.length === 1 ? '' : 's'} in place of ${names.join(' and ')}`,
    );
    return false;
  }

  /**
   * Fills the parameters the arguments left open from `hint`, the type expected where the value
   * goes. The arguments win: when what they said doesn't fit there, reports which type came
   * from where (`from`) and returns false.
   */
  private fromHint(span: Span, what: string, params: ParamType[], known: Map<ParamType, Type>, from: Map<ParamType, string>, declared: Type, hint: Type | null): boolean {
    if (!hint || hasError(hint)) return true;
    const wanted = new Map<ParamType, Type>();
    // A `T` goes where a `T?` is expected.
    unify(declared, hint.kind === 'option' && declared.kind !== 'option' && declared.kind !== 'param' ? hint.inner : hint, params, wanted);
    for (const [p, t] of wanted) if (!known.has(p)) known.set(p, t);
    if (params.some((p) => !known.has(p))) return true;
    const gives = subst(declared, (p) => known.get(p) ?? p);
    if (hasError(gives) || sameType(gives, hint) || assignable(gives, hint)) return true;
    const clash = params.filter((p) => from.has(p) && wanted.has(p) && !sameType(known.get(p)!, wanted.get(p)!));
    const said = clash.map((p) => `\`${p.name}\` is ${this.show(known.get(p)!)}, from ${from.get(p)!}`);
    // `get(v)` with `T = int?` gives an `int??`: missing, or present and `none`.
    if (gives.kind === 'option' && gives.inner.kind === 'option' && assignable(gives.inner, hint)) {
      this.error(
        Codes.TypeMismatch,
        span,
        `${what} gives ${this.show(gives)}, but where it goes expects ${this.show(hint)}`,
        `${said.length > 0 ? `${said.join('; ')}, so it gives an option of an option; ` : ''}write \`${what.replace(/`/g, '')} ?? none\` for one ${this.show(gives.inner)}`,
      );
      return false;
    }
    this.error(
      Codes.TypeMismatch,
      span,
      `${what} gives ${this.show(gives)}, but where it goes expects ${this.show(hint)}`,
      said.length > 0
        ? `${said.join('; ')}, and the arguments decide. Change ${clash.length === 1 ? 'that' : 'those'} or the type where it goes`
        : 'change the arguments or the type where it goes',
    );
    return false;
  }

  /** The name a declaration is written by here, without type arguments: `Page`, `geo.Page`. */
  private declName(t: UserType): string {
    return t.module === this.mod.name || builtinTypes.includes(t.origin) ? t.name : `${t.module}.${t.name}`;
  }

  private takeHint(): Type | null {
    const h = this.hint;
    this.hint = null;
    return h;
  }

  /**
   * Checks `e` where a value of type `expected` must go, letting the context decide what
   * `Ok(...)`, `none` and branch values mean. Returns `expected`, or `error` if it doesn't fit.
   */
  private checkAgainst(e: ast.Expr, expected: Type): Type {
    if (isSqlQuery(expected)) return this.checkQuery(e, expected);
    let t: Type;
    if (e.kind === 'If') t = this.checkIf(e, 'value', expected);
    else if (e.kind === 'Match') t = this.checkMatch(e, 'value', expected);
    else if (e.kind === 'Call' && resultCtor(e)) {
      // Into a `Result<T, E>?`: build the Result, then wrap it.
      t = this.checkResultCtor(e, expected.kind === 'option' && expected.inner.kind === 'result' ? expected.inner : expected);
    }
    else if (e.kind === 'Lambda') {
      // Into a `(fn(...))?` too: the lambda is the present value.
      const want = expected.kind === 'option' ? expected.inner : expected;
      t = want.kind === 'fn' ? this.checkLambda(e, want.params, want.ret) : this.checkLambda(e, null, null);
    } else if (e.kind === 'ListLit') {
      // Into a `List<T>?` too (card 148): the list is the present value.
      const want = expected.kind === 'option' ? expected.inner : expected;
      t = this.inferList(e, want.kind === 'list' ? want.elem : null);
      this.types.set(e, t);
    } else if (e.kind === 'MapLit') {
      const want = expected.kind === 'option' ? expected.inner : expected;
      t = this.inferMap(e, want.kind === 'map' ? want : null);
      this.types.set(e, t);
    } else if (e.kind === 'TupleLit') {
      // Into a `(A, B)?`: build the tuple, then wrap it.
      const want = expected.kind === 'option' ? expected.inner : expected;
      t = this.inferTuple(e, want.kind === 'tuple' && want.elems.length === e.items.length ? want : null);
      this.types.set(e, t);
    } else {
      if (e.kind === 'Call' || e.kind === 'StructLit' || e.kind === 'Member') this.hint = expected;
      t = this.checkExpr(e);
      this.hint = null;
    }
    return this.coerce(e, t, expected) ? expected : T.error;
  }

  /**
   * Where a `sql.Query` goes: a string literal, whose `${...}` are parameters, sent apart from the
   * text. A string from anywhere else is refused, so no query is ever glued together.
   */
  private checkQuery(e: ast.Expr, expected: Type): Type {
    if (e.kind !== 'String' && e.kind !== 'Interp') {
      const t = this.checkExpr(e);
      if (t.kind === 'error' || isSqlQuery(t)) return t.kind === 'error' ? T.error : expected;
      this.error(
        Codes.TypeMismatch,
        e.span,
        t.kind === 'string' ? 'a query is a string literal, written where it runs, and this is a string from elsewhere' : `expected a query (a string literal), found ${this.show(t)}`,
        t.kind === 'string'
          ? 'write the query here, with the values in `${...}`: each becomes a parameter, so the text never changes with them. To pass a query around, type it `sql.Query`'
          : undefined,
      );
      return T.error;
    }
    this.types.set(e, expected);
    this.queries.add(e);
    if (e.kind === 'String') return expected;
    let text = '';
    for (const part of e.parts) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      const t = this.checkExpr(part);
      const x = part.kind === 'Ident' || part.kind === 'Member' ? exprText(part) : 'x';
      // Inside quotes, the `?` it becomes is text.
      if ((text.match(/'/g)?.length ?? 0) % 2 === 1) {
        this.error(
          Codes.TypeMismatch,
          part.span,
          "`${ }` in a query is a parameter, and inside quotes it would be the text `?`",
          `drop the quotes: \`\${${x}}\`; to match part of a string, build the pattern: \`LIKE \${"%\${${x}}%"}\``,
        );
      }
      text += '?';
      if (t.kind === 'error' || t.kind === 'none' || column(t)) continue;
      const field = t.kind === 'struct' ? t.fields.find((f) => column(f.type)) : undefined;
      this.error(
        Codes.TypeMismatch,
        part.span,
        `\`\${ }\` in a query is a parameter: int, string, bool, float, Bytes or an optional of those, found ${this.show(t)}`,
        field ? `pass its fields, like \`\${${x}.${field.name}}\`` : t.kind === 'list' ? 'a parameter is one value: run the query once per item' : undefined,
      );
    }
    return expected;
  }

  /**
   * A lambda, with what the context says about its parameters and result. Its effects are what
   * its body performs; it captures them from the enclosing function, which must have them.
   */
  private checkLambda(
    e: ast.Lambda,
    expectedParams: Type[] | null,
    expectedRet: Type | null,
    onFrame?: (frame: LambdaFrame) => void,
  ): Type {
    if (expectedParams && expectedParams.length !== e.params.length) {
      const n = expectedParams.length;
      this.error(
        Codes.ArgCount,
        e.span,
        `this lambda takes ${e.params.length} parameter${e.params.length === 1 ? '' : 's'}, but ${n} ${n === 1 ? 'is' : 'are'} expected here`,
      );
      expectedParams = null;
    }
    const params = e.params.map((p, i): Type => {
      const exp = expectedParams?.[i];
      if (p.type) {
        const t = this.resolveType(p.type);
        if (exp && t.kind !== 'error' && !sameType(t, exp)) this.mismatch(p.type.span, exp, t);
        return t;
      }
      if (exp) return exp;
      this.error(Codes.NeedsAnnotation, p.span, `cannot tell the type of \`${p.name}\``, `annotate it: \`(${p.name}: int) => ...\``);
      return T.error;
    });
    if (e.returnType) {
      const declared = this.resolveReturn(e.returnType);
      if (expectedRet && declared.kind !== 'error' && !sameType(declared, expectedRet)) {
        this.mismatch(e.returnType.span, expectedRet, declared);
      }
      expectedRet = declared;
    }
    const frame: LambdaFrame = {
      ret: expectedRet,
      errHint: null,
      okHint: null,
      pending: [],
      retHint: null,
      retFrom: null,
      tries: [],
      used: new Set(),
      scopeDepth: this.scopes.length,
      parent: this.lambda,
    };
    onFrame?.(frame);
    const loops = this.loops;
    const { body: outerBody, deferFrame } = this;
    // The body may run later or never: what it learns stays inside it.
    const facts = this.facts;
    this.lambda = frame;
    this.loops = 0;
    this.body = e.body.kind === 'Block' ? e.body : null;
    this.deferFrame = null;
    this.scopes.push(new Map());
    // Unused parameters are fine, as for functions: `(_x) => ...` would be noise.
    // `_` ignores its argument.
    e.params.forEach((p, i) => {
      if (p.name !== '_') this.bind(p.name, { kind: 'local', type: params[i], used: true }, p.span);
    });
    // `(n) => match n { 0 => Err("zero"), _ => Ok(n) }` with nothing saying the result: each
    // branch alone can't tell, so they become returns, which say it together.
    if (frame.ret === null && (e.body.kind === 'If' || e.body.kind === 'Match') && returnsInBranches(e.body)) {
      e.body = { kind: 'Block', stmts: [{ kind: 'ExprStmt', expr: e.body, span: e.body.span }], span: e.body.span };
    }
    // #a64e87fe: `(tx) => Ok(tx.n)` for a `Result<R, string>`: a return settles `R` from the
    // value and the error type from the hint, as the block body `{ return Ok(tx.n) }` does.
    const hinted = frame.retHint !== null && !hasError(frame.retHint);
    if (frame.ret === null && !hinted && (frame.okHint || frame.errHint) && e.body.kind !== 'Block' && needsContext(e.body)) {
      e.body = { kind: 'Block', stmts: [{ kind: 'Return', value: e.body, span: e.body.span }], span: e.body.span };
    }
    const body = e.body;
    if (body.kind === 'Block') {
      const returnsValue = frame.ret !== null && frame.ret.kind !== 'unit';
      const r = this.checkBlock(body, returnsValue ? 'tail' : 'statement');
      if (frame.ret === null && frame.pending.length > 0) this.settleReturns(frame);
      const ret = frame.ret as Type | null;
      if (ret && ret.kind !== 'unit' && ret.kind !== 'error' && !r.diverges) {
        this.error(
          Codes.MissingReturn,
          e.span,
          `this lambda returns ${this.show(ret)} but not every path ends in \`return\``,
          'a block body needs `return`, as in a function; or drop the braces: `(x) => x + 1`',
        );
      }
    } else if (frame.ret?.kind === 'unit') {
      // Nothing is expected back, so a value is dropped, as for a call on its own line.
      if (body.kind === 'If') this.checkIf(body, 'statement');
      else if (body.kind === 'Match') this.checkMatch(body, 'statement');
      else {
        const t = this.checkExpr(body);
        if (t.kind !== 'unit' && t.kind !== 'error' && body.kind !== 'Call') {
          this.error(Codes.UnusedValue, body.span, `a function returning nothing is expected here, but this lambda gives a ${this.show(t)}`);
        }
      }
    } else if (frame.ret) {
      this.checkAgainst(body, frame.ret);
    } else if (needsContext(body) && frame.retHint && !hasError(frame.retHint)) {
      // `() => Ok(1)`: where the result goes says what it is.
      this.checkAgainst(body, frame.retHint);
      frame.ret = frame.retHint;
    } else {
      const t = body.kind === 'If' ? this.checkIf(body, 'value') : body.kind === 'Match' ? this.checkMatch(body, 'value') : this.checkExpr(body);
      if (t.kind === 'none') {
        this.error(Codes.NeedsAnnotation, body.span, 'cannot tell what kind of value this `none` is missing');
        frame.ret = T.error;
      } else {
        frame.ret = t;
      }
      frame.retFrom = `the lambda on line ${body.span.start.line}`;
    }
    this.popScope();
    this.lambda = frame.parent;
    this.loops = loops;
    this.body = outerBody;
    this.deferFrame = deferFrame;
    this.facts = facts;
    for (const x of frame.tries) this.checkTryTarget(x.operand, x.span, frame.ret ?? T.unit, 'this lambda', true);
    const t = fn(params, frame.ret ?? T.unit, [...frame.used]);
    this.types.set(e, t);
    return t;
  }

  /** A lambda's result is now known: the returns that waited for it are checked against it. */
  private decide(frame: LambdaFrame, t: Type, from: Span) {
    frame.ret = t;
    frame.retFrom = `the \`return\` on line ${from.start.line}`;
    for (const { value, span, leaves } of frame.pending.splice(0)) {
      if (value) this.settle(value, t, leaves);
      else if (t.kind !== 'unit' && t.kind !== 'error') this.error(Codes.TypeMismatch, span, `this lambda returns ${this.show(t)} but this \`return\` has no value`);
    }
  }

  /** A waiting `return`'s value, now that the type is known: its checked parts are coerced, the rest checked. */
  private settle(e: ast.Expr, want: Type, leaves: Map<ast.Expr, Type>) {
    const leaf = leaves.get(e);
    if (leaf) {
      this.coerce(e, leaf, want);
      return;
    }
    if (e.kind === 'None' || e.kind === 'ListLit' || e.kind === 'MapLit' || want.kind === 'error') {
      this.checkAgainst(e, want);
      return;
    }
    // Into a `T?`: build the `T`, then wrap it.
    const inner = want.kind === 'option' ? want.inner : want;
    if (e.kind === 'TupleLit') {
      if (inner.kind !== 'tuple' || inner.elems.length !== e.items.length) {
        this.mismatch(e.span, want, this.shapeType(e, leaves));
        return;
      }
      e.items.forEach((x, i) => this.settle(x, inner.elems[i], leaves));
      this.types.set(e, inner);
    } else if (e.kind === 'Call' && resultCtor(e)) {
      if (e.args.length !== 1 || leaves.has(e.args[0])) {
        // Its arguments were all checked: the usual checks, with their types.
        const r = this.checkResultCtor(e, inner, e.args.map((a) => leaves.get(a)!));
        if (r.kind === 'error') return;
      } else {
        if (inner.kind !== 'result') {
          this.mismatch(e.span, want, this.shapeType(e, leaves));
          return;
        }
        const which = resultCtor(e)!;
        this.settle(e.args[0], which === 'Ok' ? inner.ok : inner.err, leaves);
        this.resultCtors.set(e, which);
        this.types.set(e, inner);
      }
    }
    if (inner !== want) this.coerce(e, inner, want);
  }

  /**
   * What a `return`'s value says of the type, checking the parts that say all of theirs: `none`,
   * `Ok(...)`, `Err(...)`, `[]`, `[:]` say some, with `hole` for the rest; tuples say what their items say.
   */
  private shapeOf(e: ast.Expr, leaves: Map<ast.Expr, Type>): Type {
    if (e.kind === 'None') return { kind: 'option', inner: hole };
    if (e.kind === 'ListLit' && e.items.length === 0) return { kind: 'list', elem: hole };
    if (e.kind === 'MapLit' && e.entries.length === 0) return { kind: 'map', key: hole, value: hole };
    // A tuple always by its items, so `(s, j)` can meet `(s, none)` as `(S, J?)`.
    if (e.kind === 'TupleLit') return { kind: 'tuple', elems: e.items.map((x) => this.shapeOf(x, leaves)) };
    if (e.kind === 'Call' && resultCtor(e)) {
      const ok = resultCtor(e) === 'Ok';
      if (e.args.length !== 1) {
        for (const a of e.args) leaves.set(a, this.checkExpr(a));
        return { kind: 'result', ok: ok && e.args.length === 0 ? T.unit : hole, err: hole };
      }
      const a = this.shapeOf(e.args[0], leaves);
      return ok ? { kind: 'result', ok: a, err: hole } : { kind: 'result', ok: hole, err: a };
    }
    const t = this.checkExpr(e);
    leaves.set(e, t);
    return t;
  }

  /** A waiting value's shape again, for an error message (`hole` shows as `_`). */
  private shapeType(e: ast.Expr, leaves: Map<ast.Expr, Type>): Type {
    const leaf = leaves.get(e);
    if (leaf) return leaf;
    if (e.kind === 'None') return { kind: 'option', inner: hole };
    if (e.kind === 'TupleLit') return { kind: 'tuple', elems: e.items.map((x) => this.shapeType(x, leaves)) };
    if (e.kind === 'Call' && resultCtor(e) && e.args.length === 1) {
      const a = this.shapeType(e.args[0], leaves);
      return resultCtor(e) === 'Ok' ? { kind: 'result', ok: a, err: hole } : { kind: 'result', ok: hole, err: a };
    }
    return T.error;
  }

  /**
   * At a lambda's end, while nothing has said its result: what all its returns say, together
   * (`return n` and `return none` make an `int?`), with what `?`, failing tasks and the place
   * the result goes say for the rest.
   */
  private settleReturns(frame: LambdaFrame) {
    // What decided it, for messages: the last `return` that said something the others hadn't.
    let t: Type = hole;
    let first = frame.pending[0];
    for (const p of frame.pending) {
      const merged = mergeShapes(t, p.shape);
      if (holes(merged) < holes(t)) first = p;
      t = merged;
    }
    if (frame.okHint || frame.errHint) t = mergeShapes(t, { kind: 'result', ok: frame.okHint ?? hole, err: frame.errHint ?? hole });
    if (frame.retHint) t = fillShape(t, frame.retHint);
    if (paramsIn(t).has(hole)) {
      const open = frame.pending.find((p) => paramsIn(p.shape).has(hole))!;
      this.error(
        Codes.NeedsAnnotation,
        open.value?.span ?? open.span,
        `cannot tell what this lambda returns: its returns say ${this.show(t)}, where \`_\` is not known`,
        `annotate it: \`(...): ${this.show(subst(t, (p) => (p === hole ? param('T') : p)))} => ...\`, with \`T\` the type meant, or return a value that says`,
      );
      t = T.error;
    }
    this.decide(frame, t, first.value?.span ?? first.span);
  }

  /** The type a lambda's annotation gives its parameter `i`, if it has one; its errors wait for the lambda's own check. */
  private annotatedParam(arg: ast.Expr, i: number): Type | null {
    const te = arg.kind === 'Lambda' ? arg.params[i]?.type : null;
    if (!te) return null;
    const before = this.diagnostics.length;
    const t = this.resolveType(te);
    this.diagnostics.length = before;
    return t;
  }

  /** A function argument to a built-in like `map`: its effects happen here, at the call. */
  private checkFnArg(arg: ast.Expr, params: Type[], ret: Type | null, onFrame?: (frame: LambdaFrame) => void): FnType | null {
    const t = arg.kind === 'Lambda' ? this.checkLambda(arg, params, ret, onFrame) : this.checkExpr(arg);
    if (t.kind === 'error') return null;
    if (t.kind !== 'fn' || t.params.length !== params.length || !t.params.every((p, i) => sameType(p, params[i])) || (ret && !sameType(t.ret, ret))) {
      const want = ret ? this.show(fn(params, ret)) : `fn(${params.map((p) => this.show(p)).join(', ')}) -> ...`;
      this.error(Codes.TypeMismatch, arg.span, `expected a function ${want}, found ${this.show(t)}`);
      return null;
    }
    // A lambda's or a named function's missing effects were reported where they were captured.
    const reported = arg.kind === 'Lambda' || (arg.kind === 'Ident' && this.refs.get(arg) === 'fn');
    this.perform(t.uses, arg.span, 'the function passed here', !reported);
    return t;
  }

  /** `[a, b]`. With `elem`, the context says what it holds; otherwise the first item does. */
  private inferList(e: ast.ListLit, elem: Type | null): Type {
    if (elem) {
      for (const item of e.items) this.checkAgainst(item, elem);
      return { kind: 'list', elem };
    }
    if (e.items.length === 0) {
      if (this.emptyBranches.has(e)) {
        this.waiting.add(e);
        return { kind: 'list', elem: T.error };
      }
      this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this empty list holds', 'annotate it: `let xs: List<int> = []`');
      return T.error;
    }
    const first = this.checkExpr(e.items[0]);
    if (first.kind === 'none') {
      this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this list holds', 'annotate it: `let xs: List<string?> = [...]`');
      return T.error;
    }
    for (const item of e.items.slice(1)) {
      if (first.kind === 'error') this.checkExpr(item);
      else this.checkAgainst(item, first);
    }
    return first.kind === 'error' ? T.error : { kind: 'list', elem: first };
  }

  /** `["a": 1]`. With `expected`, the context says what it holds; otherwise the first entry does. */
  private inferMap(e: ast.MapLit, expected: (Type & { kind: 'map' }) | null): Type {
    if (expected) {
      for (const { key, value } of e.entries) {
        this.checkAgainst(key, expected.key);
        this.checkAgainst(value, expected.value);
      }
      this.duplicateKeys(e);
      return expected;
    }
    if (e.entries.length === 0) {
      if (this.emptyBranches.has(e)) {
        this.waiting.add(e);
        return { kind: 'map', key: T.error, value: T.error };
      }
      this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this empty map holds', 'annotate it: `let m: Map<string, int> = [:]`');
      return T.error;
    }
    const [first, ...rest] = e.entries;
    const key = this.checkExpr(first.key);
    const value = this.checkExpr(first.value);
    if (key.kind === 'none' || value.kind === 'none') {
      this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what this map holds', 'annotate it: `let m: Map<string, int?> = [...]`');
      return T.error;
    }
    for (const entry of rest) {
      if (key.kind === 'error') this.checkExpr(entry.key);
      else this.checkAgainst(entry.key, key);
      if (value.kind === 'error') this.checkExpr(entry.value);
      else this.checkAgainst(entry.value, value);
    }
    if (key.kind === 'error' || value.kind === 'error' || !this.checkKey(key, first.key.span)) return T.error;
    this.duplicateKeys(e);
    return { kind: 'map', key, value };
  }

  /** A literal key written twice: the first value would be lost. */
  private duplicateKeys(e: ast.MapLit) {
    const seen = new Set<string>();
    for (const { key } of e.entries) {
      const text = key.kind === 'String' ? JSON.stringify(key.value) : key.kind === 'Int' || key.kind === 'Bool' ? String(key.value) : null;
      if (text === null) continue;
      if (seen.has(text)) this.error(Codes.Duplicate, key.span, `the key ${text} is given twice`, 'keep one');
      seen.add(text);
    }
  }

  /** `xs[i]`: a `T?`, so an index out of range is a `none` to handle, not a crash. `m[k]` likewise. */
  /** `(a, b)`: with an expected tuple type, each part is checked against its own. */
  private inferTuple(e: ast.TupleLit, expected: TupleType | null): Type {
    if (expected) {
      e.items.forEach((x, i) => this.checkAgainst(x, expected.elems[i]));
      return expected;
    }
    const elems = e.items.map((x) => this.checkExpr(x));
    const none = e.items.find((_, i) => elems[i].kind === 'none');
    if (none) {
      this.error(Codes.NeedsAnnotation, none.span, 'cannot tell what kind of value this `none` is missing', 'annotate it: `let p: (int, string?) = (1, none)`');
      return T.error;
    }
    return elems.some((x) => x.kind === 'error') ? T.error : { kind: 'tuple', elems };
  }

  private inferIndex(e: ast.Index): Type {
    const t = this.checkExpr(e.object);
    if (t.kind === 'map') {
      this.checkAgainst(e.index, t.key);
      return this.optionOf(e, t.value);
    }
    // An unknown value may be a map: its index can be anything.
    if (t.kind === 'error') {
      this.checkExpr(e.index);
      return T.error;
    }
    if (t.kind !== 'list') {
      this.checkExpr(e.index);
      this.error(Codes.InvalidOperands, e.bracketSpan, `cannot index ${this.show(t)}`, t.kind === 'bytes' ? 'use `.at(i)`: an `int?`, `none` out of range' : undefined);
      return T.error;
    }
    this.checkAgainst(e.index, T.int);
    return this.optionOf(e, t.elem);
  }

  /** A built-in's `T?` of `item`: an item that is already a `U?` stays one (card 148). */
  private optionOf(e: ast.Expr, item: Type): Type {
    if (item.kind !== 'option') return { kind: 'option', inner: item };
    this.flattened.add(e);
    return item;
  }

  /**
   * Where a value can change: a `let mut` local, or a field path starting at one. Marks it
   * changed. Returns its type, or `error` after reporting why it can't change.
   */
  /** `whole`: the target is replaced whole (`x = v`), so a narrowed one is the `T?` it is. */
  private checkPlace(target: ast.Expr, verb: string, checked = false, whole = false): Type {
    if (target.kind === 'Index' && target.object.kind === 'Index') {
      // `xs[i][j] = v`: `xs[i]` is a `List<T>?`, so there is no row to change in place.
      for (const e of [target.object.object, target.object.index, target.index]) this.checkExpr(e);
      const xs = target.object.object.kind === 'Ident' ? target.object.object.name : 'xs';
      this.error(
        Codes.NotMutable,
        target.span,
        `cannot change an item of \`${xs}[i]\` in place: \`${xs}[i]\` is an optional`,
        `copy the row out, change it, and put it back: \`let mut row = ${xs}[i] ?? []\`, \`row[j] = v\`, \`${xs}[i] = row\``,
      );
      return T.error;
    }
    let t = checked ? (this.types.get(target) ?? T.error) : this.checkExpr(target);
    if (whole) t = this.widen(target) ?? t;
    if (t.kind === 'error') return t;
    let root = target;
    let holder: Type | undefined;
    if (root.kind === 'Index') {
      // `xs[i] = v`, `m[k] = v`: the list or map is what must be assignable; the item, a `T` not a `T?`, is what changes.
      holder = this.types.get(root.object);
      if (holder?.kind === 'map') {
        t = holder.value;
      } else if (holder?.kind === 'list') {
        t = holder.elem;
      } else {
        return T.error;
      }
      root = root.object;
    }
    while (root.kind === 'Member') {
      const inner = root.object;
      if (inner.kind === 'Member') {
        const holder = this.types.get(inner.object);
        const boxed = holder?.kind === 'struct' && holder.fields.find((f) => f.name === inner.name)?.boxed;
        if (boxed) {
          this.error(
            Codes.NotMutable,
            target.span,
            `cannot change a field inside \`${inner.name}\`: it may be shared with other values`,
            `replace it whole: \`... ${inner.name} = { ...old, field: value }\``,
          );
          return T.error;
        }
      }
      root = inner;
    }
    const found = root.kind === 'Ident' ? this.lookupAt(root.name) : undefined;
    if (root.kind !== 'Ident' || !found || found.binding.kind !== 'local') {
      this.error(Codes.NotMutable, target.span, `can only ${verb} a \`let mut\` variable or its fields`);
      return T.error;
    }
    const { binding, depth } = found;
    if (this.deferFrame && depth === this.deferFrame.bodyScope && binding.mutable) {
      this.error(
        Codes.BadDefer,
        target.span,
        `a \`defer\` cannot ${verb} \`${root.name}\`: it runs after the function has returned, so the change would be lost`,
        'a `defer` cleans up: release, close or log here, and compute results before the function returns',
      );
      return T.error;
    }
    if (!binding.mutable) {
      this.error(
        Codes.NotMutable,
        target.span,
        `cannot ${verb} \`${root.name}\`: it is not mutable`,
        binding.decl?.kind === 'Let'
          ? `declare it with \`let mut ${root.name}\``
          : `copy it into a variable first: \`let mut ${root.name}Copy = ${root.name}\``,
      );
      return T.error;
    }
    binding.mutated = true;
    if (holder?.kind === 'map' && !whole && target.kind === 'Index') {
      // `m[k] += 1`: the key may be missing, and the code should say what happens then.
      const m = pathOf(target.object) ?? 'm';
      const i = target.index;
      const k = i.kind === 'Ident' ? i.name : i.kind === 'String' ? JSON.stringify(i.value) : 'k';
      this.error(
        Codes.NotMutable,
        target.span,
        `cannot ${verb} \`${m}[${k}]\` with \`op=\`: the key may be missing`,
        `say what a missing key starts at: \`${m}[${k}] = (${m}[${k}] ?? 0) + 1\``,
      );
      return T.error;
    }
    const through = this.narrowedPart(target.kind === 'Index' ? target.object : verb === 'assign to' ? null : target);
    if (through) {
      const name = pathOf(through) ?? 'x';
      this.error(
        Codes.NotMutable,
        target.span,
        `cannot ${verb} \`${name}\` in place: it is an optional, even where a test proved it present`,
        `copy it out, change it, and assign it back: \`let mut copy = ${name} ?? ...\`, then \`${name} = copy\``,
      );
      return T.error;
    }
    if (holder?.kind === 'list' && target.kind === 'Index' && target.object.kind === 'Ident' && binding.decl?.kind === 'Let') this.indexed.add(binding.decl);
    if (this.lambda && depth < this.lambda.scopeDepth) return T.error; // reported by checkCapture
    return t;
  }

  /** The narrowed read in a place's path (`xs`, `u.items`), if any: lists and maps in one don't change in place. */
  private narrowedPart(e: ast.Expr | null): ast.Expr | null {
    for (let x = e; x; x = x.kind === 'Member' ? x.object : null) if (this.narrowed.has(x)) return x;
    return null;
  }

  /** Records the wrapping of a `T` or `none` into a `T?`; reports a mismatch if `from` doesn't fit. */
  private coerce(e: ast.Expr, from: Type, to: Type): boolean {
    if (from.kind === 'error' || to.kind === 'error') return true;
    if (from.kind !== 'none' && sameType(from, to)) return true;
    if (assignable(from, to)) {
      this.coercions.set(e, to);
      return true;
    }
    if (from.kind === 'fn' && to.kind === 'fn' && sameShape(from, to)) {
      const extra = from.uses.filter((u) => !to.uses.includes(u));
      const param = this.argFor.get(e);
      this.error(
        Codes.TypeMismatch,
        e.span,
        `this function uses ${extra.map((u) => `\`${u}\``).join(', ')}, which \`${this.show(to)}\` does not allow`,
        param
          ? // Allowing it in the type would make the function declare it too, though it only passes it on.
            `allow it in the type: \`${param.name}: ${this.show(fn(to.params, to.ret, [...to.uses, ...extra]))}\`, or put \`uses ${param.name}\` on \`${param.fn}\`: it then takes on what each function passed does, and only its callers declare that`
          : `allow it in the type: \`${this.show(fn(to.params, to.ret, [...to.uses, ...extra]))}\``,
      );
      return false;
    }
    this.mismatch(e.span, to, from);
    return false;
  }

  /**
   * `Ok(x)` / `Err(e)`: what they build comes from where they go. `given`: the types of the
   * arguments, when they were checked already (a lambda's `return` that waited).
   */
  private checkResultCtor(e: ast.Call, expected: Type | null, given?: Type[]): Type {
    const which = resultCtor(e)!;
    const check = (a: ast.Expr, i: number) => (given ? given[i] : this.checkExpr(a));
    // `Ok()`: a Result<void, E> succeeded, with nothing to give.
    const bare = which === 'Ok' && e.args.length === 0;
    if (e.args.length !== 1 && !bare) {
      e.args.forEach(check);
      this.error(Codes.ArgCount, e.span, `\`${which}\` takes one argument, found ${e.args.length}`);
      return T.error;
    }
    if (!expected || expected.kind !== 'result') {
      if (!bare) check(e.args[0], 0);
      if (expected && expected.kind !== 'error') {
        this.error(Codes.TypeMismatch, e.span, `expected ${this.show(expected)}, found \`${which}(...)\`, a Result`);
      } else if (!expected) {
        this.error(
          Codes.NeedsAnnotation,
          e.span,
          `cannot tell what kind of Result \`${which}(...)\` is`,
          'use it where a Result is expected, such as a `return`, or annotate it: `let r: Result<int, string> = ...`',
        );
      }
      return T.error;
    }
    if (bare && expected.ok.kind !== 'unit' && expected.ok.kind !== 'error') {
      this.error(Codes.ArgCount, e.span, `\`Ok()\` is a \`Result<void, E>\`, but ${this.show(expected)} holds a ${this.show(expected.ok)}`, 'give the value: `Ok(x)`');
      return T.error;
    }
    if (!bare && expected.ok.kind === 'unit' && which === 'Ok') {
      if (!given) this.checkAgainst(e.args[0], T.unit);
      this.error(Codes.ArgCount, e.args[0].span, `${this.show(expected)} holds nothing`, 'write `Ok()`');
      return T.error;
    }
    const want = which === 'Ok' ? expected.ok : expected.err;
    if (!bare && given) this.coerce(e.args[0], given[0], want);
    else if (!bare) this.checkAgainst(e.args[0], want);
    this.resultCtors.set(e, which);
    this.types.set(e, expected);
    return expected;
  }

  /** `x?`: unwrap, or return early with the error or `none`. */
  private inferTry(e: ast.Try): Type {
    const t = this.checkExpr(e.operand);
    if (t.kind === 'error') return T.error;
    if (this.deferFrame && (t.kind === 'result' || t.kind === 'option')) {
      this.error(
        Codes.BadDefer,
        e.opSpan,
        '`?` would return from a `defer`, which runs after the function has returned',
        t.kind === 'result' ? 'handle the error here with `match`' : 'say what to do when it is none: `x ?? default`, or `if x != none { ... }`',
      );
      return T.error;
    }
    if (this.contract && !this.lambda) {
      this.error(Codes.BadContract, e.opSpan, `\`?\` would return from \`${this.fn.name}\` in the middle of its \`${this.contract.clause}\``, this.contractHelp(t));
      return T.error;
    }
    if (t.kind !== 'result' && t.kind !== 'option') {
      this.error(Codes.BadTry, e.span, `\`?\` needs a Result or an optional, found ${this.show(t)}`);
      return T.error;
    }
    const frame = this.lambda;
    if (frame && frame.ret === null) {
      // Nothing has said what this lambda returns yet: check once something does.
      frame.tries.push({ span: e.span, operand: t });
      if (t.kind === 'result') frame.errHint ??= t.err;
    } else {
      this.checkTryTarget(t, e.span, this.currentRet(), this.currentName(), false);
    }
    return t.kind === 'result' ? t.ok : t.inner;
  }

  /** Whether `?` on `t` can return early from something returning `ret`. `inferred`: a lambda's guessed result. */
  private checkTryTarget(t: ResultType | OptionType, span: Span, ret: Type, who: string, inferred: boolean) {
    if (ret.kind === 'error') return;
    if (t.kind === 'result') {
      const err = this.show(t.err);
      if (ret.kind !== 'result') {
        const ok = ret.kind === 'unit' ? (inferred ? 'T' : 'void') : this.show(ret);
        this.error(
          Codes.BadTry,
          span,
          `\`?\` passes the error on, but ${who} returns ${this.show(ret)}`,
          inferred
            ? `annotate it: \`(...): Result<${ok}, ${err}> => ...\``
            : who === '`main`'
              ? `return \`Result<void, ${err}>\` (an \`Err\` from \`main\` is printed on stderr and exits with status 1; \`Result<void, Exit>\` picks the status), or handle the error with \`match\``
              : `return \`Result<${ok}, ${err}>\`, or handle the error with \`match\``,
        );
      } else if (!sameType(ret.err, t.err)) {
        this.error(
          Codes.BadTry,
          span,
          `\`?\` would pass on a ${err} error, but ${who} returns ${this.show(ret)}`,
          'there is no automatic error conversion; convert it with `match`',
        );
      }
      return;
    }
    if (ret.kind !== 'option') {
      this.error(
        Codes.BadTry,
        span,
        `\`?\` on an optional returns \`none\`, but ${who} returns ${this.show(ret)}`,
        inferred
          ? 'annotate it: `(...): T? => ...`'
          : ret.kind === 'result'
            ? 'handle `none` with `match` or `??`'
            : `make ${who} return \`${this.show(ret)}?\`, or use \`??\``,
      );
    }
  }

  /** `x ?? d`: `d` must fit the `T` in `x: T?`; a `T?` on the right keeps the result optional. */
  private inferCoalesce(e: ast.Binary): Type {
    const l = this.checkExpr(e.left);
    if (l.kind !== 'option') {
      // `x ?? .Default` on a present `x`: the one error is the `??`.
      if (e.right.kind === 'StructLit' && e.right.short && l.kind !== 'error') this.checkAgainst(e.right, l);
      else this.checkExpr(e.right);
      if (l.kind !== 'error') {
        this.error(
          Codes.InvalidOperands,
          e.opSpan,
          `\`??\` needs an optional on its left, found ${this.show(l)}`,
          this.narrowed.has(e.left)
            ? `a test above proved it present, so here it is a ${this.show(l)}; remove \`?? ...\``
            : l.kind === 'result'
              ? // `??` would drop the error unread; the match says so where it happens.
                `a Result's error would be dropped unread: \`${e.left.kind === 'Ident' || e.left.kind === 'Member' ? exprText(e.left) : '...'}.ok() ?? ...\` drops it in plain sight, or \`?\` passes it on`
              : 'it is never `none`; remove `?? ...`',
        );
      }
      return T.error;
    }
    // `xs ?? []`, `m ?? [:]`, `r ?? Ok(1)`: the left side says what the fallback is.
    if (needsContext(e.right) && e.right.kind !== 'None') return this.checkAgainst(e.right, l.inner).kind === 'error' ? T.error : l.inner;
    const r = this.checkExpr(e.right);
    // `x ?? none` on an `int??` (from a generic function of the program) is an `int?`.
    if (l.inner.kind === 'option' && (r.kind === 'option' || r.kind === 'none')) return this.coerce(e.right, r, l.inner) ? l.inner : T.error;
    if (r.kind === 'option' || r.kind === 'none') return this.coerce(e.right, r, l) ? l : T.error;
    // `xs.first() ?? 0 > 0` is `xs.first() ?? (0 > 0)`: `??` binds looser than other operators.
    if (e.right.kind === 'Binary' && r.kind !== 'error' && l.inner.kind !== 'error' && !sameType(r, l.inner) && !assignable(r, l.inner)) {
      const op = e.right.op;
      this.error(
        Codes.TypeMismatch,
        e.right.span,
        `expected ${this.show(l.inner)}, found ${this.show(r)}`,
        `\`??\` binds looser than \`${op}\`, so this reads \`a ?? (b ${op} c)\`; for \`${op}\` on the result, write \`(a ?? b) ${op} c\``,
      );
      return T.error;
    }
    return this.coerce(e.right, r, l.inner) ? l.inner : T.error;
  }

  private lookup(name: string): Binding | undefined {
    return this.lookupAt(name)?.binding;
  }

  /** The binding and the index of the scope holding it. */
  private lookupAt(name: string): { binding: Binding; depth: number } | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b) return { binding: b, depth: i };
    }
    return undefined;
  }

  /** Closures capture by reference in Go; `let mut` values would change under the lambda. */
  private checkCapture(name: string, depth: number, span: Span) {
    if (!this.lambda || depth >= this.lambda.scopeDepth || depth === 0) return;
    this.error(
      Codes.MutCapture,
      span,
      `a lambda cannot use \`${name}\`: it is \`let mut\`, so it could change under the lambda`,
      `copy it first, outside the lambda: \`let current = ${name}\``,
    );
  }

  /** An effect named in a contract: refused, since a contract runs on every call and changes nothing. */
  private contractEffect(name: string, span: Span, what: string | null) {
    this.error(
      Codes.BadContract,
      span,
      `${what === null ? `\`${name}\` is an effect` : `${what} uses \`${name}\``}, but a \`${this.contract!.clause}\` cannot use effects`,
      `a contract runs on every call and must not change anything: check this in the body of \`${this.fn.name}\`, or pass in the value it needs`,
    );
  }

  /** The help for `?` in a contract: what to write for each kind of value. */
  private contractHelp(t: Type): string {
    return t.kind === 'option'
      ? 'say what holds when it is none: `x != none && ...`, or `(x ?? default) ...`'
      : 'say what holds for each case: `match r { Ok(v) => v > 0, Err(_) => true }`';
  }

  /** The current function or lambda performs `effects` here: it must have them. */
  private perform(effects: string[], span: Span, what: string, report = true) {
    for (const name of effects) {
      if (this.contract && report) {
        this.contractEffect(name, span, what);
      } else if (this.fn.uses.includes(name)) {
        this.scopes[0].get(name)!.used = true;
        this.lambda?.used.add(name);
      } else if (this.fn.effectParams.includes(name)) {
        this.effectParamsUsed.add(name);
        this.lambda?.used.add(name);
      } else if (report) {
        this.error(
          Codes.UndeclaredEffect,
          span,
          `${what} uses \`${name}\`, which \`${this.fn.name}\` does not declare`,
          this.addEffectHelp(name),
        );
      }
    }
  }

  private currentRet(): Type {
    return this.lambda ? (this.lambda.ret ?? T.unit) : this.fn.ret;
  }

  private currentName(): string {
    return this.lambda ? 'this lambda' : `\`${this.fn.name}\``;
  }

  /** Candor has no shadowing: a name means one thing everywhere it is visible. */
  private bind(name: string, binding: Binding, span: Span) {
    if (name === '_') {
      this.error(Codes.NotAValue, span, '`_` is not a name', 'to discard a value, call it on its own line');
      return;
    }
    const fn = this.fns.get(name);
    const outer = name === this.rebindable ? this.lookupAt(name) : undefined;
    const rebinds = outer !== undefined && outer.binding.kind === 'local' && outer.depth < this.scopes.length - 1;
    if (rebinds) this.rebound = true;
    // A test-only name is no clash in program code, which never sees it.
    const seen = this.testSide || !this.testOnly.has(name);
    const clash = rebinds
      ? null
      : this.lookup(name)
      ? 'is already defined'
      : // An effect's externs are names only its operations can see.
        fn && (!fn.privateTo || fn.privateTo === this.inOps) && seen
        ? 'is already a function'
        : this.values.has(name) && seen
          ? (this.values.get(name)!.decl.kind === 'ConstDecl' ? 'is already a const' : 'is already a binding')
          : this.userTypes.has(name) && seen
          ? 'is the name of a type'
          : this.typeParams.has(name)
          ? 'is the name of a type parameter'
          : this.effectType(name)
            ? 'is the name of an effect'
            : this.imports.has(name)
              ? 'is the name of an imported module'
              : null;
    // Bound anyway: what follows means the new value, and checking it against the old one
    // would only add errors about a name already reported.
    const help = this.imports.has(name) && clash === 'is the name of an imported module'
      ? `Candor has no shadowing; pick another name, or import the module under another, \`import "${this.imports.get(name)!.module}" as ${name[0]}\``
      : 'Candor has no shadowing; pick another name';
    if (clash) this.error(Codes.Duplicate, span, `\`${name}\` ${clash}`, help);
    this.scopes[this.scopes.length - 1].set(name, binding);
    // Without shadowing, a name can only come back after its scope ended: what was known is gone.
    this.facts = without(this.facts, name);
  }

  private popScope() {
    for (const [name, b] of this.scopes.pop()!) {
      if (b.mutable && !b.mutated && b.decl?.kind === 'Let' && b.type.kind !== 'error') {
        this.warn(Codes.NeedlessMut, b.decl.nameSpan, `\`${name}\` never changes`, 'declare it with `let`, without `mut`');
      }
      // A name whose value already failed is reported once, not again as unused.
      if (!b.decl || b.used || b.type.kind === 'error') continue;
      this.unused.add(b.decl);
      for (const twin of b.twins ?? []) this.unused.add(twin);
      if (b.decl.kind === 'For') {
        this.warn(Codes.UnusedVariable, b.decl.nameSpan, `\`${name}\` is never used`, 'write `for _ in ...`');
      } else if (b.decl.kind === 'Let') {
        this.warn(Codes.UnusedVariable, b.decl.nameSpan, `\`${name}\` is never used`);
      } else {
        this.warn(
          Codes.UnusedVariable,
          b.decl.span,
          `\`${name}\` is never used`,
          'match it with `_`, or leave the field out of the pattern',
        );
      }
    }
  }

  private checkMain() {
    const main = this.fns.get('main');
    if (!main) {
      this.error(
        Codes.NoMain,
        this.mod.nameSpan,
        `module \`${this.mod.name}\` has no \`main\` function`,
        'add `fn main() { ... }`',
      );
      return;
    }
    const ret = main.ret;
    const result = ret.kind === 'result' && ret.ok.kind === 'unit';
    if (main.params.length > 0 || (ret.kind !== 'unit' && !result) || main.typeParams.length > 0) {
      this.error(
        Codes.MainSignature,
        main.decl.nameSpan,
        '`main` takes no parameters and returns nothing, or `Result<void, E>`',
        'write `fn main() { ... }`, or `fn main() -> Result<void, E> { ... }` to exit with status 1 on an `Err` (with `E` = `Exit`, `Err(Exit { status: 2, message: "..." })` exits 2)',
      );
    }
  }

  private checkStmt(stmt: ast.Stmt) {
    switch (stmt.kind) {
      case 'Let': {
        let type: Type;
        if (stmt.type) {
          type = this.resolveType(stmt.type);
          if (type.kind === 'error') this.checkExpr(stmt.value);
          else if (this.checkAgainst(stmt.value, type).kind === 'error') type = T.error;
        } else {
          type = this.checkExpr(stmt.value);
          if (type.kind === 'unit') {
            this.error(
              Codes.NoValue,
              stmt.value.span,
              'this expression has no value',
              stmt.value.kind === 'Call' ? 'call it on its own line instead of assigning it' : undefined,
            );
            type = T.error;
          } else if (type.kind === 'none') {
            this.error(
              Codes.NeedsAnnotation,
              stmt.value.span,
              'cannot tell what kind of value this `none` is missing',
              `annotate it: \`let ${stmt.name}: string? = none\``,
            );
            type = T.error;
          }
        }
        this.bind(stmt.name, { kind: 'local', type, used: false, decl: stmt, mutable: stmt.mutable }, stmt.nameSpan);
        return;
      }
      case 'LetTuple': {
        let type: Type;
        if (stmt.type) {
          type = this.resolveType(stmt.type);
          if (type.kind === 'error') this.checkExpr(stmt.value);
          else if (this.checkAgainst(stmt.value, type).kind === 'error') type = T.error;
        } else {
          type = this.checkExpr(stmt.value);
        }
        this.destructure(stmt.pattern, type, 'a `let`');
        return;
      }
      case 'Return': {
        if (this.deferFrame) {
          this.error(Codes.BadDefer, stmt.span, 'a `defer` cannot `return`: it runs after the function has returned', 'to skip the rest of the cleanup, put it in an `if`');
          return;
        }
        if (this.contract && !this.lambda) {
          this.error(Codes.BadContract, stmt.span, `a \`${this.contract.clause}\` cannot return from \`${this.fn.name}\``, 'a contract is a condition: give the branch a bool value instead of returning');
          return;
        }
        if (this.lambda && this.lambda.ret === null) {
          // A lambda without a known result: every `return` says what it can, and the body's end
          // puts them together (`settleReturns`).
          const leaves = new Map<ast.Expr, Type>();
          const v = stmt.value;
          this.lambda.pending.push({ value: v, span: stmt.span, shape: v ? this.shapeOf(v, leaves) : T.unit, leaves });
          return;
        }
        const ret = this.currentRet();
        if (stmt.value === null) {
          if (ret.kind !== 'unit') {
            this.error(
              Codes.TypeMismatch,
              stmt.span,
              `${this.currentName()} returns ${this.show(ret)} but this \`return\` has no value`,
            );
          }
          return;
        }
        if (ret.kind !== 'unit') {
          this.checkAgainst(stmt.value, ret);
          return;
        }
        const t = this.checkExpr(stmt.value);
        this.error(
          Codes.TypeMismatch,
          stmt.value.span,
          `${this.currentName()} returns nothing, but this \`return\` has a value`,
          this.lambda ? undefined : `add \`-> ${this.show(t)}\` to the signature, or drop the value`,
        );
        return;
      }
      case 'Assert': {
        if (!this.inTest) {
          this.error(
            Codes.AssertOutsideTest,
            stmt.span,
            '`assert` only works inside `test` blocks',
            'for a failure the caller should handle, return a `Result`; a helper for tests that asserts is a `test fn`',
          );
        }
        const t = this.checkExpr(stmt.expr);
        if (t.kind !== 'bool' && t.kind !== 'error') {
          this.error(Codes.ConditionNotBool, stmt.expr.span, `\`assert\` needs a bool, found ${this.show(t)}`);
        }
        return;
      }
      case 'Assign': {
        this.checkAssign(stmt);
        this.assigned(stmt);
        return;
      }
      case 'For': {
        // What the body assigns may change from one step to the next.
        const before = withoutAll(this.facts, assignedPaths(stmt.body));
        this.facts = before;
        let elem: Type;
        if (stmt.end) {
          this.checkAgainst(stmt.iterable, T.int);
          this.checkAgainst(stmt.end, T.int);
          elem = T.int;
        } else {
          const t = this.checkExpr(stmt.iterable);
          if (t.kind === 'map') {
            elem = stmt.pattern ? { kind: 'tuple', elems: [t.key, t.value] } : t.key;
            if (!stmt.pattern) {
              this.error(Codes.NotIterable, stmt.nameSpan, 'a map gives a key and a value per step', `write \`for (${stmt.name}, value) in ...\`, or loop over \`.keys()\``);
            }
          } else if (t.kind === 'list' || (t.kind === 'handle' && t.handle === 'Channel')) {
            elem = t.kind === 'list' ? t.elem : t.arg;
            if (stmt.pattern && elem.kind !== 'tuple' && elem.kind !== 'error') {
              const help = t.kind === 'list' ? 'write `for x in ...`; to number the items, loop over `.enumerated()`' : 'write `for x in ...`';
              this.error(Codes.NotIterable, stmt.pattern.span, `this ${t.kind === 'list' ? 'list' : 'channel'} gives one ${this.show(elem)} per step`, help);
              elem = T.error;
            }
          } else {
            if (t.kind !== 'error') {
              this.error(
                Codes.NotIterable,
                stmt.iterable.span,
                `cannot loop over ${this.show(t)}`,
                t.kind === 'int'
                  ? 'to count, use a range: `for i in 0..n`'
                  : t.kind === 'bytes'
                    ? 'loop over its bytes as ints: `for x in b.toList()`'
                    : '`for` takes a List, a Map, a Channel, or a range `a..b`',
              );
            }
            elem = T.error;
          }
        }
        this.scopes.push(new Map());
        if (stmt.pattern) {
          this.destructure(stmt.pattern, elem, 'a `for` loop');
        } else if (stmt.name !== '_') {
          this.bind(stmt.name, { kind: 'local', type: elem, used: false, decl: stmt }, stmt.nameSpan);
        }
        this.loops++;
        this.checkBlock(stmt.body, 'statement');
        this.loops--;
        this.popScope();
        this.facts = before;
        return;
      }
      case 'While': {
        const before = withoutAll(this.facts, assignedPaths(stmt.body));
        this.facts = before;
        const t = this.checkExpr(stmt.cond);
        if (t.kind !== 'bool' && t.kind !== 'error') {
          this.error(Codes.ConditionNotBool, stmt.cond.span, `a \`while\` condition must be a bool, found ${this.show(t)}`);
        }
        const proved = this.proves(stmt.cond);
        this.facts = withAll(before, proved.yes);
        this.loops++;
        this.checkBlock(stmt.body, 'statement');
        this.loops--;
        // Without a `break`, the loop ends only when its condition is false.
        this.facts = breaks(stmt.body) ? before : withAll(before, proved.no);
        return;
      }
      case 'Defer': {
        if (!this.body?.stmts.includes(stmt)) {
          this.error(
            Codes.BadDefer,
            stmt.span,
            this.deferFrame ? 'a `defer` cannot hold another `defer`' : '`defer` goes at the top level of a function body',
            this.deferFrame
              ? 'put the cleanup in the same `defer`, in the order it should run'
              : 'it runs when the function ends; move it out of the block, or make the block a function of its own',
          );
        }
        // The body runs when the function ends: what is known of `let mut` values may be stale by then.
        const facts = this.facts;
        this.facts = new Set([...facts].filter((p) => !this.lookup(p.split('.')[0])?.mutable));
        const frame = this.deferFrame;
        this.deferFrame = { bodyScope: this.scopes.length - 1 };
        this.checkBlock(stmt.body, 'statement');
        this.deferFrame = frame;
        this.facts = facts;
        return;
      }
      case 'Break':
      case 'Continue':
        if (this.loops === 0) {
          const word = stmt.kind === 'Break' ? 'break' : 'continue';
          this.error(
            Codes.OutsideLoop,
            stmt.span,
            `\`${word}\` outside a loop`,
            this.lambda ? 'a lambda is its own function: loops around it do not count' : undefined,
          );
        }
        return;
      case 'ExprStmt': {
        if (stmt.expr.kind === 'If') {
          this.checkIf(stmt.expr, 'statement');
          return;
        }
        if (stmt.expr.kind === 'Match') {
          this.checkMatch(stmt.expr, 'statement');
          return;
        }
        const t = this.checkExpr(stmt.expr);
        // `save(x)?` on its own line passes the error on; what is left, like any call's value, may be dropped.
        if (stmt.expr.kind === 'Try' && (t.kind === 'unit' || t.kind === 'error')) return;
        const call = stmt.expr.kind === 'Try' ? stmt.expr.operand : stmt.expr;
        // With a `?` after it, the call's error is what the line is for: `r.mapErr(f)?` stays.
        const pure = stmt.expr.kind === 'Call' && t.kind !== 'unit' && t.kind !== 'error' ? this.readOnlyBuiltin(stmt.expr) : null;
        if (pure) {
          // Card 74cc743a: `fs.remove(p).isOk()` only reads a value, and Go refuses a dropped `r.ok`.
          const r = this.types.get(pure.object);
          const help =
            r?.kind === 'result'
              ? `to ignore the error, \`match\` it: \`match ... { ${r.ok.kind === 'unit' ? 'Ok()' : 'Ok(_)'} => {}, Err(_) => {} }\`; to pass it on, use \`?\``
              : 'assign it with `let`, or remove it';
          this.error(Codes.UnusedValue, stmt.span, `this ${this.show(t)} from \`.${pure.name}()\` is not used`, help);
        } else if (call.kind !== 'Call') {
          this.error(
            Codes.UnusedValue,
            stmt.span,
            `this ${this.show(t)} value is not used`,
            'assign it with `let`, or remove it',
          );
        } else if (t.kind === 'result') {
          this.warn(
            Codes.UnusedResult,
            stmt.span,
            `this ${this.show(t)} is dropped, so a failure would go unnoticed`,
            t.ok.kind === 'unit' ? 'pass the error on with `?`, or handle it with `match`' : 'use the value with `let`, pass the error on with `?`, or `match` it',
          );
        }
        return;
      }
    }
  }

  /**
   * A call to a built-in method that only reads its value (`r.isOk()`, `xs.isEmpty()`, `s.trim()`):
   * the callee, or null. `xs.pop()` and `m.remove(k)` change the value, so theirs may be dropped.
   */
  private readOnlyBuiltin(call: ast.Call): ast.Member | null {
    if (call.callee.kind !== 'Member') return null;
    const list = this.listCalls.get(call);
    const map = this.mapCalls.get(call);
    const builtin =
      this.methods.has(call.callee) ||
      this.resultChecks.has(call) ||
      this.wrapMaps.has(call) ||
      (list !== undefined && list !== 'pop' && list !== 'push') ||
      (map !== undefined && map !== 'remove');
    return builtin ? call.callee : null;
  }

  private checkAssign(stmt: ast.AssignStmt) {
    // `x = none` replaces a narrowed `x` whole, so it takes any `T?`; `x += 1` reads it first.
    const target = this.checkPlace(stmt.target, 'assign to', false, stmt.op === '=');
    if (target.kind === 'error') {
      this.checkExpr(stmt.value);
      return;
    }
    if (stmt.op === '=') {
      this.checkAgainst(stmt.value, target);
      return;
    }
    const v = this.checkExpr(stmt.value);
    const ok = sameType(v, target) && (target.kind === 'int' || target.kind === 'float' || (stmt.op === '+=' && target.kind === 'string'));
    if (!ok && v.kind !== 'error') {
      this.error(Codes.InvalidOperands, stmt.opSpan, `cannot apply \`${stmt.op}\` to ${this.show(target)} and ${this.show(v)}`);
    }
  }

  /** What an assignment does to what is known: `x = 5` makes `x` present, `x = f()` unknown. */
  private assigned(stmt: ast.AssignStmt) {
    const path = pathOf(stmt.target);
    if (path === null) return; // `xs[i] = v` leaves `xs` present
    if (stmt.op !== '=') {
      this.facts = withoutAll(this.facts, new Set([path]), true);
      return;
    }
    this.facts = without(this.facts, path);
    const to = this.types.get(stmt.target);
    const v = this.types.get(stmt.value);
    if (to?.kind === 'option' && v && v.kind !== 'option' && v.kind !== 'none' && v.kind !== 'error') this.facts = withAll(this.facts, new Set([path]));
  }

  /**
   * The paths a condition proves present when it is true, and when it is false. Called after
   * the condition is checked: it reads the types the check recorded.
   */
  private proves(e: ast.Expr): { yes: Facts; no: Facts } {
    const nothing = { yes: new Set<string>(), no: new Set<string>() };
    if (e.kind === 'Unary' && e.op === '!') {
      const p = this.proves(e.operand);
      return { yes: p.no, no: p.yes };
    }
    if (e.kind !== 'Binary') return nothing;
    if (e.op === '&&' || e.op === '||') {
      const a = this.proves(e.left);
      const b = this.proves(e.right);
      return e.op === '&&'
        ? { yes: union(a.yes, b.yes), no: intersect(a.no, b.no) }
        : { yes: intersect(a.yes, b.yes), no: union(a.no, b.no) };
    }
    if (e.op !== '==' && e.op !== '!=') return nothing;
    const tested = this.presence(e.left, e.right) ?? this.presence(e.right, e.left);
    if (!tested) return nothing;
    const one = new Set([tested.path]);
    // `x == none` proves `x` present when false; `x == 5` when true.
    const whenEqual = !tested.againstNone;
    return (e.op === '==') === whenEqual ? { yes: one, no: new Set() } : { yes: new Set(), no: one };
  }

  /** `side == other` tests whether `side`, a path to a `T?`, is present: against `none`, or a plain `T`. */
  private presence(side: ast.Expr, other: ast.Expr): { path: string; againstNone: boolean } | null {
    const path = this.localPath(side);
    if (path === null || this.types.get(side)?.kind !== 'option') return null;
    if (other.kind === 'None') return { path, againstNone: true };
    const t = this.types.get(other);
    if (!t || t.kind === 'option' || t.kind === 'none' || t.kind === 'error') return null;
    return { path, againstNone: false };
  }

  /** `x` or `x.a.b` starting at a local: the path facts are about. Anything else has none. */
  private localPath(e: ast.Expr): string | null {
    let root = e;
    while (root.kind === 'Member') {
      if (this.moduleRefs.has(root) || this.variantRefs.has(root) || this.methods.has(root)) return null;
      root = root.object;
    }
    return root.kind === 'Ident' && this.refs.get(root) === 'local' ? pathOf(e) : null;
  }

  /** A read of a `T?`: the `T` where a test proved it present. */
  private narrow(e: ast.Expr, t: Type): Type {
    if (t.kind !== 'option') return t;
    const path = this.localPath(e);
    if (path === null || !this.facts.has(path)) return t;
    this.narrowed.set(e, t);
    return t.inner;
  }

  /** Undoes `narrow` on `e`: it is used as the `T?` it is. */
  private widen(e: ast.Expr): Type | undefined {
    const wide = this.narrowed.get(e);
    if (!wide) return undefined;
    this.narrowed.delete(e);
    this.types.set(e, wide);
    return wide;
  }

  /** `asCallee`: the expression is directly called, which methods on built-in types require. */
  private checkExpr(e: ast.Expr, asCallee = false): Type {
    const t = this.infer(e, asCallee);
    this.types.set(e, t);
    return t;
  }

  private infer(e: ast.Expr, asCallee: boolean): Type {
    switch (e.kind) {
      case 'String':
        return T.string;
      case 'Interp':
        return this.inferInterp(e);
      case 'Int':
        this.constInt(e, BigInt(e.value));
        return T.int;
      case 'Bool':
        return T.bool;
      case 'Char':
        return T.char;
      case 'Float':
        if (!Number.isFinite(Number(e.value))) {
          this.error(Codes.IntegerOverflow, e.span, `${e.value} does not fit in a float (64-bit)`, 'a float reaches about 1.8e308');
        }
        return T.float;
      case 'None':
        return { kind: 'none' };
      case 'Ident':
        return this.inferIdent(e, asCallee);
      case 'Lambda':
        return this.checkLambda(e, null, null);
      case 'ListLit':
        return this.inferList(e, null);
      case 'MapLit':
        return this.inferMap(e, null);
      case 'TupleLit':
        return this.inferTuple(e, null);
      case 'Index':
        return this.inferIndex(e);
      case 'Member':
        return this.inferMember(e, asCallee);
      case 'Call': {
        if (resultCtor(e)) return this.checkResultCtor(e, null);
        const t = this.inferCall(e);
        const ref = e.callee.kind === 'Member' ? this.moduleRefs.get(e.callee) : undefined;
        if (ref?.module === 'sql' && ['exec', 'insert', 'query', 'queryOne'].includes(ref.name)) this.sqlCalls.push({ call: e, name: ref.name, ret: t });
        if (ref?.module === 'flags' && ref.name === 'parse') this.checkFlagsCall(e, t);
        if (ref?.module === 'sql' && ref.name === 'function') this.checkSqlFunction(e);
        return t;
      }
      case 'Try':
        return this.inferTry(e);
      case 'Unary':
        return this.inferUnary(e);
      case 'Binary':
        return this.inferBinary(e);
      case 'Range': {
        // A mismatch is reported against `int`; the range is still a list of them.
        this.checkAgainst(e.start, T.int);
        this.checkAgainst(e.end, T.int);
        return { kind: 'list', elem: T.int };
      }
      case 'If':
        return this.ifType(e, 'value');
      case 'Match':
        return this.matchType(e, 'value');
      case 'StructLit':
        return this.inferStructLit(e);
    }
  }

  private inferUnary(e: ast.Unary): Type {
    if (e.op === '-' && e.operand.kind === 'Int') {
      // `-9223372036854775808` is in range even though its digits alone are not.
      this.types.set(e.operand, T.int);
      this.constInt(e, -BigInt(e.operand.value));
      return T.int;
    }
    const t = this.checkExpr(e.operand);
    if (t.kind === 'error') return T.error;
    const want = e.op === '-' ? (t.kind === 'float' ? T.float : T.int) : T.bool;
    if (!sameType(t, want)) {
      this.error(Codes.InvalidOperands, e.span, `cannot apply \`${e.op}\` to ${this.show(t)}`);
      return T.error;
    }
    const c = this.consts.get(e.operand);
    if (c !== undefined) this.constInt(e, -c);
    return want;
  }

  /** `"n: ${n}"`: strings, ints, bools and the other `Show` types. Anything else needs saying how it reads. */
  private inferInterp(e: ast.Interp): Type {
    for (const part of e.parts) {
      if (typeof part === 'string') continue;
      const t = this.checkExpr(part);
      if (this.lacks(t, Show) === null) continue;
      const x = part.kind === 'Ident' || part.kind === 'Member' ? exprText(part) : 'x';
      const field = t.kind === 'struct' ? t.fields.find((f) => f.type.kind === 'string' || f.type.kind === 'int' || f.type.kind === 'bool') : undefined;
      const help = field
        ? `interpolate its fields, like \`\${${x}.${field.name}}\``
        : t.kind === 'enum'
          ? 'turn it into a string with a `match` first'
          : t.kind === 'bytes'
            ? `show them as \`\${${x}.toHex()}\`, or as text with \`${x}.toText()\` (a \`string?\`, \`none\` unless they are UTF-8)`
            : undefined;
      // Its own type, a type parameter, or one holding them: it can be given `Show`.
      const give = this.boundHelp(t, Show);
      const why = this.lacks(t, Show);
      const found = showInner(t).length > 0 || this.impls.has(implKey(Show, t)) ? `${this.show(t)}: ${why}` : this.show(t);
      this.error(Codes.TypeMismatch, part.span, `\`\${ }\` shows a type with \`Show\` (string, int, bool, lists, maps, optionals and Results of those, and types with \`impl Show\`), found ${found}`, give && help ? `${give}, or ${help}` : (give ?? help));
    }
    return T.string;
  }

  private inferBinary(e: ast.Binary): Type {
    if (e.op === '??') return this.inferCoalesce(e);
    if (e.op === '==' || e.op === '!=') return this.inferEquality(e);
    const l = this.checkExpr(e.left);
    // `x != none && x > 3`, `x == none || x > 3`: the right side runs only when the left says so.
    const before = this.facts;
    if (e.op === '&&' || e.op === '||') {
      const proved = this.proves(e.left);
      this.facts = withAll(before, e.op === '&&' ? proved.yes : proved.no);
    }
    const r = this.checkExpr(e.right);
    this.facts = before;
    if (l.kind === 'error' || r.kind === 'error') return T.error;
    const bad = (help?: string): Type => {
      const optional = l.kind === 'option' ? e.left : r.kind === 'option' ? e.right : null;
      this.error(
        Codes.InvalidOperands,
        e.opSpan,
        `cannot apply \`${e.op}\` to ${this.show(l)} and ${this.show(r)}`,
        help ?? (optional ? this.optionalHelp(optional) : undefined),
      );
      return T.error;
    };
    const both = (kind: Type['kind']) => l.kind === kind && r.kind === kind;
    // An int and a float never mix: say which way to convert.
    const mixed = () => (l.kind === 'int' && r.kind === 'float') || (l.kind === 'float' && r.kind === 'int');
    const mixHelp = () => {
      const side = l.kind === 'int' ? e.left : e.right;
      const x = side.kind === 'Ident' || side.kind === 'Member' ? exprText(side) : side.kind === 'Int' ? side.value : 'n';
      return side.kind === 'Int'
        ? `an int and a float never mix; write the int as a float: \`${x}.0\``
        : `an int and a float never mix; convert the int: \`${x}.toFloat()\` (or the float to an int with \`.round()\`)`;
    };
    switch (e.op) {
      case '&&':
      case '||':
        return both('bool') ? T.bool : bad();
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (mixed()) return bad(mixHelp());
        if (!sameType(l, r)) return bad();
        const why = this.lacks(l, Ord);
        return why ? bad(`${why}: ${this.boundHelp(l, Ord) ?? '`<` compares int, string, and types with `impl Ord`'}`) : T.bool;
      }
      case '+':
        if (both('string')) return T.string;
        if (both('float')) return T.float;
        if (both('int')) {
          this.foldInt(e);
          return T.int;
        }
        if (mixed()) return bad(mixHelp());
        if (l.kind === 'string' || r.kind === 'string') {
          const other = l.kind === 'string' ? r : l;
          if (other.kind !== 'int' && other.kind !== 'bool' && other.kind !== 'char' && other.kind !== 'float') return bad(`\`+\` never converts implicitly; call \`.toString()\` on the ${this.show(other)}`);
          const side = l.kind === 'string' ? e.right : e.left;
          const x = side.kind === 'Ident' || side.kind === 'Member' ? exprText(side) : 'x';
          return bad(`\`+\` never converts implicitly; interpolate the ${this.show(other)}, as in \`"...\${${x}}"\`, or call \`.toString()\` on it`);
        }
        if (both('list')) {
          const named = (x: ast.Expr) => x.kind === 'Ident' || x.kind === 'Member';
          const call = named(e.left) && named(e.right) ? `${exprText(e.left)}.concat(${exprText(e.right)})` : 'a.concat(b)';
          return bad(`there is no \`+\` on lists; join them with \`${call}\``);
        }
        if (both('bytes')) return bad('there is no `+` on Bytes; join them with `a.concat(b)`');
        return bad();
      case '-':
      case '*':
      case '/':
      case '%':
        if (both('float')) return T.float;
        if (mixed()) return bad(mixHelp());
        if (!both('int')) return bad();
        this.foldInt(e);
        return T.int;
    }
  }

  /**
   * `==` and `!=` compare by value, deeply: structs field by field, lists item by item. Either
   * side may need the other for context (`r == Ok(1)`, `x == none`), and a `T` meets a `T?`.
   */
  private inferEquality(e: ast.Binary): Type {
    // A lambda isn't compared, so it never takes the other side's type.
    const vague = (x: ast.Expr) => x.kind !== 'Lambda' && needsContext(x);
    let l: Type;
    let r: Type;
    if (vague(e.left) && !vague(e.right)) {
      r = this.checkExpr(e.right);
      l = r.kind === 'error' ? this.checkExpr(e.left) : this.checkAgainst(e.left, r);
    } else {
      l = this.checkExpr(e.left);
      if (!vague(e.right) && (e.right.kind === 'Call' || e.right.kind === 'StructLit' || e.right.kind === 'Member')) this.hint = l;
      r = vague(e.right) && l.kind !== 'error' && l.kind !== 'none' ? this.checkAgainst(e.right, l) : this.checkExpr(e.right);
      this.hint = null;
    }
    if (l.kind === 'error' || r.kind === 'error') return T.error;
    const bad = (help?: string): Type => {
      this.error(Codes.InvalidOperands, e.opSpan, `cannot apply \`${e.op}\` to ${this.show(l)} and ${this.show(r)}`, help);
      return T.error;
    };
    if (l.kind === 'none' && r.kind === 'none') return bad('compare an optional value with `none`');
    let t: Type;
    if (sameType(l, r)) t = l;
    else if (assignable(r, l)) {
      this.coerce(e.right, r, l);
      t = l;
    } else if (assignable(l, r)) {
      this.coerce(e.left, l, r);
      t = r;
    } else return bad();
    // Testing for `none` compares no values, so any `T?` can be tested.
    if (!comparable(t) && e.left.kind !== 'None' && e.right.kind !== 'None') {
      const p = [...paramsIn(t)].find((x) => !x.bounds.includes(Eq));
      return bad(`${this.whyNotEq(t)}${p ? `: ${this.boundHelp(p, Eq)}` : ''}`);
    }
    return T.bool;
  }

  /** Go rejects constant division by zero and constant overflow, so Candor must reject them first. */
  private foldInt(e: ast.Binary) {
    const b = this.consts.get(e.right);
    if ((e.op === '/' || e.op === '%') && b === 0n) {
      this.error(
        Codes.DivisionByZero,
        e.right.span,
        `division by zero: this divisor of \`${e.op}\` is always 0`,
        e.op === '/'
          ? 'it would panic every time; for a divisor that can be 0 at run time, `a.checkedDiv(b)` gives `none` for it'
          : 'it would panic every time; for a divisor that can be 0 at run time, test `b != 0` first',
      );
      return;
    }
    const a = this.consts.get(e.left);
    if (a === undefined || b === undefined) return;
    // BigInt division truncates toward zero and `%` takes the dividend's sign, as in Go.
    const v =
      e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : e.op === '/' ? a / b : a % b;
    this.constInt(e, v);
  }

  private constInt(e: ast.Expr, v: bigint) {
    if (v >= INT_MIN && v <= INT_MAX) {
      this.consts.set(e, v);
      return;
    }
    this.error(
      Codes.IntegerOverflow,
      e.span,
      e.kind === 'Int'
        ? `${e.value} does not fit in int (64-bit)`
        : `this constant expression overflows int (64-bit): it is ${v}`,
      e.kind === 'Int'
        ? `int ranges from ${INT_MIN} to ${INT_MAX}`
        : `int ranges from ${INT_MIN} to ${INT_MAX}; to wrap around on purpose, \`a.wrappingAdd(b)\` (and \`wrappingSub\`, \`wrappingMul\`)`,
    );
  }

  private inferIdent(e: ast.Ident, asCallee: boolean): Type {
    if (e.typeArgs && !asCallee) {
      this.error(Codes.TypeArgs, e.typeArgs.span, `\`${e.name}\` takes no type arguments here`, 'they go on a call of a generic function, `first<int>(xs)`, or on a generic type, `Tree<int>.Leaf`');
    }
    const found = this.lookupAt(e.name);
    if (found) {
      const { binding, depth } = found;
      binding.used = true;
      this.refs.set(e, binding.kind);
      if (binding.kind === 'effect') this.lambda?.used.add(e.name);
      else if (binding.mutable) this.checkCapture(e.name, depth, e.span);
      if (binding.mutable && binding.type.kind === 'map') this.mutMapReads.add(e);
      if (binding.mutable && binding.type.kind === 'list') this.mutListReads.add(e);
      return binding.kind === 'local' ? this.narrow(e, binding.type) : binding.type;
    }
    const sig = this.fns.get(e.name);
    if (sig) {
      this.refs.set(e, 'fn');
      if (sig.privateTo && this.inOps !== sig.privateTo) this.privateExtern(e.span, sig);
      this.testFnOutsideTest(e.span, sig);
      if (sig.decl.kind !== 'FnDecl' || sig.decl.test === undefined) this.testFileOnly(e.span, e.name);
      if (!asCallee && !this.valueFn(e.span, sig, sig.name)) return T.error;
      if (!asCallee) {
        // As a value it carries our capabilities along, so we must have them.
        for (const u of sig.uses) {
          if (this.contract) {
            this.contractEffect(u, e.span, `\`${sig.name}\``);
          } else if (this.fn.uses.includes(u)) {
            this.scopes[0].get(u)!.used = true;
          } else {
            this.error(
              Codes.UndeclaredEffect,
              e.span,
              `\`${sig.name}\` uses \`${u}\`, so passing it on needs \`${u}\`, which \`${this.fn.name}\` does not declare`,
              this.addEffectHelp(u),
            );
          }
        }
      }
      return sig.type;
    }
    const value = this.values.get(e.name);
    if (value) {
      this.refs.set(e, 'value');
      this.testFileOnly(e.span, e.name);
      // Go folds consts, and rejects the overflow and division by zero that folding finds.
      if (typeof value.value === 'bigint') this.consts.set(e, value.value);
      return value.type;
    }
    const effect = this.effectType(e.name);
    if (effect) {
      if (this.contract) {
        this.contractEffect(e.name, e.span, null);
      } else {
        this.error(
          Codes.UndeclaredEffect,
          e.span,
          `\`${e.name}\` is used here but \`${this.fn.name}\` does not declare it`,
          this.addEffectHelp(e.name),
        );
      }
      // Carry on as if it were declared, so the rest of the expression is still checked.
      this.refs.set(e, 'effect');
      return effect;
    }
    if (this.imports.has(e.name)) {
      const first = publicNames(this.imports.get(e.name)!)[0] ?? 'name';
      this.error(Codes.NotAValue, e.span, `\`${e.name}\` is a module, not a value`, `name one of its declarations, as in \`${e.name}.${first}\``);
      return T.error;
    }
    if (e.name === '_') {
      this.error(Codes.NotAValue, e.span, '`_` ignores a value, so it cannot be read', 'give it a name to use it: in a pattern, `x`; as a lambda parameter, `(x) => ...`');
      return T.error;
    }
    const habit = habits.get(e.name);
    if (habit) {
      this.error(Codes.UnknownName, e.span, habit[0], habit[1]);
      return T.error;
    }
    const ty = this.userTypes.get(e.name);
    if (ty) {
      this.notAValue(e.span, ty);
      return T.error;
    }
    if (this.helperOf?.ownState.some((s) => s.name === e.name)) {
      // Once per helper and name: an operation written without `pub` would say it at every use.
      const key = `${this.fn.name}.${e.name}`;
      if (this.stateSeen.has(key)) return T.error;
      this.stateSeen.add(key);
      this.error(
        Codes.UnknownName,
        e.span,
        `\`${e.name}\` is the state of \`effect ${this.helperOf.name}\`, which its helpers don't see`,
        `take it as a parameter, and have the operation pass it in: \`${this.fn.name}(${e.name}, ...)\`; if \`${this.fn.name}\` is meant to be an operation, write \`pub fn ${this.fn.name}\``,
      );
      return T.error;
    }
    const visible = this.scopes.flatMap((s) => [...s.keys()]);
    const candidates = [...visible, ...this.fns.keys(), ...this.values.keys(), ...this.effectNames(), ...this.imports.keys()];
    const near = suggest(e.name, candidates);
    const alias = [...this.imports].find(([as, m]) => m.module === e.name && as !== e.name)?.[0];
    this.error(Codes.UnknownName, e.span, `cannot find \`${e.name}\``, alias ? `this file imports \`${e.name}\` as \`${alias}\`; write \`${alias}\`` : near && `did you mean \`${near}\`?`);
    return T.error;
  }

  private inferMember(e: ast.Member, asCallee: boolean): Type {
    const hint = this.takeHint();
    const imported = this.importedModule(e.object, e.name);
    if (e.typeArgs && !(imported && asCallee)) {
      this.error(Codes.TypeArgs, e.typeArgs.span, `\`${e.name}\` takes no type arguments here`, 'they go on a call of a generic function, `first<int>(xs)`, or on a generic type, `Tree<int>.Leaf`');
    }
    if (imported) return this.moduleMember(e, imported, asCallee);
    const typePath = this.typeNamed(e.object);
    if (typePath) {
      // `Status.Pending`: a variant used as a value.
      let target = this.resolveCtor([...typePath, e.name], e.span);
      if (!target || target.kind !== 'variant') return T.error;
      const written = e.object.kind === 'Ident' || e.object.kind === 'Member' ? e.object.typeArgs : undefined;
      const origin = target.type;
      if (written) {
        const inst = this.applyTypeArgs(origin, written.types, written.span, this.declName(origin));
        if (inst.kind !== 'enum') return T.error;
        target = withType(target, inst);
      } else if (origin.params.length > 0 && target.variant.fields.length === 0) {
        // `Tree.Leaf` says nothing of `T`: where it goes does, or the help says what to write.
        const variant = target.variant.name;
        const known = new Map<ParamType, Type>();
        this.fromHint(e.span, `\`${this.declName(origin)}.${variant}\``, origin.params, known, new Map(), origin, hint);
        if (!this.allKnown(e.span, `\`${this.declName(origin)}.${variant}\` doesn't say`, origin.params, known, origin, hint, (args) => `${this.declName(origin)}<${args}>.${variant}`)) return T.error;
        const args = origin.params.map((p) => known.get(p)!);
        if (!this.checkBounds(origin.params, args, e.span, `\`${this.declName(origin)}\``)) return T.error;
        target = withType(target, instantiate(origin, args));
      }
      if (target.variant.fields.length > 0) {
        const fields = target.variant.fields.map((f) => `${f.name}: ...`).join(', ');
        this.error(
          Codes.NotAValue,
          e.span,
          `\`${this.ctorName(target)}\` has fields, so it needs them`,
          `write \`${this.ctorName(target)} { ${fields} }\``,
        );
        return T.error;
      }
      this.variantRefs.set(e, target);
      return target.type;
    }
    return this.memberOf(e, this.checkExpr(e.object), asCallee);
  }

  /**
   * The module `e` names, if it is the name of an imported module and `member` is one of its
   * declarations. A module's effect has the module's name: `http.get`, an operation, goes
   * through the effect, which the caller must declare.
   */
  private importedModule(e: ast.Expr, member: string): CheckResult | null {
    if (e.kind !== 'Ident') return null;
    const b = this.lookup(e.name);
    if (b && b.kind !== 'effect') return null;
    const mod = this.imports.get(e.name);
    if (!mod) return null;
    const fx = mod.effect;
    if (fx && (fx.ops.has(member) || fx.steering.has(member) || fx.fake?.state.some((s) => s.name === member))) return null;
    return mod;
  }

  /**
   * Whether a function can be used as a value. A generic one can't: Go needs its type arguments,
   * and a call is where they come from. Nor can one that takes on its callback's effects.
   */
  private valueFn(span: Span, sig: FnSig, name: string): boolean {
    if (sig.typeParams.length === 0 && sig.effectParams.length === 0) return true;
    const ps = sig.params.map((p) => p.name).join(', ');
    this.error(
      Codes.NotAValue,
      span,
      sig.typeParams.length > 0
        ? `\`${name}\` is generic, so it can only be called`
        : `\`${name}\` takes on the effects of the function it is given, so it can only be called`,
      `wrap it in a lambda: \`(${ps}) => ${name}(${ps})\``,
    );
    return false;
  }

  private notAValue(span: Span, ty: UserType) {
    const name = this.show(ty);
    this.error(
      Codes.NotAValue,
      span,
      `\`${name}\` is a type, not a value`,
      ty.kind === 'struct'
        ? `construct one with \`${name} { ... }\``
        : `name a variant, as in \`${name}.${ty.variants[0]?.name ?? 'Variant'}\``,
    );
  }

  private privateExtern(span: Span, sig: FnSig) {
    const fx = this.userEffects.get(sig.privateTo!)!;
    if (fx.helpers.get(sig.name) === sig) {
      this.error(
        Codes.BadEffect,
        span,
        `\`${sig.name}\` is a helper inside \`effect ${fx.name}\`, so only its operations can call it`,
        `an operation is \`pub fn\`: make \`${sig.name}\` one, or call an operation that uses it`,
      );
      return;
    }
    this.error(
      Codes.BadEffect,
      span,
      `\`${sig.name}\` is bound inside \`effect ${sig.privateTo}\`, so only its operations can call it`,
      `call an operation instead, as in \`${sig.privateTo}.${[...this.userEffects.get(sig.privateTo!)!.ops.keys()][0] ?? 'op'}(...)\`, with \`uses ${sig.privateTo}\``,
    );
  }

  /** #79ce004a: the test file is read only by `test` and `check`, so program code can't name what it declares. */
  private testFileOnly(span: Span, name: string) {
    if (this.testSide || !this.testOnly.has(name)) return;
    const tests = `${this.file.replace(/^.*[\\/]/, '').replace(/\.candor$/, '')}_test.candor`;
    this.error(Codes.TestFile, span, `\`${name}\` is declared in ${tests}, which \`candor build\` doesn't read`, `move \`${name}\` into ${tests.replace('_test', '')} if program code needs it`);
  }

  /** A `test fn` is built only for tests, so only tests and other test fns may name it. */
  private testFnOutsideTest(span: Span, sig: FnSig) {
    if (this.inTest || sig.decl.kind !== 'FnDecl' || sig.decl.test === undefined) return;
    this.error(
      Codes.FakeOnly,
      span,
      `\`${sig.name}\` is a \`test fn\`, which only tests and other test fns can call`,
      `drop \`test\` from its declaration if it doesn't \`assert\` or use a fake's own functions`,
    );
  }

  /** `strconv.atoi`: a function or extern value of an imported module. */
  private moduleMember(e: ast.Member, mod: CheckResult, asCallee: boolean): Type {
    const sig = mod.fns.get(e.name);
    const value = mod.values.get(e.name);
    if (sig?.privateTo) {
      this.privateExtern(e.nameSpan, sig);
      return T.error;
    }
    const ty = mod.userTypes.find((t) => t.name === e.name);
    if (!sig && !value && ty) {
      this.notAValue(e.span, ty);
      return T.error;
    }
    const names = [...publicNames(mod), ...(mod.effect ? mod.effect.ops.keys() : [])];
    if ((sig && !sig.decl.pub) || (value && !value.decl.pub)) {
      this.privateDecl(e.nameSpan, `\`${e.name}\``, mod, names);
      return T.error;
    }
    if (sig) this.testFnOutsideTest(e.span, sig);
    if (!sig && !value) {
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        `module \`${mod.module}\` has no \`${e.name}\``,
        names.length > 0 ? choices(e.name, names) : `\`${mod.module}\` declares no functions`,
      );
      return T.error;
    }
    this.moduleRefs.set(e, { module: mod.module, name: e.name, kind: sig ? 'fn' : 'value' });
    if (typeof value?.value === 'bigint') this.consts.set(e, value.value);
    if (!sig) return value!.type;
    if (!asCallee && !this.valueFn(e.span, sig, `${mod.module}.${sig.name}`)) return T.error;
    // As a value it carries our capabilities along, so we must have them; a call checks its own.
    if (!asCallee) this.perform(sig.uses, e.span, `\`${mod.module}.${sig.name}\``);
    return sig.type;
  }

  /** `e.name` on a value of type `objType`, already checked. */
  private memberOf(e: ast.Member, objType: Type, asCallee: boolean): Type {
    if (objType.kind === 'error') return T.error;
    if (this.traitMethods(objType, e.name).length > 0) {
      this.error(Codes.MethodNotCalled, e.span, `\`${e.name}\` is a method and must be called`, `write \`.${e.name}(...)\``);
      return T.error;
    }
    if (objType.kind === 'map') {
      if (mapMethods.includes(e.name)) {
        this.error(Codes.MethodNotCalled, e.span, `\`${e.name}\` is a method and must be called`, `write \`.${e.name}()\``);
      } else {
        this.error(Codes.NoSuchMember, e.nameSpan, `${this.show(objType)} has no member \`${e.name}\``, mapMisnamed.get(e.name) ?? `available: ${mapMethods.join(', ')}`);
      }
      return T.error;
    }
    if (objType.kind === 'list') {
      if (listMethods.includes(e.name) || e.name === 'forEach') {
        this.error(Codes.MethodNotCalled, e.span, `\`${e.name}\` is a method and must be called`, `write \`.${e.name}()\``);
      } else {
        this.error(Codes.NoSuchMember, e.nameSpan, `${this.show(objType)} has no member \`${e.name}\``, `available: ${listMethods.join(', ')}`);
      }
      return T.error;
    }
    const handleMethods =
      objType.kind === 'effect' && objType.name === 'tasks'
        ? taskMethods
        : objType.kind === 'scope'
          ? scopeMethods
          : objType.kind === 'task'
            ? ['join']
            : objType.kind === 'handle'
              ? sharedMethods(objType)
              : null;
    if (handleMethods) {
      if (handleMethods.includes(e.name)) {
        this.error(Codes.MethodNotCalled, e.span, `\`${e.name}\` is a method and must be called`, `write \`.${e.name}(...)\``);
      } else {
        this.error(Codes.NoSuchMember, e.nameSpan, `${this.show(objType)} has no member \`${e.name}\``, `available: ${handleMethods.join(', ')}`);
      }
      return T.error;
    }
    if (objType.kind === 'struct') {
      const field = objType.fields.find((f) => f.name === e.name);
      if (field) {
        this.fieldVisible(objType, field, e.nameSpan);
        return this.narrow(e, field.type);
      }
      this.unknownField({ kind: 'struct', type: objType }, e.name, e.nameSpan);
      return T.error;
    }
    if (objType.kind === 'tuple') {
      // `pair.0`: items by position, from 0.
      const i = /^\d+$/.test(e.name) ? Number(e.name) : -1;
      if (i >= 0 && i < objType.elems.length) return this.narrow(e, objType.elems[i]);
      const items = objType.elems.map((_, j) => `\`.${j}\``).join(', ');
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        i >= 0 ? `${this.show(objType)} has ${objType.elems.length} items, so no \`.${e.name}\`` : `${this.show(objType)} has no member \`${e.name}\``,
        `its items are ${items}, from 0; or take it apart: \`let (${objType.elems.map((_, j) => String.fromCharCode(97 + j)).join(', ')}) = ...\``,
      );
      return T.error;
    }
    if (objType.kind === 'enum') {
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        `\`${objType.name}\` is an enum; which fields it has depends on the variant`,
        'use `match` to look inside',
      );
      return T.error;
    }
    if (objType.kind === 'effect') {
      const method = objType.methods.get(e.name);
      if (method) return method;
      const fx = this.userEffects.get(objType.name);
      // Tests are checked after the fake, so its state's types are known by then.
      const state = fx?.state.find((s) => s.name === e.name);
      if (state && this.inTest) {
        this.fakeState.set(e, state);
        return state.type;
      }
      if (fx?.fake?.state.some((s) => s.name === e.name)) {
        this.error(
          Codes.FakeOnly,
          e.nameSpan,
          `\`${objType.name}.${e.name}\` is the fake's state, which only \`test\` blocks can read`,
          'pass what the code needs as a parameter, or give the effect an operation for it; a helper for tests can be a `test fn`',
        );
        return T.error;
      }
      if (this.fakeOnly(objType.name, e.name)) {
        this.error(
          Codes.FakeOnly,
          e.nameSpan,
          `\`${objType.name}.${e.name}\` only exists on the fake \`${objType.name}\` inside \`test\` blocks`,
          'a helper for tests that uses it is a `test fn`, which tests call with their fakes',
        );
        return T.error;
      }
      const helper = this.userEffects.get(objType.name)?.helpers.get(e.name);
      if (helper) {
        this.privateExtern(e.nameSpan, helper);
        return T.error;
      }
      const generic = objType.name === 'random' ? ['shuffle', 'pick'] : [];
      if (generic.includes(e.name)) {
        this.error(Codes.MethodNotCalled, e.span, `\`random.${e.name}\` is generic and must be called`, `write \`random.${e.name}(xs)\``);
        return T.error;
      }
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        `effect \`${objType.name}\` has no \`${e.name}\``,
        `available: ${[...objType.methods.keys(), ...generic].join(', ')}`,
      );
      return T.error;
    }
    if (objType.kind === 'param') {
      const giving = this.visibleTraits().filter((t) => t.methods.has(e.name));
      const own = objType.bounds.flatMap((b) => [...b.methods.keys()]);
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        `\`${objType.name}\` is a type parameter, and its bounds give no \`${e.name}\``,
        giving.length > 0
          ? `add the bound: \`<${objType.name}: ${traitName(giving[0], this.mod.name)}>\``
          : own.length > 0
            ? `its bounds give: ${own.join(', ')}`
            : 'a type parameter has only the methods its bounds give: bound it by a trait that has them, `<T: SomeTrait>`',
      );
      return T.error;
    }
    const methods = primitiveMethods(objType);
    const method = methods.get(e.name);
    if (!method) {
      const available = [...methods.keys()];
      this.error(
        Codes.NoSuchMember,
        e.nameSpan,
        `${this.show(objType)} has no member \`${e.name}\``,
        objType.kind === 'option' ? this.optionalHelp(e.object) : (primitiveMisnamed(objType, e.name) ?? (available.length > 0 ? `available: ${available.join(', ')}` : undefined)),
      );
      return T.error;
    }
    if (!asCallee) {
      this.error(Codes.MethodNotCalled, e.span, `\`${e.name}\` is a method and must be called`, `write \`.${e.name}()\``);
      return T.error;
    }
    this.methods.set(e, method);
    return method.type;
  }

  /**
   * `env.load(path)`: reads a .env file into what `env.get` sees. The work is `loadEnv` in std/fs,
   * whose `FsError` it gives back, so it needs `import "fs"`; the call becomes a call to that.
   */
  private envLoad(e: ast.Call, callee: ast.Member): Type {
    const sig = this.byModule.get('fs')?.fns.get('loadEnv');
    if (!sig) {
      for (const a of e.args) this.checkExpr(a);
      this.perform(['env'], callee.span, '`env.load`');
      this.error(Codes.BadImport, callee.span, '`env.load` reads a file, so it needs `import "fs"`', 'add `import "fs"` at the top, and `uses env, fs` on the function');
      return T.error;
    }
    this.moduleRefs.set(callee, { module: 'fs', name: 'loadEnv', kind: 'fn' });
    this.types.set(callee, sig.type);
    if (e.args.length !== 1) {
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.ArgCount, e.span, `\`env.load\` takes 1 argument, the file's path, found ${e.args.length}`, 'write `env.load(".env")?`');
      return sig.type.ret;
    }
    this.checkAgainst(e.args[0], T.string);
    this.perform(sig.uses, callee.span, '`env.load`');
    return sig.type.ret;
  }

  /**
   * #862ac7c0: `env.zone()`, and the fake's `env.setZone(z)`, give and take std's `time.Zone`,
   * so the checker sends them to `envZone` and `setEnvZone` in std/time, as `env.load` goes to
   * std/fs.
   */
  private envZone(e: ast.Call, callee: ast.Member, b: Binding | undefined): Type {
    const setting = callee.name === 'setZone';
    const name = setting ? 'setEnvZone' : 'envZone';
    const what = `\`env.${callee.name}\``;
    const sig = this.byModule.get('time')?.fns.get(name);
    this.perform(['env'], callee.span, what);
    if (!sig) {
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.BadImport, callee.span, `${what} ${setting ? 'takes' : 'gives'} a \`time.Zone\`, so it needs \`import "time"\``, 'add `import "time"` at the top');
      return setting ? T.unit : T.error;
    }
    if (setting && b && b.type.kind === 'effect' && !b.type.methods.has('setPid')) {
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.NoSuchMember, callee.nameSpan, '`env.setZone` is for tests: it sets the zone the fake `env` gives', 'a running program\'s zone comes from `$TZ`, else the machine\'s; to use another, name it: `time.zone("Europe/Oslo")`');
      return T.unit;
    }
    this.moduleRefs.set(callee, { module: 'time', name, kind: 'fn' });
    this.types.set(callee, sig.type);
    if (e.args.length !== sig.params.length) {
      for (const a of e.args) this.checkExpr(a);
      const takes = setting ? '1 argument, the zone' : 'no arguments';
      this.error(Codes.ArgCount, e.span, `${what} takes ${takes}, found ${e.args.length}`, setting ? 'write `env.setZone(time.zone("Europe/Oslo") ?? time.utcZone())`' : 'write `env.zone()`');
      return sig.ret;
    }
    if (setting) this.checkAgainst(e.args[0], sig.params[0].type);
    return sig.ret;
  }

  /**
   * #0c2dc168: `flags.parse(args, defaults)` reads flags into the fields of the struct it is
   * given, so the emitter writes each call for that struct. Its fields must each be a flag.
   */
  private checkFlagsCall(e: ast.Call, t: Type) {
    const opts = t.kind === 'result' && t.ok.kind === 'tuple' ? t.ok.elems[0] : null;
    if (!opts || opts.kind === 'error' || e.args.length !== 2) return;
    const at = e.args[1].span;
    if (opts.kind !== 'struct') {
      this.error(
        Codes.TypeMismatch,
        at,
        `\`flags.parse\` reads flags into a struct's fields, and was given ${opts.kind === 'param' ? `\`${this.show(opts)}\`, which could be any type` : `\`${this.show(opts)}\``}`,
        'give it the defaults as a struct of options: `flags.parse(env.args(), Options { verbose: false, out: "" })`',
      );
      return;
    }
    const seen = new Map<string, string>();
    for (const f of opts.fields) {
      if (!flagField(f.type)) {
        const listOfBool = f.type.kind === 'list' && f.type.elem.kind === 'bool';
        this.error(
          Codes.TypeMismatch,
          at,
          `\`${opts.name}.${f.name}\` is a ${this.show(f.type)}, which no flag reads`,
          listOfBool
            ? 'a bool flag takes no value, so a list of them would only count its uses: use an `int` and count them yourself, or one `bool`'
            : 'a flag is a `string`, `int`, `float`, `bool` or `time.Duration`, a `T?` of one, or a `List` of one: read it as a `string` and convert it after `flags.parse`',
        );
        continue;
      }
      const name = flagName(f);
      const other = seen.get(name);
      if (other !== undefined) {
        this.error(Codes.Duplicate, at, `\`${opts.name}.${other}\` and \`${opts.name}.${f.name}\` are both the flag \`-${name}\``, `give one another name with \`as\`: \`${f.name}: ${this.show(f.type)} as "${name}2"\``);
      }
      seen.set(name, f.name);
    }
    this.flagCalls.set(e, opts);
  }

  /**
   * #b29bfb64: `sql.function("name", f)`: the name a literal SQLite has no function by, `f` a
   * named function without effects or type parameters whose values SQLite can hold. The
   * emitter wraps `f`; the schema check learns its name, arguments and result.
   */
  private checkSqlFunction(e: ast.Call) {
    if (e.args.length !== 2) return;
    const [nameArg, f] = e.args;
    if (nameArg.kind !== 'String') {
      this.error(Codes.NotConstant, nameArg.span, "`sql.function`'s name is a string literal: the schema check reads it when the program compiles", 'write the name in the call: `sql.function("strip_html", stripHtml)`');
      return;
    }
    const name = nameArg.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      this.error(Codes.SqlSchema, nameArg.span, `\`${name}\` isn't a name SQL can call`, 'a SQL function name is letters, digits and `_`, not starting with a digit: `strip_html`');
      return;
    }
    if (sqliteHasFunction(name)) {
      this.error(Codes.SqlSchema, nameArg.span, `SQLite has a function \`${name}\` already`, `give yours a name of its own, e.g. \`app_${name.toLowerCase()}\`, and call that in the SQL`);
      return;
    }
    let sig: FnSig | undefined;
    if (f.kind === 'Ident' && this.refs.get(f) === 'fn') sig = this.fns.get(f.name);
    else if (f.kind === 'Member') {
      const ref = this.moduleRefs.get(f);
      if (ref?.kind === 'fn') sig = this.imports.get(ref.module)?.fns.get(ref.name);
    }
    if (!sig) {
      this.error(
        Codes.TypeMismatch,
        f.span,
        '`sql.function` takes a named function: the compiler writes how SQLite calls it, and a lambda or a variable could be anything',
        `declare it with \`fn\` and pass its name: \`fn stripHtml(s: string) -> string { ... }\`, then \`sql.function("${name}", stripHtml)\``,
      );
      return;
    }
    const show = `\`${sig.name}\``;
    if (sig.typeParams.length > 0) {
      this.error(Codes.TypeMismatch, f.span, `${show} has type parameters, and SQLite calls one function with values of its own`, 'write a function with the types it takes: `fn lengthOf(s: string) -> int`');
      return;
    }
    if (sig.type.uses.length > 0 || sig.effectParams.length > 0) {
      this.error(
        Codes.TypeMismatch,
        f.span,
        `${show} uses ${sig.type.uses.map((u) => `\`${u}\``).join(', ') || 'a function it is given'}, and SQLite may call a SQL function anywhere: in a query, a trigger, an index`,
        'give SQL a function that only computes from its arguments; do the rest in Candor around the query',
      );
      return;
    }
    const value = (t: Type) => ['int', 'float', 'string', 'bool', 'bytes'].includes(t.kind);
    const nullable = (t: Type) => value(t) || (t.kind === 'option' && value(t.inner));
    const ret = sig.type.ret.kind === 'result' && sig.type.ret.err.kind === 'string' ? sig.type.ret.ok : sig.type.ret;
    const kinds = 'int, float, string, bool, Bytes, or a `T?` of one (none is NULL)';
    const bad = sig.params.find((p) => !nullable(p.type));
    if (bad) {
      this.error(Codes.TypeMismatch, f.span, `${show}'s parameter \`${bad.name}\` is a ${this.show(bad.type)}, which SQLite has no value for`, `a SQL function's parameters are ${kinds}`);
      return;
    }
    if (!nullable(ret)) {
      this.error(
        Codes.TypeMismatch,
        f.span,
        `${show} gives a ${this.show(sig.type.ret)}, which SQLite has no value for`,
        `a SQL function gives ${kinds}, or a \`Result\` of one with a \`string\` error, which fails the statement`,
      );
      return;
    }
    const fn = f.kind === 'Member' ? `${this.moduleRefs.get(f)!.module}.${sig.name}` : `${this.mod.name}.${sig.name}`;
    const use: SqlFunctionUse = { name, fn, params: sig.params.map((p) => p.name), type: sig.type, where: `${this.file}:${nameArg.span.start.line}` };
    // The same function again (main and a test both opening the database) is the same registration.
    const other = [...this.ownSqlFunctions, ...[...this.imports.values()].flatMap((m) => m.sqlFunctionDecls)].find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (other && other.fn !== fn) {
      this.error(Codes.Duplicate, nameArg.span, `the SQL function \`${name}\` is \`${other.fn}\` already, registered at ${other.where}`, 'one name, one function: give this one another name');
      return;
    }
    if (!other) this.ownSqlFunctions.push(use);
    this.sqlFunctions.set(f, use);
  }

  /**
   * #b29bfb64: `sql.function("f", (s) => ...)`: said before the call is inferred, which would
   * only say it can't tell `F`. Gives the call's type when it is such a call.
   */
  private sqlFunctionLambda(e: ast.Call): Type | null {
    const f = e.args[1];
    if (e.callee.kind !== 'Member' || e.callee.object.kind !== 'Ident' || e.callee.name !== 'function' || !f) return null;
    const generic = f.kind === 'Ident' && !this.lookup(f.name) ? this.fns.get(f.name) : undefined;
    if (f.kind !== 'Lambda' && !generic?.typeParams.length) return null;
    const mod = this.imports.get(e.callee.object.name);
    const sig = mod?.module === 'sql' ? mod.fns.get('function') : undefined;
    const b = this.lookup(e.callee.object.name);
    if (!sig || (b && b.kind !== 'effect')) return null;
    if (f.kind === 'Lambda') {
      this.checkLambda(f, null, null);
      this.error(Codes.TypeMismatch, f.span, '`sql.function` takes a named function: the compiler writes how SQLite calls it, and a lambda or a variable could be anything', 'declare it with `fn` and pass its name: `fn stripHtml(s: string) -> string { ... }`, then `sql.function("strip_html", stripHtml)`');
    } else {
      this.error(Codes.TypeMismatch, f.span, `\`${generic!.name}\` has type parameters, and SQLite calls one function with values of its own`, 'write a function with the types it takes: `fn lengthOf(s: string) -> int`');
    }
    this.checkExpr(e.args[0]);
    return sig.ret;
  }

  /** #b29bfb64: the SQL functions registered here and in the imports, each once. */
  private sqlFunctionDecls(): SqlFunctionUse[] {
    const all = new Map<string, SqlFunctionUse>();
    for (const x of [...[...this.imports.values()].flatMap((m) => m.sqlFunctionDecls), ...this.ownSqlFunctions]) {
      if (!all.has(x.name.toLowerCase())) all.set(x.name.toLowerCase(), x);
    }
    return [...all.values()];
  }

  /**
   * #cb18c33b: `env.signals(s, [.Interrupt, .Terminate])` gives a `Channel<Signal>` that gets
   * those signals until the scope `s` ends; `env.sendSignal(.Interrupt)`, in a test, sends one
   * as if the process were sent it.
   */
  private envSignals(e: ast.Call, callee: ast.Member, b: Binding | undefined): Type {
    const signal = this.userTypes.get('Signal') === signalType ? signalType : null;
    const chan: HandleType = { kind: 'handle', handle: 'Channel', arg: signalType };
    if (b) this.checkExpr(callee.object);
    this.perform(['env'], callee.span, `\`env.${callee.name}\``);
    if (callee.name === 'sendSignal') {
      if (b && b.type.kind === 'effect' && !b.type.methods.has('sendSignal')) {
        for (const a of e.args) this.checkAgainst(a, signal ?? T.error);
        this.error(Codes.NoSuchMember, callee.nameSpan, '`env.sendSignal` is for tests: it sends a signal to the fake `env`', 'a running program gets signals from outside; receive them with `env.signals(s, [...])`');
        return T.unit;
      }
      if (e.args.length !== 1) {
        for (const a of e.args) this.checkAgainst(a, signal ?? T.error);
        this.error(Codes.ArgCount, e.span, `\`env.sendSignal\` takes 1 argument, the signal, found ${e.args.length}`, 'write `env.sendSignal(.Interrupt)`');
        return T.unit;
      }
      this.checkAgainst(e.args[0], signal ?? this.userTypes.get('Signal')!);
      if (!signal) {
        this.error(Codes.TypeMismatch, e.args[0].span, "this module's own `Signal` type hides the built-in one, which `env.sendSignal` takes", "rename the module's `Signal`, so `.Interrupt` and the like mean the built-in one");
        return T.unit;
      }
      this.signalCalls.set(e, 'send');
      return T.unit;
    }
    if (e.args.length !== 2) {
      // A list is still the signals, so `.Interrupt` in it is no error of its own.
      for (const a of e.args) if (a.kind === 'ListLit' && signal) this.checkAgainst(a, { kind: 'list', elem: signal });
      else this.checkExpr(a);
      this.error(Codes.ArgCount, e.span, `\`env.signals\` takes 2 arguments, the scope the signals are wanted in and which ones, found ${e.args.length}`, 'write `env.signals(s, [.Interrupt, .Terminate])` inside `tasks.scope((s) => ...)`');
      return T.error;
    }
    const s = this.checkExpr(e.args[0]);
    if (s.kind !== 'scope' && s.kind !== 'error') {
      this.error(Codes.TypeMismatch, e.args[0].span, `\`env.signals\` takes the Scope the signals are wanted in first, found ${this.show(s)}`, 'write `tasks.scope((s) => { let sigs = env.signals(s, [.Interrupt]) ... })`: they stop coming when the scope ends');
    }
    if (!signal) {
      // A module's own `Signal` hides the built-in one, which `env.signals` still gives.
      this.checkAgainst(e.args[1], { kind: 'list', elem: this.userTypes.get('Signal')! });
      this.error(Codes.TypeMismatch, e.args[1].span, "this module's own `Signal` type hides the built-in one, which `env.signals` takes", 'rename the module\'s `Signal`, so `.Interrupt` and the like mean the built-in one');
      return T.error;
    }
    const which = e.args[1];
    this.checkAgainst(which, { kind: 'list', elem: signal });
    if (which.kind === 'ListLit' && which.items.length === 0) {
      this.error(Codes.TypeMismatch, which.span, '`env.signals` with no signals would never give one', 'name the ones wanted: `[.Interrupt, .Terminate]`');
    }
    this.signalCalls.set(e, 'listen');
    return chan;
  }

  /**
   * Card 144: `embed("testdata/feed.xml")`, a file read when the program compiles and built into
   * it: a string (the file must be UTF-8), or with `embed<Bytes>(...)` its bytes. The path is a
   * literal, relative to this file.
   */
  private embedCall(e: ast.Call, callee: ast.Ident): Type {
    const typeArgs = callee.typeArgs;
    let type: Type = T.string;
    if (typeArgs) {
      const t = typeArgs.types.length === 1 ? this.resolveType(typeArgs.types[0]) : T.error;
      if (t.kind === 'bytes' || t.kind === 'string') type = t;
      else if (t.kind !== 'error' || typeArgs.types.length !== 1) {
        this.error(Codes.TypeArgs, typeArgs.span, '`embed` gives a file as a `string` or as `Bytes`', 'write `embed("path")` for text, `embed<Bytes>("path")` for any file');
      }
    }
    const arg = e.args[0];
    if (e.args.length !== 1 || arg.kind !== 'String') {
      for (const a of e.args) this.checkExpr(a);
      this.error(
        Codes.ArgCount,
        e.args.length === 1 ? arg.span : e.span,
        '`embed` takes the path of a file, as a string literal: the file is read when the program compiles',
        'write `embed("testdata/feed.xml")`, relative to this file',
      );
      return type;
    }
    this.types.set(arg, T.string);
    const file = path.resolve(path.dirname(this.file), arg.value).replace(/\\/g, '/');
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      const dir = existsSync(file);
      this.error(Codes.EmbedFile, arg.span, dir ? `${arg.value} is a folder, and \`embed\` takes a file` : `cannot read ${arg.value} (${file})`, dir ? 'embed each file in it' : 'the path is relative to this file');
      return type;
    }
    if (type.kind === 'string' && !utf8(data)) {
      this.error(Codes.EmbedFile, arg.span, `${arg.value} is not UTF-8 text, so it can't be a string`, `write \`embed<Bytes>(${JSON.stringify(arg.value)})\` for its bytes`);
      return type;
    }
    this.embeds.set(e, { file, bytes: type.kind === 'bytes' });
    return type;
  }

  private inferCall(e: ast.Call): Type {
    const hint = this.takeHint();
    const callee = e.callee;
    if (callee.kind === 'Ident' && callee.name === 'embed' && !this.lookup('embed') && !this.fns.has('embed')) return this.embedCall(e, callee);
    const lambdaUdf = this.sqlFunctionLambda(e);
    if (lambdaUdf) return lambdaUdf;
    if (callee.kind === 'Member' && callee.name === 'load' && callee.object.kind === 'Ident' && callee.object.name === 'env') {
      const b = this.lookup('env');
      if (!b || b.kind === 'effect') return this.envLoad(e, callee);
    }
    if (callee.kind === 'Member' && (callee.name === 'zone' || callee.name === 'setZone') && callee.object.kind === 'Ident' && callee.object.name === 'env') {
      const b = this.lookup('env');
      if (!b || b.kind === 'effect') return this.envZone(e, callee, b);
    }
    if (callee.kind === 'Member' && (callee.name === 'signals' || callee.name === 'sendSignal') && callee.object.kind === 'Ident' && callee.object.name === 'env') {
      const b = this.lookup('env');
      if (!b || b.kind === 'effect') return this.envSignals(e, callee, b);
    }
    let calleeType: Type;
    const imported = callee.kind === 'Member' ? this.importedModule(callee.object, callee.name) : null;
    if (callee.kind === 'Member' && imported) {
      calleeType = this.moduleMember(callee, imported, true);
      this.types.set(callee, calleeType);
    } else if (callee.kind === 'Member' && !this.isTypeName(callee.object)) {
      const objType = this.checkExpr(callee.object);
      // `xs.toString()`: lists, maps, optionals and Results are `Show` when what they hold is.
      if (callee.name === 'toString' && showInner(objType).length > 0) return this.traitCall(e, callee, objType, this.traitMethods(objType, callee.name));
      if (objType.kind === 'list') return this.listCall(e, callee, objType, hint);
      if (objType.kind === 'map') return this.mapCall(e, callee, objType);
      if (objType.kind === 'result') return this.resultCall(e, callee, objType, hint);
      if (objType.kind === 'option' && callee.name === 'map') return this.optionMap(e, objType, hint);
      if (objType.kind === 'effect' && objType.name === 'tasks') return this.tasksCall(e, callee, hint);
      if (objType.kind === 'effect' && objType.name === 'random' && (callee.name === 'shuffle' || callee.name === 'pick')) {
        return this.randomCall(e, callee, callee.name, hint);
      }
      if (objType.kind === 'scope' || objType.kind === 'task') return this.handleCall(e, callee, objType, hint);
      if (objType.kind === 'handle') return this.sharedCall(e, callee, objType, hint);
      const found = this.traitMethods(objType, callee.name);
      if (found.length > 0) return this.traitCall(e, callee, objType, found);
      calleeType = this.memberOf(callee, objType, true);
      const toEnd = callee.name === 'slice' && e.args.length === 1 && this.methods.has(callee) ? sliceToEnd(objType) : undefined;
      if (toEnd) {
        this.methods.set(callee, toEnd);
        calleeType = toEnd.type;
      }
      this.types.set(callee, calleeType);
    } else {
      calleeType = this.checkExpr(callee, true);
    }
    if (calleeType.kind !== 'fn') {
      // #a64e87fe: after an error in the callee, a lambda's unannotated parameters say nothing new.
      for (const a of e.args) {
        if (a.kind === 'Lambda' && calleeType.kind === 'error') this.checkLambda(a, a.params.map(() => T.error), null);
        else this.checkExpr(a);
      }
      if (calleeType.kind !== 'error') {
        this.error(Codes.NotCallable, e.callee.span, `${this.show(calleeType)} is not a function`);
      }
      return T.error;
    }
    const sig = this.calledSig(e.callee);
    const typeArgs = callee.kind === 'Ident' || callee.kind === 'Member' ? callee.typeArgs : undefined;
    if (sig && (sig.typeParams.length > 0 || sig.effectParams.length > 0 || typeArgs)) return this.genericCall(e, sig, typeArgs, hint);
    if (typeArgs) {
      this.error(Codes.TypeArgs, typeArgs.span, `\`${exprText(callee)}\` is not generic, so it takes no type arguments`, `write \`${exprText(callee)}(...)\``);
    }
    // Each argument is checked against its parameter, so `none`, `Ok(...)` and `T` into `T?` work.
    e.args.forEach((a, i) => {
      if (sig?.decl.kind === 'FnDecl' && i < sig.params.length) this.argFor.set(a, { fn: exprText(e.callee), name: sig.params[i].name });
      if (i < calleeType.params.length) this.checkAgainst(a, calleeType.params[i]);
      else this.checkExpr(a);
    });
    const ref = e.callee.kind === 'Member' ? this.moduleRefs.get(e.callee) : undefined;
    if (e.callee.kind === 'Ident' && this.refs.get(e.callee) === 'fn') {
      this.checkCallEffects(e.callee, this.fns.get(e.callee.name)!);
    } else if (ref) {
      this.perform(calleeType.uses, e.callee.span, `\`${ref.module}.${ref.name}\``);
    } else {
      // A function value: calling it performs the effects its type allows.
      this.perform(calleeType.uses, e.callee.span, `\`${exprText(e.callee)}\``);
    }
    if (e.args.length !== calleeType.params.length) {
      const n = calleeType.params.length;
      if (e.callee.kind === 'Member' && e.callee.name === 'slice' && this.methods.has(e.callee)) {
        this.error(Codes.ArgCount, e.span, `\`slice\` takes 1 or 2 arguments, found ${e.args.length}`, SLICE_HELP);
      } else if (e.callee.kind === 'Member' && /^trim(Start|End)?$/.test(e.callee.name) && this.methods.has(e.callee) && e.args.length === 1) {
        // Card 159: JavaScript's trims take nothing; one that takes text is `removePrefix`.
        const remove = e.callee.name === 'trimEnd' ? 'removeSuffix' : 'removePrefix';
        this.error(Codes.ArgCount, e.span, `\`${e.callee.name}\` takes no arguments: it removes whitespace`, `to remove given text, \`${remove}(text)\`; it gives the string unchanged if the text isn't there. For any of a set of characters from both ends, \`trimChars(" \\t")\``);
      } else {
        this.error(Codes.ArgCount, e.span, `expected ${n} argument${n === 1 ? '' : 's'}, found ${e.args.length}`);
      }
    }
    return calleeType.ret;
  }

  /**
   * A generic function that, through calls, gets back to itself with a type parameter inside a
   * bigger type would need a new version of itself for every round. Go refuses to build it.
   */
  private checkInstantiation() {
    const reaches = (from: ParamType, to: ParamType, seen = new Set<ParamType>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return this.flows.some((f) => f.from === from && reaches(f.to, to, seen));
    };
    for (const f of this.flows) {
      if (!f.grows || !reaches(f.to, f.from)) continue;
      this.error(
        Codes.TypeArgs,
        f.span,
        `\`${f.callee}\` is called here with \`${f.from.name}\` inside \`${this.show(f.arg)}\`, and gets back here, so every round would need a bigger type`,
        'Go builds one version of a generic function per type it is used with, and this would need infinitely many: keep the type arguments of recursive calls as they are',
      );
    }
  }

  /** The declared function a callee names, if it names one directly. */
  private calledSig(callee: ast.Expr): FnSig | null {
    if (callee.kind === 'Ident' && this.refs.get(callee) === 'fn') return this.fns.get(callee.name) ?? null;
    const ref = callee.kind === 'Member' ? this.moduleRefs.get(callee) : undefined;
    return ref?.kind === 'fn' ? (this.byModule.get(ref.module)?.fns.get(ref.name) ?? null) : null;
  }

  /**
   * A call of a generic function, or of one that takes on its callback's effects. The type
   * arguments are written, or come from the arguments; never from where the result goes.
   */
  private genericCall(e: ast.Call, sig: FnSig, written: ast.TypeArgs | undefined, hint: Type | null): Type {
    const name = exprText(e.callee);
    const known = new Map<ParamType, Type>();
    const n = sig.typeParams.length;
    if (written) {
      const types = written.types.map((t) => this.resolveType(t));
      if (n === 0) {
        this.error(Codes.TypeArgs, written.span, `\`${name}\` is not generic, so it takes no type arguments`, `write \`${name}(...)\``);
      } else if (types.length !== n) {
        this.error(Codes.TypeArgs, written.span, `\`${name}\` takes ${n} type${n === 1 ? '' : 's'}, found ${types.length}`, `write \`${name}<${sig.typeParams.map((p) => p.name).join(', ')}>(...)\``);
      } else {
        sig.typeParams.forEach((p, i) => known.set(p, types[i]));
      }
    }
    this.perform(sig.uses, e.callee.span, `\`${name}\``);
    if (e.args.length !== sig.params.length) {
      this.arity(e, name, -1, false);
      const count = sig.params.length;
      this.error(Codes.ArgCount, e.span, `expected ${count} argument${count === 1 ? '' : 's'}, found ${e.args.length}`);
      return T.error;
    }
    const from = this.inferArgs(
      sig.typeParams,
      e.args.map((a, i) => ({
        expr: a,
        type: sig.params[i].type,
        effect: sig.effectParams.includes(sig.params[i].name),
        label: `\`${sig.params[i].name}\``,
        param: sig.decl.kind === 'FnDecl' ? { fn: name, name: sig.params[i].name } : undefined,
      })),
      known,
      { declared: sig.ret, hint },
    );
    const form = (args: string) => `${name}<${args}>(${e.args.length > 0 ? '...' : ''})`;
    if (!written && !this.fromHint(e.callee.span, `\`${name}(...)\``, sig.typeParams, known, from, sig.ret, hint)) return T.error;
    if (!this.allKnown(e.callee.span, `the arguments of \`${name}\` don't say`, sig.typeParams, known, sig.ret, hint, form)) return T.error;
    const typeArgs = sig.typeParams.map((p) => known.get(p)!);
    if (!this.checkBounds(sig.typeParams, typeArgs, e.callee.span, `\`${name}\``)) return T.error;
    if (n > 0) this.callTypeArgs.set(e, typeArgs);
    if (n > 0 && this.fns.get(sig.name) === sig) {
      for (const to of sig.typeParams) {
        const arg = known.get(to)!;
        for (const from of paramsIn(arg)) {
          if (this.fn.typeParams.includes(from)) this.flows.push({ from, to, grows: arg !== from, span: e.callee.span, callee: name, arg });
        }
      }
    }
    return subst(sig.ret, (p) => known.get(p) ?? p);
  }

  private isTypeName(e: ast.Expr): boolean {
    return this.typeNamed(e) !== null;
  }

  /** Methods on `List<T>`. `map` and `filter` take on the effects of the function they're given. */
  private mapCall(e: ast.Call, callee: ast.Member, map: Type & { kind: 'map' }): Type {
    const name = callee.name;
    const arity = (n: number): boolean => {
      if (e.args.length === n) return true;
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.ArgCount, e.span, `\`${name}\` takes ${n} argument${n === 1 ? '' : 's'}, found ${e.args.length}`);
      return false;
    };
    if (!mapMethods.includes(name)) {
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.NoSuchMember, callee.nameSpan, `${this.show(map)} has no method \`${name}\``, mapMisnamed.get(name) ?? `available: ${mapMethods.join(', ')}`);
      // `m.set(k, v)` meant a write: a `let mut m` isn't also told to drop its `mut`.
      const root = rootOf(callee.object);
      const found = root.kind === 'Ident' ? this.lookupAt(root.name) : undefined;
      if (found?.binding.kind === 'local') found.binding.mutated = true;
      return T.error;
    }
    this.mapCalls.set(e, name);
    switch (name) {
      case 'length':
        return arity(0) ? T.int : T.error;
      case 'isEmpty':
        return arity(0) ? T.bool : T.error;
      case 'has':
        if (!arity(1)) return T.error;
        this.checkAgainst(e.args[0], map.key);
        return T.bool;
      case 'keys':
        return arity(0) ? { kind: 'list', elem: map.key } : T.error;
      case 'values':
        return arity(0) ? { kind: 'list', elem: map.value } : T.error;
      case 'entries':
        return arity(0) ? { kind: 'list', elem: { kind: 'tuple', elems: [map.key, map.value] } } : T.error;
      case 'remove':
        if (!arity(1)) return T.error;
        this.checkPlace(callee.object, 'remove from', true);
        this.checkAgainst(e.args[0], map.key);
        return this.optionOf(e, map.value);
      default:
        throw new Error(`unhandled map method ${name}`);
    }
  }

  /**
   * Methods on `Result<T, E>`: `map`, which turns the value into another, `mapErr`, the error,
   * `isOk`/`isErr`, which say which it is, and `ok`, the value as a `T?`.
   */
  private resultCall(e: ast.Call, callee: ast.Member, r: Type & { kind: 'result' }, hint: Type | null): Type {
    const name = callee.name;
    if (name === 'isOk' || name === 'isErr') {
      if (!this.arity(e, name, 0)) return T.error;
      this.resultChecks.set(e, name);
      return T.bool;
    }
    // `r.ok() ?? fallback`: the error is dropped where it says so.
    if (name === 'ok') {
      if (!this.arity(e, name, 0)) return T.error;
      if (r.ok.kind === 'unit') {
        this.error(Codes.NoValue, callee.nameSpan, `${this.show(r)} holds no value to take`, 'use `r.isOk()` to ask whether it succeeded');
        return T.error;
      }
      this.resultChecks.set(e, name);
      return this.optionOf(e, r.ok);
    }
    if (name !== 'map' && name !== 'mapErr') {
      for (const a of e.args) this.checkExpr(a);
      this.error(
        Codes.NoSuchMember,
        callee.nameSpan,
        `${this.show(r)} has no method \`${name}\``,
        'available: map, mapErr, isOk, isErr, ok; to read it, `match` it, use `?`, or `r.ok() ?? fallback`',
      );
      return T.error;
    }
    if (!this.arity(e, name, 1)) return T.error;
    const ok = name === 'map';
    if (ok && r.ok.kind === 'unit') {
      this.checkExpr(e.args[0]);
      this.error(Codes.NoValue, callee.nameSpan, `${this.show(r)} holds no value to map`, 'use `?` and go on, or `match` it');
      return T.error;
    }
    // Where it goes can say what the lambda returns: `return r.mapErr((e) => none)`.
    const want = e.args[0].kind === 'Lambda' && hint?.kind === 'result' ? (ok ? hint.ok : hint.err) : null;
    const f = this.checkFnArg(e.args[0], [ok ? r.ok : r.err], want);
    if (!f) return T.error;
    if (f.ret.kind === 'unit') {
      this.error(
        Codes.NoValue,
        e.args[0].span,
        `the function given to \`${name}\` returns nothing`,
        ok ? 'return the new value: `r.map((u) => u.id)`' : 'return the new error: `r.mapErr((e) => AppError.Db { error: e })`',
      );
      return T.error;
    }
    if (f.ret.kind === 'error') return T.error;
    const t: Type = ok ? { kind: 'result', ok: f.ret, err: r.err } : { kind: 'result', ok: r.ok, err: f.ret };
    this.wrapMaps.set(e, { side: ok ? 'ok' : 'err', type: t, flat: false });
    return t;
  }

  /**
   * `x.map(f)` on a `T?`: `f` of the value, or `none`. An `f` that gives a `U?` gives it as it is,
   * so `m.attachment.map((a) => a.url)` is a `string?` when `url` is: what `?.` does elsewhere.
   */
  private optionMap(e: ast.Call, o: Type & { kind: 'option' }, hint: Type | null): Type {
    if (!this.arity(e, 'map', 1)) return T.error;
    const want = e.args[0].kind === 'Lambda' && hint?.kind === 'option' ? hint : null;
    const f = this.checkFnArg(e.args[0], [o.inner], want);
    if (!f) return T.error;
    if (f.ret.kind === 'unit') {
      this.error(
        Codes.NoValue,
        e.args[0].span,
        'the function given to `map` returns nothing',
        'return the new value: `x.map((u) => u.name)`; to act on a present value, `if x != none { ... }`',
      );
      return T.error;
    }
    if (f.ret.kind === 'error') return T.error;
    const flat = f.ret.kind === 'option';
    const t: Type = flat ? f.ret : { kind: 'option', inner: f.ret };
    this.wrapMaps.set(e, { side: 'some', type: t, flat });
    return t;
  }

  private listCall(e: ast.Call, callee: ast.Member, list: Type & { kind: 'list' }, hint: Type | null = null): Type {
    const elem = list.elem;
    const name = callee.name;
    const arity = (n: number): boolean => {
      if (e.args.length === n) return true;
      for (const a of e.args) this.checkExpr(a);
      this.error(Codes.ArgCount, e.span, `\`${name}\` takes ${n} argument${n === 1 ? '' : 's'}, found ${e.args.length}`);
      return false;
    };
    if (!listMethods.includes(name)) {
      // A lambda here has no context for its parameters; one error is enough.
      for (const a of e.args) {
        if (a.kind === 'Lambda') this.checkLambda(a, a.params.map(() => T.error), null);
        else this.checkExpr(a);
      }
      if (name === 'forEach') {
        this.error(Codes.NoSuchMember, callee.nameSpan, 'lists have no `forEach`', 'loop instead: `for x in xs { ... }`');
      } else {
        this.error(Codes.NoSuchMember, callee.nameSpan, `${this.show(list)} has no method \`${name}\``, `available: ${listMethods.join(', ')}`);
      }
      return T.error;
    }
    this.listCalls.set(e, name);
    switch (name) {
      case 'length':
        return arity(0) ? T.int : T.error;
      case 'isEmpty':
        return arity(0) ? T.bool : T.error;
      case 'first':
      case 'last':
        return arity(0) ? this.optionOf(e, elem) : T.error;
      case 'enumerated':
        return arity(0) ? { kind: 'list', elem: { kind: 'tuple', elems: [T.int, elem] } } : T.error;
      case 'contains':
        if (!arity(1)) return T.error;
        this.checkAgainst(e.args[0], elem);
        if (!comparable(elem)) {
          this.error(Codes.InvalidOperands, callee.nameSpan, `\`contains\` compares items with \`==\`, but ${this.whyNotEq(elem)}`, this.boundHelp(elem, Eq));
          return T.error;
        }
        return T.bool;
      case 'unique':
      case 'union':
      case 'intersect':
        if (!arity(name === 'unique' ? 0 : 1)) return T.error;
        if (name !== 'unique') this.checkAgainst(e.args[0], list);
        if (!comparable(elem)) {
          this.error(Codes.InvalidOperands, callee.nameSpan, `\`${name}\` compares items with \`==\`, but ${this.whyNotEq(elem)}`, this.boundHelp(elem, Eq));
          return T.error;
        }
        return list;
      case 'sorted': {
        if (!arity(0)) return T.error;
        const why = this.lacks(elem, Ord);
        if (why) {
          this.error(Codes.InvalidOperands, callee.nameSpan, `\`sorted\` orders items with \`<\`, but ${why}`, this.boundHelp(elem, Ord));
          return T.error;
        }
        return list;
      }
      case 'min':
      case 'max': {
        if (!arity(0)) return T.error;
        const why = this.lacks(elem, Ord);
        if (why) {
          this.error(
            Codes.InvalidOperands,
            callee.nameSpan,
            `\`${name}\` compares items with \`<\`, but ${why}`,
            this.boundHelp(elem, Ord) ?? `by a key, sort first: \`xs.sortedBy((x) => x.score).${name === 'min' ? 'first' : 'last'}()\``,
          );
          return T.error;
        }
        return { kind: 'option', inner: elem };
      }
      case 'join':
        if (!arity(1)) return T.error;
        this.checkAgainst(e.args[0], T.string);
        if (elem.kind !== 'string' && elem.kind !== 'char' && elem.kind !== 'error') {
          this.error(
            Codes.TypeMismatch,
            callee.nameSpan,
            `\`join\` needs a List<string> or List<char>, found ${this.show(list)}`,
            elem.kind === 'int' || elem.kind === 'bool' ? 'turn the items into strings first: `xs.map((x) => x.toString()).join(", ")`' : undefined,
          );
          return T.error;
        }
        return T.string;
      case 'concat':
        if (!arity(1)) return T.error;
        this.checkAgainst(e.args[0], list);
        return list;
      case 'reversed':
        return arity(0) ? list : T.error;
      case 'slice':
        if (e.args.length !== 1 && e.args.length !== 2) {
          for (const a of e.args) this.checkExpr(a);
          this.error(Codes.ArgCount, e.span, `\`slice\` takes 1 or 2 arguments, found ${e.args.length}`, SLICE_HELP);
          return T.error;
        }
        for (const a of e.args) this.checkAgainst(a, T.int);
        return list;
      case 'map': {
        if (!arity(1)) return T.error;
        const f = this.checkFnArg(e.args[0], [elem], null);
        if (!f) return T.error;
        if (f.ret.kind === 'unit') {
          this.error(Codes.NoValue, e.args[0].span, 'the function given to `map` returns nothing', 'to do something with each item, loop: `for x in xs { ... }`');
          return T.error;
        }
        return f.ret.kind === 'error' ? T.error : { kind: 'list', elem: f.ret };
      }
      case 'filter':
        if (!arity(1)) return T.error;
        return this.checkFnArg(e.args[0], [elem], T.bool) ? list : T.error;
      case 'all':
      case 'any':
        if (!arity(1)) return T.error;
        return this.checkFnArg(e.args[0], [elem], T.bool) ? T.bool : T.error;
      case 'fold': {
        if (!arity(2)) return T.error;
        // Card 161: `[]`, `[:]` or `none` take their type from the lambda's annotated `acc`, or
        // (#a64e87fe) from where the result goes, `return xs.fold([], ...)` in a `-> List<int>`.
        const start = e.args[0];
        const empty = (start.kind === 'ListLit' && start.items.length === 0) || (start.kind === 'MapLit' && start.entries.length === 0);
        const fits = hint && !hasError(hint) && hint.kind === (start.kind === 'ListLit' ? 'list' : start.kind === 'MapLit' ? 'map' : 'option') ? hint : null;
        const said = empty || start.kind === 'None' ? (this.annotatedParam(e.args[1], 0) ?? fits) : null;
        if (said?.kind === 'error') {
          // The lambda's check reports its annotation.
          this.checkFnArg(e.args[1], [T.error, elem], null);
          return T.error;
        }
        if (empty && !said) {
          this.checkFnArg(e.args[1], [T.error, elem], null);
          const what = start.kind === 'MapLit' ? 'map' : 'list';
          const example = start.kind === 'MapLit' ? 'Map<string, int>' : 'List<int>';
          this.error(
            Codes.NeedsAnnotation,
            start.span,
            `cannot tell what this empty ${what} holds`,
            `annotate the lambda's \`acc\`: \`xs.fold(${start.kind === 'MapLit' ? '[:]' : '[]'}, (acc: ${example}, x) => ...)\``,
          );
          return T.error;
        }
        const acc = said ? this.checkAgainst(start, said) : this.checkExpr(start);
        if (acc.kind === 'error') {
          this.checkFnArg(e.args[1], [T.error, elem], null);
          return T.error;
        }
        if (acc.kind === 'none') {
          this.checkFnArg(e.args[1], [T.error, elem], null);
          this.error(
            Codes.NeedsAnnotation,
            e.args[0].span,
            "`none` doesn't say what the result holds",
            'give it a type first: `let start: int? = none`, then `xs.fold(start, ...)`',
          );
          return T.error;
        }
        return this.checkFnArg(e.args[1], [acc, elem], acc) ? acc : T.error;
      }
      case 'sum':
        if (!arity(0)) return T.error;
        if (elem.kind === 'float') return T.float;
        if (elem.kind !== 'int' && elem.kind !== 'error') {
          this.error(
            Codes.TypeMismatch,
            callee.nameSpan,
            `\`sum\` adds a List<int> or List<float>, found ${this.show(list)}`,
            'to add up something else, `fold`: `xs.fold(0, (acc, x) => acc + x.size)`',
          );
          return T.error;
        }
        return T.int;
      case 'sortedBy': {
        if (!arity(1)) return T.error;
        const f = this.checkFnArg(e.args[0], [elem], null);
        if (!f || f.ret.kind === 'error') return T.error;
        const why = f.ret.kind === 'unit' ? 'it returns nothing' : this.lacks(f.ret, Ord);
        if (why) {
          this.error(
            Codes.InvalidOperands,
            e.args[0].span,
            `\`sortedBy\` orders items by the key the function gives, with \`<\`, but ${why}`,
            this.boundHelp(f.ret, Ord) ?? 'give an int, a string, or a tuple of them: `(j) => (j.at, j.id)`',
          );
          return T.error;
        }
        return list;
      }
      case 'push':
        if (!arity(1)) return T.error;
        this.checkPlace(callee.object, 'push to', true);
        this.checkAgainst(e.args[0], elem);
        return T.unit;
      case 'pop':
        if (!arity(0)) return T.error;
        this.checkPlace(callee.object, 'pop from', true);
        return this.optionOf(e, elem);
      default:
        throw new Error(`unhandled list method ${name}`);
    }
  }

  /**
   * Card 064: the queries in `sql` calls against the schema the migrations make, from the DDL in
   * `sql.exec` calls here and in imported modules. With no DDL anywhere there is nothing to check
   * against. Gives this module's DDL.
   */
  private checkSqlCalls(registered: SqlFunctionUse[]): { text: string; where: string }[] {
    const sqlKind = (t: Type): { type: SqlType; optional: boolean } =>
      t.kind === 'option' ? { type: rowPrimitive(t.inner) ? (t.inner.kind as SqlType) : 'other', optional: true } : { type: rowPrimitive(t) ? (t.kind as SqlType) : 'other', optional: false };
    const fns: SqlFns = new Map(
      registered.map((u) => {
        const ret = u.type.ret.kind === 'result' ? u.type.ret.ok : u.type.ret;
        return [u.name.toUpperCase(), { name: u.name, fn: u.fn, params: u.type.params.map((p, i) => ({ name: u.params[i], ...sqlKind(p) })), ret: sqlKind(ret) }];
      }),
    );
    const literal = (c: ast.Call) => {
      const q = c.args[0];
      return q && (q.kind === 'String' || q.kind === 'Interp') && this.queries.has(q) ? q : null;
    };
    const textOf = (q: ast.StringLit | ast.Interp) => (q.kind === 'String' ? q.value : q.parts.map((p) => (typeof p === 'string' ? p : '?')).join(''));
    const own: { text: string; where: string }[] = [];
    for (const c of this.sqlCalls) {
      const q = literal(c.call);
      if (q) {
        const params = q.kind === 'Interp' ? q.parts.filter((p) => typeof p !== 'string').map((p) => this.sqlParam(this.types.get(p))) : [];
        for (const p of checkFunctionCalls(textOf(q), params, fns)) this.error(Codes.SqlSchema, q.span, p.message, p.help);
      }
      if (c.name === 'exec' && q && isDdl(textOf(q))) {
        own.push({ text: textOf(q), where: `${this.file}:${q.span.start.line}` });
        for (const p of checkDdl(textOf(q))) this.error(Codes.SqlSchema, q.span, p.message, p.help);
      }
      // Card 134: by hand, a test would attach the real file, not one in memory.
      const first = q ? (/^\s*(\w+)/.exec(textOf(q))?.[1] ?? '').toUpperCase() : '';
      if (first === 'ATTACH' || first === 'DETACH') {
        this.error(
          Codes.SqlSchema,
          q!.span,
          `a database is attached with \`sql.attach\`, not ${first} in a query`,
          '`sql.attach("data/vault.db", "vault")` keeps it attached for the program; in a test it attaches a fresh one in memory',
        );
      }
      // Card 170: `${}` is a bound parameter, and SQLite takes none in a pragma.
      if (first === 'PRAGMA' && q!.kind === 'Interp' && q!.parts.some((p) => typeof p !== 'string')) {
        this.error(
          Codes.SqlSchema,
          q!.span,
          "a pragma can't take a `${}`: it is passed as a parameter, and SQLite takes none in a pragma",
          'write the value in the text, e.g. `match v { 1 => sql.exec("PRAGMA user_version = 1"), ... }`',
        );
      }
    }
    const ddl = [...[...this.imports.values()].flatMap((m) => m.sqlDdl), ...own];
    if (ddl.length === 0) return own;
    const schema = readSchema(ddl);
    const sqlType = (t: Type): SqlType => (rowPrimitive(t) ? (t.kind as SqlType) : 'other');
    for (const c of this.sqlCalls) {
      const q = literal(c.call);
      if (!q || isDdl(textOf(q))) continue;
      const params = q.kind === 'Interp' ? q.parts.filter((p) => typeof p !== 'string').map((p) => this.sqlParam(this.types.get(p))) : [];
      // `query<T>` gives `Result<List<T>, Error>`, `queryOne<T>` `Result<T?, Error>`.
      const ok = c.ret.kind === 'result' ? c.ret.ok : null;
      const item = c.name === 'query' && ok?.kind === 'list' ? ok.elem : c.name === 'queryOne' && ok?.kind === 'option' ? ok.inner : null;
      const row: RowShape | null =
        item?.kind === 'struct'
          ? { kind: 'struct', name: item.name, fields: item.fields.map((f) => ({ name: f.name, type: sqlType(f.type.kind === 'option' ? f.type.inner : f.type), optional: f.type.kind === 'option' })) }
          : item && rowPrimitive(item)
            ? { kind: 'one', type: sqlType(item), optional: false }
            : null;
      for (const p of checkSql(textOf(q), params, schema, row, fns)) {
        if (p.note) this.diagnostics.push({ code: Codes.SqlUnchecked, severity: 'note', message: p.message, help: p.help, file: this.file, span: q.span });
        else this.error(Codes.SqlSchema, q.span, p.message, p.help);
      }
    }
    return own;
  }

  /** A `${}` value's type as the SQL check sees it. */
  private sqlParam(t: Type | undefined): SqlParam {
    const one = (u: Type): SqlType => (rowPrimitive(u) ? (u.kind as SqlType) : 'other');
    return !t ? { type: 'other', optional: false } : t.kind === 'none' ? { type: 'none', optional: true } : t.kind === 'option' ? { type: one(t.inner), optional: true } : { type: one(t), optional: false };
  }

  /** `n` arguments, as `name` takes; otherwise checks them anyway and, with `report`, says so. */
  private arity(e: ast.Call, name: string, n: number, report = true): boolean {
    if (e.args.length === n) return true;
    for (const a of e.args) {
      if (a.kind === 'Lambda') this.checkLambda(a, a.params.map(() => T.error), null);
      else this.checkExpr(a);
    }
    if (report) this.error(Codes.ArgCount, e.span, `\`${name}\` takes ${n} argument${n === 1 ? '' : 's'}, found ${e.args.length}`);
    return false;
  }

  /**
   * `tasks.scope`, `all`, `race`, `timeout`, `both`. They run functions concurrently, so they take
   * on those functions' effects. A function returning a Result can fail, and its first failure
   * cancels the others. `select`, `after` and `otherwise` are below.
   */
  /** `random.shuffle(xs)`: the list in a random order; `random.pick(xs)`: one item, `none` if empty. */
  private randomCall(e: ast.Call, callee: ast.Member, name: 'shuffle' | 'pick', hint: Type | null): Type {
    if (!this.arity(e, `random.${name}`, 1)) return T.error;
    const listHint = name === 'shuffle' ? hint : hint?.kind === 'option' ? ({ kind: 'list', elem: hint.inner } as Type) : null;
    // The hint only types a literal (`[]`); anything else is checked as itself, for a clearer error.
    const t = listHint?.kind === 'list' && e.args[0].kind === 'ListLit' ? this.checkAgainst(e.args[0], listHint) : this.checkExpr(e.args[0]);
    if (t.kind === 'error') return T.error;
    if (t.kind !== 'list') {
      this.error(Codes.TypeMismatch, e.args[0].span, `\`random.${name}\` takes a list, found ${this.show(t)}`, name === 'pick' ? 'for a number in a range, `random.int(low, high)`' : undefined);
      return T.error;
    }
    const ret = name === 'shuffle' ? t : this.optionOf(e, t.elem);
    this.types.set(callee, fn([t], ret));
    this.randomCalls.set(e, name);
    return ret;
  }

  private tasksCall(e: ast.Call, callee: ast.Member, hint: Type | null): Type {
    const name = callee.name;
    switch (name) {
      case 'select':
        return this.selectCall(e, hint);
      case 'after': {
        if (!this.arity(e, 'tasks.after', 2)) return T.error;
        this.checkAgainst(e.args[0], T.int);
        return this.armOf(e, 'after', e.args[1], [], null, hint);
      }
      case 'otherwise': {
        if (!this.arity(e, 'tasks.otherwise', 1)) return T.error;
        return this.armOf(e, 'otherwise', e.args[0], [], null, hint);
      }
      case 'scope': {
        if (!this.arity(e, 'tasks.scope', 1)) return T.error;
        const scope: ScopeType = { kind: 'scope', id: this.scopeFrames.size + 1 };
        const frame: ScopeFrame = { ret: null, body: null, fallible: [] };
        this.scopeFrames.set(scope.id, frame);
        const f = this.checkFnArg(e.args[0], [scope], null, (lf) => {
          frame.body = lf;
          // What its returns leave open comes from where the scope's result goes.
          lf.retHint = hint;
        });
        frame.body = null;
        if (!f) return T.error;
        frame.ret = f.ret;
        for (const x of frame.fallible) this.checkFallible(frame, x);
        const held = heldHandle(f.ret);
        if (held) {
          this.error(
            Codes.TypeMismatch,
            e.args[0].span,
            `${f.ret === held ? `${article(held.handle)} ${this.show(held)}` : `${this.show(f.ret)} holds ${article(held.handle)} ${this.show(held)}, which`} belongs to the scope that made it, so the scope's function can't return one`,
            `make it with an outer scope, or return what you read from it`,
          );
        }
        this.taskCalls.set(e, { kind: 'scope', ret: f.ret });
        return f.ret;
      }
      case 'all': {
        if (!this.arity(e, 'tasks.all', 2)) return T.error;
        const xs = this.checkExpr(e.args[0]);
        if (xs.kind !== 'list') {
          if (xs.kind !== 'error') {
            this.error(Codes.TypeMismatch, e.args[0].span, `\`tasks.all\` runs a function on each item of a List, found ${this.show(xs)}`);
          }
          this.checkFnArg(e.args[1], [T.error], null);
          return T.error;
        }
        const f = this.checkFnArg(e.args[1], [xs.elem], null);
        if (!f) return T.error;
        this.taskCalls.set(e, { kind: 'all', ret: f.ret });
        if (f.ret.kind === 'unit' || f.ret.kind === 'error') return f.ret;
        if (f.ret.kind === 'result') return { kind: 'result', ok: { kind: 'list', elem: f.ret.ok }, err: f.ret.err };
        return { kind: 'list', elem: f.ret };
      }
      case 'race': {
        if (!this.arity(e, 'tasks.race', 1)) return T.error;
        const ret = this.raceArg(e.args[0]);
        if (!ret) return T.error;
        this.taskCalls.set(e, { kind: 'race', ret });
        return ret;
      }
      case 'timeout': {
        if (!this.arity(e, 'tasks.timeout', 2)) return T.error;
        this.checkAgainst(e.args[0], T.int);
        const f = this.checkFnArg(e.args[1], [], null);
        if (!f || f.ret.kind === 'error') return T.error;
        if (f.ret.kind === 'option') {
          this.error(
            Codes.TypeMismatch,
            e.args[1].span,
            '`tasks.timeout` gives `none` when time runs out, so the function cannot return an optional itself',
            'return a Result instead',
          );
          return T.error;
        }
        this.taskCalls.set(e, { kind: 'timeout', ret: f.ret });
        // Nothing to give back: whether it finished in time.
        return f.ret.kind === 'unit' ? T.bool : { kind: 'option', inner: f.ret };
      }
      case 'both':
        return this.bothCall(e);
      default:
        this.arity(e, name, -1, false);
        this.error(Codes.NoSuchMember, callee.nameSpan, `effect \`tasks\` has no \`${name}\``, `available: ${taskMethods.join(', ')}`);
        return T.error;
    }
  }

  /** The functions given to `tasks.race`; returns what each returns. A literal list may mix effects. */
  private raceArg(arg: ast.Expr): Type | null {
    if (arg.kind !== 'ListLit') {
      const t = this.checkExpr(arg);
      if (t.kind === 'error') return null;
      if (t.kind !== 'list' || t.elem.kind !== 'fn' || t.elem.params.length > 0) {
        this.error(
          Codes.TypeMismatch,
          arg.span,
          `\`tasks.race\` takes a List of functions without parameters, found ${this.show(t)}`,
          'write `tasks.race([() => a(), () => b()])`',
        );
        return null;
      }
      this.perform(t.elem.uses, arg.span, 'the functions passed here');
      return t.elem.ret;
    }
    if (arg.items.length === 0) {
      this.error(Codes.ArgCount, arg.span, '`tasks.race` needs at least one function');
      return null;
    }
    let ret: Type | null = null;
    let failed = false;
    const uses = new Set<string>();
    for (const item of arg.items) {
      const f = this.checkFnArg(item, [], ret);
      if (!f) {
        failed = true;
        continue;
      }
      ret ??= f.ret;
      for (const u of f.uses) uses.add(u);
    }
    if (failed || !ret || ret.kind === 'error') return null;
    this.types.set(arg, { kind: 'list', elem: fn([], ret, [...uses]) });
    return ret;
  }

  /** `s.spawn(f)`, `s.mutex(v)` and the like, and `task.join()`. */
  private handleCall(e: ast.Call, callee: ast.Member, objType: ScopeType | TaskType, hint: Type | null): Type {
    const available = objType.kind === 'scope' ? scopeMethods : ['join'];
    if (!available.includes(callee.name)) {
      this.arity(e, callee.name, -1, false);
      this.error(Codes.NoSuchMember, callee.nameSpan, `${this.show(objType)} has no method \`${callee.name}\``, `available: ${available.join(', ')}`);
      return T.error;
    }
    if (callee.name === 'wait') {
      if (!this.arity(e, 'wait', 0)) return T.error;
      this.taskCalls.set(e, { kind: 'wait' });
      return T.unit;
    }
    if (callee.name !== 'spawn' && callee.name !== 'background' && callee.name !== 'join') return this.makeShared(e, callee.name, hint);
    if (objType.kind === 'task') {
      if (!this.arity(e, 'join', 0)) return T.error;
      this.taskCalls.set(e, { kind: 'join' });
      return objType.result;
    }
    // #dfd9edd7: `s.background(f)` is checked as `spawn`, and gives no Task: nothing waits for it.
    const background = callee.name === 'background';
    if (!this.arity(e, callee.name, 1)) return T.error;
    const f = this.checkFnArg(e.args[0], [], null);
    if (!f || f.ret.kind === 'error') return T.error;
    const frame = this.scopeFrames.get(objType.id) ?? null;
    if (f.ret.kind === 'result') {
      const x = { err: f.ret.err, span: e.args[0].span };
      if (!frame) {
        this.error(
          Codes.TypeMismatch,
          x.span,
          "a task that can fail must be spawned in the function given to its `tasks.scope`, so its error can become the scope's",
          'spawn it there, or handle the error inside the task with `match`',
        );
      } else {
        frame.fallible.push(x);
        if (frame.body && frame.body.ret === null) frame.body.errHint ??= f.ret.err;
        if (frame.ret) this.checkFallible(frame, x);
      }
    }
    this.taskCalls.set(e, { kind: 'spawn', ret: f.ret, scope: frame, background });
    return background ? T.unit : { kind: 'task', result: f.ret };
  }

  /** A task's failure becomes its scope's result, so the scope must return a Result with the same error. */
  private checkFallible(frame: ScopeFrame, x: { err: Type; span: Span }) {
    const ret = frame.ret!;
    const err = this.show(x.err);
    if (ret.kind === 'error') return;
    if (ret.kind !== 'result') {
      this.error(
        Codes.TypeMismatch,
        x.span,
        `this task can fail with ${err}, so its scope must return \`Result<T, ${err}>\`, not ${this.show(ret)}`,
        "end the scope's function with `return Ok(...)`: the first failure becomes the scope's result",
      );
    } else if (!sameType(ret.err, x.err)) {
      this.error(
        Codes.TypeMismatch,
        x.span,
        `this task fails with ${err}, but its scope returns ${this.show(ret)}`,
        'there is no automatic error conversion; convert it with `match` inside the task',
      );
    }
  }

  /** `s.mutex(v)`, `s.atomic(v)`, `s.channel(n)`: what they hold comes from `v`, or from where the result goes. */
  private makeShared(e: ast.Call, method: string, hint: Type | null): Type {
    if (method === 'lock') {
      if (!this.arity(e, method, 0)) return T.error;
      const type: HandleType = { kind: 'handle', handle: 'Lock', arg: T.unit };
      this.taskCalls.set(e, { kind: 'make', type });
      return type;
    }
    const handle = method === 'mutex' ? 'Mutex' : method === 'atomic' ? 'Atomic' : 'Channel';
    if (!this.arity(e, method, 1)) return T.error;
    const wanted = hint?.kind === 'option' ? hint.inner : hint;
    const known = wanted?.kind === 'handle' && wanted.handle === handle ? wanted.arg : null;
    let arg: Type;
    if (handle === 'Channel') {
      this.checkAgainst(e.args[0], T.int);
      if (!known) {
        this.error(Codes.NeedsAnnotation, e.span, 'cannot tell what goes through this channel', 'annotate it: `let ch: Channel<int> = s.channel(8)`');
        return T.error;
      }
      arg = known;
    } else if (known) {
      this.checkAgainst(e.args[0], known);
      arg = known;
    } else {
      const v = e.args[0];
      if (handle === 'Mutex' && ((v.kind === 'ListLit' && v.items.length === 0) || (v.kind === 'MapLit' && v.entries.length === 0))) {
        // #a64e87fe: an empty start says nothing, and nothing after it is read for its type.
        const example = v.kind === 'MapLit' ? 'Map<string, int>' : 'List<int>';
        this.error(Codes.NeedsAnnotation, v.span, `cannot tell what this ${handle} holds`, `annotate it: \`let m: ${handle}<${example}> = s.${method}(${v.kind === 'MapLit' ? '[:]' : '[]'})\``);
        return T.error;
      }
      arg = this.checkExpr(v);
      if (arg.kind === 'error') return T.error;
      if (arg.kind === 'none') {
        this.error(Codes.NeedsAnnotation, e.args[0].span, `cannot tell what this ${handle} holds`, `annotate it: \`let m: ${handle}<string?> = s.${method}(none)\``);
        return T.error;
      }
    }
    if (handle === 'Atomic' && !this.checkAtomic(arg, e.args[0].span)) return T.error;
    const type: HandleType = { kind: 'handle', handle, arg };
    this.taskCalls.set(e, { kind: 'make', type });
    return type;
  }

  /** An Atomic holds what the hardware swaps in one step: an int or a bool. */
  private checkAtomic(t: Type, span: Span): boolean {
    if (t.kind === 'int' || t.kind === 'bool' || t.kind === 'error') return true;
    this.error(Codes.TypeMismatch, span, `an Atomic holds an int or a bool, not ${this.show(t)}`, 'for anything else, use a Mutex: `s.mutex(...)`');
    return false;
  }

  /** A method of a Mutex, Atomic or Channel. None needs `uses`: having the handle is enough, as for a Scope. */
  private sharedCall(e: ast.Call, callee: ast.Member, h: HandleType, hint: Type | null): Type {
    const name = callee.name;
    const methods = sharedMethods(h);
    if (!methods.includes(name)) {
      this.arity(e, name, -1, false);
      const help =
        name === 'set' && h.handle === 'Mutex'
          ? 'a Mutex changes by function, so no update is lost: `m.update((v) => ...)`'
          : methods.length === 0
            ? 'an Arm is one choice for `tasks.select([...])`, which runs the function given to it'
            : `available: ${methods.join(', ')}`;
      this.error(Codes.NoSuchMember, callee.nameSpan, `${this.show(h)} has no method${methods.length === 0 ? 's' : ` \`${name}\``}`, help);
      return T.error;
    }
    const n = { get: 0, recv: 0, close: 0, compareAndSet: 2, onSend: 2 }[name as 'get'] ?? 1;
    if (!this.arity(e, name, n)) return T.error;
    this.taskCalls.set(e, { kind: 'shared', type: h, method: name });
    const v = h.arg;
    switch (name) {
      case 'onRecv':
        return this.armOf(e, 'onRecv', e.args[0], [{ kind: 'option', inner: v }], v, hint);
      case 'onSend':
        this.checkAgainst(e.args[0], v);
        return this.armOf(e, 'onSend', e.args[1], [], null, hint);
      case 'get':
        return v;
      case 'recv':
        return { kind: 'option', inner: v };
      case 'close':
        return T.unit;
      case 'set':
      case 'send':
        this.checkAgainst(e.args[0], v);
        return T.unit;
      case 'add':
        this.checkAgainst(e.args[0], T.int);
        return T.int;
      case 'compareAndSet':
        this.checkAgainst(e.args[0], v);
        this.checkAgainst(e.args[1], v);
        return T.bool;
      case 'update': {
        const f = this.checkFnArg(e.args[0], [v], v);
        if (!f) return T.error;
        this.underLock(f, e.args[0], name);
        return v;
      }
      case 'hold': {
        // Effects allowed: the call performs them, as for `map`.
        const f = this.checkFnArg(e.args[0], [], null);
        return f ? f.ret : T.error;
      }
      default: {
        const f = this.checkFnArg(e.args[0], [v], null);
        if (!f || f.ret.kind === 'error') return T.error;
        if (f.ret.kind !== 'tuple' || f.ret.elems.length !== 2 || !sameType(f.ret.elems[0], v)) {
          this.error(
            Codes.TypeMismatch,
            e.args[0].span,
            `the function given to \`updateWith\` returns the new value and a result, \`(${this.show(v)}, R)\`, found ${this.show(f.ret)}`,
            'as in `m.updateWith((n) => (n + 1, n))`, which stores n + 1 and gives back n',
          );
          return T.error;
        }
        this.underLock(f, e.args[0], name);
        return f.ret.elems[1];
      }
    }
  }

  /** The function given to `update` runs under the lock: no effects, so it can't hold it long. */
  private underLock(f: FnType, arg: ast.Expr, method: string) {
    if (f.uses.length === 0) return;
    this.error(
      Codes.EffectUnderLock,
      arg.span,
      `the function given to \`${method}\` runs while the Mutex is locked, so it can't use effects (it uses ${f.uses.join(', ')})`,
      `do the effect before or after: \`${method}\` gives back what the function returned`,
    );
  }

  /** `tasks.both(a, b)`: both results at once, as a tuple. If either can fail, a Result of one. */
  private bothCall(e: ast.Call): Type {
    if (!this.arity(e, 'tasks.both', 2)) return T.error;
    const fa = this.checkFnArg(e.args[0], [], null);
    const fb = this.checkFnArg(e.args[1], [], null);
    if (!fa || !fb || fa.ret.kind === 'error' || fb.ret.kind === 'error') return T.error;
    for (const [f, arg] of [[fa, e.args[0]], [fb, e.args[1]]] as const) {
      if (f.ret.kind === 'unit') {
        this.error(Codes.NoValue, arg.span, '`tasks.both` gives both results, but this function returns nothing', 'to run work that gives nothing back, spawn it in a `tasks.scope`');
        return T.error;
      }
    }
    const a = fa.ret;
    const b = fb.ret;
    const ok = (t: Type) => (t.kind === 'result' ? t.ok : t);
    const pair: Type = { kind: 'tuple', elems: [ok(a), ok(b)] };
    let ret: Type = pair;
    if (a.kind === 'result' && b.kind === 'result' && !sameType(a.err, b.err)) {
      this.error(
        Codes.TypeMismatch,
        e.span,
        `both functions can fail, but with different errors, ${this.show(a.err)} and ${this.show(b.err)}`,
        'the first failure becomes the result, so convert one with `match` inside its function',
      );
      return T.error;
    }
    const err = a.kind === 'result' ? a.err : b.kind === 'result' ? b.err : null;
    if (err) ret = { kind: 'result', ok: pair, err };
    this.taskCalls.set(e, { kind: 'both', a, b, ret });
    return ret;
  }

  /**
   * An arm for `tasks.select`: `ch.onRecv(f)`, `ch.onSend(v, f)`, `tasks.after(ms, f)`,
   * `tasks.otherwise(f)`. Its function runs in the selecting task once the arm is picked, so it
   * may use effects; they are captured here, as for `s.spawn`. What it gives is the arm's `R`,
   * known from where the arm goes, or from the function.
   */
  private armOf(e: ast.Call, method: ArmMethod, arg: ast.Expr, params: Type[], elem: Type | null, hint: Type | null): Type {
    const want = hint?.kind === 'handle' && hint.handle === 'Arm' ? hint.arg : null;
    const f = this.checkFnArg(arg, params, want);
    if (!f || f.ret.kind === 'error') return T.error;
    this.taskCalls.set(e, { kind: 'arm', method, ret: f.ret, elem });
    return { kind: 'handle', handle: 'Arm', arg: f.ret };
  }

  /**
   * `tasks.select(arms)`: waits until an arm is ready, picks one of those, runs its function and
   * gives what it returned. Every arm gives the same `R`: the first arm of a literal list says
   * which, unless the context does.
   */
  private selectCall(e: ast.Call, hint: Type | null): Type {
    if (!this.arity(e, 'tasks.select', 1)) return T.error;
    const arg = e.args[0];
    const example = 'write `tasks.select([a.onRecv((x) => ...), tasks.after(100, () => ...)])`';
    if (arg.kind !== 'ListLit') {
      const t = this.checkExpr(arg);
      if (t.kind === 'error') return T.error;
      if (t.kind !== 'list' || t.elem.kind !== 'handle' || t.elem.handle !== 'Arm') {
        this.error(Codes.TypeMismatch, arg.span, `\`tasks.select\` takes a List of arms, found ${this.show(t)}`, example);
        return T.error;
      }
      this.taskCalls.set(e, { kind: 'select', ret: t.elem.arg });
      return t.elem.arg;
    }
    if (arg.items.length === 0) {
      this.error(Codes.ArgCount, arg.span, '`tasks.select` needs at least one arm', example);
      return T.error;
    }
    let ret: Type | null = hint;
    let failed = false;
    let otherwise = false;
    for (const item of arg.items) {
      // A call making an arm takes `R` from the arms before it; anything else is checked on its own.
      const makesArm = item.kind === 'Call' && item.callee.kind === 'Member' && (armMethods as readonly string[]).includes(item.callee.name);
      const t = ret && makesArm ? this.checkAgainst(item, { kind: 'handle', handle: 'Arm', arg: ret }) : this.checkExpr(item);
      if (t.kind === 'error') {
        failed = true;
        continue;
      }
      if (t.kind === 'handle' && t.handle === 'Arm' && ret && !sameType(t.arg, ret)) {
        this.mismatch(item.span, { kind: 'handle', handle: 'Arm', arg: ret }, t);
        failed = true;
        continue;
      }
      if (t.kind !== 'handle' || t.handle !== 'Arm') {
        this.error(
          Codes.TypeMismatch,
          item.span,
          `an arm for \`tasks.select\` is expected here, found ${this.show(t)}`,
          'arms are `ch.onRecv(f)`, `ch.onSend(v, f)`, `tasks.after(ms, f)` and `tasks.otherwise(f)`',
        );
        failed = true;
        continue;
      }
      ret ??= t.arg;
      const call = item.kind === 'Call' ? this.taskCalls.get(item) : undefined;
      if (call?.kind === 'arm' && call.method === 'otherwise') {
        if (otherwise) {
          this.error(Codes.ArgCount, item.span, '`tasks.select` takes one `otherwise` arm', 'it runs only when no other arm is ready, so a second could never be picked');
          failed = true;
        }
        otherwise = true;
      }
    }
    if (failed || !ret || ret.kind === 'error') return T.error;
    this.types.set(arg, { kind: 'list', elem: { kind: 'handle', handle: 'Arm', arg: ret } });
    this.taskCalls.set(e, { kind: 'select', ret });
    return ret;
  }

  /** The effect rule: a caller must declare every effect its callee declares. */
  private checkCallEffects(callee: ast.Ident, sig: FnSig) {
    this.perform(sig.uses, callee.span, `\`${sig.name}\``);
  }

  private addEffectHelp(effect: string): string {
    return this.fn.uses.length > 0
      ? `add \`${effect}\` to the \`uses\` clause of \`fn ${this.fn.name}\``
      : `add \`uses ${effect}\` to the signature of \`fn ${this.fn.name}\``;
  }

  /** `-> T`. Without one, a function returns `void`, so `-> void` says nothing. */
  private resolveReturn(te: ast.TypeExpr | null): Type {
    if (!te) return T.unit;
    const t = this.resolveType(te);
    if (t.kind === 'unit') this.warn(Codes.NeedlessVoid, te.span, 'a function without `->` already returns `void`', 'leave out `-> void`');
    return t;
  }

  private resolveType(te: ast.TypeExpr): Type {
    const base = this.resolveBaseType(te);
    if (!te.optional || base.kind === 'error') return base;
    return { kind: 'option', inner: base };
  }

  private resolveBaseType(te: ast.TypeExpr): Type {
    if (te.kind === 'TupleType') {
      const elems = te.elems.map((x) => this.resolveType(x));
      return elems.some((x) => x.kind === 'error') ? T.error : { kind: 'tuple', elems };
    }
    if (te.kind === 'FnType') {
      const params = te.params.map((p) => this.resolveType(p));
      const ret = this.resolveReturn(te.returnType);
      const uses: string[] = [];
      let failed = params.some((p) => p.kind === 'error') || ret.kind === 'error';
      for (const ref of te.uses) {
        const name = ref.path.join('.');
        if (this.effectType(name)) {
          uses.push(name);
        } else {
          failed = true;
          this.error(
            Codes.UnknownEffect,
            ref.span,
            `unknown effect \`${name}\``,
            `known effects: ${this.effectNames().join(', ')}. Inside \`<...>\`, wrap a function type in parentheses: \`List<(fn() uses io)>\``,
          );
        }
      }
      return failed ? T.error : fn(params, ret, uses);
    }
    if (te.name === 'Self') {
      if (!this.selfType) {
        this.error(Codes.UnknownType, te.span, '`Self` only means something in a `trait` or an `impl`', 'name the type');
        return T.error;
      }
      if (te.args.length === 0) return this.selfType;
      this.error(Codes.TypeArgs, te.span, '`Self` takes no type arguments', 'write `Self`');
      return T.error;
    }
    if (this.traitNamed(te.name)) {
      this.error(Codes.UnknownType, te.span, `\`${te.name}\` is a trait, not a type`, `take a type parameter that has it: \`fn f<T: ${te.name}>(x: T)\``);
      return T.error;
    }
    const opaque = this.opaques.get(te.name);
    if (opaque) {
      if (te.args.length > 0) {
        this.error(Codes.TypeArgs, te.span, `\`${te.name}\` takes no type arguments`, `write \`${te.name}\``);
        return T.error;
      }
      if (this.inEffectCode) return opaque;
      this.error(
        Codes.GoTypeOutside,
        te.span,
        `\`${te.name}\` is a Go type, so only the code of \`effect ${this.mod.name}\` can hold one`,
        `outside, Candor holds Candor values: an operation takes and gives those, and keeps the \`${te.name}\` in the effect's state (\`let mut conn: ${te.name}? = none\`)`,
      );
      return T.error;
    }
    const tp = this.typeParams.get(te.name);
    if (tp) {
      if (te.args.length > 0) {
        this.error(Codes.TypeArgs, te.span, `\`${te.name}\` is a type parameter, so it takes no type arguments`, `write \`${te.name}\``);
        return T.error;
      }
      return tp;
    }
    if (te.name === 'List' || te.name === 'Array') {
      if (te.name === 'Array' || te.args.length !== 1) {
        this.error(Codes.UnknownType, te.span, te.name === 'Array' ? 'there is no `Array` type' : '`List` takes one type', 'write `List<T>`');
        return T.error;
      }
      const elem = this.resolveType(te.args[0]);
      return elem.kind === 'error' ? T.error : { kind: 'list', elem };
    }
    if (te.name === 'Map') {
      if (te.args.length !== 2) {
        this.error(Codes.UnknownType, te.span, '`Map` takes two types', 'write `Map<K, V>`: the key, then the value');
        return T.error;
      }
      const key = this.resolveType(te.args[0]);
      const value = this.resolveType(te.args[1]);
      if (key.kind === 'error' || value.kind === 'error') return T.error;
      return this.checkKey(key, te.args[0].span) ? { kind: 'map', key, value } : T.error;
    }
    if (te.name === 'Scope' && te.args.length === 0) return { kind: 'scope', id: 0 };
    const handle = handleNames.find((h) => h === te.name);
    if (handle === 'Lock') {
      if (te.args.length === 0) return { kind: 'handle', handle, arg: T.unit };
      this.error(Codes.UnknownType, te.span, '`Lock` takes no type', 'write `Lock`: it guards what its `hold` functions do, and holds nothing');
      return T.error;
    }
    if (handle) {
      if (te.args.length !== 1) {
        const what = handle === 'Channel' ? 'what goes through it' : handle === 'Arm' ? 'what `tasks.select` gives when it picks the arm' : 'what it holds';
        this.error(Codes.UnknownType, te.span, `\`${handle}\` takes one type`, `write \`${handle}<T>\`: ${what}`);
        return T.error;
      }
      const arg = this.resolveType(te.args[0]);
      if (arg.kind === 'error') return T.error;
      if (handle === 'Atomic' && !this.checkAtomic(arg, te.args[0].span)) return T.error;
      return { kind: 'handle', handle, arg };
    }
    if (te.name === 'Task') {
      if (te.args.length !== 1) {
        this.error(Codes.UnknownType, te.span, '`Task` takes one type', 'write `Task<T>`: what `join()` gives');
        return T.error;
      }
      const result = this.resolveType(te.args[0]);
      return result.kind === 'error' ? T.error : { kind: 'task', result };
    }
    if (te.name === 'Result') {
      if (te.args.length !== 2) {
        this.error(Codes.UnknownType, te.span, '`Result` takes two types', 'write `Result<T, E>`: the value, then the error');
        return T.error;
      }
      const ok = this.resolveType(te.args[0]);
      const err = this.resolveType(te.args[1]);
      return ok.kind === 'error' || err.kind === 'error' ? T.error : { kind: 'result', ok, err };
    }
    if (te.name === 'Option') {
      const arg = te.args[0];
      const inner = arg?.kind === 'TypeName' ? arg.name : 'T';
      this.error(Codes.UnknownType, te.span, 'there is no `Option` type', `write \`${inner}?\``);
      return T.error;
    }
    const path = te.name.split('.');
    if (path.length > 1 || this.imports.has(te.name)) {
      const found = this.typeAt(path, te.span);
      if (!found) return T.error;
      if (found.rest.length === 0) return this.applyTypeArgs(found.ty, te.args, te.span, te.name);
      this.error(Codes.UnknownType, te.span, `\`${te.name}\` is not a type`, `write \`${path.slice(0, path.length - found.rest.length).join('.')}\``);
      return T.error;
    }
    const builtin = resolveTypeName(te.name);
    if (builtin && te.args.length > 0) {
      this.error(Codes.UnknownType, te.span, `\`${te.name}\` takes no type parameters`, `write \`${te.name}\``);
      return T.error;
    }
    if (builtin) return builtin;
    const ty = this.userTypes.get(te.name);
    if (ty) return this.applyTypeArgs(ty, te.args, te.span, te.name);
    this.error(
      Codes.UnknownType,
      te.span,
      `unknown type \`${te.name}\``,
      this.importedType(te.name) ?? choices(te.name, [...typeNames(), ...this.userTypes.keys(), ...this.typeParams.keys()]),
    );
    return T.error;
  }

  /** `Page<int>`: a declared type with the type arguments written after it. */
  private applyTypeArgs(ty: UserType, argExprs: ast.TypeExpr[], span: Span, written: string): Type {
    const n = ty.params.length;
    if (n === 0) {
      if (argExprs.length === 0) return ty;
      this.error(Codes.TypeArgs, span, `\`${written}\` is not generic, so it takes no type arguments`, `write \`${written}\``);
      return T.error;
    }
    const args = argExprs.map((a) => this.resolveType(a));
    if (args.length !== n) {
      this.error(
        Codes.TypeArgs,
        span,
        args.length === 0 ? `\`${written}\` is generic, so it needs ${n === 1 ? 'a type argument' : `${n} type arguments`}` : `\`${written}\` takes ${n} type${n === 1 ? '' : 's'}, found ${args.length}`,
        `write \`${written}<${ty.params.map((p) => p.name).join(', ')}>\`, with the type${n === 1 ? '' : 's'} in place of ${ty.params.map((p) => `\`${p.name}\``).join(' and ')}`,
      );
      return T.error;
    }
    if (args.some((a) => a.kind === 'error')) return T.error;
    if (!this.checkBounds(ty.params, args, span, `\`${written}\``)) return T.error;
    if (this.defining === ty && !args.every((a, i) => a === ty.params[i])) {
      const own = `${ty.name}<${ty.params.map((p) => p.name).join(', ')}>`;
      this.error(Codes.TypeArgs, span, `inside its own declaration, \`${ty.name}\` can only be \`${own}\``, 'Go cannot build a type that holds itself with other type arguments');
      return T.error;
    }
    return instantiate(ty, args);
  }

  private ctorName(target: CtorTarget): string {
    return target.kind === 'struct' ? this.show(target.type) : `${this.show(target.type)}.${target.variant.name}`;
  }

  /** `t` as this module writes it: imported types carry their module, `http.HttpError`. */
  private show(t: Type): string {
    return typeToString(t, this.mod.name);
  }

  private mismatch(span: Span, expected: Type, found: Type) {
    const help =
      expected.kind === 'string' && found.kind === 'char'
        ? 'a char is not a string: `c.toString()` makes one'
        : expected.kind === 'char' && found.kind === 'string'
          ? "a char is written in single quotes, `'a'`; for a string's first one, `s.chars().first()`"
          : found.kind === 'option' && sameType(found.inner, expected)
            ? // #a64e87fe: `97.toChar()`, `xs[0]`, `s.toInt()` give optionals.
              `this may be \`none\`: give a default, \`x ?? ${defaultOf(expected)}\`, or handle it first: \`if x == none { return ... }\`, after which \`x\` is ${this.show(expected)}`
            : undefined;
    this.error(Codes.TypeMismatch, span, `expected ${this.show(expected)}, found ${this.show(found)}`, help);
  }

  private error(code: Code, span: Span, message: string, help?: string) {
    this.diagnostics.push({ code, severity: 'error', message, help, file: this.file, span });
  }

  private warn(code: Code, span: Span, message: string, help?: string) {
    this.diagnostics.push({ code, severity: 'warning', message, help, file: this.file, span });
  }
}

const SLICE_HELP = '`s.slice(start)` runs to the end; `s.slice(start, end)` stops before `end`; both clamp to the length';
const taskMethods = methodNames('tasks');
const scopeMethods = methodNames('scope');
const armMethods: readonly ArmMethod[] = ['onRecv', 'onSend', 'after', 'otherwise'];

function sharedMethods(t: HandleType): string[] {
  switch (t.handle) {
    case 'Mutex':
      return methodNames('mutex');
    case 'Atomic':
      return methodNames('atomic').filter((m) => m !== 'add' || t.arg.kind === 'int');
    case 'Channel':
      return methodNames('channel');
    case 'Lock':
      return methodNames('lock');
    case 'Arm':
      return [];
  }
}

/** `a Mutex`, `an Arm`. */
function article(name: string): string {
  return /^[AEIOU]/.test(name) ? 'an' : 'a';
}

/** The Mutex, Atomic or Channel a value of `t` holds, if any. */
function heldHandle(t: Type, seen = new Set<Type>()): HandleType | null {
  if (seen.has(t)) return null;
  seen.add(t);
  if (t.kind === 'handle') return t;
  const parts = t.kind === 'list' ? [t.elem] : t.kind === 'map' ? [t.key, t.value] : children(t).map((c) => c.type);
  for (const p of parts) {
    const h = heldHandle(p, seen);
    if (h) return h;
  }
  return null;
}

/** Whether `t` is, or holds, one of an effect's Go types. */
function holdsOpaque(t: Type): boolean {
  switch (t.kind) {
    case 'opaque':
      return true;
    case 'option':
      return holdsOpaque(t.inner);
    case 'list':
      return holdsOpaque(t.elem);
    case 'map':
      return holdsOpaque(t.key) || holdsOpaque(t.value);
    case 'tuple':
      return t.elems.some(holdsOpaque);
    case 'result':
      return holdsOpaque(t.ok) || holdsOpaque(t.err);
    default:
      return false;
  }
}

/** What a binding can pass to Go and back. Go's types are checked against these when it builds. */
function externValueType(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || t.kind === 'bool' || t.kind === 'bytes' || (t.kind === 'list' && t.elem.kind === 'string');
}

const mapMethods = methodNames('map');
const listMethods = methodNames('list');

/** `f`, `handlers.onSave`: a callee as written, for messages. */
function exprText(e: ast.Expr): string {
  if (e.kind === 'Ident') return e.name;
  if (e.kind === 'Member') return `${exprText(e.object)}.${e.name}`;
  return 'this function';
}

const INT_MAX = 2n ** 63n - 1n;
const INT_MIN = -(2n ** 63n);

/**
 * Whether a value of type `from` can hold a `target`. `needSum`: only paths through an enum,
 * `T?` or Result count. `byValueOnly`: boxed fields don't count.
 */
function reaches(from: Type, target: UserType, opts: { needSum: boolean; byValueOnly: boolean }): boolean {
  const seen = new Map<Type, Set<boolean>>();
  const visit = (t: Type, sawSum: boolean): boolean => {
    if (t === target) return sawSum || !opts.needSum;
    const states = seen.get(t) ?? new Set<boolean>();
    // Generic types that hold each other with growing arguments never repeat; Go refuses those.
    if (states.has(sawSum) || seen.size > 1000) return false;
    states.add(sawSum);
    seen.set(t, states);
    const next = sawSum || isSum(t);
    return children(t).some((c) => !(opts.byValueOnly && c.boxed) && visit(c.type, next));
  };
  return visit(from, false);
}

/** Names the language gives meaning to; types and functions can't take them. */
const builtinNames = new Set(['Result', 'Ok', 'Err', 'Option', 'Some', 'None', 'List', 'Map', 'Scope', 'Task', ...handleNames, 'Self', 'Eq', 'Ord', 'Show', 'Json', 'Row']);

/** A value given for a part declared with type parameters; `effect`: for a `uses f` parameter. */
interface InferItem {
  expr: ast.Expr;
  type: Type;
  effect: boolean;
  /** What it is, for an error that names where a type came from: "field `items`". */
  label: string;
  /** A user function's parameter it is given for: a function with effects its type doesn't allow gets help naming `uses f`. */
  param?: { fn: string; name: string };
}

/** What a function's signature is resolved from. Extern functions have no type parameters. */
type SigDecl = Pick<ast.FnDecl, 'name' | 'params' | 'returnType' | 'uses'> & { typeParams?: ast.TypeParam[] };

/** Expressions whose type comes from where they go, so other arguments must speak first. */
function needsContext(e: ast.Expr): boolean {
  return (
    e.kind === 'Lambda' ||
    e.kind === 'None' ||
    (e.kind === 'Call' && resultCtor(e) !== null) ||
    // #a64e87fe: `[Ok("a")]`, `["k": none]`; a lambda in a list can say its own type.
    (e.kind === 'ListLit' && (e.items.length === 0 || e.items.some((x) => x.kind !== 'Lambda' && needsContext(x)))) ||
    (e.kind === 'MapLit' && (e.entries.length === 0 || e.entries.some((x) => x.value.kind !== 'Lambda' && needsContext(x.value)))) ||
    (e.kind === 'TupleLit' && e.items.some(needsContext)) ||
    (e.kind === 'StructLit' && e.short)
  );
}

/** Where a lambda's `return` says nothing of its type (`none` says `_?`); see `shapeOf`. */
const hole = param('_');

/**
 * Two returns' shapes as one: a hole takes what the other says, `T` and `_?` make a `T?`. Where
 * they disagree the first wins, and the other is reported when it is checked against it.
 */
function mergeShapes(a: Type, b: Type): Type {
  if (a === hole) return b;
  if (b === hole) return a;
  if (a.kind === 'error' || b.kind === 'error') return T.error;
  if (a.kind === 'option' && b.kind === 'option') return { kind: 'option', inner: mergeShapes(a.inner, b.inner) };
  if (a.kind === 'option') return { kind: 'option', inner: mergeShapes(a.inner, b) };
  if (b.kind === 'option') return { kind: 'option', inner: mergeShapes(a, b.inner) };
  if (a.kind === 'result' && b.kind === 'result') return { kind: 'result', ok: mergeShapes(a.ok, b.ok), err: mergeShapes(a.err, b.err) };
  if (a.kind === 'list' && b.kind === 'list') return { kind: 'list', elem: mergeShapes(a.elem, b.elem) };
  if (a.kind === 'map' && b.kind === 'map') return { kind: 'map', key: mergeShapes(a.key, b.key), value: mergeShapes(a.value, b.value) };
  if (a.kind === 'tuple' && b.kind === 'tuple' && a.elems.length === b.elems.length) return { kind: 'tuple', elems: a.elems.map((x, i) => mergeShapes(x, b.elems[i])) };
  return a;
}

/** How many holes a shape has. */
function holes(t: Type): number {
  if (t === hole) return 1;
  switch (t.kind) {
    case 'option':
      return holes(t.inner);
    case 'result':
      return holes(t.ok) + holes(t.err);
    case 'list':
      return holes(t.elem);
    case 'map':
      return holes(t.key) + holes(t.value);
    case 'tuple':
      return t.elems.reduce((n, x) => n + holes(x), 0);
    default:
      return 0;
  }
}

/** The holes left in a shape, filled from what the place the result goes says (its unknowns are `error`). */
function fillShape(t: Type, hint: Type): Type {
  if (t === hole) return hint.kind === 'error' ? hole : hint;
  if (t.kind === 'option' && hint.kind === 'option') return { kind: 'option', inner: fillShape(t.inner, hint.inner) };
  if (t.kind === 'result' && hint.kind === 'result') return { kind: 'result', ok: fillShape(t.ok, hint.ok), err: fillShape(t.err, hint.err) };
  if (t.kind === 'list' && hint.kind === 'list') return { kind: 'list', elem: fillShape(t.elem, hint.elem) };
  if (t.kind === 'map' && hint.kind === 'map') return { kind: 'map', key: fillShape(t.key, hint.key), value: fillShape(t.value, hint.value) };
  if (t.kind === 'tuple' && hint.kind === 'tuple' && t.elems.length === hint.elems.length) return { kind: 'tuple', elems: t.elems.map((x, i) => fillShape(x, hint.elems[i])) };
  if (t.kind === 'option' && hint.kind !== 'option') return t;
  if (hint.kind === 'option' && t.kind !== 'option') return fillShape(t, hint.inner);
  return t;
}

/** A constructor target on an instance of its type: `Tree<int>.Node` rather than `Tree<T>.Node`. */
function withType<C extends CtorTarget>(target: C, t: UserType): C {
  if (target.kind === 'struct' || t.kind === 'struct') return { kind: 'struct', type: t } as C;
  return { kind: 'variant', type: t, variant: t.variants.find((v) => v.name === target.variant.name)! } as C;
}

/** `Ok(x)` or `Err(e)`. The names are reserved, so nothing else can be called that. */
function resultCtor(e: ast.Call): 'Ok' | 'Err' | null {
  return e.callee.kind === 'Ident' && (e.callee.name === 'Ok' || e.callee.name === 'Err') ? e.callee.name : null;
}

/** The value a block yields: its last expression, if it ends in one. */
function valueExpr(b: ast.Block): ast.Expr | null {
  const last = b.stmts.at(-1);
  return last?.kind === 'ExprStmt' ? last.expr : null;
}

/**
 * The values an `if` or `match` gives, through nested ones: null if a branch gives none (an
 * `if` without `else`, a block ending in a statement) and doesn't leave by `return`.
 */
function branchValues(e: ast.If | ast.Match): ast.Expr[] | null {
  if (e.kind === 'Match') return valuesOf(e.arms.map((a) => a.body));
  if (e.else === null) return null;
  const then = valuesOf([e.then]);
  const rest = e.else.kind === 'Block' ? valuesOf([e.else]) : branchValues(e.else);
  return then && rest ? [...then, ...rest] : null;
}

function valuesOf(blocks: ast.Block[]): ast.Expr[] | null {
  const out: ast.Expr[] = [];
  for (const b of blocks) {
    if (exits(b)) continue;
    const v = valueExpr(b);
    if (!v) return null;
    const inner = v.kind === 'If' || v.kind === 'Match' ? branchValues(v) : [v];
    if (!inner) return null;
    out.push(...inner);
  }
  return out;
}

/**
 * Turns an `if` or `match` that is a lambda's whole body into one whose branches `return` their
 * values (`branchValues` said they all have one), so the returns say the lambda's result
 * together: `Err("x")` in one arm and `Ok(n)` in another.
 */
function returnsInBranches(e: ast.If | ast.Match): boolean {
  const values = branchValues(e);
  if (!values || !values.some(needsContext)) return false;
  returnBranches(e);
  return true;
}

function returnBranches(e: ast.If | ast.Match) {
  const blocks = e.kind === 'Match' ? e.arms.map((a) => a.body) : [e.then, ...(e.else?.kind === 'Block' ? [e.else] : [])];
  if (e.kind === 'If' && e.else?.kind === 'If') returnBranches(e.else);
  for (const b of blocks) {
    const last = b.stmts.at(-1);
    if (last?.kind !== 'ExprStmt') continue;
    if (last.expr.kind === 'If' || last.expr.kind === 'Match') returnBranches(last.expr);
    else b.stmts[b.stmts.length - 1] = { kind: 'Return', value: last.expr, span: last.span };
  }
}

/** Names models reach for out of habit from other languages, with what Candor says instead. */
const habits = new Map<string, [string, string]>([
  ['null', ['Candor has no `null`', 'absence is `none`, and only a `T?` can hold it']],
  ['undefined', ['Candor has no `undefined`', 'absence is `none`, and only a `T?` can hold it']],
  ['nil', ['Candor has no `nil`', 'absence is `none`, and only a `T?` can hold it']],
  ['None', ['there is no `None`', 'write `none`']],
  ['Some', ['there is no `Some`', 'write the value itself: a `T` is accepted where a `T?` is expected']],
  ['Ok', ['`Ok` must be called', 'write `Ok(value)`']],
  ['Err', ['`Err` must be called', 'write `Err(error)`']],
  ['Math', ['Candor has no `Math`', 'numbers have the methods: `a.max(b)`, `a.min(b)`, `x.pow(y)`, `x.abs()`, `x.sqrt()`, `x.floor()`; a list has `xs.max()`']],
  ['math', ['Candor has no `math` module', 'numbers have the methods: `a.max(b)`, `a.min(b)`, `x.pow(y)`, `x.abs()`, `x.sqrt()`, `x.floor()`; a list has `xs.max()`']],
  ['max', ['there is no `max` function', 'call it on a number, `a.max(b)`, or on a list, `xs.max()` (a `T?`)']],
  ['min', ['there is no `min` function', 'call it on a number, `a.min(b)`, or on a list, `xs.min()` (a `T?`)']],
  ['pow', ['there is no `pow` function', 'call it on the base: `x.pow(y)`']],
  ['abs', ['there is no `abs` function', 'call it on the number: `x.abs()`']],
]);

/** A literal pattern's value, normalised: `-0` and `0` are one int; strings keep their quotes. */
function literalKey(p: ast.LiteralPattern): string {
  if (p.value.kind === 'Int') return BigInt((p.negative ? '-' : '') + p.value.value).toString();
  if (p.value.kind === 'String') return JSON.stringify(p.value.value);
  if (p.value.kind === 'Char') return `'${p.value.value}'`;
  return String(p.value.value);
}

/** "did you mean `x`?" if a candidate is close, otherwise the full list. */
function choices(name: string, candidates: string[]): string {
  const near = suggest(name, candidates);
  return near ? `did you mean \`${near}\`?` : `available: ${candidates.join(', ')}`;
}

/** The closest candidate, if it is close enough to be a likely typo. */
export function suggest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Paths of `T?` values known to be present. */
type Facts = Set<string>;

/** `x`, `u.manager`: an identifier and its fields, written out. Anything else is not a path. */
function pathOf(e: ast.Expr): string | null {
  if (e.kind === 'Ident') return e.name;
  if (e.kind !== 'Member') return null;
  const o = pathOf(e.object);
  return o === null ? null : `${o}.${e.name}`;
}

/** The variable a field path starts at: `s` in `s.a.b`. */
function rootOf(e: ast.Expr): ast.Expr {
  while (e.kind === 'Member') e = e.object;
  return e;
}

function withAll(a: Facts, b: Facts): Facts {
  return b.size === 0 ? a : new Set([...a, ...b]);
}

const union = withAll;

function intersect(a: Facts, b: Facts): Facts {
  return new Set([...a].filter((x) => b.has(x)));
}

/** `paths` and everything under them (`u` takes `u.manager` with it). `below`: only what is under them. */
function withoutAll(a: Facts, paths: Facts, below = false): Facts {
  const gone = (k: string) => [...paths].some((p) => (!below && k === p) || k.startsWith(p + '.'));
  return [...a].some(gone) ? new Set([...a].filter((k) => !gone(k))) : a;
}

function without(a: Facts, path: string): Facts {
  return withoutAll(a, new Set([path]));
}

/** Every path assigned inside `node`, at any depth. `xs[i] = v` assigns none: `xs` stays present. */
function assignedPaths(node: unknown, out: Facts = new Set()): Facts {
  if (Array.isArray(node)) {
    for (const x of node) assignedPaths(x, out);
  } else if (node && typeof node === 'object') {
    if ((node as ast.Stmt).kind === 'Assign') {
      const p = pathOf((node as ast.AssignStmt).target);
      if (p !== null) out.add(p);
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') assignedPaths(v, out);
  }
  return out;
}

/** Whether a `break` inside `node` leaves the loop whose body it is (not one nested in it, nor a lambda's). */
function breaks(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(breaks);
  if (!node || typeof node !== 'object') return false;
  const kind = (node as { kind?: string }).kind;
  if (kind === 'Break') return true;
  if (kind === 'For' || kind === 'While' || kind === 'Lambda') return false;
  return Object.values(node).some((v) => v && typeof v === 'object' && breaks(v));
}

/** A block that never reaches its end: it returns, breaks or continues on every path. */
function exits(block: ast.Block): boolean {
  return block.stmts.some(
    (s) => s.kind === 'Return' || s.kind === 'Break' || s.kind === 'Continue' || (s.kind === 'ExprStmt' && exprExits(s.expr)),
  );
}

function exprExits(e: ast.Expr): boolean {
  if (e.kind === 'If') return e.else !== null && exits(e.then) && (e.else.kind === 'If' ? exprExits(e.else) : exits(e.else));
  if (e.kind === 'Match') return e.arms.length > 0 && e.arms.every((a) => exits(a.body));
  return false;
}

/** What a column holds: int, string, bool, or an optional of one for NULL. */
function column(t: Type): boolean {
  return rowPrimitive(t.kind === 'option' ? t.inner : t);
}

/** What a list, map, optional or Result shows through: `Show` if each of these is. Empty for any other type. */
export function showInner(t: Type): Type[] {
  if (t.kind === 'list') return [t.elem];
  if (t.kind === 'map') return [t.key, t.value];
  if (t.kind === 'option') return [t.inner];
  // `Ok()` shows nothing inside.
  if (t.kind === 'result') return t.ok.kind === 'unit' ? [t.err] : [t.ok, t.err];
  return [];
}

/** int, string, bool, float and Bytes: what a column holds, and `Row` without an impl. */
function rowPrimitive(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'string' || t.kind === 'bool' || t.kind === 'float' || t.kind === 'bytes';
}

/** int, string, bool, char, float and Bytes (base64): `Json` without an impl. */
function jsonPrimitive(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'string' || t.kind === 'bool' || t.kind === 'char' || t.kind === 'float' || t.kind === 'bytes';
}

/** What a `Json` container's form depends on: `T` of `T?`, `List<T>` and `Map<string, T>`. */
function jsonInner(t: Type): Type | null {
  if (t.kind === 'option') return t.inner;
  if (t.kind === 'list') return t.elem;
  if (t.kind === 'map' && t.key.kind === 'string') return t.value;
  return null;
}
