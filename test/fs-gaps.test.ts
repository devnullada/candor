import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 086: `fs.within`, `info`, `rename`, `copy`, `removeAll`. The same code runs on disk and
// against the fake.

const root = path.join(import.meta.dir, '..');
const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function candor(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['run', path.join(root, 'src', 'cli.ts'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const app = `module gaps

import "fs"

fn show(r: Result<void, fs.FsError>) -> string {
  return match r {
    Ok() => "ok",
    Err(e) => "\${e}",
  }
}

fn describe(path: string) -> string uses fs {
  return match fs.info(path) {
    Ok(i) => {
      let kind = if i.isDir { "dir" } else { "file" }
      "\${path} \${i.size} \${kind}"
    },
    Err(e) => "\${e}",
  }
}

fn names(path: string) -> string uses fs {
  return match fs.list(path) {
    Ok(xs) => xs.join(","),
    Err(e) => "\${e}",
  }
}

fn text(path: string) -> string uses fs {
  return match fs.read(path) {
    Ok(t) => t,
    Err(e) => "\${e}",
  }
}

// Each step's outcome, the same on disk and in memory.
fn exercise() -> List<string> uses fs {
  let mut out: List<string> = []
  out.push(show(fs.removeAll("w")))
  out.push(show(fs.makeDir("w/a/b")))
  out.push(show(fs.write("w/a/b/one.txt", "hello")))
  out.push(show(fs.writeBytes("w/a/two.bin", "été".toBytes())))
  out.push(describe("w/a/b/one.txt"))
  out.push(describe("w/a/two.bin"))
  out.push(describe("w/a"))
  out.push(describe("w/none"))
  out.push(show(fs.copy("w/a/b/one.txt", "w/copy.txt")))
  out.push(show(fs.copy("w/a", "w/x")))
  out.push(show(fs.copy("w/none", "w/x")))
  out.push(show(fs.rename("w/copy.txt", "w/moved.txt")))
  out.push(show(fs.rename("w/a", "w/c")))
  out.push(show(fs.rename("w/none", "w/y")))
  out.push(show(fs.rename("w/moved.txt", "w/c/two.bin")))
  out.push(names("w"))
  out.push(names("w/c"))
  out.push(text("w/c/b/one.txt"))
  out.push(text("w/c/two.bin"))
  out.push(show(fs.removeAll("w/c")))
  out.push(show(fs.removeAll("w/c")))
  out.push(names("w"))
  out.push(show(fs.removeAll(".")))
  out.push(show(fs.removeAll("../..")))
  out.push(show(fs.removeAll("w")))
  out.push("\${fs.exists("w")}")
  return out
}

fn main() uses io, fs {
  for line in exercise() {
    io.println(line)
  }
}

fn expected() -> List<string> {
  return [
  "ok",
  "ok",
  "ok",
  "ok",
  "w/a/b/one.txt 5 file",
  "w/a/two.bin 5 file",
  "w/a 0 dir",
  "w/none: not found",
  "ok",
  "w/a: is a directory",
  "w/none: not found",
  "ok",
  "ok",
  "w/none: not found",
  "ok",
  "c",
  "b,two.bin",
  "hello",
  "hello",
  "ok",
  "ok",
  "",
  ".: refusing to remove a root or the working directory",
  "../..: refusing to remove a root or the working directory",
  "ok",
  "false",
]
}

test "the same steps against memory" {
  assert exercise() == expected()
}

test "within keeps a path inside its root" {
  assert fs.within("public", "css/site.css") == "public/css/site.css"
  assert fs.within("public", "/css/./site.css") == none
  assert fs.within("public", "a/../b.txt") == "public/b.txt"
  assert fs.within("public", "") == "public"
  assert fs.within("public", "..") == none
  assert fs.within("public", "a/../../etc/passwd") == none
  assert fs.within("public", "..\\\\secret") == none
  assert fs.within("public", "a\\\\b.txt") == "public/a/b.txt"
  assert fs.within("public", "C:/Windows") == none
  assert fs.within("public", "file.txt:stream") == none
  assert fs.within("/srv/www", "index.html") == "/srv/www/index.html"
}

test "info's modified is the test's time at the write" {
  assert fs.write("a.txt", "x") == Ok()
  clock.advance(5000)
  assert fs.makeDir("d") == Ok()
  clock.advance(5000)
  assert fs.append("a.txt", "yz") == Ok()
  let a = fs.info("a.txt")
  assert a == Ok(fs.FileInfo { size: 3, modified: 10000, isDir: false })
  assert fs.info("d") == Ok(fs.FileInfo { size: 0, modified: 5000, isDir: true })
  assert fs.rename("d", "a.txt") == Err(fs.FsError.Failed { path: "d", message: "file exists" })
  assert fs.makeDir("d/e") == Ok()
  assert fs.rename("d", "d/e/f") == Err(fs.FsError.Failed { path: "d", message: "invalid argument" })
}
`;

test('the same code on disk and in memory', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'fs-gaps');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 'gaps.candor'), app);
  const run = candor(dir, 'run', 'gaps.candor');
  expect(run.stderr).toBe('');
  const lines = run.stdout.replace(/\r\n/g, '\n').split('\n');
  // Fill the expected list from the program itself: it is the list `expected` holds.
  const expected = [...app.matchAll(/^  return \[\n([\s\S]*?)\n\]/gm)][0][1]
    .split('\n')
    .map((l) => JSON.parse(l.trim().replace(/,$/, '')));
  expect(lines.slice(0, -1)).toEqual(expected);
  expect(existsSync(path.join(dir, 'w'))).toBe(false);

  const t = candor(dir, 'test', 'gaps.candor');
  expect(t.stdout).toContain('3 passed, 0 failed');
}, 120_000);
