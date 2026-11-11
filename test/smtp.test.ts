import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `smtp`, an effect for sending what `mime.compose` wrote. The fake records it; the
// real client is checked against a small server in std/smtpgo/smtp_test.go.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'smtp');

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

import "mime"
import "smtp"

fn account() -> smtp.Account {
  return smtp.Account { host: "smtp.example.com", port: 465, user: "dev@example.com", password: "app" }
}

// A reply, sent: its Message-ID, to thread on.
fn reply(to: string, subject: string, inReplyTo: string) -> Result<string, smtp.SmtpError> uses smtp, random, clock {
  let out = mime.compose(mime.Draft {
    from: mime.Address { name: "Dev", address: "dev@example.com" },
    to: [mime.Address { name: "", address: to }],
    cc: [mime.Address { name: "", address: "boss@example.com" }],
    subject: "Re: " + subject,
    text: "Thanks!",
    inReplyTo,
    references: [inReplyTo],
  })
  smtp.send(account(), out)?
  return Ok(out.messageId)
}

test "a reply is sent to To and Cc, from From" {
  let id = reply("ada@example.com", "hi", "1@example.com")
  assert id.isOk()
  let sent = smtp.sent()
  assert sent.length() == 1
  assert sent.map((s) => s.from) == ["dev@example.com"]
  assert sent.map((s) => s.recipients) == [["ada@example.com", "boss@example.com"]]
  assert sent.all((s) => mime.parse(s.message.data).map((m) => m.inReplyTo) == Ok("1@example.com"))
  assert id.map((x) => sent.map((s) => s.message.messageId) == [x]) == Ok(true)
}

test "verify, a refused recipient, a refused login" {
  assert smtp.verify(account()) == Ok()
  smtp.refuseRecipient("boss@example.com")
  assert reply("ada@example.com", "hi", "1@example.com") == Err(smtp.SmtpError.Recipient { message: "boss@example.com: 550 no such user" })
  assert smtp.sent().isEmpty()
  smtp.refuseLogin("535 authentication failed")
  assert smtp.verify(account()) == Err(smtp.SmtpError.Login { message: "535 authentication failed" })
}
`;

test('smtp: sending against the fake', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('2 passed, 0 failed');
}, 180_000);

// The real client against std/smtpgo/smtp_test.go's server, run in the module the test above built.
test('smtp: the real client against a server', () => {
  const out = path.join(dir, 'out');
  const pkg = readdirSync(out).find((d) => d.startsWith('local__') && existsSync(path.join(out, d, 'smtp.go')));
  expect(pkg).toBeDefined();
  copyFileSync(path.join(import.meta.dir, '..', 'std', 'smtpgo', 'smtp_test.go'), path.join(out, pkg!, 'smtp_test.go'));
  const r = spawnSync(go, ['test', `./${pkg}/`], { cwd: out, encoding: 'utf8' });
  expect(r.stdout + r.stderr).toContain('ok');
}, 180_000);
