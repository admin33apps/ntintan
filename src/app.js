'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const dbLib = require('./db');
const { seed, seedDrinks, seedHalal, REGIONS } = require('./seed');
const { HttpError, Router, parseCookies, serializeCookie, appendHeader, readBody, sendJson } = require('./lib/http');
const sec = require('./lib/security');
const { v, validate } = require('./lib/validate');
const { auditService, notifyService, retentionService, leadsService, statsService } = require('./services/misc');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml'
};
const DELIVERY_SLOTS = ['Tomorrow, 8am – 12pm', 'Tomorrow, 12pm – 4pm', 'Tomorrow, 4pm – 8pm', 'Call me to arrange'];
const COUPON_PRESETS = [5000, 10000, 25000, 50000];
const ACCOUNT_TYPES = ['household', 'restaurant', 'school', 'farmer'];

function createApp(config, { dbPath } = {}) {
  const db = dbLib.open(dbPath || config.DATABASE_PATH);
  seed(db);
  seedDrinks(db);
  require('./seed-brands').seedBrands(db);
  seedHalal(db);

  const audit = auditService(db);
  const sms = require('./services/sms')({ db, config });
  const notify = notifyService(sms);
  const ctx0 = { db, config, audit, notify };
  const otp = require('./services/otp')({ db, config, sms });
  const auth = require('./services/auth')({ ...ctx0, otp, sms });
  const catalog = require('./services/catalog')(ctx0);
  const payments = require('./services/payments')(ctx0);
  const wallet = require('./services/wallet')({ ...ctx0, payments });
  const coupons = require('./services/coupons')({ ...ctx0, payments, wallet });
  const orders = require('./services/orders')({ ...ctx0, payments, wallet, coupons });
  const leads = leadsService(ctx0);
  const stats = statsService(db);
  const purgeOldData = retentionService(db);
  auth.ensureAdmin();

  const SID = config.isProd ? '__Host-ntn_sid' : 'ntn_sid';
  const CSRF = config.isProd ? '__Host-ntn_csrf' : 'ntn_csrf';
  const limits = {
    api: new sec.RateLimiter(300, 60_000),
    auth: new sec.RateLimiter(20, 15 * 60_000),
    otp: new sec.RateLimiter(10, 15 * 60_000),
    lookup: new sec.RateLimiter(20, 10 * 60_000),
    write: new sec.RateLimiter(30, 10 * 60_000)
  };
  const publicOrigin = new URL(config.PUBLIC_URL).origin;

  // ---------- helpers ----------
  const meta = (c) => ({ ip: c.ip, userAgent: c.req.headers['user-agent'], userId: c.user?.id });
  const requireUser = (c) => { if (!c.user) throw new HttpError(401, 'Please sign in', { code: 'auth_required' }); return c.user; };
  const pub = (u) => auth.publicUser(u);

  function setSessionCookie(c, token) {
    appendHeader(c.res, 'Set-Cookie', serializeCookie(SID, token, { maxAge: config.SESSION_TTL_DAYS * 86400, secure: config.isProd, sameSite: 'Lax' }));
  }
  function clearSessionCookie(c) {
    appendHeader(c.res, 'Set-Cookie', serializeCookie(SID, '', { maxAge: 0, secure: config.isProd }));
  }
  function ensureCsrfCookie(c) {
    let token = c.cookies[CSRF];
    if (!token || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) {
      token = sec.randomToken(24);
      appendHeader(c.res, 'Set-Cookie', serializeCookie(CSRF, token, { httpOnly: false, secure: config.isProd, sameSite: 'Strict', maxAge: 30 * 86400 }));
      c.cookies[CSRF] = token;
    }
    return token;
  }
  function limit(c, limiter, suffix = '') {
    const r = limits[limiter].check(c.ip + suffix);
    if (!r.ok) throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', { code: 'rate_limited', headers: { 'Retry-After': String(r.retryAfter) } });
  }

  // ---------- schemas ----------
  const S = {
    otpRequest: { phone: v.phone() },
    otpVerify: { phone: v.phone(), code: v.str({ min: 6, max: 6, pattern: /^\d{6}$/ }) },
    otpComplete: {
      signupToken: v.str({ min: 10, max: 64 }), name: v.str({ min: 2, max: 80 }), email: v.email({ optional: true }),
      accountType: v.oneOf(ACCOUNT_TYPES, { optional: true }), acceptTerms: v.bool(), marketingOptIn: v.bool({ optional: true })
    },
    profile: { name: v.str({ min: 2, max: 80 }), email: v.email({ optional: true }), accountType: v.oneOf(ACCOUNT_TYPES), marketingOptIn: v.bool() },
    login: { email: v.email(), password: v.str({ max: 200, trim: false }) },
    password: { currentPassword: v.str({ max: 200, trim: false }), newPassword: v.password() },
    cartItem: v.object({ productId: v.int({ min: 1 }), qty: v.int({ min: 1, max: 999 }) }),
    quote: () => ({ items: v.array(S.cartItem, { min: 1, max: 100 }), paymentMethod: v.oneOf(['momo', 'card', 'ogya', 'cash']), couponCode: v.str({ max: 20, optional: true }) }),
    order: () => ({
      ...S.quote(),
      name: v.str({ min: 2, max: 80 }), phone: v.phone(), email: v.email({ optional: true }),
      region: v.oneOf(REGIONS), town: v.str({ min: 2, max: 80 }), address: v.str({ min: 3, max: 200 }),
      deliverySlot: v.oneOf(DELIVERY_SLOTS), notes: v.str({ max: 300, optional: true, multiline: true }),
      acceptTerms: v.bool(),
      confirmAge: v.bool({ optional: true })
    }),
    coupon: { amount: v.int({ min: 1000, max: 200000 }), recipientName: v.str({ min: 2, max: 80 }), recipientPhone: v.phone(), message: v.str({ max: 140, optional: true }), method: v.oneOf(['ogya', 'momo', 'card']) },
    leads: {
      business: { name: v.str({ min: 2, max: 120 }), businessType: v.oneOf(['Restaurant / Chop bar', 'Hotel', 'Caterer', 'Supermarket / Retailer', 'Office canteen']), phone: v.phone(), region: v.oneOf(REGIONS), needs: v.str({ max: 1000, optional: true, multiline: true }) },
      school: { name: v.str({ min: 2, max: 120 }), role: v.oneOf(['School caterer', 'School administrator', 'District assembly', 'NGO / Donor']), pupils: v.int({ min: 1, max: 100000 }), phone: v.phone(), region: v.oneOf(REGIONS) },
      farmer: { name: v.str({ min: 2, max: 120 }), phone: v.phone(), region: v.oneOf(REGIONS), farmSize: v.oneOf(['Under 2 acres', '2–10 acres', '10–50 acres', '50+ acres']), produce: v.str({ min: 2, max: 300 }) },
      newsletter: { email: v.email() },
      quote: { name: v.str({ min: 2, max: 80 }), phone: v.phone(), region: v.oneOf(REGIONS), productId: v.int({ min: 1 }), quantity: v.str({ min: 1, max: 120 }), notes: v.str({ max: 500, optional: true, multiline: true }) },
      contact: { name: v.str({ min: 2, max: 80 }), phone: v.phone(), message: v.str({ min: 5, max: 1000, multiline: true }) }
    }
  };

  // ---------- routes ----------
  const r = new Router();

  r.get('/healthz', (c) => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', time: new Date().toISOString() };
  });

  r.get('/api/config', () => ({
    paymentsMode: payments.mode,
    onlinePayments: payments.enabled(),
    deliveryFee: config.DELIVERY_FEE,
    freeDeliveryThreshold: config.FREE_DELIVERY_THRESHOLD,
    ogyaDiscountBps: config.OGYA_DISCOUNT_BPS,
    ogyPerGhs: config.OGY_PER_GHS,
    regions: REGIONS,
    deliverySlots: DELIVERY_SLOTS,
    couponPresets: COUPON_PRESETS,
    smsMode: config.SMS_MODE,
    demo: config.DEMO_MODE,
    termsVersion: config.TERMS_VERSION,
    otpTtlMinutes: config.OTP_TTL_MINUTES,
    company: { name: config.LEGAL.COMPANY_NAME, tradingName: config.LEGAL.TRADING_NAME, supportPhone: config.LEGAL.SUPPORT_PHONE, supportEmail: config.LEGAL.SUPPORT_EMAIL }
  }));

  r.get('/api/session', (c) => ({ user: pub(c.user), csrfToken: ensureCsrfCookie(c) }));

  // Customer sign-in: phone + one-time SMS code (Sailup)
  r.post('/api/auth/otp/request', async (c) => {
    limit(c, 'otp');
    const d = validate(S.otpRequest, c.body);
    return await auth.otpStart(d.phone, meta(c));
  });
  r.post('/api/auth/otp/verify', (c) => {
    limit(c, 'auth');
    const d = validate(S.otpVerify, c.body);
    const r2 = auth.otpVerify(d.phone, d.code, meta(c));
    if (r2.token) {
      if (c.token) auth.logout(c.token);
      setSessionCookie(c, r2.token);
      return { user: r2.user };
    }
    return { needsProfile: true, signupToken: r2.signupToken };
  });
  r.post('/api/auth/otp/complete', (c) => {
    limit(c, 'auth');
    const d = validate(S.otpComplete, c.body);
    const { user, token } = auth.completeSignup(d, meta(c));
    setSessionCookie(c, token);
    return { status: 201, body: { user } };
  });

  // Staff sign-in: email + password, then a one-time SMS code
  r.post('/api/auth/admin/login', async (c) => {
    limit(c, 'auth');
    const d = validate(S.login, c.body);
    const r2 = await auth.adminLogin(d, meta(c));
    if (r2.token) { setSessionCookie(c, r2.token); return { user: r2.user }; }
    return { otpRequired: true, challenge: r2.challenge, phoneHint: r2.phoneHint, devCode: r2.devCode };
  });
  r.post('/api/auth/admin/verify', (c) => {
    limit(c, 'auth');
    const d = validate({ challenge: v.str({ min: 10, max: 64 }), code: v.str({ min: 6, max: 6, pattern: /^\d{6}$/ }) }, c.body);
    const { user, token } = auth.adminVerify(d, meta(c));
    if (c.token) auth.logout(c.token);
    setSessionCookie(c, token);
    return { user };
  });

  r.post('/api/auth/logout', (c) => {
    auth.logout(c.token);
    clearSessionCookie(c);
    return { ok: true };
  });

  r.post('/api/auth/password', (c) => {
    const u = requireUser(c);
    limit(c, 'auth');
    const d = validate(S.password, c.body);
    const token = auth.changePassword(u.id, d.currentPassword, d.newPassword, meta(c));
    setSessionCookie(c, token);
    return { ok: true };
  });

  r.get('/api/me', (c) => ({ user: pub(requireUser(c)) }));
  r.patch('/api/me', (c) => {
    const u = requireUser(c);
    const d = validate(S.profile, c.body);
    return { user: auth.updateProfile(u.id, d, meta(c)) };
  });
  r.post('/api/me/accept-terms', (c) => ({ user: auth.acceptTerms(requireUser(c).id, meta(c)) }));
  r.get('/api/me/export', (c) => {
    const u = requireUser(c);
    limit(c, 'lookup', ':export');
    audit(u.id, 'user.data_export', '', c.ip);
    const body = JSON.stringify(auth.exportData(u.id), null, 2);
    c.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ntintan-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    });
    c.res.end(body);
  });
  r.post('/api/me/delete', (c) => {
    const u = requireUser(c);
    const d = validate({ confirm: v.oneOf(['DELETE']), confirmForfeit: v.bool({ optional: true }) }, c.body);
    auth.deleteAccount(u.id, { confirmForfeit: d.confirmForfeit === true }, meta(c));
    clearSessionCookie(c);
    return { ok: true };
  });

  // Catalog
  r.get('/api/categories', () => ({ categories: catalog.categories() }));
  r.get('/api/units', () => ({ units: catalog.units() }));
  r.get('/api/products', () => ({ products: catalog.products() }));
  r.get('/api/products/:id', (c) => ({ product: catalog.product(Number(c.params.id) || 0) }));
  r.get('/api/market-prices', () => ({ marketPrices: catalog.marketPrices(), priceHistory: catalog.priceHistory() }));
  r.get('/api/farmers', () => ({ farmers: catalog.farmers() }));
  r.get('/api/brands', () => ({ brands: catalog.brands() }));

  // Orders
  r.post('/api/orders/quote', (c) => {
    const d = validate(S.quote(), c.body);
    return { quote: orders.publicQuote(orders.price(d)) };
  });
  r.post('/api/orders', async (c) => {
    limit(c, 'write');
    const d = validate(S.order(), c.body);
    const result = await orders.create(d, c.user, meta(c));
    if (c.user && c.user.terms_version !== config.TERMS_VERSION) auth.acceptTerms(c.user.id, meta(c));
    return { status: 201, body: result };
  });
  r.get('/api/orders/mine', (c) => ({ orders: orders.mine(requireUser(c).id) }));
  r.post('/api/orders/track', (c) => {
    limit(c, 'lookup');
    const d = validate({ ref: v.str({ min: 6, max: 20 }), phone: v.phone() }, c.body);
    return { order: orders.track(d.ref, d.phone) };
  });

  // Coupons
  r.post('/api/coupons/check', (c) => {
    limit(c, 'lookup');
    const d = validate({ code: v.str({ min: 4, max: 20 }) }, c.body);
    return { coupon: coupons.check(d.code) };
  });
  r.post('/api/coupons', async (c) => {
    const u = requireUser(c);
    limit(c, 'write');
    const d = validate(S.coupon, c.body);
    return { status: 201, body: await coupons.purchase(u, d) };
  });
  r.get('/api/coupons/mine', (c) => ({ coupons: coupons.mine(requireUser(c).id) }));

  // Wallet
  r.get('/api/wallet', (c) => {
    const u = requireUser(c);
    return { balance: wallet.balance(u.id), history: wallet.history(u.id) };
  });
  r.post('/api/wallet/topup', async (c) => {
    const u = requireUser(c);
    limit(c, 'write');
    const d = validate({ amount: v.int({ min: 100, max: 500000 }), method: v.oneOf(['momo', 'card']) }, c.body);
    return { payment: await wallet.startTopup(u, d.amount, d.method) };
  });

  // Payments
  r.post('/api/payments/verify', async (c) => {
    limit(c, 'lookup', ':verify');
    const d = validate({ reference: v.str({ min: 8, max: 40, pattern: /^[A-Z0-9]+$/ }) }, c.body);
    const p = await payments.confirm(d.reference);
    const out = { payment: { reference: p.reference, purpose: p.purpose, status: p.status, amount: p.amount } };
    if (p.purpose === 'order') out.order = orders.get(p.targetId);
    return out;
  });
  r.post('/api/payments/webhook', async (c) => {
    await payments.handleWebhook(c.raw, c.req.headers['x-paystack-signature']);
    return { ok: true };
  }, { csrf: false, rawBody: true });
  r.get('/api/payments/simulate/:reference', (c) => ({ payment: payments.get(c.params.reference) }));
  r.post('/api/payments/simulate', (c) => {
    const d = validate({ reference: v.str({ max: 40 }), outcome: v.oneOf(['success', 'failed']) }, c.body);
    payments.simulate(d.reference, d.outcome);
    return { ok: true };
  });

  r.post('/api/sms/webhook', (c) => { sms.handleWebhook(c.raw, c.req.headers); return { ok: true }; }, { csrf: false, rawBody: true });

  // Leads
  r.post('/api/leads/:type', (c) => {
    const schema = S.leads[c.params.type];
    if (!schema) throw new HttpError(404, 'Not found');
    limit(c, 'write', ':lead');
    const d = validate(schema, c.body);
    if (c.params.type === 'quote') catalog.product(d.productId);
    return { status: 201, body: leads.create(c.params.type, d, meta(c)) };
  });

  // ---------- admin ----------
  const A = { admin: true };
  r.get('/api/admin/stats', () => ({ stats: stats() }), A);
  r.get('/api/admin/orders', (c) => ({
    orders: orders.list({ status: Object.keys(orders.TRANSITIONS).includes(c.query.get('status')) ? c.query.get('status') : null, q: (c.query.get('q') || '').slice(0, 40) || null })
  }), A);
  r.patch('/api/admin/orders/:ref', (c) => {
    const d = validate({ status: v.oneOf(Object.keys(orders.TRANSITIONS)) }, c.body);
    return { order: orders.setStatus(c.params.ref, d.status, c.user.id) };
  }, A);
  r.post('/api/admin/orders/:ref/refund', async (c) => {
    const o = orders.list({ q: c.params.ref, limit: 1 })[0];
    if (!o || o.ref !== c.params.ref) throw new HttpError(404, 'Order not found');
    if (o.status !== 'cancelled') throw new HttpError(409, 'Only cancelled orders can be refunded');
    const r2 = await orders.refundOrder(o.id, 'admin_retry');
    if (!r2) throw new HttpError(409, 'This order has no online payment to refund');
    audit(c.user.id, 'order.refund_retry', `${o.ref} ${r2.status}`, c.ip);
    return { refund: r2 };
  }, A);
  r.get('/api/admin/sms', () => ({ messages: sms.list() }), A);
  r.get('/api/admin/products', () => ({ products: catalog.products({ includeInactive: true }), units: catalog.units(), categories: catalog.categories() }), A);
  r.patch('/api/admin/products/:id', (c) => {
    const d = validate({
      price: (x) => (x === null ? null : x === undefined ? undefined : v.int({ min: 1, max: 100_000_000 })(x)),
      priceUnitLabel: (x) => (x === undefined ? undefined : v.str({ max: 60, optional: true })(x)),
      stock: (x) => (x === null ? null : x === undefined ? undefined : v.int({ min: 0, max: 1_000_000 })(x)),
      active: v.bool({ optional: true }),
      featured: v.bool({ optional: true }),
      ageRestricted: v.bool({ optional: true }),
      halal: v.bool({ optional: true }),
      notes: (x) => (x === undefined ? undefined : v.str({ max: 300, optional: true })(x) || '')
    }, c.body);
    for (const k of Object.keys(d)) if (d[k] === undefined || (d[k] === null && (k === 'active' || k === 'featured' || k === 'ageRestricted' || k === 'halal'))) delete d[k];
    if (d.ageRestricted !== undefined) d.verifyAbv = false; // an admin has checked the label
    const id = Number(c.params.id) || 0;
    const current = catalog.product(id, { includeInactive: true });
    if (d.halal ?? current.halal) {
      if (d.ageRestricted ?? current.ageRestricted) throw new HttpError(400, 'Alcoholic products cannot be marked halal', { fields: { halal: 'not allowed for alcohol' } });
      if (/\b(pork|pig|bacon|ham|lard)\b/i.test(`${current.name} ${d.notes ?? current.notes ?? ''}`)) throw new HttpError(400, 'Products containing pork cannot be marked halal', { fields: { halal: 'not allowed for pork' } });
    }
    const product = catalog.updateProduct(id, d);
    audit(c.user.id, 'product.update', `${product.id} ${JSON.stringify(d)}`, c.ip);
    return { product };
  }, A);
  r.get('/api/admin/coupons', () => ({ coupons: coupons.list() }), A);
  r.post('/api/admin/coupons', (c) => {
    const d = validate({ amount: v.int({ min: 100, max: 1_000_000 }), recipientName: v.str({ min: 2, max: 80 }), recipientPhone: v.phone(), message: v.str({ max: 140, optional: true }) }, c.body);
    return { status: 201, body: { coupon: coupons.issue(c.user.id, d) } };
  }, A);
  r.post('/api/admin/coupons/:code/void', (c) => { coupons.voidCoupon(c.user.id, c.params.code); return { ok: true }; }, A);
  const farmerSchema = {
    name: v.str({ min: 2, max: 120 }), enterprise: v.str({ max: 120, optional: true }), location: v.str({ max: 200, optional: true }),
    region: v.oneOf(REGIONS, { optional: true }), focusCategoryIds: v.array(v.int({ min: 1, max: 9 }), { max: 9 }),
    notes: v.str({ max: 500, optional: true }), verified: v.bool()
  };
  r.get('/api/admin/farmers', () => ({ farmers: catalog.farmers({ includePersonal: true }) }), A);
  r.post('/api/admin/farmers', (c) => {
    const id = catalog.upsertFarmer(null, validate(farmerSchema, c.body));
    audit(c.user.id, 'farmer.create', String(id), c.ip);
    return { status: 201, body: { id } };
  }, A);
  r.patch('/api/admin/farmers/:id', (c) => {
    catalog.upsertFarmer(Number(c.params.id) || 0, validate(farmerSchema, c.body));
    audit(c.user.id, 'farmer.update', c.params.id, c.ip);
    return { ok: true };
  }, A);
  r.delete('/api/admin/farmers/:id', (c) => {
    catalog.deleteFarmer(Number(c.params.id) || 0);
    audit(c.user.id, 'farmer.delete', c.params.id, c.ip);
    return { ok: true };
  }, A);
  r.get('/api/admin/leads', (c) => ({ leads: leads.list({ type: c.query.get('type') || null }) }), A);
  r.patch('/api/admin/leads/:id', (c) => {
    const d = validate({ status: v.oneOf(['new', 'contacted', 'closed']) }, c.body);
    leads.setStatus(Number(c.params.id) || 0, d.status);
    return { ok: true };
  }, A);
  r.get('/api/admin/users', () => ({
    users: db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all().map(pub)
  }), A);
  r.post('/api/admin/users/:id/credit', (c) => {
    const d = validate({ amount: v.int({ min: 1, max: 10_000_000 }), note: v.str({ min: 3, max: 120 }) }, c.body);
    const id = Number(c.params.id) || 0;
    if (!auth.getUserRow(id)) throw new HttpError(404, 'User not found');
    const balance = wallet.credit(id, d.amount, 'admin_credit', d.note);
    audit(c.user.id, 'wallet.admin_credit', `user ${id} +${d.amount} OGY: ${d.note}`, c.ip);
    return { balance };
  }, A);
  r.get('/api/admin/audit', () => ({
    entries: db.prepare('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all()
      .map((e) => ({ id: e.id, user: e.email, action: e.action, detail: e.detail, ip: e.ip, createdAt: e.created_at }))
  }), A);

  // ---------- static files ----------
  const fileCache = new Map();
  const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/payment/callback': 'index.html', '/pay/simulate': 'simulate.html', '/terms': 'terms.html', '/privacy': 'privacy.html' };
  const escHtml = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const TOKENS = {
    ...Object.fromEntries(Object.entries(config.LEGAL).map(([k, val]) => [k, val])),
    TERMS_VERSION: config.TERMS_VERSION,
    PUBLIC_URL: config.PUBLIC_URL,
    DELIVERY_FEE: (config.DELIVERY_FEE / 100).toFixed(2),
    FREE_DELIVERY: (config.FREE_DELIVERY_THRESHOLD / 100).toFixed(2),
    OGYA_DISCOUNT: String(config.OGYA_DISCOUNT_BPS / 100),
    UNPAID_TTL: String(config.UNPAID_ORDER_TTL_MINUTES),
    OTP_TTL: String(config.OTP_TTL_MINUTES)
  };
  const fillTokens = (html) => html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in TOKENS ? escHtml(TOKENS[k]) : m));

  function loadStatic(rel) {
    const abs = path.resolve(PUBLIC_DIR, '.' + path.sep + rel);
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) return null;
    if (path.basename(abs).startsWith('.')) return null;
    if (config.isProd && fileCache.has(abs)) return fileCache.get(abs);
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    let buf = fs.readFileSync(abs);
    if (type.startsWith('text/html')) buf = Buffer.from(fillTokens(buf.toString('utf8')));
    const compressible = /text|javascript|json|svg|xml|manifest/.test(type) && buf.length > 512;
    const entry = { buf, gz: compressible ? zlib.gzipSync(buf, { level: 9 }) : null, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"', html: type.startsWith('text/html') };
    if (config.isProd) fileCache.set(abs, entry);
    return entry;
  }

  function serveStatic(c, pathname) {
    let rel = PAGES[pathname];
    if (rel === 'simulate.html' && payments.mode !== 'simulate') rel = null;
    if (!rel && pathname !== '/' && !PAGES[pathname]) rel = pathname.replace(/^\/+/, '');
    if (rel && /(^|\/)simulate\.html$/.test(rel) && payments.mode !== 'simulate') rel = null;
    let file = rel ? loadStatic(decodeURIComponent(rel)) : null;
    let status = 200;
    if (!file) { file = loadStatic('404.html'); status = 404; }
    const res = c.res;
    sec.securityHeaders(res, { isProd: config.isProd, html: file.html });
    if (file.html) ensureCsrfCookie(c);
    res.setHeader('Content-Type', file.type);
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', file.html ? 'no-cache' : 'public, max-age=3600');
    res.setHeader('Vary', 'Accept-Encoding');
    if (status === 200 && c.req.headers['if-none-match'] === file.etag) { res.writeHead(304); return res.end(); }
    const gzip = file.gz && /\bgzip\b/.test(c.req.headers['accept-encoding'] || '');
    const body = gzip ? file.gz : file.buf;
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.writeHead(status);
    res.end(c.req.method === 'HEAD' ? undefined : body);
  }

  // ---------- request handler ----------
  function clientIp(req) {
    if (config.TRUST_PROXY) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://local');
    const c = { req, res, url, query: url.searchParams, ip: clientIp(req), cookies: parseCookies(req.headers.cookie), params: {}, body: null };
    if (config.DEMO_MODE) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.on('finish', () => {
      if (config.NODE_ENV === 'test') return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: url.pathname, s: res.statusCode, ms: Math.round(ms), ip: c.ip }));
    });

    try {
      const pathname = url.pathname;
      const isApi = pathname.startsWith('/api/') || pathname === '/healthz';
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(c, pathname);
      }

      sec.securityHeaders(res, { isProd: config.isProd });
      limit(c, 'api');
      const m = r.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const { route, params } = m;
      c.params = params;

      c.token = c.cookies[SID] || null;
      c.user = c.token ? auth.userFromToken(c.token) : null;

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating) {
        if (route.opts.csrf !== false) {
          const origin = req.headers.origin;
          if (origin && origin !== publicOrigin) throw new HttpError(403, 'Cross-origin request blocked', { code: 'bad_origin' });
          const header = req.headers['x-csrf-token'];
          const cookie = c.cookies[CSRF];
          if (!header || !cookie || !sec.safeEqual(header, cookie)) throw new HttpError(403, 'Your session expired. Please refresh the page.', { code: 'csrf' });
        }
        const raw = await readBody(req, config.MAX_BODY_BYTES);
        c.raw = raw;
        if (!route.opts.rawBody) {
          if (raw.length && !/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected application/json');
          try { c.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Malformed JSON'); }
        }
      }

      if (route.opts.admin && (!c.user || c.user.role !== 'admin')) throw new HttpError(c.user ? 403 : 401, c.user ? 'Admins only' : 'Please sign in', { code: c.user ? 'forbidden' : 'auth_required' });

      const out = await route.handler(c);
      if (res.headersSent) return;
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) return sendJson(res, out.status, out.body);
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        if (!c.url.pathname.startsWith('/api/') && err.status === 405) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
        return sendJson(res, err.status, { error: { message: err.message, code: err.code, fields: err.fields } }, err.headers || {});
      }
      const id = sec.randomToken(6);
      console.error(JSON.stringify({ level: 'error', id, path: c.url.pathname, message: err.message, stack: err.stack }));
      return sendJson(res, 500, { error: { message: `Something went wrong on our side (ref ${id}). Please try again.`, code: 'server_error' } });
    }
  }

  // ---------- background jobs ----------
  const jobs = [
    setInterval(() => { try { orders.expireUnpaid(); } catch (e) { console.error('[job] expireUnpaid', e.message); } }, 60_000),
    setInterval(() => { try { purgeOldData(); } catch (e) { console.error('[job] retention', e.message); } }, 6 * 3600_000)
  ];
  jobs.forEach((j) => j.unref());
  try { purgeOldData(); } catch (e) { console.error('[job] retention', e.message); }

  function close() {
    jobs.forEach(clearInterval);
    Object.values(limits).forEach((l) => clearInterval(l.timer));
    db.close();
  }

  return { handle, close, db, services: { auth, catalog, payments, wallet, coupons, orders, leads, sms, otp }, limits };
}

module.exports = { createApp };
