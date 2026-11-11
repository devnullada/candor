// `bun run numbers`: fills in the measured parts of trial-numbers/numbers.json (the language's
// own figures, and each trial's results from its runs in trials/runs) and writes the README's
// Numbers section from it, if the README has the `begin`...`end` block for one (it has none
// until there are trial numbers worth showing). `--quick` skips running the tests and keeps the
// last count.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');
const file = path.join(root, 'trial-numbers', 'numbers.json');
const readme = path.join(root, 'README.md');
export const begin = '<!-- numbers: generated from trial-numbers/numbers.json by `bun run numbers` -->';
export const end = '<!-- /numbers -->';

type Result = {
  app: string;
  lang: string;
  passed: number;
  failed: number;
  lines: number | null;
  compilerRuns: number;
  minutes: number;
  /** Context at the first edit; null for runs from before it was recorded. */
  context?: number | null;
  tokens?: number | null;
  dollars?: number | null;
};

export function load(): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Design decisions logged: the `###` headings above "Open questions" in docs/design.md. */
function decisions(): number {
  const design = readFileSync(path.join(root, 'docs', 'design.md'), 'utf8');
  return design.slice(0, design.indexOf('\n## Open questions')).split('\n').filter((l) => l.startsWith('### ')).length;
}

export function stdModules(): string[] {
  return readdirSync(path.join(root, 'std')).filter((f) => f.endsWith('.candor')).map((f) => f.slice(0, -'.candor'.length)).sort();
}

function compilerLines(): number {
  const dir = path.join(root, 'src');
  return readdirSync(dir).filter((f) => f.endsWith('.ts')).reduce((n, f) => n + readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length, 0);
}

function testsPassing(): number {
  const out = spawnSync(process.execPath, ['test'], { cwd: root, encoding: 'utf8', env: { ...process.env, CANDOR_NUMBERS: '1' } });
  const text = out.stdout + out.stderr;
  const pass = /(\d+) pass/.exec(text), fail = /(\d+) fail/.exec(text);
  if (!pass || !fail || fail[1] !== '0') throw new Error(`bun test didn't pass cleanly:\n${text.slice(-2000)}`);
  return Number(pass[1]);
}

/** One run's figures from its result.json (an app trial, or an ntfy change request). */
export function summarize(run: string): Result {
  const r = JSON.parse(readFileSync(path.join(root, 'trials', 'runs', run, 'result.json'), 'utf8'));
  const a = r.acceptance;
  const [passed, failed] = a.request ? [a.request.passed + a.base.passed, a.request.failed + a.base.failed] : [a.pass, a.fail];
  const app = r.request ? `ntfy, ${r.request}` : r.app;
  const compilerRuns = Object.entries(r.compiler as Record<string, number>).filter(([k]) => k !== 'accept').reduce((n, [, v]) => n + v, 0);
  const u = r.agent?.usage;
  const tokens = u ? u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null;
  return {
    app,
    lang: r.lang,
    passed,
    failed,
    lines: r.lines ?? null,
    compilerRuns,
    minutes: Math.round(r.wallMs / 6000) / 10,
    context: r.reading?.context ?? null,
    tokens,
    dollars: r.agent?.costUsd ?? null,
  };
}

/** The acceptance tests of each same-spec app, counted in its acceptance.test.ts. */
function specTests(): Record<string, number> {
  const apps = path.join(root, 'trials', 'apps');
  const out: Record<string, number> = {};
  for (const app of readdirSync(apps)) out[app] = (readFileSync(path.join(apps, app, 'acceptance.test.ts'), 'utf8').match(/^\s*test\(/gm) ?? []).length;
  return out;
}

const ranges = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};
const thousands = (n: number) => n.toLocaleString('en-US');

/** The README's Numbers section. */
export function render(n: any): string {
  const l = n.language;
  const out = [
    begin,
    '## Numbers',
    '',
    `As of ${l.version} (${l.date}). Each claim comes with its catches; the figures are in`,
    '[trial-numbers/numbers.json](trial-numbers/numbers.json).',
    '',
    `- ${l.decisions} design decisions logged in [docs/design.md](docs/design.md), ${l.stdModules.length} standard modules,`,
    `  ${thousands(l.tests)} compiler and runtime tests passing; the compiler is ${thousands(l.compilerLines)} lines of TypeScript.`,
  ];
  for (const t of n.trials) {
    const rs: Result[] = t.results;
    const passedAll = rs.filter((r) => r.failed === 0).length;
    out.push('', `### ${t.title}`, '', `${t.agent} (\`${t.model}\`), Candor ${t.candor}, ${t.date}. ${t.how}`, '');
    out.push(`- ${passedAll} of ${rs.length} runs passed every acceptance test.`);
    for (const lang of ['candor', 'go']) {
      const runs = rs.filter((r) => r.lang === lang);
      if (runs.length) out.push(`- Compiler runs until done, ${lang === 'go' ? 'Go' : 'Candor'}: ${ranges(runs.map((r) => r.compilerRuns))}.`);
    }
    out.push('', '| App | Candor lines | Go lines |', '|---|---:|---:|');
    for (const app of [...new Set(rs.map((r) => r.app))]) {
      const c = rs.find((r) => r.app === app && r.lang === 'candor'), g = rs.find((r) => r.app === app && r.lang === 'go');
      if (c?.lines && g?.lines) out.push(`| ${app} | ${c.lines} | ${g.lines} |`);
    }
    out.push('', ...t.catches.map((c: string) => `- Catch: ${c}`));
  }
  out.push('', '### Go programs ported to Candor', '');
  for (const p of n.ports) {
    out.push(`**[${p.source.replace('https://github.com/', '')}](${p.source})**: ${p.what} ${p.agent} (\`${p.model}\`). ${p.how}`, '');
    out.push('| Candor | Minutes | Cost | Tests passing | Lines | |', '|---|---:|---:|---:|---:|---|');
    for (const s of p.passes) out.push(`| ${s.candor} | ${s.minutes} | $${s.dollars.toFixed(2)} | ${s.tests} | ${s.lines ? `about ${thousands(s.lines)}` : ''} | ${s.note} |`);
    out.push('', ...p.catches.map((c: string) => `- Catch: ${c}`), '');
  }
  out.push(`Also: ${n.ownApps.count} ${n.ownApps.what}`, end);
  return out.join('\n');
}

// docs/trials.md's change-trial block, from `change`. Its runs are in the private
// change repo; `bun run numbers` copies that repo's summary.json into `change.results`.
const trials = path.join(root, 'docs', 'trials.md');
export const changeBegin = '<!-- numbers:change generated from trial-numbers/numbers.json by `bun run numbers` -->';
export const changeEnd = '<!-- /numbers:change -->';
const changeSummary = path.join(process.env.CANDOR_CHANGE ?? path.join(root, '..', 'candortests', 'change'), 'summary.json');

const dash = (x: number | null | undefined, f: (n: number) => string = String) => (x == null ? '—' : f(x));
const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
const ofRuns = (g: any) => (g ? `${g.passedAll}/${g.runs}` : '—');

/** docs/trials.md's change-trial block. */
export function renderChange(c: any): string {
  const r = c.results;
  const out = [
    changeBegin,
    `${c.agent}, \`${c.model}\`, Candor ${r?.candor ?? c.candor}${r ? `, ${r.date}` : ''}. ${c.how}${r ? '' : ' Not run yet.'}`,
    '',
    '### Codebases',
    '',
    'Lines are non-blank lines of code, tests left out.',
    '',
    '| App | What it is | Go lines | Candor lines | Shared tests |',
    '|---|---|---:|---:|---:|',
  ];
  for (const [name, a] of Object.entries(c.apps as Record<string, any>)) {
    const m = r?.apps[name];
    out.push(`| [${name}](${a.source}) | ${a.what} | ${dash(m?.goLines, thousands)} | ${dash(m?.candorLines, thousands)} | ${dash(m?.sharedTests)} |`);
  }
  out.push(
    '',
    '### Requests',
    '',
    'Runs that passed: every hidden test, no shared test broken and, for a refactor, the shape',
    'check. Context is the median context the first edit was made in: the docs and code the agent',
    "had read by then, plus Claude Code's own setup, which both languages pay.",
    '',
    '| App | Request | Kind | Hidden tests | Go passed | Candor passed | Go context | Candor context |',
    '|---|---|---|---:|---:|---:|---:|---:|',
  );
  for (const [key, q] of Object.entries(c.requests as Record<string, any>)) {
    const [app, name] = key.split('/');
    const at = (l: string) => r?.byRequest[`${key}/${l}`];
    const tests = at('go')?.hiddenTests ?? at('candor')?.hiddenTests;
    out.push(`| ${app} | ${name}: ${q.what} | ${q.kind} | ${dash(tests)} | ${ofRuns(at('go'))} | ${ofRuns(at('candor'))} | ${dash(at('go')?.contextTokens, kTokens)} | ${dash(at('candor')?.contextTokens, kTokens)} |`);
  }
  const go = r?.byLang.go, cd = r?.byLang.candor;
  const both = (label: string, f: (g: any) => string) => `| ${label} | ${go ? f(go) : '—'} | ${cd ? f(cd) : '—'} |`;
  const spread = (s: number[] | null) => (s ? ` (${kTokens(s[0])}–${kTokens(s[1])})` : '');
  out.push(
    '',
    '### What it took',
    '',
    'Medians over every run of a language, the range in brackets.',
    '',
    '| | Go | Candor |',
    '|---|---:|---:|',
    both('Runs', (g) => `${g.runs}`),
    both('Runs that passed', (g) => `${g.passedAll}`),
    both('Runs that broke a shared test', (g) => `${g.broke}`),
    both('Refactors that passed the shape check', (g) => `${g.shapePassed}/${g.refactors}`),
    both('Context at the first edit', (g) => `${dash(g.contextTokens, kTokens)}${spread(g.contextSpread)}`),
    both('Tokens before the first edit, every call summed', (g) => `${dash(g.readingTokens, kTokens)}${spread(g.readingSpread)}`),
    both('Tokens in all', (g) => `${dash(g.tokens, kTokens)}${spread(g.tokensSpread)}`),
    both('Turns', (g) => dash(g.turns)),
    both('Compiler runs', (g) => dash(g.compilerRuns)),
    both('Lines changed', (g) => dash(g.linesChanged)),
    both('Minutes (see the catches)', (g) => dash(g.minutes, (m) => m.toFixed(1))),
    both('Cost, all runs', (g) => `$${g.dollars.toFixed(2)}`),
    '',
    'By kind of request:',
    '',
    '| Kind | Go passed | Candor passed | Go context | Candor context | Go tokens | Candor tokens |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const k of ['feature', 'bug', 'change', 'refactor']) {
    const at = (l: string) => r?.byKind[`${k}/${l}`];
    out.push(`| ${k} | ${ofRuns(at('go'))} | ${ofRuns(at('candor'))} | ${dash(at('go')?.contextTokens, kTokens)} | ${dash(at('candor')?.contextTokens, kTokens)} | ${dash(at('go')?.tokens, kTokens)} | ${dash(at('candor')?.tokens, kTokens)} |`);
  }
  out.push('', 'Catches:', '', ...c.catches.map((x: string) => `- ${x}`), changeEnd);
  return out.join('\n');
}

export const sameBegin = '<!-- numbers:same-spec generated from trial-numbers/numbers.json by `bun run numbers` -->';
export const sameEnd = '<!-- /numbers:same-spec -->';

/** docs/trials.md's same-spec block, from the `same-spec` trial. */
export function renderSameSpec(t: any): string {
  const rs: Result[] = t.results;
  const at = (app: string, lang: string) => rs.find((r) => r.app === app && r.lang === lang);
  const passed = (r?: Result) => (r ? `${r.passed}/${r.passed + r.failed}` : '—');
  const out = [
    sameBegin,
    `${t.agent}, \`${t.model}\`, Candor ${t.candor}, ${t.date}. ${t.how}${rs.length ? '' : ' Not run yet.'}`,
    '',
    'Lines are non-blank lines written, tests included. Context is the context the agent first',
    'wrote code in: the spec and docs it had read by then, plus Claude Code\'s own setup.',
    '',
    '| App | Tests | Go passed | Candor passed | Go lines | Candor lines | Go compiler runs | Candor compiler runs | Go context | Candor context | Go minutes | Candor minutes |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [app, tests] of Object.entries(t.tests as Record<string, number>)) {
    const g = at(app, 'go'), c = at(app, 'candor');
    const both = (f: (r: Result) => string) => `${g ? f(g) : '—'} | ${c ? f(c) : '—'}`;
    out.push(`| ${app} | ${tests} | ${passed(g)} | ${passed(c)} | ${both((r) => dash(r.lines))} | ${both((r) => `${r.compilerRuns}`)} | ${both((r) => dash(r.context, kTokens))} | ${both((r) => r.minutes.toFixed(1))} |`);
  }
  const cost = (lang: string) => rs.filter((r) => r.lang === lang).reduce((n, r) => n + (r.dollars ?? 0), 0);
  if (rs.length) out.push('', `Cost, all runs: Go $${cost('go').toFixed(2)}, Candor $${cost('candor').toFixed(2)}.`);
  out.push('', 'Catches:', '', ...t.catches.map((x: string) => `- ${x}`), sameEnd);
  return out.join('\n');
}

export const compareBegin = '<!-- numbers:agents generated from trial-numbers/numbers.json by `bun run numbers` -->';
export const compareEnd = '<!-- /numbers:agents -->';
const compareSummary = path.join(path.dirname(changeSummary), 'compare-summary.json');

/**
 * docs/trials.md's other-agents block: the change trial's requests on one app, an
 * agent and model per column. `compare.results` is the change repo's compare-summary.json.
 */
export function renderCompare(c: any): string {
  const r = c.results;
  const agents: any[] = r?.agents ?? [];
  const label = (a: any) => `${a.name}, \`${a.model}\``;
  const out = [
    compareBegin,
    `${c.app}, Candor ${c.candor}${r ? `, ${r.date}` : ''}. ${c.how}${agents.length ? '' : ' Not run yet.'}`,
    '',
    'Context is the context the first edit was made in, as in the change trial. Tokens count cache',
    "reads too; an agent's CLI may cache differently, so tokens compare less well than context.",
    '',
    '| Agent | Runs | Go passed | Candor passed | Go context | Candor context | Go tokens | Candor tokens | Go turns | Candor turns | Go compiler runs | Candor compiler runs | Cost |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const a of agents) {
    const go = a.byLang.go, cd = a.byLang.candor;
    const both = (f: (g: any) => string) => `${go ? f(go) : '—'} | ${cd ? f(cd) : '—'}`;
    const cost = (go?.dollars ?? 0) + (cd?.dollars ?? 0);
    out.push(
      `| ${label(a)} | ${(go?.runs ?? 0) + (cd?.runs ?? 0)} | ${ofRuns(go)} | ${ofRuns(cd)} | ${both((g) => dash(g.contextTokens, kTokens))} | ${both((g) => dash(g.tokens, kTokens))} | ${both((g) => dash(g.turns))} | ${both((g) => dash(g.compilerRuns))} | ${a.costs === false ? 'not reported' : `$${cost.toFixed(2)}`} |`,
    );
  }
  out.push('', 'Each request, runs passed and context at the first edit:', '', `| Request | Kind | ${agents.map((a) => `${a.model} Go | ${a.model} Candor`).join(' | ')} |`, `|---|---|${agents.map(() => '---:|---:').join('|')}|`);
  for (const [name, kind] of Object.entries((r?.requests ?? {}) as Record<string, string>)) {
    const cell = (g: any) => (g ? `${ofRuns(g)}, ${dash(g.contextTokens, kTokens)}` : '—');
    out.push(`| ${name} | ${kind} | ${agents.map((a) => `${cell(a.byRequest[`${name}/go`])} | ${cell(a.byRequest[`${name}/candor`])}`).join(' | ')} |`);
  }
  out.push('', 'Catches:', '', ...c.catches.map((x: string) => `- ${x}`), compareEnd);
  return out.join('\n');
}

/** `text` with its `b`...`e` block replaced by `section`. */
export function withBlock(text: string, b: string, e: string, section: string): string {
  const i = text.indexOf(b), j = text.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`no ${b} ... ${e} block`);
  return text.slice(0, i) + section + text.slice(j + e.length);
}

/** README with its Numbers section replaced by `section`. */
export function withSection(text: string, section: string): string {
  const i = text.indexOf(begin), j = text.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`README.md has no ${begin} ... ${end} block`);
  return text.slice(0, i) + section + text.slice(j + end.length);
}

if (import.meta.main) {
  const n = load();
  const quick = process.argv.includes('--quick');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  n.language = {
    version,
    date: new Date().toISOString().slice(0, 10),
    decisions: decisions(),
    stdModules: stdModules(),
    tests: quick ? n.language.tests : testsPassing(),
    compilerLines: compilerLines(),
  };
  // The runs are kept locally only; without them the results stay as they were.
  for (const t of n.trials) if (t.runs.every((r: string) => existsSync(path.join(root, 'trials', 'runs', r)))) t.results = t.runs.map(summarize);
  const same = n.trials.find((t: any) => t.id === 'same-spec');
  same.tests = specTests();
  if (existsSync(changeSummary)) {
    const s = JSON.parse(readFileSync(changeSummary, 'utf8'));
    const day = (s.until ?? new Date().toISOString()).slice(0, 10);
    n.change.results = { candor: s.candor.split('\n')[0].replace(/^candor /, ''), date: day, since: s.since, apps: s.apps, byRequest: s.byRequest, byLang: s.byLang, byKind: s.byKind };
  }
  if (existsSync(compareSummary)) {
    const s = JSON.parse(readFileSync(compareSummary, 'utf8'));
    n.compare.results = { date: s.date, requests: s.requests, agents: s.agents };
  }
  writeFileSync(file, JSON.stringify(n, null, 2) + '\n');
  const text = readFileSync(readme, 'utf8');
  if (text.includes(begin)) writeFileSync(readme, withSection(text, render(n)));
  let doc = withBlock(readFileSync(trials, 'utf8'), changeBegin, changeEnd, renderChange(n.change));
  doc = withBlock(doc, compareBegin, compareEnd, renderCompare(n.compare));
  writeFileSync(trials, withBlock(doc, sameBegin, sameEnd, renderSameSpec(same)));
}
