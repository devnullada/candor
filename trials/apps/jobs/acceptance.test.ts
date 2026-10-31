// Hidden from the agent: the spec, checked from outside over HTTP. Times are generous: the
// tests check order and bounds, not milliseconds.

import { describe, expect, test } from 'bun:test';
import { type App, startApp, waitFor } from '../../harness';

async function post(app: App, body: unknown): Promise<number> {
  const r = await app.req('POST', '/jobs', body);
  expect(r.status).toBe(201);
  return r.json.id;
}

const job = async (app: App, id: number) => (await app.req('GET', `/jobs/${id}`)).json;

/** Waits until job `id` is in `state`, and gives it. */
const until = (app: App, id: number, state: string, ms = 5000) =>
  waitFor(`job ${id} ${state}`, async () => {
    const j = await job(app, id);
    return j.state === state ? j : undefined;
  }, ms);

describe('jobs', () => {
  test('are queued, run and done', async () => {
    const app = await startApp();
    const r = await app.req('POST', '/jobs', { duration: 100 });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe(1);
    expect(['queued', 'running']).toContain(r.json.state);
    expect(r.json.error).toBeNull();
    expect(await until(app, 1, 'done')).toEqual({ id: 1, state: 'done', attempts: 1, error: null });
    expect(await post(app, { duration: 0 })).toBe(2);
  });

  test('a running job says so', async () => {
    const app = await startApp();
    const id = await post(app, { duration: 1000 });
    expect(await until(app, id, 'running')).toEqual({ id, state: 'running', attempts: 1, error: null });
  });

  test('bad bodies are 400', async () => {
    const app = await startApp();
    for (const body of ['{', {}, { duration: -1 }, { duration: 'x' }, { duration: 10, fails: -1 }, { duration: 10, retries: -2 }, { duration: 10, timeout: 0 }, { duration: 10, timeout: -5 }]) {
      const r = await app.req('POST', '/jobs', body);
      expect(r.status).toBe(400);
      expect(typeof r.json?.error).toBe('string');
    }
  });

  test('failed attempts are retried after a growing backoff', async () => {
    const app = await startApp();
    const started = Date.now();
    const id = await post(app, { duration: 20, fails: 2, retries: 2 });
    const retrying = await until(app, id, 'retrying');
    expect(retrying.error).toBe('failed');
    expect(await until(app, id, 'done')).toEqual({ id, state: 'done', attempts: 3, error: 'failed' });
    // 3 × 20 ms of work and backoffs of 100 and 200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(330);
  });

  test('with no retries left, a job has failed', async () => {
    const app = await startApp();
    const id = await post(app, { duration: 10, fails: 5, retries: 1 });
    expect(await until(app, id, 'failed')).toEqual({ id, state: 'failed', attempts: 2, error: 'failed' });
    const once = await post(app, { duration: 10, fails: 1 });
    expect(await until(app, once, 'failed')).toEqual({ id: once, state: 'failed', attempts: 1, error: 'failed' });
  });

  test('an attempt longer than its timeout is stopped', async () => {
    const app = await startApp();
    const started = Date.now();
    const id = await post(app, { duration: 5000, timeout: 100 });
    expect(await until(app, id, 'failed')).toEqual({ id, state: 'failed', attempts: 1, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    const retried = await post(app, { duration: 5000, timeout: 50, retries: 1 });
    expect(await until(app, retried, 'failed')).toEqual({ id: retried, state: 'failed', attempts: 2, error: 'timeout' });
    const fits = await post(app, { duration: 50, timeout: 1000 });
    expect((await until(app, fits, 'done')).error).toBeNull();
  });
});

describe('workers', () => {
  test('no more than WORKERS attempts run at once, and none idles while a job waits', async () => {
    const app = await startApp({ WORKERS: '2' });
    const started = Date.now();
    const ids = [];
    for (let n = 0; n < 6; n++) ids.push(await post(app, { duration: 300 }));
    for (const id of ids) await until(app, id, 'done');
    const elapsed = Date.now() - started;
    // Three rounds of two.
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(2500);
    expect((await app.req('GET', '/stats')).json).toEqual({ workers: 2, running: 0, maxRunning: 2 });
  });

  test('WORKERS defaults to 4', async () => {
    const app = await startApp();
    for (let n = 0; n < 6; n++) await post(app, { duration: 400 });
    await waitFor('4 running', async () => ((await app.req('GET', '/stats')).json.running === 4 ? true : undefined));
    const s = (await app.req('GET', '/stats')).json;
    expect(s.workers).toBe(4);
    expect(s.maxRunning).toBe(4);
  });

  test('take jobs oldest first', async () => {
    const app = await startApp({ WORKERS: '1' });
    const a = await post(app, { duration: 200 });
    const b = await post(app, { duration: 300 });
    const c = await post(app, { duration: 10 });
    await until(app, b, 'running');
    expect((await job(app, a)).state).toBe('done');
    expect((await job(app, c)).state).toBe('queued');
  });

  test('a job waiting out its backoff holds no worker', async () => {
    const app = await startApp({ WORKERS: '1' });
    const a = await post(app, { duration: 50, fails: 1, retries: 1 });
    const b = await post(app, { duration: 50 });
    // `a` fails at 50 ms and waits until 150; `b` runs in between.
    await until(app, b, 'done');
    expect((await job(app, a)).state).not.toBe('done');
    expect((await until(app, a, 'done')).attempts).toBe(2);
  });
});

describe('cancelling', () => {
  test('a queued job never runs', async () => {
    const app = await startApp({ WORKERS: '1' });
    const a = await post(app, { duration: 300 });
    const b = await post(app, { duration: 10 });
    const r = await app.req('DELETE', `/jobs/${b}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: b, state: 'cancelled', attempts: 0, error: null });
    await until(app, a, 'done');
    await Bun.sleep(100);
    expect(await job(app, b)).toEqual({ id: b, state: 'cancelled', attempts: 0, error: null });
  });

  test('a running job stops, and frees its worker', async () => {
    const app = await startApp({ WORKERS: '1' });
    const a = await post(app, { duration: 10_000 });
    const b = await post(app, { duration: 10 });
    await until(app, a, 'running');
    const cancelled = Date.now();
    const r = await app.req('DELETE', `/jobs/${a}`);
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('cancelled');
    await until(app, b, 'done', 2000);
    expect(Date.now() - cancelled).toBeLessThan(1000);
    expect(await job(app, a)).toEqual({ id: a, state: 'cancelled', attempts: 1, error: null });
    expect((await app.req('GET', '/stats')).json.running).toBe(0);
  });

  test('a retrying job never runs again', async () => {
    const app = await startApp();
    const a = await post(app, { duration: 10, fails: 1, retries: 3 });
    await until(app, a, 'retrying');
    expect((await app.req('DELETE', `/jobs/${a}`)).status).toBe(200);
    await Bun.sleep(400);
    expect(await job(app, a)).toEqual({ id: a, state: 'cancelled', attempts: 1, error: 'failed' });
  });

  test('a finished or cancelled job is 409, an unknown one 404', async () => {
    const app = await startApp();
    const a = await post(app, { duration: 0 });
    await until(app, a, 'done');
    expect((await app.req('DELETE', `/jobs/${a}`)).status).toBe(409);
    const b = await post(app, { duration: 0, fails: 1 });
    await until(app, b, 'failed');
    expect((await app.req('DELETE', `/jobs/${b}`)).status).toBe(409);
    const c = await post(app, { duration: 5000 });
    expect((await app.req('DELETE', `/jobs/${c}`)).status).toBe(200);
    expect((await app.req('DELETE', `/jobs/${c}`)).status).toBe(409);
    expect((await app.req('DELETE', '/jobs/99')).status).toBe(404);
    expect((await app.req('DELETE', '/jobs/x')).status).toBe(404);
  });
});

describe('shutdown', () => {
  test('refuses new jobs, cancels waiting ones, lets running ones finish, then exits 0', async () => {
    const app = await startApp({ WORKERS: '1' });
    // Long enough that `a` is still running after the requests below on a busy machine.
    const a = await post(app, { duration: 3000 });
    const b = await post(app, { duration: 10 });
    await until(app, a, 'running');
    const asked = Date.now();
    const r = await app.req('POST', '/shutdown');
    expect(r.status).toBe(202);
    expect(r.json).toEqual({});
    expect((await app.req('POST', '/jobs', { duration: 10 })).status).toBe(503);
    expect((await job(app, b)).state).toBe('cancelled');
    expect((await job(app, a)).state).toBe('running');
    const code = await Promise.race([app.exited, Bun.sleep(10_000).then(() => 'still running')]);
    expect(code).toBe(0);
    // It waited for `a`, which had at most 3 s left, rather than exiting at once.
    expect(Date.now() - asked).toBeGreaterThanOrEqual(500);
  }, 20_000);

  test('a running attempt that fails is not retried', async () => {
    const app = await startApp({ WORKERS: '1' });
    const a = await post(app, { duration: 300, fails: 1, retries: 3 });
    await until(app, a, 'running');
    expect((await app.req('POST', '/shutdown')).status).toBe(202);
    const code = await Promise.race([app.exited, Bun.sleep(5000).then(() => 'still running')]);
    expect(code).toBe(0);
  });

  test('with nothing running, it exits at once', async () => {
    const app = await startApp();
    expect((await app.req('POST', '/shutdown')).status).toBe(202);
    const code = await Promise.race([app.exited, Bun.sleep(2000).then(() => 'still running')]);
    expect(code).toBe(0);
  });
});

describe('routes', () => {
  test('unknown paths and ids are 404, wrong methods 405', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/nope')).status).toBe(404);
    expect((await app.req('GET', '/jobs/1')).status).toBe(404);
    expect((await app.req('GET', '/jobs/x')).status).toBe(404);
    expect((await app.req('GET', '/jobs')).status).toBe(405);
    // On a job that exists: on one that doesn't, 404 is as right as 405.
    expect((await app.req('POST', '/jobs', { duration: 0 })).status).toBe(201);
    expect((await app.req('PUT', '/jobs/1')).status).toBe(405);
    expect((await app.req('POST', '/stats')).status).toBe(405);
    expect((await app.req('GET', '/shutdown')).status).toBe(405);
  });
});
