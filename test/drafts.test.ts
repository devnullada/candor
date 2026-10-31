import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { candorName, checkExterns, draft, type GoFunc, type GoPackage, type GoType } from '../src/bind';
import { compile } from '../src/compile';

const program = (main: string, files: Record<string, string>) => compile(main, 'main.candor', 'main', { read: (f) => files[f] ?? null });
const diags = (files: Record<string, string>, main = 'module m\nimport "lib"\nfn main() {\n}\n') =>
  program(main, files).diagnostics.map((d) => [d.code, d.message, d.help]);
const lib = (body: string) => ({ 'lib.candor': `module lib\n${body}` });

describe('versions', () => {
  test('a third-party package names its version', () => {
    expect(diags(lib('extern "github.com/dustin/go-humanize" {\n  fn Comma(v: int) -> string as comma\n}\n'))).toEqual([
      [
        'CAN0042',
        "`github.com/dustin/go-humanize` is not in Go's standard library, so the binding names its version",
        'as in `extern "github.com/dustin/go-humanize@v1.2.3"`: the version the binding was written against (`go list -m -versions` lists them)',
      ],
    ]);
    expect(diags(lib('extern "github.com/dustin/go-humanize@v1.0.1" {\n  fn Comma(v: int) -> string as comma\n}\n'))).toEqual([]);
  });

  test('an exact one', () => {
    expect(diags(lib('extern "github.com/dustin/go-humanize@latest" {\n  fn F() -> int as f\n}\n')).map(([c, m]) => [c, m])).toEqual([['CAN0042', '`latest` is not an exact version']]);
    expect(diags(lib('extern "example.com/x@v1.2.3-pre.1+build" {\n  fn F() -> int as f\n}\n'))).toEqual([]);
  });

  test('the standard library and local packages have none', () => {
    expect(diags(lib('extern "strconv@v1.0.0" {\n  fn F() -> int as f\n}\n'))).toEqual([['CAN0042', '`strconv` comes with Go, so it has no version', 'write `extern "strconv"`']]);
    expect(diags(lib('extern "./native@v1.0.0" {\n  fn F() -> int as f\n}\n')).map(([, m]) => m)).toEqual(['a Go package next to the binding has no version']);
  });

  test('one version of a package per program', () => {
    const files = {
      'a.candor': 'module a\nextern "example.com/x@v1.0.0" {\n  fn F() -> int as f\n}\n',
      'b.candor': 'module b\nextern "example.com/x@v1.1.0" {\n  fn F() -> int as f\n}\n',
    };
    expect(diags(files, 'module m\nimport "a"\nimport "b"\nfn main() {\n}\n')).toEqual([
      ['CAN0042', '`example.com/x` is bound at v1.1.0 here and at v1.0.0 in a.candor', 'a program uses one version of each Go package: bind the same one everywhere'],
    ]);
    const same = { ...files, 'b.candor': files['b.candor'].replace('v1.1.0', 'v1.0.0') };
    const r = program('module m\nimport "a"\nimport "b"\nfn main() {\n}\n', same);
    expect(r.diagnostics).toEqual([]);
    expect(r.goRequires).toEqual([{ path: 'example.com/x', version: 'v1.0.0' }]);
  });
});

describe('unvetted', () => {
  test('the checker refuses it until someone decides', () => {
    expect(diags(lib('extern "strconv" {\n  unvetted fn Itoa(i: int) -> string as itoa\n}\n'))).toEqual([
      [
        'CAN0044',
        'nobody has decided yet whether the Go function `Itoa` is pure',
        "if it does no I/O, keeps no global state, never blocks and can't exit the program, delete `unvetted`; otherwise move it into `effect lib { ... }`, where only the effect's operations call it",
      ],
    ]);
    // A context is one more reason to move it, not a second error.
    expect(diags(lib('extern "./native" {\n  unvetted fn Get(ctx, url: string) -> string as get\n}\n')).map(([c]) => c)).toEqual(['CAN0044']);
  });
});

test('Candor names for Go names', () => {
  expect(['Comma', 'FormatInt', 'URLEncode', 'IBytes', 'SI', 'Match', 'X'].map(candorName)).toEqual([
    'comma',
    'formatInt',
    'urlEncode',
    'iBytes',
    'si',
    'matchGo',
    'x',
  ]);
});

const t = (kind: GoType['kind'], text: string = kind): GoType => ({ kind, text });
const fn = (name: string, params: [string, GoType][], results: GoType[], extra: Partial<GoFunc> = {}): GoFunc => ({
  name,
  params: params.map(([n, type]) => ({ name: n, type })),
  results,
  variadic: false,
  text: `func(${params.map(([n, ty]) => `${n} ${ty.text}`).join(', ')}) ${results.map((r) => r.text).join(', ')}`.trim(),
  ...extra,
});
const fake: GoPackage = {
  path: 'example.com/kit',
  name: 'kit',
  errors: [],
  funcs: [
    fn('Atoi', [['s', t('string')]], [t('int'), t('error')], { doc: 'Atoi parses an int.' }),
    fn('Fetch', [['ctx', t('context', 'context.Context')], ['url', t('string')]], [t('string'), t('error')]),
    fn('Join', [['parts', t('[]string')], ['type', t('string')]], [t('string')]),
    fn('Log', [['err', t('error')]], []),
    fn('Validate', [['s', t('string')]], [t('error')]),
    fn('Sum', [], [t('int')], { variadic: true, rest: t('int'), text: 'func(xs ...int) int' }),
    fn('Now', [], [t('other', 'time.Time')]),
  ],
  values: [
    { name: 'ErrRange', type: t('error'), const: false },
    { name: 'Max', type: t('int', 'untyped int'), const: true },
    { name: 'Verbose', type: t('bool'), const: false },
  ],
  types: [],
};

describe('drafts', () => {
  const text = draft(fake, { module: 'kit', goPath: 'example.com/kit', version: 'v1.0.0' });

  test('every function that fits, unvetted, and why the rest are left out', () => {
    expect(text).toContain('extern "example.com/kit@v1.0.0" {\n  // Atoi parses an int.\n  unvetted fn Atoi(s: string) -> Result<int, GoError> as atoi\n');
    expect(text).toContain('  unvetted fn Fetch(ctx, url: string) -> Result<string, GoError> as fetch\n');
    expect(text).toContain('  unvetted fn Join(parts: List<string>, type: string) -> string as join\n');
    expect(text).toContain('  unvetted fn Log(err: GoError) as log\n');
    expect(text).toContain('  let ErrRange: GoError as errRange\n  let Max: int as max\n}');
    expect(text).toContain('  unvetted fn Validate(s: string) -> Result<void, GoError> as validate\n');
    expect(text).toContain('// - Sum(xs ...int) int: variadic: bind it at the arity you call it with, as in `...(id: int, name: string)`');
    expect(text).toContain("// - Now() time.Time: a time.Time can't cross into Candor yet");
    expect(text).toContain('// - Verbose bool: a Go variable is global state; bind a function that reads it instead');
  });

  test('is refused as it is, and checks once vetted', () => {
    expect(diags({ 'kit.candor': text }, 'module m\nimport "kit"\nfn main() {\n}\n').map(([c]) => c)).toEqual(['CAN0044', 'CAN0044', 'CAN0044', 'CAN0044', 'CAN0044']);
    const vetted = text.replace(/unvetted fn Fetch.*\n/, '').replaceAll('unvetted ', '');
    const r = program('module m\nimport "kit"\nfn main() {\n}\n', { 'kit.candor': vetted });
    expect(r.diagnostics).toEqual([]);
    // Each binding fits the Go it was drafted from.
    expect(checkExterns(r.externs, new Map([['example.com/kit', fake]]))).toEqual([]);
  });
});

describe('bindings against Go types', () => {
  const check = (body: string) => {
    const r = program('module m\nimport "kit"\nfn main() {\n}\n', { 'kit.candor': `module kit\nextern "example.com/kit@v1.0.0" {\n${body}\n}\n` });
    expect(r.diagnostics).toEqual([]);
    return checkExterns(r.externs, new Map([['example.com/kit', fake]])).map((d) => [d.code, d.message, d.help]);
  };

  test('a signature that does not fit says what would', () => {
    expect(check('  fn Atoi(s: string) -> int as atoi')).toEqual([
      ['CAN0045', "the Go function `Atoi` is `func(s string) int, error`, which does not fit this binding's signature", 'write `fn Atoi(s: string) -> Result<int, GoError>`'],
    ]);
    expect(check('  fn Join(parts: List<string>, sep: int) -> string as join')[0][2]).toBe('write `fn Join(parts: List<string>, type: string) -> string`');
  });

  test('names Go does not have', () => {
    expect(check('  fn Atoii(s: string) -> Result<int, GoError> as atoi')).toEqual([['CAN0045', '`example.com/kit` has no function `Atoii`', 'did you mean `Atoi`?']]);
    expect(check('  fn Max() -> int as max')[0][2]).toBe('`Max` is a constant: bind it with `let`');
    expect(check('  let Atoi: int as atoi')[0][2]).toBe('`Atoi` is a function: bind it with `fn`');
  });

  test('values', () => {
    expect(check('  let ErrRange: GoError as errRange\n  let Max: int as max')).toEqual([]);
    expect(check('  let Max: string as max')).toEqual([['CAN0045', 'the Go constant `Max` has type `untyped int`, which does not fit string', 'write `let Max: int`']]);
  });

  test('variadic Go functions, at the arity they are called with', () => {
    expect(check('  fn Sum(xs: int) -> int as sum')[0].slice(1)).toEqual([
      'the Go function `Sum` is `func(xs ...int) int`: variadic',
      'after its other parameters, write what goes into the last one, as many as you pass: `...(a: int, b: int)`',
    ]);
    expect(check('  fn Sum(...(a: int, b: int)) -> int as sum2')).toEqual([]);
    expect(check('  fn Sum(...(a: string)) -> int as sum2')[0][1]).toBe("the Go function `Sum` is `func(xs ...int) int`, which does not fit this binding's signature");
    expect(check('  fn Atoi(...(s: string)) -> Result<int, GoError> as atoi')[0][2]).toBe('drop the `...(...)`');
  });
});

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cli = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, CANDOR_GO: go } });

describe('candor bind', () => {
  test(
    "a draft of Go's strconv, vetted, checks against Go and builds",
    () => {
      const dir = path.join(tmpdir(), 'candor-test', 'draft-strconv');
      mkdirSync(path.join(dir, 'lib'), { recursive: true });
      const r = cli(dir, 'bind', 'strconv');
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('  unvetted fn Atoi(s: string) -> Result<int, GoError> as atoi\n');
      writeFileSync(path.join(dir, 'lib', 'strconv.candor'), r.stdout.replaceAll('unvetted ', ''));
      writeFileSync(path.join(dir, 'm.candor'), 'module m\nimport "lib/strconv"\nfn main() uses io {\n  io.println(strconv.itoa(42) + " " + strconv.quote("hi"))\n}\n');
      const run = cli(dir, 'run', 'm.candor', '--out', path.join(dir, 'out'));
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe('42 "hi"\n');
    },
    120_000,
  );

  test('a third-party package needs a version', () => {
    const r = cli(tmpdir(), 'bind', 'github.com/dustin/go-humanize');
    expect(r.stderr).toContain('candor: name a version, as in github.com/dustin/go-humanize@latest');
    expect(r.status).toBe(1);
  }, 60_000);
});
