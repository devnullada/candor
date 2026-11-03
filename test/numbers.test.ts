import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { headlineCards } from '../site/src/headline';
import { begin, changeBegin, changeEnd, compareBegin, compareEnd, end, load, render, renderChange, renderCompare, renderSameSpec, sameBegin, sameEnd, stdModules } from '../tools/numbers';

// trial-numbers/numbers.json feeds the README (once it has a Numbers block again) and the site;
// `bun run numbers` regenerates both parts.

const root = path.join(import.meta.dir, '..');

// `bun run numbers` counts the passing tests before it has written these, so it skips them.
describe.skipIf(!!process.env.CANDOR_NUMBERS)('the numbers', () => {
  const n = load();

  test('the README shows them as they are, if it shows them', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    if (!readme.includes(begin)) return;
    expect(readme.slice(readme.indexOf(begin), readme.indexOf(end) + end.length)).toBe(render(n));
  });

  test('are for this version, with every standard module', () => {
    expect(n.language.version).toBe(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    expect(n.language.stdModules).toEqual(stdModules());
  });

  test('every claim has its catches and its trial results', () => {
    for (const t of n.trials) {
      expect(t.catches.length).toBeGreaterThan(0);
      expect(t.results.length).toBe(t.runs.length);
    }
    for (const p of n.ports) expect(p.catches.length).toBeGreaterThan(0);
    expect(n.change.catches.length).toBeGreaterThan(0);
  });

  test("the front page's numbers each show figures, and an expected one says so and why", () => {
    const cards = headlineCards(n);
    expect(cards.map((c) => c.id)).toEqual(['accepted', 'cost', 'effects', 'newApp']);
    for (const c of cards) {
      expect(c.rows.length).toBeGreaterThan(0);
      for (const r of c.rows) {
        expect(r.go).toMatch(/\d/);
        expect(r.candor).toMatch(/\d/);
        // A `~` is how an estimate reads on the page: it never appears without the label.
        expect(r.go.startsWith('~')).toBe(!!r.expected);
        expect(r.candor.startsWith('~')).toBe(!!r.expected);
      }
    }
    expect(n.headline.catches.length).toBeGreaterThan(0);
    for (const s of n.headline.stages) expect(s.done).toBeLessThanOrEqual(s.planned);
  });

  test('docs/trials.md shows the change trial as it is', () => {
    const trials = readFileSync(path.join(root, 'docs', 'trials.md'), 'utf8');
    expect(trials.slice(trials.indexOf(changeBegin), trials.indexOf(changeEnd) + changeEnd.length)).toBe(renderChange(n.change));
  });

  test('docs/trials.md shows the other agents as they are', () => {
    const trials = readFileSync(path.join(root, 'docs', 'trials.md'), 'utf8');
    expect(trials.slice(trials.indexOf(compareBegin), trials.indexOf(compareEnd) + compareEnd.length)).toBe(renderCompare(n.compare));
    expect(n.compare.catches.length).toBeGreaterThan(0);
  });

  test('docs/trials.md shows the same-spec trial as it is, every app in it', () => {
    const trials = readFileSync(path.join(root, 'docs', 'trials.md'), 'utf8');
    const same = n.trials.find((t: any) => t.id === 'same-spec');
    expect(trials.slice(trials.indexOf(sameBegin), trials.indexOf(sameEnd) + sameEnd.length)).toBe(renderSameSpec(same));
    expect(Object.keys(same.tests).sort()).toEqual(readdirSync(path.join(root, 'trials', 'apps')).sort());
  });
});
