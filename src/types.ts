export type Type =
  | { kind: 'string' }
  | { kind: 'int' }
  | { kind: 'bool' }
  /** One code point, `'a'`: what `s.chars()` gives. A `rune` in Go. */
  | { kind: 'char' }
  /** 64-bit, `1.5`. Never NaN or infinite: an operation that would make one panics. */
  | { kind: 'float' }
  /** `Bytes`: bytes, never changed once made, like a string. A byte is an `int` 0 to 255. A `[]byte` in Go. */
  | { kind: 'bytes' }
  /** `void`: what a function without `->` returns. Its one value is the one in `Ok()`; `struct{}` in Go. */
  | { kind: 'unit' }
  /** An expression that already produced an error. Compatible with everything, so one mistake is reported once. */
  | { kind: 'error' }
  | FnType
  | EffectType
  | StructType
  | EnumType
  | OptionType
  | ResultType
  | ListType
  | MapType
  | TupleType
  | ScopeType
  | TaskType
  | HandleType
  | ParamType
  | OpaqueType
  /** An error from Go, as a binding's `Result<T, GoError>` gives it. Opaque: `.message()`, `.is(e)`. */
  | { kind: 'goerror' }
  /** The type of `none` before context says what is missing. */
  | { kind: 'none' };

/** `List<T>`: an immutable value, unless held in a `let mut`. A Go slice. */
export interface ListType {
  kind: 'list';
  elem: Type;
}

/**
 * `Map<K, V>`: a value like a list, iterated in insertion order. Keys are any `Eq` type. A
 * `candor.Map` in Go.
 */
export interface MapType {
  kind: 'map';
  key: Type;
  value: Type;
}

/** `(int, string)`: a value of two or more parts, taken apart by patterns. An anonymous struct in Go. */
export interface TupleType {
  kind: 'tuple';
  elems: Type[];
}

/**
 * `s` in `tasks.scope((s) => ...)`. Each scope gets its own `id`, so a task spawned on it can
 * be checked against what that scope returns; a `Scope` written as a type has id 0.
 */
export interface ScopeType {
  kind: 'scope';
  id: number;
}

/** `Task<T>`: what `s.spawn(f)` returns; `join()` gives the T. */
export interface TaskType {
  kind: 'task';
  result: Type;
}

/**
 * `Mutex<T>`, `Atomic<T>`, `Channel<T>`: what tasks share, made by a scope (`s.mutex(v)`) and
 * gone with it. Handles: copies are the same one, and there is no `==`. `Atomic` holds an int or
 * a bool. `Arm<R>` is one choice for `tasks.select` (`ch.onRecv(f)`, `tasks.after(ms, f)`),
 * giving an `R` when picked; it holds its channel, so it is a handle too. `Lock` (`s.lock()`)
 * holds nothing and takes no type: its `arg` is `void`.
 */
export interface HandleType {
  kind: 'handle';
  handle: 'Mutex' | 'Atomic' | 'Channel' | 'Arm' | 'Lock';
  arg: Type;
}

export const handleNames = ['Mutex', 'Atomic', 'Channel', 'Arm', 'Lock'] as const;

/**
 * `type *DB as Db` in an effect's `extern` block: a Go value Candor holds but can't look into.
 * Only the effect's own code can name it, so it never leaves the effect.
 */
export interface OpaqueType {
  kind: 'opaque';
  /** The Candor name, `Db`. */
  name: string;
  module: string;
  /** How Go names it in its package, `DB`, and whether the binding holds a pointer to it. */
  goName: string;
  pointer: boolean;
  /** The Go package's import path, as the binding writes it. */
  goPath: string;
}

/**
 * `T` in `struct Page<T>` or `fn first<T: Ord>`: inside the declaration, a type it knows only
 * the bounds of. Its values can be stored and passed on, and do what the bounds say. Each use
 * of the declaration picks what it stands for.
 */
export interface ParamType {
  kind: 'param';
  name: string;
  /** Tells apart the `T`s of different declarations. */
  id: number;
  /** `T: Eq + Show`. Filled in once every trait is known. */
  bounds: Trait[];
}

let paramIds = 0;

export function param(name: string): ParamType {
  return { kind: 'param', name, id: ++paramIds, bounds: [] };
}

/**
 * What a type parameter can be bound by. `Eq` and `Ord` are built in: `Eq` is what `==` already
 * works on, and `Ord` is int, string, and types with `impl Ord`. Others are declared with
 * `trait`, and a type has one only through an `impl`.
 */
export interface Trait {
  name: string;
  /** The declaring module; null for the built-in ones. */
  module: string | null;
  /** `pub trait`: other modules can name it. The built-in ones are. */
  pub: boolean;
  /** `Self` in the methods' signatures. */
  self: ParamType;
  /** Each method's signature, `self` first. */
  methods: Map<string, FnType>;
  /** The methods with a default body, which an impl may leave out. */
  defaults: Set<string>;
}

function builtinTrait(name: string, methods: (self: ParamType) => [string, FnType][]): Trait {
  const self = param('Self');
  const trait: Trait = { name, module: null, pub: true, self, methods: new Map(methods(self)), defaults: new Set() };
  self.bounds = [trait];
  return trait;
}

export const Eq = builtinTrait('Eq', () => []);
/** `a.compare(b)`: negative, zero or positive, as `a` sorts before, with or after `b`. */
export const Ord = builtinTrait('Ord', (self) => [['compare', fn([self, self], { kind: 'int' })]]);
/** `x.toString()`: how a value reads in a string. `"${x}"` calls it. */
export const Show = builtinTrait('Show', (self) => [['toString', fn([self], { kind: 'string' })]]);
/** `impl Json for T`, derived: what `json.encode` and `json.decode` need. No methods to call. */
export const Json = builtinTrait('Json', () => []);
/** `impl Row for T`, derived: what `sql.query<T>` reads a row into. No methods to call. */
export const Row = builtinTrait('Row', () => []);
export const builtinTraits = new Map([
  ['Eq', Eq],
  ['Ord', Ord],
  ['Show', Show],
  ['Json', Json],
  ['Row', Row],
]);

/** `sql.Query`: made only from a string literal, and not compared. */
export function isSqlQuery(t: Type): boolean {
  return t.kind === 'struct' && t.module === 'sql' && t.name === 'Query';
}

/** `Show`, `geo.Show`: how a trait is written from module `home`. */
export function traitName(t: Trait, home?: string): string {
  return t.module === null || t.module === home ? t.name : `${t.module}.${t.name}`;
}

/** Ord without an impl: the types `<` already orders. */
export function ordered(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'string' || t.kind === 'char' || t.kind === 'float';
}

/** Show without an impl: the types that read as themselves. */
export function shown(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'string' || t.kind === 'bool' || t.kind === 'char' || t.kind === 'float';
}

/** `T?`: a T, or `none`. */
export interface OptionType {
  kind: 'option';
  inner: Type;
}

/** `Result<T, E>`: `Ok(T)` or `Err(E)`. */
export interface ResultType {
  kind: 'result';
  ok: Type;
  err: Type;
}

/**
 * Structs and enums are nominal: two types are the same only if they are the same declaration
 * with the same type arguments. Each `Page<int>` is one object (see `instantiate`), so `===`
 * still decides.
 */
export type UserType = StructType | EnumType;

interface Declared {
  name: string;
  /** The module declaring it; Go names are prefixed with it. */
  module: string;
  /** `pub struct`, `pub enum`: other modules can name it. */
  pub: boolean;
  /** `struct Page<T>`: its type parameters. */
  params: ParamType[];
  /** What they stand for here: the parameters themselves in the declaration, `[int]` in `Page<int>`. */
  args: Type[];
}

export interface StructType extends Declared {
  kind: 'struct';
  origin: StructType;
  /**
   * Filled in after every type name is known, so types can refer to each other in any order.
   * On an instance, worked out from the declaration's on every read.
   */
  fields: Field[];
  /** The `//` lines above its declaration: `flags.parse`'s usage header. */
  doc?: string;
}

export interface EnumType extends Declared {
  kind: 'enum';
  origin: EnumType;
  variants: Variant[];
}

/** A struct or enum declaration, before its fields are known. */
export function declareUserType(kind: UserType['kind'], name: string, module: string, pub: boolean, typeParams: ParamType[]): UserType {
  const t = (kind === 'struct' ? { kind, name, module, pub, params: typeParams, args: typeParams, fields: [] } : { kind, name, module, pub, params: typeParams, args: typeParams, variants: [] }) as unknown as UserType;
  t.origin = t as never;
  instances.set(t, new Map());
  return t;
}

const instances = new WeakMap<UserType, Map<string, UserType>>();

/** `Page<int>`: the declaration with its type parameters replaced, one object per distinct arguments. */
export function instantiate<U extends UserType>(origin: U, args: Type[]): U {
  if (args.length === origin.params.length && args.every((a, i) => a === origin.params[i])) return origin;
  const cache = instances.get(origin)!;
  const key = args.map(typeKey).join(', ');
  const cached = cache.get(key);
  if (cached) return cached as U;
  const map = new Map(origin.params.map((p, i) => [p, args[i]]));
  const into = (fs: Field[]) => fs.map((f) => ({ ...f, type: subst(f.type, (p) => map.get(p) ?? p) }));
  const inst = { kind: origin.kind, name: origin.name, module: origin.module, pub: origin.pub, params: origin.params, args, origin } as U;
  // Read each time: the declaration's fields may not be filled in yet, and boxing is decided later.
  if (origin.kind === 'struct') Object.defineProperty(inst, 'fields', { get: () => into(origin.fields), enumerable: true });
  else Object.defineProperty(inst, 'variants', { get: () => origin.variants.map((v) => ({ ...v, fields: into(v.fields) })), enumerable: true });
  cache.set(key, inst);
  return inst;
}

/** `t` with each type parameter replaced by what `to` says it stands for. */
export function subst(t: Type, to: (p: ParamType) => Type): Type {
  const go = (u: Type) => subst(u, to);
  switch (t.kind) {
    case 'param':
      return to(t);
    case 'list':
      return { kind: 'list', elem: go(t.elem) };
    case 'map':
      return { kind: 'map', key: go(t.key), value: go(t.value) };
    case 'tuple':
      return { kind: 'tuple', elems: t.elems.map(go) };
    case 'option':
      return { kind: 'option', inner: go(t.inner) };
    case 'result':
      return { kind: 'result', ok: go(t.ok), err: go(t.err) };
    case 'task':
      return { kind: 'task', result: go(t.result) };
    case 'handle':
      return { kind: 'handle', handle: t.handle, arg: go(t.arg) };
    case 'fn':
      return fn(t.params.map(go), go(t.ret), t.uses);
    case 'struct':
    case 'enum':
      return t.args.length === 0 ? t : instantiate(t.origin, t.args.map(go));
    default:
      return t;
  }
}

/** The type parameters `t` mentions. */
export function paramsIn(t: Type, out = new Set<ParamType>()): Set<ParamType> {
  switch (t.kind) {
    case 'param':
      out.add(t);
      break;
    case 'list':
      paramsIn(t.elem, out);
      break;
    case 'map':
      paramsIn(t.key, out);
      paramsIn(t.value, out);
      break;
    case 'tuple':
      for (const x of t.elems) paramsIn(x, out);
      break;
    case 'option':
      paramsIn(t.inner, out);
      break;
    case 'result':
      paramsIn(t.ok, out);
      paramsIn(t.err, out);
      break;
    case 'task':
      paramsIn(t.result, out);
      break;
    case 'handle':
      paramsIn(t.arg, out);
      break;
    case 'fn':
      for (const p of t.params) paramsIn(p, out);
      paramsIn(t.ret, out);
      break;
    case 'struct':
    case 'enum':
      for (const a of t.args) paramsIn(a, out);
      break;
  }
  return out;
}

/** Whether `t` has an `error` in it: a part nothing has said yet. */
export function hasError(t: Type): boolean {
  switch (t.kind) {
    case 'error':
      return true;
    case 'list':
      return hasError(t.elem);
    case 'map':
      return hasError(t.key) || hasError(t.value);
    case 'tuple':
      return t.elems.some(hasError);
    case 'option':
      return hasError(t.inner);
    case 'result':
      return hasError(t.ok) || hasError(t.err);
    case 'task':
      return hasError(t.result);
    case 'handle':
      return hasError(t.arg);
    case 'fn':
      return t.params.some(hasError) || hasError(t.ret);
    case 'struct':
    case 'enum':
      return t.args.some(hasError);
    default:
      return false;
  }
}

/**
 * Learns what `params` stand for by matching `declared`, a type written with them, against
 * `found`, the type of a value given for it. What is already known stays.
 */
export function unify(declared: Type, found: Type, params: ParamType[], known: Map<ParamType, Type>) {
  if (found.kind === 'error' || found.kind === 'none') return;
  const go = (d: Type, f: Type) => unify(d, f, params, known);
  switch (declared.kind) {
    case 'param':
      if (params.includes(declared) && !known.has(declared)) known.set(declared, found);
      return;
    case 'option':
      // A `T` goes where a `T?` is expected.
      go(declared.inner, found.kind === 'option' ? found.inner : found);
      return;
    case 'list':
      if (found.kind === 'list') go(declared.elem, found.elem);
      return;
    case 'map':
      if (found.kind === 'map') {
        go(declared.key, found.key);
        go(declared.value, found.value);
      }
      return;
    case 'tuple':
      if (found.kind === 'tuple' && found.elems.length === declared.elems.length) declared.elems.forEach((x, i) => go(x, found.elems[i]));
      return;
    case 'task':
      if (found.kind === 'task') go(declared.result, found.result);
      return;
    case 'handle':
      if (found.kind === 'handle' && found.handle === declared.handle) go(declared.arg, found.arg);
      return;
    case 'result':
      if (found.kind === 'result') {
        go(declared.ok, found.ok);
        go(declared.err, found.err);
      }
      return;
    case 'fn':
      if (found.kind === 'fn' && found.params.length === declared.params.length) {
        declared.params.forEach((p, i) => go(p, found.params[i]));
        go(declared.ret, found.ret);
      }
      return;
    case 'struct':
    case 'enum':
      if ((found.kind === 'struct' || found.kind === 'enum') && found.origin === declared.origin) declared.args.forEach((a, i) => go(a, found.args[i]));
      return;
  }
}

export interface Variant {
  name: string;
  /** The tag in Go. */
  index: number;
  fields: Field[];
  /** `InProgress as "in-progress"`: its name in JSON. */
  wire?: string;
}

export interface Field {
  name: string;
  type: Type;
  /** Other modules can read it: a struct's `pub` field, or any field of a `pub enum`'s variant. */
  pub: boolean;
  /** A field that leads back to its own type through an enum, `T?` or Result: a pointer in Go. */
  boxed: boolean;
  /** `kind_: string as "type"`: its name in JSON, and its flag in `flags.parse`. */
  wire?: string;
  /** The `//` lines above it: its help in `flags.parse`'s usage. */
  doc?: string;
}

/** The naming rules of `impl Json(snake) for T`, each turning a Candor name into its JSON one. */
export const jsonRules: Record<string, (words: string[]) => string> = {
  snake: (ws) => ws.map((w) => w.toLowerCase()).join('_'),
  kebab: (ws) => ws.map((w) => w.toLowerCase()).join('-'),
  camel: (ws) => ws.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(''),
  pascal: (ws) => ws.map((w) => w[0].toUpperCase() + w.slice(1)).join(''),
};

/**
 * A field's or variant's name in JSON: its `as` name, else `rule` applied to its words.
 * Words break at `_` and at a capital: `createdAt`, `created_at` and `userID` are
 * created/at, created/at and user/ID.
 */
export function jsonName(item: { name: string; wire?: string }, rule: string | null): string {
  if (item.wire !== undefined) return item.wire;
  const apply = rule ? jsonRules[rule] : undefined;
  if (!apply) return item.name;
  const words = item.name.split('_').flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z0-9]|$)|[A-Z]?[a-z0-9]+|[A-Z]+/g) ?? []);
  return words.length === 0 ? item.name : apply(words);
}

/** What `flags.parse` reads a field as: a kind, as one value, `T?` or `List<T>`. */
export interface FlagField {
  kind: 'string' | 'int' | 'float' | 'bool' | 'duration';
  shape: 'one' | 'option' | 'list';
}

export function flagField(t: Type): FlagField | null {
  const scalar = (x: Type): FlagField['kind'] | null =>
    x.kind === 'string' || x.kind === 'int' || x.kind === 'float' || x.kind === 'bool' ? x.kind : isDuration(x) ? 'duration' : null;
  if (t.kind === 'option') {
    const kind = scalar(t.inner);
    return kind ? { kind, shape: 'option' } : null;
  }
  if (t.kind === 'list') {
    const kind = scalar(t.elem);
    // A bool flag takes no value, so a list of them would only count its uses.
    return kind && kind !== 'bool' ? { kind, shape: 'list' } : null;
  }
  const kind = scalar(t);
  return kind ? { kind, shape: 'one' } : null;
}

/** std's `time.Duration`. */
export function isDuration(t: Type): t is StructType {
  return t.kind === 'struct' && t.origin.module === 'time' && t.origin.name === 'Duration';
}

/** A field's flag in `flags.parse`: its `as` name, else its name in kebab case. */
export function flagName(f: Field): string {
  return jsonName(f, 'kebab');
}

export interface FnType {
  kind: 'fn';
  params: Type[];
  ret: Type;
  /** Effects calling it performs, sorted. A function with fewer fits where more are allowed. */
  uses: string[];
}

export interface EffectType {
  kind: 'effect';
  name: string;
  methods: Map<string, FnType>;
}

export const T: { string: Type; int: Type; float: Type; bool: Type; char: Type; bytes: Type; unit: Type; error: Type; goerror: Type } = {
  goerror: { kind: 'goerror' },
  string: { kind: 'string' },
  int: { kind: 'int' },
  bool: { kind: 'bool' },
  char: { kind: 'char' },
  bytes: { kind: 'bytes' },
  float: { kind: 'float' },
  unit: { kind: 'unit' },
  error: { kind: 'error' },
};

/**
 * `Exit { status, message }`: built in, no import. `main` returning
 * `Result<void, Exit>` ends with that status; a module's own `Exit` type hides it.
 */
export const exitType = declareUserType('struct', 'Exit', 'candor', true, []) as StructType;
exitType.fields = [
  { name: 'status', type: T.int, pub: true, boxed: false },
  { name: 'message', type: T.string, pub: true, boxed: false },
];

/**
 * `enum Signal { Interrupt, Terminate, Hangup, User1, User2 }`: built in like `Exit`,
 * what `env.signals(s, [...])` delivers. The runtime knows them by tag, in this order.
 */
export const signalType = declareUserType('enum', 'Signal', 'candor', true, []) as EnumType;
signalType.variants = ['Interrupt', 'Terminate', 'Hangup', 'User1', 'User2'].map((name, index) => ({ name, index, fields: [] }));

/** Types every module has without an import, unless it declares its own of that name. */
export const builtinTypes: UserType[] = [exitType, signalType];

export function fn(params: Type[], ret: Type, uses: string[] = []): FnType {
  return { kind: 'fn', params, ret, uses: [...new Set(uses)].sort() };
}

export function effect(name: string, methods: [string, FnType][]): EffectType {
  return { kind: 'effect', name, methods: new Map(methods) };
}

export function sameType(a: Type, b: Type): boolean {
  if (a.kind === 'error' || b.kind === 'error') return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'effect':
      return a.name === (b as EffectType).name;
    case 'fn': {
      const bf = b as FnType;
      return sameShape(a, bf) && a.uses.join() === bf.uses.join();
    }
    case 'list':
      return sameType(a.elem, (b as ListType).elem);
    case 'map':
      return sameType(a.key, (b as MapType).key) && sameType(a.value, (b as MapType).value);
    case 'tuple': {
      const bt = b as TupleType;
      return a.elems.length === bt.elems.length && a.elems.every((x, i) => sameType(x, bt.elems[i]));
    }
    case 'task':
      return sameType(a.result, (b as TaskType).result);
    case 'handle':
      return a.handle === (b as HandleType).handle && sameType(a.arg, (b as HandleType).arg);
    case 'struct':
    case 'enum':
    case 'param':
    case 'opaque':
      return a === b;
    case 'option':
      return sameType(a.inner, (b as OptionType).inner);
    case 'result':
      return sameType(a.ok, (b as ResultType).ok) && sameType(a.err, (b as ResultType).err);
    default:
      return true;
  }
}

/** Same parameters and result; effects aside. */
export function sameShape(a: FnType, b: FnType): boolean {
  return a.params.length === b.params.length && a.params.every((p, i) => sameType(p, b.params[i])) && sameType(a.ret, b.ret);
}

/**
 * How Candor writes `t`. Types declared outside `home` carry their module, `geo.Point`, as
 * they are written there; with no `home`, every one does.
 */
export function typeToString(t: Type, home?: string): string {
  return render(t, home, false);
}

/** A string that tells types apart, type parameters of different declarations too. */
export function typeKey(t: Type): string {
  return render(t, undefined, true);
}

function render(t: Type, home: string | undefined, ids: boolean): string {
  const show = (u: Type) => render(u, home, ids);
  switch (t.kind) {
    case 'unit':
      return 'void';
    case 'error':
      return '<error>';
    case 'goerror':
      return 'GoError';
    case 'effect':
      return `effect ${t.name}`;
    case 'fn': {
      const ret = t.ret.kind === 'unit' ? '' : ` -> ${show(t.ret)}`;
      const uses = t.uses.length > 0 ? ` uses ${t.uses.join(', ')}` : '';
      return `fn(${t.params.map(show).join(', ')})${ret}${uses}`;
    }
    case 'list':
      return `List<${show(t.elem)}>`;
    case 'map':
      return `Map<${show(t.key)}, ${show(t.value)}>`;
    case 'tuple':
      return `(${t.elems.map(show).join(', ')})`;
    case 'scope':
      return 'Scope';
    case 'task':
      return `Task<${show(t.result)}>`;
    case 'handle':
      return t.handle === 'Lock' ? 'Lock' : `${t.handle}<${show(t.arg)}>`;
    case 'struct':
    case 'enum': {
      const args = t.args.length > 0 ? `<${t.args.map(show).join(', ')}>` : '';
      return `${t.module === home || builtinTypes.includes(t.origin) ? t.name : `${t.module}.${t.name}`}${args}`;
    }
    case 'param':
      return ids ? `${t.name}#${t.id}` : t.name;
    case 'opaque':
      return t.module === home ? t.name : `${t.module}.${t.name}`;
    case 'option':
      return `${show(t.inner)}?`;
    case 'result':
      return `Result<${show(t.ok)}, ${show(t.err)}>`;
    case 'bytes':
      return 'Bytes';
    default:
      return t.kind;
  }
}

const namedTypes = new Map<string, Type>([
  ['string', T.string],
  ['int', T.int],
  ['bool', T.bool],
  ['char', T.char],
  ['float', T.float],
  ['Bytes', T.bytes],
  ['GoError', T.goerror],
  ['void', T.unit],
]);

export function resolveTypeName(name: string): Type | null {
  return namedTypes.get(name) ?? null;
}

export function typeNames(): string[] {
  return [...namedTypes.keys(), 'Result', 'List', 'Map', 'Scope', 'Task', ...handleNames];
}

/**
 * Where a value of type `from` may go where `to` is expected: the same type, `T`/`none` into
 * `T?`, or a function into a function type that allows at least its effects.
 */
export function assignable(from: Type, to: Type): boolean {
  if (from.kind === 'none') return to.kind === 'option' || to.kind === 'error';
  if (sameType(from, to)) return true;
  if (from.kind === 'fn' && to.kind === 'fn') return sameShape(from, to) && from.uses.every((u) => to.uses.includes(u));
  return to.kind === 'option' && sameType(from, to.inner);
}

/**
 * Whether `==` works on values of `t`, which makes it `Eq`: everything but functions, effects,
 * tasks and the other handles, Go errors (`.is` compares those) and Go's own types, and type parameters without the bound `Eq`.
 * `void` has one value, equal to itself.
 */
export function comparable(t: Type, seen = new Set<Type>()): boolean {
  if (seen.has(t)) return true;
  seen.add(t);
  switch (t.kind) {
    case 'fn':
    case 'effect':
    case 'scope':
    case 'task':
    case 'handle':
    case 'goerror':
    case 'opaque':
      return false;
    case 'param':
      return t.bounds.includes(Eq);
    case 'list':
      return comparable(t.elem, seen);
    case 'map':
      return comparable(t.value, seen);
    case 'tuple':
      return t.elems.every((x) => comparable(x, seen));
    case 'option':
      return comparable(t.inner, seen);
    case 'result':
      return comparable(t.ok, seen) && comparable(t.err, seen);
    case 'struct':
      return !isSqlQuery(t) && t.fields.every((f) => comparable(f.type, seen));
    case 'enum':
      return t.variants.every((v) => v.fields.every((f) => comparable(f.type, seen)));
    default:
      return true;
  }
}

/** The types a value of type `t` holds directly, with whether each is stored behind a pointer. */
export function children(t: Type): { type: Type; boxed: boolean }[] {
  switch (t.kind) {
    case 'struct':
      return t.fields;
    case 'enum':
      return t.variants.flatMap((v) => v.fields);
    case 'option':
      return [{ type: t.inner, boxed: false }];
    case 'tuple':
      return t.elems.map((type) => ({ type, boxed: false }));
    case 'result':
      return [
        { type: t.ok, boxed: false },
        { type: t.err, boxed: false },
      ];
    default:
      return [];
  }
}

/** Types where recursion can stop: a variant, `none` or the other branch of a Result ends it. */
export function isSum(t: Type): boolean {
  return t.kind === 'enum' || t.kind === 'option' || t.kind === 'result';
}
