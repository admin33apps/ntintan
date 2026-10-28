'use strict';
/** Leads (partner/quote/newsletter forms), notifications outbox, audit log, admin stats. */
const { HttpError } = require('../lib/http');

function auditService(db) {
  return function audit(userId, action, detail = '', ip = null) {
    try {
      db.prepare('INSERT INTO audit_log (user_id, action, detail, ip) VALUES (?, ?, ?, ?)').run(userId ?? null, action, String(detail).slice(0, 500), ip);
    } catch (e) {
      console.error('[audit] failed to write', e.message);
    }
  };
}

function notifyService(sms) {
  return { sms: (phone, text, purpose = 'notification') => sms.notify(phone, text, purpose) };
}

/** Retention schedule — must match the Privacy Notice (section "How long we keep your data"). */
function retentionService(db) {
  return function purge() {
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    db.prepare("DELETE FROM otp_codes WHERE created_at < datetime('now', '-1 day')").run();
    db.prepare("DELETE FROM sms_log WHERE created_at < datetime('now', '-12 months')").run();
    db.prepare("DELETE FROM leads WHERE created_at < datetime('now', '-24 months')").run();
    db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-24 months')").run();
  };
}

function leadsService({ db, audit }) {
  function create(type, data, meta) {
    const { name = null, phone = null, email = null, region = null, ...rest } = data;
    if (type === 'newsletter' && db.prepare("SELECT 1 FROM leads WHERE type = 'newsletter' AND email = ?").get(email)) return { duplicate: true };
    db.prepare('INSERT INTO leads (type, name, phone, email, region, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(type, name, phone, email, region, JSON.stringify(rest));
    audit(meta.userId || null, `lead.${type}`, name || email || '', meta.ip);
    return { ok: true };
  }
  function list({ type, status } = {}) {
    const where = [];
    const vals = [];
    if (type) { where.push('type = ?'); vals.push(type); }
    if (status) { where.push('status = ?'); vals.push(status); }
    return db.prepare(`SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...vals)
      .map((l) => ({ id: l.id, type: l.type, name: l.name, phone: l.phone, email: l.email, region: l.region, details: JSON.parse(l.payload), status: l.status, createdAt: l.created_at }));
  }
  function setStatus(id, status) {
    if (!db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id).changes) throw new HttpError(404, 'Lead not found');
  }
  return { create, list, setStatus };
}

function statsService(db) {
  return function stats() {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    return {
      revenueToday: one("SELECT COALESCE(SUM(total),0) v FROM orders WHERE status != 'cancelled' AND paid = 1 AND date(created_at) = date('now')").v,
      revenue30d: one("SELECT COALESCE(SUM(total),0) v FROM orders WHERE status != 'cancelled' AND paid = 1 AND created_at >= datetime('now','-30 days')").v,
      ordersOpen: one("SELECT COUNT(*) v FROM orders WHERE status IN ('confirmed','processing','out_for_delivery')").v,
      ordersPendingPayment: one("SELECT COUNT(*) v FROM orders WHERE status = 'pending_payment'").v,
      ordersTotal: one('SELECT COUNT(*) v FROM orders').v,
      customers: one("SELECT COUNT(*) v FROM users WHERE role = 'customer'").v,
      leadsNew: one("SELECT COUNT(*) v FROM leads WHERE status = 'new'").v,
      couponsActiveBalance: one("SELECT COALESCE(SUM(balance_pesewas),0) v FROM coupons WHERE status = 'active'").v,
      walletLiability: one('SELECT COALESCE(SUM(ogy_balance),0) v FROM users').v,
      productsPriced: one('SELECT COUNT(*) v FROM products WHERE price_pesewas IS NOT NULL AND active = 1').v,
      productsTotal: one('SELECT COUNT(*) v FROM products').v,
      lowStock: db.prepare('SELECT id, name, stock FROM products WHERE stock IS NOT NULL AND stock <= 5 AND active = 1 ORDER BY stock').all()
    };
  };
}

module.exports = { auditService, notifyService, retentionService, leadsService, statsService };
