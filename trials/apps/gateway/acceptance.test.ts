// Hidden from the agent: the spec, checked from outside over HTTP. Times are generous: the
// tests check order and bounds, not milliseconds.

import { describe, expect, test } from 'bun:test';
import { type App, startApp } from '../../harness';

const check = (app: App, key: string, cost?: number) => app.req('POST', '/check', cost === undefined ? { key } : { key, cost });

async function setLimit(app: App, key: string, limit: number, window: number) {
  const r = await app.req('PUT', `/limits/${key}`, { limit, window });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ key, limit, window });
}

describe('gateway', () => {
  test('checks count down to the limit, then are denied', async () => {
    const app = await startApp({ LIMIT: '3', WINDOW: '60000' });
    for (const remaining of [2, 1, 0]) {
      const r = await check(app, 'alice');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ allowed: true, remaining });
    }
    const denied = await check(app, 'alice');
    expect(denied.status).toBe(429);
    expect(denied.json.allowed).toBe(false);
    expect(denied.json.remaining).toBe(0);
    expect(denied.json.retryAfter).toBeGreaterThan(55_000);
    expect(denied.json.retryAfter).toBeLessThanOrEqual(60_000);
  });

  test('defaults are a limit of 10 per second', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/limits/x')).json).toEqual({ key: 'x', limit: 10, window: 1000 });
    for (let i = 0; i < 10; i++) expect((await check(app, 'x')).status).toBe(200);
    expect((await check(app, 'x')).status).toBe(429);
  });

  test('costs add up; a denied check reports what is left', async () => {
    const app = await startApp({ LIMIT: '10', WINDOW: '60000' });
    expect((await check(app, 'k', 4)).json).toEqual({ allowed: true, remaining: 6 });
    expect((await check(app, 'k', 5)).json).toEqual({ allowed: true, remaining: 1 });
    const r = await check(app, 'k', 2);
    expect(r.status).toBe(429);
    expect(r.json.remaining).toBe(1);
    expect((await check(app, 'k', 1)).json).toEqual({ allowed: true, remaining: 0 });
  });

  test('the window slides: each check ages out on its own', async () => {
    const app = await startApp();
    await setLimit(app, 's', 2, 1500);
    const t0 = Date.now();
    expect((await check(app, 's')).status).toBe(200);
    await Bun.sleep(700);
    expect((await check(app, 's')).status).toBe(200);
    const denied = await check(app, 's');
    expect(denied.status).toBe(429);
    // The first check ages out 1500 ms after it was made.
    const due = 1500 - (Date.now() - t0);
    expect(denied.json.retryAfter).toBeGreaterThan(due - 300);
    expect(denied.json.retryAfter).toBeLessThanOrEqual(due + 300);
    await Bun.sleep(denied.json.retryAfter + 100);
    // Only the first has aged out: one more is allowed, not two (a fixed window would reset both).
    expect((await check(app, 's')).json).toEqual({ allowed: true, remaining: 0 });
    expect((await check(app, 's')).status).toBe(429);
  });

  test('retryAfter waits for enough cost to age out, not just the first check', async () => {
    const app = await startApp();
    await setLimit(app, 'c', 3, 1200);
    expect((await check(app, 'c', 1)).status).toBe(200);
    await Bun.sleep(600);
    expect((await check(app, 'c', 2)).status).toBe(200);
    const t1 = Date.now();
    // Cost 3 needs both checks gone: the second one ages out 1200 ms after it was made.
    const r = await check(app, 'c', 3);
    expect(r.status).toBe(429);
    expect(r.json.retryAfter).toBeGreaterThan(900);
    expect(r.json.retryAfter).toBeLessThanOrEqual(1200 + (Date.now() - t1));
  });

  test('keys are independent', async () => {
    const app = await startApp({ LIMIT: '1', WINDOW: '60000' });
    expect((await check(app, 'a')).status).toBe(200);
    expect((await check(app, 'a')).status).toBe(429);
    expect((await check(app, 'b')).status).toBe(200);
  });

  test('the limit holds under 50 concurrent checks', async () => {
    const app = await startApp({ LIMIT: '20', WINDOW: '60000' });
    const replies = await Promise.all(Array.from({ length: 50 }, () => check(app, 'busy')));
    expect(replies.filter((r) => r.status === 200).length).toBe(20);
    expect(replies.filter((r) => r.status === 429).length).toBe(30);
    expect(replies.map((r) => r.json.remaining).filter((n) => n !== 0).sort((a, b) => a - b)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  });

  test('a key of its own: set, read, applied from the next check, history kept', async () => {
    const app = await startApp({ LIMIT: '5', WINDOW: '60000' });
    expect((await check(app, 'v', 3)).json).toEqual({ allowed: true, remaining: 2 });
    await setLimit(app, 'v', 4, 60000);
    expect((await app.req('GET', '/limits/v')).json).toEqual({ key: 'v', limit: 4, window: 60000 });
    expect((await check(app, 'v', 1)).json).toEqual({ allowed: true, remaining: 0 });
    expect((await check(app, 'v', 1)).status).toBe(429);
    expect((await app.req('GET', '/limits/other')).json).toEqual({ key: 'other', limit: 5, window: 60000 });
  });

  test('bad checks and bad limits are 400', async () => {
    const app = await startApp({ LIMIT: '5' });
    for (const body of ['{', {}, { key: '' }, { key: 3 }, { key: 'a', cost: 0 }, { key: 'a', cost: -1 }, { key: 'a', cost: 'x' }, { key: 'a', cost: 6 }]) {
      const r = await app.req('POST', '/check', body);
      expect(r.status).toBe(400);
      expect(typeof r.json?.error).toBe('string');
    }
    for (const body of ['{', {}, { limit: 5 }, { window: 5 }, { limit: 0, window: 5 }, { limit: 5, window: 0 }, { limit: 'x', window: 5 }]) {
      const r = await app.req('PUT', '/limits/a', body);
      expect(r.status).toBe(400);
      expect(typeof r.json?.error).toBe('string');
    }
  });

  test('stats count keys, allowed and denied; a 400 counts in none', async () => {
    const app = await startApp({ LIMIT: '2', WINDOW: '60000' });
    expect((await app.req('GET', '/stats')).json).toEqual({ keys: 0, allowed: 0, denied: 0 });
    await check(app, 'a');
    await check(app, 'a');
    await check(app, 'a');
    await check(app, 'b');
    await check(app, 'c', 0);
    expect((await app.req('GET', '/stats')).json).toEqual({ keys: 2, allowed: 3, denied: 1 });
  });

  test('unknown paths are 404, wrong methods 405', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/nope')).status).toBe(404);
    expect((await app.req('GET', '/check')).status).toBe(405);
    expect((await app.req('POST', '/limits/a')).status).toBe(405);
    expect((await app.req('DELETE', '/stats')).status).toBe(405);
  });
});
