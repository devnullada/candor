import type { Type } from './types';

/**
 * Exhaustiveness and reachability of `match` arms, by Maranget's usefulness algorithm
 * ("Warnings for pattern matching", 2007). Patterns are reduced to constructors and wildcards;
 * bindings are wildcards here.
 */

export type Ctor =
  /** An enum variant. Also `T?` (0 `none`, 1 present) and Result (0 `Ok`, 1 `Err`). */
  | { kind: 'variant'; index: number }
  | { kind: 'struct' }
  | { kind: 'tuple' }
  | { kind: 'bool'; value: boolean }
  /** An int or string literal, normalised so equal literals have equal keys. */
  | { kind: 'literal'; value: string };

export type Pat = { kind: 'wild' } | { kind: 'ctor'; ctor: Ctor; args: Pat[] };

export const wild: Pat = { kind: 'wild' };

/**
 * A value that `q` matches and no row of `rows` does, as one pattern per column, or null if
 * there is none. `useful(arms, [wild])` finds a value no arm covers; `useful(arms above, [arm])`
 * is null when the arm can never match.
 */
export function useful(rows: Pat[][], q: Pat[], types: Type[]): Pat[] | null {
  if (q.length === 0) return rows.length === 0 ? [] : null;
  const [head, ...restQ] = q;
  const t = types[0];
  const restTypes = types.slice(1);

  const through = (c: Ctor): Pat[] | null => {
    const argTypes = ctorArgTypes(t, c);
    const n = argTypes.length;
    const sub = rows.map((r) => specialize(r, c, n)).filter((r): r is Pat[] => r !== null);
    const w = useful(sub, specialize(q, c, n)!, [...argTypes, ...restTypes]);
    return w && [{ kind: 'ctor', ctor: c, args: w.slice(0, n) }, ...w.slice(n)];
  };

  if (head.kind === 'ctor') return through(head.ctor);

  const seen = rows.flatMap((r) => (r[0].kind === 'ctor' ? [r[0].ctor] : []));
  const all = allCtors(t);
  const missing = all?.filter((c) => !seen.some((s) => sameCtor(s, c))) ?? null;
  if (all && missing!.length === 0) {
    // Every constructor appears: the wildcard is useful only through one of them.
    for (const c of all) {
      const w = through(c);
      if (w) return w;
    }
    return null;
  }
  // Some constructor is missing (or there are infinitely many): only wildcard rows matter.
  const defaults = rows.filter((r) => r[0].kind === 'wild').map((r) => r.slice(1));
  const w = useful(defaults, restQ, restTypes);
  if (!w) return null;
  const c = missing?.[0];
  const witness: Pat = c ? { kind: 'ctor', ctor: c, args: ctorArgTypes(t, c).map(() => wild) } : wild;
  return [witness, ...w];
}

/** A witness as Candor pattern syntax, for diagnostics: `Status.Paid`, `Point { x: true }`, `_`. */
export function formatWitness(p: Pat, t: Type): string {
  if (p.kind === 'wild') return '_';
  const c = p.ctor;
  if (c.kind === 'bool') return String(c.value);
  if (c.kind === 'literal') return c.value;
  if (c.kind === 'variant' && t.kind === 'option') {
    // A present value is written as its own pattern; `x` stands for "any present value".
    return c.index === 0 ? 'none' : p.args[0].kind === 'wild' ? 'x' : formatWitness(p.args[0], t.inner);
  }
  if (c.kind === 'variant' && t.kind === 'result') {
    if (c.index === 0 && t.ok.kind === 'unit') return 'Ok()';
    return c.index === 0 ? `Ok(${formatWitness(p.args[0], t.ok)})` : `Err(${formatWitness(p.args[0], t.err)})`;
  }
  if (c.kind === 'tuple' && t.kind === 'tuple') return `(${p.args.map((a, i) => formatWitness(a, t.elems[i])).join(', ')})`;
  let name: string;
  let fields: { name: string; type: Type }[];
  if (c.kind === 'variant' && t.kind === 'enum') {
    name = `${t.name}.${t.variants[c.index].name}`;
    fields = t.variants[c.index].fields;
  } else if (t.kind === 'struct') {
    name = t.name;
    fields = t.fields;
  } else {
    return '_';
  }
  const shown = p.args.flatMap((a, i) => (a.kind === 'wild' ? [] : [`${fields[i].name}: ${formatWitness(a, fields[i].type)}`]));
  return shown.length > 0 ? `${name} { ${shown.join(', ')} }` : name;
}

function specialize(row: Pat[], c: Ctor, arity: number): Pat[] | null {
  const [head, ...rest] = row;
  if (head.kind === 'wild') return [...Array<Pat>(arity).fill(wild), ...rest];
  return sameCtor(head.ctor, c) ? [...head.args, ...rest] : null;
}

function sameCtor(a: Ctor, b: Ctor): boolean {
  switch (a.kind) {
    case 'variant':
      return b.kind === 'variant' && a.index === b.index;
    case 'struct':
    case 'tuple':
      return b.kind === a.kind;
    case 'bool':
      return b.kind === 'bool' && a.value === b.value;
    case 'literal':
      return b.kind === 'literal' && a.value === b.value;
  }
}

/** Every constructor of `t`, or null when there are infinitely many (int, string). */
function allCtors(t: Type): Ctor[] | null {
  switch (t.kind) {
    case 'enum':
      return t.variants.map((v) => ({ kind: 'variant', index: v.index }));
    case 'option':
    case 'result':
      return [
        { kind: 'variant', index: 0 },
        { kind: 'variant', index: 1 },
      ];
    case 'struct':
      return [{ kind: 'struct' }];
    case 'tuple':
      return [{ kind: 'tuple' }];
    case 'bool':
      return [
        { kind: 'bool', value: true },
        { kind: 'bool', value: false },
      ];
    default:
      return null;
  }
}

function ctorArgTypes(t: Type, c: Ctor): Type[] {
  if (c.kind === 'variant' && t.kind === 'enum') return t.variants[c.index].fields.map((f) => f.type);
  if (c.kind === 'variant' && t.kind === 'option') return c.index === 0 ? [] : [t.inner];
  if (c.kind === 'variant' && t.kind === 'result') return [c.index === 0 ? t.ok : t.err];
  if (c.kind === 'struct' && t.kind === 'struct') return t.fields.map((f) => f.type);
  if (c.kind === 'tuple' && t.kind === 'tuple') return t.elems;
  return [];
}
