// The agents a trial can run: headless Claude Code. Each gives the
// command that starts it on a prompt in a directory, and reads its transcript: tool calls,
// compiler runs (a Bash command matching the language's pattern), turns and tokens.

import os from 'node:os';
import path from 'node:path';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** What result.json keeps of the agent's run. */
export interface Summary {
  subtype?: string;
  isError: boolean;
  turns: number;
  durationMs: number;
  /** Dollars, for an agent that reports them. */
  costUsd: number | null;
  usage: Usage;
  permissionDenials: number;
}

export interface Digest {
  tools: Record<string, number>;
  compiler: Record<string, number>;
  agent: Summary | null;
}

export interface Agent {
  name: string;
  model: string;
  command(prompt: string, model: string, budget: string): string[];
  digest(transcript: string[], compiler: RegExp): Digest;
  /** The model calls in order: each one's usage, and whether its tool calls edit the code. */
  calls(transcript: string[]): ModelCall[];
}

export interface ModelCall {
  usage: Usage;
  edits: boolean;
}

/** Counts each tool call, and each compiler run in a Bash command. */
function count(calls: { name: string; command?: string }[], compiler: RegExp) {
  const tools: Record<string, number> = {};
  const runs: Record<string, number> = {};
  for (const c of calls) {
    tools[c.name] = (tools[c.name] ?? 0) + 1;
    if (c.name === 'Bash')
      for (const m of String(c.command ?? '').matchAll(compiler)) {
        const cmd = (m[1] ?? 'accept').replace(/\s+/g, ' ');
        runs[cmd] = (runs[cmd] ?? 0) + 1;
      }
  }
  return { tools, compiler: runs };
}

const claude: Agent = {
  name: 'claude',
  model: 'sonnet',
  command: (prompt, model, budget) => [
    'claude', '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--permission-mode', 'dontAsk',
    // The same tools in every language: files and a shell, no web, no subagents.
    '--tools', 'Read,Write,Edit,Glob,Grep,Bash',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash',
    // The user's settings (hooks, plugins) and MCP servers stay out of the trial.
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd', budget,
  ],
  digest(transcript, compiler) {
    const calls: { name: string; command?: string }[] = [];
    let result: any = null;
    for (const line of transcript) {
      const msg = JSON.parse(line);
      if (msg.type === 'assistant')
        for (const c of msg.message?.content ?? []) if (c.type === 'tool_use') calls.push({ name: c.name, command: c.input?.command });
      // A background task finishing after the agent's answer wakes it again, and each wake ends
      // with its own result: add up turns, time and usage; the cost is already a running total.
      if (msg.type === 'result') result = result ? merge(result, msg) : msg;
    }
    return {
      ...count(calls, compiler),
      agent: result && {
        subtype: result.subtype,
        isError: result.is_error,
        turns: result.num_turns,
        durationMs: result.duration_ms,
        costUsd: result.total_cost_usd,
        usage: result.usage,
        permissionDenials: result.permission_denials?.length ?? 0,
      },
    };
  },
  calls(transcript) {
    // A model call streams as several messages with one id; the last carries its final usage.
    const calls = new Map<string, ModelCall>();
    for (const line of transcript) {
      const msg = JSON.parse(line);
      if (msg.type !== 'assistant' || !msg.message?.id) continue;
      const prev = calls.get(msg.message.id);
      const edits = (msg.message.content ?? []).some(
        (c: any) =>
          c.type === 'tool_use' &&
          (((c.name === 'Edit' || c.name === 'Write') && !isLog(String(c.input?.file_path ?? ''))) || (c.name === 'Bash' && bashEdits(String(c.input?.command ?? '')))),
      );
      calls.set(msg.message.id, { usage: msg.message.usage ?? prev?.usage, edits: edits || (prev?.edits ?? false) });
    }
    return [...calls.values()];
  },
};

// Antigravity's CLI, Google's models. Headless it can't ask, so a tool runs only if
// --settings allows it. A rule is an exact path or `*` (path globs don't match: probed 2026-10-29),
// so files and the shell are allowed anywhere, as Claude's Bash is; the sandbox limits the shell.
// Browser, web, MCP and subagent tools stay denied. --mode auto isn't on every plan.
// The init event lists other names than the steps report (replace_file_content, edit_file): both.
const agyFile = ['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file'];
const agySettings = {
  permissions: {
    allow: [
      ...['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search'],
      ...agyFile,
      // A rule names the permission, which isn't always the tool's name: run_command checks `command`.
      ...['command', 'run_command', 'command_status', 'send_command_input'],
    ].map((t) => `${t}(*)`),
  },
};

/** agy's stream-json: one event per step; a tool step comes ACTIVE then DONE under one step_index. */
function agySteps(transcript: string[]) {
  const steps = new Map<number, any>();
  let result: any = null;
  for (const line of transcript) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // stderr lines, if they were mixed in
    }
    if (msg.event === 'result') result = msg.result;
    const s = msg.step_update;
    if (msg.event === 'step_update' && s) steps.set(s.step_index, { ...steps.get(s.step_index), ...s });
  }
  return { steps: [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s), result };
}

const agyCommand = (p: any) => String(p?.CommandLine ?? p?.Command ?? p?.command ?? '');
const agyPath = (p: any) => String(p?.Path ?? p?.TargetFile ?? p?.AbsolutePath ?? p?.File ?? '');

/** agy's usage as Claude's fields: its input leaves cache reads out; thinking counts as output. */
const agyUsage = (u: any): Usage => ({
  input_tokens: u?.input_tokens ?? 0,
  output_tokens: (u?.output_tokens ?? 0) + (u?.thinking_tokens ?? 0),
  cache_read_input_tokens: u?.cache_read_tokens ?? 0,
  cache_creation_input_tokens: 0,
});

const agy: Agent = {
  name: 'agy',
  model: 'gemini-4-argon-medium',
  // No budget flag: a time limit instead.
  command: (prompt, model) => [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
    '-p', prompt,
    '--output-format', 'stream-json',
    '--model', model,
    '--sandbox',
    '--settings', JSON.stringify(agySettings),
    '--print-timeout', '45m',
  ],
  digest(transcript, compiler) {
    const { steps, result } = agySteps(transcript);
    const tools = steps.filter((s) => s.step_type === 'tool');
    const responses = steps.filter((s) => s.step_type === 'agent_response');
    const usage = agyUsage(result?.usage ?? {});
    return {
      ...count(
        tools.map((s) => (s.tool_name === 'run_command' ? { name: 'Bash', command: agyCommand(s.tool_info?.parameters) } : { name: s.tool_name })),
        compiler,
      ),
      agent: result && {
        subtype: String(result.status ?? '').toLowerCase(),
        isError: result.status !== 'SUCCESS',
        // Its num_turns counts prompts; a turn here is a model call, as Claude counts them.
        turns: responses.length,
        durationMs: Math.round((result.duration_seconds ?? 0) * 1000),
        costUsd: null,
        usage,
        permissionDenials: result.denied_actions?.length ?? 0,
      },
    };
  },
  calls(transcript) {
    // A response step comes before the tool steps it asked for.
    const calls: ModelCall[] = [];
    for (const s of agySteps(transcript).steps) {
      if (s.step_type === 'agent_response') calls.push({ usage: agyUsage(s.usage), edits: false });
      else if (s.step_type === 'tool' && calls.length) {
        const p = s.tool_info?.parameters;
        const edits = (agyFile.includes(s.tool_name) && !isLog(agyPath(p))) || (s.tool_name === 'run_command' && bashEdits(agyCommand(p)));
        if (edits) calls[calls.length - 1].edits = true;
      }
    }
    return calls;
  },
};

function merge(a: any, b: any) {
  const usage = { ...b.usage };
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
    usage[k] = (a.usage?.[k] ?? 0) + (b.usage?.[k] ?? 0);
  return { ...b, num_turns: a.num_turns + b.num_turns, duration_ms: a.duration_ms + b.duration_ms, usage };
}

export const agents: Record<string, Agent> = { claude, agy };

export function agentArg(name: string): Agent {
  const a = agents[name];
  if (!a) throw new Error(`no agent ${name}: ${Object.keys(agents).join(', ')}`);
  return a;
}

/** What the agent took in before its first edit, from its transcript. */
export interface Reading {
  /** Model calls before the first edit to the code (log.md doesn't count). */
  turns: number;
  /** Tokens those calls took: input, cache reads and writes, output; as the run's total counts them. */
  tokens: number;
  /**
   * The context the first edit was made in: that call's whole input (cache reads and writes too).
   * What the agent actually took in; `tokens` counts a file read early again on every later call.
   */
  context: number;
  /** False when the agent never edited: then the figures are the whole run. */
  edited: boolean;
}

const isLog = (f: string) => /(^|[\\/])log\.md$/.test(f);

/** Whether a Bash command writes a file other than log.md: agents edit with sed, python and redirects too. */
export function bashEdits(cmd: string): boolean {
  if (/\bsed\s+(-\w+\s+)*-i|\bperl\s+-\w*i|\bgit\s+apply\b|\bpatch\s/.test(cmd)) return true;
  if (/\bpython3?\b/.test(cmd) && /\.write\(|open\([^)]*['"][wa]/.test(cmd)) return true;
  // `> f`, `>> f`, `tee f`; not `2>&1`, `>/dev/null` or log.md.
  for (const m of cmd.matchAll(/(?:(?:^|[^\d&>])>>?|\btee(?:\s+-a)?)\s*([^\s;|&<>()]+)/g)) {
    const f = m[1].replace(/['"]/g, '');
    if (!f.startsWith('&') && !/^\/dev\/null$|^nul$/i.test(f) && !isLog(f)) return true;
  }
  return false;
}

export function reading(transcript: string[], agent: Agent = claude): Reading {
  const calls = agent.calls(transcript);
  const input = (u: any) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  let turns = 0;
  let tokens = 0;
  let context = 0;
  for (const { usage: u, edits } of calls) {
    context = input(u);
    if (edits) return { turns, tokens, context, edited: true };
    turns++;
    tokens += input(u) + (u?.output_tokens ?? 0);
  }
  return { turns, tokens, context, edited: false };
}

/**
 * Stops what an agent or a test left running from `dir` (a server started in the background),
 * so the directory can go. Windows only: elsewhere the process group ends with the agent.
 */
export function reap(dir: string) {
  if (process.platform !== 'win32') return;
  const under = path.resolve(dir).replace(/'/g, "''");
  Bun.spawnSync(['powershell', '-NoProfile', '-Command', `Get-Process | Where-Object { $_.Path -like '${under}\\*' } | Stop-Process -Force`]);
}

/** Subscription use a run reported, 0 to 1, as of its last reading. */
export interface Limits {
  fiveHour: number | null;
  sevenDay: number | null;
}

/** The status a runner exits with when a limit cut its run off: not a failure of the run. */
export const limitExit = 75;

function rateEvents(transcript: string[]): any[] {
  const events: any[] = [];
  for (const line of transcript) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) events.push(msg.rate_limit_info);
    } catch {
      // stderr lines, if they were mixed in
    }
  }
  return events;
}

/** The last subscription readings in a transcript; null if it has none (an API key, or agy). */
export function limits(transcript: string[]): Limits | null {
  const windows = rateEvents(transcript).map((e) => e.unifiedWindows).filter(Boolean);
  const last = windows.at(-1);
  return last ? { fiveHour: last.five_hour?.utilization ?? null, sevenDay: last.seven_day?.utilization ?? null } : null;
}

/**
 * Why a limit cut this run off, or null if none did. Such a run says nothing about the language,
 * so it mustn't be scored. No real rejection has been seen yet: this covers the rejected status,
 * the assistant message's error and the failed result's text.
 */
export function stoppedByLimit(transcript: string[]): string | null {
  const rejected = rateEvents(transcript).find((e) => e.status === 'rejected');
  if (rejected) {
    const at = rejected.resetsAt ? `, resets ${new Date(rejected.resetsAt * 1000).toISOString()}` : '';
    return `${rejected.rateLimitType ?? 'usage'} limit reached${at}`;
  }
  for (const line of transcript) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'assistant' && msg.error === 'rate_limit') return 'rate limit reached';
    if (msg.type === 'result' && msg.is_error && /hit your .*limit|usage limit|rate limit|limit reached/i.test(String(msg.result ?? ''))) return String(msg.result);
  }
  return null;
}

/**
 * Whether a run may start at this local time, given `CANDOR_TRIALS_HOURS` as `HH:MM-HH:MM`
 * (the start window; it may wrap past midnight). No window: any time.
 */
export function inTrialHours(now: Date, window = process.env.CANDOR_TRIALS_HOURS): boolean {
  if (!window) return true;
  const m = window.match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
  if (!m) throw new Error(`CANDOR_TRIALS_HOURS is "${window}"; give a start window as HH:MM-HH:MM`);
  const [from, to] = [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
  const t = now.getHours() * 60 + now.getMinutes();
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/** Waits for the trial hours, if `CANDOR_TRIALS_HOURS` sets them. Call before starting each run. */
export async function holdForTurn(everyMs = 60_000) {
  let told = false;
  while (!inTrialHours(new Date())) {
    if (!told) console.log(`Outside trial hours (${process.env.CANDOR_TRIALS_HOURS}): holding.`);
    told = true;
    await Bun.sleep(everyMs);
  }
}

/** Starts the agent in `dir` and collects its stdout lines until it exits. */
export async function runAgent(cmd: string[], dir: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(cmd, { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  // Read at the same time, or a full stderr pipe stops the agent.
  const stderr = new Response(proc.stderr).text();
  const transcript: string[] = [];
  const dec = new TextDecoder();
  let pending = '';
  for await (const chunk of proc.stdout) {
    pending += dec.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop()!;
    transcript.push(...lines.filter((l) => l.trim()));
  }
  if (pending.trim()) transcript.push(pending);
  await proc.exited;
  return { transcript, stderr: await stderr };
}
