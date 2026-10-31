import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// #cb18c33b: `env.signals(s, [...])`, a Channel of the built-in `Signal` until the scope ends;
// `env.sendSignal(.X)` in tests. hey's shape: work until done or interrupted, then report. The
// real path (os/signal) is tested in runtime/go/signals_test.go, as Windows can't send SIGINT.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

function files(name: string, src: Record<string, string>) {
  const dir = path.join(tmpdir(), 'candor-test', 'signals', name);
  mkdirSync(dir, { recursive: true });
  for (const [f, s] of Object.entries(src)) writeFileSync(path.join(dir, f), s);
  return dir;
}

function candor(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['run', cli, ...args, '--out', path.join(dir, 'out')], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });
}

const app = `module app

// Requests until there have been 100, or Ctrl-C; how many were made.
fn load() -> int uses clock, env, tasks {
  return tasks.scope((s) => {
    let sigs = env.signals(s, [.Interrupt, .Terminate])
    let stop = s.atomic(false)
    s.background(() => {
      if sigs.recv() != none {
        stop.set(true)
      }
    })
    let mut n = 0
    while !stop.get() && n < 100 {
      clock.sleep(10)
      n = n + 1
    }
    return n
  })
}

fn main() uses clock, env, io, tasks {
  io.println("made \${load()}")
}
`;

const tests = `module app

test "an interrupt stops the work, and the report still comes" {
  tasks.scope((s) => {
    s.spawn(() => {
      clock.sleep(35)
      env.sendSignal(.Interrupt)
    })
    assert load() == 4
  })
}

test "a signal not asked for is not given" {
  tasks.scope((s) => {
    s.spawn(() => {
      clock.sleep(35)
      env.sendSignal(.Hangup)
    })
    assert load() == 100
  })
}

test "signals come in order, until the scope ends" {
  let got = tasks.scope((s) => {
    let sigs = env.signals(s, [.Hangup, .User2])
    env.sendSignal(.User2)
    env.sendSignal(.Hangup)
    return [sigs.recv(), sigs.recv()]
  })
  assert got == [.User2, .Hangup]
  env.sendSignal(.Hangup)
}
`;

test('signals reach the channel in tests, under seeded orders', () => {
  const dir = files('sim', { 'app.candor': app, 'app_test.candor': tests });
  for (const seed of ['1', '2', '3']) {
    const r = candor(dir, 'test', path.join(dir, 'app.candor'), '--seed', seed);
    expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
  }
}, 120_000);

test('a program that asks for signals and is sent none runs as before', () => {
  const dir = files('run', { 'app.candor': app });
  const r = candor(dir, 'run', path.join(dir, 'app.candor'));
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('made 100\n');
}, 60_000);

const errors = (body: string, uses = 'env, tasks') =>
  compile(`module m\n\nenum Other { A }\n\nfn main() uses ${uses} {\n${body}\n}\n`, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

test('env.signals takes a scope and the signals; sendSignal is for tests', () => {
  expect(errors('  tasks.scope((s) => {\n    let sigs: Channel<Signal> = env.signals(s, [.Interrupt])\n  })')).toEqual([]);
  expect(errors('  env.sendSignal(.Interrupt)')).toEqual(['`env.sendSignal` is for tests: it sends a signal to the fake `env`']);
  expect(errors('  let sigs = env.signals([.Interrupt])')).toEqual(['`env.signals` takes 2 arguments, the scope the signals are wanted in and which ones, found 1']);
  expect(errors('  let sigs = env.signals(1, [.Interrupt])')).toEqual(['`env.signals` takes the Scope the signals are wanted in first, found int']);
  expect(errors('  tasks.scope((s) => {\n    let sigs = env.signals(s, [])\n  })')).toEqual(['`env.signals` with no signals would never give one']);
  expect(errors('  tasks.scope((s) => {\n    let sigs = env.signals(s, [Other.A])\n  })')[0]).toContain('Signal');
  expect(errors('  tasks.scope((s) => {\n    let sigs = env.signals(s, [.Interrupt])\n  })', 'tasks')[0]).toContain('env');
});

test("a module's own Signal hides the built-in one", () => {
  const r = compile('module m\n\nenum Signal { Go }\n\nfn main() uses env, tasks {\n  tasks.scope((s) => {\n    let sigs = env.signals(s, [.Go])\n  })\n}\n', 'm.candor');
  expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual(["this module's own `Signal` type hides the built-in one, which `env.signals` takes"]);
});
