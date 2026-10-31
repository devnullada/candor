import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GoPackage } from './bind';
import type { CompileResult } from './compile';
import { candorHome } from './home';

// Everything that runs the Go toolchain: the build's Go module, its third-party requirements,
// and the helper that reads Go's type information.

const exeSuffix = process.platform === 'win32' ? '.exe' : '';

export function findGo(): string | null {
  const candidates = [process.env.CANDOR_GO, 'go', 'C:\\Program Files\\Go\\bin\\go.exe', '/usr/local/go/bin/go', '/opt/homebrew/bin/go'];
  for (const c of candidates) {
    if (c && spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}

const installGo: Record<string, string> = {
  win32: 'winget install GoLang.Go',
  darwin: 'brew install go, or https://go.dev/dl/',
  linux: 'https://go.dev/dl/, or your package manager',
};

export const noGo = `candor: cannot find Go, which candor builds with. Install it (${installGo[process.platform] ?? 'https://go.dev/dl/'}) or set CANDOR_GO to the go binary.`;

/**
 * Writes the Go module a program builds in: go.mod, with the runtime and every third-party
 * package its bindings name, and the Go packages next to bindings. Returns an error message,
 * or null.
 */
export function prepareModule(goBin: string, result: CompileResult, outDir: string): string | null {
  const runtimeDir = path.join(candorHome(), 'runtime', 'go').replace(/\\/g, '/');
  mkdirSync(outDir, { recursive: true });
  for (const pkg of result.localPackages) {
    const dest = path.join(outDir, pkg.importPath.slice('candorapp/'.length));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    let files: string[];
    try {
      files = readdirSync(pkg.dir).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    } catch {
      return `candor: cannot read the Go package ${pkg.dir}`;
    }
    for (const f of files) copyFileSync(path.join(pkg.dir, f), path.join(dest, f));
  }
  // Card 144: the files `embed` names, where main.go's `//go:embed` lines look.
  rmSync(path.join(outDir, 'embed'), { recursive: true, force: true });
  if (result.embeds.length > 0) mkdirSync(path.join(outDir, 'embed'));
  for (const e of result.embeds) {
    try {
      copyFileSync(e.from, path.join(outDir, e.to));
    } catch {
      return `candor: cannot read ${e.from}, which \`embed\` names`;
    }
  }
  const base = `module candorapp\n\ngo 1.22\n\nrequire candor.dev/runtime v0.0.0\n\nreplace candor.dev/runtime => "${runtimeDir}"\n`;
  const specs = result.goRequires.map((r) => `${r.path}@${r.version}`).sort();
  // `go get` writes the requirements into go.mod and go.sum; skip it when they're already there.
  const stamp = path.join(outDir, 'go.requires');
  const want = [base, ...specs].join('\n');
  // A get that failed leaves no go.sum: a stamp from before it (0.0.20 and older kept one) is stale.
  const got = specs.length === 0 || existsSync(path.join(outDir, 'go.sum'));
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === want && existsSync(path.join(outDir, 'go.mod')) && got) return null;
  // Gone until `go get` succeeds: a failed one leaves go.mod without the requirements, and an
  // old stamp would let the next build skip getting them.
  rmSync(stamp, { force: true });
  writeFileSync(path.join(outDir, 'go.mod'), base);
  rmSync(path.join(outDir, 'go.sum'), { force: true });
  if (specs.length > 0) {
    const res = spawnSync(goBin, ['get', ...specs], { cwd: outDir, encoding: 'utf8' });
    if (res.status !== 0) return `${(res.stderr ?? res.error?.message ?? '').trim()}\ncandor: cannot get the Go packages the bindings name (${specs.join(', ')})`;
  }
  writeFileSync(stamp, want);
  return null;
}

/** Builds the module in `outDir` (after prepareModule). Returns the binary's path, or null. */
/** Builds the program; `debug` turns off optimizing and inlining, so a debugger sees every line and local. */
/** Card 157: what `candor build --target` takes, as the release's names, to Go's GOOS and GOARCH. */
export const targets: Record<string, { goos: string; goarch: string }> = {
  'windows-x64': { goos: 'windows', goarch: 'amd64' },
  'windows-arm64': { goos: 'windows', goarch: 'arm64' },
  'linux-x64': { goos: 'linux', goarch: 'amd64' },
  'linux-arm64': { goos: 'linux', goarch: 'arm64' },
  'darwin-x64': { goos: 'darwin', goarch: 'amd64' },
  'darwin-arm64': { goos: 'darwin', goarch: 'arm64' },
};

/** `to`: card 162, where the binary goes: a folder (named for the module) or the file itself. */
export function goBuild(goBin: string, result: CompileResult, moduleName: string, outDir: string, debug = false, target: string | null = null, to: { dir: string } | { file: string } = { dir: outDir }): string | null {
  writeFileSync(path.join(outDir, 'main.go'), result.go!);
  rmSync(path.join(outDir, 'bindings.go'), { force: true });
  if (result.bindings) writeFileSync(path.join(outDir, 'bindings.go'), result.bindings);
  // A target builds for it with cgo off (SQLite is modernc's, pure Go); without one, a GOOS set
  // in the environment still names the binary for the system it is for.
  const sys = target ? targets[target] : null;
  const goos = sys?.goos ?? process.env.GOOS;
  const suffix = goos ? (goos === 'windows' ? '.exe' : '') : exeSuffix;
  const exe = 'file' in to ? path.resolve(to.file) : path.resolve(to.dir, moduleName + suffix);
  // Go would put the binary inside a folder of that name.
  if (existsSync(exe) && statSync(exe).isDirectory()) {
    console.error(`candor: ${path.relative('.', exe)} is a folder, so the binary can't go there; name it with -o, as in -o ${path.relative('.', exe)}-bin`);
    return null;
  }
  if (process.platform === 'win32' && path.dirname(exe) === path.resolve(outDir)) setAside(exe);
  const env = sys ? { ...process.env, GOOS: sys.goos, GOARCH: sys.goarch, CGO_ENABLED: '0' } : process.env;
  const res = spawnSync(goBin, ['build', ...(debug ? ['-gcflags=all=-N -l'] : []), '-o', exe, '.'], { cwd: outDir, encoding: 'utf8', env });
  if (res.status !== 0) {
    process.stderr.write(goErrors(res.stderr, outDir));
    // Bindings are checked against Go before this, so a failure here is rare in a binding. main.go
    // points at .candor lines too, so only a local package or bindings.go says it surely is one.
    const inBinding = /bindings\.go:\d+|local__\d+[\\/]/.test(res.stderr);
    console.error(
      inBinding
        ? 'candor: go build failed in a binding. Check that each `extern` names a Go function whose parameters and results match its Candor signature.'
        : 'candor: go build failed. If the error is on an `extern` line, check that it names a Go function whose parameters and results match its Candor signature; otherwise generated Go should always build, so this is a compiler bug.',
    );
    return null;
  }
  return exe;
}

/** #a538dc9d: Windows won't replace a program that is running, as the cached one is while an
 * earlier `candor run` of the same file still goes. It can rename it, so it's moved aside for Go
 * to build anew, and gone at a later build once it has stopped. */
function setAside(exe: string): void {
  const dir = path.dirname(exe);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.old')) continue;
    try {
      rmSync(path.join(dir, f), { force: true });
    } catch {
      // Still running: next time.
    }
  }
  if (!existsSync(exe)) return;
  try {
    closeSync(openSync(exe, 'r+'));
  } catch {
    renameSync(exe, `${exe}.${process.pid}.old`);
  }
}

/**
 * Go's build errors, with those about bindings said in Candor's terms. They already point at the
 * `extern` line (bindings.go has `//line` directives); Go shows paths relative to outDir.
 */
function goErrors(stderr: string, outDir: string): string {
  return stderr
    .split('\n')
    .filter((l) => !l.startsWith('# '))
    .map((l) => {
      const m = /^(.*\.candor):(\d+): in call to \w+, type (func.*?) of go__\d+\.(\w+) does not match/.exec(l);
      if (m) return `${path.relative('.', path.resolve(outDir, m[1]))}:${m[2]}: the Go function ${m[4]} is \`${m[3]}\`, which does not fit this binding's Candor signature`;
      const at = /^(.*\.candor):(\d+): (.*)$/.exec(l);
      return at ? `${path.relative('.', path.resolve(outDir, at[1]))}:${at[2]}: ${at[3]}` : l;
    })
    .join('\n');
}

/** The helper that reads Go's type information, built from tools/gotypes when it's stale. */
function gotypes(goBin: string): string | { error: string } {
  const src = path.join(candorHome(), 'tools', 'gotypes');
  const exe = path.join(src, 'bin', `gotypes${exeSuffix}`);
  const newest = Math.max(...['main.go', 'go.mod', 'go.sum'].map((f) => statSync(path.join(src, f)).mtimeMs));
  if (existsSync(exe) && statSync(exe).mtimeMs >= newest) return exe;
  const res = spawnSync(goBin, ['build', '-o', exe, '.'], { cwd: src, encoding: 'utf8' });
  return res.status === 0 ? exe : { error: `${res.stderr.trim()}\ncandor: cannot build the Go type reader in ${src}` };
}

/**
 * Go's type information for `importPaths`, read in the module at `dir`. Cached there, keyed by
 * what it depends on: the paths, go.mod, the files of the local packages, and the reader itself.
 */
export function goPackages(goBin: string, dir: string, importPaths: string[], opts: { docs?: boolean } = {}): Map<string, GoPackage> | { error: string } {
  const paths = [...new Set(importPaths)].sort();
  const locals = paths.filter((p) => p.startsWith('candorapp/')).map((p) => path.join(dir, p.slice('candorapp/'.length)));
  const exe = gotypes(goBin);
  if (typeof exe !== 'string') return exe;
  const key = JSON.stringify({
    paths,
    reader: statSync(exe).mtimeMs,
    docs: opts.docs ?? false,
    mod: readFileSync(path.join(dir, 'go.mod'), 'utf8'),
    locals: locals.map((d) => readdirSync(d).map((f) => [f, statSync(path.join(d, f)).mtimeMs])),
  });
  const cache = path.join(dir, 'gotypes.json');
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.key === key) return new Map(saved.packages.map((p: GoPackage) => [p.path, p]));
  }
  const res = spawnSync(exe, [...(opts.docs ? ['-docs'] : []), ...paths], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // go/packages runs `go list`, so the go it finds must be ours.
    env: { ...process.env, PATH: `${path.dirname(goBin)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  if (res.status !== 0) return { error: `${res.stderr.trim()}\ncandor: cannot read Go's types for ${paths.join(', ')}` };
  const packages: GoPackage[] = JSON.parse(res.stdout).packages;
  writeFileSync(cache, JSON.stringify({ key, packages }));
  return new Map(packages.map((p) => [p.path, p]));
}

/**
 * A scratch Go module that requires `spec` (`path@version`, `path@latest`, or a standard
 * package), for drafting a binding. Returns its directory and the exact version, if any.
 */
export function scratchModule(goBin: string, scratch: string, spec: string): { dir: string; goPath: string; version: string | null } | { error: string } {
  const at = spec.lastIndexOf('@');
  const goPath = at < 0 ? spec : spec.slice(0, at);
  const dir = path.join(scratch, goPath.replace(/[^A-Za-z0-9.-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'go.mod'), 'module candorbind\n\ngo 1.22\n');
  rmSync(path.join(dir, 'go.sum'), { force: true });
  rmSync(path.join(dir, 'gotypes.json'), { force: true });
  if (at < 0) return { dir, goPath, version: null };
  const get = spawnSync(goBin, ['get', spec], { cwd: dir, encoding: 'utf8' });
  if (get.status !== 0) return { error: `${get.stderr.trim()}\ncandor: cannot get ${spec}` };
  // `@latest` or a branch name becomes the exact version go.mod now requires.
  const list = spawnSync(goBin, ['list', '-f', '{{.Module.Version}}', goPath], { cwd: dir, encoding: 'utf8' });
  if (list.status !== 0) return { error: `${list.stderr.trim()}\ncandor: cannot find the version of ${goPath}` };
  return { dir, goPath, version: list.stdout.trim() };
}
