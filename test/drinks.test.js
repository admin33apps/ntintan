'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, delivery, signUp, admin } = require('./helpers');

let srv, a;
const ID = {};
before(async () => {
  srv = await startServer();
  a = await admin(srv.base);
  const { products } = (await new Client(srv.base).get('/api/products')).body;
  const find = (n) => products.find((p) => p.name === n).id;
  Object.assign(ID, { WINE: find('Laborie Wines'), LAGER: find('Club Premium Lager'), SOBOLO: find('Sobolo'), WATER: find('Premium Still Spring Water (750 ml glass)') });
  // Admin prices a few drinks so they can be bought
  for (const [id, price] of [[ID.WINE, 18000], [ID.LAGER, 26000], [ID.SOBOLO, 1500], [ID.WATER, 3500]]) {
    const r = await a.patch(`/api/admin/products/${id}`, { price, priceUnitLabel: id === ID.LAGER ? 'Crate of 12' : null });
    assert.equal(r.status, 200);
  }
});
after(async () => { await srv.close(); });
beforeEach(() => srv.resetLimits());

test('drinks catalogue: 4 sub-categories, alcohol flagged 18+, new measures, idempotent seeding', async () => {
  const c = new Client(srv.base);
  const { products } = (await c.get('/api/products')).body;
  const drinks = products.filter((p) => p.categoryId === 10);
  assert.equal(drinks.length, 127, '16 traditional/generic + 111 from the makers list');
  const by = (sub) => drinks.filter((p) => p.subcategory === sub);
  assert.equal(by('wine').length, 4);
  assert.equal(by('alcoholic').length, 73);
  assert.equal(by('non_alcoholic').length, 37);
  assert.equal(by('water').length, 13);
  assert.ok(by('wine').every((p) => p.ageRestricted) && by('alcoholic').every((p) => p.ageRestricted));
  assert.ok(by('non_alcoholic').every((p) => !p.ageRestricted) && by('water').every((p) => !p.ageRestricted));
  assert.ok(by('water').filter((p) => !p.brand).every((p) => /glass/i.test(p.name)), 'house premium waters are glass-bottled');
  const cats = (await c.get('/api/categories')).body.categories;
  assert.equal(cats.find((x) => x.id === 10).name, 'Wine & African Drinks');
  assert.equal((await c.get('/api/units')).body.units.length, 20);
  require('../src/seed').seedDrinks(srv.app.db);
  require('../src/seed-brands').seedBrands(srv.app.db);
  assert.equal(srv.app.db.prepare('SELECT COUNT(*) n FROM products WHERE category_id = 10').get().n, 137, 'no duplicates (26 + 111)');
});

test('alcohol orders require 18+ confirmation; soft drinks and water do not', async () => {
  const g = await new Client(srv.base).init();
  const q = await g.post('/api/orders/quote', { items: [{ productId: ID.WINE, qty: 1 }, { productId: ID.SOBOLO, qty: 2 }], paymentMethod: 'cash' });
  assert.equal(q.body.quote.ageRestricted, true);
  const no = await g.post('/api/orders', { items: [{ productId: ID.WINE, qty: 1 }], paymentMethod: 'cash', ...delivery });
  assert.equal(no.status, 422);
  assert.equal(no.body.error.code, 'age_confirmation_required');
  const yes = await g.post('/api/orders', { items: [{ productId: ID.WINE, qty: 1 }, { productId: ID.SOBOLO, qty: 2 }], paymentMethod: 'cash', ...delivery, confirmAge: true });
  assert.equal(yes.status, 201);
  assert.equal(yes.body.order.ageRestricted, true);
  assert.equal(yes.body.order.subtotal, 18000 + 3000);
  assert.equal(yes.body.order.items[0].name, 'Laborie Wines');
  const soft = await g.post('/api/orders', { items: [{ productId: ID.SOBOLO, qty: 1 }, { productId: ID.WATER, qty: 4 }], paymentMethod: 'cash', ...delivery });
  assert.equal(soft.status, 201);
  assert.equal(soft.body.order.ageRestricted, false);
  const adminView = (await a.get(`/api/admin/orders?q=${yes.body.order.ref}`)).body.orders[0];
  assert.equal(adminView.ageRestricted, true);
  const sms = srv.app.services.sms.outbox.find((m) => m.body.includes(yes.body.order.ref));
  assert.match(sms.body, /18\+ and show ID/);
});

test('school accounts and programme coupons cannot buy alcohol', async () => {
  const { client, phone } = await signUp(srv.base);
  await client.patch('/api/me', { name: 'Asokwa M/A School', email: null, accountType: 'school', marketingOptIn: false });
  const r = await client.post('/api/orders', { items: [{ productId: ID.LAGER, qty: 1 }], paymentMethod: 'cash', ...delivery, phone, confirmAge: true });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'alcohol_not_allowed');
  assert.equal((await client.post('/api/orders', { items: [{ productId: ID.SOBOLO, qty: 3 }], paymentMethod: 'cash', ...delivery, phone })).status, 201, 'soft drinks fine');

  const issued = (await a.post('/api/admin/coupons', { amount: 50000, recipientName: 'Relief Programme', recipientPhone: '0244555666' })).body.coupon.code;
  const g = await new Client(srv.base).init();
  const blocked = await g.post('/api/orders', { items: [{ productId: ID.WINE, qty: 1 }], paymentMethod: 'cash', couponCode: issued, ...delivery, confirmAge: true });
  assert.equal(blocked.body.error.code, 'alcohol_coupon_not_allowed');
  assert.equal((await g.post('/api/orders', { items: [{ productId: ID.WATER, qty: 2 }], paymentMethod: 'cash', couponCode: issued, ...delivery })).status, 201, 'programme coupon fine for water');
});

test('admin can mark any product 18+', async () => {
  const r = await a.patch('/api/admin/products/94', { ageRestricted: true });
  assert.equal(r.body.product.ageRestricted, true);
  await a.patch('/api/admin/products/94', { ageRestricted: false });
});

test('Terms include the alcohol section with licence details and FDA-style warnings', async () => {
  const t = (await new Client(srv.base).get('/terms')).text;
  assert.match(t, /Alcoholic drinks and glass bottles/);
  assert.match(t, /Liquor Licensing Act, 1970 \(Act 331\)/);
  assert.match(t, /Not for sale to persons under 18/);
  assert.match(t, /Not recommended for pregnant or breastfeeding women/);
  assert.match(t, /Version 2026-10-28\.1/);
  assert.doesNotMatch(t, /\{\{[A-Z_]+\}\}/);
  const h = (await new Client(srv.base).get('/')).text;
  assert.match(h, /id="drinks"/);
  assert.match(h, /Not for sale to persons under 18/);
});

test('makers directory: 30 African makers, every listed product linked, non-drinks excluded', async () => {
  const c = new Client(srv.base);
  const { brands } = (await c.get('/api/brands')).body;
  assert.equal(brands.length, 30);
  const total = brands.reduce((n, b) => n + b.productCount, 0);
  assert.equal(total, 111);
  const abl = brands.find((b) => b.name === 'Accra Brewery Limited (ABL)');
  assert.deepEqual(abl.products, ['Club Premium Lager', 'Eagle Lager', 'Beta Malt', 'Club Shandy']);
  assert.deepEqual(abl.countryCodes, ['GH']);
  const twellium = brands.find((b) => b.name === 'Twellium Industrial Company');
  assert.deepEqual(twellium.countryCodes, ['GH', 'CI']);
  const snell = brands.find((b) => b.name === 'Edward Snell & Co.');
  assert.ok(!snell.products.includes('Glenryck'), 'Glenryck is not a beverage');
  assert.match(snell.notes, /Glenryck/);
  const { products } = (await c.get('/api/products')).body;
  const p = (n) => products.find((x) => x.name === n);
  assert.equal(p('Tusker Lager').brand.country, 'Kenya / East Africa Regional');
  assert.equal(p('Tusker Lager').ageRestricted, true);
  assert.equal(p('Alvaro (Non-Alcoholic)').ageRestricted, false);
  assert.equal(p('Malta Guinness').ageRestricted, false);
  assert.equal(p('Amarula Cream Liqueur').subcategory, 'alcoholic');
  assert.equal(p('Shahrazad Wines').subcategory, 'wine');
  assert.equal(p('Verna Mineral Water').subcategory, 'water');
  assert.equal(p('Storm Energy Drink').subcategory, 'non_alcoholic');
  const unsure = products.filter((x) => x.verifyAbv).map((x) => x.name).sort();
  assert.deepEqual(unsure, ['Club Shandy', 'Dubic Malt', 'Joy Twedie Ginger', 'Summit Malt']);
  assert.ok(products.filter((x) => x.verifyAbv).every((x) => x.ageRestricted), 'unconfirmed drinks are treated as 18+');
  // search by maker and country
  assert.ok(products.some((x) => x.brand?.name.includes('Kasapreko') && x.name === 'Alomo Bitters'));
});

test('generic drinks superseded by named brands are hidden unless already priced or ordered', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.get('/api/products/79')).status, 404, 'generic lager hidden');
  await a.patch('/api/admin/products/79', { active: true, price: 25000 });
  require('../src/seed-brands').seedBrands(srv.app.db);
  assert.equal((await c.get('/api/products/79')).status, 200, 'priced generic is never hidden by re-seeding');
});

test('admin confirming a label clears the "check alcohol content" flag', async () => {
  const id = (await new Client(srv.base).get('/api/products')).body.products.find((x) => x.name === 'Club Shandy').id;
  const r = await a.patch(`/api/admin/products/${id}`, { ageRestricted: false });
  assert.equal(r.body.product.ageRestricted, false);
  assert.equal(r.body.product.verifyAbv, false);
});
