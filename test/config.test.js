'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (env) => spawnSync(process.execPath, ['-e', "require('./src/config')"], {
  cwd: path.join(__dirname, '..'),
  env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env },
  encoding: 'utf8'
});
const good = { APP_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://shop.example.com', PAYMENTS_MODE: 'disabled', SMS_MODE: 'sailup', SAILUP_API_KEY: 'sailup_abc123', SAILUP_SENDER_ID: 'NTINTAN' };

test('production refuses unsafe configuration', () => {
  assert.equal(run(good).status, 0);
  assert.match(run({ ...good, APP_SECRET: 'short' }).stderr, /APP_SECRET/);
  assert.match(run({ ...good, PUBLIC_URL: 'http://shop.example.com' }).stderr, /https/);
  assert.match(run({ ...good, PAYMENTS_MODE: 'simulate' }).stderr, /simulate is not allowed/);
  assert.match(run({ ...good, PAYMENTS_MODE: 'paystack', PAYSTACK_SECRET_KEY: '' }).stderr, /PAYSTACK_SECRET_KEY/);
  assert.equal(run({ ...good, PAYMENTS_MODE: 'paystack', PAYSTACK_SECRET_KEY: 'sk_live_abc123' }).status, 0);
  assert.match(run({ ...good, SMS_MODE: 'log' }).stderr, /SMS_MODE=log is not allowed/);
  assert.match(run({ ...good, SAILUP_API_KEY: 'wrong' }).stderr, /SAILUP_API_KEY/);
  assert.match(run({ ...good, SAILUP_SENDER_ID: '' }).stderr, /SAILUP_SENDER_ID/);
  assert.match(run(good).stderr, /LEGAL_COMPANY_NAME/, 'warns about unset legal details');
});

test('demo mode allows simulated payments and on-screen codes in production, never live keys', () => {
  const demo = { APP_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://demo.example.com', DEMO_MODE: '1', PAYMENTS_MODE: 'simulate', SMS_MODE: 'log' };
  const ok = run(demo);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /DEMO_MODE is on/);
  assert.match(run({ ...demo, PAYMENTS_MODE: 'paystack', PAYSTACK_SECRET_KEY: 'sk_live_abc123' }).stderr, /live Paystack key/);
  assert.match(run({ ...demo, PUBLIC_URL: 'http://demo.example.com' }).stderr, /https/, 'still requires HTTPS');
  assert.match(run({ ...demo, APP_SECRET: 'short' }).stderr, /APP_SECRET/, 'still requires a real secret');
});
