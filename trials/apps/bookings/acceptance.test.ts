// Hidden from the agent: the spec, checked from outside over HTTP.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type App, startApp } from '../../harness';

const errorBody = (r: { json: any }) => expect(typeof r.json?.error).toBe('string');

async function withRoom(app: App, name = 'Fjord'): Promise<number> {
  const r = await app.req('POST', '/rooms', { name });
  expect(r.status).toBe(201);
  return r.json.id;
}

describe('rooms', () => {
  test('are added, trimmed, and listed by id', async () => {
    const app = await startApp();
    const a = await app.req('POST', '/rooms', { name: '  Fjord ' });
    expect(a.status).toBe(201);
    expect(a.json).toEqual({ id: 1, name: 'Fjord' });
    expect((await app.req('POST', '/rooms', { name: 'Glacier' })).json).toEqual({ id: 2, name: 'Glacier' });
    const all = await app.req('GET', '/rooms');
    expect(all.status).toBe(200);
    expect(all.json).toEqual([
      { id: 1, name: 'Fjord' },
      { id: 2, name: 'Glacier' },
    ]);
  });

  test('a fresh start has none', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/rooms')).json).toEqual([]);
  });

  test('a blank name, bad JSON, a missing or mistyped field are 400', async () => {
    const app = await startApp();
    for (const body of [{ name: '   ' }, '{', {}, { name: 7 }]) {
      const r = await app.req('POST', '/rooms', body);
      expect(r.status).toBe(400);
      errorBody(r);
    }
    expect((await app.req('GET', '/rooms')).json).toEqual([]);
  });
});

describe('bookings', () => {
  test('are made and listed by start', async () => {
    const app = await startApp();
    const room = await withRoom(app);
    const b = await app.req('POST', '/bookings', { room, start: 13, end: 15 });
    expect(b.status).toBe(201);
    expect(b.json).toEqual({ id: 1, room, start: 13, end: 15 });
    expect((await app.req('POST', '/bookings', { room, start: 9, end: 11 })).status).toBe(201);
    const list = await app.req('GET', `/rooms/${room}/bookings`);
    expect(list.status).toBe(200);
    expect(list.json).toEqual([
      { id: 2, room, start: 9, end: 11 },
      { id: 1, room, start: 13, end: 15 },
    ]);
  });

  test('touching ranges are fine, overlapping ones 409, other rooms unaffected', async () => {
    const app = await startApp();
    const a = await withRoom(app, 'A');
    const b = await withRoom(app, 'B');
    expect((await app.req('POST', '/bookings', { room: a, start: 9, end: 11 })).status).toBe(201);
    expect((await app.req('POST', '/bookings', { room: a, start: 11, end: 13 })).status).toBe(201);
    expect((await app.req('POST', '/bookings', { room: a, start: 7, end: 9 })).status).toBe(201);
    for (const [start, end] of [
      [10, 12],
      [8, 10],
      [9, 11],
      [6, 14],
      [12, 13],
    ]) {
      const r = await app.req('POST', '/bookings', { room: a, start, end });
      expect(r.status).toBe(409);
      errorBody(r);
    }
    expect((await app.req('POST', '/bookings', { room: b, start: 9, end: 11 })).status).toBe(201);
    expect((await app.req('GET', `/rooms/${a}/bookings`)).json).toHaveLength(3);
  });

  test('hours outside 0 to 24, or start not before end, are 400', async () => {
    const app = await startApp();
    const room = await withRoom(app);
    for (const [start, end] of [
      [-1, 3],
      [20, 25],
      [10, 10],
      [12, 10],
    ]) {
      const r = await app.req('POST', '/bookings', { room, start, end });
      expect(r.status).toBe(400);
      errorBody(r);
    }
    expect((await app.req('POST', '/bookings', { room, start: 0, end: 24 })).status).toBe(201);
  });

  test('bad bodies are 400', async () => {
    const app = await startApp();
    const room = await withRoom(app);
    for (const body of ['nope', { room, start: 9 }, { room: 'x', start: 9, end: 10 }, { room, start: '9', end: 10 }]) {
      expect((await app.req('POST', '/bookings', body)).status).toBe(400);
    }
  });

  test('an unknown room is 404', async () => {
    const app = await startApp();
    const r = await app.req('POST', '/bookings', { room: 9, start: 9, end: 10 });
    expect(r.status).toBe(404);
    errorBody(r);
    expect((await app.req('GET', '/rooms/9/bookings')).status).toBe(404);
    expect((await app.req('GET', '/rooms/x/bookings')).status).toBe(404);
  });

  test('are deleted once, and free their slot', async () => {
    const app = await startApp();
    const room = await withRoom(app);
    const id = (await app.req('POST', '/bookings', { room, start: 9, end: 11 })).json.id;
    const d = await app.req('DELETE', `/bookings/${id}`);
    expect(d.status).toBe(204);
    expect(d.text).toBe('');
    expect((await app.req('DELETE', `/bookings/${id}`)).status).toBe(404);
    expect((await app.req('DELETE', '/bookings/x')).status).toBe(404);
    expect((await app.req('POST', '/bookings', { room, start: 9, end: 11 })).status).toBe(201);
  });

  test('of many requests for one slot at once, exactly one wins', async () => {
    const app = await startApp();
    const room = await withRoom(app);
    const replies = await Promise.all(Array.from({ length: 20 }, () => app.req('POST', '/bookings', { room, start: 10, end: 12 })));
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect((await app.req('GET', `/rooms/${room}/bookings`)).json).toHaveLength(1);
  });
});

describe('routes', () => {
  test('unknown paths are 404, wrong methods 405', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/nope')).status).toBe(404);
    expect((await app.req('GET', '/rooms/1/nope')).status).toBe(404);
    expect((await app.req('DELETE', '/rooms')).status).toBe(405);
    expect((await app.req('GET', '/bookings')).status).toBe(405);
    expect((await app.req('POST', '/rooms/1/bookings')).status).toBe(405);
    expect((await app.req('GET', '/bookings/1')).status).toBe(405);
  });
});

describe('storage', () => {
  test('`DB` names a file that outlives the program', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bookings-'));
    try {
      const db = path.join(dir, 'b.db');
      const first = await startApp({ DB: db });
      await withRoom(first, 'Kept');
      first.stop();
      await first.exited;
      const second = await startApp({ DB: db });
      expect((await second.req('GET', '/rooms')).json).toEqual([{ id: 1, name: 'Kept' }]);
      second.stop();
      await second.exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
