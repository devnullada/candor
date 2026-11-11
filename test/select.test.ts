import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

const mod = (body: string, extra = '') => `module m\n${extra}fn main() uses io, tasks {\n${body}\n}\n`;
// `body` inside a scope with `a: Channel<string>` and `b: Channel<int>`, whose function returns nothing.
const inScope = (body: string, extra = '') =>
  mod(`  tasks.scope((s) => {\n    let a: Channel<string> = s.channel(1)\n    let b: Channel<int> = s.channel(1)\n${body}\n  })`, extra);
const diags = (src: string) => compileSplit(src, 't').diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message, d.help]);

describe('arms', () => {
  test('every arm gives the same type: the first says which, or the context does', () => {
    expect(
      diags(
        inScope(
          '    let line: string = tasks.select([a.onRecv((x) => x ?? "a closed"), b.onRecv((n) => (n ?? 0).toString()), tasks.after(100, () => "nothing"), tasks.otherwise(() => "nothing yet")])\n    io.println(line)',
        ),
      ),
    ).toEqual([]);
    expect(diags(inScope('    let n = tasks.select([b.onRecv((x) => x ?? 0), a.onRecv((x) => 1)])\n    io.println(n.toString())'))).toEqual([]);
    expect(diags(inScope('    tasks.select([b.onRecv((x) => x ?? 0), a.onRecv((x) => "one")])'))[0].slice(0, 2)).toEqual(['CAN0005', 'expected int, found string']);
  });

  test('a receive arm gets a `T?`: none once the channel is closed', () => {
    expect(diags(inScope('    tasks.select([b.onRecv((n) => n + 1)])'))[0][1]).toBe('cannot apply `+` to int? and int');
  });

  test('a send arm sends a `T`', () => {
    expect(diags(inScope('    tasks.select([a.onSend(1, () => true)])'))[0].slice(0, 2)).toEqual(['CAN0005', 'expected string, found int']);
    expect(diags(inScope('    let sent = tasks.select([a.onSend("x", () => true), tasks.otherwise(() => false)])\n    io.println(sent.toString())'))).toEqual([]);
  });

  test('arms can be built up in a list', () => {
    const body =
      '    let mut arms: List<Arm<int>> = [tasks.after(10, () => -1)]\n    arms.push(b.onRecv((n) => n ?? 0))\n    arms.push(a.onRecv((x) => 1))\n    io.println(tasks.select(arms).toString())';
    expect(diags(inScope(body))).toEqual([]);
  });

  test("an arm's function may use effects, which the function making the arm must have", () => {
    const extra = 'fn arm(ch: Channel<int>) -> Arm<void> {\n  return ch.onRecv((n) => io.println("got"))\n}\n';
    expect(diags(mod('', extra))[0].slice(0, 2)).toEqual(['CAN0004', '`io` is used here but `arm` does not declare it']);
  });
});

describe('what select refuses', () => {
  test('things that are not arms, and no arms', () => {
    expect(diags(inScope('    tasks.select([a.onRecv((x) => 1), 2])'))[0].slice(1)).toEqual([
      'an arm for `tasks.select` is expected here, found int',
      'arms are `ch.onRecv(f)`, `ch.onSend(v, f)`, `tasks.after(ms, f)` and `tasks.otherwise(f)`',
    ]);
    expect(diags(inScope('    tasks.select(a)'))[0].slice(1)).toEqual([
      '`tasks.select` takes a List of arms, found Channel<string>',
      'write `tasks.select([a.onRecv((x) => ...), tasks.after(100, () => ...)])`',
    ]);
    expect(diags(inScope('    tasks.select([])'))[0].slice(0, 2)).toEqual(['CAN0006', '`tasks.select` needs at least one arm']);
  });

  test('one `otherwise`', () => {
    expect(diags(inScope('    tasks.select([a.onRecv((x) => 1), tasks.otherwise(() => 2), tasks.otherwise(() => 3)])'))[0].slice(1)).toEqual([
      '`tasks.select` takes one `otherwise` arm',
      'it runs only when no other arm is ready, so a second could never be picked',
    ]);
  });

  test('an Arm is a handle: no methods, no `==`, and it stays in its scope', () => {
    expect(diags(inScope('    a.onRecv((x) => 1).run()'))[0].slice(1)).toEqual([
      'Arm<int> has no methods',
      'an Arm is one choice for `tasks.select([...])`, which runs the function given to it',
    ]);
    expect(diags(inScope('    let arm = a.onRecv((x) => 1)\n    let same = arm == arm'))[0][2]).toBe('an Arm is a choice for `tasks.select`, not a value');
    expect(diags(mod('  let arms = tasks.scope((s) => {\n    let c: Channel<int> = s.channel(1)\n    return [c.onRecv((n) => 1)]\n  })'))[0][1]).toBe(
      "List<Arm<int>> holds an Arm<int>, which belongs to the scope that made it, so the scope's function can't return one",
    );
    expect(diags(inScope('    for x in a.onRecv((x) => 1) {\n    }'))[0][2]).toBe('`for` takes a List, a Map, a Channel, or a range `a..b`');
    expect(diags(mod('', 'fn f(arm: Arm) {}\n'))[0].slice(1)).toEqual(['`Arm` takes one type', 'write `Arm<T>`: what `tasks.select` gives when it picks the arm']);
  });
});

describe('lowering', () => {
  test('arms are runtime values; a receive arm is handed the value and whether there was one', () => {
    const r = compileSplit(
      inScope('    let line = tasks.select([a.onRecv((x) => x ?? "closed"), b.onSend(1, () => "sent"), tasks.after(100, () => "late"), tasks.otherwise(() => "now")])\n    io.println(line)'),
      't',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.go).toContain('candor.OnRecv(ctx__, a, func(c *candor.Ctx, v string, ok bool) string { return t__3(c, optOf__(v, ok)) })');
    expect(r.go).toContain('candor.OnSend(ctx__, b, 1, t__4)');
    expect(r.go).toContain('candor.After(ctx__, 100, t__6)');
    expect(r.go).toContain('candor.Select(ctx__, []*candor.Arm[string]{t__5, t__7, t__9, candor.Otherwise(ctx__, t__8)})');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

describe('run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'select');
  mkdirSync(dir, { recursive: true });
  const ties = `module ties

// Both channels have a value: either arm may be picked.
fn tie() -> string uses tasks {
  return tasks.scope((s) => {
    let a: Channel<string> = s.channel(1)
    let b: Channel<string> = s.channel(1)
    a.send("a")
    b.send("b")
    return tasks.select([a.onRecv((x) => x ?? "closed"), b.onRecv((x) => x ?? "closed")])
  })
}

fn main() uses io, tasks {
  io.println(tie())
}

test "the tie goes to a" {
  assert tie() == "a"
}

test "nobody sends" {
  tasks.scope((s) => {
    let ch: Channel<int> = s.channel(0)
    tasks.select([ch.onRecv((x) => x ?? 0)])
  })
}
`;

  test(
    'on goroutines, Go picks among ready arms',
    () => {
      writeModule(path.join(dir, 'ties.candor'), ties);
      const r = cli(dir, 'run', 'ties.candor', '--out', path.join(dir, 'out'));
      expect(r.stderr).toBe('');
      expect(['a\n', 'b\n']).toContain(r.stdout);
    },
    120_000,
  );

  test(
    'on the test scheduler the seed picks, and replays the pick; a select nobody can wake is a deadlock',
    () => {
      writeModule(path.join(dir, 'ties.candor'), ties);
      const deadlock =
        'FAIL nobody sends\n\n    panic: candor: deadlock: every task is waiting and nothing can wake them (1 on tasks.select)\n      is a Channel never closed? `ch.close()` makes its `onRecv` arm ready; `tasks.after(ms, ...)` gives up waiting\n      at ties_test.candor:25 in test "nobody sends"\n      at ties_test.candor:23 in test "nobody sends"\n';
      // A hundred orders a run, fresh seeds each: within a few runs, the tie goes to b.
      let lost: ReturnType<typeof cli> | null = null;
      for (let i = 0; i < 12 && !lost; i++) {
        const r = cli(dir, 'test', 'ties.candor', '--out', path.join(dir, 'test'));
        expect(r.stdout).toContain(deadlock);
        if (r.stdout.includes('FAIL the tie goes to a')) lost = r;
      }
      expect(lost).not.toBeNull();
      const seed = lost!.stdout.match(/run with --seed (\d+)/)![1];
      const again = cli(dir, 'test', 'ties.candor', '--out', path.join(dir, 'test'), '--seed', seed);
      expect(again.stdout).toBe(lost!.stdout.replace(/, run \d+ of 100/, ''));
    },
    240_000,
  );
});
