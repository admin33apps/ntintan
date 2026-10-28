'use strict';
/**
 * Orders. Prices, discounts, delivery fees and totals are ALWAYS computed
 * here on the server from the database — client-sent prices are ignored.
 */
const { tx } = require('../db');
const { HttpError } = require('../lib/http');
const { randomCode } = require('../lib/security');

const TRANSITIONS = {
  pending_payment: ['cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};

module.exports = function orderService({ db, config, payments, wallet, coupons, audit, notify }) {
  /** Price a cart. Throws on unavailable items. */
  function price({ items, paymentMethod, couponCode }) {
    const merged = new Map();
    for (const { productId, qty } of items) merged.set(productId, (merged.get(productId) || 0) + qty);
    if (merged.size === 0) throw new HttpError(422, 'Your bag is empty', { code: 'empty_cart' });

    const lines = [];
    for (const [productId, qty] of merged) {
      if (qty > 999) throw new HttpError(422, 'Quantity too large');
      const p = db.prepare(`SELECT p.*, COALESCE(p.price_unit_label, u.name, 'unit') AS unit_label FROM products p LEFT JOIN units u ON u.id = COALESCE(p.price_unit_id, p.default_unit_id) WHERE p.id = ?`).get(productId);
      if (!p || !p.active) throw new HttpError(422, 'A product in your bag is no longer available', { code: 'unavailable', fields: { [`product_${productId}`]: 'unavailable' } });
      if (!p.price_pesewas) throw new HttpError(422, `${p.name} is sold on request. Please ask for a quote.`, { code: 'price_on_request' });
      if (p.stock !== null && p.stock < qty) throw new HttpError(409, `Only ${p.stock} × ${p.name} left in stock`, { code: 'out_of_stock' });
      lines.push({ productId: p.id, name: p.name, emoji: p.emoji, unitLabel: p.unit_label, unitPrice: p.price_pesewas, qty, lineTotal: p.price_pesewas * qty, stock: p.stock, ageRestricted: Boolean(p.age_restricted) });
    }
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const deliveryFee = subtotal >= config.FREE_DELIVERY_THRESHOLD ? 0 : config.DELIVERY_FEE;
    const discount = paymentMethod === 'ogya' ? Math.floor(subtotal * config.OGYA_DISCOUNT_BPS / 10_000) : 0;
    let total = subtotal + deliveryFee - discount;
    let couponAmount = 0;
    let coupon = null;
    if (couponCode) {
      coupon = coupons.usable(couponCode);
      couponAmount = Math.min(coupon.balance_pesewas, total);
      total -= couponAmount;
    }
    const ageRestricted = lines.some((l) => l.ageRestricted);
    return { lines, subtotal, deliveryFee, discount, couponCode: coupon?.code || null, couponAmount, couponBalance: coupon?.balance_pesewas ?? null, total, coupon, ageRestricted };
  }

  function publicQuote(q) {
    const { coupon, ...rest } = q;
    return { ...rest, lines: q.lines.map(({ stock, ...l }) => l) };
  }

  function newRef() {
    for (let i = 0; i < 10; i++) {
      const ref = `NTN-${randomCode(6)}`;
      if (!db.prepare('SELECT 1 FROM orders WHERE ref = ?').get(ref)) return ref;
    }
    throw new HttpError(500, 'Could not create order reference');
  }

  async function create(input, user, meta) {
    if (input.acceptTerms !== true) throw new HttpError(422, 'Please accept the Terms of Sale to place your order', { code: 'terms_required', fields: { acceptTerms: 'must be accepted' } });
    let method = input.paymentMethod;
    if (method === 'ogya' && !user) throw new HttpError(401, 'Sign in to pay with Ogya Coin', { code: 'auth_required' });
    if ((method === 'momo' || method === 'card') && !payments.enabled()) throw new HttpError(503, 'Online payments are not available right now. Choose cash on delivery.', { code: 'payments_disabled' });

    const order = tx(db, () => {
      const q = price(input);
      if (q.ageRestricted) {
        if (user?.account_type === 'school') throw new HttpError(422, 'Alcoholic drinks cannot be ordered on a school account. Remove them from your bag to continue.', { code: 'alcohol_not_allowed' });
        if (q.coupon && q.coupon.source === 'admin') throw new HttpError(422, 'Programme coupons cannot be used for alcoholic drinks. Remove the alcohol or use another payment method.', { code: 'alcohol_coupon_not_allowed' });
        if (input.confirmAge !== true) throw new HttpError(422, 'Your bag contains alcohol. Please confirm that you and the person receiving the order are 18 or older.', { code: 'age_confirmation_required', fields: { confirmAge: 'must be confirmed' } });
      }
      if (q.total === 0) method = 'coupon';
      const needsPayment = method === 'momo' || method === 'card';
      const ref = newRef();
      const r = db.prepare(`INSERT INTO orders (ref, user_id, customer_name, phone, email, region, town, address, delivery_slot, notes, payment_method, status,
          subtotal, delivery_fee, discount, coupon_code, coupon_amount, total, paid, terms_version, age_confirmed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ref, user?.id || null, input.name, input.phone, input.email || user?.email || null, input.region, input.town, input.address,
        input.deliverySlot, input.notes || '', method, needsPayment ? 'pending_payment' : 'confirmed',
        q.subtotal, q.deliveryFee, q.discount, q.couponCode, q.couponAmount, q.total, method === 'ogya' || method === 'coupon' ? 1 : 0, config.TERMS_VERSION, q.ageRestricted ? 1 : 0
      );
      const orderId = Number(r.lastInsertRowid);
      const item = db.prepare('INSERT INTO order_items (order_id, product_id, name, unit_label, unit_price, qty, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const l of q.lines) {
        item.run(orderId, l.productId, l.name, l.unitLabel, l.unitPrice, l.qty, l.lineTotal);
        if (l.stock !== null) {
          const s = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(l.qty, l.productId, l.qty);
          if (!s.changes) throw new HttpError(409, `${l.name} just sold out`, { code: 'out_of_stock' });
        }
      }
      if (q.coupon && q.couponAmount > 0) coupons.redeem(q.coupon.id, orderId, q.couponAmount);
      if (method === 'ogya' && q.total > 0) wallet.debit(user.id, q.total, 'order_payment', ref);
      audit(user?.id || null, 'order.create', `${ref} ${method} ${q.total}`, meta.ip);
      return { id: orderId, ref, total: q.total, method, needsPayment, ageRestricted: q.ageRestricted };
    });

    let payment = null;
    if (order.needsPayment) {
      try {
        payment = await payments.start({ purpose: 'order', targetId: order.id, userId: user?.id, amount: order.total, email: input.email || user?.email, phone: input.phone, channel: order.method });
      } catch (e) {
        cancel(order.id, 'payment_init_failed');
        throw e;
      }
    } else {
      notifyConfirmed(order.id);
    }
    return { order: get(order.id), payment };
  }

  function notifyConfirmed(orderId) {
    const o = db.prepare('SELECT ref, phone, total, payment_method, age_confirmed FROM orders WHERE id = ?').get(orderId);
    notify.sms(o.phone, `Ntintan: order ${o.ref} confirmed. Total GH₵${(o.total / 100).toFixed(2)}${o.payment_method === 'cash' ? ' — pay on delivery' : ''}.${o.age_confirmed ? ' Contains alcohol: the receiver must be 18+ and show ID.' : ''} Track it on our site with your order number and phone.`);
  }

  payments.register('order', {
    onSuccess(orderId) {
      const r = db.prepare("UPDATE orders SET paid = 1, status = 'confirmed', updated_at = datetime('now') WHERE id = ? AND status = 'pending_payment'").run(orderId);
      if (r.changes) notifyConfirmed(orderId);
      else {
        // Paid after it was auto-cancelled (e.g. late MoMo approval): refund automatically.
        const c = db.prepare("UPDATE orders SET paid = 1, notes = notes || ' [paid after cancellation — auto refund]', updated_at = datetime('now') WHERE id = ? AND status = 'cancelled'").run(orderId);
        if (c.changes) setImmediate(() => refundOrder(orderId, 'paid_after_cancellation'));
      }
    },
    onFailure(orderId) { cancel(orderId, 'payment_failed'); }
  });

  /** Cancel and release stock, coupon balance and Ogya. Idempotent. */
  function cancel(orderId, reason, actorId = null) {
    return tx(db, () => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o || o.status === 'cancelled') return false;
      if (o.status === 'delivered') throw new HttpError(409, 'Delivered orders cannot be cancelled');
      for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId)) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').run(it.qty, it.product_id);
      }
      coupons.reverseForOrder(orderId);
      if (o.payment_method === 'ogya' && o.paid && o.total > 0) wallet.credit(o.user_id, o.total, 'order_refund', o.ref);
      db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now'), notes = TRIM(notes || ' [cancelled: ' || ? || ']') WHERE id = ?").run(reason, orderId);
      audit(actorId, 'order.cancel', `${o.ref} ${reason}`, null);
      return true;
    });
  }

  async function refundOrder(orderId, reason) {
    const o = db.prepare('SELECT id, ref, phone, total, payment_method, paid FROM orders WHERE id = ?').get(orderId);
    if (!o || !o.paid || !['momo', 'card'].includes(o.payment_method)) return null;
    const r = await payments.refundFor('order', o.id, o.total, reason);
    if (r && r.status !== 'failed') notify.sms(o.phone, `Ntintan: order ${o.ref} was cancelled. A refund of GHS ${(o.total / 100).toFixed(2)} has been sent to your original payment method. It can take 1-10 working days to arrive.`);
    return r;
  }

  function expireUnpaid() {
    const rows = db.prepare(`SELECT id FROM orders WHERE status = 'pending_payment' AND created_at <= datetime('now', ?)`).all(`-${config.UNPAID_ORDER_TTL_MINUTES} minutes`);
    rows.forEach((r) => cancel(r.id, 'payment_timeout'));
    return rows.length;
  }

  function view(o, { full = false } = {}) {
    const items = db.prepare('SELECT product_id, name, unit_label, unit_price, qty, line_total FROM order_items WHERE order_id = ?').all(o.id)
      .map((i) => ({ productId: i.product_id, name: i.name, unitLabel: i.unit_label, unitPrice: i.unit_price, qty: i.qty, lineTotal: i.line_total }));
    const base = {
      ref: o.ref, status: o.status, paymentMethod: o.payment_method, paid: Boolean(o.paid), deliverySlot: o.delivery_slot,
      region: o.region, town: o.town, subtotal: o.subtotal, deliveryFee: o.delivery_fee, discount: o.discount,
      couponCode: o.coupon_code, couponAmount: o.coupon_amount, total: o.total, items, ageRestricted: Boolean(o.age_confirmed), createdAt: o.created_at, updatedAt: o.updated_at
    };
    if (full) Object.assign(base, { id: o.id, customerName: o.customer_name, phone: o.phone, email: o.email, address: o.address, notes: o.notes, userId: o.user_id, termsVersion: o.terms_version, payment: payments.paymentFor('order', o.id) });
    return base;
  }

  function get(id) { return view(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)); }

  function track(ref, phone) {
    const o = db.prepare('SELECT * FROM orders WHERE ref = ? AND phone = ?').get(String(ref).trim().toUpperCase(), phone);
    if (!o) throw new HttpError(404, 'No order found with that number and phone', { code: 'order_not_found' });
    return view(o);
  }

  function mine(userId) {
    return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId).map((o) => view(o));
  }

  function list({ status, q, limit = 200 } = {}) {
    const where = [];
    const vals = [];
    if (status) { where.push('status = ?'); vals.push(status); }
    if (q) { where.push('(ref LIKE ? OR phone LIKE ? OR customer_name LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...vals, limit).map((o) => view(o, { full: true }));
  }

  function setStatus(ref, status, actorId) {
    const o = db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!TRANSITIONS[o.status].includes(status)) throw new HttpError(409, `Cannot move an order from ${o.status.replace(/_/g, ' ')} to ${status.replace(/_/g, ' ')}`);
    if (status === 'cancelled') {
      cancel(o.id, 'admin', actorId);
      if (o.paid && ['momo', 'card'].includes(o.payment_method)) setImmediate(() => refundOrder(o.id, 'cancelled_by_admin'));
      else if (o.status !== 'pending_payment') notify.sms(o.phone, `Ntintan: order ${o.ref} has been cancelled.${o.payment_method === 'ogya' ? ' Your Ogya has been returned to your wallet.' : ''}${o.coupon_amount ? ' Your coupon balance has been restored.' : ''}`);
    }
    else {
      db.prepare("UPDATE orders SET status = ?, paid = CASE WHEN ? = 'delivered' AND payment_method = 'cash' THEN 1 ELSE paid END, updated_at = datetime('now') WHERE id = ?").run(status, status, o.id);
      audit(actorId, 'order.status', `${ref} ${o.status} -> ${status}`, null);
      if (status === 'out_for_delivery') notify.sms(o.phone, `Ntintan: order ${o.ref} is out for delivery.`);
    }
    return view(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), { full: true });
  }

  return { price, publicQuote, create, cancel, refundOrder, expireUnpaid, get, track, mine, list, setStatus, TRANSITIONS };
};
