'use strict';
/**
 * One-time passcodes sent by SMS (Sailup). Sailup only delivers the message —
 * codes are generated, hashed and checked here.
 *  - 6 random digits (crypto.randomInt), stored as HMAC-SHA256(APP_SECRET, phone|purpose|code)
 *  - expires after OTP_TTL_MINUTES, max OTP_MAX_ATTEMPTS guesses, single use
 *  - resend cooldown and hourly cap per phone; per-IP limits are applied in routes
 */
const crypto = require('node:crypto');
const { tx } = require('../db');
const { HttpError } = require('../lib/http');

module.exports = function otpService({ db, config, sms }) {
  const digest = (phone, purpose, code) => crypto.createHmac('sha256', config.APP_SECRET).update(`${phone}|${purpose}|${code}`).digest('hex');
  const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

  async function request(phone, purpose, ip) {
    const last = db.prepare("SELECT (strftime('%s','now') - strftime('%s', created_at)) AS age FROM otp_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(phone, purpose);
    if (last && last.age < config.OTP_RESEND_SECONDS) {
      const wait = config.OTP_RESEND_SECONDS - last.age;
      throw new HttpError(429, `Please wait ${wait} seconds before requesting another code.`, { code: 'otp_cooldown', headers: { 'Retry-After': String(wait) } });
    }
    const hourly = db.prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > datetime('now', '-1 hour')").get(phone).n;
    if (hourly >= config.OTP_MAX_PER_HOUR) throw new HttpError(429, 'Too many codes requested for this number. Please try again in an hour.', { code: 'otp_hourly_limit' });

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const id = tx(db, () => {
      db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE phone = ? AND purpose = ? AND consumed_at IS NULL").run(phone, purpose);
      return Number(db.prepare(`INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, ip) VALUES (?, ?, ?, datetime('now', '+${config.OTP_TTL_MINUTES} minutes'), ?)`)
        .run(phone, purpose, digest(phone, purpose, code), ip || null).lastInsertRowid);
    });
    const label = purpose === 'admin' ? 'admin sign-in' : 'sign-in';
    await sms.send(phone, `${code} is your Ntintan ${label} code. It expires in ${config.OTP_TTL_MINUTES} minutes. Never share it - Ntintan staff will never ask for it.`, {
      purpose: `otp_${purpose}`,
      redacted: `****** is your Ntintan ${label} code. (code redacted)`,
      strict: true
    }).catch((e) => { db.prepare('DELETE FROM otp_codes WHERE id = ?').run(id); throw e; });
    return { expiresInSeconds: config.OTP_TTL_MINUTES * 60, resendInSeconds: config.OTP_RESEND_SECONDS, devCode: config.SMS_MODE === 'log' && (!config.isProd || config.DEMO_MODE) ? code : undefined };
  }

  /**
   * Verify a code. Returns the otp row id on success; throws otherwise.
   * Attempt counting is committed BEFORE the error is thrown, so failed guesses always count.
   */
  function verify(phone, purpose, code) {
    const outcome = tx(db, () => {
      const row = db.prepare(`SELECT *, (expires_at <= datetime('now')) AS expired FROM otp_codes
        WHERE phone = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`).get(phone, purpose);
      if (!row) return { error: 'missing' };
      if (row.expired) return { error: 'expired' };
      if (row.attempts >= config.OTP_MAX_ATTEMPTS) {
        db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
        return { error: 'locked' };
      }
      const ok = crypto.timingSafeEqual(Buffer.from(digest(phone, purpose, String(code))), Buffer.from(row.code_hash));
      if (!ok) {
        const attempts = row.attempts + 1;
        db.prepare('UPDATE otp_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
        if (attempts >= config.OTP_MAX_ATTEMPTS) {
          db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
          return { error: 'locked' };
        }
        return { error: 'invalid', left: config.OTP_MAX_ATTEMPTS - attempts };
      }
      db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
      return { id: row.id };
    });
    if (outcome.id) return outcome.id;
    if (outcome.error === 'missing') throw new HttpError(400, 'Request a new code to continue.', { code: 'otp_missing', fields: { code: 'has expired — request a new one' } });
    if (outcome.error === 'expired') throw new HttpError(400, 'This code has expired. Request a new one.', { code: 'otp_expired', fields: { code: 'has expired' } });
    if (outcome.error === 'locked') throw new HttpError(429, 'Too many wrong attempts. Request a new code.', { code: 'otp_locked' });
    throw new HttpError(400, `That code is not correct. ${outcome.left} attempt(s) left.`, { code: 'otp_invalid', fields: { code: 'is not correct' } });
  }

  /** Short-lived token proving phone ownership, used to finish sign-up for new customers. */
  function issueSignupToken(otpId) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE otp_codes SET signup_token_hash = ? WHERE id = ?').run(tokenHash(token), otpId);
    return token;
  }

  function redeemSignupToken(token) {
    if (typeof token !== 'string' || token.length > 64) throw new HttpError(400, 'Your sign-up session expired. Please start again.', { code: 'signup_expired' });
    const row = db.prepare("SELECT * FROM otp_codes WHERE signup_token_hash = ? AND created_at > datetime('now', '-20 minutes')").get(tokenHash(token));
    if (!row) throw new HttpError(400, 'Your sign-up session expired. Please start again.', { code: 'signup_expired' });
    db.prepare('UPDATE otp_codes SET signup_token_hash = NULL WHERE id = ?').run(row.id);
    return row.phone;
  }

  function purge() {
    db.prepare("DELETE FROM otp_codes WHERE created_at < datetime('now', '-1 day')").run();
  }

  return { request, verify, issueSignupToken, redeemSignupToken, purge };
};
