'use strict';
/** Ogya wallet. Balances are integer OGY; 100 OGY = GH₵1, so 1 OGY = 1 pesewa. */
const { tx } = require('../db');
const { HttpError } = require('../lib/http');

module.exports = function walletService({ db, payments, audit }) {
  function balance(userId) {
    return db.prepare('SELECT ogy_balance FROM users WHERE id = ?').get(userId)?.ogy_balance ?? 0;
  }

  function apply(userId, amountOgy, type, reference) {
    return tx(db, () => {
      const current = balance(userId);
      const next = current + amountOgy;
      if (next < 0) throw new HttpError(402, `Not enough Ogya. You need ${(-next).toLocaleString('en-GH')} more OGY.`, { code: 'insufficient_ogya' });
      db.prepare('UPDATE users SET ogy_balance = ? WHERE id = ?').run(next, userId);
      db.prepare('INSERT INTO wallet_tx (user_id, type, amount_ogy, balance_after, reference) VALUES (?, ?, ?, ?, ?)').run(userId, type, amountOgy, next, reference || null);
      return next;
    });
  }

  const credit = (userId, amount, type, ref) => {
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Credit amount must be positive');
    return apply(userId, amount, type, ref);
  };
  const debit = (userId, amount, type, ref) => {
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Debit amount must be positive');
    return apply(userId, -amount, type, ref);
  };

  function history(userId, limit = 20) {
    return db.prepare('SELECT type, amount_ogy, balance_after, reference, created_at FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
      .map((t) => ({ type: t.type, amount: t.amount_ogy, balanceAfter: t.balance_after, reference: t.reference, createdAt: t.created_at }));
  }

  /** Top up via online payment. amountGhsPesewas == OGY credited. */
  async function startTopup(user, amount, channel) {
    return payments.start({ purpose: 'topup', targetId: user.id, userId: user.id, amount, email: user.email, phone: user.phone, channel });
  }

  payments.register('topup', {
    onSuccess(userId, payment) {
      credit(userId, payment.amount_pesewas, 'topup', payment.reference);
      audit(userId, 'wallet.topup', `${payment.amount_pesewas} OGY via ${payment.reference}`, null);
    }
  });

  return { balance, credit, debit, history, startTopup };
};
