// The trial runner. An agent (headless Claude Code) writes an app from its spec in a fresh
// directory; then the app is built and the hidden acceptance tests run against it.
//
//   bun trials/run.ts <app> [--lang candor] [--agent claude] [--model ...] [--runs 1] [--budget 10] [--keep]
//   bun trials/run.ts accept <app> <dir> [--lang candor]      acceptance tests on a program's directory
//   bun trials/run.ts refs [app]                               every app's reference against its acceptance tests
//   bun trials/run.ts report                                   every run so far, as a table
//   bun trials/run.ts rescore <app>                            the acceptance tests again on every kept run
//   bun trials/run.ts recover <app> <dir>                      score a run whose agent finished but scoring didn't
//
// A run lands in trials/runs/<app>/<lang>/<stamp>/: the sources, the agent's log.md,
// result.json, and transcript.jsonl (ignored by git). The agent works in <tmp>/candor-trials
// (CANDOR_TRIALS_TMP), and its directory goes once the run is kept; --keep leaves it.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Agent, agentArg, holdForTurn, limitExit, limits, reading, reap, runAgent, stoppedByLimit } from './agent';

const trials = import.meta.dir;
const repo = path.dirname(trials);
const goBin = 'C:\\Program Files\\Go\\bin';
const env = { ...process.env, PATH: `${process.env.PATH}${path.delimiter}${goBin}` };
// Agents' directories and builds, off the system drive; each goes once its run is kept and scored.
const work = path.resolve(process.env.CANDOR_TRIALS_TMP ?? path.join(os.tmpdir(), 'candor-trials'));
const gone = (dir: string) => {
  reap(dir);
  rmSync(dir, { recursive: true, force: true });
};

interface Lang {
  name: string;
  /** The files the agent writes that are kept: names in its directory, or extensions (`.go`). */
  keep: string[];
  /** Fills the agent's directory with what it may read and the tools it may run. */
  setup(dir: string): void;
  /** Lines of the prompt that are this language's. */
  prompt: string[];
  /** A Bash command that builds, tests or runs the program: each match is one compiler run, named by its group. */
  compiler: RegExp;
  /** Builds the program in `dir` into `out`; gives the command that starts it, or the build's errors. */
  build(dir: string, out: string): { cmd: string[] } | { error: string };
}

function run(cmd: string[], cwd?: string): { error: string } | null {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, env, encoding: 'utf8' });
  return r.status === 0 ? null : { error: `${r.stdout}${r.stderr}${r.error ?? ''}` };
}

const candor: Lang = {
  name: 'candor',
  keep: ['.candor'],
  setup(dir) {
    cpSync(path.join(repo, 'README.md'), path.join(dir, 'README.md'));
    for (const doc of ['agent.md', 'agent-more.md', 'agent-service.md', 'start.md', 'reference.md', 'design.md']) cpSync(path.join(repo, 'docs', doc), path.join(dir, 'docs', doc));
    cpSync(path.join(repo, 'std'), path.join(dir, 'std'), { recursive: true });
    cpSync(path.join(repo, 'examples'), path.join(dir, 'examples'), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes('.candor'),
    });
    writeFileSync(path.join(dir, 'candor.cmd'), `@echo off\r\nbun run "${path.join(repo, 'src', 'cli.ts')}" %*\r\n`);
  },
  prompt: [
    'The language is Candor, which compiles to Go. It is new: you will not know it from training. Start with docs/agent.md: one page on the language, its tests and its standard modules. The rest is here: docs/start.md (the long guide, with two whole services; search it), README.md, docs/reference.md (the methods of built-in types and effects), docs/design.md (every design decision; long, so search it), std/ (the standard modules: http, json, sql) and examples/.',
    'Write the program in app.candor (with `main`), and its tests as `test` blocks in app_test.candor beside it (the same `module` line); other modules, if any, in .candor files next to it.',
    'The compiler: `./candor.cmd check|run|test|build app.candor` (README.md, "Usage").',
  ],
  compiler: /candor(?:\.cmd)?\s+(check|run|test|build|emit)/g,
  build(dir, out) {
    const r = spawnSync('bun', ['run', path.join(repo, 'src', 'cli.ts'), 'build', path.join(dir, 'app.candor'), '--out', out], { env, encoding: 'utf8' });
    if (r.status !== 0) return { error: `${r.stdout}${r.stderr}` };
    return { cmd: [r.stdout.trim().split('\n').at(-1)!.trim()] };
  },
};

const go: Lang = {
  name: 'go',
  keep: ['.go', 'go.mod', 'go.sum'],
  setup() {},
  prompt: [
    'The language is Go. Write the program as package main in main.go (other files of the package next to it), its tests in main_test.go, and a go.mod (module `app`).',
    'Use the standard library. For SQLite, use modernc.org/sqlite (pure Go: there is no C compiler here); `go get` works.',
    '`go` is on the PATH: `go build`, `go test`, `go run .`.',
  ],
  compiler: /\bgo\s+(build|test|run|vet)\b/g,
  build(dir, out) {
    const exe = path.join(out, 'app.exe');
    return run(['go', 'build', '-o', exe, '.'], dir) ?? { cmd: [exe] };
  },
};

const ts: Lang = {
  name: 'ts',
  keep: ['.ts'],
  setup() {},
  prompt: [
    'The language is TypeScript, run by Bun. Write the program in app.ts (the entry point) and its tests in app.test.ts (bun:test); other modules, if any, in .ts files next to them.',
    'Use only what Bun has built in (Bun.serve, bun:sqlite, ...): nothing to install.',
    '`bun app.ts` runs it, `bun test` tests it.',
  ],
  compiler: /\bbun\s+(test|run|build|app\.ts)\b/g,
  build(dir, out) {
    const source = path.join(dir, 'app.ts');
    return run(['bun', 'build', source, '--target', 'bun', '--outdir', out]) ?? { cmd: ['bun', source] };
  },
};

const python: Lang = {
  name: 'python',
  keep: ['.py'],
  setup() {},
  prompt: [
    'The language is Python 3.13. Write the program in app.py (the entry point) and its tests in test_app.py (unittest); other modules, if any, in .py files next to them.',
    'Use only the standard library (http.server, sqlite3, threading, ...): nothing to pip install.',
    '`python app.py` runs it, `python -m unittest` tests it.',
  ],
  compiler: /\bpython3?\s+(-m\s+unittest|-m\s+py_compile|-c|app\.py|test_app\.py)/g,
  build(dir) {
    const source = path.join(dir, 'app.py');
    return run(['python', '-m', 'py_compile', source]) ?? { cmd: ['python', '-u', source] };
  },
};

const langs: Record<string, Lang> = { candor, go, ts, python };

function prompt(lang: Lang): string {
  return [
    `You are taking part in a trial: alone, you write a program from a spec, in ${lang.name}.`,
    '',
    '- The spec is spec.md in this directory. Build what it says.',
    '- Work only in this directory: do not read or change anything outside it.',
    ...lang.prompt.map((l) => `- ${l}`),
    '- Keep log.md as you go: each build or test run, the errors you got and whether the error message told you the fix, and every place you had to guess (syntax, a library function, how something is written). Short entries.',
    '- You are done when the program builds, your tests pass, and you have checked it against the spec. Separate acceptance tests, which you cannot see, will then run it as the spec says.',
    '- Do not ask questions: nobody will answer. Decide, and note it in log.md.',
  ].join('\n');
}

interface Acceptance {
  built: boolean;
  pass: number;
  fail: number;
  failures: string[];
  buildError?: string;
}

function accept(app: string, lang: Lang, dir: string, out: string): Acceptance {
  mkdirSync(out, { recursive: true });
  const built = lang.build(dir, out);
  if ('error' in built) return { built: false, pass: 0, fail: 0, failures: [], buildError: built.error.slice(0, 4000) };
  const r = spawnSync('bun', ['test', `./trials/apps/${app}/acceptance.test.ts`], {
    cwd: repo,
    env: { ...env, TRIAL_CMD: JSON.stringify(built.cmd) },
    encoding: 'utf8',
  });
  const text = `${r.stdout}${r.stderr}`;
  const count = (word: string) => Number(text.match(new RegExp(`^\\s*(\\d+) ${word}$`, 'm'))?.[1] ?? 0);
  const failures = [...text.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]);
  return { built: true, pass: count('pass'), fail: count('fail'), failures };
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

async function trial(app: string, lang: Lang, agent: Agent, model: string, budget: string) {
  await holdForTurn();
  const id = stamp();
  const dir = path.join(work, `${app}-${lang.name}-${id}`);
  mkdirSync(dir, { recursive: true });
  lang.setup(dir);
  cpSync(path.join(trials, 'apps', app, 'spec.md'), path.join(dir, 'spec.md'));
  const provided = new Set(readdirSync(dir));
  const keep = path.join(trials, 'runs', app, lang.name, id);
  mkdirSync(keep, { recursive: true });
  console.log(`${app}/${lang.name} (${agent.name}): working in ${dir}`);

  const started = Date.now();
  const { transcript, stderr } = await runAgent(agent.command(prompt(lang), model, budget), dir, env);
  const wallMs = Date.now() - started;
  const cut = stoppedByLimit(transcript);
  if (cut) {
    // Says nothing about the language: not kept, not scored, and a batch stops here.
    console.error(`${app}/${lang.name}: not scored: ${cut}`);
    rmSync(keep, { recursive: true, force: true });
    gone(dir);
    process.exit(limitExit);
  }
  writeFileSync(path.join(keep, 'transcript.jsonl'), transcript.join('\n') + '\n');
  finish(app, lang, agent, model, dir, keep, provided, started, wallMs, transcript, stderr);
  // trials/runs keeps the sources, log and transcript; --keep leaves the directory, for `recover`.
  if (!process.argv.includes('--keep')) gone(dir);
}

/** After the agent: keeps its sources, runs the acceptance tests, writes result.json. */
function finish(app: string, lang: Lang, agent: Agent, model: string, dir: string, keep: string, provided: Set<string>, started: number, wallMs: number, transcript: string[], stderr: string) {
  const { tools, compiler, agent: run } = agent.digest(transcript, lang.compiler);
  // Files only: Candor's build cache is a folder named `.candor`.
  const sources = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && lang.keep.some((k) => (k.startsWith('.') ? d.name.endsWith(k) : d.name === k)))
    .map((d) => d.name);
  for (const f of [...sources, 'log.md']) if (existsSync(path.join(dir, f))) cpSync(path.join(dir, f), path.join(keep, f));
  // Folders the agent made (a Candor binding's `./native` Go, a Go package) are kept whole.
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !provided.has(d.name) && !d.name.startsWith('.') && !['node_modules', '__pycache__'].includes(d.name))
    .map((d) => d.name);
  for (const f of folders) cpSync(path.join(dir, f), path.join(keep, f), { recursive: true });
  const acceptance: Acceptance = sources.length
    ? accept(app, lang, dir, path.join(dir, '.trial', 'build'))
    : { built: false, pass: 0, fail: 0, failures: [], buildError: 'no sources' };
  // Every non-blank line written, tests included: Candor's tests share the program's file.
  const source = /\.(candor|go|ts|py)$/;
  const written = [
    ...sources.filter((f) => !f.startsWith('go.')),
    ...folders.flatMap((f) => (readdirSync(path.join(dir, f), { recursive: true }) as string[]).filter((g) => source.test(g)).map((g) => path.join(f, g))),
  ];
  const lines = written.reduce((n, f) => n + readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length, 0);

  const summary = {
    app,
    lang: lang.name,
    model,
    started: new Date(started).toISOString(),
    wallMs,
    via: agent.name,
    agent: run,
    tools,
    compiler,
    reading: reading(transcript, agent),
    limits: limits(transcript),
    lines,
    acceptance,
    ...(run ? {} : { stderr: stderr.slice(0, 4000) }),
  };
  writeFileSync(path.join(keep, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(row(summary));
}

function row(r: any): string {
  const a = r.acceptance;
  const tokens = r.agent?.usage ? r.agent.usage.input_tokens + r.agent.usage.output_tokens + (r.agent.usage.cache_read_input_tokens ?? 0) + (r.agent.usage.cache_creation_input_tokens ?? 0) : 0;
  const builds = Object.values(r.compiler as Record<string, number>).reduce((s, n) => s + n, 0);
  return [
    r.app.padEnd(10),
    r.lang.padEnd(8),
    (r.via ?? 'claude').padEnd(6),
    r.model.padEnd(12),
    r.started.slice(0, 16),
    `${Math.round(r.wallMs / 1000)}s`.padStart(6),
    (r.agent?.costUsd == null ? '-' : `$${r.agent.costUsd.toFixed(2)}`).padStart(7),
    (r.reading ? `${Math.round(r.reading.context / 1000)}k ctx` : '-').padStart(8),
    `${Math.round(tokens / 1000)}k tok`.padStart(9),
    `${r.agent?.turns ?? '?'} turns`.padStart(9),
    `${builds} compiles`.padStart(12),
    `${r.lines} lines`.padStart(10),
    a.built ? `${a.pass}/${a.pass + a.fail} accepted` : 'no build',
  ].join('  ');
}

/** After an acceptance test changes: runs them again on each run's kept sources and records the new result. */
function rescore(app: string) {
  const root = path.join(trials, 'runs', app);
  for (const name of readdirSync(root)) {
    const lang = langs[name];
    if (!lang) continue;
    for (const id of readdirSync(path.join(root, name))) {
      const keep = path.join(root, name, id);
      const f = path.join(keep, 'result.json');
      if (!existsSync(f)) continue;
      const r = JSON.parse(readFileSync(f, 'utf8'));
      const before = r.acceptance;
      const out = path.join(work, `rescore-${app}-${name}-${id}`);
      const now = accept(app, lang, keep, out);
      gone(out);
      if (!now.built && before.built) {
        // The language changed since (Candor's does): the run is scored as it was.
        console.log(`${keep}: no longer builds, kept as it was`);
        continue;
      }
      r.acceptance = now;
      if (r.acceptance.pass !== before.pass || r.acceptance.fail !== before.fail) r.rescored = { from: `${before.pass}/${before.pass + before.fail}` };
      writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
      console.log(row(r));
    }
  }
}

function report() {
  const root = path.join(trials, 'runs');
  if (!existsSync(root)) return console.log('no runs yet');
  for (const app of readdirSync(root))
    for (const lang of readdirSync(path.join(root, app)))
      for (const id of readdirSync(path.join(root, app, lang))) {
        const f = path.join(root, app, lang, id, 'result.json');
        if (existsSync(f)) console.log(row(JSON.parse(readFileSync(f, 'utf8'))));
      }
}

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const lang = langs[flag(args, 'lang', 'candor')];
if (!lang) throw new Error(`no language ${flag(args, 'lang', '')}: ${Object.keys(langs).join(', ')}`);
const apps = readdirSync(path.join(trials, 'apps'));
const appArg = (a: string | undefined) => {
  if (!a || !apps.includes(a)) throw new Error(`name an app: ${apps.join(', ')}`);
  return a;
};

if (args[0] === 'report') {
  report();
} else if (args[0] === 'rescore') {
  rescore(appArg(args[1]));
} else if (args[0] === 'recover') {
  // The agent finished but scoring failed: score the run from its directory and kept transcript.
  const app = appArg(args[1]);
  const dir = path.resolve(args[2]);
  const id = path.basename(dir).slice(`${app}-${lang.name}-`.length);
  const keep = path.join(trials, 'runs', app, lang.name, id);
  const transcript = readFileSync(path.join(keep, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
  const scratch = path.join(work, `provided-${lang.name}`);
  mkdirSync(scratch, { recursive: true });
  lang.setup(scratch);
  const provided = new Set([...readdirSync(scratch), 'spec.md']);
  gone(scratch);
  const started = Date.parse(id.replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:$6Z'));
  const agent = agentArg(flag(args, 'agent', 'claude'));
  finish(app, lang, agent, flag(args, 'model', agent.model), dir, keep, provided, started, agent.digest(transcript, lang.compiler).agent?.durationMs ?? 0, transcript, '');
} else if (args[0] === 'accept') {
  const app = appArg(args[1]);
  const out = path.join(work, `accept-${app}-${lang.name}`);
  const a = accept(app, lang, path.resolve(args[2]), out);
  gone(out);
  console.log(JSON.stringify(a, null, 2));
  process.exit(a.built && a.fail === 0 ? 0 : 1);
} else if (args[0] === 'refs') {
  // Every app's reference (Candor) against its acceptance tests: after a compiler or std change.
  const picked = args[1] && !args[1].startsWith('--') ? [appArg(args[1])] : apps;
  let failed = 0;
  for (const app of picked) {
    const out = path.join(work, `refs-${app}`);
    const a = accept(app, langs.candor, path.join(trials, 'apps', app, 'reference'), out);
    gone(out);
    const ok = a.built && a.fail === 0 && a.pass > 0;
    if (!ok) failed++;
    console.log(`${app}: ${ok ? 'ok' : 'FAIL'} ${a.pass}/${a.pass + a.fail}`);
    if (a.buildError) console.log(`  ${a.buildError.split('\n').join('\n  ')}`);
    for (const f of a.failures) console.log(`  ${f}`);
  }
  process.exit(failed ? 1 : 0);
} else {
  const app = appArg(args[0]);
  const runs = Number(flag(args, 'runs', '1'));
  const agent = agentArg(flag(args, 'agent', 'claude'));
  for (let n = 0; n < runs; n++) await trial(app, lang, agent, flag(args, 'model', agent.model), flag(args, 'budget', '10'));
}
