'use strict';
/** Exercises the real Paystack provider against a local mock of the Paystack API. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer, Client, delivery, admin } = require('./helpers');

const SECRET = 'sk_test_mocksecret1234567890';
const txns = new Map(); // reference -> { amount, currency, status }
const refunds = [];
let mock, mockUrl, srv;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { status: false, message: 'Invalid key' });
      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const b = JSON.parse(body);
        assert.equal(b.currency, 'GHS');
        assert.ok(Number.isInteger(b.amount));
        assert.match(b.email, /@/);
        txns.set(b.reference, { amount: b.amount, currency: 'GHS', status: 'pending', channels: b.channels });
        return send(200, { status: true, data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, reference: b.reference } });
      }
      if (req.method === 'POST' && req.url === '/refund') {
        const b = JSON.parse(body);
        refunds.push(b);
        return send(200, { status: true, message: 'Refund has been queued for processing', data: { status: 'pending', amount: b.amount, currency: 'GHS', transaction: { reference: b.transaction } } });
      }
      const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
      if (req.method === 'GET' && m) {
        const t = txns.get(decodeURIComponent(m[1]));
        if (!t) return send(404, { status: false });
        return send(200, { status: true, data: { status: t.status, amount: t.amount, currency: t.currency, channel: 'mobile_money', reference: m[1] } });
      }
      send(404, { status: false });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  srv = await startServer({ PAYMENTS_MODE: 'paystack', PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_BASE: mockUrl }, 30000 + Math.floor(Math.random() * 9000));
});
after(async () => { await srv.close(); await new Promise((r) => mock.close(r)); });

const sign = (raw) => crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

test('Paystack: initialize → customer pays → verify confirms order', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'momo', ...delivery });
  assert.equal(r.status, 201);
  assert.match(r.body.payment.authorizationUrl, /^https:\/\/checkout\.paystack\.com\//);
  const ref = r.body.payment.reference;
  assert.deepEqual(txns.get(ref).channels, ['mobile_money']);
  assert.equal(txns.get(ref).amount, 6900 + 2500);
  txns.get(ref).status = 'success';
  const v = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(v.body.payment.status, 'success');
  assert.equal(v.body.order.status, 'confirmed');
});

test('Paystack: amount mismatch is never accepted', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 3, qty: 1 }], paymentMethod: 'card', ...delivery });
  const ref = r.body.payment.reference;
  Object.assign(txns.get(ref), { status: 'success', amount: 100 }); // attacker paid GH₵1
  const v = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(v.body.payment.status, 'failed');
  assert.equal(v.body.order.status, 'cancelled');
  assert.equal(v.body.order.paid, false);
});

test('Paystack: signed webhook confirms payment; forged signature rejected', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 6, qty: 1 }], paymentMethod: 'momo', ...delivery });
  const ref = r.body.payment.reference;
  txns.get(ref).status = 'success';
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: ref } });
  const forged = await g.req('POST', '/api/payments/webhook', undefined, { raw, csrf: false, headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'a'.repeat(128) } });
  assert.equal(forged.status, 401);
  const ok = await g.req('POST', '/api/payments/webhook', undefined, { raw, csrf: false, headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sign(raw) } });
  assert.equal(ok.status, 200);
  const track = await g.post('/api/orders/track', { ref: r.body.order.ref, phone: delivery.phone });
  assert.equal(track.body.order.status, 'confirmed');
  assert.equal(track.body.order.paid, true);
  // replaying the webhook is harmless
  assert.equal((await g.req('POST', '/api/payments/webhook', undefined, { raw, csrf: false, headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sign(raw) } })).status, 200);
});

test('Paystack: simulator endpoints are disabled in paystack mode', async () => {
  const g = await new Client(srv.base).init();
  assert.equal((await g.post('/api/payments/simulate', { reference: 'NTNX', outcome: 'success' })).status, 404);
  assert.equal((await g.get('/pay/simulate')).status, 404);
});

test('Paystack: cancelling a paid MoMo order refunds the customer automatically; refund webhook updates status', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 2, qty: 1 }], paymentMethod: 'momo', ...delivery });
  const ref = r.body.payment.reference;
  txns.get(ref).status = 'success';
  await g.post('/api/payments/verify', { reference: ref });
  const a = await admin(srv.base);
  const c = await a.patch(`/api/admin/orders/${r.body.order.ref}`, { status: 'cancelled' });
  assert.equal(c.status, 200);
  await new Promise((res) => setTimeout(res, 150));
  const rf = refunds.find((x) => x.transaction === ref);
  assert.ok(rf, 'refund requested from Paystack');
  assert.equal(rf.amount, 34000, 'GH₵340 cassava, free delivery');
  let o = (await a.get(`/api/admin/orders?q=${r.body.order.ref}`)).body.orders[0];
  assert.equal(o.payment.refundStatus, 'pending');

  const raw = JSON.stringify({ event: 'refund.processed', data: { transaction_reference: ref, status: 'processed' } });
  assert.equal((await g.req('POST', '/api/payments/webhook', undefined, { raw, csrf: false, headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sign(raw) } })).status, 200);
  o = (await a.get(`/api/admin/orders?q=${r.body.order.ref}`)).body.orders[0];
  assert.equal(o.payment.refundStatus, 'processed');

  // retry is refused once a refund is in progress / done (idempotent)
  const again = await a.post(`/api/admin/orders/${r.body.order.ref}/refund`);
  assert.equal(again.body.refund.status, 'processed');
  assert.equal(refunds.filter((x) => x.transaction === ref).length, 1, 'never refunded twice');
});

test('Paystack: a payment that arrives after auto-cancellation is refunded', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'momo', ...delivery });
  const ref = r.body.payment.reference;
  srv.app.db.prepare("UPDATE orders SET created_at = datetime('now', '-2 hours') WHERE ref = ?").run(r.body.order.ref);
  srv.app.services.orders.expireUnpaid();
  txns.get(ref).status = 'success';
  const v = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(v.body.order.status, 'cancelled');
  await new Promise((res) => setTimeout(res, 150));
  assert.ok(refunds.some((x) => x.transaction === ref), 'late payment refunded');
});
