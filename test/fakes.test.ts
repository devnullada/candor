import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// A fake's functions may use other effects (a slow fake sleeping on the fake clock),
// and a test reads a fake's state without a method for it.

const api = `module api

effect api {
  pub fn fetch(id: int) -> string {
    return "real \${id}"
  }
}

fake api {
  let mut calls: List<int> = []
  let mut slowMs = 0
  let mut seen: Map<int, int> = [:]
  let mut marks: List<int> = [0, 0]
  fn fetch(id: int) -> string uses clock {
    calls.push(id)
    clock.sleep(slowMs)
    calls.push(id * 10)
    seen[id] = clock.now()
    marks[0] = (marks[0] ?? 0) + 1
    return "fake \${id}"
  }
  fn slow(ms: int) {
    slowMs = ms
  }
}

fn load(id: int) -> string? uses api, tasks {
  return tasks.timeout(1_000, () => api.fetch(id))
}
`;

const errors = (src: string) =>
  compileSplit(src, 'api.candor', 'test')
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => [d.code, d.message]);
const withFake = (old: string, replacement: string, rest = '') => {
  if (!api.includes(old)) throw new Error(`not in api: ${old}`);
  return api.replace(old, replacement) + rest;
};

test("a fake's function may use another effect, not its own or a callback's", () => {
  expect(errors(api)).toEqual([]);
  expect(errors(withFake('fn fetch(id: int) -> string uses clock {', 'fn fetch(id: int) -> string uses clock, api {'))).toEqual([
    ['CAN0043', 'the fake `api` stands in for `api`, so it cannot use it'],
  ]);
  expect(errors(withFake('fn slow(ms: int) {', 'fn slow(ms: int) uses nope {'))).toEqual([['CAN0003', 'unknown effect `nope`']]);
  expect(errors(withFake('  fn slow(ms: int) {', '  fn each(f: fn() -> void) uses f {\n    f()\n  }\n  fn slow(ms: int) {'))).toEqual([
    ['CAN0043', "a fake's function cannot take on a callback's effects with `uses f`"],
  ]);
  // The signature still has to match, what it uses aside.
  expect(errors(withFake('fn fetch(id: int) -> string uses clock {', 'fn fetch(id: string) -> string uses clock {'))).toContainEqual([
    'CAN0005',
    "the fake's `fetch` must have the operation's signature: expected fn(int) -> string, found fn(string) -> string",
  ]);
});

test("a test reads the fake's state; nothing else can, and it can't change it", () => {
  expect(errors(`${api}test "reads" {\n  assert api.calls == []\n  assert api.seen.length() == 0\n}\n`)).toEqual([]);
  expect(errors(`${api}fn peek() -> int uses api {\n  return api.slowMs\n}\n`)).toEqual([
    ['CAN0035', '`api.slowMs` is the fake\'s state, which only `test` blocks can read'],
  ]);
  const assign = errors(`${api}test "writes" {\n  api.slowMs = 3\n}\n`);
  expect(assign.length).toBe(1);
  const push = errors(`${api}test "pushes" {\n  api.calls.push(3)\n}\n`);
  expect(push.length).toBe(1);
});

test('the fake gets the test\'s fakes of what it uses', () => {
  const r = compileSplit(api, 'api.candor', 'test');
  expect(r.go).toContain('type fx__api__fake struct {\n\tuses__clock candor.Clock');
  expect(r.go).toContain('var clock candor.Clock = f__.uses__clock');
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candorTest(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'fakes', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const tests = `
test "a slow fake times out on the fake clock" {
  api.slow(5_000)
  assert load(1) == none
  assert api.calls == [1]
  assert clock.now() < 5_000
}

test "a quick one answers" {
  api.slow(10)
  assert load(2) == "fake 2"
  assert api.calls == [2, 20]
  assert api.seen == [2: 10]
  assert api.marks == [1, 0]
}

test "two tasks in the fake at once lose nothing" {
  api.slow(100)
  let both = tasks.all([1, 2], (id) => api.fetch(id))
  assert both == ["fake 1", "fake 2"]
  assert api.calls.length() == 4
  assert api.seen.length() == 2
  assert api.marks == [2, 0]
}
`;

test('a fake sleeping 5 s meets a 1 s timeout in virtual time; tasks share its state', () => {
  const started = Date.now();
  const r = candorTest('slow', api + tests);
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('3 passed, 0 failed');
  expect(Date.now() - started).toBeLessThan(60_000);
}, 120_000);

const slowServer = `module m
import "http"

fn price(url: string) -> Result<string, http.HttpError> uses http {
  let res = http.send(http.ClientRequest { ...http.request("GET", url), timeoutMs: 1_000 })?
  return Ok(res.body)
}

test "a server slower than the timeout is a timeout" {
  http.answer((req) => {
    clock.sleep(5_000)
    return http.Response { status: 200, headers: [:], body: "late" }
  })
  assert price("https://prices.example/tea") == Err(http.HttpError.Timeout)
  assert http.requests.length() == 1
}

test "a quicker one answers" {
  http.answer((req) => {
    clock.sleep(500)
    return http.Response { status: 200, headers: [:], body: "3.50" }
  })
  assert price("https://prices.example/tea") == Ok("3.50")
}
`;

test("std's fake http runs a handler that uses clock, under the request's timeout", () => {
  const r = candorTest('http', slowServer);
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('2 passed, 0 failed');
}, 120_000);
