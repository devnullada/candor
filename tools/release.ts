// Builds the release binaries: `bun run release [target...]`, into dist/.
//
// Each is `bun build --compile` of src/cli.ts behind an entry that first sets
// `globalThis.__candorAssets` to the files the compiler needs on disk (src/home.ts writes them
// out on first use). Go stays a prerequisite. dist/SHA256SUMS goes up beside them.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';

const root = path.join(import.meta.dir, '..');
const dist = path.join(root, 'dist');

const targets: Record<string, string> = {
  'windows-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
};

/** Every file under `dir`, relative to the repo, with forward slashes. */
function files(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...files(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

const assets: Record<string, string> = {};
for (const f of [
  ...files('std', () => true),
  ...files('runtime/go', (f) => !f.endsWith('_test.go')),
  ...['main.go', 'go.mod', 'go.sum'].map((f) => `tools/gotypes/${f}`),
])
  assets[f] = readFileSync(path.join(root, f), 'utf8');

const wanted = process.argv.slice(2);
for (const t of wanted) if (!targets[t]) throw new Error(`no target ${t}: ${Object.keys(targets).join(', ')}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
// ES modules run in import order, so the assets are set before the CLI starts.
writeFileSync(path.join(dist, 'assets.gen.ts'), `globalThis.__candorAssets = ${JSON.stringify(assets)};\n`);
writeFileSync(path.join(dist, 'entry.ts'), `import './assets.gen.ts';\nimport '../src/cli.ts';\n`);

for (const name of wanted.length > 0 ? wanted : Object.keys(targets)) {
  const outfile = path.join(dist, `candor-${name}${name.startsWith('windows') ? '.exe' : ''}`);
  const res = spawnSync(
    'bun',
    ['build', '--compile', '--minify', `--target=${targets[name]}`, path.join(dist, 'entry.ts'), '--outfile', outfile],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
  console.log(`${path.relative(root, outfile)}  ${(statSync(outfile).size / 1e6).toFixed(0)} MB`);
}
rmSync(path.join(dist, 'assets.gen.ts'));
rmSync(path.join(dist, 'entry.ts'));
// `sha256sum -c` reads this; the install scripts check the binary they fetched against it.
const sums = readdirSync(dist)
  .filter((f) => f.startsWith('candor-'))
  .sort()
  .map((f) => `${createHash('sha256').update(readFileSync(path.join(dist, f))).digest('hex')}  ${f}\n`);
writeFileSync(path.join(dist, 'SHA256SUMS'), sums.join(''));
console.log('dist/SHA256SUMS');
console.log(`candor ${pkg.version}, ${Object.keys(assets).length} files embedded`);
