import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSplit, writeModule } from './split';

// Card 150: `url`, Go's net/url: parse, format, resolve, query strings, escaping.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'url');

function cli(src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const src = String.raw`module m

import "url"

test "parse" {
  match url.parse("HTTPS://ada:pw@Example.com:8080/a%20b/c?tag=x&tag=y#top%21") {
    none => assert false,
    u => {
      assert u.scheme == "https"
      assert u.user == "ada"
      assert u.password == "pw"
      assert u.host == "Example.com"
      assert u.port == 8080
      assert u.path == "/a b/c"
      assert u.query == "tag=x&tag=y"
      assert u.fragment == "top!"
    },
  }
  match url.parse("http://[::1]/") {
    none => assert false,
    u => assert u.host == "::1" && u.port == none && u.user == none,
  }
  match url.parse("../x?y") {
    none => assert false,
    u => assert u.scheme == "" && u.host == "" && u.path == "../x" && u.query == "y",
  }
  match url.parse("mailto:ada@example.com") {
    none => assert false,
    u => assert u.scheme == "mailto" && u.path == "ada@example.com",
  }
  assert url.parse("http://x/%zz") == none
  assert url.parse("http://x:port/") == none
  assert url.parse("http://x/\u{7}") == none
}

test "format" {
  for s in ["https://ada:pw@example.com:8080/a%20b?q=1#top", "mailto:ada@example.com", "http://[::1]:80/", "../x?y", "/a/b"] {
    match url.parse(s) {
      none => assert false,
      u => assert url.format(u) == s,
    }
  }
  match url.parse("https://example.com:8080/a?x=1#top") {
    none => assert false,
    u => assert url.format(url.Url { ...u, path: "/other dir", query: "" }) == "https://example.com:8080/other%20dir#top",
  }
}

test "resolve, as yarr's feeds need it" {
  let page = "https://example.com/blog/post?id=3"
  assert url.resolve(page, "../feed.xml") == "https://example.com/feed.xml"
  assert url.resolve(page, "img/a.png") == "https://example.com/blog/img/a.png"
  assert url.resolve(page, "/") == "https://example.com/"
  assert url.resolve(page, "//cdn.example.com/x.png") == "https://cdn.example.com/x.png"
  assert url.resolve(page, "?page=2") == "https://example.com/blog/post?page=2"
  assert url.resolve(page, "#c") == "https://example.com/blog/post?id=3#c"
  assert url.resolve(page, "") == "https://example.com/blog/post?id=3"
  assert url.resolve(page, "http://other.org/a/../b") == "http://other.org/b"
  assert url.resolve(page, "%zz") == none
  assert url.resolve("http://x/%zz", "a") == none
}

test "query strings" {
  let q = url.query("?a=1&b=two+words&a=3&flag&c=%26%3D&bad=%zz")
  assert q == ["a": ["1", "3"], "b": ["two words"], "flag": [""], "c": ["&="], "bad": ["%zz"]]
  assert q.keys() == ["a", "b", "flag", "c", "bad"]
  assert url.query("") == [:]
  assert url.encodeQuery(["q": ["rock & roll"], "tag": ["x", "y"], "e": [""]]) == "q=rock+%26+roll&tag=x&tag=y&e="
  assert url.query(url.encodeQuery(["k=": ["v&w"]])) == ["k=": ["v&w"]]
}

test "escaping a part" {
  assert url.encode("a b/c&d") == "a+b%2Fc%26d"
  assert url.encodePath("a b/c&d") == "a%20b%2Fc&d"
  assert url.decode("a+b%2F") == "a b/"
  assert url.decodePath("a+b%2F") == "a+b/"
  assert url.decode("%zz") == none
  assert url.decode("\u{e9}") == "\u{e9}"
  assert url.encode("\u{e9}") == "%C3%A9"
}
`;

test('url: parse, format, resolve, query, escape', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('5 passed, 0 failed');
}, 180_000);

test('importing url takes the name, and `as` frees it', () => {
  const errs = (s: string) => compileSplit(s, 't.candor').diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  expect(errs('module m\n\nimport "url"\n\nfn get(url: string) -> string {\n  return url\n}\n\nfn main() {}\n').length).toBeGreaterThan(0);
  expect(errs('module m\n\nimport "url" as urls\n\nfn get(url: string) -> string? {\n  return urls.resolve("https://x/", url)\n}\n\nfn main() {}\n')).toEqual([]);
});
