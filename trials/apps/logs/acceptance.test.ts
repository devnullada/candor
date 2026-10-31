// Hidden from the agent: the spec, checked from outside by running the program.

import { describe, expect, test } from 'bun:test';
import { runCli } from '../../harness';

const sample = [
  '2026-10-25T10:00:01Z GET /items/3 200 12ms',
  '2026-10-25T10:00:02Z GET /items/4 200 10ms',
  '2026-10-25T10:00:30Z POST /orders 201 250ms',
  'this line is not a request',
  '2026-10-25T10:01:05Z GET /items/3 404 12ms',
  '',
  '2026-10-25T10:01:10Z PUT /items/12 500 26ms',
  '2026-10-25T10:02:00Z POST /orders 201 10ms',
].join('\n');

const report = [
  'requests: 6',
  'malformed: 1',
  'status: 2xx 4, 4xx 1, 5xx 1',
  'errors: 16.7%',
  'latency: p50 12ms, p95 250ms, max 250ms',
  'top paths:',
  '  4  avg 15ms  /items/{id}',
  '  2  avg 130ms  /orders',
  '',
].join('\n');

describe('logs', () => {
  test('the report for the sample, with a warning for the malformed line', async () => {
    const r = await runCli([], sample + '\n');
    expect(r.stdout).toBe(report);
    expect(r.stderr).toBe('warning: line 4: malformed\n');
    expect(r.status).toBe(0);
  });

  test('CRLF line endings and no final newline read the same', async () => {
    const r = await runCli([], sample.replace(/\n/g, '\r\n'));
    expect(r.stdout).toBe(report);
    expect(r.status).toBe(0);
  });

  test('every kind of malformed line is counted, numbered among all lines', async () => {
    const bad = [
      '2026-10-25 10:00:01 GET /a 200 1ms',
      '2026-10-25T10:00:01Z FETCH /a 200 1ms',
      '2026-10-25T10:00:01Z GET a 200 1ms',
      '2026-10-25T10:00:01Z GET /a 99 1ms',
      '2026-10-25T10:00:01Z GET /a 600 1ms',
      '2026-10-25T10:00:01Z GET /a 200 1',
      '2026-10-25T10:00:01Z GET /a 200 ms',
      '2026-10-25T10:00:01Z GET  /a 200 1ms',
      '2026-10-25T10:00:01Z GET /a 200 1ms extra',
      'xxxx-10-25T10:00:01Z GET /a 200 1ms',
      '   ',
      '2026-10-25T10:00:01Z GET /a 200 7ms',
    ];
    const r = await runCli([], bad.join('\n') + '\n');
    expect(r.stdout.split('\n').slice(0, 2)).toEqual(['requests: 1', 'malformed: 10']);
    expect(r.stderr).toBe([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `warning: line ${n}: malformed\n`).join(''));
  });

  test('no requests: just the counts', async () => {
    expect((await runCli([], '')).stdout).toBe('requests: 0\nmalformed: 0\n');
    expect((await runCli([], 'junk\n')).stdout).toBe('requests: 0\nmalformed: 1\n');
    expect((await runCli(['--status', '3xx'], sample)).stdout).toBe('requests: 0\nmalformed: 1\n');
  });

  test('--status filters by class or exact status', async () => {
    const r = await runCli(['--status', '2xx'], sample);
    expect(r.stdout).toBe(
      ['requests: 4', 'malformed: 1', 'status: 2xx 4', 'errors: 0.0%', 'latency: p50 10ms, p95 250ms, max 250ms', 'top paths:', '  2  avg 11ms  /items/{id}', '  2  avg 130ms  /orders', ''].join('\n'),
    );
    const one = await runCli(['--status', '500'], sample);
    expect(one.stdout).toBe(['requests: 1', 'malformed: 1', 'status: 5xx 1', 'errors: 100.0%', 'latency: p50 26ms, p95 26ms, max 26ms', 'top paths:', '  1  avg 26ms  /items/{id}', ''].join('\n'));
  });

  test('--since keeps requests at or after the time', async () => {
    const r = await runCli(['--since', '2026-10-25T10:01:05Z'], sample);
    expect(r.stdout.split('\n').slice(0, 3)).toEqual(['requests: 3', 'malformed: 1', 'status: 2xx 1, 4xx 1, 5xx 1']);
  });

  test('--by status, method and minute; keys tie-break ascending', async () => {
    expect((await runCli(['--by', 'status'], sample)).stdout.split('top statuses:\n')[1]).toBe('  2  avg 11ms  200\n  2  avg 130ms  201\n  1  avg 12ms  404\n  1  avg 26ms  500\n');
    expect((await runCli(['--by', 'method'], sample)).stdout.split('top methods:\n')[1]).toBe('  3  avg 11ms  GET\n  2  avg 130ms  POST\n  1  avg 26ms  PUT\n');
    expect((await runCli(['--by', 'minute'], sample)).stdout.split('top minutes:\n')[1]).toBe('  3  avg 91ms  2026-10-25T10:00\n  2  avg 19ms  2026-10-25T10:01\n  1  avg 10ms  2026-10-25T10:02\n');
  });

  test('--top limits the groups; flags in any order', async () => {
    const r = await runCli(['--top', '1', '--by', 'status', '--since', '2026-10-25T10:00:00Z'], sample);
    expect(r.stdout.endsWith('top statuses:\n  2  avg 11ms  200\n')).toBe(true);
  });

  test('paths: every all-digit part is {id}; the rest is kept', async () => {
    const input = ['/items/3/notes/17', '/items/3a', '/v2/users', '/items/007/notes/1', '/'].map((p, i) => `2026-10-25T10:00:0${i}Z GET ${p} 200 ${i + 1}ms`).join('\n');
    const r = await runCli([], input);
    expect(r.stdout.split('top paths:\n')[1]).toBe('  2  avg 3ms  /items/{id}/notes/{id}\n  1  avg 5ms  /\n  1  avg 2ms  /items/3a\n  1  avg 3ms  /v2/users\n');
  });

  test('rounding: half up, for the error share and the means', async () => {
    // 1 of 8 is 12.5%; 2 of 3 is 66.666..% → 66.7%; latencies 1 and 2 average 1.5 → 2.
    const lines = (statuses: number[], ms: number[]) => statuses.map((s, i) => `2026-10-25T10:00:00Z GET /a ${s} ${ms[i]}ms`).join('\n');
    expect((await runCli([], lines([500, 200, 200, 200, 200, 200, 200, 200], [1, 1, 1, 1, 1, 1, 1, 1]))).stdout).toContain('errors: 12.5%\n');
    expect((await runCli([], lines([500, 503, 200], [1, 1, 1]))).stdout).toContain('errors: 66.7%\n');
    expect((await runCli([], lines([200, 200], [1, 2]))).stdout).toContain('  2  avg 2ms  /a\n');
    expect((await runCli([], lines([200, 200, 200], [1, 1, 2]))).stdout).toContain('  3  avg 1ms  /a\n');
  });

  test('percentiles by nearest rank', async () => {
    const ms = Array.from({ length: 20 }, (_, i) => i + 1);
    const input = ms.map((m) => `2026-10-25T10:00:00Z GET /a 200 ${m}ms`).join('\n');
    expect((await runCli([], input)).stdout).toContain('latency: p50 10ms, p95 19ms, max 20ms\n');
  });

  test('usage errors: message on stderr, nothing on stdout, non-zero status', async () => {
    for (const args of [['--top', '0'], ['--top', 'x'], ['--status', '6xx'], ['--status', '42'], ['--by', 'host'], ['--since', 'yesterday'], ['--since', '2026-10-25T10:00:00'], ['--colour'], ['--top'], ['--by', 'path', '--by', 'status'], ['extra']]) {
      const r = await runCli(args, sample);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(r.stderr.startsWith('error: '), args.join(' ')).toBe(true);
    }
  });
});
