import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// docs/start.md (card 051), docs/agent.md (card #f4df4655) and docs/agent-more.md (#7de8b2de): every ```candor block compiles. A block that starts with `module`
// is a whole program, and its tests pass; one with declarations is a module of its own; the
// rest are statements, each run as a test. ```candor wrong CANxxxx must give that error. A block
// starting `// x_test.candor` is the test file of the block before it (#240e482c): with a
// `module` line when that block has one, else the harness adds it.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

const isTests = (code: string) => /^\/\/ \w+_test\.candor/.test(code);
/** Each block, a test file's on the block before it. */
const blocksOf = (page: string) => {
  const all = [...page.matchAll(/^```candor(.*)\n([\s\S]*?)^```$/gm)].map((m) => ({
    info: m[1].trim(),
    code: m[2],
    line: page.slice(0, m.index).split('\n').length,
    tests: null as string | null,
  }));
  for (const [i, b] of all.entries()) if (isTests(b.code)) all[i - 1].tests = b.code;
  return all.filter((b) => !isTests(b.code));
};
const count = (code: string | null) => code?.match(/^test "/gm)?.length ?? 0;
const isDecls = (code: string) => /^(fn|struct|enum|impl|import|trait|test) /m.test(code);
const asModule = (code: string, i: number) => `module block${i}\n\n${code}${/^fn main\(/m.test(code) ? '' : '\nfn main() {}\n'}`;
const diags = (src: string, file: string) => compile(src, file).diagnostics.map((d) => `${d.code} ${d.message}`);

function candorTest(doc: string, name: string, src: string, tests: number, testSrc: string | null = null) {
  const dir = path.join(tmpdir(), 'candor-test', doc, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.candor`), src);
  rmSync(path.join(dir, `${name}_test.candor`), { force: true });
  if (testSrc) writeFileSync(path.join(dir, `${name}_test.candor`), testSrc);
  const r = cli('test', path.join(dir, `${name}.candor`), '--out', path.join(dir, 'out'));
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain(`${tests} passed, 0 failed`);
}

for (const [doc, programs, mistakes, statementsToo] of [['start', 3, true, true], ['agent', 0, false, true], ['agent-more', 0, false, false], ['agent-service', 0, false, false]] as const)
describe(`docs/${doc}.md`, () => {
  const blocks = blocksOf(readFileSync(path.join(root, 'docs', `${doc}.md`), 'utf8'));
  test('has its whole programs, declarations, statements and mistakes', () => {
    expect(blocks.filter((b) => b.code.startsWith('module ')).length).toBe(programs);
    expect(blocks.filter((b) => b.info.startsWith('wrong')).length > 0).toBe(mistakes);
  });

  for (const [i, b] of blocks.entries()) {
    if (b.info.startsWith('wrong')) {
      const code = b.info.split(' ')[1];
      test(`line ${b.line}: the mistake gives ${code}`, () => {
        expect(diags(asModule(b.code, i), `block${i}`).map((d) => d.slice(0, 7))).toContain(code);
      });
    } else if (b.code.startsWith('module ')) {
      test(
        `line ${b.line}: the program compiles and passes its tests`,
        () => {
          expect(diags(b.code, `block${i}`)).toEqual([]);
          // Its test file names the module itself.
          candorTest(doc, `block${i}`, b.code, count(b.tests), b.tests);
        },
        120_000,
      );
    } else if (isDecls(b.code)) {
      test(
        `line ${b.line}: the declarations compile`,
        () => {
          const src = asModule(b.code, i);
          expect(diags(src, `block${i}`)).toEqual([]);
          if (b.tests) candorTest(doc, `block${i}`, src, count(b.tests), `module block${i}\n\n${b.tests}`);
        },
        120_000,
      );
    }
  }

  test(
    'the statements run and their asserts hold',
    () => {
      const statements = blocks.filter((b) => b.info === '' && !b.code.startsWith('module ') && !isDecls(b.code));
      expect(statements.length > 0).toBe(statementsToo);
      if (!statementsToo) return;
      const tests = `module statements\n\n${statements.map((b) => `test "line ${b.line}" {\n${b.code.replace(/^(?=.)/gm, '  ')}}\n`).join('\n')}`;
      const read = (f: string) => (f === 'statements_test.candor' ? tests : null);
      expect(compile('module statements\n\nfn main() {}\n', 'statements.candor', 'test', { read }).diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
      candorTest(doc, 'statements', 'module statements\n\nfn main() {}\n', statements.length, tests);
    },
    120_000,
  );
});
