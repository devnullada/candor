import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `exec.withOwnGroup` and `exec.withStop` say how a cancel stops a program, and
// `env.pid()` gives this process's id.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'exec-stop');

function cli(cmd: 'run' | 'test', src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// Starts a child of itself, then on SIGTERM writes "stopped" to its file, waits for the child
// and exits; the child does the same with its own file. Neither stops by itself in 30 s.
const stopper = `package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	got := make(chan os.Signal, 1)
	signal.Notify(got, syscall.SIGTERM)
	var child *exec.Cmd
	if len(os.Args) < 3 {
		child = exec.Command(os.Args[0], os.Args[1]+".child", "child")
		child.Start()
	}
	select {
	case <-got:
		os.WriteFile(os.Args[1], []byte("stopped"), 0o644)
		if child != nil {
			child.Wait()
		}
	case <-time.After(30 * time.Second):
	}
}
`;

test('a cancel sends the stop signal to the whole group, or kills at once on Windows', () => {
  mkdirSync(dir, { recursive: true });
  for (const f of ['parent.txt', 'parent.txt.child']) rmSync(path.join(dir, f), { force: true });
  writeFileSync(path.join(dir, 'stopper.go'), stopper);
  const exe = path.join(dir, process.platform === 'win32' ? 'stopper.exe' : 'stopper');
  expect(spawnSync(go, ['build', '-o', exe, 'stopper.go'], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
  const r = cli(
    'run',
    `module m

import "exec"

fn main() uses io, exec, clock, tasks {
  let cmd = exec.withStop(exec.withOwnGroup(exec.command(${JSON.stringify(exe)}, ["parent.txt"])), .Terminate, 10000)
  let started = clock.now()
  let r = tasks.timeout(1000, () => exec.output(cmd))
  let quick = clock.now() - started < 8000
  io.println("timed out \${r == none}, quick \${quick}")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim()).toBe('timed out true, quick true');
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : 'none');
  if (process.platform === 'win32') {
    expect([read('parent.txt'), read('parent.txt.child')]).toEqual(['none', 'none']);
  } else {
    expect([read('parent.txt'), read('parent.txt.child')]).toEqual(['stopped', 'stopped']);
  }
}, 180_000);

test('the fake records both options; env.pid is 1000 until setPid', () => {
  const r = cli(
    'test',
    `module m

import "exec"

fn job() -> Result<exec.Output, exec.ExecError> uses exec {
  return exec.output(exec.withStop(exec.withOwnGroup(exec.command("sh", ["-c", "run"])), .Interrupt, 500))
}

test "options as given" {
  exec.script("sh", [], 0)
  assert job().isOk()
  let cmd = exec.ran()[0] ?? exec.command("", [])
  assert cmd.ownGroup
  assert cmd.stop == exec.Stop { signal: .Interrupt, graceMs: 500 }
  assert !exec.command("sh", []).ownGroup && exec.command("sh", []).stop == none
}

test "pid" {
  assert env.pid() == 1000
  env.setPid(1)
  assert env.pid() == 1
}
`,
  );
  expect(r.stdout + r.stderr).toContain('2 passed, 0 failed');
}, 180_000);
