'use strict';
const http = require('node:http');

const PORT = 40000 + Math.floor(Math.random() * 20000);
process.env.NODE_ENV = 'test';
process.env.PAYMENTS_MODE = 'simulate';
process.env.PORT = String(PORT);
process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.ADMIN_EMAIL = 'admin@ntintan.test';
process.env.ADMIN_PASSWORD = 'Admin-Password-123';
process.env.ADMIN_PHONE = '0200000001';
process.env.SMS_MODE = 'log';

const config = require('../src/config');
const { createApp } = require('../src/app');

async function startServer(overrides = {}, port = PORT) {
  const cfg = { ...config, ...overrides, PUBLIC_URL: `http://127.0.0.1:${port}` };
  const app = createApp(cfg, { dbPath: ':memory:' });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    app, base: cfg.PUBLIC_URL,
    async close() { await new Promise((r) => server.close(r)); app.close(); },
    resetLimits() { Object.values(app.limits).forEach((l) => l.reset()); }
  };
}

/** Cookie-jar HTTP client that behaves like the browser app. */
class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
  }
  async init() { const r = await this.req('GET', '/api/session'); this.csrf = r.body.csrfToken; return this; }
  async req(method, path, body, { headers = {}, csrf = true, raw } = {}) {
    const h = { Accept: 'application/json', Cookie: this.cookieHeader(), ...headers };
    if (method !== 'GET' && body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf && this.csrf) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, body: json, text };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b ?? {}, o); }
  patch(p, b, o) { return this.req('PATCH', p, b ?? {}, o); }
  del(p, o) { return this.req('DELETE', p, {}, o); }
}

const delivery = {
  name: 'Ama Mensah', phone: '024 123 4567', region: 'Ashanti', town: 'Asokwa',
  address: 'AK-039-5028, near the Total station', deliverySlot: 'Tomorrow, 8am – 12pm', acceptTerms: true
};

const randomPhone = () => '05' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');

/** Sign up a new customer through the real OTP flow (SMS_MODE=log returns the code as devCode). */
async function signUp(base, { phone = randomPhone(), name = 'Kofi Boateng', email } = {}) {
  const c = await new Client(base).init();
  const req = await c.post('/api/auth/otp/request', { phone });
  if (req.status !== 200) throw new Error('otp request failed ' + JSON.stringify(req.body));
  const ver = await c.post('/api/auth/otp/verify', { phone, code: req.body.devCode });
  if (!ver.body?.needsProfile) throw new Error('verify failed ' + JSON.stringify(ver.body));
  const done = await c.post('/api/auth/otp/complete', { signupToken: ver.body.signupToken, name, email, acceptTerms: true });
  if (done.status !== 201) throw new Error('complete failed ' + JSON.stringify(done.body));
  return { client: c, user: done.body.user, phone };
}

const adminCache = new Map();
/** Admin sign-in with password + SMS code; cached per server to respect OTP cooldowns. */
async function admin(base) {
  if (adminCache.has(base)) return adminCache.get(base);
  const c = await new Client(base).init();
  const r = await c.post('/api/auth/admin/login', { email: 'admin@ntintan.test', password: 'Admin-Password-123' });
  if (!r.body?.otpRequired) throw new Error('admin login failed ' + JSON.stringify(r.body));
  const v = await c.post('/api/auth/admin/verify', { challenge: r.body.challenge, code: r.body.devCode });
  if (v.status !== 200) throw new Error('admin verify failed ' + JSON.stringify(v.body));
  adminCache.set(base, c);
  return c;
}

module.exports = { startServer, Client, delivery, signUp, admin, randomPhone, PORT, config };
