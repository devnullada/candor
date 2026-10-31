import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// #dfd9edd7: `s.background(f)`, a task the scope cancels once its function has returned and its
// other tasks have ended. supercronic's shape: sources feed a loop, and end when it does.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

function files(name: string, src: Record<string, string>) {
  const dir = path.join(tmpdir(), 'candor-test', 'background', name);
  mkdirSync(dir, { recursive: true });
  for (const [f, s] of Object.entries(src)) writeFileSync(path.join(dir, f), s);
  return dir;
}

function candor(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['run', cli, ...args, '--out', path.join(dir, 'out')], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });
}

const app = `module app

enum Event {
  Tick { n: int }
  Stop
}

// A source that never ends on its own, like a watcher or a server.
fn ticker(events: Channel<Event>) uses clock, io {
  defer {
    io.println("ticker stopped")
  }
  let mut n = 0
  while true {
    clock.sleep(10)
    n = n + 1
    events.send(.Tick { n })
  }
}

// One that waits forever.
fn idle(never: Channel<bool>) {
  never.recv()
}

// The work: reads events until the third tick.
fn supervise(events: Channel<Event>) -> int {
  let mut seen = 0
  for e in events {
    match e {
      .Tick { n } => {
        seen = n
        if n == 3 {
          return seen
        }
      }
      .Stop => return seen
    }
  }
  return seen
}

fn runApp() -> int uses clock, io, tasks {
  return tasks.scope((s) => {
    let events: Channel<Event> = s.channel(4)
    let never: Channel<bool> = s.channel(1)
    s.background(() => ticker(events))
    s.background(() => idle(never))
    return supervise(events)
  })
}

fn watch() -> Result<void, string> uses clock {
  clock.sleep(5)
  return Err("the watcher broke")
}

fn failing() -> Result<int, string> uses clock, tasks {
  return tasks.scope((s) => {
    s.background(() => watch())
    clock.sleep(1_000)
    return Ok(1)
  })
}

fn main() uses clock, io, tasks {
  io.println("saw \${runApp()}")
  io.println("\${failing()}")
}
`;

test('background tasks are cancelled when the work ends, their defers run, and an Err cancels the scope', () => {
  const dir = files('run', { 'app.candor': app });
  const r = candor(dir, 'run', path.join(dir, 'app.candor'));
  expect(r.stderr).toBe('');
  // The scope waits for the ticker to stop, its `defer` included, before `runApp` returns.
  expect(r.stdout).toBe('ticker stopped\nsaw 3\nErr("the watcher broke")\n');
}, 60_000);

test('the same under the test scheduler, in seeded orders', () => {
  const tests = `module app

test "the sources end with the work" {
  assert runApp() == 3
  assert io.output() == "ticker stopped\\n"
  assert clock.now() == 30
}

test "a background Err is the scope's" {
  assert failing() == Err("the watcher broke")
  assert clock.now() == 5
}

test "wait doesn't wait for a background task" {
  tasks.scope((s) => {
    let never: Channel<bool> = s.channel(1)
    s.background(() => idle(never))
    s.spawn(() => clock.sleep(5))
    s.wait()
    assert clock.now() == 5
  })
}
`;
  const dir = files('sim', { 'app.candor': app, 'app_test.candor': tests });
  for (const seed of ['1', '2', '3']) {
    const r = candor(dir, 'test', path.join(dir, 'app.candor'), '--seed', seed);
    expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
  }
}, 120_000);

test('background gives no Task, and a failing one needs its scope to return a Result', () => {
  const errors = (body: string) =>
    compile(`module m\n\nfn work() -> Result<void, string> {\n  return Ok()\n}\n\nfn main() uses tasks {\n${body}\n}\n`, 'm.candor')
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => d.message);
  expect(errors('  tasks.scope((s) => {\n    let t = s.background(() => 1)\n  })')).toEqual(['this expression has no value']);
  expect(errors('  tasks.scope((s) => {\n    s.background(() => work())\n  })')).toEqual(['this task can fail with string, so its scope must return `Result<T, string>`, not void']);
});
