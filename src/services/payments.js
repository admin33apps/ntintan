'use strict';
/**
 * Payments: Paystack (GHS — MTN MoMo, Telecel Cash, AirtelTigo Money, cards)
 * plus a local simulator for development. Fulfilment is idempotent and
 * always re-verifies with the provider before granting anything.
 */
const crypto = require('node:crypto');
const { tx } = require('../db');
const { HttpError } = require('../lib/http');
const { randomCode } = require('../lib/security');

function paystackProvider(config) {
  async function call(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(config.PAYSTACK_BASE + path, {
        method,
        headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== true) throw new HttpError(502, 'Payment provider error. Please try again.', { code: 'provider_error' });
      return json.data;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'Could not reach the payment provider. Please try again.', { code: 'provider_unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    name: 'paystack',
    async initialize({ reference, amount, email, callbackUrl, channels, metadata }) {
      const data = await call('POST', '/transaction/initialize', {
        reference, amount, email, currency: 'GHS', callback_url: callbackUrl, channels, metadata
      });
      return { authorizationUrl: data.authorization_url };
    },
    async verify(reference) {
      const data = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      return { status: data.status, amount: data.amount, currency: data.currency, channel: data.channel };
    },
    async refund(reference, amount) {
      const data = await call('POST', '/refund', { transaction: reference, amount });
      return { status: data.status || 'pending' };
    },
    verifyWebhookSignature(rawBody, signature) {
      if (!signature) return false;
      const expected = crypto.createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
  };
}

function simulatedProvider(config, db) {
  return {
    name: 'simulate',
    async initialize({ reference }) {
      return { authorizationUrl: `${config.PUBLIC_URL}/pay/simulate?reference=${encodeURIComponent(reference)}` };
    },
    async verify(reference) {
      const p = db.prepare('SELECT amount_pesewas, provider_status FROM payments WHERE reference = ?').get(reference);
      if (!p) throw new HttpError(404, 'Payment not found');
      return { status: p.provider_status === 'sim_success' ? 'success' : p.provider_status === 'sim_failed' ? 'failed' : 'pending', amount: p.amount_pesewas, currency: 'GHS', channel: 'simulated' };
    },
    async refund() { return { status: 'processed' }; },
    verifyWebhookSignature() { return false; }
  };
}

module.exports = function paymentsService({ db, config, audit }) {
  const provider = config.PAYMENTS_MODE === 'paystack' ? paystackProvider(config)
    : config.PAYMENTS_MODE === 'simulate' ? simulatedProvider(config, db) : null;
  const handlers = {}; // purpose -> { onSuccess(targetId, payment), onFailure(targetId, payment) }

  const enabled = () => Boolean(provider);
  const register = (purpose, h) => { handlers[purpose] = h; };

  /** Create a payment row and get a checkout URL. */
  async function start({ purpose, targetId, userId, amount, email, phone, channel }) {
    if (!provider) throw new HttpError(503, 'Online payments are not available right now. Choose cash on delivery or Ogya wallet.', { code: 'payments_disabled' });
    if (!Number.isInteger(amount) || amount < 100) throw new HttpError(400, 'Amount is too small for online payment (minimum GH₵1.00)');
    const reference = `NTN${Date.now().toString(36).toUpperCase()}${randomCode(6)}`;
    db.prepare(`INSERT INTO payments (reference, purpose, target_id, user_id, amount_pesewas, channel, provider, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'initialized')`)
      .run(reference, purpose, targetId, userId || null, amount, channel || null, provider.name);
    const payEmail = email || `${(phone || 'customer').replace(/\D/g, '') || 'customer'}@${config.CUSTOMER_EMAIL_DOMAIN}`;
    const channels = channel === 'momo' ? ['mobile_money'] : channel === 'card' ? ['card'] : ['mobile_money', 'card'];
    const { authorizationUrl } = await provider.initialize({
      reference, amount, email: payEmail, channels,
      callbackUrl: `${config.PUBLIC_URL}/payment/callback`,
      metadata: { purpose, target_id: targetId }
    });
    return { reference, authorizationUrl };
  }

  /** Verify with the provider and apply the effect exactly once. */
  async function confirm(reference) {
    const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    if (!p) throw new HttpError(404, 'Payment not found');
    if (p.status === 'success') return summary(p);
    if (!provider) throw new HttpError(503, 'Payments are not configured');
    const result = await provider.verify(reference);

    return tx(db, () => {
      const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
      if (fresh.status === 'success') return summary(fresh);
      const valid = result.status === 'success' && result.amount === fresh.amount_pesewas && result.currency === 'GHS';
      if (valid) {
        db.prepare("UPDATE payments SET status = 'success', provider_status = ?, channel = COALESCE(?, channel), updated_at = datetime('now') WHERE id = ?")
          .run(result.status, result.channel || null, fresh.id);
        handlers[fresh.purpose]?.onSuccess(fresh.target_id, fresh);
        audit(fresh.user_id, 'payment.success', `${fresh.reference} ${fresh.purpose}#${fresh.target_id} ${fresh.amount_pesewas}`, null);
      } else if (result.status === 'failed' || result.status === 'abandoned' || (result.status === 'success' && !valid)) {
        const status = result.status === 'abandoned' ? 'abandoned' : 'failed';
        db.prepare("UPDATE payments SET status = ?, provider_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, result.status, fresh.id);
        if (result.status === 'success' && !valid) audit(fresh.user_id, 'payment.amount_mismatch', `${fresh.reference} expected ${fresh.amount_pesewas} got ${result.amount} ${result.currency}`, null);
        handlers[fresh.purpose]?.onFailure?.(fresh.target_id, fresh);
      }
      return summary(db.prepare('SELECT * FROM payments WHERE id = ?').get(fresh.id));
    });
  }

  function summary(p) {
    return { reference: p.reference, purpose: p.purpose, targetId: p.target_id, status: p.status, amount: p.amount_pesewas };
  }

  async function handleWebhook(rawBody, signature) {
    if (!provider || !provider.verifyWebhookSignature(rawBody, signature)) throw new HttpError(401, 'Invalid signature');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (typeof event?.event === 'string' && event.event.startsWith('refund.')) {
      const d = event.data || {};
      const refRef = d.transaction_reference || d.transaction?.reference || d.reference;
      const status = { 'refund.processed': 'processed', 'refund.failed': 'failed', 'refund.pending': 'pending', 'refund.processing': 'processing', 'refund.needs-attention': 'needs-attention' }[event.event];
      if (status && typeof refRef === 'string') {
        db.prepare("UPDATE payments SET refund_status = ?, updated_at = datetime('now') WHERE reference = ?").run(status, refRef);
        audit(null, `payment.refund_${status}`, refRef, null);
      }
      return;
    }
    const ref = event?.data?.reference;
    if ((event.event === 'charge.success' || event.event === 'charge.failed') && typeof ref === 'string') {
      const exists = db.prepare('SELECT 1 FROM payments WHERE reference = ?').get(ref);
      if (exists) await confirm(ref);
    }
  }

  /** Development only: mark a simulated payment as paid/failed. */
  function simulate(reference, outcome) {
    if (config.PAYMENTS_MODE !== 'simulate') throw new HttpError(404, 'Not found');
    const r = db.prepare("UPDATE payments SET provider_status = ? WHERE reference = ? AND status = 'initialized'").run(outcome === 'success' ? 'sim_success' : 'sim_failed', reference);
    if (!r.changes) throw new HttpError(404, 'Payment not found or already completed');
  }

  /**
   * Refund the successful online payment for an order/coupon/top-up back to the customer's
   * card or mobile money via Paystack. Idempotent; records status for the admin dashboard.
   */
  async function refundFor(purpose, targetId, amount, reason) {
    const p = db.prepare("SELECT * FROM payments WHERE purpose = ? AND target_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1").get(purpose, targetId);
    if (!p) return null;
    if (p.refund_status && p.refund_status !== 'failed') return { status: p.refund_status, reference: p.reference };
    const amt = Math.min(amount ?? p.amount_pesewas, p.amount_pesewas);
    db.prepare("UPDATE payments SET refund_status = 'requested', refund_amount = ?, refund_error = NULL, updated_at = datetime('now') WHERE id = ?").run(amt, p.id);
    try {
      if (!provider) throw new Error('payments not configured');
      const r = await provider.refund(p.reference, amt);
      db.prepare("UPDATE payments SET refund_status = ?, updated_at = datetime('now') WHERE id = ?").run(r.status, p.id);
      audit(null, 'payment.refund_requested', `${p.reference} ${amt} ${reason || ''}`, null);
      return { status: r.status, reference: p.reference };
    } catch (e) {
      db.prepare("UPDATE payments SET refund_status = 'failed', refund_error = ?, updated_at = datetime('now') WHERE id = ?").run(String(e.message).slice(0, 200), p.id);
      audit(null, 'payment.refund_failed', `${p.reference} ${e.message}`, null);
      return { status: 'failed', reference: p.reference, error: e.message };
    }
  }

  function paymentFor(purpose, targetId) {
    const p = db.prepare('SELECT * FROM payments WHERE purpose = ? AND target_id = ? ORDER BY id DESC LIMIT 1').get(purpose, targetId);
    return p ? { reference: p.reference, status: p.status, channel: p.channel, amount: p.amount_pesewas, refundStatus: p.refund_status, refundAmount: p.refund_amount, refundError: p.refund_error } : null;
  }

  function get(reference) {
    const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
    if (!p) throw new HttpError(404, 'Payment not found');
    return summary(p);
  }

  return { enabled, register, start, confirm, handleWebhook, simulate, get, refundFor, paymentFor, mode: config.PAYMENTS_MODE };
};
