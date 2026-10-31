import type { Span } from './diagnostics';

export interface Module {
  kind: 'Module';
  name: string;
  nameSpan: Span;
  imports: ImportDecl[];
  decls: Decl[];
  /** Names declared in declarations dropped for a syntax error: unknown, but not missing. */
  lostNames: string[];
  /** What a syntax error skipped inside a declaration that was kept. */
  dropped: Dropped[];
  span: Span;
}

/** A statement, an item of a declaration, or a match arm, left out for a syntax error. */
export interface Dropped {
  span: Span;
  /** The names it would have declared: `let x`, a field, a variant, a method. */
  names: string[];
}

export type Decl = FnDecl | StructDecl | EnumDecl | TestDecl | ExternDecl | EffectDecl | FakeDecl | TraitDecl | ImplDecl | ConstDecl;

/** `const limit = 20`: a scalar known when compiling, lowered to a Go `const`. */
export interface ConstDecl {
  kind: 'ConstDecl';
  pub: Span | null;
  name: string;
  nameSpan: Span;
  type: TypeExpr | null;
  value: Expr;
  span: Span;
}

/** `trait Show { fn show(self) -> string }`: each `impl` gives the methods, or takes their default bodies. */
export interface TraitDecl {
  kind: 'TraitDecl';
  /** `pub`: other modules can use it. Without it, only its own module can. */
  pub: Span | null;
  name: string;
  nameSpan: Span;
  methods: TraitMethod[];
  span: Span;
}

/** `fn show(self) -> string` in a trait; with a body, the default for impls that leave it out. */
export type TraitMethod = Omit<FnDecl, 'kind' | 'pub' | 'body' | 'contracts'> & { kind: 'TraitMethod'; body: Block | null };

/** `impl Show for Point { fn show(self) -> string { ... } }`, `impl<T: Show> Show for Box<T> { ... }`. */
export interface ImplDecl {
  kind: 'ImplDecl';
  /** `<T: Show>` in `impl<T: Show> Show for Box<T>`: one per type argument of the target. */
  typeParams: TypeParam[];
  /** `Show`, `geo.Show`. */
  trait: string;
  traitSpan: Span;
  target: TypeExpr;
  fns: FnDecl[];
  /** `impl Json for Todo`, without a body: the compiler writes it. */
  derived: boolean;
  /** `snake` in `impl Json(snake) for Todo`: how field and variant names read in JSON. */
  rule: { name: string; span: Span } | null;
  /** `nulls` in `impl Json(nulls) for Quote`: a none field is written as `null`, not left out. */
  nulls: Span | null;
  /** Options after the first naming rule or `nulls`, which the checker refuses: `(snake, camel)`. */
  extra: { name: string; span: Span }[];
  /** `string` in `impl Json for Money via string { ... }`: the JSON form, written by hand. */
  via: TypeExpr | null;
  span: Span;
}

/**
 * `effect http { extern ... { ... } pub fn get(...) { ... } }`: the module's effect, named after
 * it. Its operations are Candor functions; the `extern`s inside are theirs alone to call, and so
 * are its helpers (`fn` without `pub`). Its state (`let mut conn: Db? = none`) is set up when
 * `main` starts, and only operations see it.
 */
export interface EffectDecl {
  kind: 'EffectDecl';
  name: string;
  nameSpan: Span;
  state: LetStmt[];
  externs: ExternDecl[];
  ops: FnDecl[];
  helpers: FnDecl[];
  span: Span;
}

/**
 * `fake http { let mut pages = [] fn get(...) { ... } fn serve(...) { ... } }`: what tests get
 * instead of the effect. State, fresh for every test; the operations; and test-only methods.
 */
export interface FakeDecl {
  kind: 'FakeDecl';
  name: string;
  nameSpan: Span;
  state: LetStmt[];
  fns: FnDecl[];
  span: Span;
}

/**
 * `import "bindings/strconv"`: another file, relative to this one; its declarations are `strconv.name`.
 * `import "bytes" as b` names it `b` here instead.
 */
export interface ImportDecl {
  kind: 'Import';
  path: string;
  pathSpan: Span;
  alias?: string;
  aliasSpan?: Span;
  span: Span;
}

/**
 * `extern "strconv" { fn Atoi(s: string) -> Result<int, GoError> as atoi }`: Go symbols with
 * Candor signatures. The path is a Go import path, or `./dir` for a Go package next to the file.
 */
export interface ExternDecl {
  kind: 'ExternDecl';
  /** `pub extern`: every item is `pub`. */
  pub: Span | null;
  /** The Go package's import path, without the version. */
  goPath: string;
  goPathSpan: Span;
  /** `extern "github.com/dustin/go-humanize@v1.0.1"`: the Go module version. */
  version: string | null;
  /** None: the Go package is imported only for what it does when loaded, like a database driver. */
  items: ExternItem[];
  span: Span;
}

export type ExternItem = ExternFn | ExternLet | ExternType;

/** `type *DB as Db`: a Go type (here a pointer to one) that Candor holds but can't look into. */
export interface ExternType {
  kind: 'ExternType';
  goName: string;
  goNameSpan: Span;
  name: string;
  nameSpan: Span;
  /** `*DB`: the binding holds a pointer, so Go may give nil (`Db?`). */
  pointer: boolean;
  span: Span;
}

/** `fn Atoi(s: string) -> Result<int, GoError> as atoi`. Without `as`, the Candor name is the Go name. */
export interface ExternFn {
  kind: 'ExternFn';
  /** Its own `pub`, or its block's. */
  pub: Span | null;
  goName: string;
  goNameSpan: Span;
  name: string;
  nameSpan: Span;
  /** `fn Get(ctx, url: string)`: the Go function takes a `context.Context` first. */
  ctx: Span | null;
  /** `unvetted fn ...`, from a generated draft: nobody has decided yet whether it is pure. */
  unvetted: Span | null;
  /** `fn (db: Db) Query(...)`: a method of a type in the same block; Candor calls it `query(db, ...)`. */
  receiver: Param | null;
  params: Param[];
  /** `...(id: int, body: string)`: what goes into Go's variadic parameter; null if Go has none. */
  spread: Param[] | null;
  returnType: TypeExpr | null;
  uses: EffectRef[];
  span: Span;
}

/** `let ErrRange: GoError as errRange`: a Go package variable, read as a value. */
export interface ExternLet {
  kind: 'ExternLet';
  /** Its own `pub`, or its block's. */
  pub: Span | null;
  goName: string;
  goNameSpan: Span;
  name: string;
  nameSpan: Span;
  type: TypeExpr;
  span: Span;
}

/** `test "name" { ... }`: checked always, compiled only by `candor test`. Every effect is a fake. */
export interface TestDecl {
  kind: 'TestDecl';
  name: string;
  nameSpan: Span;
  body: Block;
  span: Span;
}

export interface StructDecl {
  kind: 'StructDecl';
  /** `pub struct`: other modules can name it. Each field is `pub` on its own. */
  pub: Span | null;
  name: string;
  nameSpan: Span;
  /** `struct Page<T>`. */
  typeParams: TypeParam[];
  fields: FieldDecl[];
  /** The `//` lines directly above it: `flags.parse`'s usage header (#0c2dc168). */
  doc?: string;
  span: Span;
}

export interface EnumDecl {
  kind: 'EnumDecl';
  /** `pub enum`: other modules can name it, its variants and their fields. */
  pub: Span | null;
  name: string;
  nameSpan: Span;
  typeParams: TypeParam[];
  variants: VariantDecl[];
  span: Span;
}

export interface VariantDecl {
  name: string;
  nameSpan: Span;
  /** Empty for a variant without a payload, like `Pending`. */
  fields: FieldDecl[];
  /** `InProgress as "in-progress"`: its name in JSON. */
  wire: { name: string; span: Span } | null;
  span: Span;
}

export interface FieldDecl {
  /** `pub name: T`, in a struct: other modules can read it. A variant's fields are as public as the enum. */
  pub: Span | null;
  name: string;
  nameSpan: Span;
  type: TypeExpr;
  /** `kind_: string as "type"`: its name in JSON, and its flag in `flags.parse`. */
  wire: { name: string; span: Span } | null;
  /** The `//` lines directly above it: its flag's help in `flags.parse`'s usage (#0c2dc168). */
  doc?: string;
  span: Span;
}

/** `T` in `fn first<T>(...)`: a type each use of the declaration picks. */
export interface TypeParam {
  name: string;
  span: Span;
  /** `T: Eq + geo.Show`. */
  bounds: { name: string; span: Span }[];
}

export interface FnDecl {
  kind: 'FnDecl';
  /** `pub`: other modules can use it. Without it, only its own module can. */
  pub: Span | null;
  name: string;
  nameSpan: Span;
  /** `fn first<T>`. */
  typeParams: TypeParam[];
  params: Param[];
  returnType: TypeExpr | null;
  /**
   * The `uses` clause: every effect the function may perform. `uses f`, naming a parameter that
   * is a function, takes on whatever `f` does.
   */
  uses: EffectRef[];
  /** `requires` and `ensures` clauses, in order. */
  contracts: Contract[];
  body: Block;
  span: Span;
  /**
   * `test fn`: a helper for tests. Like a test it may `assert` and use the fakes' own functions,
   * and only tests and other test fns can call it. Built only by `candor test`.
   */
  test?: Span;
}

/** `requires amount > 0`, `ensures result >= 0`: a condition checked on every call. */
export interface Contract {
  clause: 'requires' | 'ensures';
  keywordSpan: Span;
  expr: Expr;
  /** The whole clause, for the failure's diagram. */
  span: Span;
}

export interface Param {
  name: string;
  type: TypeExpr;
  span: Span;
}

export type TypeExpr = TypeName | FnTypeExpr | TupleTypeExpr;

/** `(int, string)`: two or more types. */
export interface TupleTypeExpr {
  kind: 'TupleType';
  elems: TypeExpr[];
  optional: boolean;
  span: Span;
}

export interface TypeName {
  kind: 'TypeName';
  name: string;
  /** `Result<T, E>`. */
  args: TypeExpr[];
  /** `T?`. */
  optional: boolean;
  span: Span;
}

/** `fn(int, string) -> bool uses io`. */
export interface FnTypeExpr {
  kind: 'FnType';
  params: TypeExpr[];
  returnType: TypeExpr | null;
  uses: EffectRef[];
  /** `(fn() -> int)?`. */
  optional: boolean;
  span: Span;
}

export interface EffectRef {
  /** `io` is `['io']`; `net.payments` is `['net', 'payments']`. */
  path: string[];
  span: Span;
}

export interface Block {
  kind: 'Block';
  stmts: Stmt[];
  span: Span;
}

export type Stmt =
  | LetStmt
  | LetTupleStmt
  | ReturnStmt
  | ExprStmt
  | AssertStmt
  | AssignStmt
  | ForStmt
  | WhileStmt
  | BreakStmt
  | ContinueStmt
  | DeferStmt;

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=';

/** `x = 1`, `p.x += 2`. The target is a `let mut` local, or a field path starting at one. */
export interface AssignStmt {
  kind: 'Assign';
  target: Expr;
  op: AssignOp;
  opSpan: Span;
  value: Expr;
  span: Span;
}

/**
 * `for x in xs { }`, `for i in 0..n { }` (`end` set: a half-open range of ints), or
 * `for (k, v) in m { }` (`pattern` set, `name` empty): over a map, or a list of tuples.
 */
export interface ForStmt {
  kind: 'For';
  /** `_` to ignore the element. */
  name: string;
  nameSpan: Span;
  pattern: TuplePattern | null;
  iterable: Expr;
  end: Expr | null;
  body: Block;
  span: Span;
}

export interface WhileStmt {
  kind: 'While';
  cond: Expr;
  body: Block;
  span: Span;
}

export interface BreakStmt {
  kind: 'Break';
  span: Span;
}

export interface ContinueStmt {
  kind: 'Continue';
  span: Span;
}

/** `defer { ... }`: runs when the function ends, however it ends. At the top level of a body only. */
export interface DeferStmt {
  kind: 'Defer';
  body: Block;
  span: Span;
}

/** `assert cond`, in tests only. A failure shows the value of each part of `cond`. */
export interface AssertStmt {
  kind: 'Assert';
  expr: Expr;
  span: Span;
}

export interface LetStmt {
  kind: 'Let';
  /** `let mut`. */
  mutable: boolean;
  name: string;
  nameSpan: Span;
  type: TypeExpr | null;
  value: Expr;
  span: Span;
}

/** `let (lo, hi) = minMax(xs)`: the pattern must match every value. */
export interface LetTupleStmt {
  kind: 'LetTuple';
  pattern: TuplePattern;
  type: TypeExpr | null;
  value: Expr;
  span: Span;
}

export interface ReturnStmt {
  kind: 'Return';
  value: Expr | null;
  span: Span;
}

export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expr;
  span: Span;
}

export type Expr =
  | StringLit
  | Interp
  | IntLit
  | CharLit
  | FloatLit
  | BoolLit
  | NoneLit
  | Ident
  | Member
  | Call
  | Unary
  | Binary
  | Range
  | Try
  | If
  | Match
  | StructLit
  | Lambda
  | ListLit
  | MapLit
  | TupleLit
  | Index;

/** `(1, "a")`: two or more values. Read by position, `t.0`, or by destructuring, `let (n, s) = t`. */
export interface TupleLit {
  kind: 'TupleLit';
  items: Expr[];
  span: Span;
}

/** `(x) => x + 1`, `(a: int, b: int) => { return a * b }`. A block body needs `return`, like a function. */
export interface Lambda {
  kind: 'Lambda';
  params: LambdaParam[];
  /** `(x): int => ...`. Usually left out: the context or the body says. */
  returnType: TypeExpr | null;
  body: Expr | Block;
  span: Span;
}

export interface LambdaParam {
  name: string;
  /** Left out when the context says, as in `xs.map((x) => x + 1)`. */
  type: TypeExpr | null;
  span: Span;
}

/** `[1, 2, 3]`. */
export interface ListLit {
  kind: 'ListLit';
  items: Expr[];
  span: Span;
}

/** `["a": 1, "b": 2]`, or `[:]` for an empty map. */
export interface MapLit {
  kind: 'MapLit';
  entries: { key: Expr; value: Expr }[];
  span: Span;
}

/** `xs[i]`: a `T?`, `none` when `i` is out of range. `m[k]` likewise, `none` when `k` is not a key. */
export interface Index {
  kind: 'Index';
  object: Expr;
  index: Expr;
  bracketSpan: Span;
  span: Span;
}

/** `none`: absence, for a `T?`. */
export interface NoneLit {
  kind: 'None';
  span: Span;
}

/** `x?`: unwrap, or return the error / `none` from the enclosing function. */
export interface Try {
  kind: 'Try';
  operand: Expr;
  /** The `?`. */
  opSpan: Span;
  span: Span;
}

/** `Point { x: 1, y }`, `Status.Paid { at: 5 }`, `Order { ...o, id: 2 }`. */
export interface StructLit {
  kind: 'StructLit';
  /** `['Point']` for a struct, `['Status', 'Paid']` for an enum variant. */
  path: string[];
  /**
   * `.Paid` or `.Paid { at: 5 }` names a variant of the enum expected where it goes; `path` is
   * then the variant alone, and a variant without fields has no braces.
   */
  short: boolean;
  pathSpan: Span;
  /** `...base`: copy every field not given. Structs only. */
  spread: Expr | null;
  /** `Page<int> { ... }`, `Tree<int>.Node { ... }`: `at` is the segment of `path` they follow. */
  typeArgs: (TypeArgs & { at: number }) | null;
  fields: FieldInit[];
  span: Span;
}

export interface FieldInit {
  name: string;
  nameSpan: Span;
  /** `{ x }` is shorthand for `{ x: x }`. */
  value: Expr;
  span: Span;
}

export interface Match {
  kind: 'Match';
  keywordSpan: Span;
  subject: Expr;
  arms: Arm[];
  /** An arm was left out for a syntax error: what the match covers and gives isn't known. */
  dropped: boolean;
  span: Span;
}

export interface Arm {
  /** `"rw" | "read-write" => ...`: the arm runs when any of them matches. Usually one. */
  patterns: Pattern[];
  /** From the first pattern to the last. */
  patternSpan: Span;
  /** `=> expr` is parsed as a one-statement block, so arms check and lower like `if` branches. */
  body: Block;
  span: Span;
}

/**
 * On a `T?` value, `none` matches absence and every other pattern except `_` matches a present
 * value: `match email { none => ..., e => e }` binds `e` as the `T`.
 */
export type Pattern = WildcardPattern | BindingPattern | LiteralPattern | CtorPattern | NonePattern | ResultPattern | TuplePattern;

/** `(a, _)`: a tuple, part by part. */
export interface TuplePattern {
  kind: 'Tuple';
  items: Pattern[];
  span: Span;
}

export interface NonePattern {
  kind: 'None';
  span: Span;
}

/** `Ok(p)` / `Err(p)`, and `Ok()` for a Result<void, E>. */
export interface ResultPattern {
  kind: 'Result';
  variant: 'Ok' | 'Err';
  /** A `_` for `Ok()`. */
  inner: Pattern;
  bare: boolean;
  span: Span;
}

export interface WildcardPattern {
  kind: 'Wildcard';
  span: Span;
}

export interface BindingPattern {
  kind: 'Binding';
  name: string;
  span: Span;
}

export interface LiteralPattern {
  kind: 'Literal';
  value: StringLit | IntLit | BoolLit | CharLit;
  /** `-5`: only ints. */
  negative: boolean;
  span: Span;
}

/**
 * `Point { x: 0, y }` or `Status.Paid { at }` or `Status.Pending`. Fields left out match anything.
 * `.Paid { at }` (`short`) names a variant of the matched enum; `path` is then the variant alone.
 */
export interface CtorPattern {
  kind: 'Ctor';
  path: string[];
  short: boolean;
  pathSpan: Span;
  fields: FieldPattern[];
  span: Span;
}

export interface FieldPattern {
  name: string;
  nameSpan: Span;
  /** `{ at }` is shorthand for `{ at: at }`, a binding. */
  pattern: Pattern;
  span: Span;
}

/** `if` is an expression: as a value, each branch yields its block's last expression. */
export interface If {
  kind: 'If';
  keywordSpan: Span;
  cond: Expr;
  then: Block;
  /** An `else if` chain is a nested `If`. */
  else: Block | If | null;
  span: Span;
}

export type UnaryOp = '-' | '!';

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  /** `x ?? d`: the value in `x`, or `d` (evaluated only then). */
  | '??';

export interface Unary {
  kind: 'Unary';
  op: UnaryOp;
  opSpan: Span;
  operand: Expr;
  span: Span;
}

/** `0..n`: the ints from `start` up to `end - 1`. A `List<int>`, except as a `for` loop's iterable, which counts. */
export interface Range {
  kind: 'Range';
  start: Expr;
  end: Expr;
  opSpan: Span;
  span: Span;
}

export interface Binary {
  kind: 'Binary';
  op: BinaryOp;
  opSpan: Span;
  left: Expr;
  right: Expr;
  span: Span;
}

export interface StringLit {
  kind: 'String';
  value: string;
  span: Span;
}

/** `"hello ${name}"`. Text and expressions alternate, starting and ending with text (maybe `""`). */
export interface Interp {
  kind: 'Interp';
  parts: (string | Expr)[];
  span: Span;
}

/** `'a'`: one code point, decoded. */
export interface CharLit {
  kind: 'Char';
  value: string;
  span: Span;
}

export interface IntLit {
  kind: 'Int';
  /** Kept as written; the checker range-checks it as a 64-bit int. */
  value: string;
  span: Span;
}

/** `1.5`, `2.0e-3`: a 64-bit float, as written (separators dropped). */
export interface FloatLit {
  kind: 'Float';
  value: string;
  span: Span;
}

export interface BoolLit {
  kind: 'Bool';
  value: boolean;
  span: Span;
}

export interface Ident {
  kind: 'Ident';
  name: string;
  /** `first<int>` in `first<int>(xs)`, `Tree<int>` in `Tree<int>.Leaf`. */
  typeArgs?: TypeArgs;
  span: Span;
}

export interface Member {
  kind: 'Member';
  object: Expr;
  name: string;
  nameSpan: Span;
  typeArgs?: TypeArgs;
  span: Span;
}

/** `<int, string>` after a name in an expression. */
export interface TypeArgs {
  types: TypeExpr[];
  span: Span;
}

export interface Call {
  kind: 'Call';
  callee: Expr;
  args: Expr[];
  span: Span;
}
