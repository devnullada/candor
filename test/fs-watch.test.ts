import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 108: `fs.watch` folds over changes under a directory, debounced and recursive, over
// fsnotify in `main` and the test's own writes in a test; `fs.join` keeps the root's separator;
// `b.toRawText()` keeps any bytes.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(cmd: 'run' | 'test', name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', `fs-watch-${name}`);
  for (const d of ['w', 'w2']) rmSync(path.join(dir, d), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'w'), { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 180_000,
  });
}

test('in a test, the writes are the changes, and Stop ends the watch', () => {
  const r = cli(
    'test',
    'memory',
    `module m

import "fs"

// The changes under \`dir\`, until \`n\` of them.
fn collect(dir: string, n: int) -> Result<List<string>, fs.FsError> uses fs {
  let empty: List<string> = []
  return fs.watch(dir, empty, (seen, c) => {
    let all = seen.concat(["\${c.kind} \${c.path}"])
    return if all.length() == n { .Stop { value: all } } else { .Continue { value: all } }
  })
}

fn writes() -> Result<void, fs.FsError> uses fs, clock {
  clock.sleep(1)
  fs.write("w/a.txt", "1")?
  fs.write("w/a.txt", "2")?
  fs.makeDir("w/d/e")?
  fs.write("w/d/e/f.txt", "x")?
  fs.write("elsewhere.txt", "x")?
  fs.rename("w/a.txt", "w/b.txt")?
  fs.removeAll("w/d")?
  return Ok()
}

test "a watch sees each write under it" {
  assert fs.makeDir("w") == Ok()
  assert tasks.both(() => collect("w", 10), () => writes()).map((p) => p.0) == Ok( ["created a.txt", "changed a.txt", "created d", "created d/e", "created d/e/f.txt", "removed a.txt", "created b.txt", "removed d/e/f.txt", "removed d/e", "removed d"])
}

test "a watch of a missing directory is an Err" {
  assert collect("nope", 1) == Err(fs.FsError.NotFound { path: "nope" })
  assert collect("w/nope.json", 1) == Err(fs.FsError.NotFound { path: "w/nope.json" })
}

test "a file's watch sees that file alone, and outlives its removal" {
  assert fs.makeDir("w/sub") == Ok()
  assert fs.write("w/hooks.json", "[]") == Ok()
  let got = tasks.both(() => collect("w/hooks.json", 3), (): Result<void, fs.FsError> => {
    clock.sleep(1)
    fs.write("w/other.txt", "x")?
    fs.write("w/sub/hooks.json", "x")?
    fs.write("w/hooks.json", "[1]")?
    fs.remove("w/hooks.json")?
    fs.write("w/hooks.json", "[2]")?
    return Ok()
  })
  assert got.map((p) => p.0) == Ok(["changed hooks.json", "removed hooks.json", "created hooks.json"])
}

test "removing the directory watched ends it with an Err" {
  assert fs.makeDir("w") == Ok()
  let got = tasks.both(() => collect("w", 5), (): Result<void, fs.FsError> => {
    clock.sleep(1)
    fs.write("w/x", "1")?
    fs.removeAll("w")?
    return Ok()
  })
  assert got.map((p) => p.0) == Err(fs.FsError.NotFound { path: "w" })
}

test "a watch nothing changes is a deadlock that says why" {
  assert fs.makeDir("w") == Ok()
  assert collect("w", 1).isOk()
}
`,
  );
  const out = r.stdout + r.stderr;
  expect(out).toContain('4 passed, 1 failed');
  expect(out).toContain('is a watch waiting for a change no task makes?');
});

test('fs.join keeps the root separator; toRawText keeps the bytes', () => {
  const r = cli(
    'test',
    'join',
    `module m

import "fs"
import "bytes"

test "join" {
  assert fs.join("D:\\\\Sounds", "takes/kick.wav") == "D:\\\\Sounds\\\\takes\\\\kick.wav"
  assert fs.join("public", "css/site.css") == "public/css/site.css"
  assert fs.join("public/", "./a/../b") == "public/b"
  assert fs.join("\\\\\\\\nas\\\\share", "a") == "\\\\\\\\nas\\\\share\\\\a"
  assert fs.join("", "a/b") == "a/b"
  assert fs.join("D:\\\\Sounds", "..") == "D:\\\\"
  assert fs.join("D:\\\\Sounds", "../../..") == "D:\\\\"
  assert fs.join("D:/", "a") == "D:/a"
  assert fs.join("\\\\\\\\nas\\\\share\\\\x", "../..") == "\\\\\\\\nas\\\\share\\\\"
  assert fs.join("/srv", "../..") == "/"
}

test "toRawText" {
  let b = bytes.fromList([255, 0, 65])
  assert b.toText() == none
  assert b.toRawText().toBytes() == b
}
`,
  );
  expect(r.stdout + r.stderr).toContain('2 passed');
});

test('fsnotify is required only by a program that calls fs.watch, and never in a test', () => {
  const dir = path.join(tmpdir(), 'candor-test', 'fs-watch-requires');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 't.candor');
  const watching = `module m\n\nimport "fs"\n\nfn main() uses fs {\n  fs.watch(".", 0, (n, c) => .Stop { value: n })\n}\n`;
  const plain = `module m\n\nimport "fs"\n\nfn main() uses fs, io {\n  io.println(fs.join("a", "b"))\n}\n`;
  const fsnotify = (src: string, mode: 'main' | 'test') => compileSplit(src, file, mode).goRequires.some((r) => r.path === 'github.com/fsnotify/fsnotify');
  expect(fsnotify(watching, 'main')).toBe(true);
  expect(fsnotify(watching, 'test')).toBe(false);
  expect(fsnotify(plain, 'main')).toBe(false);
  expect(compileSplit(plain, file, 'main').go).not.toContain('watchgo');
});

test('a real watch: debounced, recursive, relative paths', () => {
  const r = cli(
    'run',
    'real',
    `module m

import "fs"

fn main() -> Result<void, fs.FsError> uses fs, tasks, clock, io {
  let empty: List<string> = []
  let (seen, _) = tasks.both(() => fs.watch("w", empty, (seen, c) => {
    let all = seen.concat(["\${c.kind} \${c.path}"])
    return if all.length() == 6 { .Stop { value: all } } else { .Continue { value: all } }
  }), (): Result<void, fs.FsError> => {
    clock.sleep(300)
    for i in 0..5 {
      fs.write("w/a.txt", "\${i}")?
    }
    clock.sleep(400)
    fs.makeDir("w/d")?
    fs.write("w/d/f.txt", "x")?
    clock.sleep(400)
    fs.write("w/d/f.txt", "y")?
    clock.sleep(400)
    fs.write("w/gone.txt", "x")?
    fs.remove("w/gone.txt")?
    fs.removeAll("w/d")?
    return Ok()
  })?
  for s in seen {
    io.println(s)
  }
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n')).toEqual(['created a.txt', 'created d', 'created d/f.txt', 'changed d/f.txt', 'removed d/f.txt', 'removed d']);
}, 180_000);

test('a real watch of a file: other files ignored, a save by rename is a change', () => {
  const r = cli(
    'run',
    'file',
    `module m

import "fs"

fn main() -> Result<void, fs.FsError> uses fs, tasks, clock, io {
  fs.write("w/hooks.json", "[]")?
  let empty: List<string> = []
  let (seen, _) = tasks.both(() => fs.watch("w/hooks.json", empty, (seen, c) => {
    let all = seen.concat(["\${c.kind} \${c.path}"])
    return if all.length() == 4 { .Stop { value: all } } else { .Continue { value: all } }
  }), (): Result<void, fs.FsError> => {
    clock.sleep(300)
    fs.write("w/other.txt", "x")?
    fs.write("w/hooks.json", "[1]")?
    clock.sleep(400)
    fs.write("w/hooks.json.tmp", "[2]")?
    fs.rename("w/hooks.json.tmp", "w/hooks.json")?
    clock.sleep(400)
    fs.remove("w/hooks.json")?
    clock.sleep(400)
    fs.write("w/hooks.json", "[3]")?
    return Ok()
  })?
  for s in seen {
    io.println(s)
  }
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n')).toEqual(['changed hooks.json', 'changed hooks.json', 'removed hooks.json', 'created hooks.json']);
}, 180_000);

// On Windows a handle on each watched directory kept it from being moved or removed: a watch
// holds one, on the directory watched, and that one doesn't stop it moving either.
test('a real watch leaves what it watches free to move and remove', () => {
  const r = cli(
    'run',
    'free',
    `module m

import "fs"

fn main() -> Result<void, fs.FsError> uses fs, tasks, clock, io {
  fs.makeDir("w/a/b/c")?
  fs.write("w/a/b/c/f.txt", "x")?
  let (_, moved) = tasks.both(() => fs.watch("w", 0, (n, c) => if c.kind == .Removed && c.path == "moved" {
    .Stop { value: n }
  } else {
    .Continue { value: n + 1 }
  }), (): Result<string, fs.FsError> => {
    clock.sleep(300)
    fs.rename("w/a", "w/moved")?
    clock.sleep(400)
    fs.removeAll("w/moved")?
    return Ok("moved and removed")
  })?
  io.println(moved)
  let (gone, renamed) = tasks.both(() => match fs.watch("w", 0, (n, c) => .Continue { value: n }) {
    Ok(_) => "ended",
    Err(e) => e.toString(),
  }, () => {
    clock.sleep(300)
    return match fs.rename("w", "w2") {
      Ok() => "renamed",
      Err(e) => e.toString(),
    }
  })
  io.println("\${gone}, \${renamed}")
  return Ok()
}
`,
  );
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n')).toEqual(['moved and removed', 'w: not found, renamed']);
}, 180_000);
