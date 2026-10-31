// `bun run deploy`: builds the site, packs dist/ (as public/) with deploy/Release.sh, and pipes
// the archive to the server over ssh, where Release.sh puts it live. CANDOR_DEPLOY_HOST is the
// ssh target, root@candorlanguage.org by default. Deploys ship files only, never server config.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, openSync, rmSync } from 'node:fs';
import path from 'node:path';

const site = path.join(import.meta.dir, '..');
const host = process.env.CANDOR_DEPLOY_HOST ?? 'root@candorlanguage.org';
const stage = path.join(site, '.deploy');
const archive = 'site.tgz';

function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? site, stdio: [opts.stdin ?? 'inherit', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${r.status ?? r.error}`);
}

run('bun', ['run', 'build']);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(path.join(site, 'dist'), path.join(stage, 'public'), { recursive: true });
cpSync(path.join(site, 'deploy', 'Release.sh'), path.join(stage, 'Release.sh'));
// Relative paths: GNU tar reads `C:\...` as a host called `C`.
run('tar', ['-czf', archive, 'public', 'Release.sh'], { cwd: stage });

// Unpacked into a fresh directory; CRLF stripped from Release.sh in case Windows added it.
const remote = `d=$(mktemp -d) && tar -xzf - --no-same-owner --warning=no-unknown-keyword -C "$d" && sed -i 's/\\r$//' "$d/Release.sh" && bash "$d/Release.sh"`;
run('ssh', [host, remote], { stdin: openSync(path.join(stage, archive), 'r') });
rmSync(stage, { recursive: true, force: true });
