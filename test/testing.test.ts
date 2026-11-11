import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { compileSplit } from './split';

const root = path.join(import.meta.dir, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const codes = (src: string, mode: 'main' | 'test' = 'main') => compileSplit(src, 't', mode).diagnostics.map((d) => d.code);
const lib = `module m\nfn add(a: int, b: int) -> int {\n  return a + b\n}\n`;

describe('test blocks', () => {
  test('a file with only tests needs no main under `candor test`', () => {
    const src = `${lib}test "adds" {\n  assert add(2, 3) == 5\n}\n`;
    expect(codes(src, 'test')).toEqual([]);
    expect(codes(src)).toEqual(['CAN0007']);
  });

  test('tests are checked by `candor test` and `check`, and only `candor test` compiles them', () => {
    const src = `${lib}fn main() {}\ntest "adds" {\n  assert add(2, 3) == 5\n}\n`;
    expect(compileSplit(src, 't').go).not.toContain('test__');
    expect(compileSplit(src, 't', 'test').go).toContain('func test__1(ctx__ *candor.Ctx) {');
    // `check` compiles as `test` does; build and run never read the test file.
    expect(codes(`${lib}fn main() {}\ntest "bad" {\n  assert add(2, "3") == 5\n}\n`, 'test')).toEqual(['CAN0005']);
    expect(codes(`${lib}fn main() {}\ntest "bad" {\n  assert add(2, "3") == 5\n}\n`)).toEqual([]);
  });

  test('every effect is available, so none goes unused', () => {
    expect(codes(`${lib}test "t" {\n  io.println("x")\n}\n`, 'test')).toEqual([]);
  });

  test('`test` is still an ordinary name', () => {
    expect(codes(`${lib}fn main() uses io {\n  let test = "x"\n  io.println(test)\n}\n`)).toEqual([]);
  });

  test('duplicate names', () => {
    expect(codes(`${lib}test "a" {\n  assert true\n}\ntest "a" {\n  assert true\n}\n`, 'test')).toEqual(['CAN0016']);
  });
});

describe('test files', () => {
  const main = `module m\n\nimport "json"\n\nfn add(a: int, b: int) -> int {\n  return a + b\n}\n\nfn main() {}\n`;
  const withTests = (tests: string, mode: 'main' | 'test' = 'test', src = main) =>
    compile(src, 'dir/m.candor', mode, { read: (f) => (f === 'dir/m_test.candor' ? tests : null) });

  test('x_test.candor is the same module: private names and imports, its own lines', () => {
    const r = withTests(`module m\n\ntest "adds" {\n  assert add(2, 3) == 5\n  assert json.encode(1) == "1"\n}\n`);
    expect(r.diagnostics).toEqual([]);
    expect(r.testFile).toEqual({ file: 'dir/m_test.candor', from: 9 });
    expect(r.go).toContain('candor.Fail(4, "assert add(2, 3) == 5"');
    expect(r.go).toContain('candor.RunTests("dir/m_test.candor"');
    expect(r.go).toMatch(/\/\/line .*dir\/m_test\.candor:4\n/);
    const bad = withTests(`module m\n\ntest "bad" {\n  assert add(2, "3") == 5\n}\n`);
    expect(bad.diagnostics.map((d) => [d.code, d.file, d.span.start.line])).toEqual([['CAN0005', 'dir/m_test.candor', 4]]);
  });

  test('build and run leave it out', () => {
    const r = withTests(`module m\n\ntest "bad" {\n  assert add(2, "3") == 5\n}\n`, 'main');
    expect(r.diagnostics).toEqual([]);
    expect(r.testFile).toBeNull();
  });

  test('it may import more, and hold helpers, types and test fns', () => {
    const r = withTests(`module m\n\nimport "time"\n\nstruct Case {\n  a: int\n}\n\nfn twice(c: Case) -> int {\n  return add(c.a, c.a)\n}\n\ntest fn same(a: int, b: int) {\n  assert a == b\n}\n\ntest "t" {\n  same(twice(Case { a: 2 }), 4)\n  assert time.days(1) > 0\n}\n`);
    expect(r.diagnostics).toEqual([]);
  });

  test('a test or a private test fn in the module\'s own file is refused, with where it goes', () => {
    const r = compile(`${lib}test "a" {\n  assert true\n}\ntest fn h() {}\npub test fn shared() {}\n`, 'lib/m.candor', 'test', { read: () => null });
    expect(r.diagnostics.map((d) => [d.code, d.span.start.line, d.message, d.help])).toEqual([
      ['CAN0063', 5, 'a `test` block goes in m_test.candor, not in the module\'s own file', 'move it to m_test.candor beside this file: it starts with `module m` and sees the module\'s private names'],
      ['CAN0063', 8, 'a `test fn` goes in m_test.candor, not in the module\'s own file', 'move it to m_test.candor beside this file, or make it `pub test fn` for other modules\' tests'],
    ]);
  });

  test('program code may reuse a name only the test file declares, and can\'t name it', () => {
    const src = `module m\n\nfn size() -> int {\n  let count = 2\n  let Case = 1\n  return count + Case\n}\n\nfn main() {}\n`;
    const tests = `module m\n\nconst limit = 3\n\nstruct Case {\n  a: int\n}\n\nfn count(c: Case) -> int {\n  return c.a + limit\n}\n\ntest fn file() {}\n\ntest "t" {\n  file()\n  assert count(Case { a: size() }) == 5\n}\n`;
    expect(withTests(tests, 'test', src).diagnostics).toEqual([]);
    // Test code sees both, so it still can't.
    const inTest = withTests(tests.replace('  file()\n', '  let size = 1\n  file()\n'), 'test', src);
    expect(inTest.diagnostics.map((d) => [d.code, d.file, d.message])[0]).toEqual(['CAN0016', 'dir/m_test.candor', '`size` is already a function']);
    // `build` doesn't read the test file.
    const uses = withTests(tests, 'test', src.replace('return count + Case', 'return count + Case + limit'));
    expect(uses.diagnostics.map((d) => [d.code, d.file, d.message, d.help])).toContainEqual(['CAN0063', 'dir/m.candor', '`limit` is declared in m_test.candor, which `candor build` doesn\'t read', 'move `limit` into m.candor if program code needs it']);
  });

  test('its module line must be the module\'s', () => {
    const r = withTests(`module other\n\ntest "t" {\n  assert true\n}\n`);
    expect(r.diagnostics.map((d) => [d.code, d.file, d.span.start.line, d.help])).toEqual([['CAN0063', 'dir/m_test.candor', 1, 'start it with `module m`, the line m.candor starts with']]);
  });

  test('a syntax error in it is at its own line', () => {
    const r = withTests(`module m\n\ntest "t" {\n  assert (\n}\n`);
    expect(r.diagnostics.filter((d) => d.code === 'CAN0001').every((d) => d.file === 'dir/m_test.candor' && d.span.start.line <= 5)).toBe(true);
  });
});

describe('assert', () => {
  test('only inside tests', () => {
    const r = compileSplit(`module m\nfn main() {\n  assert 1 == 1\n}\n`, 't');
    expect(r.diagnostics.map((d) => [d.code, d.help])).toEqual([
      ['CAN0034', 'for a failure the caller should handle, return a `Result`; a helper for tests that asserts is a `test fn`'],
    ]);
  });

  test('needs a bool', () => {
    expect(codes(`module m\ntest "t" {\n  assert 1\n}\n`, 'test')).toEqual(['CAN0021']);
  });

  test('records each part with its column and its source, parentheses as written', () => {
    const r = compileSplit(`${lib}test "t" {\n  assert (add(1, 2)) == 4\n}\n`, 't', 'test');
    expect(r.go).toContain('candor.Fail(6, "assert (add(1, 2)) == 4", []int{8, 19}, []string{"(add(1, 2))", "(add(1, 2)) == 4"}, ');
  });
});

describe('fakes', () => {
  test('fake-only methods are rejected outside tests', () => {
    expect(codes(`module m\nfn main() uses io {\n  io.println(io.output())\n}\n`)).toEqual(['CAN0035']);
    expect(codes(`module m\nfn main() uses clock {\n  clock.advance(5)\n}\n`)).toEqual(['CAN0035']);
  });

  test('the real clock', () => {
    const r = compileSplit(`module m\nfn main() uses io, clock {\n  io.println(clock.now().toString())\n}\n`, 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('m__main(candor.Root(), candor.StdIO(), candor.SystemClock())');
  });
});

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });

describe('candor test', () => {
  test(
    'failures show the value of each part of the assertion',
    () => {
      const file = 'test/fixtures/failing.candor';
      const out = path.join(tmpdir(), 'candor-test', 'failing');
      const r = cli('test', file, '--out', out);
      expect(r.stdout).toBe(readFileSync(path.join(root, 'test/fixtures/failing.out'), 'utf8'));
      expect(r.status).toBe(1);
      // The binary goes once it has run; the module stays for the next build.
      expect(existsSync(path.join(out, 'failing' + exe))).toBe(false);
      expect(existsSync(path.join(out, 'go.mod'))).toBe(true);
    },
    60_000,
  );

  test(
    '--json: a line per test as it ends, then the totals; each failing part named with its value',
    () => {
      const file = 'test/fixtures/failing.candor';
      const tests = 'test/fixtures/failing_test.candor';
      const r = cli('test', file, '--json', '--seed', '7', '--out', path.join(tmpdir(), 'candor-test', 'failing'));
      expect(r.status).toBe(1);
      expect(r.stdout.endsWith('}\n')).toBe(true);
      expect(r.stdout.trim().split('\n')).toHaveLength(9);
      const report = jsonLines(r.stdout);
      expect(report.summary).toEqual({ type: 'summary', file: tests, seed: 7, passed: 1, failed: 7, filtered: 0 });
      expect(report.tests.map((t: { name: string; status: string }) => `${t.name}:${t.status}`)).toEqual([
        'passes:pass', 'arithmetic:fail', 'optional:fail', 'short circuit:fail', 'enum:fail', 'multi-line:fail', 'io:fail', 'panics:fail',
      ]);
      expect(report.tests[0]).toEqual({ type: 'test', name: 'passes', status: 'pass', seeded: false, runs: 1, seed: 7 });
      expect(report.tests[1].failure).toEqual({
        kind: 'assert',
        line: 9,
        source: 'assert total(a, 22) == 42',
        parts: [
          { col: 7, text: 'total(a, 22)', value: '41' },
          { col: 13, text: 'a', value: '20' },
          { col: 20, text: 'total(a, 22) == 42', value: 'false' },
        ],
        traces: [[{ file: tests, line: 9, fn: 'test "arithmetic"' }]],
        text: 'assert total(a, 22) == 42\n       |     |      |\n       |     |      false\n       |     20\n       41',
      });
      // A parenthesized operand keeps its parentheses; a part that never ran is left out.
      expect(report.tests[2].failure.parts[2]).toEqual({ col: 28, text: '(find("Bob") ?? "?") == "ada@example.com"', value: 'false' });
      expect(report.tests[3].failure.parts.map((p: { text: string }) => p.text)).toEqual(['n', 'n > 0', 'n > 0 && 10 / n == 1']);
      expect(r.stdout).toContain('"source":"assert n > 0 && 10 / n == 1"');
      expect(report.tests[5].failure.source).toBe('assert ( total(2, 2) == 5 )');
      expect(report.tests[7].failure).toEqual({
        kind: 'panic',
        message: 'integer divide by zero',
        traces: [[{ file, line: 33, fn: 'div' }, { file: tests, line: 39, fn: 'test "panics"' }]],
        text: `panic: integer divide by zero\n  at ${file}:33 in div\n  at ${tests}:39 in test "panics"`,
      });
    },
    60_000,
  );

  test(
    '--only runs the tests named, says how many it left out, and refuses a name that matches nothing',
    () => {
      const file = 'test/fixtures/failing.candor';
      const out = path.join(tmpdir(), 'candor-test', 'failing');
      const expected = readFileSync(path.join(root, 'test/fixtures/failing.out'), 'utf8').split('\n');
      const one = cli('test', file, '--only', 'arithmetic', '--out', out);
      expect(one.stdout).toBe(expected.slice(1, 9).join('\n') + '\n0 passed, 1 failed, 7 filtered out\n');
      expect(one.status).toBe(1);
      const two = cli('test', file, '--only', 'passes', '--only', 'enum', '--out', out);
      expect(two.stdout).toBe('PASS passes\n' + expected.slice(25, 33).join('\n') + '\n1 passed, 1 failed, 6 filtered out\n');
      const none = cli('test', file, '--only', 'nope', '--out', out);
      expect(none.stdout).toBe('');
      expect(none.stderr).toBe(
        'candor: no test matching "nope" in test/fixtures/failing_test.candor\n' +
          'tests: "passes", "arithmetic", "optional", "short circuit", "enum", "multi-line", "io", "panics"\n',
      );
      expect(none.status).toBe(1);
      const json = cli('test', file, '--only', 'passes', '--json', '--out', out);
      const lines = jsonLines(json.stdout);
      expect(lines.summary).toMatchObject({ passed: 1, failed: 0, filtered: 7 });
      expect(lines.tests).toMatchObject([{ name: 'passes', status: 'pass' }]);
      expect(json.status).toBe(0);
      expect(cli('test', file, '--only').stderr).toContain('candor: --only needs part of a test name');
    },
    120_000,
  );

  test('a file without tests gives just the totals under --json', () => {
    expect(cli('test', 'examples/hello.candor', '--json').stdout).toBe(
      '{"type":"summary","file":"examples/hello.candor","seed":null,"passed":0,"failed":0,"filtered":0}\n',
    );
    expect(cli('test', 'examples/hello.candor').stdout).toBe('no tests in examples/hello.candor (they go in hello_test.candor)\n');
  }, 30_000);

  test(
    'file:line runs the test holding the line; a line in no test lists them',
    () => {
      const file = 'test/fixtures/failing.candor';
      const out = path.join(tmpdir(), 'candor-test', 'failing');
      const expected = readFileSync(path.join(root, 'test/fixtures/failing.out'), 'utf8').split('\n');
      // Line 9 of the test file is inside `test "arithmetic"`.
      const tests = 'test/fixtures/failing_test.candor';
      const one = cli('test', `${tests}:9`, '--out', out);
      expect(one.stdout).toBe(expected.slice(1, 9).join('\n') + '\n0 passed, 1 failed, 7 filtered out\n');
      const nowhere = cli('test', `${file}:1`, '--out', out);
      expect(nowhere.status).toBe(1);
      expect(nowhere.stderr).toStartWith(`candor: line 1 of ${file} is in no test; the tests:\n  ${tests}:`);
      expect(nowhere.stderr).toContain('"arithmetic"');
      expect(cli('run', `${file}:38`).stderr).toContain('`file:line` picks a test, for test');
    },
    120_000,
  );

  test(
    'lists and maps keep value semantics in Go (spare capacity, nested lists, pop, closures in loops, map ownership, index writes)',
    () => {
      const out = path.join(tmpdir(), 'candor-test', 'aliasing');
      const r = cli('test', 'test/fixtures/aliasing.candor', '--out', out);
      expect(r.stdout).toMatch(/\n14 passed, 0 failed\n$/);
      expect(r.status).toBe(0);
      expect(existsSync(path.join(out, 'alias' + exe))).toBe(false);
    },
    60_000,
  );
});

/** `candor test --json`'s lines: a line per test as it ends, then the totals. */
function jsonLines(stdout: string) {
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  return { tests: lines.filter((l) => l.type === 'test'), summary: lines.at(-1) };
}
