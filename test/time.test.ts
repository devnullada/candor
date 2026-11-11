import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `import "time"`, pure functions on epoch-ms ints, in UTC.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(command: string, name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'time', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), command, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const tests = `module dates

import "time"

// Pure: no \`uses\`.
fn label(t: int) -> string {
  let p = time.parts(t)
  return "\${time.formatDate(t)} day \${p.yearDay}, weekday \${p.weekday}"
}

fn at(text: string) -> int {
  return match time.parse(text) {
    Ok(t) => t,
    Err(_) => -1,
  }
}

test "format and parse round-trip" {
  let t = at("2026-10-25T10:00:01.250Z")
  assert t == 1792922401250
  assert time.format(t) == "2026-10-25T10:00:01.250Z"
  assert time.parse(time.format(t)) == Ok(t)
  assert time.parse("2026-10-25T12:00:01.25+02:00") == Ok(t)
  assert time.format(0) == "1970-01-01T00:00:00.000Z"
  assert time.formatDate(t) == "2026-10-25"
  assert time.parse("2026-10-25") == Ok(at("2026-10-25T00:00:00Z"))
}

test "a bad timestamp says what is wrong" {
  assert time.parse("2026-13-01") == Err("\\"2026-13-01\\" is not a time: month out of range")
  assert time.parse("2026-02-30") == Err("\\"2026-02-30\\" is not a time: day out of range")
  assert time.parse("yesterday") == Err("\\"yesterday\\" is not a time: write it as 2026-10-25T10:00:00Z (an offset like +02:00 for Z, a fraction of a second allowed) or 2026-10-25")
  assert time.utc(2027, 2, 29, 0, 0, 0) == Err("2027-02-29 00:00:00 is not a time")
  assert time.utc(2026, 10, 25, 24, 0, 0) == Err("2026-10-25 24:00:00 is not a time")
}

test "parts" {
  let t = at("2026-10-25T10:20:30.400Z")
  assert time.parts(t) == time.Parts { year: 2026, month: 10, day: 25, hour: 10, minute: 20, second: 30, millisecond: 400, weekday: 7, yearDay: 298 }
  assert label(at("2028-12-31")) == "2028-12-31 day 366, weekday 7"
  assert time.utc(2028, 2, 29, 12, 0, 0) == Ok(at("2028-02-29T12:00:00Z"))
}

test "across a month end and a leap day" {
  assert time.addDays(at("2028-02-28T09:00:00Z"), 1) == at("2028-02-29T09:00:00Z")
  assert time.addDays(at("2027-02-28T09:00:00Z"), 1) == at("2027-03-01T09:00:00Z")
  assert time.addDays(at("2026-12-31"), 1) == at("2027-01-01")
  assert time.addMonths(at("2028-01-31T08:00:00Z"), 1) == at("2028-02-29T08:00:00Z")
  assert time.addMonths(at("2027-01-31"), 1) == at("2027-02-28")
  assert time.addMonths(at("2026-11-30"), 3) == at("2027-02-28")
  assert time.addMonths(at("2026-03-31"), -1) == at("2026-02-28")
  assert time.addMonths(at("2026-01-15"), -13) == at("2024-12-15")
  assert time.addYears(at("2028-02-29"), 1) == at("2029-02-28")
  assert time.addYears(at("2028-02-29"), 4) == at("2032-02-29")
}

test "days" {
  assert time.startOfDay(at("2026-10-25T23:59:59.999Z")) == at("2026-10-25")
  assert time.startOfDay(at("1969-12-31T12:00:00Z")) == at("1969-12-31")
  assert time.daysBetween(at("2028-02-27T23:00:00Z"), at("2028-03-01T01:00:00Z")) == 3
  assert time.daysBetween(at("2026-10-25"), at("2026-10-24T23:00:00Z")) == -1
  assert at("2026-10-25") + time.hours(1) + time.minutes(2) + time.seconds(3) == at("2026-10-25T01:02:03Z")
  assert time.days(2) == 172_800_000
}
`;

test('time: format, parse, parts and calendar arithmetic', () => {
  const r = candor('test', 'dates', tests);
  expect(r.stderr).toBe('');
  expect(r.stdout).toEndWith('5 passed, 0 failed\n');
}, 120_000);

test('time works in a program with the clock', () => {
  const r = candor(
    'run',
    'now',
    `module now

import "time"

fn main() uses io, clock {
  let t = clock.now()
  match time.parse(time.format(t)) {
    Ok(back) => io.println("\${back == t} \${time.parts(t).year >= 2026}"),
    Err(e) => io.println(e),
  }
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('true true\n');
}, 120_000);
