import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `candor init` with no dir, or `.`, works in the current directory (it threw EEXIST on '.').

const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');

for (const args of [['init'], ['init', '.']]) {
  test(`candor ${args.join(' ')} starts a project in the current directory`, () => {
    const dir = path.join(tmpdir(), 'candor-test', 'init', args.length === 1 ? 'bare' : 'dot');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const r = spawnSync(process.execPath, ['run', cli, ...args], { cwd: dir, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const f of ['main.candor', 'main_test.candor', 'AGENTS.md', 'CLAUDE.md']) expect(existsSync(path.join(dir, f))).toBe(true);
  });
}
