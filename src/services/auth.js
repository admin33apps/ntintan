'use strict';
/**
 * Accounts & sessions.
 *  - Customers sign in with their phone number + a one-time SMS code (Sailup). No passwords.
 *  - Admins sign in with email + password, then a one-time SMS code to their phone (2-step).
 */
const { tx } = require('../db');
const { HttpError } = require('../lib/http');
const sec = require('../lib/security');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const OPEN_ORDER_STATUSES = ['pending_payment', 'confirmed', 'processing', 'out_for_delivery'];

module.exports = function authService({ db, config, audit, otp, sms }) {
  const publicUser = (u) => u && ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, accountType: u.account_type,
    ogyBalance: u.ogy_balance, marketingOptIn: Boolean(u.marketing_opt_in), termsVersion: u.terms_version,
    needsTerms: u.terms_version !== config.TERMS_VERSION, createdAt: u.created_at
  });

  const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
  const getUser = (id) => publicUser(getUserRow(id));
  const byPhone = (phone) => db.prepare('SELECT * FROM users WHERE phone = ? AND deleted_at IS NULL').get(phone);

  // ---------------- sessions ----------------
  function createSession(userId, meta) {
    const token = sec.randomToken(32);
    db.prepare(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, datetime('now', '+${config.SESSION_TTL_DAYS} days'), ?, ?)`)
      .run(sec.sha256(token), userId, meta.ip || null, String(meta.userAgent || '').slice(0, 200));
    return token;
  }
  function userFromToken(token) {
    if (!token || token.length > 100) return null;
    return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.deleted_at IS NULL`).get(sec.sha256(token)) || null;
  }
  function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sec.sha256(token)); }
  function purgeExpiredSessions() { db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(); }

  // ---------------- customer OTP ----------------
  async function otpStart(phone, meta) {
    const u = byPhone(phone);
    if (u && u.role === 'admin') throw new HttpError(403, 'Staff accounts sign in at /admin.', { code: 'use_admin_login' });
    const r = await otp.request(phone, 'login', meta.ip);
    audit(u?.id || null, 'auth.otp_requested', sms.mask(phone), meta.ip);
    return r;
  }

  function otpVerify(phone, code, meta) {
    const otpId = otp.verify(phone, 'login', code);
    const u = byPhone(phone);
    if (u && u.role === 'admin') throw new HttpError(403, 'Staff accounts sign in at /admin.', { code: 'use_admin_login' });
    if (u) {
      audit(u.id, 'auth.login', 'otp', meta.ip);
      return { user: publicUser(u), token: createSession(u.id, meta) };
    }
    return { needsProfile: true, signupToken: otp.issueSignupToken(otpId) };
  }

  function completeSignup({ signupToken, name, email, accountType, acceptTerms, marketingOptIn }, meta) {
    if (acceptTerms !== true) throw new HttpError(422, 'Please accept the Terms of Sale and Privacy Notice to create an account', { fields: { acceptTerms: 'must be accepted' } });
    const phone = otp.redeemSignupToken(signupToken);
    return tx(db, () => {
      if (byPhone(phone)) throw new HttpError(409, 'An account already exists for this number. Please sign in.', { code: 'phone_taken' });
      if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'This email is already used by another account', { fields: { email: 'is already in use' } });
      const r = db.prepare(`INSERT INTO users (phone, email, name, account_type, terms_version, terms_accepted_at, marketing_opt_in)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`).run(phone, email || null, name, accountType || 'household', config.TERMS_VERSION, marketingOptIn ? 1 : 0);
      const id = Number(r.lastInsertRowid);
      audit(id, 'user.register', sms.mask(phone), meta.ip);
      return { user: getUser(id), token: createSession(id, meta) };
    });
  }

  // ---------------- admin: password + SMS code ----------------
  async function adminLogin({ email, password }, meta) {
    const u = db.prepare("SELECT *, (locked_until IS NOT NULL AND locked_until > datetime('now')) AS is_locked FROM users WHERE email = ? AND deleted_at IS NULL").get(email);
    if (!u || !u.password_hash) { sec.dummyVerify(); throw new HttpError(401, 'Incorrect email or password', { code: 'bad_credentials' }); }
    if (u.is_locked) throw new HttpError(429, `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`, { code: 'locked' });
    if (!sec.verifyPassword(password, u.password_hash)) {
      const failed = u.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? `datetime('now', '+${LOCK_MINUTES} minutes')` : 'NULL';
      db.prepare(`UPDATE users SET failed_logins = ?, locked_until = ${lock} WHERE id = ?`).run(failed >= MAX_FAILED ? 0 : failed, u.id);
      audit(u.id, 'admin.login_failed', '', meta.ip);
      throw new HttpError(401, 'Incorrect email or password', { code: 'bad_credentials' });
    }
    if (u.role !== 'admin') throw new HttpError(403, 'This account does not have admin access', { code: 'forbidden' });
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
    if (!u.phone) {
      if (config.isProd) throw new HttpError(403, 'Admin accounts need a phone number for 2-step verification. Run `npm run create-admin` with a phone.', { code: 'admin_phone_required' });
      audit(u.id, 'admin.login', 'password only (dev, no phone)', meta.ip);
      return { user: publicUser(u), token: createSession(u.id, meta) };
    }
    const r = await otp.request(u.phone, 'admin', meta.ip);
    const row = db.prepare("SELECT id FROM otp_codes WHERE phone = ? AND purpose = 'admin' ORDER BY id DESC LIMIT 1").get(u.phone);
    return { otpRequired: true, challenge: otp.issueSignupToken(row.id), phoneHint: sms.mask(u.phone), devCode: r.devCode };
  }

  function adminVerify({ challenge, code }, meta) {
    const phone = otp.redeemSignupToken(challenge);
    otp.verify(phone, 'admin', code);
    const u = byPhone(phone);
    if (!u || u.role !== 'admin') throw new HttpError(403, 'Admins only', { code: 'forbidden' });
    audit(u.id, 'admin.login', '2-step', meta.ip);
    return { user: publicUser(u), token: createSession(u.id, meta) };
  }

  function changePassword(userId, current, next, meta) {
    const u = getUserRow(userId);
    if (!u?.password_hash || !sec.verifyPassword(current, u.password_hash)) throw new HttpError(400, 'Current password is incorrect', { fields: { currentPassword: 'is incorrect' } });
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(sec.hashPassword(next), userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
    audit(userId, 'user.password_changed', '', meta.ip);
    return createSession(userId, meta);
  }

  /** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_PHONE if none exists. */
  function ensureAdmin() {
    if (db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1").get()) return false;
    if (!config.ADMIN_EMAIL || config.ADMIN_PASSWORD.length < 12) {
      if (config.NODE_ENV !== 'test') console.warn('[setup] No admin account. Set ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars) and ADMIN_PHONE, or run `npm run create-admin`.');
      return false;
    }
    createAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD, 'Administrator', config.ADMIN_PHONE || null);
    return true;
  }

  function createAdmin(email, password, name, phone) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (phone) {
      const clash = db.prepare('SELECT id FROM users WHERE phone = ? AND (? IS NULL OR id != ?)').get(phone, existing?.id ?? null, existing?.id ?? null);
      if (clash) throw new Error(`Phone ${phone} already belongs to another account`);
    }
    if (existing) {
      db.prepare("UPDATE users SET role = 'admin', password_hash = ?, phone = COALESCE(?, phone), deleted_at = NULL WHERE id = ?").run(sec.hashPassword(password), phone, existing.id);
      return existing.id;
    }
    return Number(db.prepare("INSERT INTO users (name, email, phone, role, account_type, password_hash, terms_version) VALUES (?, ?, ?, 'admin', 'staff', ?, ?)")
      .run(name, email, phone, sec.hashPassword(password), config.TERMS_VERSION).lastInsertRowid);
  }

  // ---------------- profile & privacy rights ----------------
  function updateProfile(userId, patch, meta) {
    const u = getUserRow(userId);
    if (!u) throw new HttpError(404, 'Account not found');
    if (patch.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(patch.email, userId)) {
      throw new HttpError(409, 'This email is already used by another account', { fields: { email: 'is already in use' } });
    }
    db.prepare('UPDATE users SET name = ?, email = ?, account_type = ?, marketing_opt_in = ? WHERE id = ?').run(
      patch.name ?? u.name,
      patch.email === undefined ? u.email : patch.email,
      patch.accountType ?? u.account_type,
      patch.marketingOptIn === undefined ? u.marketing_opt_in : patch.marketingOptIn ? 1 : 0,
      userId
    );
    audit(userId, 'user.profile_updated', '', meta.ip);
    return getUser(userId);
  }

  function acceptTerms(userId, meta) {
    db.prepare("UPDATE users SET terms_version = ?, terms_accepted_at = datetime('now') WHERE id = ?").run(config.TERMS_VERSION, userId);
    audit(userId, 'user.terms_accepted', config.TERMS_VERSION, meta.ip);
    return getUser(userId);
  }

  /** Right of access (Act 843): everything we hold about the customer, as JSON. */
  function exportData(userId) {
    const u = getUserRow(userId);
    const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id').all(userId).map((o) => ({
      ...o, items: db.prepare('SELECT name, unit_label, unit_price, qty, line_total FROM order_items WHERE order_id = ?').all(o.id)
    }));
    return {
      generatedAt: new Date().toISOString(),
      notice: 'Amounts are in pesewas (100 pesewas = GHS 1 = 100 OGY).',
      account: { name: u.name, phone: u.phone, email: u.email, accountType: u.account_type, createdAt: u.created_at, termsVersion: u.terms_version, termsAcceptedAt: u.terms_accepted_at, marketingOptIn: Boolean(u.marketing_opt_in), ogyBalance: u.ogy_balance },
      orders,
      walletTransactions: db.prepare('SELECT type, amount_ogy, balance_after, reference, created_at FROM wallet_tx WHERE user_id = ? ORDER BY id').all(userId),
      couponsPurchased: db.prepare('SELECT code, initial_pesewas, balance_pesewas, status, recipient_name, recipient_phone, message, created_at FROM coupons WHERE purchaser_user_id = ?').all(userId),
      enquiries: u.phone ? db.prepare('SELECT type, name, phone, email, region, payload, created_at FROM leads WHERE phone = ?').all(u.phone) : [],
      activeSessions: db.prepare("SELECT created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > datetime('now')").all(userId)
    };
  }

  /** Right to erasure: anonymise the account; keep order/payment records (legal retention) without identity. */
  function deleteAccount(userId, { confirmForfeit }, meta) {
    const u = getUserRow(userId);
    if (!u) throw new HttpError(404, 'Account not found');
    if (u.role === 'admin') throw new HttpError(403, 'Admin accounts must be removed by another administrator.');
    const open = db.prepare(`SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status IN (${OPEN_ORDER_STATUSES.map(() => '?').join(',')})`).get(userId, ...OPEN_ORDER_STATUSES).n;
    if (open) throw new HttpError(409, 'You have orders still in progress. You can delete your account once they are delivered or cancelled.', { code: 'open_orders' });
    if (u.ogy_balance > 0 && confirmForfeit !== true) {
      throw new HttpError(409, `You still have ${u.ogy_balance.toLocaleString('en-GH')} OGY in your wallet. Spend it first, or confirm that you give it up.`, { code: 'wallet_not_empty' });
    }
    tx(db, () => {
      if (u.ogy_balance > 0) {
        db.prepare('INSERT INTO wallet_tx (user_id, type, amount_ogy, balance_after, reference) VALUES (?, ?, ?, 0, ?)').run(userId, 'forfeited_on_deletion', -u.ogy_balance, 'account deletion');
      }
      db.prepare("UPDATE users SET name = 'Deleted customer', phone = NULL, email = NULL, password_hash = NULL, ogy_balance = 0, marketing_opt_in = 0, deleted_at = datetime('now') WHERE id = ?").run(userId);
      db.prepare("UPDATE orders SET customer_name = 'Deleted customer', phone = '', email = NULL, address = '[removed]', notes = '' WHERE user_id = ?").run(userId);
      if (u.phone) db.prepare('DELETE FROM leads WHERE phone = ?').run(u.phone);
      if (u.email) db.prepare('DELETE FROM leads WHERE email = ?').run(u.email);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
    audit(userId, 'user.deleted', '', meta.ip);
  }

  return {
    publicUser, getUser, getUserRow, createSession, userFromToken, logout, purgeExpiredSessions,
    otpStart, otpVerify, completeSignup, adminLogin, adminVerify, changePassword, ensureAdmin, createAdmin,
    updateProfile, acceptTerms, exportData, deleteAccount
  };
};
