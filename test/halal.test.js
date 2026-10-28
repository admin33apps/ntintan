'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, admin } = require('./helpers');

let srv, a, products;
const find = (n) => products.find((p) => p.name === n);
before(async () => {
  srv = await startServer();
  a = await admin(srv.base);
  products = (await new Client(srv.base).get('/api/products')).body.products;
});
after(async () => { await srv.close(); });
beforeEach(() => srv.resetLimits());

test('halal section: 6 seeded halal products, none pork or alcohol, idempotent seeding', async () => {
  const halal = products.filter((p) => p.halal);
  assert.equal(halal.length, 6);
  assert.ok(halal.every((p) => !p.ageRestricted && !/pork|pig|bacon|ham\b/i.test(p.name)));
  assert.ok(halal.some((p) => p.name === 'Live Ram for Eid & Naming Ceremonies'));
  assert.equal(find('Pork').halal, false);
  require('../src/seed').seedHalal(srv.app.db);
  assert.equal(srv.app.db.prepare('SELECT COUNT(*) n FROM products WHERE halal = 1').get().n, 6, 'no duplicates');
});

test('admin can mark and unmark a product halal', async () => {
  const id = find('Eggs').id;
  let r = await a.patch(`/api/admin/products/${id}`, { halal: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.product.halal, true);
  r = await a.patch(`/api/admin/products/${id}`, { halal: false });
  assert.equal(r.body.product.halal, false);
});

test('pork and alcohol can never be marked halal', async () => {
  for (const name of ['Pork', 'Assorted Meats', 'Club Premium Lager']) {
    const r = await a.patch(`/api/admin/products/${find(name).id}`, { halal: true });
    assert.equal(r.status, 400, `${name} must be refused`);
  }
  // A halal product cannot be turned into an 18+ alcoholic one
  const r = await a.patch(`/api/admin/products/${find('Halal Beef').id}`, { ageRestricted: true });
  assert.equal(r.status, 400);
  assert.equal((await new Client(srv.base).get(`/api/products/${find('Halal Beef').id}`)).body.product.ageRestricted, false);
});

test('customers cannot change halal status', async () => {
  const r = await new Client(srv.base).init();
  const res = await r.patch(`/api/admin/products/${find('Eggs').id}`, { halal: true });
  assert.ok([401, 403].includes(res.status));
});
