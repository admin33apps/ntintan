'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, delivery, signUp, admin, randomPhone } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.resetLimits());

const db = () => srv.app.db;

// ---------------------------------------------------------------- customer OTP
test('OTP sign-up: request → verify → complete profile → signed in; returning user signs straight in', async () => {
  const phone = randomPhone();
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/auth/otp/request', { phone: `+233 ${phone.slice(1)}` });
  assert.equal(r.status, 200);
  assert.match(r.body.devCode, /^\d{6}$/);
  assert.equal(r.body.expiresInSeconds, 300);

  const stored = db().prepare('SELECT * FROM otp_codes WHERE phone = ?').get(phone);
  assert.ok(stored, 'phone normalised to 0XXXXXXXXX');
  assert.notEqual(stored.code_hash, r.body.devCode, 'code is hashed, not stored in clear');
  assert.equal(db().prepare("SELECT COUNT(*) n FROM sms_log WHERE body LIKE ?").get(`%${r.body.devCode}%`).n, 0, 'code never written to SMS log');

  const v = await c.post('/api/auth/otp/verify', { phone, code: r.body.devCode });
  assert.equal(v.body.needsProfile, true);
  assert.equal((await c.get('/api/me')).status, 401, 'not signed in until profile completed');
  const noTerms = await c.post('/api/auth/otp/complete', { signupToken: v.body.signupToken, name: 'Efua Asante', acceptTerms: false });
  assert.equal(noTerms.status, 422);
  // a failed attempt must not burn a valid token? token is consumed only after terms pass
  const done = await c.post('/api/auth/otp/complete', { signupToken: v.body.signupToken, name: 'Efua Asante', email: 'efua@test.gh', acceptTerms: true, marketingOptIn: true });
  assert.equal(done.status, 201);
  assert.equal(done.body.user.phone, phone);
  assert.equal(done.body.user.needsTerms, false);
  assert.equal(done.body.user.marketingOptIn, true);
  assert.equal((await c.post('/api/auth/otp/complete', { signupToken: v.body.signupToken, name: 'X Y', acceptTerms: true })).status, 400, 'sign-up token is single use');

  // returning customer
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ?").run(phone);
  const c2 = await new Client(srv.base).init();
  const r2 = await c2.post('/api/auth/otp/request', { phone });
  const v2 = await c2.post('/api/auth/otp/verify', { phone, code: r2.body.devCode });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.user.name, 'Efua Asante');
  assert.equal((await c2.get('/api/me')).status, 200);
});

test('OTP rules: wrong codes, lockout after 5 attempts, expiry, single use, resend cooldown, hourly cap', async () => {
  const phone = randomPhone();
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/auth/otp/request', { phone });
  const wrong = r.body.devCode === '000000' ? '111111' : '000000';
  const w1 = await c.post('/api/auth/otp/verify', { phone, code: wrong });
  assert.equal(w1.status, 400);
  assert.match(w1.body.error.message, /4 attempt/);
  assert.equal((await c.post('/api/auth/otp/request', { phone })).status, 429, 'resend cooldown');
  for (let i = 0; i < 3; i++) await c.post('/api/auth/otp/verify', { phone, code: wrong });
  const locked = await c.post('/api/auth/otp/verify', { phone, code: wrong });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'otp_locked');
  assert.equal((await c.post('/api/auth/otp/verify', { phone, code: r.body.devCode })).status, 400, 'right code refused after lockout');

  // expiry
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ?").run(phone);
  const r2 = await c.post('/api/auth/otp/request', { phone });
  db().prepare("UPDATE otp_codes SET expires_at = datetime('now', '-1 second') WHERE phone = ? AND consumed_at IS NULL").run(phone);
  const exp = await c.post('/api/auth/otp/verify', { phone, code: r2.body.devCode });
  assert.equal(exp.body.error.code, 'otp_expired');

  // single use
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ?").run(phone);
  const r3 = await c.post('/api/auth/otp/request', { phone });
  assert.equal((await c.post('/api/auth/otp/verify', { phone, code: r3.body.devCode })).status, 200);
  assert.equal((await c.post('/api/auth/otp/verify', { phone, code: r3.body.devCode })).status, 400, 'code cannot be reused');

  // hourly cap (3 sent so far)
  for (let i = 0; i < 2; i++) {
    db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ? AND created_at > datetime('now','-2 minutes')").run(phone);
    assert.equal((await c.post('/api/auth/otp/request', { phone })).status, 200);
  }
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ? AND created_at > datetime('now','-2 minutes')").run(phone);
  const cap = await c.post('/api/auth/otp/request', { phone });
  assert.equal(cap.status, 429);
  assert.equal(cap.body.error.code, 'otp_hourly_limit');
});

test('OTP validation and per-IP limits', async () => {
  const c = await new Client(srv.base).init();
  assert.equal((await c.post('/api/auth/otp/request', { phone: '12345' })).status, 422);
  assert.equal((await c.post('/api/auth/otp/verify', { phone: randomPhone(), code: 'abc' })).status, 422);
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/otp/request', { phone: randomPhone() });
  assert.equal(last.status, 429, 'max 10 code requests per IP per 15 minutes');
});

test('staff cannot sign in through the customer OTP flow', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/auth/otp/request', { phone: '0200000001' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'use_admin_login');
});

// ---------------------------------------------------------------- admin 2-step
test('admin sign-in needs password AND SMS code', async () => {
  const c = await new Client(srv.base).init();
  assert.equal((await c.post('/api/auth/admin/login', { email: 'admin@ntintan.test', password: 'wrong-password' })).status, 401);
  const r = await c.post('/api/auth/admin/login', { email: 'admin@ntintan.test', password: 'Admin-Password-123' });
  assert.equal(r.body.otpRequired, true);
  assert.match(r.body.phoneHint, /•+001$/);
  assert.equal((await c.get('/api/admin/stats')).status, 401, 'password alone gives no access');
  const bad = await c.post('/api/auth/admin/verify', { challenge: r.body.challenge, code: r.body.devCode === '999999' ? '888888' : '999999' });
  assert.equal(bad.status, 400);
  assert.equal((await c.post('/api/auth/admin/verify', { challenge: r.body.challenge, code: r.body.devCode })).status, 400, 'challenge is single use');
  const { client: cust } = await signUp(srv.base);
  assert.equal((await cust.post('/api/auth/admin/login', { email: 'nobody@test.gh', password: 'x' })).status, 401);
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = '0200000001'").run();
  // a fresh challenge works (helper)
  const a = await admin(srv.base);
  assert.equal((await a.get('/api/admin/stats')).status, 200);
  const sms = (await a.get('/api/admin/sms')).body.messages;
  assert.ok(sms.some((m) => m.purpose === 'otp_admin' && /redacted/.test(m.body)));
  assert.ok(!sms.some((m) => /\d{6} is your/.test(m.body)), 'no codes in SMS log');
});

// ---------------------------------------------------------------- profile & privacy rights
test('profile update, terms re-acceptance, data export', async () => {
  const { client, phone } = await signUp(srv.base, { email: 'kwesi@test.gh' });
  const up = await client.patch('/api/me', { name: 'Kwesi Arthur', email: 'kwesi.a@test.gh', accountType: 'restaurant', marketingOptIn: true });
  assert.equal(up.status, 200);
  assert.equal(up.body.user.accountType, 'restaurant');
  const { user: other } = await signUp(srv.base, { email: 'taken@test.gh' });
  assert.ok(other);
  assert.equal((await client.patch('/api/me', { name: 'K A', email: 'taken@test.gh', accountType: 'household', marketingOptIn: false })).status, 409);

  db().prepare("UPDATE users SET terms_version = 'old' WHERE phone = ?").run(phone);
  assert.equal((await client.get('/api/me')).body.user.needsTerms, true);
  assert.equal((await client.post('/api/me/accept-terms')).body.user.needsTerms, false);

  await client.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery, phone });
  const ex = await client.get('/api/me/export');
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition'), /attachment; filename="ntintan-my-data-/);
  assert.equal(ex.body.account.phone, phone);
  assert.equal(ex.body.orders.length, 1);
  assert.equal(ex.body.orders[0].items[0].name, 'Tomatoes');
});

test('account deletion: blocked with open orders or wallet balance; anonymises data', async () => {
  const a = await admin(srv.base);
  const { client, user, phone } = await signUp(srv.base, { email: 'delete.me@test.gh' });
  const o = await client.post('/api/orders', { items: [{ productId: 3, qty: 1 }], paymentMethod: 'cash', ...delivery, phone, name: 'Delete Me' });
  assert.equal((await client.post('/api/me/delete', { confirm: 'DELETE' })).body.error.code, 'open_orders');
  for (const s of ['processing', 'out_for_delivery', 'delivered']) await a.patch(`/api/admin/orders/${o.body.order.ref}`, { status: s });
  await a.post(`/api/admin/users/${user.id}/credit`, { amount: 500, note: 'Goodwill credit' });
  assert.equal((await client.post('/api/me/delete', { confirm: 'delete' })).status, 422, 'must type DELETE');
  assert.equal((await client.post('/api/me/delete', { confirm: 'DELETE' })).body.error.code, 'wallet_not_empty');
  const del = await client.post('/api/me/delete', { confirm: 'DELETE', confirmForfeit: true });
  assert.equal(del.status, 200);
  assert.equal((await client.get('/api/me')).status, 401, 'signed out');

  const row = db().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(row.phone, null);
  assert.equal(row.email, null);
  assert.equal(row.name, 'Deleted customer');
  assert.ok(row.deleted_at);
  const ord = db().prepare('SELECT * FROM orders WHERE ref = ?').get(o.body.order.ref);
  assert.equal(ord.customer_name, 'Deleted customer');
  assert.equal(ord.address, '[removed]');
  assert.equal(ord.total, 4400 + 2500, 'financial record kept');

  // same phone can sign up fresh
  db().prepare("UPDATE otp_codes SET created_at = datetime('now', '-2 minutes') WHERE phone = ?").run(phone);
  const again = await signUp(srv.base, { phone });
  assert.notEqual(again.user.id, user.id);
});

test('retention job removes old codes, sessions and logs', async () => {
  db().prepare("INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, created_at) VALUES ('0559999999','login','x', datetime('now','-2 days'), datetime('now','-2 days'))").run();
  db().prepare("INSERT INTO sms_log (recipient, purpose, body, status, created_at) VALUES ('0559999999','notification','old','sent', datetime('now','-13 months'))").run();
  db().prepare("INSERT INTO leads (type, payload, created_at) VALUES ('newsletter','{}', datetime('now','-25 months'))").run();
  const { retentionService } = require('../src/services/misc');
  retentionService(db())();
  assert.equal(db().prepare("SELECT COUNT(*) n FROM otp_codes WHERE phone = '0559999999'").get().n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM sms_log WHERE body = 'old'").get().n, 0);
  assert.equal(db().prepare("SELECT COUNT(*) n FROM leads WHERE created_at < datetime('now','-24 months')").get().n, 0);
});

// ---------------------------------------------------------------- legal pages
test('legal pages are served with company details filled in', async () => {
  const c = new Client(srv.base);
  for (const p of ['/terms', '/privacy']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(r.text, /\{\{[A-Z_]+\}\}/, `${p}: no unreplaced tokens`);
    assert.match(r.text, /Version 2026-10-28/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
  const terms = (await c.get('/terms')).text;
  assert.match(terms, /Terms of Sale &amp; Customer Conditions/);
  assert.match(terms, /18 years old/);
  assert.match(terms, /laws of the Republic of Ghana/);
  assert.match(terms, /100 OGY = GH₵1/);
  assert.match(terms, /GH₵25\.00 per order/);
  const privacy = (await c.get('/privacy')).text;
  assert.match(privacy, /Data Protection Act, 2012 \(Act 843\)/);
  assert.match(privacy, /Sailup/);
  assert.match(privacy, /Paystack/);
  const home = (await c.get('/')).text;
  assert.match(home, /href="\/terms"/);
  assert.match(home, /href="\/privacy"/);
});
