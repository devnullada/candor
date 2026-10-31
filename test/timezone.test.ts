import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 153: named time zones (`time.zone`, the `...In` functions) from the zone database built
// into the program, and Go layouts (`time.parseLayout`, `time.formatLayout`) with a fixed table
// of zone abbreviations.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(command: string, name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'timezone', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), command, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const tests = `module zones

import "time"

fn at(text: string) -> int {
  return time.parse(text).ok() ?? -1
}

fn oslo() -> time.Zone {
  return time.zone("Europe/Oslo") ?? time.utcZone()
}

test "zones by name" {
  assert time.zone("Europe/Oslo").map((z) => time.zoneName(z)) == "Europe/Oslo"
  assert time.zone("UTC") == time.utcZone()
  assert time.zone("Mars/Olympus_Mons") == none
  assert time.zone("Local") == none && time.zone("") == none
}

test "a time on a zone's clocks" {
  let winter = at("2026-10-28T10:00:00Z")
  assert time.formatIn(winter, oslo()) == "2026-10-28T11:00:00.000+01:00"
  assert time.formatDateIn(at("2026-10-28T23:30:00Z"), oslo()) == "2026-10-29"
  assert time.partsIn(winter, oslo()).hour == 11
  assert time.offsetIn(winter, oslo()) == time.hours(1)
  assert time.offsetIn(at("2026-07-01T10:00:00Z"), oslo()) == time.hours(2)
  let ny = time.zone("America/New_York") ?? time.utcZone()
  assert time.formatIn(winter, ny) == "2026-10-28T06:00:00.000-04:00"
  assert time.offsetIn(at("2026-11-02T10:00:00Z"), ny) == time.hours(-5)
  assert time.partsIn(winter, time.utcZone()) == time.parts(winter)
}

test "local times, daylight saving included" {
  assert time.inZone(oslo(), 2026, 10, 28, 9, 0, 0) == Ok(at("2026-10-28T08:00:00Z"))
  // #862ac7c0: a time the clocks skip moves on by the gap, as Go's does; validIn tells.
  assert time.inZone(oslo(), 2026, 3, 29, 2, 30, 0) == Ok(at("2026-03-29T01:30:00Z"))
  assert time.partsIn(at("2026-03-29T01:30:00Z"), oslo()).hour == 3
  assert !time.validIn(oslo(), 2026, 3, 29, 2, 30, 0) && time.validIn(oslo(), 2026, 3, 29, 3, 30, 0)
  assert time.inZone(oslo(), 2026, 2, 30, 9, 0, 0) == Err("2026-02-30 09:00:00 is not a time in Europe/Oslo")
  assert !time.validIn(oslo(), 2026, 2, 30, 9, 0, 0)
  assert time.inZone(oslo(), 2026, 10, 25, 2, 30, 0) == Ok(at("2026-10-25T00:30:00Z"))
}

test "local days" {
  let late = at("2026-10-28T23:30:00Z")
  assert time.startOfDayIn(late, oslo()) == at("2026-10-28T23:00:00Z")
  assert time.daysBetweenIn(at("2026-10-28T10:00:00Z"), late, oslo()) == 1
  assert time.daysBetween(at("2026-10-28T10:00:00Z"), late) == 0
  let day = time.startOfDayIn(at("2026-10-25T12:00:00Z"), oslo())
  assert time.startOfDayIn(time.addDaysIn(day, 1, oslo()), oslo()) - day == time.hours(25)
  assert time.addDaysIn(at("2026-10-24T08:00:00Z"), 1, oslo()) == at("2026-10-25T09:00:00Z")
  assert time.addDaysIn(at("2026-10-24T08:00:00Z"), -1, oslo()) == at("2026-10-23T08:00:00Z")
}

test "layouts and zone abbreviations" {
  let rfc = "Mon, 02 Jan 2006 15:04:05 MST"
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 EST", rfc) == Ok(at("2026-10-27T14:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 PDT", rfc) == Ok(at("2026-10-27T16:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 CET", rfc) == Ok(at("2026-10-27T08:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 IST", rfc) == Ok(at("2026-10-27T03:30:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 GMT", rfc) == Ok(at("2026-10-27T09:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 UTC", rfc) == Ok(at("2026-10-27T09:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 GMT+2", rfc) == Ok(at("2026-10-27T07:00:00Z"))
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 -0700", "Mon, 02 Jan 2006 15:04:05 -0700") == Ok(at("2026-10-27T16:00:00Z"))
  // #862ac7c0: an abbreviation not in the table is read at offset 0, as Go does.
  assert time.parseLayout("Tue, 27 Oct 2026 09:00:00 XYZ", rfc) == Ok(at("2026-10-27T09:00:00Z"))
  assert time.parseLayoutIn("Tue, 27 Oct 2026 09:00:00 XYZ", rfc, oslo()) == Ok(at("2026-10-27T09:00:00Z"))
  assert time.parseLayout("27 Oct 2026", "2 Jan 2006") == Ok(at("2026-10-27"))
  assert time.parseLayout("32 Oct 2026", "2 Jan 2006") == Err("\\"32 Oct 2026\\" is not a time: day out of range")
  assert time.parseLayout("yesterday", "2 Jan 2006").isErr()
  assert time.parseLayoutIn("2026-10-28 09:00", "2006-01-02 15:04", oslo()) == Ok(at("2026-10-28T08:00:00Z"))
  assert time.parseLayoutIn("Tue, 27 Oct 2026 09:00:00 EST", rfc, oslo()) == Ok(at("2026-10-27T14:00:00Z"))
  let ny = time.zone("America/New_York") ?? time.utcZone()
  assert time.parseLayoutIn("Tue, 27 Oct 2026 09:00:00 EDT", rfc, ny) == Ok(at("2026-10-27T13:00:00Z"))
  assert time.formatLayout(at("2026-10-28T10:00:00Z"), "Jan 2, 15:04 MST", oslo()) == "Oct 28, 11:00 CET"
  assert time.formatLayout(at("2026-10-28T10:00:00Z"), rfc, time.utcZone()) == "Wed, 28 Oct 2026 10:00:00 UTC"
}
`;

test('time zones: zones by name, local days, layouts', () => {
  const r = candor('test', 'zones', tests);
  expect(r.stderr).toBe('');
  expect(r.stdout).toEndWith('5 passed, 0 failed\n');
}, 120_000);
