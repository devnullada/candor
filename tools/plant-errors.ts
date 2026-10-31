// Card 092: plants syntax errors, one site at a time, in the examples and trial apps, and counts
// what the compiler still reports: the error itself, a type error seeded in the same function and
// in another declaration, both of two broken items, and anything that only follows from it.
// Run: bun tools/plant-errors.ts [--list]   (--list names each miss and each false diagnostic)
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import path from 'node:path';
import { compile } from '../src/compile';

const ROOT = path.resolve(import.meta.dir, '..').replaceAll('\\', '/') + '/';
const files = [
  ...new Glob('examples/*.candor').scanSync(ROOT),
  ...new Glob('trials/apps/*/reference/*.candor').scanSync(ROOT),
].map((f) => ROOT + f.replaceAll('\\', '/'));

type Kind = 'field' | 'variant' | 'arm' | 'impl-stmt' | 'stmt' | 'extern' | 'if' | 'unclosed';
const TYPE_ERR = 'let zzq: int = "zz"';

const opener = (l: string) => /^\s*(pub )?fn .*\{\s*$/.test(l) || /^\s*test ".*\{\s*$/.test(l);
const indent = (l: string) => l.length - l.trimStart().length;

function sites(lines: string[]): { kind: Kind; at: number; mutate: (l: string) => string }[] {
  const out: { kind: Kind; at: number; mutate: (l: string) => string }[] = [];
  let ctx: string | null = null; // the column-1 declaration we are in
  let inExtern = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (indent(l) === 0 && l.trim()) {
      ctx = l.split(/\s/)[l.startsWith('pub ') ? 1 : 0];
      inExtern = ctx === 'extern';
    }
    if (indent(l) === 0) continue;
    const t = l.trim();
    if (ctx === 'struct' && /^(pub )?\w+: \S/.test(t) && !t.includes('=')) out.push({ kind: 'field', at: i, mutate: (s) => s.replace(': ', ' ') });
    else if (ctx === 'enum' && /^[A-Z]\w*( \{.*\})?,?$/.test(t)) out.push({ kind: 'variant', at: i, mutate: (s) => s.replace(/([A-Z]\w*)/, '$1(int)') });
    else if (inExtern && /^(fn|type) /.test(t)) out.push({ kind: 'extern', at: i, mutate: (s) => s.replace('(', '((') });
    else if (/^(\.|[A-Z]|"|\d|none|_|true|false).* => /.test(t) && !/^\(/.test(t)) out.push({ kind: 'arm', at: i, mutate: (s) => s.replace(' => ', ' = ') });
    else if (/^if .* \{$/.test(t) && ctx === 'fn') out.push({ kind: 'if', at: i, mutate: (s) => s.replace(/ \{$/, ') {') });
    else if (/^let (mut )?\w+ = \w[\w.]*\(.*\)$/.test(t) && ctx === 'fn' && i % 2 === 0) out.push({ kind: 'unclosed', at: i, mutate: (s) => s.replace(/\)$/, '') });
    else if (/^let (mut )?\w+ = /.test(t)) out.push({ kind: ctx === 'impl' || ctx === 'effect' || ctx === 'fake' ? 'impl-stmt' : 'stmt', at: i, mutate: (s) => s.replace(' = ', ' = = ') });
  }
  return out;
}

/** The body openers to seed a type error in: the one around `at`, and the next one after. */
function bodies(lines: string[], at: number): { same: number | null; other: number | null } {
  let same: number | null = null;
  for (let i = at; i >= 0; i--) if (opener(lines[i]) && indent(lines[i]) < indent(lines[at])) { same = i; break; }
  let other: number | null = null;
  // Another declaration's body: the first opener in column 1 after the next column-1 line.
  let j = at + 1;
  while (j < lines.length && !(indent(lines[j]) === 0 && lines[j].trim() && lines[j].trim() !== '}')) j++;
  for (; j < lines.length; j++) if (opener(lines[j]) && j !== same) { other = j; break; }
  return { same: same === at ? null : same, other };
}

function seed(lines: string[], opens: number[]): string[] {
  const out = [...lines];
  for (const o of [...opens].sort((a, b) => b - a)) out.splice(o + 1, 0, ' '.repeat(indent(lines[o]) + 2) + TYPE_ERR);
  return out;
}

const tally = new Map<Kind, { n: number; reported: number; same: [number, number]; other: [number, number]; pair: [number, number]; false: number }>();
const list = process.argv.includes('--list');
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const baseAll = compile(src, file, 'test').diagnostics;
  const known = new Set(baseAll.map((d) => `${d.span.start.line} ${d.message}`));
  const base = baseAll.filter((d) => d.severity === 'error');
  if (base.length) {
    console.log(`skip ${file}: ${base.length} errors`);
    continue;
  }
  const all = sites(lines);
  for (const s of all) {
    const t = tally.get(s.kind) ?? { n: 0, reported: 0, same: [0, 0], other: [0, 0], pair: [0, 0], false: 0 };
    tally.set(s.kind, t);
    const { same, other } = bodies(lines, s.at);
    const mutated = [...lines];
    mutated[s.at] = s.mutate(lines[s.at]);
    const opens = [same, other].filter((x): x is number => x !== null);
    const shifted = seed(mutated, opens);
    const ds = compile(shifted.join('\n'), file, 'test').diagnostics.filter((d) => d.severity === 'error');
    const syntax = ds.filter((d) => d.code === 'CAN0001');
    const typeLines = ds.filter((d) => d.message === 'expected int, found string').map((d) => d.span.start.line - 1);
    const pos = (o: number) => o + 1 + opens.filter((x) => x < o).length; // 0-based line of the seed after `o`
    t.n++;
    if (syntax.length === 1) t.reported++;
    if (same !== null && ['arm', 'stmt', 'impl-stmt', 'if', 'unclosed'].includes(s.kind)) {
      t.same[1]++;
      if (typeLines.includes(pos(same))) t.same[0]++;
      else if (list) console.log(`  hidden in same body: ${path.basename(file)}:${s.at + 1} ${s.kind}`);
    }
    if (other !== null) {
      t.other[1]++;
      if (typeLines.includes(pos(other))) t.other[0]++;
      else if (list) console.log(`  hidden in other decl: ${path.basename(file)}:${s.at + 1} ${s.kind}`);
    }
    // With only the syntax error: anything else reported follows from it.
    const alone = compile(mutated.join('\n'), file, 'test').diagnostics.filter((d) => d.code !== 'CAN0001' && !known.has(`${d.span.start.line} ${d.message}`));
    t.false += alone.length ? 1 : 0;
    if (list) for (const d of alone) console.log(`  false: ${path.basename(file)}:${s.at + 1} ${s.kind} -> ${d.span.start.line}: ${d.code} ${d.message}`);
    // A second error of the same kind within a few lines: both reported?
    const next = all.find((x) => x.kind === s.kind && x.at > s.at && x.at - s.at <= 6 && indent(lines[x.at]) === indent(lines[s.at]));
    if (next) {
      const two = [...lines];
      two[s.at] = s.mutate(lines[s.at]);
      two[next.at] = next.mutate(lines[next.at]);
      const n = compile(two.join('\n'), file, 'test').diagnostics.filter((d) => d.code === 'CAN0001').length;
      t.pair[1]++;
      if (n === 2) t.pair[0]++;
    }
  }
}
const pct = ([a, b]: [number, number]) => (b ? `${a}/${b}` : '-');
console.log('kind       sites  one-error  same-body-type-err  other-decl-type-err  both-of-two  false');
for (const [k, t] of tally) console.log(`${k.padEnd(10)} ${String(t.n).padStart(5)}  ${String(t.reported).padStart(9)}  ${pct(t.same).padStart(18)}  ${pct(t.other).padStart(19)}  ${pct(t.pair).padStart(11)}  ${t.false}`);
