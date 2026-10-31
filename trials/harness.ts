// What acceptance tests use to start the program under trial and talk to it. The runner gives
// the command in TRIAL_CMD (a JSON array); the same tests check every language's build.

import { afterEach } from 'bun:test';

export interface Reply {
  status: number;
  text: string;
  /** The body parsed as JSON, or undefined if it isn't JSON. */
  json: any;
  /** The `content-type` header, or "". */
  contentType: string;
}

export interface App {
  url: string;
  req(method: string, path: string, body?: unknown): Promise<Reply>;
  /** Resolves with the exit status when the program ends. */
  exited: Promise<number>;
  /** What the program printed so far, both streams. */
  output(): string;
  stop(): void;
}

const running: App[] = [];
afterEach(() => {
  for (const app of running.splice(0)) app.stop();
});

function command(): string[] {
  const cmd = process.env.TRIAL_CMD;
  if (!cmd) throw new Error('TRIAL_CMD is not set: run acceptance tests through `bun trials/run.ts`');
  return JSON.parse(cmd);
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Starts the program with `PORT` and `env`, and waits until it answers HTTP. */
export async function startApp(env: Record<string, string> = {}): Promise<App> {
  const port = await freePort();
  const proc = Bun.spawn(command(), {
    env: { ...process.env, ...env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let out = '';
  for (const stream of [proc.stdout, proc.stderr]) {
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of stream) out += dec.decode(chunk);
    })();
  }
  let ended = false;
  const exited = proc.exited.then((code) => {
    ended = true;
    return code;
  });
  const url = `http://127.0.0.1:${port}`;
  const req = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(url + path, {
      method,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, contentType: res.headers.get('content-type') ?? '' };
  };
  const app: App = { url, req, exited, output: () => out, stop: () => proc.kill() };
  running.push(app);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (ended) throw new Error(`the program exited before answering:\n${out}`);
    try {
      await fetch(url + '/');
      return app;
    } catch {
      if (Date.now() > deadline) throw new Error(`the program didn't answer on ${url} within 20s:\n${out}`);
      await Bun.sleep(50);
    }
  }
}

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the program to its end with `args` and `stdin`, for apps that are commands, not servers. */
export async function runCli(args: string[], stdin = '', env: Record<string, string> = {}): Promise<Ran> {
  const proc = Bun.spawn([...command(), ...args], {
    env: { ...process.env, ...env },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  // Windows line endings are allowed; the tests compare with `\n`.
  return { status, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n') };
}

/** Polls `f` until it gives something other than undefined, or fails after `ms`. */
export async function waitFor<T>(what: string, f: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await Bun.sleep(20);
  }
}
