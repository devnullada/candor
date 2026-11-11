// Hidden from the agent: the spec, checked from outside over HTTP.

import { describe, expect, test } from 'bun:test';
import { type App, startApp } from '../../harness';

const quote = (app: App, cart: unknown) => app.req('POST', '/quote', cart);
const items = (...pairs: [string, number][]) => pairs.map(([sku, qty]) => ({ sku, qty }));

async function order(app: App, cart: unknown): Promise<number> {
  const r = await app.req('POST', '/orders', cart);
  expect(r.status).toBe(201);
  return r.json.id;
}

describe('pricing', () => {
  test("the spec's example", async () => {
    const app = await startApp();
    const r = await quote(app, { items: items(['apple', 7], ['wine', 1]), tier: 'gold', coupon: 'SAVE10' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      lines: [
        { sku: 'apple', qty: 7, gross: 250, discount: 25, net: 225, tax: 23, total: 248 },
        { sku: 'wine', qty: 1, gross: 1500, discount: 0, net: 1500, tax: 375, total: 1875 },
      ],
      subtotal: 2123,
      voucher: 0,
      total: 2123,
      coupon: { code: 'SAVE10', applied: false },
    });
  });

  test('multi-buys: every third apple free, bread in pairs', async () => {
    const app = await startApp();
    const r = await quote(app, { items: items(['bread', 3], ['apple', 3], ['milk', 2]) });
    expect(r.json.lines.map((l: any) => [l.sku, l.gross])).toEqual([['apple', 100], ['bread', 650], ['milk', 240]]);
    expect(r.json.coupon).toBeNull();
    const two = await quote(app, { items: items(['apple', 2], ['bread', 4]) });
    expect(two.json.lines.map((l: any) => l.gross)).toEqual([100, 800]);
  });

  test('tiers: silver 5%, gold 10%, never on alcohol, rounded half up per line', async () => {
    const app = await startApp();
    // milk 3 = 360: 5% = 18; cheese 1 = 700: 5% = 35; apple 1 = 50: 5% = 2.5 → 3.
    const r = await quote(app, { items: items(['milk', 3], ['cheese', 1], ['apple', 1], ['wine', 2]), tier: 'silver' });
    expect(r.json.lines.map((l: any) => [l.sku, l.discount])).toEqual([['apple', 3], ['cheese', 35], ['milk', 18], ['wine', 0]]);
    const std = await quote(app, { items: items(['milk', 1]), tier: 'standard' });
    expect(std.json.lines[0].discount).toBe(0);
  });

  test('tax: 25% on alcohol, 10% on the rest, on the net, half up', async () => {
    const app = await startApp();
    // apple 1 gold: net 45, tax 4.5 → 5. wine 3: 4500, tax 1125.
    const r = await quote(app, { items: items(['apple', 1], ['wine', 3]), tier: 'gold' });
    expect(r.json.lines).toEqual([
      { sku: 'apple', qty: 1, gross: 50, discount: 5, net: 45, tax: 5, total: 50 },
      { sku: 'wine', qty: 3, gross: 4500, discount: 0, net: 4500, tax: 1125, total: 5625 },
    ]);
    expect(r.json.subtotal).toBe(5675);
    expect(r.json.total).toBe(5675);
  });

  test('DAIRY20 comes after the tier, on dairy lines only', async () => {
    const app = await startApp();
    // cheese 1 gold: 700 − 70 = 630; 20% = 126; net 504; tax 50.4 → 50.
    // milk 1 gold: 120 − 12 = 108; 20% = 21.6 → 22; net 86; tax 8.6 → 9.
    const r = await quote(app, { items: items(['cheese', 1], ['milk', 1], ['bread', 1]), tier: 'gold', coupon: 'DAIRY20' });
    expect(r.json.lines).toEqual([
      { sku: 'bread', qty: 1, gross: 250, discount: 25, net: 225, tax: 23, total: 248 },
      { sku: 'cheese', qty: 1, gross: 700, discount: 196, net: 504, tax: 50, total: 554 },
      { sku: 'milk', qty: 1, gross: 120, discount: 34, net: 86, tax: 9, total: 95 },
    ]);
    expect(r.json.coupon).toEqual({ code: 'DAIRY20', applied: true });
    const none = await quote(app, { items: items(['apple', 1]), coupon: 'DAIRY20' });
    expect(none.json.coupon).toEqual({ code: 'DAIRY20', applied: false });
    expect(none.json.lines[0].discount).toBe(0);
  });

  test('SAVE10 takes 1000 off a subtotal of 5000 or more', async () => {
    const app = await startApp();
    // wine 3 + tax = 5625.
    const r = await quote(app, { items: items(['wine', 3]), coupon: 'SAVE10' });
    expect([r.json.subtotal, r.json.voucher, r.json.total]).toEqual([5625, 1000, 4625]);
    expect(r.json.coupon).toEqual({ code: 'SAVE10', applied: true });
    // cheese 6: 4200 + 420 = 4620, not enough.
    const under = await quote(app, { items: items(['cheese', 6]), coupon: 'SAVE10' });
    expect([under.json.subtotal, under.json.voucher, under.json.total]).toEqual([4620, 0, 4620]);
  });

  test('lines with the same sku are merged', async () => {
    const app = await startApp();
    const r = await quote(app, { items: items(['apple', 2], ['milk', 1], ['apple', 1]) });
    expect(r.json.lines.map((l: any) => [l.sku, l.qty, l.gross])).toEqual([['apple', 3, 100], ['milk', 1, 120]]);
    expect((await quote(app, { items: items(['apple', 60], ['apple', 41]) })).status).toBe(400);
    expect((await quote(app, { items: items(['apple', 60], ['apple', 40]) })).status).toBe(200);
  });

  test('bad carts are 400', async () => {
    const app = await startApp();
    for (const cart of ['{', {}, { items: [] }, { items: items(['pear', 1]) }, { items: items(['apple', 0]) }, { items: items(['apple', 101]) }, { items: [{ sku: 'apple', qty: 'x' }] }, { items: items(['apple', 1]), tier: 'platinum' }, { items: items(['apple', 1]), coupon: 'FREE' }]) {
      const r = await quote(app, cart);
      expect(r.status).toBe(400);
      expect(typeof r.json?.error).toBe('string');
    }
  });

  test('an order goes pending → paid → shipped → delivered → refunded', async () => {
    const app = await startApp();
    const id = await order(app, { items: items(['apple', 7], ['wine', 1]), tier: 'gold' });
    expect(id).toBe(1);
    expect((await app.req('GET', '/orders/1')).json).toEqual({ id: 1, state: 'pending', total: 2123, history: ['pending'] });
    for (const [action, state] of [['pay', 'paid'], ['ship', 'shipped'], ['deliver', 'delivered'], ['refund', 'refunded']]) {
      const r = await app.req('POST', `/orders/1/${action}`);
      expect(r.status).toBe(200);
      expect(r.json.state).toBe(state);
    }
    expect((await app.req('GET', '/orders/1')).json.history).toEqual(['pending', 'paid', 'shipped', 'delivered', 'refunded']);
  });

  test('actions not allowed from a state are 409 and change nothing', async () => {
    const app = await startApp();
    const a = await order(app, { items: items(['milk', 1]) });
    for (const action of ['ship', 'deliver', 'refund']) expect((await app.req('POST', `/orders/${a}/${action}`)).status).toBe(409);
    expect((await app.req('POST', `/orders/${a}/cancel`)).json.state).toBe('cancelled');
    for (const action of ['pay', 'ship', 'deliver', 'cancel', 'refund']) expect((await app.req('POST', `/orders/${a}/${action}`)).status).toBe(409);
    expect((await app.req('GET', `/orders/${a}`)).json.history).toEqual(['pending', 'cancelled']);
    const b = await order(app, { items: items(['milk', 1]) });
    await app.req('POST', `/orders/${b}/pay`);
    expect((await app.req('POST', `/orders/${b}/cancel`)).status).toBe(409);
    expect((await app.req('POST', `/orders/${b}/refund`)).json.state).toBe('refunded');
    expect((await app.req('POST', `/orders/${b}/explode`)).status).toBe(404);
  });

  test('a bad cart makes no order; orders are listed by id', async () => {
    const app = await startApp();
    expect((await app.req('POST', '/orders', { items: [] })).status).toBe(400);
    await order(app, { items: items(['apple', 1]) });
    await order(app, { items: items(['bread', 2]), coupon: 'SAVE10' });
    const r = await app.req('GET', '/orders');
    expect(r.status).toBe(200);
    expect(r.json.orders.map((o: any) => [o.id, o.total])).toEqual([[1, 55], [2, 440]]);
  });

  test('unknown ids and paths are 404, wrong methods 405', async () => {
    const app = await startApp();
    expect((await app.req('GET', '/orders/1')).status).toBe(404);
    expect((await app.req('GET', '/orders/abc')).status).toBe(404);
    expect((await app.req('POST', '/orders/7/pay')).status).toBe(404);
    expect((await app.req('GET', '/nope')).status).toBe(404);
    expect((await app.req('GET', '/quote')).status).toBe(405);
    expect((await app.req('DELETE', '/orders')).status).toBe(405);
  });
});
