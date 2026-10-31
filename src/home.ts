import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json';

// Where the files the compiler needs on disk are: `std/`, `runtime/go/` and `tools/gotypes/`.
// In a clone they are next to `src/`. A release binary (card 094) carries them, set by its entry
// in `globalThis.__candorAssets` as path -> text, and writes them out once per version under
// `~/.candor/<version>/`, since Go builds from files. Older versions' folders go then.

export const version: string = pkg.version;

declare global {
  var __candorAssets: Record<string, string> | undefined;
}

let dir: string | null = null;

/** The folder holding `std/`, `runtime/go/` and `tools/gotypes/`. */
export function candorHome(): string {
  if (dir) return dir;
  const assets = globalThis.__candorAssets;
  if (!assets) return (dir = fileURLToPath(new URL('..', import.meta.url)));
  const home = path.join(process.env.CANDOR_HOME ?? path.join(homedir(), '.candor'), version);
  const done = path.join(home, '.complete');
  if (!existsSync(done)) {
    // Written to a temporary folder and renamed, so two candors starting at once can't see half.
    const tmp = `${home}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [file, text] of Object.entries(assets)) {
      mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      writeFileSync(path.join(tmp, file), text);
    }
    writeFileSync(path.join(tmp, '.complete'), '');
    try {
      renameSync(tmp, home);
    } catch {
      // Another candor got there first, or an old half-written folder is in the way.
      if (!existsSync(done)) {
        rmSync(home, { recursive: true, force: true });
        renameSync(tmp, home);
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    removeOlder(path.dirname(home), version);
  }
  return (dir = home);
}

/** Card 162: where a file's module builds, out of the project: `~/.candor/cache/<folder>-<hash>/<module>`
 * (`CANDOR_CACHE` for the cache). One folder per source folder, so two `app` modules in different
 * folders don't share a build; its name starts with the source folder's, to find it by eye. */
export function buildDir(file: string, module: string): string {
  const dir = path.resolve(path.dirname(file));
  const key = createHash('sha256').update(process.platform === 'win32' ? dir.toLowerCase() : dir).digest('hex').slice(0, 10);
  const folder = `${path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '') || 'root'}-${key}`;
  const out = path.join(cacheRoot(), folder, module);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, '.used'), '');
  pruneBuilds(cacheRoot(), Date.now());
  return out;
}

/** #a538dc9d: one build at a time in `dir`; a second candor building the same file waits here.
 * The lock is a file made only if absent, holding its owner's pid; a dead owner's lock, or one
 * older than 10 minutes, is taken over. Returns the function that lets it go. */
export function lockBuild(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (stale(lock)) rmSync(lock, { force: true });
    else Atomics.wait(nap, 0, 0, 100);
  }
  let held = true;
  const release = () => {
    if (held) rmSync(lock, { force: true });
    held = false;
  };
  process.once('exit', release);
  return release;
}

function stale(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000) return true;
    const pid = Number(readFileSync(lock, 'utf8'));
    // Read before its owner wrote the pid: it is being made, not stale.
    if (!pid) return false;
    process.kill(pid, 0);
    return false;
  } catch (e) {
    // ESRCH: no such process. EPERM: alive, someone else's.
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function cacheRoot(): string {
  return process.env.CANDOR_CACHE ?? path.join(homedir(), '.candor', 'cache');
}

const day = 24 * 60 * 60 * 1000;

/** Builds not used for 30 days go, checked once a day. A folder in use (Windows) is left for next time. */
export function pruneBuilds(root: string, now: number): void {
  const stamp = path.join(root, '.pruned');
  try {
    if (now - statSync(stamp).mtimeMs < day) return;
  } catch {}
  writeFileSync(stamp, '');
  for (const folder of readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const at = path.join(root, folder.name);
    for (const module of readdirSync(at)) {
      let used = 0;
      try {
        used = statSync(path.join(at, module, '.used')).mtimeMs;
      } catch {}
      if (now - used < 30 * day) continue;
      try {
        rmSync(path.join(at, module), { recursive: true, force: true });
      } catch {}
    }
    try {
      if (readdirSync(at).length === 0) rmSync(at, { recursive: true, force: true });
    } catch {}
  }
}

/** Card 136: the folders of versions before `current` in `base` go once a new one unpacks.
 * Only names like `0.0.21`: `bin/` and anything else there stay, and so do newer versions.
 * A folder in use (Windows) is left for next time. */
export function removeOlder(base: string, current: string): void {
  const parts = (v: string) => v.split('.').map(Number);
  const older = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const now = parts(current);
  for (const name of readdirSync(base)) {
    if (!/^\d+\.\d+\.\d+$/.test(name) || !older(parts(name), now)) continue;
    try {
      rmSync(path.join(base, name), { recursive: true, force: true });
    } catch {}
  }
}
