import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { antivirusHelp, blockedBuild } from '../src/go';

// Windows antivirus can block a binary while Go writes it, remove it after, or stop it starting.
// A stand-in for go does each, since Defender can't be asked to. Each failure must say what
// happened: these ended in silence, a stack trace, or "this is a compiler bug".

const realGo = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');
const dir = mkdtempSync(path.join(tmpdir(), 'candor-blocked-'));
const fake = path.join(dir, process.platform === 'win32' ? 'fakego.exe' : 'fakego');
const virus = 'open C:\\Temp\\go-build1\\b001\\exe\\a.out.exe: Operation did not complete successfully because the file contains a virus or potentially unwanted software.';

const fakeGo = `package main

import (
	"fmt"
	"os"
	"os/exec"
)

func real(args []string) int {
	c := exec.Command(os.Getenv("REAL_GO"), args...)
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			return e.ExitCode()
		}
		return 1
	}
	return 0
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] != "build" {
		os.Exit(real(args))
	}
	out := ""
	for i, a := range args {
		if a == "-o" {
			out = args[i+1]
		}
	}
	switch os.Getenv("FAKE_GO_MODE") {
	case "virus":
		fmt.Fprintln(os.Stderr, ${JSON.stringify(virus)})
		os.Exit(1)
	case "missing":
		code := real(args)
		os.Remove(out)
		os.Exit(code)
	case "unstartable":
		code := real(args)
		// Not a program, so it can't start; on no system does this look like a usable binary.
		os.WriteFile(out, []byte("not a program"), 0o644)
		os.Exit(code)
	}
	os.Exit(real(args))
}
`;

beforeAll(() => {
  writeFileSync(path.join(dir, 'main.go'), fakeGo);
  const built = spawnSync(realGo, ['build', '-o', fake, 'main.go'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GO111MODULE: 'off' } });
  if (built.status !== 0) throw new Error(built.stderr);
  mkdirSync(path.join(dir, 'p'));
  writeFileSync(path.join(dir, 'p', 'quick.candor'), 'module quick\n\nfn main() uses io {\n  io.println("started")\n}\n');
  writeFileSync(path.join(dir, 'p', 'lib.candor'), 'module lib\n\npub fn one() -> int {\n  return 1\n}\n');
  writeFileSync(path.join(dir, 'p', 'lib_test.candor'), 'module lib\n\ntest "one" {\n  assert one() == 1\n}\n');
}, 300_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const candor = (mode: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--no-env-file', 'run', cli, ...args], {
    cwd: path.join(dir, 'p'),
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: fake, REAL_GO: realGo, FAKE_GO_MODE: mode, CANDOR_CACHE: path.join(dir, `cache-${mode}`) },
  });

const help = antivirusHelp();

test('the antivirus help is for Windows only', () => {
  expect(antivirusHelp('win32')).toContain('antivirus');
  expect(antivirusHelp('linux')).toBe('');
  expect(antivirusHelp('darwin')).toBe('');
});

test('a blocked build is told from a real build error', () => {
  expect(blockedBuild(virus, 'win32')).toBe('blocked');
  expect(blockedBuild('open C:\\a\\b\\a.out.exe: Access is denied.', 'win32')).toBe('maybe');
  expect(blockedBuild('rename C:\\a\\a.exe C:\\a\\b.exe: The system cannot find the file specified.', 'win32')).toBe('maybe');
  expect(blockedBuild('app.candor:3: undefined: x', 'win32')).toBe(null);
  expect(blockedBuild('open C:\\a\\go.mod: Access is denied.', 'win32')).toBe(null);
  expect(blockedBuild(virus, 'linux')).toBe(null);
});

for (const command of ['run', 'test']) {
  const file = command === 'run' ? 'quick.candor' : 'lib.candor';

  test(`${command}: a binary removed after the build says so, with no stack trace`, () => {
    const r = candor('missing', command, file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("go build succeeded, but the binary isn't there");
    expect(r.stderr).toContain(help);
    expect(r.stderr).not.toContain('at build');
  }, 120_000);

  test(`${command}: a binary that can't start says so`, () => {
    const r = candor('unstartable', command, file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('candor: cannot start ');
    expect(r.stderr).toContain(help);
  }, 120_000);
}

test.if(process.platform === 'win32')('a build Windows blocked says so, and not that the compiler is at fault', () => {
  const r = candor('virus', 'run', 'quick.candor');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('Windows blocked the binary');
  expect(r.stderr).toContain(help);
  expect(r.stderr).not.toContain('compiler bug');
}, 120_000);

test('off Windows, or for anything else, a failed build keeps its message', () => {
  if (process.platform === 'win32') return;
  const r = candor('virus', 'run', 'quick.candor');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('compiler bug');
}, 120_000);

test('a test binary that never started is not counted as a file that ran', () => {
  const r = candor('unstartable', 'test', '.');
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('in 0 files');
}, 120_000);

test('a binary that runs is unaffected', () => {
  const run = candor('ok', 'run', 'quick.candor');
  expect(run.stderr).toBe('');
  expect(run.stdout).toContain('started');
  const tests = candor('ok', 'test', 'lib.candor');
  expect(tests.status).toBe(0);
  expect(tests.stdout).toContain('1 passed');
}, 120_000);
