'use strict';
/** Exercises the real Sailup SMS client against a local mock of https://api.sailup.io/v1. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer, Client, randomPhone, delivery } = require('./helpers');

const KEY = 'sailup_testkey123';
const HOOK = 'whsec_test_123';
const sent = [];
let failNext = false;
let mock, srv;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: 'Invalid API key' });
      if (req.method === 'POST' && req.url === '/v1/sms/') {
        if (failNext) { failNext = false; return send(400, { detail: 'Insufficient credits' }); }
        const b = JSON.parse(body);
        const id = crypto.randomUUID();
        sent.push({ ...b, id });
        return send(202, { id, to: b.to, sender: b.from, body: b.body, quantity: 1, status: 'queued', delivery_status: '', created_at: new Date().toISOString() });
      }
      send(404, { detail: 'not found' });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  srv = await startServer({
    SMS_MODE: 'sailup', SAILUP_API_KEY: KEY, SAILUP_SENDER_ID: 'NTINTAN', SAILUP_WEBHOOK_SECRET: HOOK,
    SAILUP_BASE: `http://127.0.0.1:${mock.address().port}/v1`
  }, 20000 + Math.floor(Math.random() * 9000));
});
after(async () => { await srv.close(); await new Promise((r) => mock.close(r)); });
beforeEach(() => srv.resetLimits());

const codeFrom = (msg) => /^(\d{6}) is your Ntintan/.exec(msg.body)?.[1];

test('OTP is delivered through Sailup with Bearer key, sender ID and E.164 number', async () => {
  const phone = randomPhone();
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/auth/otp/request', { phone });
  assert.equal(r.status, 200);
  assert.equal(r.body.devCode, undefined, 'code is never returned to the browser in sailup mode');
  const msg = sent.at(-1);
  assert.equal(msg.from, 'NTINTAN');
  assert.deepEqual(msg.to, ['+233' + phone.slice(1)]);
  const code = codeFrom(msg);
  assert.match(code, /^\d{6}$/);
  assert.doesNotMatch(msg.body, /[₵–—]/, 'GSM-7 safe text (no Unicode surcharge)');
  const v = await c.post('/api/auth/otp/verify', { phone, code });
  assert.equal(v.body.needsProfile, true);
  const logged = srv.app.db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(logged.status, 'sent');
  assert.equal(logged.provider_id, msg.id);
  assert.doesNotMatch(logged.body, new RegExp(code));
});

test('if Sailup fails, the customer gets a clear error and can retry immediately', async () => {
  const phone = randomPhone();
  const c = await new Client(srv.base).init();
  failNext = true;
  const r = await c.post('/api/auth/otp/request', { phone });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'sms_failed');
  const again = await c.post('/api/auth/otp/request', { phone });
  assert.equal(again.status, 200, 'no cooldown after a failed send');
});

test('order confirmations are sent by SMS', async () => {
  const before = sent.length;
  const c = await new Client(srv.base).init();
  const o = await c.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery });
  assert.equal(o.status, 201);
  await new Promise((r) => setTimeout(r, 100));
  const msg = sent.slice(before).find((m) => m.body.includes(o.body.order.ref));
  assert.ok(msg, 'confirmation SMS sent');
  assert.match(msg.body, /GHS ?94\.00/);
});

test('Sailup delivery webhook: signature, timestamp and status update', async () => {
  const id = sent.at(-1).id;
  const raw = JSON.stringify({ event: 'message.delivered', created_at: new Date().toISOString(), data: { message_id: id, delivery_status: 'delivered' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'sha256=' + crypto.createHmac('sha256', HOOK).update(ts + '.' + raw).digest('hex');
  const g = new Client(srv.base);
  const post = (headers) => g.req('POST', '/api/sms/webhook', undefined, { raw, csrf: false, headers: { 'Content-Type': 'application/json', ...headers } });
  assert.equal((await post({ 'x-sailup-signature': 'sha256=' + 'a'.repeat(64), 'x-sailup-timestamp': ts })).status, 401);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = 'sha256=' + crypto.createHmac('sha256', HOOK).update(old + '.' + raw).digest('hex');
  assert.equal((await post({ 'x-sailup-signature': oldSig, 'x-sailup-timestamp': old })).status, 401, 'replayed old webhook rejected');
  assert.equal((await post({ 'x-sailup-signature': sig, 'x-sailup-timestamp': ts })).status, 200);
  const row = srv.app.db.prepare('SELECT status FROM sms_log WHERE provider_id = ?').get(id);
  assert.equal(row.status, 'delivered');
});
