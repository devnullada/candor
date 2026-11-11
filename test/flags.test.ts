import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { lex } from '../src/lexer';

// `flags.parse(args, defaults)` reads a command line into a struct of options, by
// Go's flag rules; the usage comes from the struct's and fields' comments. `time.Duration` with it.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

function files(name: string, src: Record<string, string>) {
  const dir = path.join(tmpdir(), 'candor-test', 'flags', name);
  mkdirSync(dir, { recursive: true });
  for (const [f, s] of Object.entries(src)) writeFileSync(path.join(dir, f), s);
  return dir;
}

// The program's own arguments, after `--`, stay last.
function candor(dir: string, ...args: string[]) {
  const cut = args.includes('--') ? args.indexOf('--') : args.length;
  return spawnSync(process.execPath, ['run', cli, ...args.slice(0, cut), '--out', path.join(dir, 'out'), ...args.slice(cut)], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });
}

const app = `module app

import "flags"
import "time"

// Usage: load [options...] <url>
struct Options {
  // Number of requests to run.
  n: int
  // A header to send; repeat it
  // for more.
  headers: List<string> as "H"
  // Stop after this long.
  z: time.Duration
  rate: float
  disableCompression: bool
  // Write the report to \`file\`.
  out: string?
  method: string as "m"
}

fn defaults() -> Options {
  return Options { n: 200, headers: [], z: time.Duration { ms: 0 }, rate: 0.0, disableCompression: false, out: none, method: "GET" }
}

fn main() -> Result<void, Exit> uses io, env {
  let (o, rest) = flags.parse(env.args(), defaults())?
  io.println("n=\${o.n} H=\${o.headers} z=\${o.z} out=\${o.out ?? "-"} m=\${o.method} rest=\${rest}")
  return Ok()
}
`;

const tests = `module app

fn parsed(args: List<string>) -> Options {
  return match flags.parse(args, defaults()) {
    Ok((o, _)) => o,
    Err(e) => Options { ...defaults(), method: "failed \${e.status}" },
  }
}

fn rest(args: List<string>) -> List<string> {
  return match flags.parse(args, defaults()) {
    Ok((_, r)) => r,
    Err(_) => ["failed"],
  }
}

fn failure(args: List<string>) -> string {
  return match flags.parse(args, defaults()) {
    Ok(_) => "",
    Err(e) => e.message.lines()[0] ?? "",
  }
}

test "the defaults stand when no flag is given" {
  assert parsed([]) == defaults()
  assert rest(["a", "b"]) == ["a", "b"]
}

test "each kind is read as Go reads it" {
  let o = parsed(["-n", "5", "--rate=2.5", "-z", "1m30s", "-disable-compression", "-out", "r.csv", "-m=POST"])
  assert o.n == 5 && o.rate == 2.5 && o.z.ms == 90_000 && o.disableCompression
  assert o.out == "r.csv" && o.method == "POST"
  assert parsed(["-n", "0x10"]).n == 16
  assert parsed(["-disable-compression=false"]).disableCompression == false
}

test "a repeated flag adds to its list, and the first replaces the default" {
  assert parsed(["-H", "a: 1", "-H=b: 2"]).headers == ["a: 1", "b: 2"]
  let given = flags.parse(["-H", "c"], Options { ...defaults(), headers: ["x"] })
  assert given.isOk()
}

test "flags end at the first argument that isn't one, or at --" {
  assert rest(["-n", "1", "url", "-n", "2"]) == ["url", "-n", "2"]
  assert rest(["--", "-n"]) == ["-n"]
  assert rest(["-"]) == ["-"]
  assert rest(["-disable-compression", "false"]) == ["false"]
}

test "a mistake is exit 2 with Go's message, then the usage" {
  assert parsed(["-x"]).method == "failed 2"
  assert failure(["-x"]) == "flag provided but not defined: -x"
  assert failure(["-n", "many"]) == "invalid value \\"many\\" for flag -n: parse error"
  assert failure(["-n", "99999999999999999999"]) == "invalid value \\"99999999999999999999\\" for flag -n: value out of range"
  assert failure(["-z", "10"]) == "invalid value \\"10\\" for flag -z: parse error"
  assert failure(["-disable-compression=maybe"]) == "invalid boolean value \\"maybe\\" for -disable-compression: parse error"
  assert failure(["-n"]) == "flag needs an argument: -n"
  assert failure(["---n"]) == "bad flag syntax: ---n"
}

test "-h is the usage and status 0" {
  let r = flags.parse(["-h"], defaults())
  let usage = [
    "Usage: load [options...] <url>",
    "  -H string",
    "    \\tA header to send; repeat it for more.",
    "  -disable-compression",
    "    \\t",
    "  -m string",
    "    \\t (default \\"GET\\")",
    "  -n int",
    "    \\tNumber of requests to run. (default 200)",
    "  -out file",
    "    \\tWrite the report to file.",
    "  -rate float",
    "    \\t",
    "  -z duration",
    "    \\tStop after this long.",
  ]
  assert r == Err(Exit { status: 0, message: usage.join("\\n") })
}

test "a duration is read and written as Go does" {
  assert time.parseDuration("1h2m3.5s") == Ok(time.Duration { ms: 3_723_500 })
  assert time.parseDuration("10").isErr()
  assert "\${time.Duration { ms: 1500 }}" == "1.5s"
  assert "\${time.Duration { ms: 0 }}" == "0s"
  assert "\${time.Duration { ms: 250 }}" == "250ms"
}
`;

test('flags.parse reads Go-style flags into the struct, in tests', () => {
  const dir = files('sim', { 'app.candor': app, 'app_test.candor': tests });
  const r = candor(dir, 'test', path.join(dir, 'app.candor'));
  expect(r.stdout + r.stderr).toContain('7 passed, 0 failed');
}, 120_000);

test('a run: flags parsed, a mistake exits 2 with the usage, -help exits 0', () => {
  const dir = files('run', { 'app.candor': app });
  const main = path.join(dir, 'app.candor');
  const ok = candor(dir, 'run', main, '--', '-n', '3', '-H', 'a: b', '-z', '2s', 'http://x');
  expect(ok.stderr).toBe('');
  expect(ok.stdout).toBe('n=3 H=["a: b"] z=2s out=- m=GET rest=["http://x"]\n');
  const bad = candor(dir, 'run', main, '--', '-q', '5');
  expect(bad.status).toBe(2);
  expect(bad.stderr).toStartWith('flag provided but not defined: -q\nUsage: load [options...] <url>\n  -H string\n');
  const help = candor(dir, 'run', main, '--', '-help');
  expect(help.status).toBe(0);
  expect(help.stderr).toContain('  -n int\n    \tNumber of requests to run. (default 200)\n');
}, 120_000);

const errors = (decls: string, call: string) =>
  compile(`module m\n\nimport "flags"\nimport "time"\n\n${decls}\n\nfn main() -> Result<void, Exit> uses env {\n  ${call}\n  return Ok()\n}\n`, 'm.candor')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => d.message);

test('the struct and its fields must each be something a flag reads', () => {
  const parse = 'let (o, _) = flags.parse(env.args(), O { a: [] })?';
  expect(errors('struct O {\n  a: List<string> as "A"\n}', parse)).toEqual([]);
  expect(errors('', 'let (o, _) = flags.parse(env.args(), 3)?')).toEqual(['`flags.parse` reads flags into a struct\'s fields, and was given `int`']);
  expect(errors('struct O {\n  a: Map<string, int>\n}', 'let (o, _) = flags.parse(env.args(), O { a: [:] })?')).toEqual(['`O.a` is a Map<string, int>, which no flag reads']);
  expect(errors('struct O {\n  a: List<bool>\n}', parse)).toEqual(['`O.a` is a List<bool>, which no flag reads']);
  expect(errors('struct O {\n  dryRun: bool\n  b: bool as "dry-run"\n}', 'let (o, _) = flags.parse(env.args(), O { dryRun: false, b: false })?')).toEqual([
    '`O.dryRun` and `O.b` are both the flag `-dry-run`',
  ]);
  expect(errors('fn p<T>(d: T) -> Result<(T, List<string>), Exit> {\n  return flags.parse([], d)\n}', 'let x = 1')[0]).toContain('could be any type');
  // `as` without `impl Json` still names nothing for a struct no flags.parse reads.
  expect(errors('struct O {\n  a: int as "A"\n}', 'let x = O { a: 1 }')[0]).toContain('has no `impl Json`');
});

test('a comment directly above a token is its doc; a trailing one or one a blank line away is not', () => {
  const toks = lex('// one\n// two\nstruct S {\n  a: int // after\n\n  // gone\n\n  b: int\n}\n', 's.candor').filter((t) => t.kind !== 'newline');
  expect(toks.find((t) => t.text === 'struct')!.doc).toBe('one\ntwo');
  expect(toks.find((t) => t.text === 'b')!.doc).toBeUndefined();
  expect(toks.find((t) => t.text === 'a')!.doc).toBeUndefined();
});
