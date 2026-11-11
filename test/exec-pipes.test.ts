import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// A program's stdin and stdout as a writer and a reader. `exec.reading(cmd, read)`
// reads stdout; `exec.piping(cmd, feed, read)` also writes stdin from a task of its own, so a
// full pipe can't deadlock it. stderr is kept and given with the exit code.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'exec-pipes');

function cli(cmd: 'run' | 'test', src: string) {
  writeModule(path.join(dir, 'm.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 'm.candor', '--out', path.join(dir, `out-${cmd}`)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 200_000,
  });
}

// upper: stdin to stdout uppercased as it reads, "done" on stderr, exit 3. forever: prints until
// its stdout breaks. quit: ends without reading stdin. sleep: waits 30 s.
const helper = `package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"time"
)

func main() {
	switch os.Args[1] {
	case "upper":
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				os.Stdout.Write(bytes.ToUpper(buf[:n]))
			}
			if err == io.EOF {
				break
			}
		}
		fmt.Fprintln(os.Stderr, "done")
		os.Exit(3)
	case "forever":
		for {
			if _, err := os.Stdout.Write([]byte("y\\n")); err != nil {
				os.Exit(0)
			}
		}
	case "quit":
		os.Exit(0)
	case "sleep":
		time.Sleep(30 * time.Second)
	}
}
`;

test('on the fake: stdout as pieces, stdin in ran(), stderr kept', () => {
  mkdirSync(dir, { recursive: true });
  const r = cli(
    'test',
    `module m

import "bytes"
import "exec"

fn upper(data: Bytes) -> Result<exec.Piped<Result<Bytes, string>>, exec.ExecError> uses exec, tasks {
  return exec.piping(exec.command("tr", ["a-z", "A-Z"]), (w) => w(data), (r) => bytes.readAll(r))
}

fn main() {}

test "piping: what was written is the command's stdin" {
  exec.script("tr", [exec.out("HELLO"), exec.err("warn"), exec.out("BYE")], 0)
  let got = upper("hello\\nbye\\n".toBytes())
  assert got.map((p) => p.value) == Ok(Ok("HELLO\\nBYE\\n".toBytes()))
  assert got.map((p) => p.stderr) == Ok("warn\\n")
  assert (exec.ran()[0] ?? exec.command("", [])).stdin == .Data { data: "hello\\nbye\\n".toBytes() }
}

test "reading: a read takes up to n bytes" {
  exec.script("cat", [exec.out("abcdef")], 3)
  let got = exec.reading(exec.command("cat", []), (r) => [r(4), r(4), r(4)])
  assert got.map((p) => p.code) == Ok(3)
  assert got.map((p) => p.value) == Ok([Ok("abcd".toBytes()), Ok("ef\\n".toBytes()), Ok(none)])
}

test "a feed's own Err is a failure; a program not found is NotFound" {
  exec.script("tr", [], 0)
  let failed = exec.piping(exec.command("tr", []), (w): Result<void, string> => Err("no data"), (r) => bytes.readAll(r))
  assert failed.map((p) => p.code) == Err(.Failed { message: "feeding the program's stdin: no data" })
  assert exec.reading(exec.command("nope", []), (r) => r(0)).map((p) => p.code) == Err(.NotFound { program: "nope" })
}
`,
  );
  expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
}, 240_000);

test('a real program: 4 MiB through a pipe, an early stop, a refused stdin, a cancel', () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'helper.go'), helper);
  const exe = path.join(dir, process.platform === 'win32' ? 'helper.exe' : 'helper');
  expect(spawnSync(go, ['build', '-o', exe, 'helper.go'], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
  const r = cli(
    'run',
    `module m

import "bytes"
import "exec"

const helper = ${JSON.stringify(exe)}

// 4 MiB written a piece at a time: far more than a pipe holds, so writing it all before
// reading would wait for ever.
fn feed(w: fn(Bytes) -> Result<void, string>) -> Result<void, string> uses w {
  let piece = "abcdefgh".repeat(8192).toBytes()
  for _ in 0..64 {
    w(piece)?
  }
  return Ok()
}

fn count(r: fn(int) -> Result<Bytes?, string>) -> Result<(int, bool), string> uses r {
  let mut n = 0
  let mut upper = true
  while true {
    match r(0)? {
      none => return Ok((n, upper)),
      b => {
        n = n + b.length()
        upper = upper && (b.slice(0, 1) == "A".toBytes())
      },
    }
  }
  return Ok((n, upper))
}

fn main() -> Result<void, exec.ExecError> uses io, exec, tasks, clock {
  let big = exec.piping(exec.command(helper, ["upper"]), (w) => feed(w), (r) => count(r))?
  io.println("upper: \${big.code} \${big.value.map((v) => v.0)} \${big.value.map((v) => v.1)} \${big.stderr.trim()}")
  let some = exec.reading(exec.command(helper, ["forever"]), (r) => r(4))?
  // A read gives what has come: "y\\n" or more, at most the 4 asked for.
  io.println("forever: \${some.value.map((b) => ((b ?? "".toBytes()).toText() ?? "").startsWith("y\\n") && (b ?? "".toBytes()).length() <= 4)}")
  let quit = exec.piping(exec.command(helper, ["quit"]), (w) => feed(w), (r) => bytes.readAll(r))?
  io.println("quit: \${quit.code} \${quit.value.map((b) => b.length())}")
  let started = clock.nanos()
  let slept = tasks.timeout(300, () => exec.reading(exec.command(helper, ["sleep"]), (r) => bytes.readAll(r)))
  io.println("sleep: \${slept == none} \${(clock.nanos() - started) / 1000000 < 5000}")
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.split('\n')).toEqual([`upper: 3 Ok(${4 << 20}) Ok(true) done`, 'forever: Ok(true)', 'quit: 0 Ok(0)', 'sleep: true true', '']);
}, 240_000);
