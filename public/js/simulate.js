import { $, $$, esc, ghs, api, loadSession, toastError } from './lib.js';

const reference = new URLSearchParams(location.search).get('reference') || '';
(async () => {
  await loadSession();
  try {
    const { payment } = await api(`/api/payments/simulate/${encodeURIComponent(reference)}`);
    $('#simDetails').innerHTML = `<div><span>Reference</span><span>${esc(payment.reference)}</span></div><div><span>For</span><span>${esc(payment.purpose)}</span></div><div><span>Amount</span><span><b>${ghs(payment.amount)}</b></span></div><div><span>Status</span><span>${esc(payment.status)}</span></div>`;
  } catch (e) { $('#simDetails').innerHTML = `<p class="up">${esc(e.message)}</p>`; }
})();
$$('[data-outcome]').forEach((b) => b.addEventListener('click', async () => {
  try {
    await api('/api/payments/simulate', { method: 'POST', body: { reference, outcome: b.dataset.outcome } });
    location.assign(`/payment/callback?reference=${encodeURIComponent(reference)}`);
  } catch (e) { toastError(e); }
}));
