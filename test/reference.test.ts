import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doc, reference, renderReference } from '../src/reference';
import { writeModule } from './split';

// The reference: generated from src/reference.ts, every example run.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

describe('the reference', () => {
  test('names every method its real types have, and no other', () => {
    for (const s of reference) {
      if (!s.types) continue;
      // An entry with a written signature is generic, which the types can't hold (`random.shuffle`).
      expect([s.key, s.entries.filter((e) => !e.sig).map((e) => e.name).sort()]).toEqual([s.key, [...s.types.keys()].sort()]);
    }
  });

  test('has an example for every method but Go\'s error', () => {
    const missing = reference.flatMap((s) => s.entries.filter((e) => !e.example).map((e) => `${s.key}.${e.name}`));
    expect(missing).toEqual(['goerror.message', 'goerror.is']);
  });

  test('links every standard module', () => {
    const page = renderReference();
    const missing = readdirSync(path.join(root, 'std'))
      .filter((f) => f.endsWith('.candor'))
      .filter((f) => !page.includes(`(../std/${f})`));
    expect(missing).toEqual([]);
  });

  test('docs/reference.md is up to date (`bun run reference`)', () => {
    expect(readFileSync(path.join(root, 'docs', 'reference.md'), 'utf8')).toBe(renderReference());
  });

  test(
    'every example runs and its asserts hold',
    () => {
      const blocks = reference.flatMap((s) =>
        s.entries.filter((e) => e.example).map((e) => `test "${s.key}.${e.name}" {\n${e.example!.replace(/^/gm, '  ')}\n}\n`),
      );
      const dir = path.join(tmpdir(), 'candor-test', 'reference');
      mkdirSync(dir, { recursive: true });
      // `fs` for `env.load`'s example, `time` for `env.zone`'s.
      writeModule(path.join(dir, 'examples.candor'), `module examples\n\nimport "fs"\nimport "time"\n\nfn main() {}\n\n${blocks.join('\n')}`);
      const run = cli(dir, 'test', 'examples.candor', '--out', path.join(dir, 'out'));
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain(`${blocks.length} passed, 0 failed`);
    },
    120_000,
  );
});

describe('candor doc', () => {
  test('lists the sections, prints one, or every method of a name', () => {
    expect(doc(undefined).text).toContain('sections: int, float, char, bool, string, bytes, list, map');
    expect(doc('string').text).toContain('### `split(string) -> List<string>`');
    expect(doc('List<T>').text).toStartWith('## List<T>');
    const split = doc('length');
    expect(split.text).toContain('string: `length() -> int`');
    expect(split.text).toContain('List<T>: `length() -> int`');
    expect(doc('includes')).toEqual({ text: 'no method `includes`\nstring: use `contains`\n', ok: false });
    expect(doc('nope').ok).toBe(false);
  });

  test('from the command line', () => {
    const r = cli(root, 'doc', 'tasks');
    expect(r.status).toBe(0);
    expect(r.stdout).toStartWith('## tasks (effect)');
  });
});
