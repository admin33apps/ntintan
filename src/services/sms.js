'use strict';
/**
 * SMS via Sailup (https://www.sailup.io/docs).
 *   POST {SAILUP_BASE}/sms/   Authorization: Bearer sailup_…
 *   body: { from: <registered sender ID>, to: [<numbers>], body: <text> }  → 202 { id, delivery_status, … }
 * Delivery webhooks: X-Sailup-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>,
 *                    X-Sailup-Timestamp: <timestamp>
 * In SMS_MODE=log (development/tests only) messages are written to the log instead of sent.
 */
const crypto = require('node:crypto');
const { HttpError } = require('../lib/http');

const toE164 = (phone) => (/^0\d{9}$/.test(phone) ? '+233' + phone.slice(1) : phone);
const mask = (phone) => String(phone).replace(/\d(?=\d{3})/g, '•');
// GSM-7 keeps each SMS to 160 chars (₵ or emoji would force 70-char Unicode segments).
const gsmSafe = (text) => String(text).replace(/₵/g, 'GHS ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...');

module.exports = function smsService({ db, config }) {
  const outbox = []; // last messages in log mode (tests/dev inspection)

  function record(recipient, purpose, body, status, providerId = null, error = null) {
    const r = db.prepare('INSERT INTO sms_log (recipient, purpose, body, status, provider_id, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(recipient, purpose, body, status, providerId, error ? String(error).slice(0, 300) : null);
    return Number(r.lastInsertRowid);
  }

  /**
   * Send one SMS. `redacted` is what gets stored in the log (OTP codes are never stored).
   * Returns { ok, providerId }. Never throws for provider failures unless `strict`.
   */
  async function send(phone, text, { purpose = 'notification', redacted, strict = false } = {}) {
    const body = gsmSafe(text).slice(0, 459); // max 3 segments
    const stored = redacted ? gsmSafe(redacted) : body;
    if (config.SMS_MODE === 'log') {
      outbox.push({ to: phone, body, purpose, at: Date.now() });
      if (outbox.length > 50) outbox.shift();
      record(phone, purpose, stored, 'logged');
      if (config.NODE_ENV !== 'test') console.log(JSON.stringify({ level: 'info', type: 'sms_log_mode', to: mask(phone), purpose, body: stored }));
      return { ok: true, providerId: null };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${config.SAILUP_BASE}/sms/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.SAILUP_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ from: config.SAILUP_SENDER_ID, to: [toE164(phone)], body }),
        signal: ctrl.signal
      });
      const json = await res.json().catch(() => ({}));
      if (res.status !== 202 && res.status !== 200 && res.status !== 201) {
        const err = json?.detail || json?.message || `HTTP ${res.status}`;
        record(phone, purpose, stored, 'failed', null, err);
        console.error(JSON.stringify({ level: 'error', type: 'sms_failed', to: mask(phone), purpose, status: res.status, error: err }));
        if (strict) throw new HttpError(502, 'We could not send the SMS right now. Please try again in a minute.', { code: 'sms_failed' });
        return { ok: false };
      }
      const providerId = json.id || (Array.isArray(json) ? json[0]?.id : null) || null;
      record(phone, purpose, stored, json.status === 'failed' ? 'failed' : 'sent', providerId, json.status === 'failed' ? 'not dispatched (check Sailup balance)' : null);
      if (json.status === 'failed' || json.status === 'pending_balance') {
        console.error(JSON.stringify({ level: 'error', type: 'sms_not_dispatched', status: json.status, purpose }));
        if (strict) throw new HttpError(502, 'We could not send the SMS right now. Please try again shortly.', { code: 'sms_failed' });
      }
      return { ok: true, providerId };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      record(phone, purpose, stored, 'failed', null, e.name === 'AbortError' ? 'timeout' : e.message);
      console.error(JSON.stringify({ level: 'error', type: 'sms_error', to: mask(phone), purpose, error: e.message }));
      if (strict) throw new HttpError(502, 'We could not send the SMS right now. Please try again in a minute.', { code: 'sms_failed' });
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fire-and-forget for notifications (order updates, coupons). */
  function notify(phone, text, purpose = 'notification') {
    if (!phone) return;
    send(phone, text, { purpose }).catch(() => {});
  }

  /** Sailup delivery-status webhook. */
  function handleWebhook(rawBody, headers) {
    if (!config.SAILUP_WEBHOOK_SECRET) throw new HttpError(404, 'Not found');
    const sig = String(headers['x-sailup-signature'] || '').replace(/^sha256=/, '');
    const ts = String(headers['x-sailup-timestamp'] || '');
    if (!sig || !ts) throw new HttpError(401, 'Missing signature');
    const tsNum = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts) || Date.parse(ts) / 1000;
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) throw new HttpError(401, 'Stale webhook');
    const expected = crypto.createHmac('sha256', config.SAILUP_WEBHOOK_SECRET).update(ts + '.' + rawBody.toString('utf8')).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Invalid signature');
    let evt;
    try { evt = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    const map = { 'message.delivered': 'delivered', 'message.failed': 'failed', 'message.expired': 'expired', 'message.rejected': 'rejected' };
    const status = map[evt?.event];
    const id = evt?.data?.message_id;
    if (status && typeof id === 'string') {
      db.prepare("UPDATE sms_log SET status = ?, updated_at = datetime('now') WHERE provider_id = ?").run(status, id);
    }
  }

  function list(limit = 200) {
    return db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT ?').all(limit).map((m) => ({
      id: m.id, to: m.recipient, purpose: m.purpose, body: m.body, status: m.status, error: m.error, createdAt: m.created_at, updatedAt: m.updated_at
    }));
  }

  return { send, notify, handleWebhook, list, outbox, mask, toE164 };
};
