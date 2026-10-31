import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 154: `html.parse` and `html.parseFragment` into `xml.Node`, read with `xml.Lookup`, and
// `html.encode` / `html.encodeAll` writing a tree back as HTML.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function candorTest(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'html-tree', name);
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const tests = `module m

import "html"
import "xml"

test "a page gets html, head and body, as a browser builds them" {
  let page = html.parse("<!DOCTYPE html><title>Hi &amp; bye</title><link rel=alternate type=application/rss+xml href='/feed'><p>one<p>two <b>bold</b><!-- gone -->")
  assert page.name() == "html"
  assert page.elements().map((e) => e.name()) == ["head", "body"]
  assert page.child("head").child("title").text() == "Hi & bye"
  assert page.child("head").child("link").attr("href") == "/feed"
  assert page.child("body").children("p").map((p) => p.text()) == ["one", "two bold"]
  assert html.encode(page.child("body")) == "<body><p>one</p><p>two <b>bold</b></p></body>"
  assert html.parse("").elements().map((e) => e.name()) == ["head", "body"]
}

test "tables, lists and stray tags are mended" {
  let body = html.parse("<table><tr><td>a<td>b</table><ul><li>x<li>y</ul></i>end").child("body")
  assert body.child("table").child("tbody").child("tr").children("td").map((c) => c.text()) == ["a", "b"]
  assert body.child("ul").children("li").length() == 2
  assert html.encode(body) == "<body><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><ul><li>x</li><li>y</li></ul>end</body>"
}

test "a fragment is its nodes; void, raw text, entities and svg" {
  let nodes = html.parseFragment("a&nbsp;<br>b<img src=x.png alt='\\"q\\"'><script>if (a < b) go()</script><svg viewBox='0 0 1 1'><circle r='1'/></svg>")
  assert nodes.map((n) => n.name()) == ["", "br", "", "img", "script", "svg"]
  assert nodes[0].map((n) => n.text()) == "a\\u{a0}"
  assert nodes[4].map((n) => n.text()) == "if (a < b) go()"
  assert nodes[5].map((n) => n.space()) == "http://www.w3.org/2000/svg"
  assert nodes[5].map((n) => n.child("circle").space()) == "http://www.w3.org/2000/svg"
  assert html.encodeAll(nodes) == "a\\u{a0}<br/>b<img src=\\"x.png\\" alt=\\"&#34;q&#34;\\"/><script>if (a < b) go()</script><svg viewBox=\\"0 0 1 1\\"><circle r=\\"1\\"></circle></svg>"
  assert html.parseFragment("").isEmpty()
}

fn cleanAll(nodes: List<xml.Node>) -> List<xml.Node> {
  let mut out: List<xml.Node> = []
  for n in nodes {
    out = out.concat(clean(n))
  }
  return out
}

fn clean(n: xml.Node) -> List<xml.Node> {
  return match n {
    .Text => [n],
    .Element { name, attrs, children } => {
      let kept = cleanAll(children)
      if name == "script" {
        return []
      }
      if ["p", "a", "b"].contains(name) {
        return [xml.Node.Element { name: name, space: "", attrs: attrs.filter((a) => a.name == "href" && a.value.startsWith("https:")), children: kept }]
      }
      return kept
    },
  }
}

test "a sanitizer: read a fragment, keep what it allows, write it" {
  let dirty = html.parseFragment("<p onclick='x()'>Hi <a href='javascript:x()'>bad</a> <a href=https://ok.io title=t>ok</a><script>x()</script><font>plain</font></p>")
  assert html.encodeAll(cleanAll(dirty)) == "<p>Hi <a>bad</a> <a href=\\"https://ok.io\\">ok</a>plain</p>"
}

test "built in code, written as HTML: escaped text, raw script, void elements" {
  let doc = xml.element("div", ["class": "a&b"], [
    xml.text("1 < 2"),
    xml.element("br", [:], []),
    xml.element("style", [:], [xml.text("p > b { color: red }")]),
  ])
  assert html.encode(doc) == "<div class=\\"a&amp;b\\">1 &lt; 2<br/><style>p > b { color: red }</style></div>"
  // A void element given children is followed by them, as a browser reads it.
  assert html.encode(xml.element("p", [:], [xml.element("br", [:], [xml.text("x")])])) == "<p><br/>x</p>"
}
`;

test('html.parse, parseFragment and encode', () => {
  const r = candorTest('tree', tests);
  expect(r.stderr).toBe('');
  expect(r.stdout).toEndWith('5 passed, 0 failed\n');
}, 120_000);
