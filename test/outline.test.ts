import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { outline } from '../src/outline';

const src = `module shop

import "json"

// What a shop sells.
pub struct Item {
  pub name: string
  price: int
}

enum Size { Small, Large { inches: int } }

const limit = 20

trait Priced {
  fn price(self) -> int
}

impl Priced for Item {
  fn price(self) -> int {
    return self.price
  }
}

impl Json for Item

pub fn total(items: List<Item>) -> int
  requires items.len() <= limit
{
  let mut sum = 0
  for i in items {
    sum += i.price
  }
  return sum
}

test fn item(price: int) -> Item {
  return Item { name: "x", price: price }
}

test "totals" {
  assert total([item(2), item(3)]) == 5
}

test "empty" {
  assert total([]) == 0
}
`;

test('an outline has every declaration, its lines, and no bodies', () => {
  expect(outline(src, 'shop.candor')).toBe(`shop.candor: module shop, 47 lines
imports json
 6-9   pub struct Item { pub name: string, price: int }
11-11  enum Size { Small, Large { inches: int } }
13-13  const limit = 20
15-17  trait Priced
16-16    fn price(self) -> int
19-23  impl Priced for Item
20-22    fn price(self) -> int
25-25  impl Json for Item
27-35  pub fn total(items: List<Item>) -> int requires items.len() <= limit
2 tests and 1 test fn: 9 lines, between lines 37 and 47 (\`candor outline --tests shop.candor\` lists them)
`);
});

test('--tests lists the tests and test fns in their place', () => {
  const text = outline(src, 'shop.candor', true);
  expect(text).toContain('37-39  test fn item(price: int) -> Item\n41-43  test "totals"\n45-47  test "empty"\n');
  expect(text).not.toContain('between lines');
});

test('a private function shows its name only, unless --full', () => {
  const code = `module m

pub fn open(path: string) -> Result<string, string> uses fs {
  return checked(path)
}

fn checked(path: string) -> Result<string, string> uses fs {
  return Ok(path)
}
`;
  expect(outline(code, 'm.candor')).toContain('3-5  pub fn open(path: string) -> Result<string, string> uses fs\n7-9  fn checked\n');
  expect(outline(code, 'm.candor', false, true)).toContain('7-9  fn checked(path: string) -> Result<string, string> uses fs\n');
});

test('a file without a module line says so', () => {
  expect(outline('fn main() {}\n', 'x.candor')).toContain('no module line');
});

test('candor outline takes folders, as check does, and is far smaller than the source', () => {
  const root = path.join(import.meta.dir, '..');
  const run = spawnSync('bun', ['src/cli.ts', 'outline', 'std/exec.candor', 'std/fs.candor'], { cwd: root, encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain('std/exec.candor: module exec');
  expect(run.stdout).toContain('\n\nstd/fs.candor: module fs');
  expect(run.stdout).toMatch(/\d+-\d+ +effect exec\n/);
  expect(run.stdout.length).toBeLessThan(readFileSync(path.join(root, 'std/exec.candor'), 'utf8').length / 2 + readFileSync(path.join(root, 'std/fs.candor'), 'utf8').length);
});

test('a test file lists its tests; its module says where they are (#240e482c)', () => {
  const root = path.join(import.meta.dir, '..');
  expect(outline('module m\n\ntest "a" {\n  assert true\n}\n', 'm_test.candor')).toBe('m_test.candor: module m, 5 lines\n3-5  test "a"\n');
  const run = spawnSync('bun', ['src/cli.ts', 'outline', 'examples/todos.candor'], { cwd: root, encoding: 'utf8' });
  expect(run.stdout).toEndWith('5 tests in examples/todos_test.candor (`candor outline examples/todos_test.candor` lists them)\n');
  const both = spawnSync('bun', ['src/cli.ts', 'outline', 'examples/todos.candor', 'examples/todos_test.candor'], { cwd: root, encoding: 'utf8' });
  expect(both.stdout).not.toContain('lists them');
  expect(both.stdout).toContain('test "missing todos are 404"');
});
