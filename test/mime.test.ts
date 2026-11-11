import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `mime.parse` reads a raw message (headers, addresses, bodies in any charset and
// transfer encoding, attachments) and `mime.compose` writes a plain-text one.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'mime');
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const src = String.raw`module m

import "mime"

const zoho = """
  Message-ID: <abc.123@mail.zoho.eu>
  In-Reply-To: <prev@x.no>
  References: <root@x.no>
   <prev@x.no>
  Date: Tue, 14 Nov 2023 22:13:20 +0000
  From: =?UTF-8?Q?=C3=85se?= <ase@example.org>
  To: "Ada L." <ada@example.com>, bob@example.com
  Cc: =?ISO-8859-1?Q?J=F8rgen?= <j@example.no>
  Subject: =?UTF-8?B?SGVpIHDDpQ==?= there
  X-Mailer: Zoho Mail
  MIME-Version: 1.0
  Content-Type: multipart/mixed; boundary="mix"

  --mix
  Content-Type: multipart/alternative; boundary="alt"

  --alt
  Content-Type: text/plain; charset=iso-8859-1
  Content-Transfer-Encoding: quoted-printable

  Hils fra Bj=F8rn, en lang linje som er =
  brutt.
  --alt
  Content-Type: text/html; charset=utf-8
  Content-Transfer-Encoding: base64

  PHA+SGk8L3A+
  --alt--
  --mix
  Content-Type: application/pdf; name="r.pdf"
  Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf
  Content-Transfer-Encoding: base64

  AAEC
  --mix
  Content-Type: image/png
  Content-ID: <logo@x.no>
  Content-Transfer-Encoding: base64

  AAEC
  --mix--
  """

test "a Zoho-shaped message, every part" {
  let m = match mime.parse(zoho.toBytes()) {
    Ok(m) => m,
    Err(e) => {
      assert e.toString() == ""
      return
    },
  }
  assert m.messageId == "abc.123@mail.zoho.eu"
  assert m.inReplyTo == "prev@x.no"
  assert m.references == ["root@x.no", "prev@x.no"]
  assert m.date == 1_700_000_000_000
  assert m.from == mime.Address { name: "\u{c5}se", address: "ase@example.org" }
  assert m.to == [mime.Address { name: "Ada L.", address: "ada@example.com" }, mime.Address { name: "", address: "bob@example.com" }]
  assert m.cc == [mime.Address { name: "J\u{f8}rgen", address: "j@example.no" }]
  assert m.subject == "Hei p\u{e5} there"
  assert m.text == "Hils fra Bj\u{f8}rn, en lang linje som er brutt."
  assert m.html == "<p>Hi</p>"
  assert m.attachments.length() == 2
  let pdf = m.attachments[0]
  assert pdf.map((a) => a.filename) == "r\u{e9}sum\u{e9}.pdf"
  assert pdf.map((a) => a.contentType) == "application/pdf"
  assert pdf.map((a) => a.size) == 3
  assert pdf.map((a) => a.data.toHex()) == "000102"
  assert pdf.map((a) => a.inline) == false
  let logo = m.attachments[1]
  assert logo.map((a) => a.contentId) == "logo@x.no"
  assert logo.map((a) => a.filename == none) == true
  assert logo.map((a) => a.inline) == true
  assert mime.header(m, "X-MAILER") == ["Zoho Mail"]
  assert mime.header(m, "nope") == []
}

test "a plain message: no brackets, no charset, LF or CRLF" {
  let raw = "From: a@b.c\r\nSubject: hi\r\nMessage-ID: bare-id@b.c\r\n\r\nline one\r\nline two\r\n"
  let m = mime.parse(raw.toBytes())
  assert m.map((x) => x.text) == Ok("line one\r\nline two\r\n")
  assert m.map((x) => x.messageId) == Ok("bare-id@b.c")
  assert m.map((x) => x.from) == Ok(mime.Address { name: "", address: "a@b.c" })
  assert m.map((x) => x.date) == Ok(none)
  assert m.map((x) => x.html) == Ok(none)
  assert m.map((x) => x.to) == Ok([])
}

test "HTML only, and a Windows-1252 subject" {
  let raw = "From: x@y.z\nSubject: =?windows-1252?Q?caf=E9_=80?=\nContent-Type: text/html; charset=utf-8\n\n<b>hi</b>"
  let m = mime.parse(raw.toBytes())
  assert m.map((x) => x.subject) == Ok("caf\u{e9} \u{20ac}")
  assert m.map((x) => x.html) == Ok("<b>hi</b>")
  assert m.map((x) => x.text) == Ok(none)
}

test "a broken header block is an error" {
  let m = mime.parse("not a header\n\nbody".toBytes())
  assert m.isErr()
}

test "a composed message parses back" {
  clock.set(1_700_000_000_000)
  let out = mime.compose(mime.Draft {
    from: mime.Address { name: "\u{c5}se \u{d8}deg\u{e5}rd", address: "dev@example.org" },
    to: [mime.Address { name: "Ada", address: "ada@example.com" }],
    cc: [mime.Address { name: "", address: "bob@example.com" }],
    subject: "Re: Hei p\u{e5} deg, and a subject long enough that the header has to be folded somewhere",
    text: "Takk!\nLine two, \u{e6}\u{f8}\u{e5}, and a line long enough to need a soft break in quoted-printable encoding here.",
    inReplyTo: "prev@x.no",
    references: ["root@x.no", "prev@x.no"],
  })
  assert out.messageId.endsWith("@example.org") && out.messageId.length() == 36 + 12
  assert out.from == "dev@example.org"
  assert out.recipients == ["ada@example.com", "bob@example.com"]
  let text = out.data.toText() ?? ""
  assert text.lines().all((l) => l.length() <= 78)
  assert text.contains("\r\nMIME-Version: 1.0\r\n")
  let m = match mime.parse(out.data) {
    Ok(m) => m,
    Err(e) => {
      assert e.toString() == ""
      return
    },
  }
  assert m.messageId == out.messageId
  assert m.subject == "Re: Hei p\u{e5} deg, and a subject long enough that the header has to be folded somewhere"
  assert m.from == mime.Address { name: "\u{c5}se \u{d8}deg\u{e5}rd", address: "dev@example.org" }
  assert m.cc == [mime.Address { name: "", address: "bob@example.com" }]
  assert m.text == "Takk!\r\nLine two, \u{e6}\u{f8}\u{e5}, and a line long enough to need a soft break in quoted-printable encoding here."
  assert m.inReplyTo == "prev@x.no"
  assert m.references == ["root@x.no", "prev@x.no"]
  assert m.date == 1_700_000_000_000
}

test "left out: no cc, no references" {
  let out = mime.compose(mime.Draft {
    from: mime.Address { name: "", address: "a@b.c" },
    to: [mime.Address { name: "", address: "d@e.f" }],
    subject: "plain",
    text: "x",
  })
  let text = out.data.toText() ?? ""
  assert !text.contains("Cc:") && !text.contains("References:") && !text.contains("In-Reply-To:")
  assert text.contains("\r\nSubject: plain\r\n")
}
`;

test('mime parses and composes mail messages', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('6 passed, 0 failed');
}, 180_000);
