import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `fs.readRange` reads a part of a file, clamped like `slice`; a file `http.serveFile`
// answers is sent from disk by the server, which answers `Range` (206, 416). In a test the
// file is in memory and the whole file is the body.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
function cli(cmd: 'run' | 'test', src: string) {
  const dir = path.join(tmpdir(), 'candor-test', `fs-read-range-${cmd}`);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), cmd, 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const src = `module m

import "fs"
import "http"

fn part(path: string, offset: int, length: int) -> string uses fs {
  return match fs.readRange(path, offset, length) {
    Ok(b) => "[\${b.toText() ?? "?"}]",
    Err(e) => e.toString(),
  }
}

fn handle(req: http.Request) -> http.Response uses fs {
  return http.serveDir("public", req.path.slice(1))
}

fn get(url: string, range: string?) -> string uses http {
  let headers: Map<string, string> = match range {
    none => [:],
    r => ["range": r],
  }
  return match http.send(http.ClientRequest { ...http.request("GET", url), headers }) {
    Ok(res) => "\${res.status} \${res.headers["content-range"] ?? "-"} \${res.headers["accept-ranges"] ?? "-"} \${res.body.length()} \${res.body.slice(0, 10)}",
    Err(e) => "failed: \${e}",
  }
}

fn calls(base: string) -> List<string> uses http, clock {
  for _ in 0..100 {
    match http.get("\${base}/data.txt") {
      Ok(_) => return [
        get("\${base}/data.txt", none),
        get("\${base}/data.txt", "bytes=10-19"),
        get("\${base}/data.txt", "bytes=9995-"),
        get("\${base}/data.txt", "bytes=-3"),
        get("\${base}/data.txt", "bytes=20000-"),
        get("\${base}/missing.txt", "bytes=0-1"),
      ],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() -> Result<void, fs.FsError> uses io, fs, http, tasks, clock {
  fs.removeAll("public")?
  fs.makeDir("public")?
  fs.write("public/data.txt", "0123456789".repeat(1000))?
  io.println(part("public/data.txt", 0, 4))
  io.println(part("public/data.txt", 9998, 10))
  io.println(part("public/data.txt", 20000, 5))
  io.println(part("public/data.txt", -5, 3))
  io.println(part("public/data.txt", 3, -1))
  io.println(part("public", 0, 1))
  io.println(part("nope.txt", 0, 1))
  let lines = tasks.race([
    () => match http.serve("127.0.0.1:18656", handle) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => calls("http://127.0.0.1:18656"),
  ])
  for line in lines {
    io.println(line)
  }
  return Ok()
}

test "in memory: readRange, and serveFile gives the whole file" {
  assert fs.makeDir("public") == Ok()
  assert fs.write("public/a.txt", "abcdef") == Ok()
  assert fs.readRange("public/a.txt", 2, 3).map((b) => b.toText()) == Ok("cde")
  assert fs.readRange("public/a.txt", 4, 100).map((b) => b.toText()) == Ok("ef")
  assert fs.readRange("public/a.txt", 9, 1).map((b) => b.toText()) == Ok("")
  let res = http.serveFile("public/a.txt")
  assert res.status == 200
  assert res.body == "abcdef"
}
`;

test('readRange on disk, and Range requests answered by the server', () => {
  const r = cli('run', src);
  expect(r.stderr).toBe('');
  expect(r.stdout.trim().split('\n').map((l) => l.trim())).toEqual([
    '[0123]',
    '[89]',
    '[]',
    '[012]',
    '[]',
    'public: is a directory',
    'nope.txt: not found',
    '200 - bytes 10000 0123456789',
    '206 bytes 10-19/10000 bytes 10 0123456789',
    '206 bytes 9995-9999/10000 bytes 5 56789',
    '206 bytes 9997-9999/10000 bytes 3 789',
    '416 bytes */10000 - 0',
    '404 - - 0',
  ]);
}, 120_000);

test('in a test, files are in memory and served whole', () => {
  const r = cli('test', src);
  expect(r.stdout + r.stderr).toContain('1 passed');
}, 120_000);
