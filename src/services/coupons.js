'use strict';
/** Food coupons: bought by customers (wallet or online payment) or issued by admins. */
const { tx } = require('../db');
const { HttpError } = require('../lib/http');
const { randomCode } = require('../lib/security');

const CODE_RE = /^NTN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

module.exports = function couponService({ db, payments, wallet, audit, notify }) {
  const normalize = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

  function newCode() {
    for (let i = 0; i < 10; i++) {
      const code = `NTN-${randomCode(4)}-${randomCode(4)}`;
      if (!db.prepare('SELECT 1 FROM coupons WHERE code = ?').get(code)) return code;
    }
    throw new HttpError(500, 'Could not generate coupon code');
  }

  const view = (c) => ({
    code: c.code, initial: c.initial_pesewas, balance: c.balance_pesewas, status: c.status,
    recipientName: c.recipient_name, recipientPhone: c.recipient_phone, message: c.message, source: c.source, createdAt: c.created_at
  });

  function insert({ amount, recipientName, recipientPhone, message, userId, status, source }) {
    const code = newCode();
    const r = db.prepare(`INSERT INTO coupons (code, initial_pesewas, balance_pesewas, status, purchaser_user_id, recipient_name, recipient_phone, message, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, amount, amount, status, userId || null, recipientName, recipientPhone, message || '', source);
    return Number(r.lastInsertRowid);
  }

  function byId(id) { return db.prepare('SELECT * FROM coupons WHERE id = ?').get(id); }

  function sendToRecipient(c) {
    notify.sms(c.recipient_phone, `You've received a GH₵${(c.initial_pesewas / 100).toFixed(2)} Ntintan food coupon${c.message ? `: "${c.message}"` : ''}. Code: ${c.code}. Redeem at checkout.`);
  }

  async function purchase(user, input) {
    const { amount, recipientName, recipientPhone, message, method } = input;
    if (method === 'ogya') {
      return tx(db, () => {
        const id = insert({ amount, recipientName, recipientPhone, message, userId: user.id, status: 'active', source: 'purchase' });
        const c = byId(id);
        wallet.debit(user.id, amount, 'coupon_purchase', c.code);
        audit(user.id, 'coupon.purchase', `${c.code} ${amount} via ogya`, null);
        sendToRecipient(c);
        return { coupon: view(c) };
      });
    }
    const id = insert({ amount, recipientName, recipientPhone, message, userId: user.id, status: 'pending', source: 'purchase' });
    try {
      const pay = await payments.start({ purpose: 'coupon', targetId: id, userId: user.id, amount, email: user.email, phone: user.phone, channel: method });
      return { payment: pay };
    } catch (e) {
      db.prepare("UPDATE coupons SET status = 'void' WHERE id = ?").run(id);
      throw e;
    }
  }

  payments.register('coupon', {
    onSuccess(id) {
      db.prepare("UPDATE coupons SET status = 'active' WHERE id = ? AND status = 'pending'").run(id);
      sendToRecipient(byId(id));
    },
    onFailure(id) {
      db.prepare("UPDATE coupons SET status = 'void' WHERE id = ? AND status = 'pending'").run(id);
    }
  });

  function issue(adminId, input) {
    const id = insert({ ...input, userId: adminId, status: 'active', source: 'admin' });
    const c = byId(id);
    audit(adminId, 'coupon.issue', `${c.code} ${c.initial_pesewas}`, null);
    sendToRecipient(c);
    return view(c);
  }

  /** Public balance check. Only reveals balance/status, never purchaser details. */
  function check(code) {
    code = normalize(code);
    if (!CODE_RE.test(code)) throw new HttpError(404, 'Coupon not found', { code: 'coupon_not_found' });
    const c = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!c || c.status === 'pending') throw new HttpError(404, 'Coupon not found', { code: 'coupon_not_found' });
    return { code: c.code, balance: c.balance_pesewas, initial: c.initial_pesewas, status: c.status };
  }

  /** Returns usable coupon row or throws. */
  function usable(code) {
    code = normalize(code);
    const c = CODE_RE.test(code) ? db.prepare('SELECT * FROM coupons WHERE code = ?').get(code) : null;
    if (!c || c.status !== 'active') throw new HttpError(422, 'Coupon code is not valid', { code: 'coupon_invalid', fields: { couponCode: 'is not valid' } });
    if (c.balance_pesewas <= 0) throw new HttpError(422, 'This coupon has no balance left', { code: 'coupon_empty', fields: { couponCode: 'has no balance left' } });
    return c;
  }

  function redeem(couponId, orderId, amount) {
    const r = db.prepare('UPDATE coupons SET balance_pesewas = balance_pesewas - ? WHERE id = ? AND balance_pesewas >= ?').run(amount, couponId, amount);
    if (!r.changes) throw new HttpError(409, 'Coupon balance changed, please try again');
    db.prepare('INSERT INTO coupon_redemptions (coupon_id, order_id, amount) VALUES (?, ?, ?)').run(couponId, orderId, amount);
  }

  function reverseForOrder(orderId) {
    const rows = db.prepare('SELECT * FROM coupon_redemptions WHERE order_id = ? AND reversed = 0').all(orderId);
    for (const r of rows) {
      db.prepare('UPDATE coupons SET balance_pesewas = balance_pesewas + ? WHERE id = ?').run(r.amount, r.coupon_id);
      db.prepare('UPDATE coupon_redemptions SET reversed = 1 WHERE id = ?').run(r.id);
    }
  }

  function mine(userId) {
    return db.prepare("SELECT * FROM coupons WHERE purchaser_user_id = ? AND status != 'pending' ORDER BY id DESC LIMIT 50").all(userId).map(view);
  }

  function list() {
    return db.prepare('SELECT * FROM coupons ORDER BY id DESC LIMIT 500').all().map(view);
  }

  function voidCoupon(adminId, code) {
    const r = db.prepare("UPDATE coupons SET status = 'void' WHERE code = ? AND status = 'active'").run(normalize(code));
    if (!r.changes) throw new HttpError(404, 'Active coupon not found');
    audit(adminId, 'coupon.void', normalize(code), null);
  }

  return { purchase, issue, check, usable, redeem, reverseForOrder, mine, list, voidCoupon, normalize };
};
