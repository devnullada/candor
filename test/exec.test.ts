import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// A line keeps its ending, so `exec.output` gives what was printed, and `combined` both
// streams in order; `exec.scriptSlow` takes test time, for a timeout's test.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'exec');

function cli(cmd: 'run' | 'test', src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// Prints a CRLF line, a line on stderr, and a last line with no ending, in that order.
const printer = `package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	fmt.Print("one\\r\\n")
	time.Sleep(200 * time.Millisecond)
	fmt.Fprint(os.Stderr, "two\\n")
	time.Sleep(200 * time.Millisecond)
	fmt.Print("three")
}
`;

test('output as printed: endings kept, both streams combined in order', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'printer.go'), printer);
  const r = cli(
    'run',
    `module m

import "exec"

fn main() -> Result<void, exec.ExecError> uses io, exec {
  let out = exec.output(exec.command(${JSON.stringify(go)}, ["run", "printer.go"]))?
  io.println(json(out.stdout))
  io.println(json(out.stderr))
  io.println(json(out.combined))
  return Ok()
}

fn json(s: string) -> string {
  return s.replaceAll("\\r", "\\\\r").replaceAll("\\n", "\\\\n")
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n')).toEqual(['one\\r\\nthree', 'two\\n', 'one\\r\\ntwo\\nthree']);
}, 180_000);

test('in a test: a last line without an ending, and a slow program timed out', () => {
  const r = cli(
    'test',
    `module m

import "exec"

fn build() -> Result<exec.Output, exec.ExecError> uses exec {
  return exec.output(exec.command("make", []))
}

test "what the script printed, as printed" {
  exec.script("make", [exec.out("ok"), exec.err("warn"), exec.Line { text: "done", fromStderr: false, ending: "" }], 0)
  assert build().map((o) => o.combined) == Ok("ok\\nwarn\\ndone")
  assert build().map((o) => o.stdout) == Ok("ok\\ndone")
}

test "a slow program, timed out" {
  exec.scriptSlow("make", [exec.out("compiling")], 0, 1000)
  assert tasks.timeout(1500, () => build()) == none
  let started = clock.now()
  assert tasks.timeout(5000, () => build()).map((r) => r.map((o) => o.stdout)) == Ok("compiling\\n")
  assert clock.now() - started == 2000
}
`,
  );
  expect(r.stdout + r.stderr).toContain('2 passed, 0 failed');
}, 180_000);

// `withArgv0` tells the program the name it was run as.
test('argv0: the name the program is told', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'argv.go'), 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Println(os.Args[0] + " " + os.Args[1])\n}\n');
  const exe = path.join(dir, process.platform === 'win32' ? 'argv.exe' : 'argv');
  expect(spawnSync(go, ['build', '-o', exe, 'argv.go'], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
  const r = cli(
    'run',
    `module m

import "exec"

fn main() -> Result<void, exec.ExecError> uses io, exec {
  let cmd = exec.command(${JSON.stringify(exe)}, ["x"])
  io.print((exec.output(exec.withArgv0(cmd, "hookecho"))?).stdout)
  io.print((exec.output(cmd)?).stdout)
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.split('\n')).toEqual(['hookecho x', `${exe} x`, '']);
}, 180_000);
