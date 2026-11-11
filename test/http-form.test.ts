import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeModule } from './split';

// `http.readForm` reads a multipart or urlencoded form whole, at most `maxBytes`;
// `http.formRequest` makes a multipart request for tests.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const cliPath = path.join(import.meta.dir, '..', 'src', 'cli.ts');
function write(name: string, src: string) {
  const dir = path.join(tmpdir(), 'candor-test', 'http-form', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.candor`);
  writeModule(file, src);
  return { dir, file };
}
function cli(name: string, src: string, cmd: 'run' | 'test') {
  const { dir, file } = write(name, src);
  return spawnSync(process.execPath, ['run', cliPath, cmd, file, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
    timeout: 120_000,
  });
}

const handler = `
fn describe(form: http.Form) -> string {
  let mut out: List<string> = []
  for (name, values) in form.fields.entries() {
    out.push("\${name}=\${values.join("|")}")
  }
  for f in form.files {
    out.push("\${f.field}:\${f.name}:\${f.contentType}:\${f.bytes.toHex()}")
  }
  return out.join(" ")
}

fn handle(req: http.Request) -> http.Response {
  return match http.readForm(req, 400) {
    Ok(form) => http.textResponse(200, describe(form)),
    Err(.TooLarge { limit }) => http.textResponse(413, "over \${limit}"),
    Err(.NotAForm { contentType }) => http.textResponse(400, "not a form: \${contentType}"),
    Err(e) => http.textResponse(400, "\${e}"),
  }
}
`;

test('a form request reads back as the form it was made from', () => {
  const r = cli('blocks', `module m

import "bytes"
import "http"
${handler}
test "fields and files round trip" {
  let form = http.Form {
    fields: ["folder": ["drums", "kicks"], "note": ["a \\"quoted\\" one"]],
    files: [http.FormFile { field: "file", name: "kick.wav", contentType: "audio/wav", bytes: bytes.fromHex("52494646ff00") ?? "".toBytes() }],
  }
  let req = http.formRequest("POST", "/upload", form)
  assert http.readForm(req, 1_000) == Ok(form)
  assert http.bodyOf(handle(req)) == "folder=drums|kicks note=a \\"quoted\\" one file:kick.wav:audio/wav:52494646ff00"
}

test "too large" {
  let req = http.formRequest("POST", "/upload", http.Form { fields: ["a": ["0123456789".padStart(500, "x")]], files: [] })
  assert handle(req).status == 413
  assert http.bodyOf(handle(req)) == "over 400"
}

test "urlencoded" {
  let req = http.Request { method: "POST", path: "/", query: [:], headers: ["content-type": "application/x-www-form-urlencoded"], body: "b=2&a=%C3%A9+x&b=3" }
  assert http.bodyOf(handle(req)) == "b=2|3 a=é x"
}

test "not a form, malformed, streamed" {
  let json = http.Request { method: "POST", path: "/", query: [:], headers: ["content-type": "application/json"], body: "{}" }
  assert http.bodyOf(handle(json)) == "not a form: application/json"
  let bad = http.Request { ...json, headers: ["content-type": "multipart/form-data; boundary=zz"], body: "nope" }
  assert handle(bad).status == 400
  let pieces = http.streamed(http.formRequest("POST", "/", http.Form { fields: ["k": ["v"]], files: [] }), ["--candor-form-boundary\\r\\n", "Content-Disposition: form-data; name=\\"k\\"\\r\\n\\r\\nv\\r\\n--candor-form-", "boundary--\\r\\n"])
  assert http.bodyOf(handle(pieces)) == "k=v"
}
`, 'test');
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain('4 passed');
});

test('browser-encoded forms over a real server, on a plain route and a large-body one', async () => {
  // Bodies as a browser's FormData and URLSearchParams encode them, posted by the program itself.
  const { dir, file } = write('server', '');
  const body = async (name: string, data: FormData | URLSearchParams) => {
    const r = new Request('http://x/', { method: 'POST', body: data });
    const type = r.headers.get('content-type') ?? `no content type for ${name}`;
    writeFileSync(path.join(dir, `${name}.body`), new Uint8Array(await r.arrayBuffer()));
    writeFileSync(path.join(dir, `${name}.type`), type);
  };
  const upload = new FormData();
  upload.append('folder', 'drums');
  upload.append('file', new Blob([new Uint8Array([0x52, 0x49, 0xff, 0x00])], { type: 'audio/wav' }), 'kick.wav');
  await body('upload', upload);
  const over = new FormData();
  over.append('file', new Blob([new Uint8Array(1000)]), 'zeros.bin');
  await body('over', over);
  await body('urlencoded', new URLSearchParams({ q: 'a b', r: 'é' }));
  const port = 18657;
  writeFileSync(file, `module m

import "fs"
import "http"
${handler}
fn post(url: string, name: string) -> string uses http, fs {
  let data = match fs.readBytes("${dir.replaceAll('\\', '/')}/\${name}.body") {
    Ok(b) => b,
    Err(e) => return "\${e}",
  }
  let ctype = match fs.read("${dir.replaceAll('\\', '/')}/\${name}.type") {
    Ok(t) => t,
    Err(e) => return "\${e}",
  }
  return match http.postBytes(url, ctype, data) {
    Ok(res) => "\${res.status} \${res.body}",
    Err(e) => "failed: \${e}",
  }
}

fn calls(base: string) -> List<string> uses http, fs, clock {
  for _ in 0..200 {
    match http.get(base) {
      Ok(_) => return [post(base, "upload"), post("\${base}/big", "upload"), post("\${base}/big", "over"), post(base, "urlencoded")],
      Err(_) => clock.sleep(50),
    }
  }
  return ["the server never answered"]
}

fn main() uses io, http, fs, tasks, clock {
  let lines = tasks.race([
    () => match http.serveWith("127.0.0.1:${port}", http.ServeOptions { largeBodies: ["POST /big"] }, handle) {
      Ok() => ["stopped"],
      Err(e) => ["serve: \${e}"],
    },
    () => calls("http://127.0.0.1:${port}"),
  ])
  for line in lines {
    io.println(line)
  }
}
`);
  const r = spawnSync(process.execPath, ['run', cliPath, 'run', file, '--out', path.join(dir, 'out')], { encoding: 'utf8', env: { ...process.env, CANDOR_GO: go }, timeout: 120_000 });
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe([
    '200 folder=drums file:kick.wav:audio/wav:5249ff00',
    '200 folder=drums file:kick.wav:audio/wav:5249ff00',
    '413 over 400',
    '200 q=a b r=é',
    '',
  ].join('\n'));
}, 120_000);
