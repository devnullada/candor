import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// A panic names Candor lines: `//line` directives in the generated Go, and the runtime's report
// of the Candor frames, in `candor run` and in `candor test`.

const here = path.resolve('t').replace(/\\/g, '/');

describe('line directives', () => {
  const src = `module m

fn div(a: int, b: int) -> int {
  return a / b
}

fn main() uses io {
  let n = if div(4, 2) == 2 {
    div(1, 0)
  } else {
    0
  }
  io.println(n.toString())
}
`;

  test('every line of a statement is marked with its Candor line, nested statements with theirs', () => {
    const r = compileSplit(src, 't');
    expect(r.diagnostics).toEqual([]);
    const go = r.go!;
    expect(go).toContain(`//line ${here}:4\n\treturn candor.Div(a, b)`);
    expect(go).toContain(`//line ${here}:8\n\tvar t__1 int64\n//line ${here}:8\n\tif (m__div(ctx__, 4, 2) == 2) {\n//line ${here}:9\n\t\tt__1 = m__div(ctx__, 1, 0)\n//line ${here}:8\n\t} else {\n//line ${here}:11\n\t\tt__1 = 0\n//line ${here}:8\n\t}\n//line ${here}:8\n\tvar n int64 = t__1`);
    // Go reads a directive only at the start of a line: none is indented.
    expect(go).not.toMatch(/^\s+\/\/line /m);
  });

  test('the helpers after the Candor code are Go again, and `main` defers the report', () => {
    const go = compileSplit(src, 't').go!;
    const lines = go.split('\n');
    const reset = lines.findIndex((l) => /^\/\/line main\.go:\d+$/.test(l));
    expect(reset).toBeGreaterThan(0);
    expect(lines[reset]).toBe(`//line main.go:${reset + 2}`);
    expect(lines.slice(reset).some((l) => l.includes('.candor:') || l.includes(`${here}:`))).toBe(false);
    expect(go).toContain('func main() {\n\tdefer candor.Report()\n\tm__main(candor.Root(), candor.StdIO())\n}');
    expect(compileSplit(`module m\ntest "t" {\n  assert true\n}\n`, 't', 'test').go).not.toContain('candor.Report()');
  });

  test('an expression-bodied lambda and an `else if` condition mark their own lines', () => {
    const r = compileSplit(`module m\nfn main() uses io {\n  let f = (x: int, y: int) =>\n    x / y\n  let s = if f(1, 0) == 0 {\n    "a"\n  } else if f(2, 1) ==\n    1 {\n    "b"\n  } else {\n    "c"\n  }\n  io.println(s)\n}\n`, 't');
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain(`//line ${here}:4\n\t\treturn candor.Div(x, y)`);
    expect(r.go).toContain(`//line ${here}:7\n\t} else if (f(ctx__, 2, 1) == 1) {`);
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, ...env },
  });

describe('candor run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'panics');
  mkdirSync(dir, { recursive: true });

  test(
    'a panic prints its message and the Candor frames, and exits 2',
    () => {
      writeModule(
        path.join(dir, 'crash.candor'),
        `module crash

fn div(a: int, b: int) -> int {
  return a / b
}

fn main() uses io {
  io.println(div(1, 0).toString())
}
`,
      );
      const r = cli(dir, {}, 'run', 'crash.candor', '--out', path.join(dir, 'crash'));
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('panic: integer divide by zero\n  at crash.candor:4 in div\n  at crash.candor:8 in main\n');
      expect(r.status).toBe(2);

      // CANDOR_TRACE=go leaves the panic to Go, whose frames still name Candor lines.
      const raw = cli(dir, { CANDOR_TRACE: 'go' }, 'run', 'crash.candor', '--out', path.join(dir, 'crash'));
      expect(raw.stderr).toContain('panic: runtime error: integer divide by zero');
      expect(raw.stderr).toContain('goroutine 1 [running]:');
      expect(raw.stderr).toMatch(/main\.crash__div\(.*\n\t.*crash\.candor:4/);
      expect(raw.status).toBe(2);
    },
    120_000,
  );

  test(
    'a crash in a task shows the task, then where its scope is',
    () => {
      writeModule(
        path.join(dir, 'crashed.candor'),
        `module crashed

fn div(a: int, b: int) -> int {
  return a / b
}

fn main() uses io, tasks {
  let n = tasks.scope((s) => {
    let t = s.spawn(() => div(1, 0))
    return t.join()
  })
  io.println(n.toString())
}
`,
      );
      const r = cli(dir, {}, 'run', 'crashed.candor', '--out', path.join(dir, 'crashed'));
      expect(r.stderr).toBe(
        'panic: integer divide by zero\n  at crashed.candor:4 in div\n  at crashed.candor:9 in main\nin a task of the scope at\n  at crashed.candor:8 in main\n',
      );
      expect(r.status).toBe(2);
    },
    120_000,
  );

  test(
    'a write past the end of a list is a panic (a read is none)',
    () => {
      writeModule(
        path.join(dir, 'bounds.candor'),
        `module bounds

fn main() uses io {
  let mut xs = [1]
  io.println((xs[3] ?? 0).toString())
  xs[3] += 1
}
`,
      );
      const r = cli(dir, {}, 'run', 'bounds.candor', '--out', path.join(dir, 'bounds'));
      expect(r.stdout).toBe('0\n');
      expect(r.stderr).toBe('panic: index 3 out of range: the list has length 1\n  at bounds.candor:6 in main\n');
      expect(r.status).toBe(2);
    },
    120_000,
  );
});

describe('candor test', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'panics');
  mkdirSync(dir, { recursive: true });

  test(
    'a panic shows its frames; a failed assert shows them when it ran in a lambda or a task',
    () => {
      writeModule(
        path.join(dir, 'checks.candor'),
        `module checks

fn div(a: int, b: int) -> int {
  return a / b
}

test "helper" {
  let check = (n: int) => {
    assert n == 1
  }
  check(2)
}

test "body" {
  assert div(4, 2) == 3
}

test "panics" {
  assert div(1, 0) == 0
}

test "task" {
  tasks.scope((s) => {
    assert s.spawn(() => div(1, 0)).join() == 0
  })
}
`,
      );
      const r = cli(dir, {}, 'test', 'checks.candor', '--out', path.join(dir, 'checks'));
      expect(r.stdout.replace(/^seed \d+: .*\n$/m, 'seed\n')).toBe(
        [
          'FAIL helper (checks_test.candor:9)',
          '',
          '    assert n == 1',
          '           | |',
          '           | false',
          '           2',
          '      at checks_test.candor:9 in test "helper"',
          '      at checks_test.candor:11 in test "helper"',
          '',
          'FAIL body (checks_test.candor:15)',
          '',
          '    assert div(4, 2) == 3',
          '           |         |',
          '           |         false',
          '           2',
          '',
          'FAIL panics',
          '',
          '    panic: integer divide by zero',
          '      at checks.candor:4 in div',
          '      at checks_test.candor:19 in test "panics"',
          '',
          'FAIL task',
          '',
          '    panic: integer divide by zero',
          '      at checks.candor:4 in div',
          '      at checks_test.candor:24 in test "task"',
          '    in a task of the scope at',
          '      at checks_test.candor:23 in test "task"',
          '',
          '0 passed, 4 failed',
          'seed',
          '',
        ].join('\n'),
      );
      expect(r.status).toBe(1);
    },
    120_000,
  );
});
