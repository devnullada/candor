#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkExterns, draft } from './bind';
import type { TestDecl } from './ast';
import { compile, mainFileOf, testFileOf, type CompileResult } from './compile';
import { formatHuman, type Diagnostic } from './diagnostics';
import { effectListing, formatEffects, formatEffectsJson, sortEntries, type EffectEntry } from './effect-listing';
import { findGo, goBuild, goPackages, noGo, prepareModule, scratchModule, targets } from './go';
import { guide, init } from './guide';
import { buildDir, lockBuild, version } from './home';
import { outline } from './outline';
import { doc } from './reference';

const USAGE = `candor: a backend language for AI coders

usage:
  candor init [dir]            start a project: main.candor, and AGENTS.md telling a coding
                               agent how to learn Candor (CLAUDE.md imports it)
  candor guide                 the language on one page, for an agent: read it before
                               writing or changing Candor
  candor guide service         a whole service (HTTP, JSON, SQLite), to start a new one from
  candor guide more            the rest of it: concurrency, tests, the standard modules
  candor guide start           the long guide, with two whole services
  candor run <file.candor> [-- args...]
                               compile and run; what follows -- is the program's
                               (env.args())
  candor build <file.candor>   compile to a native binary, beside the file and named for
                               its module (-o to name it); --target linux-x64 builds one
                               for another system
  candor debug <file.candor> [-- args...]
                               build without optimizing and run it under Delve (dlv):
                               \`break app.candor:12\`, \`continue\`, \`print total\`
  candor test <file.candor>    run its tests, in <file>_test.candor beside it;
                               <file>_test.candor:42 runs the one holding line 42
  candor test [files or dirs]  every module with tests among them (none: under the
                               current directory), one total at the end
  candor check <file.candor>   type-check only; several files or dirs (none: the current
                               one) check each .candor file under them
  candor emit <file.candor>    print the generated Go
  candor outline [files or dirs]
                               each file's declarations and signatures with their line
                               ranges, no bodies; tests counted (--tests lists them).
                               Read it before reading a file, then read the lines you need
  candor effects [files or dirs]
                               each pub function's effects, sorted, with file and line;
                               --full adds private ones, --json for a tool. Diffs show when
                               a module's reach changes
  candor bind <go package>     print a draft binding for a Go package, as in
                               github.com/dustin/go-humanize@v1.0.1 (or @latest), or strconv
  candor doc [name]            the methods of a built-in type or effect (candor doc string),
                               or every method of a name (candor doc split); no name lists
                               them. All of it: docs/reference.md
  candor version               the version, and the Go it builds with

options:
  --json        diagnostics as JSON (on stderr, like the human form); for test, a JSON line
                per test as it ends, then one with the totals
  --out <dir>   build directory, binary included (default: one per module under
                ~/.candor/cache, CANDOR_CACHE to move it; unused for 30 days, it goes)
  -o <file>     for build: the binary's path
  --seed <n>    for test: the task order to replay (a failing run prints its seed)
  --runs <n>    for test: the task orders to try in a test that starts tasks (default 100;
                1 with --seed), stopping at the first failure
  --only <text> for test: run the tests whose name contains the text (repeatable)
  --tests       for outline: list each test and test fn
  --full        for outline: every function's signature (otherwise private ones by name);
                for effects: private functions too
  --name <m>    for bind: the module's name (default: the Go package's)
  --init <file> for debug: Delve commands to run first, one per line
  --target <t>  for build: the system to build for, one of windows-x64, windows-arm64,
                linux-x64, linux-arm64, darwin-x64, darwin-arm64 (named without .exe off
                Windows; cgo off)
`;

const commands = ['run', 'build', 'debug', 'test', 'check', 'emit', 'bind', 'doc', 'version', 'guide', 'init', 'outline', 'effects'] as const;

interface Args {
  command: (typeof commands)[number];
  file: string;
  json: boolean;
  /** For test: `file.candor:42`, the line whose test to run. */
  line: number | null;
  /** The file named was the module's test file, so `line` is one of its lines. */
  inTests?: boolean;
  out: string | null;
  /** Card 162: for build, `-o`: the binary's path. */
  exe: string | null;
  seed: string | null;
  runs: string | null;
  only: string[];
  name: string | null;
  /** For debug: a file of Delve commands. */
  init: string | null;
  /** Card 157: for build, the system to build for (a key of `targets`). */
  target: string | null;
  /** For run: what follows `--`, passed to the program untouched. */
  rest: string[];
  /** Card #917237b1: for outline, `--tests`. */
  tests: boolean;
  /** Card #7de8b2de: for outline, `--full`: every function's signature, not only pub ones'. */
  full: boolean;
  /** Card 145: for test and check, the files to go through one by one; null for one file named. */
  files: string[] | null;
}

/** Card 145: what the test files of one `candor test` gave, for the total. */
interface Tally {
  passed: number;
  failed: number;
  filtered: number;
  /** Files whose tests ran: a `test "` inside a string isn't a test. */
  files: number;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args) return 2;
  if (args.command === 'outline') return outlines(args.files ?? [args.file], args.tests, args.full);
  if (args.command === 'effects') return effects(args.files ?? [args.file], args.full, args.json);
  if (args.files) return many(args, args.files);
  return one(args);
}

/**
 * Card 145: `candor test` or `check` over several files, or the `.candor` files under folders.
 * A test file is one with a `test "..."` block; each builds and runs on its own, and the
 * totals come last.
 */
function many(args: Args, files: string[]): number {
  const testing = args.command === 'test';
  const picked = testing ? files.filter((f) => hasTests(f, args.only)) : files;
  if (picked.length === 0) {
    const what = testing ? (args.only.length > 0 ? 'no tests matching --only' : 'no tests') : 'no .candor files';
    if (args.json && testing) console.log(JSON.stringify({ type: 'total', files: 0, passed: 0, failed: 0, filtered: 0 }));
    else console.log(`${what} in ${files.length === 0 ? 'these folders' : `${files.length} file${files.length === 1 ? '' : 's'}`}`);
    return 0;
  }
  const tally: Tally = { passed: 0, failed: 0, filtered: 0, files: 0 };
  const failing: string[] = [];
  for (const file of picked) {
    // A check's diagnostics carry their file; a test's PASS lines don't.
    if (!args.json && testing) console.log(`== ${file}`);
    const status = one({ ...args, file, files: null }, tally);
    if (status !== 0) failing.push(file);
  }
  if (testing) {
    if (args.json) {
      console.log(JSON.stringify({ type: 'total', files: tally.files, passed: tally.passed, failed: tally.failed, filtered: tally.filtered }));
    } else {
      const filtered = tally.filtered > 0 ? `, ${tally.filtered} filtered out` : '';
      console.log(`\ntotal: ${tally.passed} passed, ${tally.failed} failed${filtered}, in ${tally.files} file${tally.files === 1 ? '' : 's'}`);
      // A file fails with a failing test, or when it doesn't compile or build.
      if (failing.length > 0) console.log(`failed: ${failing.join(', ')}`);
    }
  } else if (!args.json) {
    console.log(failing.length === 0 ? `checked ${picked.length} files: no errors` : `checked ${picked.length} files; errors in ${failing.join(', ')}`);
  }
  return failing.length > 0 ? 1 : 0;
}

/** Card #917237b1: `candor outline`, each file's in turn. */
function outlines(files: string[], tests: boolean, full: boolean): number {
  if (files.length === 0) console.log('no .candor files in these folders');
  let status = 0;
  for (const [i, file] of files.entries()) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      console.error(`candor: cannot read ${file}`);
      status = 1;
      continue;
    }
    process.stdout.write((i > 0 ? '\n' : '') + outline(source, file, tests, full));
    // #240e482c: where the module's tests are, unless that file is outlined too.
    const own = testFileOf(file);
    if (own && existsSync(own) && !files.some((f) => path.resolve(f) === path.resolve(own))) {
      const count = [...readFileSync(own, 'utf8').matchAll(/^test\s+"/gm)].length;
      console.log(`${count} test${count === 1 ? '' : 's'} in ${own} (\`candor outline ${own}\` lists them)`);
    }
  }
  return status;
}

/**
 * Card #b64daaed: `candor effects`. Paths are relative with forward slashes, so a listing reads
 * the same on every system. All or nothing: a listing missing a broken file would look like that
 * file's functions had gone.
 */
function effects(files: string[], full: boolean, json: boolean): number {
  const entries: EffectEntry[] = [];
  const shown = (f: string) => path.relative(process.cwd(), f).replaceAll('\\', '/');
  let status = 0;
  for (const file of [...new Set(files.map(shown))]) {
    if (file.endsWith('_test.candor')) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      console.error(`candor: cannot read ${file}`);
      status = 1;
      continue;
    }
    const listing = effectListing(source, file, full);
    entries.push(...listing.entries);
    const errors = listing.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      status = 1;
      report(errors, new Map([[file, source]]), json);
    }
  }
  if (status !== 0) return status;
  const sorted = sortEntries(entries);
  process.stdout.write(json ? formatEffectsJson(sorted) : formatEffects(sorted));
  return 0;
}

/** Whether a file has a test block (one whose name has an `--only` text, when given). */
function hasTests(file: string, only: string[]): boolean {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return true;
  }
  // Its test file's (#240e482c); one left in the file itself still runs, to be refused.
  const tests = testFileOf(file);
  if (tests && existsSync(tests)) source += `\n${readFileSync(tests, 'utf8')}`;
  const names = [...source.matchAll(/^test\s+"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1]);
  return names.some((n) => only.length === 0 || only.some((o) => n.includes(o)));
}

/** The `.candor` files under `dir`, in order; not in folders starting with `.` (builds, git) or node_modules. */
function candorFiles(dir: string): string[] {
  const out: string[] = [];
  // By name without `.candor`, so x.candor comes before x_test.candor.
  const key = (n: string) => n.replace(/\.candor$/, '');
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => key(a.name).localeCompare(key(b.name)))) {
    const p = dir === '.' ? e.name : path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== 'node_modules') out.push(...candorFiles(p));
    } else if (e.name.endsWith('.candor')) {
      out.push(p);
    }
  }
  return out;
}

/** One file: compile it, and run, build, test or check it as the command says. `tally`: a test run of many files, counted. */
function one(args: Args, tally?: Tally): number {
  if (args.command === 'bind') return bind(args.file, args.name);
  if (args.command === 'guide') {
    process.stdout.write(guide(args.file === 'start' ? 'start' : args.file === 'more' ? 'more' : args.file === 'service' ? 'service' : 'agent'));
    return 0;
  }
  if (args.command === 'init') return init(args.file || '.');
  if (args.command === 'version') {
    const goBin = findGo();
    const go = goBin && spawnSync(goBin, ['version'], { encoding: 'utf8' }).stdout.trim();
    console.log(`candor ${version}`);
    console.log(go || noGo);
    return 0;
  }
  if (args.command === 'doc') {
    const found = doc(args.file || undefined);
    (found.ok ? process.stdout : process.stderr).write(found.text);
    return found.ok ? 0 : 1;
  }

  // #240e482c: a test file is its module's, so `candor test x_test.candor:12` is x.candor's test
  // on that line of the test file.
  const named = mainFileOf(args.file);
  if (named) {
    if (!existsSync(named)) {
      console.error(`candor: ${args.file} holds the tests of ${path.basename(named)}, which isn't there`);
      return 1;
    }
    args = { ...args, file: named, inTests: true };
  }

  let source: string;
  try {
    source = readFileSync(args.file, 'utf8');
  } catch {
    console.error(`candor: cannot read ${args.file}`);
    return 1;
  }

  const testing = args.command === 'test';
  // `check` compiles as `test` does, so a library without `main` checks clean.
  const result = compile(source, args.file, testing || args.command === 'check' ? 'test' : 'main');
  // Notes (a query not checked against the schema) are for `check`; the rest would only be noise.
  report(args.command === 'check' ? result.diagnostics : result.diagnostics.filter((d) => d.severity !== 'note'), result.sources, args.json);
  if (!result.go || !result.module) return 1;
  if (args.command === 'emit') {
    process.stdout.write(result.go);
    if (result.bindings) process.stdout.write(`\n// ---- bindings.go\n${result.bindings}`);
    return 0;
  }
  if (args.command === 'check' && result.externs.length === 0) return 0;

  const goBin = findGo();
  if (!goBin) {
    console.error(noGo);
    return 1;
  }
  const outDir = args.out ?? buildDir(args.file, result.module.name + (testing ? '.test' : ''));
  // #a538dc9d: from preparing the folder to the built binary, one candor at a time per folder.
  const unlock = lockBuild(outDir);
  let built: ReturnType<typeof build>;
  try {
    built = build(goBin, result, outDir, args, testing);
  } finally {
    unlock();
  }
  if (typeof built === 'number') return built;
  return runBuilt(goBin, built.exe, built.lineTest, args, testing, tally);
}

/** Prepares the build folder, checks the bindings against Go, and builds: the binary, or the exit code. */
function build(goBin: string, result: CompileResult, outDir: string, args: Args, testing: boolean): { exe: string; lineTest: TestDecl | null } | number {
  const prepared = prepareModule(goBin, result, outDir);
  if (prepared) {
    console.error(prepared);
    return 1;
  }
  // Every binding against Go's own types, so a mismatch reads as a Candor error at the binding.
  if (result.externs.length > 0) {
    const packages = goPackages(goBin, outDir, result.externs.map((e) => e.importPath));
    if ('error' in packages) {
      console.error(packages.error);
      return 1;
    }
    const mismatches = checkExterns(result.externs, packages);
    report(mismatches, result.sources, args.json);
    if (mismatches.length > 0) return 1;
  }
  if (args.command === 'check') return 0;
  const tests = result.module!.decls.filter((d) => d.kind === 'TestDecl');
  if (testing && tests.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ type: 'summary', file: args.file, seed: null, passed: 0, failed: 0, filtered: 0 }));
    } else {
      console.log(`no tests in ${args.file}${result.testFile ? '' : ` (they go in ${path.basename(testFileOf(args.file) ?? '')})`}`);
    }
    return 0;
  }
  // `file.candor:42`: the test whose block holds line 42. Tests are in the test file, whose lines
  // the module numbers on from its own.
  const from = result.testFile?.from ?? 0;
  const line = args.line === null ? null : args.line + (args.inTests ? from : 0);
  const lineTest = line === null ? null : ((tests as TestDecl[]).find((t) => t.span.start.line <= line && line <= t.span.end.line) ?? null);
  if (args.line !== null && !lineTest) {
    const where = (l: number) => (result.testFile && l > from ? `${result.testFile.file}:${l - from}` : `${args.file}:${l}`);
    const listed = tests.map((t) => `  ${where(t.span.start.line)}  ${JSON.stringify(t.name)}`).join('\n');
    console.error(`candor: line ${args.line} of ${args.inTests ? result.testFile?.file : args.file} is in no test; the tests:\n${listed}`);
    return 1;
  }

  // Card 162: a built program goes beside its source (as `go build` does), the rest stays in the cache.
  const to: { dir: string } | { file: string } = args.exe ? { file: args.exe } : args.command === 'build' && !args.out ? { dir: path.dirname(args.file) } : { dir: outDir };
  const built = goBuild(goBin, result, result.module!.name, outDir, args.command === 'debug', args.target, to);
  if (!built) return 1;
  if (!testing) return { exe: built, lineTest };
  // A test binary is removed once it has run; under a name of its own, so that a test run of the
  // same file ending meanwhile can't remove this one.
  const exe = built.replace(/(\.exe)?$/, `.${process.pid}$1`);
  renameSync(built, exe);
  return { exe, lineTest };
}

function runBuilt(goBin: string, exe: string, lineTest: TestDecl | null, args: Args, testing: boolean, tally?: Tally): number {
  if (args.command === 'debug') return debug(goBin, exe, args);
  if (args.command === 'build') {
    console.log(exe);
    return 0;
  }
  const testArgs = [
    ...(args.seed ? ['-seed', args.seed] : []),
    ...(args.runs ? ['-runs', args.runs] : []),
    ...args.only.flatMap((o) => ['-only', o]),
    ...(lineTest ? ['-test', lineTest.name] : []),
    ...(args.json ? ['-json'] : []),
  ];
  // Card 145: in a run of many files, the summary is read for the total.
  const run = spawnSync(exe, testing ? testArgs : args.rest, { stdio: tally ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (tally) {
    tally.files++;
    const out = run.stdout ?? '';
    process.stdout.write(out);
    const summary = args.json
      ? out.split('\n').map((l) => (l.startsWith('{') ? JSON.parse(l) : null)).find((l) => l?.type === 'summary')
      : /^(?<passed>\d+) passed, (?<failed>\d+) failed(?:, (?<filtered>\d+) filtered out)?$/m.exec(out)?.groups;
    tally.passed += Number(summary?.passed ?? 0);
    tally.failed += Number(summary?.failed ?? 0);
    tally.filtered += Number(summary?.filtered ?? 0);
  }
  // Nothing runs a test binary again, and there is one per test file: 7-17 MB each.
  if (testing) {
    try {
      rmSync(exe, { force: true });
    } catch {
      // Still held by the OS; the next build overwrites it.
    }
  }
  return run.status ?? 1;
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let json = false;
  let tests = false;
  let full = false;
  let out: string | null = null;
  let exe: string | null = null;
  let seed: string | null = null;
  let runs: string | null = null;
  const only: string[] = [];
  let name: string | null = null;
  let init: string | null = null;
  let target: string | null = null;
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a === '--json') {
      json = true;
    } else if (a === '--tests') {
      tests = true;
    } else if (a === '--full') {
      full = true;
    } else if (a === '-o') {
      exe = argv[++i] ?? null;
      if (exe === null) return usageError('-o needs a file for the binary');
    } else if (a === '--out') {
      out = argv[++i] ?? null;
      if (out === null) return usageError('--out needs a directory');
    } else if (a === '--seed') {
      seed = argv[++i] ?? null;
      if (seed === null || !/^-?\d+$/.test(seed)) return usageError('--seed needs a number');
    } else if (a === '--runs') {
      runs = argv[++i] ?? null;
      if (runs === null || !/^[1-9]\d*$/.test(runs)) return usageError('--runs needs a count, like 500');
    } else if (a === '--only') {
      const text = argv[++i];
      if (text === undefined || text === '') return usageError('--only needs part of a test name');
      only.push(text);
    } else if (a === '--name') {
      name = argv[++i] ?? null;
      if (name === null || !/^[a-z][a-zA-Z0-9]*$/.test(name)) return usageError('--name needs a module name, like `humanize`');
    } else if (a === '--init') {
      init = argv[++i] ?? null;
      if (init === null) return usageError('--init needs a file of Delve commands');
    } else if (a === '--target') {
      target = argv[++i] ?? null;
      if (target === null || !(target in targets)) return usageError(`--target needs one of ${Object.keys(targets).join(', ')}`);
    } else if (a.startsWith('-')) {
      return usageError(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  const [command, file] = positional;
  const known = commands.find((c) => c === command);
  if (!known) return usageError(command ? `unknown command ${command}` : 'no command given');
  if (known === 'doc' || known === 'version' || known === 'guide' || known === 'init') return { command: known, file: file ?? '', json, line: null, out, exe, seed, runs, only, name, init, target, rest, tests, full, files: null };
  // Card 145: test and check take several files, folders, or none (the current folder).
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const named = positional.slice(1);
  if ((known === 'test' || known === 'check' || known === 'outline' || known === 'effects') && (named.length !== 1 || isDir(named[0]))) {
    if (out) return usageError(`--out is for one file; ${command} of several builds each on its own`);
    if (named.some((f) => /\.candor:\d+$/.test(f))) return usageError('`file:line` picks a test in one file; name that file alone');
    const missing = named.find((f) => !existsSync(f));
    if (missing) return usageError(`cannot find ${missing}`);
    const found = (named.length === 0 ? ['.'] : named).flatMap((f) => (isDir(f) ? candorFiles(f) : [f]));
    // #240e482c: a test file goes with its module, unless it has none (then it is refused).
    const own = (f: string) => {
      const main = known === 'outline' || known === 'effects' ? null : mainFileOf(f);
      return main && existsSync(main) ? main : f;
    };
    const files = [...new Set(found.map(own))];
    return { command: known, file: '', json, line: null, out, exe, seed, runs, only, name, init, target, rest, tests, full, files };
  }
  if (positional.length > 2) return usageError(`${command} takes one ${known === 'bind' ? 'Go package' : 'file'}; only test, check, outline and effects take several`);
  if (!file) return usageError(known === 'bind' ? 'bind needs a Go package' : `${command} needs a file`);
  // `app.candor:42` (not `C:\...`: the line is digits at the end).
  const at = /^(.*\.candor):(\d+)$/.exec(file);
  if (at && known !== 'test') return usageError(`${command} takes a file; \`file:line\` picks a test, for test`);
  if (at) return { command: known, file: at[1], json, line: Number(at[2]), out, exe, seed, runs, only, name, init, target, rest, tests, full, files: null };
  if (target && known !== 'build') return usageError(`--target is for build: ${command} runs the program here`);
  if (exe && known !== 'build') return usageError(`-o is for build: ${command} keeps its binary in the build directory`);
  if (rest.length > 0 && known !== 'run' && known !== 'debug') return usageError('only run and debug pass arguments to the program');
  return { command: known, file, json, line: null, out, exe, seed, runs, only, name, init, target, rest, tests, full, files: null };
}

/**
 * `candor debug`: the program under Delve. The `//line` directives put Candor's lines in the
 * binary, so breakpoints and stack traces use `.candor` lines, and locals keep their names.
 */
function debug(goBin: string, exe: string, args: Args): number {
  const dlv = findDlv(goBin);
  if (!dlv) {
    console.error('candor: Delve is not installed: `go install github.com/go-delve/delve/cmd/dlv@latest`, then try again');
    return 1;
  }
  const init = args.init ? ['--init', args.init, '--allow-non-terminal-interactive=true'] : [];
  const run = spawnSync(dlv, ['exec', exe, ...init, ...(args.rest.length > 0 ? ['--', ...args.rest] : [])], { stdio: 'inherit' });
  return run.status ?? 1;
}

/** dlv on the PATH, or where `go install` puts it. */
function findDlv(goBin: string): string | null {
  const name = process.platform === 'win32' ? 'dlv.exe' : 'dlv';
  const onPath = spawnSync(name, ['version'], { encoding: 'utf8' });
  if (onPath.status === 0) return name;
  const gopath = spawnSync(goBin, ['env', 'GOPATH'], { encoding: 'utf8' }).stdout?.trim();
  const installed = gopath ? path.join(gopath, 'bin', name) : null;
  return installed && existsSync(installed) ? installed : null;
}

function usageError(message: string): null {
  console.error(`candor: ${message}\n\n${USAGE}`);
  return null;
}

function report(diagnostics: Diagnostic[], sources: Map<string, string>, json: boolean) {
  if (diagnostics.length === 0) return;
  if (json) {
    console.error(JSON.stringify({ diagnostics }, null, 2));
    return;
  }
  for (const d of diagnostics) console.error(formatHuman(d, sources.get(d.file) ?? '') + '\n');
  const count = (s: Diagnostic['severity']) => diagnostics.filter((d) => d.severity === s).length;
  const [errors, warnings, notes] = [count('error'), count('warning'), count('note')];
  const parts = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  console.error(`candor: ${parts.join(', ')}`);
}

/** `candor bind <spec>`: a draft binding for a Go package, on stdout. */
function bind(spec: string, name: string | null): number {
  const goBin = findGo();
  if (!goBin) {
    console.error(noGo);
    return 1;
  }
  const scratch = scratchModule(goBin, path.join(tmpdir(), 'candor-bind'), spec);
  if ('error' in scratch) {
    console.error(scratch.error);
    return 1;
  }
  const std = !scratch.goPath.split('/')[0].includes('.');
  if (!std && !scratch.version) {
    console.error(`candor: name a version, as in ${spec}@latest or ${spec}@v1.2.3: a binding is written against one`);
    return 1;
  }
  const packages = goPackages(goBin, scratch.dir, [scratch.goPath], { docs: true });
  if ('error' in packages) {
    console.error(packages.error);
    return 1;
  }
  const pkg = packages.get(scratch.goPath);
  if (!pkg || pkg.errors.length > 0) {
    console.error(`candor: cannot load the Go package ${scratch.goPath}${pkg ? `: ${pkg.errors.join('; ')}` : ''}`);
    return 1;
  }
  const module = name ?? pkg.name;
  if (!/^[a-z][a-zA-Z0-9]*$/.test(module)) {
    console.error(`candor: the Go package is named ${pkg.name}, which isn't a Candor module name; pass --name`);
    return 1;
  }
  process.stdout.write(draft(pkg, { module, goPath: scratch.goPath, version: scratch.version }));
  return 0;
}

process.exit(main(process.argv.slice(2)));
