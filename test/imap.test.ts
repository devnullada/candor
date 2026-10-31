import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// Card 113: `imap`, an effect over a mailbox. The fake drives a sync as the console port runs
// one: the newest N on a first look, then only new UIDs, a refill when uidValidity changes.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');

function cli(src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'imap');
  mkdirSync(dir, { recursive: true });
  writeModule(path.join(dir, 't.candor'), src);
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'test', 't.candor', '--out', path.join(dir, 'out')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

const src = String.raw`module m

import "imap"
import "mime"

struct Cursor {
  uidValidity: int
  lastUid: int
}

const backfill = 3

fn account() -> imap.Account {
  return imap.Account { host: "imap.example.com", port: 993, user: "dev@example.com", password: "app" }
}

// One folder's sync: the subjects that are new, and the cursor after.
fn syncFolder(s: imap.Session, folder: string, cursor: Cursor?) -> Result<(List<string>, Cursor), imap.ImapError> uses imap {
  let box = imap.select(s, folder)?
  // The UID to go on from, unless this is a first look or the folder was renumbered.
  let since = match cursor {
    none => none,
    c => if c.uidValidity == box.uidValidity { c.lastUid } else { none },
  }
  let got = match since {
    none => imap.fetch(s, (box.count - backfill + 1).max(1), box.count)?,
    uid => imap.fetchAbove(s, uid)?,
  }
  let subjects = got.map((f) => match mime.parse(f.source) {
    Ok(msg) => msg.subject ?? "",
    Err(_) => "?",
  })
  let last = got.map((f) => f.uid).max() ?? since ?? 0
  return Ok((subjects, Cursor { uidValidity: box.uidValidity, lastUid: last }))
}

fn sentFolder(s: imap.Session) -> Result<string, imap.ImapError> uses imap {
  for f in imap.folders(s)? {
    if f.specialUse == .Sent {
      return Ok(f.name)
    }
  }
  return Ok("Sent")
}

fn mail(subject: string) -> Bytes {
  return ("From: a@b.c\r\nSubject: " + subject + "\r\n\r\nx\r\n").toBytes()
}

test "a first sync takes the newest, then only what's new, then refills" {
  for i in 1..6 {
    imap.addMessage("INBOX", mail("m" + i.toString()), i)
  }
  let first = imap.session(account(), (s) => syncFolder(s, "INBOX", none))
  assert first.map((r) => r.0) == Ok(["m3", "m4", "m5"])
  let cursor = match first {
    Ok(r) => r.1,
    Err(e) => {
      assert e.toString() == ""
      return
    },
  }
  assert cursor == Cursor { uidValidity: 1, lastUid: 5 }
  let none_new = imap.session(account(), (s) => syncFolder(s, "INBOX", cursor))
  assert none_new.map((r) => r.0) == Ok([])
  assert none_new.map((r) => r.1) == Ok(cursor)
  imap.addMessage("INBOX", mail("m6"), 6)
  let next = imap.session(account(), (s) => syncFolder(s, "INBOX", cursor))
  assert next.map((r) => r.0) == Ok(["m6"])
  assert next.map((r) => r.1.lastUid) == Ok(6)
  imap.setUidValidity("INBOX", 7)
  let refill = imap.session(account(), (s) => syncFolder(s, "INBOX", Cursor { uidValidity: 1, lastUid: 6 }))
  assert refill.map((r) => r.0) == Ok(["m4", "m5", "m6"])
  assert refill.map((r) => r.1) == Ok(Cursor { uidValidity: 7, lastUid: 6 })
  assert imap.openSessions() == 0
}

test "the Sent folder is asked of the server" {
  imap.addFolder("Sent Items", .Sent)
  imap.addFolder("Archive", none)
  let found = imap.session(account(), (s) => sentFolder(s))
  assert found == Ok("Sent Items")
  let attrs = imap.session(account(), (s) => imap.folders(s)).map((fs) => fs.map((f) => (f.name, f.attributes)))
  assert attrs == Ok([("INBOX", []), ("Sent Items", ["\\Sent"]), ("Archive", [])])
}

test "an empty folder, a missing one, a refused login" {
  let empty = imap.session(account(), (s) => syncFolder(s, "INBOX", none))
  assert empty.map((r) => r.1) == Ok(Cursor { uidValidity: 1, lastUid: 0 })
  let missing = imap.session(account(), (s) => imap.select(s, "Nope"))
  assert missing.map((b) => b.count) == Err(imap.ImapError.NoFolder { name: "Nope", message: "no such folder" })
  assert imap.openSessions() == 0
  let unselected = imap.session(account(), (s) => imap.fetch(s, 1, 1))
  assert unselected.isErr()
  imap.refuseLogin("AUTHENTICATIONFAILED")
  let refused = imap.session(account(), (s) => imap.select(s, "INBOX"))
  assert refused.map((b) => b.count) == Err(imap.ImapError.Login { message: "AUTHENTICATIONFAILED" })
}
`;

test('imap: a sync against the fake', () => {
  const r = cli(src);
  expect(r.stdout + r.stderr).toContain('3 passed, 0 failed');
}, 180_000);

// The real client, against go-imap's own server: std/imapgo/imap_test.go, run in the module the
// test above built, with the server's packages added to it.
test('imap: the real client against a server', () => {
  const out = path.join(tmpdir(), 'candor-test', 'imap', 'out');
  const pkg = readdirSync(out).find((d) => d.startsWith('local__') && existsSync(path.join(out, d, 'imap.go')));
  expect(pkg).toBeDefined();
  copyFileSync(path.join(import.meta.dir, '..', 'std', 'imapgo', 'imap_test.go'), path.join(out, pkg!, 'imap_test.go'));
  const get = spawnSync(go, ['get', 'github.com/emersion/go-imap/backend/memory@v1.2.1', 'github.com/emersion/go-imap/server@v1.2.1'], { cwd: out, encoding: 'utf8' });
  expect(get.stderr).not.toContain('error');
  const r = spawnSync(go, ['test', `./${pkg}/`], { cwd: out, encoding: 'utf8' });
  expect(r.stdout).toContain('ok');
}, 180_000);
