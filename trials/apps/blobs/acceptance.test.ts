// Hidden from the agent: the spec, checked from outside over HTTP.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type App, startApp } from '../../harness';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const db = () => path.join(mkdtempSync(path.join(tmpdir(), 'blobs-')), 'store.db');
const start = () => startApp({ DB: db() });

async function put(app: App, text: string): Promise<string> {
  const r = await app.req('PUT', '/blobs', text);
  expect([200, 201]).toContain(r.status);
  return r.json.id;
}

describe('blobs', () => {
  test('a blob is stored by its hash, once', async () => {
    const app = await start();
    const r = await app.req('PUT', '/blobs', 'hello');
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ id: sha('hello'), size: 5, created: true });
    const again = await app.req('PUT', '/blobs', 'hello');
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ id: sha('hello'), size: 5, created: false });
  });

  test('read back exactly, as plain text; sizes are bytes', async () => {
    const app = await start();
    const text = 'héllo ✓\nline two\r\n  ';
    const id = await put(app, text);
    expect(id).toBe(sha(text));
    const r = await app.req('GET', `/blobs/${id}`);
    expect(r.status).toBe(200);
    expect(r.text).toBe(text);
    expect(r.contentType).toBe('text/plain; charset=utf-8');
    expect((await app.req('GET', `/blobs/${id}/meta`)).json).toEqual({ id, size: Buffer.byteLength(text), tags: [] });
  });

  test('the empty text is a blob too', async () => {
    const app = await start();
    const r = await app.req('PUT', '/blobs', '');
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ id: sha(''), size: 0, created: true });
    expect((await app.req('GET', `/blobs/${sha('')}`)).text).toBe('');
  });

  test('base64, with padding; other encodings are 400', async () => {
    const app = await start();
    for (const text of ['a', 'ab', 'abc', 'héllo ✓']) {
      const id = await put(app, text);
      const r = await app.req('GET', `/blobs/${id}?encoding=base64`);
      expect(r.status).toBe(200);
      expect(r.text).toBe(Buffer.from(text, 'utf8').toString('base64'));
    }
    expect((await app.req('GET', `/blobs/${sha('a')}?encoding=hex`)).status).toBe(400);
  });

  test('ids: malformed is 400, unknown is 404', async () => {
    const app = await start();
    for (const bad of ['abc', sha('x').toUpperCase(), sha('x') + '0', 'g'.repeat(64)]) expect((await app.req('GET', `/blobs/${bad}`)).status).toBe(400);
    expect((await app.req('GET', `/blobs/${sha('nothing')}`)).status).toBe(404);
    expect((await app.req('GET', `/blobs/${sha('nothing')}/meta`)).status).toBe(404);
    expect((await app.req('DELETE', `/blobs/${sha('nothing')}`)).status).toBe(404);
  });

  test('blobs are listed by id', async () => {
    const app = await start();
    const texts = ['one', 'two', 'three', 'four'];
    for (const t of texts) await put(app, t);
    const r = await app.req('GET', '/blobs');
    expect(r.json).toEqual({ blobs: texts.map((t) => ({ id: sha(t), size: t.length })).sort((a, b) => (a.id < b.id ? -1 : 1)) });
  });

  test('tags point at blobs, move, and are listed by name', async () => {
    const app = await start();
    const a = await put(app, 'version a');
    const b = await put(app, 'version b');
    for (const [name, id] of [['v1', a], ['latest', a], ['v2', b]]) {
      const r = await app.req('PUT', `/tags/${name}`, { id });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ name, id });
    }
    expect((await app.req('GET', '/tags/latest')).json).toEqual({ name: 'latest', id: a });
    expect((await app.req('GET', `/blobs/${a}/meta`)).json.tags).toEqual(['latest', 'v1']);
    expect((await app.req('PUT', '/tags/latest', { id: b })).json).toEqual({ name: 'latest', id: b });
    expect((await app.req('GET', `/blobs/${a}/meta`)).json.tags).toEqual(['v1']);
    expect((await app.req('GET', '/tags')).json).toEqual({ tags: [{ name: 'latest', id: b }, { name: 'v1', id: a }, { name: 'v2', id: b }] });
  });

  test('a tagged blob cannot be deleted; untagged, it can', async () => {
    const app = await start();
    const id = await put(app, 'keep me');
    await app.req('PUT', '/tags/keep', { id });
    expect((await app.req('DELETE', `/blobs/${id}`)).status).toBe(409);
    const gone = await app.req('DELETE', '/tags/keep');
    expect(gone.status).toBe(204);
    expect((await app.req('GET', '/tags/keep')).status).toBe(404);
    expect((await app.req('DELETE', '/tags/keep')).status).toBe(404);
    const del = await app.req('DELETE', `/blobs/${id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect((await app.req('GET', `/blobs/${id}`)).status).toBe(404);
    expect((await app.req('GET', '/blobs')).json).toEqual({ blobs: [] });
  });

  test('bad tags are 400; a tag to nothing is 404', async () => {
    const app = await start();
    const id = await put(app, 'x');
    for (const name of ['UPPER', 'a b', 'x'.repeat(65), 'semi;colon']) expect((await app.req('PUT', `/tags/${encodeURIComponent(name)}`, { id })).status).toBe(400);
    expect((await app.req('PUT', '/tags/ok-1.2_x', { id })).status).toBe(200);
    for (const body of ['{', {}, { id: 'short' }, { id: 5 }]) expect((await app.req('PUT', '/tags/t', body)).status).toBe(400);
    expect((await app.req('PUT', '/tags/t', { id: sha('nothing') })).status).toBe(404);
  });

  test('everything survives a restart on the same database', async () => {
    const file = db();
    const first = await startApp({ DB: file });
    const id = await put(first, 'durable');
    await first.req('PUT', '/tags/v1', { id });
    first.stop();
    await first.exited;
    const second = await startApp({ DB: file });
    expect((await second.req('GET', `/blobs/${id}`)).text).toBe('durable');
    expect((await second.req('GET', '/tags/v1')).json).toEqual({ name: 'v1', id });
    expect((await second.req('PUT', '/blobs', 'durable')).json.created).toBe(false);
  });

  test('unknown paths are 404, wrong methods 405', async () => {
    const app = await start();
    expect((await app.req('GET', '/nope')).status).toBe(404);
    expect((await app.req('POST', '/blobs')).status).toBe(405);
    expect((await app.req('POST', `/blobs/${sha('a')}`)).status).toBe(405);
    expect((await app.req('POST', '/tags/x')).status).toBe(405);
    expect((await app.req('DELETE', '/tags')).status).toBe(405);
  });
});
