import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `candor debug` builds without optimizing and runs the program under Delve. The
// `//line` directives put Candor's lines in the binary: a breakpoint takes `app.candor:N`, the
// stack shows Candor lines, and locals keep their Candor names. Skipped where dlv isn't installed.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dlvName = process.platform === 'win32' ? 'dlv.exe' : 'dlv';
const gopath = spawnSync(go, ['env', 'GOPATH'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const haveDlv = spawnSync(dlvName, ['version']).status === 0 || existsSync(path.join(gopath, 'bin', dlvName));

const app = `module app

struct Item {
  name: string
  count: int
}

fn total(items: List<Item>) -> int {
  let mut sum = 0
  for item in items {
    sum += item.count
  }
  return sum
}

fn main() uses io {
  let items = [Item { name: "cup", count: 2 }, Item { name: "tea", count: 3 }]
  io.println("\${total(items)}")
}
`;

test.skipIf(!haveDlv)('a breakpoint at a Candor line stops there, and locals print by their names', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'debug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.candor'), app);
  writeFileSync(path.join(dir, 'cmds.txt'), 'break app.candor:11\ncontinue\ncontinue\nlocals\nbt\nexit\n');
  const r = spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), 'debug', 'app.candor', '--init', 'cmds.txt'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go, NO_COLOR: '1' },
    input: '',
  });
  // Delve colours its listing; the plain text is what matters.
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  expect(out).toContain('Breakpoint 1 set at');
  expect(out).toMatch(/main\.app__total\(\) .*app\.candor:11/);
  // The second time round: the first item added, the second in hand.
  expect(out).toContain('sum = 2');
  expect(out).toContain('item = main.app__Item {name: "tea", count: 3}');
  expect(out).toMatch(/in main\.app__main\s+at .*app\.candor:18/);
}, 120_000);

test('debug takes a file, and its arguments after --', () => {
  const r = spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), 'debug'], { encoding: 'utf8' });
  expect(r.stderr).toContain('debug needs a file');
});
