import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `xml`, a tree read with Go's encoding/xml (lenient as feed readers are, or strict),
// looked up a step at a time, and written back.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'xml');

function cli(src: string) {
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// `#{` stands for Candor's `${`, which a JS template would take as its own.
const src = String.raw`module m

import "xml"
import "bytes"

const rss = """
  <?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel>
      <title>News &amp; more</title>
      <link>https://example.com/</link>
      <item>
        <title><![CDATA[First <b>one</b>]]></title>
        <content:encoded>&lt;p&gt;Hi&nbsp;there</content:encoded>
        <dc:creator>Ann</dc:creator>
        <enclosure url="https://example.com/a.mp3" length="12" type="audio/mpeg"/>
      </item>
      <item><title>Second</title><description>no enclosure</description></item>
    </channel>
  </rss>
  """

const atom = """
  <?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en">
    <title type="html">A &lt;b&gt;feed&lt;/b&gt;</title>
    <entry>
      <title>One</title>
      <link rel="alternate" href="https://e/1"/>
      <media:thumbnail url="https://e/1.png"/>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hi <b>there</b></div></content>
    </entry>
  </feed>
  """

fn root(source: string) -> xml.Node {
  return xml.parse(source).ok() ?? xml.text("")
}

test "an RSS feed: lookups, CDATA, entities, namespaces, attributes" {
  let channel = root(rss).child("channel")
  assert channel.name() == "channel"
  assert channel.child("title").text() == "News & more"
  // RSS's <link> has text: not HTML's empty <link>.
  assert channel.child("link").text() == "https://example.com/"
  let items = channel.children("item")
  assert items.length() == 2
  let first = items[0] ?? xml.text("")
  assert first.child("title").text() == "First <b>one</b>"
  assert first.child("encoded").text() == "<p>Hi\u{a0}there"
  assert first.child("encoded").space() == "http://purl.org/rss/1.0/modules/content/"
  assert first.childIn("http://purl.org/dc/elements/1.1/", "creator").text() == "Ann"
  assert first.childIn("http://example.com/other", "creator").name() == ""
  assert first.child("enclosure").attr("url") == "https://example.com/a.mp3"
  assert first.child("enclosure").attr("width") == none
  let second = items[1] ?? xml.text("")
  assert second.children("enclosure").first() == none
  assert second.child("enclosure").attr("url") == none
  assert second.child("nope").child("deeper").text() == ""
  assert root(rss).attr("version") == "2.0"
  assert root(rss).attrs().map((a) => "#{a.space}:#{a.name}") == [":version", "xmlns:content", "xmlns:dc"]
  assert channel.elements().map((e) => e.name()) == ["title", "link", "item", "item"]
  assert channel.child("title").nodes() == [xml.text("News & more")]
}

test "an Atom feed: a default namespace, xml:lang, text of nested elements" {
  let feed = root(atom)
  assert feed.name() == "feed"
  assert feed.space() == "http://www.w3.org/2005/Atom"
  assert feed.attrIn("http://www.w3.org/XML/1998/namespace", "lang") == "en"
  assert feed.child("title").text() == "A <b>feed</b>"
  let entry = feed.child("entry")
  assert entry.child("link").attr("href") == "https://e/1"
  assert entry.childIn("http://search.yahoo.com/mrss/", "thumbnail").attr("url") == "https://e/1.png"
  assert entry.childIn("http://www.w3.org/2005/Atom", "thumbnail").name() == ""
  assert entry.child("content").text() == "Hi there"
  assert entry.child("content").child("div").space() == "http://www.w3.org/1999/xhtml"
}

test "lenient reading keeps going; strict refuses" {
  assert xml.parse("<a><b>x</a>").map((n) => xml.encode(n)) == Ok("<a><b>x</b></a>")
  assert "#{xml.parseStrict("<a><b>x</a>")}" == "Err(line 1: element <b> closed by </a>)"
  assert xml.parse("<a>\n<b>cut sh").map((n) => xml.encode(n)) == Ok("<a>\n<b>cut sh</b></a>")
  assert "#{xml.parseStrict("<a>\n<b>cut sh")}" == "Err(line 2: <b> is not closed)"
  assert xml.parse("<a x=1 y>&nbsp;&copy; & &bogus;<br></a>").map((n) => n.attr("x")) == Ok("1")
  assert xml.parse("<a x=1 y>&copy; & &bogus;<br></a>").map((n) => n.text()) == Ok("\u{a9} & &bogus;")
  assert "#{xml.parseStrict("<a>&nbsp;</a>")}" == "Err(line 1: invalid character entity &nbsp;)"
  assert xml.parse("<a/><b/>").map((n) => n.name()) == Ok("a")
  assert "#{xml.parseStrict("<a/><b/>")}" == "Err(line 1: a second root element <b>)"
  assert "#{xml.parseStrict("<a/>x")}" == "Err(line 1: text outside the root element)"
  assert "#{xml.parse("hello")}" == "Err(line 1: no element in the document)"
  assert "#{xml.parse("")}" == "Err(line 1: no element in the document)"
  // A closing tag nothing opened ends the document.
  assert xml.parse("<a><b>x</b></c>y</a>").map((n) => xml.encode(n)) == Ok("<a><b>x</b></a>")
  // A control character, which XML refuses and feeds carry.
  assert xml.parse("<a>\u{7}title</a>").map((n) => n.text()) == Ok("title")
  assert xml.parseStrict("<a>\u{7}title</a>").isErr()
  // An undeclared prefix stands as its own namespace.
  assert xml.parse("<a><p:x>1</p:x></a>").map((n) => n.child("x").space()) == Ok("p")
}

test "charsets from the declaration" {
  let cp1251 = "<?xml version=\"1.0\" encoding=\"windows-1251\"?><a>".toBytes().concat(bytes.fromList([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])).concat("</a>".toBytes())
  assert xml.parse(cp1251.toRawText()).map((n) => n.text()) == Ok("\u{43f}\u{440}\u{438}\u{432}\u{435}\u{442}")
  assert xml.parseStrict(cp1251.toRawText()).map((n) => n.text()) == Ok("\u{43f}\u{440}\u{438}\u{432}\u{435}\u{442}")
  let latin = "<?xml version='1.0' encoding='ISO-8859-1'?><a>caf".toBytes().concat(bytes.fromList([0xe9])).concat("</a>".toBytes())
  assert xml.parse(latin.toRawText()).map((n) => n.text()) == Ok("caf\u{e9}")
  // Invalid UTF-8 in a UTF-8 document, leniently.
  let broken = "<a>caf".toBytes().concat(bytes.fromList([0xe9])).concat("</a>".toBytes())
  assert xml.parse(broken.toRawText()).map((n) => n.text()) == Ok("caf\u{fffd}")
  assert xml.parse("<?xml version=\"1.0\" encoding=\"klingon\"?><a>x</a>").map((n) => n.text()) == Ok("x")
  assert "#{xml.parseStrict("<?xml version=\"1.0\" encoding=\"klingon\"?><a/>")}" == "Err(line 1: unknown charset \"klingon\")"
}

test "writing: built in code, escaped, namespaces, a document" {
  let opml = xml.element("opml", ["version": "2.0"], [
    xml.element("head", [:], [xml.element("title", [:], [xml.text("Subscriptions")])]),
    xml.element("body", [:], [
      xml.element("outline", ["text": "A & B", "title": "\"quoted\" <tag>"], [
        xml.element("outline", ["type": "rss", "xmlUrl": "https://e/feed?a=1&b=2"], []),
      ]),
    ]),
  ])
  assert xml.document(opml) == """
    <?xml version="1.0" encoding="UTF-8"?>
    <opml version="2.0">
      <head>
        <title>Subscriptions</title>
      </head>
      <body>
        <outline text="A &amp; B" title="&quot;quoted&quot; &lt;tag&gt;">
          <outline type="rss" xmlUrl="https://e/feed?a=1&amp;b=2"/>
        </outline>
      </body>
    </opml>

    """
  assert "#{opml}".startsWith("<opml version=\"2.0\"><head><title>Subscriptions</title></head>")
  // What is written reads back as the same tree.
  assert xml.parseStrict(xml.encode(opml)) == Ok(opml)
  assert xml.escape("<a href='x'>&</a>") == "&lt;a href=&apos;x&apos;&gt;&amp;&lt;/a&gt;"
  // A child built without a namespace takes its parent's; an attribute in one gets a prefix.
  let feed = xml.Node.Element {
    name: "feed",
    space: "http://www.w3.org/2005/Atom",
    attrs: [xml.Attr { name: "lang", space: "http://www.w3.org/XML/1998/namespace", value: "en" }, xml.Attr { name: "x", space: "urn:other", value: "1" }],
    children: [xml.element("title", [:], [xml.text("a < b")])],
  }
  assert xml.encode(feed) == "<feed xmlns=\"http://www.w3.org/2005/Atom\" xml:lang=\"en\" xmlns:ns1=\"urn:other\" ns1:x=\"1\"><title>a &lt; b</title></feed>"
}

test "a parsed document is written back as it was read" {
  let feed = root(atom)
  assert xml.parseStrict(xml.encode(feed)) == Ok(feed)
  let channel = root(rss)
  assert xml.parseStrict(xml.encode(channel)) == Ok(channel)
  assert xml.encode(root(atom).child("entry").child("content")) == "<content xmlns=\"http://www.w3.org/2005/Atom\" type=\"xhtml\"><div xmlns=\"http://www.w3.org/1999/xhtml\">Hi <b>there</b></div></content>"
  // An element that says xmlns="" keeps saying it.
  let none_ = root("<a xmlns=\"urn:a\"><b xmlns=\"\">x</b></a>")
  assert none_.child("b").space() == ""
  assert xml.encode(none_) == "<a xmlns=\"urn:a\"><b xmlns=\"\">x</b></a>"
  assert xml.encodeIndented(root("<a>\n  <b>x <i>y</i></b>\n  <c/>\n</a>")) == "<a>\n  <b>x <i>y</i></b>\n  <c/>\n</a>"
}

// From the yarr port.
test "own text, inner XML, quotes in text, a default namespace, a feed cut short" {
  let b = root("<b>a <i>b</i> c</b>")
  assert b.ownText() == "a  c"
  assert b.text() == "a b c"
  assert xml.text("t").ownText() == "t"
  let content = root(atom).child("entry").child("content")
  assert content.innerXml() == "<div xmlns=\"http://www.w3.org/1999/xhtml\">Hi <b>there</b></div>"
  // The same XML, not the same bytes: CDATA as escaped text, entities as characters.
  assert root("<a>x <![CDATA[<y>]]> &#39;z&#39; &amp;</a>").innerXml() == "x &lt;y&gt; 'z' &amp;"
  assert xml.text("1 < 2").innerXml() == "1 &lt; 2"
  // Text keeps its quotes; an attribute value escapes them.
  assert xml.encode(xml.element("a", ["t": "it's \"x\""], [xml.text("it's \"x\"")])) == "<a t=\"it&apos;s &quot;x&quot;\">it's \"x\"</a>"
  // Under a default namespace every unprefixed element has it.
  let feed = root("<rss xmlns=\"urn:r\"><channel><title>t</title></channel></rss>")
  assert feed.child("channel").space() == "urn:r"
  assert feed.child("channel").child("title").space() == "urn:r"
  // A feed whose download broke off gives the items read so far.
  let cut = root("<rss><channel><item><title>One</title></item><item><title>Tw")
  assert cut.child("channel").children("item").map((i) => i.child("title").text()) == ["One", "Tw"]
}
`.replaceAll('#{', '${');

test('xml: read, look up, write', () => {
  const r = cli(src);
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('7 passed, 0 failed');
}, 180_000);
