import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile } from '../src/compile';
import { guide, init } from '../src/guide';

test('the guide is the checklist and agent.md, its links made to work outside the repo', () => {
  const text = guide();
  expect(text).toContain('candor check <file>');
  expect(text).toContain('# Candor for an agent');
  expect(text).toContain('If the project says where Candor gaps go');
  expect(text).not.toContain('candor.log');
  expect(text).not.toMatch(/\]\((reference|start)\.md\)/);
  expect(text).toContain('`candor guide start`');
  expect(text).toContain(path.join('std', '<name>.candor'));
});

test('the long guide is the checklist and start.md', () => {
  const text = guide('start');
  expect(text).toContain('# Start here');
  expect(text).not.toContain('](reference.md)');
  expect(text).not.toContain('](../std/');
  expect(text).toContain(path.join('std', 'http.candor'));
});

test('`candor guide more` is agent-more.md, and the short guide points at it', () => {
  expect(guide()).toContain('`candor guide more`: concurrency');
  expect(guide()).not.toContain('agent-more.md');
  const text = guide('more');
  expect(text).toContain('# Candor for an agent: more');
  expect(text).toContain('The rest of `candor guide`');
  expect(text).toContain('A whole service is `candor guide service`');
  expect(text).toContain(path.join('std', '<name>.candor'));
});

test('`candor guide service` is agent-service.md (#144da828), and both other parts point at it', () => {
  expect(guide()).toContain('`candor guide service`: writing a new service');
  expect(guide()).not.toContain('agent-service.md');
  const text = guide('service');
  expect(text).toContain('# Candor for an agent: a service');
  expect(text).toContain('`candor guide more`');
  expect(text).not.toContain('agent-more.md');
  expect(text).toContain('fn handle(');
});

test('agent.md stays short: an agent reads it whole before every change', () => {
  // About 4 characters a token: under ~2.5k tokens. #7de8b2de halved it; the rest is agent-more.md.
  expect(guide().length).toBeLessThan(10_000);
});

test('init writes a project that checks, and keeps what exists', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'candor-init-')), 'my-shop');
  const log = console.log;
  console.log = () => {};
  try {
    init(dir);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('candor guide');
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('tell the user what was\n   missing');
    const main = readFileSync(path.join(dir, 'main.candor'), 'utf8');
    expect(main.startsWith('module myShop\n') || main.startsWith('module myshop\n')).toBe(true);
    const checked = compile(main, path.join(dir, 'main.candor'), 'test');
    expect(checked.diagnostics).toEqual([]);
    expect(checked.module?.decls.filter((d) => d.kind === 'TestDecl').length).toBe(1);
    writeFileSync(path.join(dir, 'AGENTS.md'), 'mine');
    init(dir);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('mine');
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
  } finally {
    console.log = log;
  }
});
