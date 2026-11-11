import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `main` may return `Result<void, E>`; an `Err` is printed on stderr
// and the status is 1. `io.eprintln` writes to stderr.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function run(name: string, src: string, ...args: string[]) {
  const dir = path.join(tmpdir(), 'candor-test', 'main-result', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeFileSync(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'run', file, '--out', path.join(dir, 'out'), '--', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const program = `module m

fn need(args: List<string>, n: int) -> Result<string, string> {
  match args[n] {
    none => return Err("usage: m <file> <mode>")
    arg => return Ok(arg)
  }
}

fn main() -> Result<void, string> uses io, env {
  let args = env.args()
  io.println("start")
  io.eprintln("checking \${args.length()} args")
  let file = need(args, 0)?
  let mode = need(args, 1)?
  io.println("\${file} \${mode}")
  return Ok()
}
`;

test('an Err from main is printed on stderr, with status 1', () => {
  const r = run('err', program);
  expect(r.stdout).toBe('start\n');
  expect(r.stderr).toBe('checking 0 args\nusage: m <file> <mode>\n');
  expect(r.status).toBe(1);
}, 60_000);

test('Ok from main is status 0', () => {
  const r = run('ok', program, 'a.log', 'fast');
  expect(r.stdout).toBe('start\na.log fast\n');
  expect(r.stderr).toBe('checking 2 args\n');
  expect(r.status).toBe(0);
}, 60_000);

test('an error that is not a string is shown as tests show it', () => {
  const src = 'module m\n\nenum Problem {\n  Missing { name: string }\n  Bad\n}\n\nfn main() -> Result<void, Problem> {\n  return Err(Problem.Missing { name: "x" })\n}\n';
  const r = run('enum', src);
  expect(r.stderr).toBe('Problem.Missing { name: "x" }\n');
  expect(r.status).toBe(1);
}, 60_000);

test('main returning anything else is refused, and the help names the Result form', () => {
  const d = compile('module m\nfn main() -> int {\n  return 1\n}\n', 't').diagnostics[0];
  expect(d.code).toBe('CAN0010');
  expect(d.help).toContain('fn main() -> Result<void, E>');
  expect(compile('module m\nfn main() -> Result<int, string> {\n  return Ok(1)\n}\n', 't').diagnostics[0].code).toBe('CAN0010');
  const tried = compile('module m\nfn f() -> Result<int, string> {\n  return Ok(1)\n}\nfn main() uses io {\n  io.println(f()?.toString())\n}\n', 't').diagnostics[0];
  expect(tried.code).toBe('CAN0033');
  expect(tried.help).toContain('return `Result<void, string>` (an `Err` from `main` is printed on stderr and exits with status 1; `Result<void, Exit>` picks the status)');
});

// `Result<void, Exit>` picks the status; `Exit` is built in, no import.
const usage = `module m

fn parse(args: List<string>) -> Result<string, Exit> {
  match args[0] {
    none => return Err(Exit { status: 2, message: "usage: m <name>" })
    "-h" => return Err(Exit { status: 0, message: "usage: m <name>\\n" })
    name => return Ok(name)
  }
}

fn main() -> Result<void, Exit> uses io, env {
  let name = parse(env.args())?
  io.println("hello \${name}")
  return Ok()
}
`;

test('an Err(Exit) from main exits with its status, its message on stderr', () => {
  const r = run('exit', usage);
  expect(r.stderr).toBe('usage: m <name>\n');
  expect(r.status).toBe(2);
  const help = run('exit-help', usage, '-h');
  expect(help.stderr).toBe('usage: m <name>\n');
  expect(help.status).toBe(0);
  expect(run('exit-ok', usage, 'ada').stdout).toBe('hello ada\n');
}, 60_000);

test('a status outside 0 to 125 exits 1 and says so', () => {
  const r = run('exit-range', 'module m\n\nfn main() -> Result<void, Exit> {\n  return Err(Exit { status: 300, message: "" })\n}\n');
  expect(r.stderr).toBe('exit status 300 is outside 0 to 125; exiting with 1\n');
  expect(r.status).toBe(1);
}, 60_000);

test("a test sees an Exit as a value, and a module's own Exit hides the built-in one", () => {
  const tests = 'module m\n\ntest "usage" {\n  assert parse([]) == Err(Exit { status: 2, message: "usage: m <name>" })\n  assert parse(["ada"]) == Ok("ada")\n}\n';
  const tested = compile(usage, 'dir/m.candor', 'test', { read: (f) => (f === 'dir/m_test.candor' ? tests : null) });
  expect(tested.diagnostics).toEqual([]);
  const own = 'module m\n\nstruct Exit {\n  code: int\n}\n\nfn main() -> Result<void, Exit> {\n  return Err(Exit { code: 3 })\n}\n';
  expect(compile(own, 't').diagnostics).toEqual([]);
  const r = run('exit-own', own);
  expect(r.stderr).toBe('Exit { code: 3 }\n');
  expect(r.status).toBe(1);
}, 60_000);
