import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';

// `html.toText`, for an HTML-only mail's body.

const go = process.env.CANDOR_GO ?? (process.platform === 'win32' ? 'C:\\Program Files\\Go\\bin\\go.exe' : 'go');
const dir = path.join(tmpdir(), 'candor-test', 'html');

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CANDOR_GO: go },
  });
}

// Each page is printed between `=` lines.
const pages: [string, string][] = [
  [
    '<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Welcome &amp; hi</h1><p>Your   account\n is <b>ready</b>.</p></body></html>',
    'Welcome & hi\n\nYour account is ready.',
  ],
  ['<div>Line one<br>Line two</div><div>three</div><br><br>four', 'Line one\nLine two\nthree\n\nfour'],
  ['<ul><li>a</li><li>b <a href="https://x.io/v">verify</a></li></ul>', '- a\n- b verify (https://x.io/v)'],
  ['<p><a href="https://y.io">https://y.io</a> <a href="mailto:a@b.c">mail</a> <a href="/rel">rel</a></p>', 'https://y.io mail rel'],
  ['<table><tr><td>Name</td><td>Ada</td></tr><tr><th>Plan</th><td>Free</td></tr></table>after', 'Name | Ada\nPlan | Free\n\nafter'],
  // Mail layout: rows as paragraphs, the gap between them CSS padding.
  [
    '<table><tr><td><a href="https://z.eu/"><img src="logo.png"></a></td></tr><tr><td style="padding:20px 0 0 12px">One.</td></tr><tr><td style="padding: 20px 0 0 12px">Two <a href="https://z.eu/x">here</a>.</td></tr><tr><td style="padding:20px 0 0 12px">Regards,<br/></td></tr><tr><td style="padding:0 0 0 12px"><b>Team</b><br></td></tr><tr><td style="padding:0"><a href="https://www.z.eu/">www.z.eu</a></td></tr></table>',
    'One.\n\nTwo here (https://z.eu/x).\n\nRegards,\nTeam\nwww.z.eu',
  ],
  // Cells laid out side by side: each read on its own, apart when they hold several lines.
  [
    '<table><tr><td><b>Paid</b><br><br>Card</td><td><b>Due</b><br><br>2026-11-01</td></tr></table><table><tr><td>Total</td><td>&#8364; 9,00<div>( &#8364; 7,20 + VAT )</div></td></tr></table>',
    'Paid\n\nCard\n\nDue\n\n2026-11-01\n\nTotal\n\n€ 9,00\n( € 7,20 + VAT )',
  ],
  [
    '<div style="display:none">preview text</div><div style="margin-top: 1em">a</div><div style="padding-top:4px">b</div><p style="margin:0">c</p><div style="padding-bottom:10px">d</div>e',
    'a\nb\n\nc\n\nd\n\ne',
  ],
  ['<a href="https://z.eu"><img alt="Zoho" src="x"></a> <a href="https://z.eu/a">https://z.eu/a</a>', 'Zoho https://z.eu/a'],
  // A campaign mail: an `alt` that is an address, and an icon link and its caption
  // going to one place, the caption a block inside the link.
  [
    '<p><a href="https://z.eu"><img alt="https://img.eu/logo.png" src="x"></a></p><p>Hello.</p><table><tr><td><a href="https://f.eu/z"><img alt="Follow Z" src="i"></a></td></tr><tr><td><a href="https://f.eu/z"><p>Follow Z</p></a></td></tr></table><p>Bye.</p>',
    'Hello.\n\nFollow Z (https://f.eu/z)\n\nBye.',
  ],
  ['<a href="https://f.eu/z"><p>Follow Z</p></a><a href="https://f.eu/z">Follow Z</a>after', 'Follow Z (https://f.eu/z)\n\nafter'],
  ['<p><img alt="logo" src=x.png> &copy; 2026</p><script>alert(1)</script><!-- c -->', 'logo © 2026'],
  ['<pre>  a\n   b</pre>', '  a\n   b'],
  ['plain <b>bold</b><i>italic', 'plain bolditalic'],
  ['', ''],
];

describe('html.toText', () => {
  test('pages as a reader sees them', () => {
    mkdirSync(dir, { recursive: true });
    const lines = pages.map(([page]) => `  io.println(html.toText(${JSON.stringify(page).replaceAll('$', '\\$')}))\n  io.println("=")\n`).join('');
    writeFileSync(path.join(dir, 'main.candor'), `module m\n\nimport "html"\n\nfn main() uses io {\n${lines}}\n`);
    const r = cli('run', path.join(dir, 'main.candor'), '--out', path.join(dir, 'out'));
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n=\n').slice(0, -1)).toEqual(pages.map(([, text]) => text));
  }, 120_000);

  test('x/net is required only by a program that imports html', () => {
    const file = path.join(dir, 't.candor');
    const xnet = (src: string) => compile(src, file, 'main').goRequires.some((r) => r.path === 'golang.org/x/net/html');
    expect(xnet('module m\n\nimport "html"\n\nfn main() uses io {\n  io.println(html.toText("<b>x</b>"))\n}\n')).toBe(true);
    expect(xnet('module m\n\nfn main() uses io {\n  io.println("x")\n}\n')).toBe(false);
  });
});
