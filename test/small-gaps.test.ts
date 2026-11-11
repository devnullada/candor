import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// `import ... as`, `\u{..}` escapes, `lastIndexOf`, `isOk`/`isErr`.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const geo = 'module geo\npub struct Point {\n  pub x: int\n}\npub fn origin() -> Point {\n  return Point { x: 0 }\n}\n';
const program = (main: string) => compileSplit(main, 'main.candor', 'test', { read: (f) => ({ 'geo.candor': geo })[f] ?? null });
const diags = (main: string) => program(main).diagnostics.map((d) => [d.code, d.message, d.help]);

test('an import goes by its alias, and its own name is free', () => {
  const r = program('module m\nimport "geo" as g\nfn f(geo: int) -> g.Point {\n  let p: g.Point = g.origin()\n  return g.Point { ...p, x: geo }\n}\n');
  expect(r.diagnostics).toEqual([]);
  expect(r.go).toContain('geo__Point');
  expect(diags('module m\nimport "geo" as g\nfn f() -> int {\n  return geo.origin().x\n}\n')).toEqual([
    ['CAN0002', 'cannot find `geo`', 'this file imports `geo` as `g`; write `g`'],
  ]);
});

test('the clash with a local points at `as`', () => {
  expect(diags('module m\nimport "bytes"\nfn f() -> int {\n  let bytes = 1\n  return bytes\n}\n')).toEqual([
    ['CAN0016', '`bytes` is the name of an imported module', 'Candor has no shadowing; pick another name, or import the module under another, `import "bytes" as b`'],
  ]);
});

test('an alias is imported once and is not the module itself', () => {
  expect(diags('module m\nimport "geo"\nimport "geo" as g\n').map(([, m]) => m)).toEqual(['`geo` is imported twice']);
  expect(diags('module m\nimport "geo" as m\n').map(([, m]) => m)).toEqual(['a module cannot import a module with its own name, `m`']);
});

test('`\\u{..}` escapes a code point; a bad one is an error with help', () => {
  expect(program('module m\nconst esc = "\\u{1b}[0m \\u{e9}"\nconst c = \'\\u{1F600}\'\n').diagnostics).toEqual([]);
  for (const bad of ['\\u{110000}', '\\u{d800}', '\\u1b', '\\u{}', '\\u{1234567}']) {
    const d = program(`module m\nconst s = "${bad}"\n`).diagnostics;
    expect(d.map((x) => x.code)).toEqual(['CAN0001']);
    expect(d[0].help).toContain('`\\u{1b}`');
  }
});

test('the new methods, run', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'small-gaps');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gaps.candor');
  writeModule(
    file,
    `module gaps

import "bytes" as b

fn parse(s: string) -> Result<int, string> {
  return match s.toInt() {
    none => Err("not a number: \${s}"),
    n => Ok(n),
  }
}

test "escapes" {
  let esc = "\\u{1b}[1mhi\\u{1b}[0m"
  assert esc.chars().first() == 27.toChar()
  assert esc.toBytes().slice(0, 2) == (b.fromHex("1b5b") ?? "".toBytes())
  assert esc.length() == 10
  assert "caf\\u{e9}" == "café"
  assert '\\u{1F600}'.code() == 128512
  // Go refuses a raw byte order mark in the middle of its source (yarr, 0.0.24).
  assert "\\u{feff}x".startsWith("\\u{feff}")
  assert '\\u{feff}'.code() == 65279
}

test "lastIndexOf" {
  assert "a/b/c.tar.gz".lastIndexOf(".") == 9
  assert "a/b/c.tar.gz".lastIndexOf("/") == 3
  assert "héhé".lastIndexOf("é") == 3
  assert "abc".lastIndexOf("x") == none
  let bytes = "abab".toBytes()
  assert bytes.lastIndexOf("ab".toBytes()) == 2
  assert bytes.lastIndexOf("x".toBytes()) == none
}

test "isOk and isErr" {
  assert parse("12").isOk()
  assert parse("x").isErr()
  assert !parse("x").isOk()
}
`,
  );
  const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('3 passed');
}, 120_000);
