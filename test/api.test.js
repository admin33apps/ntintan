'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, delivery, signUp, admin } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.resetLimits());

// ---------------------------------------------------------------- platform
test('health check and security headers', async () => {
  const c = new Client(srv.base);
  const h = await c.get('/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.body.status, 'ok');
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  const page = await c.get('/');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.text, /NTINTAN/);
});

test('static files: traversal, dotfiles and unknown paths are blocked', async () => {
  const c = new Client(srv.base);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fsrc%2fconfig.js', '/.env', '/js/../../package.json']) {
    const r = await c.get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /APP_SECRET|createApp|"scripts"/, p);
  }
  assert.equal((await c.get('/nope')).status, 404);
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.req('POST', '/index.html', {})).status, 405);
});

// ---------------------------------------------------------------- catalog
test('catalog is seeded from the supplied data', async () => {
  const c = new Client(srv.base);
  const [{ body: cat }, { body: prod }, { body: units }, { body: farmers }, { body: market }] = await Promise.all(
    ['/api/categories', '/api/products', '/api/units', '/api/farmers', '/api/market-prices'].map((p) => c.get(p)));
  assert.equal(cat.categories.length, 10);
  assert.equal(prod.products.length, 205); // 72 produce + 16 traditional drinks + 111 from the makers list + 6 halal
  assert.equal(units.units.length, 20);
  assert.equal(farmers.farmers.length, 11);
  assert.ok(farmers.farmers.every((f) => !('name' in f)), 'public farmer directory must not expose personal names');
  assert.equal(farmers.farmers[0].enterprise, 'Unique Time Tells Enterprise');
  assert.equal(market.marketPrices.length, 10);
  assert.equal(market.priceHistory.length, 3);
  const tomatoes = prod.products.find((p) => p.name === 'Tomatoes');
  assert.equal(tomatoes.price, 6900); // GH₵69 → 6,900 pesewas = 6,900 OGY (100 OGY = GH₵1)
  assert.equal(tomatoes.purchasable, true);
  const yam = prod.products.find((p) => p.name === 'Yam');
  assert.equal(yam.price, null);
  assert.equal(yam.purchasable, false);
  assert.equal(yam.defaultUnit.name, 'Heap');
  const maize = market.marketPrices.find((m) => m.id === 1);
  assert.deepEqual([maize.min, maize.max], [110000, 464500]);
  const cassava = market.priceHistory.find((h) => h.productName === 'Cassava');
  assert.equal(cassava.changePct, -25.1);
  const cfg = (await c.get('/api/config')).body;
  assert.equal(cfg.ogyPerGhs, 100);
});

// ---------------------------------------------------------------- CSRF / validation
test('state-changing requests require a matching CSRF token and same origin', async () => {
  const c = await new Client(srv.base).init();
  const body = { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery };
  assert.equal((await c.post('/api/orders', body, { csrf: false })).status, 403);
  assert.equal((await c.post('/api/orders', body, { csrf: false, headers: { 'X-CSRF-Token': 'x'.repeat(32) } })).status, 403);
  assert.equal((await c.post('/api/orders', body, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.post('/api/orders', body)).status, 201);
});

test('input validation returns field errors', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery, phone: '12345' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.phone);
  const r2 = await c.post('/api/orders', { items: [{ productId: 5, qty: 0 }], paymentMethod: 'cash', ...delivery });
  assert.equal(r2.status, 422);
  const r3 = await c.req('POST', '/api/orders', undefined, { raw: '{bad json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r3.status, 400);
  const r4 = await c.req('POST', '/api/orders', undefined, { raw: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r4.status, 415);
  const big = await c.req('POST', '/api/orders', undefined, { raw: JSON.stringify({ x: 'a'.repeat(70 * 1024) }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413);
});

// ---------------------------------------------------------------- orders
test('server computes totals and ignores client-sent prices', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/orders', { items: [{ productId: 5, qty: 2, price: 1 }, { productId: 3, qty: 1 }], paymentMethod: 'cash', total: 1, ...delivery });
  assert.equal(r.status, 201);
  const o = r.body.order;
  assert.equal(o.subtotal, 6900 * 2 + 4400);
  assert.equal(o.deliveryFee, 2500);
  assert.equal(o.total, 6900 * 2 + 4400 + 2500);
  assert.equal(o.status, 'confirmed');
  assert.match(o.ref, /^NTN-[A-Z2-9]{6}$/);
  assert.equal(r.body.order.phone, undefined, 'customer PII is not echoed in public order view');

  const free = await c.post('/api/orders/quote', { items: [{ productId: 2, qty: 1 }], paymentMethod: 'cash' });
  assert.equal(free.body.quote.deliveryFee, 0, 'free delivery at GH₵300+');
  const dup = await c.post('/api/orders/quote', { items: [{ productId: 5, qty: 1 }, { productId: 5, qty: 2 }], paymentMethod: 'cash' });
  assert.equal(dup.body.quote.lines[0].qty, 3, 'duplicate lines are merged');
});

test('price-on-request and unknown products cannot be ordered', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/orders', { items: [{ productId: 1, qty: 1 }], paymentMethod: 'cash', ...delivery });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'price_on_request');
  assert.equal((await c.post('/api/orders/quote', { items: [{ productId: 9999, qty: 1 }], paymentMethod: 'cash' })).status, 422);
});

test('order tracking requires matching reference and phone', async () => {
  const c = await new Client(srv.base).init();
  const { body } = await c.post('/api/orders', { items: [{ productId: 6, qty: 1 }], paymentMethod: 'cash', ...delivery });
  const ok = await c.post('/api/orders/track', { ref: body.order.ref, phone: '+233 24 123 4567' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.ref, body.order.ref);
  assert.equal((await c.post('/api/orders/track', { ref: body.order.ref, phone: '0559999999' })).status, 404);
});

// ---------------------------------------------------------------- auth
test('orders require accepting the Terms of Sale', async () => {
  const c = await new Client(srv.base).init();
  const r = await c.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery, acceptTerms: false });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'terms_required');
  const ok = await c.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', ...delivery });
  const a = await admin(srv.base);
  const o = (await a.get(`/api/admin/orders?q=${ok.body.order.ref}`)).body.orders[0];
  assert.equal(o.termsVersion, '2026-10-28.1');
});

test('admin endpoints are protected', async () => {
  const anon = await new Client(srv.base).init();
  assert.equal((await anon.get('/api/admin/stats')).status, 401);
  const { client } = await signUp(srv.base);
  assert.equal((await client.get('/api/admin/stats')).status, 403);
  assert.equal((await client.patch('/api/admin/products/5', { price: 1 })).status, 403);
  const a = await admin(srv.base);
  const s = await a.get('/api/admin/stats');
  assert.equal(s.status, 200);
  assert.equal(s.body.stats.productsTotal, 215); // 209 + 6 halal
});

// ---------------------------------------------------------------- wallet + coupons
test('Ogya wallet: admin credit, 5% discount, insufficient balance, refunds on cancel', async () => {
  const a = await admin(srv.base);
  const { client, user } = await signUp(srv.base);
  const poor = await client.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'ogya', ...delivery });
  assert.equal(poor.status, 402);
  assert.equal(poor.body.error.code, 'insufficient_ogya');

  const cr = await a.post(`/api/admin/users/${user.id}/credit`, { amount: 50000, note: 'Cash top-up at hub' });
  assert.equal(cr.body.balance, 50000); // 50,000 OGY = GH₵500

  const r = await client.post('/api/orders', { items: [{ productId: 5, qty: 2 }], paymentMethod: 'ogya', ...delivery });
  assert.equal(r.status, 201);
  const o = r.body.order;
  assert.equal(o.discount, Math.floor(13800 * 0.05));
  assert.equal(o.total, 13800 + 2500 - 690);
  assert.equal(o.paid, true);
  const w = await client.get('/api/wallet');
  assert.equal(w.body.balance, 50000 - o.total);

  const cancel = await a.patch(`/api/admin/orders/${o.ref}`, { status: 'cancelled' });
  assert.equal(cancel.body.order.status, 'cancelled');
  assert.equal((await client.get('/api/wallet')).body.balance, 50000, 'Ogya refunded on cancellation');
  assert.equal((await a.patch(`/api/admin/orders/${o.ref}`, { status: 'processing' })).status, 409, 'cannot reopen cancelled orders');
});

test('food coupons: buy with Ogya, check, partial redemption, reversal', async () => {
  const a = await admin(srv.base);
  const { client, user } = await signUp(srv.base);
  await a.post(`/api/admin/users/${user.id}/credit`, { amount: 20000, note: 'Test funds' });
  const buy = await client.post('/api/coupons', { amount: 10000, recipientName: 'Maame Akosua', recipientPhone: '0244000000', method: 'ogya' });
  assert.equal(buy.status, 201);
  const code = buy.body.coupon.code;
  assert.match(code, /^NTN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await client.get('/api/wallet')).body.balance, 10000);

  const guest = await new Client(srv.base).init();
  const chk = await guest.post('/api/coupons/check', { code: code.toLowerCase() });
  assert.equal(chk.body.coupon.balance, 10000);
  assert.equal(chk.body.coupon.recipientPhone, undefined, 'no PII leaked by balance check');
  assert.equal((await guest.post('/api/coupons/check', { code: 'NTN-AAAA-AAAA' })).status, 404);

  const order = await guest.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', couponCode: code, ...delivery });
  assert.equal(order.status, 201);
  assert.equal(order.body.order.couponAmount, 6900 + 2500);
  assert.equal(order.body.order.total, 0);
  assert.equal(order.body.order.paymentMethod, 'coupon');
  assert.equal((await guest.post('/api/coupons/check', { code })).body.coupon.balance, 600);

  await a.patch(`/api/admin/orders/${order.body.order.ref}`, { status: 'cancelled' });
  assert.equal((await guest.post('/api/coupons/check', { code })).body.coupon.balance, 10000, 'coupon balance restored');

  assert.equal((await guest.post('/api/coupons', { amount: 10000, recipientName: 'X Y', recipientPhone: '0244000000', method: 'ogya' })).status, 401);
});

test('admin-issued coupons and voiding', async () => {
  const a = await admin(srv.base);
  const r = await a.post('/api/admin/coupons', { amount: 5000, recipientName: 'Asokwa Basic School', recipientPhone: '0244111222' });
  assert.equal(r.status, 201);
  const code = r.body.coupon.code;
  assert.equal((await a.post(`/api/admin/coupons/${code}/void`)).status, 200);
  const g = await new Client(srv.base).init();
  const q = await g.post('/api/orders/quote', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'cash', couponCode: code });
  assert.equal(q.status, 422);
});

// ---------------------------------------------------------------- stock & admin products
test('stock limits are enforced atomically and restored on cancel', async () => {
  const a = await admin(srv.base);
  const upd = await a.patch('/api/admin/products/6', { stock: 2 });
  assert.equal(upd.body.product.stock, 2);
  const g = await new Client(srv.base).init();
  assert.equal((await g.post('/api/orders', { items: [{ productId: 6, qty: 3 }], paymentMethod: 'cash', ...delivery })).status, 409);
  const ok = await g.post('/api/orders', { items: [{ productId: 6, qty: 2 }], paymentMethod: 'cash', ...delivery });
  assert.equal(ok.status, 201);
  const p = (await g.get('/api/products/6')).body.product;
  assert.equal(p.stock, 0);
  assert.equal(p.purchasable, false);
  await a.patch(`/api/admin/orders/${ok.body.order.ref}`, { status: 'cancelled' });
  assert.equal((await g.get('/api/products/6')).body.product.stock, 2);
  await a.patch('/api/admin/products/6', { stock: null });
});

test('admin can price a product so it becomes purchasable', async () => {
  const a = await admin(srv.base);
  const r = await a.patch('/api/admin/products/21', { price: 1500, priceUnitLabel: 'Olonka' });
  assert.equal(r.status, 200);
  assert.equal(r.body.product.purchasable, true);
  assert.equal(r.body.product.priceUnit, 'Olonka');
  assert.equal((await a.patch('/api/admin/products/21', { price: -5 })).status, 422);
  await a.patch('/api/admin/products/21', { price: null });
});

// ---------------------------------------------------------------- order lifecycle
test('order status transitions follow the workflow', async () => {
  const a = await admin(srv.base);
  const g = await new Client(srv.base).init();
  const { body } = await g.post('/api/orders', { items: [{ productId: 3, qty: 1 }], paymentMethod: 'cash', ...delivery });
  const ref = body.order.ref;
  assert.equal((await a.patch(`/api/admin/orders/${ref}`, { status: 'delivered' })).status, 409);
  for (const s of ['processing', 'out_for_delivery', 'delivered']) {
    const r = await a.patch(`/api/admin/orders/${ref}`, { status: s });
    assert.equal(r.status, 200, s);
  }
  const fin = (await a.get(`/api/admin/orders?q=${ref}`)).body.orders[0];
  assert.equal(fin.status, 'delivered');
  assert.equal(fin.paid, true, 'cash orders marked paid on delivery');
  assert.equal((await a.patch(`/api/admin/orders/${ref}`, { status: 'cancelled' })).status, 409);
});

// ---------------------------------------------------------------- simulated online payments
test('online payment (simulated): success is verified once, failure releases stock', async () => {
  const g = await new Client(srv.base).init();
  const r = await g.post('/api/orders', { items: [{ productId: 5, qty: 1 }], paymentMethod: 'momo', ...delivery });
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, 'pending_payment');
  const ref = r.body.payment.reference;
  assert.match(r.body.payment.authorizationUrl, /\/pay\/simulate\?reference=/);
  const pending = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(pending.body.payment.status, 'initialized');
  assert.equal((await g.post('/api/payments/simulate', { reference: ref, outcome: 'success' })).status, 200);
  const v1 = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(v1.body.payment.status, 'success');
  assert.equal(v1.body.order.status, 'confirmed');
  assert.equal(v1.body.order.paid, true);
  const v2 = await g.post('/api/payments/verify', { reference: ref });
  assert.equal(v2.body.payment.status, 'success', 'idempotent');

  const a = await admin(srv.base);
  await a.patch('/api/admin/products/3', { stock: 5 });
  const f = await g.post('/api/orders', { items: [{ productId: 3, qty: 2 }], paymentMethod: 'card', ...delivery });
  assert.equal((await g.get('/api/products/3')).body.product.stock, 3);
  await g.post('/api/payments/simulate', { reference: f.body.payment.reference, outcome: 'failed' });
  const vf = await g.post('/api/payments/verify', { reference: f.body.payment.reference });
  assert.equal(vf.body.payment.status, 'failed');
  assert.equal(vf.body.order.status, 'cancelled');
  assert.equal((await g.get('/api/products/3')).body.product.stock, 5, 'stock released');
  await a.patch('/api/admin/products/3', { stock: null });
});

test('wallet top-up via online payment credits OGY', async () => {
  const { client } = await signUp(srv.base);
  const t = await client.post('/api/wallet/topup', { amount: 5000, method: 'momo' });
  assert.equal(t.status, 200);
  await client.post('/api/payments/simulate', { reference: t.body.payment.reference, outcome: 'success' });
  await client.post('/api/payments/verify', { reference: t.body.payment.reference });
  assert.equal((await client.get('/api/wallet')).body.balance, 5000); // GH₵50 → 5,000 OGY
});

test('webhook rejects unsigned requests', async () => {
  const g = new Client(srv.base);
  const r = await g.req('POST', '/api/payments/webhook', undefined, { raw: JSON.stringify({ event: 'charge.success', data: { reference: 'X' } }), headers: { 'Content-Type': 'application/json' }, csrf: false });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- leads & rate limiting
test('lead forms are validated and visible to admins', async () => {
  const g = await new Client(srv.base).init();
  assert.equal((await g.post('/api/leads/school', { name: 'Asokwa M/A', role: 'School caterer', pupils: 450, phone: '0244123123', region: 'Ashanti' })).status, 201);
  assert.equal((await g.post('/api/leads/school', { name: 'X', role: 'Hacker', pupils: -1, phone: '1', region: 'Mars' })).status, 422);
  assert.equal((await g.post('/api/leads/unknown', {})).status, 404);
  assert.equal((await g.post('/api/leads/quote', { name: 'Kwame', phone: '0244123123', region: 'Volta', productId: 12, quantity: '2 tonnes' })).status, 201);
  const a = await admin(srv.base);
  const leads = (await a.get('/api/admin/leads')).body.leads;
  assert.ok(leads.some((l) => l.type === 'school' && l.details.pupils === 450));
  assert.ok(leads.some((l) => l.type === 'quote' && l.details.quantity === '2 tonnes'));
});

test('lookups are rate limited', async () => {
  const g = await new Client(srv.base).init();
  let last;
  for (let i = 0; i < 21; i++) last = await g.post('/api/coupons/check', { code: 'NTN-AAAA-AAAA' });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});
