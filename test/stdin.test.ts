import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `io.readLine` and `io.readAll` read standard input; in tests, what `io.setInput` gives.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(name: string, src: string, input: string, ...args: string[]) {
  const dir = path.join(tmpdir(), 'candor-test', 'stdin', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CANDOR_GO: go },
  });
}

const counter = `module m

fn main() uses io {
  let mut n = 0
  while true {
    match io.readLine() {
      none => break
      line => {
        n += 1
        io.println("\${n}: \${line}")
      }
    }
  }
  io.print("rest: [\${io.readAll()}]")
}

test "reads what setInput gives" {
  io.setInput("a\\r\\n\\nb")
  main()
  assert io.output() == "1: a\\n2: \\n3: b\\nrest: []"
}

test "no input" {
  main()
  assert io.output() == "rest: []"
}
`;

test('readLine reads standard input line by line, to none at the end', () => {
  const r = cli('lines', counter, 'one\r\ntwo\n\nlast', 'run');
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('1: one\n2: two\n3: \n4: last\nrest: []');
}, 60_000);

test('the fake reads only what setInput gives', () => {
  const r = cli('lines-test', counter, 'ignored\n', 'test');
  expect(r.stdout).toContain('2 passed, 0 failed');
}, 60_000);

test('readAll after readLine gets the rest', () => {
  const src = 'module m\n\nfn main() uses io {\n  let first = io.readLine()\n  io.print("${first == "h"} [${io.readAll()}]")\n}\n';
  const r = cli('all', src, 'h\nx\ny\n', 'run');
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('true [x\ny\n]');
}, 60_000);
