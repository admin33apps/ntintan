import { $, $$, esc, icon, ghs, ogy, num, formatDate, titleCase, api, loadSession, toast, toastError, formData, checkForm, showErrors, setLoading, openLayerEl, closeLayer } from './lib.js';

const theme = (() => { try { return JSON.parse(localStorage.getItem('ntn_theme')); } catch { return null; } })();
if (theme === 'dark') document.documentElement.dataset.theme = 'dark';

const TRANSITIONS = {
  pending_payment: ['cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};
const ctx = { user: null, config: null, categories: [], view: 'dashboard' };
const view = $('#view');

document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeLayer(); });
$('#adminModal').addEventListener('mousedown', (e) => { if (e.target.id === 'adminModal') closeLayer(); });

async function boot() {
  try {
    ctx.user = await loadSession();
    ctx.config = await api('/api/config');
  } catch (e) { toastError(e); return; }
  render();
}

function render() {
  const isAdmin = ctx.user?.role === 'admin';
  $('#loginView').hidden = isAdmin;
  $('#appView').hidden = !isAdmin;
  $('#adminUser').hidden = !isAdmin;
  if (isAdmin) { $('#adminEmail').textContent = ctx.user.email; show(ctx.view); }
  else if (ctx.user) {
    const box = $('#adminLogin .form-error');
    box.textContent = 'This account does not have admin access.';
    box.hidden = false;
  }
}

let challenge = null;
$('#adminLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    const r = await api('/api/auth/admin/login', { method: 'POST', body: formData(f) });
    f.reset();
    if (r.otpRequired) {
      challenge = r.challenge;
      $('#adminPhoneHint').textContent = r.phoneHint;
      $('#adminDevHint').hidden = !r.devCode;
      $('#adminDevHint').textContent = r.devCode ? `Development mode (no SMS sent): code ${r.devCode}` : '';
      f.hidden = true;
      $('#adminOtp').hidden = false;
      $('#aCode').focus();
      return;
    }
    ctx.user = r.user;
    render();
  } catch (err) { showErrors(f, err); } finally { setLoading(btn, false); }
});
$('#adminOtp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    ctx.user = (await api('/api/auth/admin/verify', { method: 'POST', body: { challenge, code: f.elements.code.value.trim() } })).user;
    f.reset();
    f.hidden = true;
    $('#adminLogin').hidden = false;
    render();
  } catch (err) {
    showErrors(f, err);
    if (['signup_expired', 'otp_locked', 'otp_expired', 'otp_missing'].includes(err.code)) $('#adminBack').click();
  } finally { setLoading(btn, false); }
});
$('#adminBack').addEventListener('click', () => { $('#adminOtp').hidden = true; $('#adminLogin').hidden = false; $('#aEmail').focus(); });
$('#adminLogout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  ctx.user = null;
  await loadSession();
  render();
});

$$('.admin-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

const VIEWS = { dashboard, orders, products, coupons, farmers, leads, users, sms, audit };
async function show(name) {
  ctx.view = name;
  $$('.admin-tabs button').forEach((b) => { const on = b.dataset.view === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await VIEWS[name](); } catch (e) {
    if (e.status === 401 || e.status === 403) { ctx.user = null; render(); }
    view.innerHTML = `<p class="up">${esc(e.message)}</p>`;
  }
}

function modal(title, html) {
  $('#adminModalTitle').textContent = title;
  $('#adminModalBody').innerHTML = html;
  openLayerEl($('#adminModal'));
  return $('#adminModalBody');
}

const statusChip = (s) => `<span class="status ${esc(s)}">${esc(titleCase(s))}</span>`;
const ghsToPesewas = (v) => Math.round(parseFloat(String(v).replace(/,/g, '')) * 100);

/* ---------------- Dashboard ---------------- */
async function dashboard() {
  const [{ stats }, { orders: recent }] = await Promise.all([api('/api/admin/stats'), api('/api/admin/orders')]);
  view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><small>Paid revenue today</small><b>${ghs(stats.revenueToday)}</b></div>
      <div class="stat-card"><small>Paid revenue · 30 days</small><b>${ghs(stats.revenue30d)}</b></div>
      <div class="stat-card"><small>Open orders</small><b>${num(stats.ordersOpen)}</b><span>${num(stats.ordersPendingPayment)} awaiting payment</span></div>
      <div class="stat-card"><small>Customers</small><b>${num(stats.customers)}</b></div>
      <div class="stat-card"><small>New leads</small><b>${num(stats.leadsNew)}</b></div>
      <div class="stat-card"><small>Products with a price</small><b>${stats.productsPriced} / ${stats.productsTotal}</b><span>Set prices in Products</span></div>
      <div class="stat-card"><small>Coupon balances outstanding</small><b>${ghs(stats.couponsActiveBalance)}</b></div>
      <div class="stat-card"><small>Ogya wallet liability</small><b>${ogy(stats.walletLiability)}</b><span>≈ ${ghs(stats.walletLiability)}</span></div>
    </div>
    ${stats.lowStock.length ? `<div class="panel"><h3>Low stock</h3>${stats.lowStock.map((p) => `<div class="list-row"><span>${esc(p.name)}</span><b>${p.stock} left</b></div>`).join('')}</div><br>` : ''}
    <div class="toolbar"><h2>Recent orders</h2></div>
    ${ordersTable(recent.slice(0, 10))}`;
  bindOrderActions();
}

/* ---------------- Orders ---------------- */
function ordersTable(list) {
  if (!list.length) return '<p class="muted">No orders yet.</p>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr>
    <th>Order</th><th>Placed</th><th>Customer</th><th>Deliver to</th><th>Items</th><th class="num">Total</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    ${list.map((o) => `<tr>
      <td><b>${esc(o.ref)}</b>${o.ageRestricted ? '<br><span class="status cancelled" title="Contains alcohol">18+ ID check</span>' : ''}</td>
      <td>${formatDate(o.createdAt)}</td>
      <td>${esc(o.customerName)}<br><small class="muted">${esc(o.phone)}</small></td>
      <td>${esc(o.town)}, ${esc(o.region)}<br><small class="muted">${esc(o.deliverySlot)}</small></td>
      <td>${o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join('<br>')}</td>
      <td class="num">${ghs(o.total)}</td>
      <td>${esc(titleCase(o.paymentMethod))}<br><small class="${o.paid ? 'good' : 'muted'}">${o.paid ? 'Paid' : 'Unpaid'}</small>${o.payment?.refundStatus ? `<br><small class="${o.payment.refundStatus === 'failed' ? 'up' : 'muted'}">Refund ${esc(o.payment.refundStatus)}</small>` : ''}</td>
      <td>${statusChip(o.status)}</td>
      <td><div class="row-actions">
        ${TRANSITIONS[o.status].map((s) => `<button type="button" class="btn btn-sm ${s === 'cancelled' ? 'btn-outline' : ''}" data-order="${esc(o.ref)}" data-status="${s}">${esc(titleCase(s))}</button>`).join('')}
        <button type="button" class="btn btn-sm btn-outline" data-detail="${esc(o.ref)}">Details</button>
      </div></td></tr>`).join('')}
    </tbody></table></div>`;
}
let lastOrders = [];
function bindOrderActions() {
  view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const s = b.dataset.status;
    if (s === 'cancelled' && !confirmAction(`Cancel order ${b.dataset.order}? Stock, coupon balance and Ogya payments will be returned.`)) return;
    setLoading(b, true);
    try {
      await api(`/api/admin/orders/${encodeURIComponent(b.dataset.order)}`, { method: 'PATCH', body: { status: s } });
      toast(`${b.dataset.order} → ${titleCase(s)}`, { type: 'success' });
      show(ctx.view);
    } catch (e) { toastError(e); setLoading(b, false); }
  }));
  view.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', async () => {
    const o = lastOrders.find((x) => x.ref === b.dataset.detail) || (await api(`/api/admin/orders?q=${encodeURIComponent(b.dataset.detail)}`)).orders[0];
    if (!o) return;
    modal(`Order ${o.ref}`, `<div class="detail-list">
      <div><span>Status</span><span>${statusChip(o.status)}</span></div>
      <div><span>Customer</span><span>${esc(o.customerName)}</span></div>
      <div><span>Phone</span><span><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></span></div>
      ${o.email ? `<div><span>Email</span><span>${esc(o.email)}</span></div>` : ''}
      <div><span>Address</span><span>${esc(o.address)}, ${esc(o.town)}, ${esc(o.region)}</span></div>
      <div><span>Delivery slot</span><span>${esc(o.deliverySlot)}</span></div>
      ${o.ageRestricted ? '<div><span>Alcohol</span><span><b>Receiver must be 18+: check Ghana Card, passport or driver\'s licence before handing over. Do not deliver to anyone under 18 or visibly intoxicated.</b></span></div>' : ''}
      ${o.notes ? `<div><span>Notes</span><span>${esc(o.notes)}</span></div>` : ''}
      ${o.items.map((i) => `<div><span>${i.qty} × ${esc(i.name)} (${esc(i.unitLabel)})</span><span>${ghs(i.lineTotal)}</span></div>`).join('')}
      <div><span>Subtotal</span><span>${ghs(o.subtotal)}</span></div>
      <div><span>Delivery</span><span>${ghs(o.deliveryFee)}</span></div>
      ${o.discount ? `<div><span>Ogya discount</span><span>−${ghs(o.discount)}</span></div>` : ''}
      ${o.couponAmount ? `<div><span>Coupon ${esc(o.couponCode)}</span><span>−${ghs(o.couponAmount)}</span></div>` : ''}
      <div><span>Total</span><span><b>${ghs(o.total)}</b></span></div>
      <div><span>Payment</span><span>${esc(titleCase(o.paymentMethod))} · ${o.paid ? 'Paid' : 'Unpaid'}</span></div>
      ${o.payment ? `<div><span>Paystack ref</span><span>${esc(o.payment.reference)} · ${esc(o.payment.status)}${o.payment.channel ? ' · ' + esc(o.payment.channel) : ''}</span></div>` : ''}
      ${o.payment?.refundStatus ? `<div><span>Refund</span><span>${esc(titleCase(o.payment.refundStatus))} · ${ghs(o.payment.refundAmount)}${o.payment.refundError ? ' — ' + esc(o.payment.refundError) : ''}</span></div>` : ''}
      <div><span>Terms version</span><span>${esc(o.termsVersion || '—')}</span></div></div>
      ${o.status === 'cancelled' && o.paid && ['momo', 'card'].includes(o.paymentMethod) && (!o.payment?.refundStatus || o.payment.refundStatus === 'failed') ? `<br><button class="btn btn-block" type="button" id="retryRefund">Refund ${ghs(o.total)} to customer</button>` : ''}`);
    $('#retryRefund')?.addEventListener('click', async (ev) => {
      setLoading(ev.currentTarget, true);
      try { const { refund } = await api(`/api/admin/orders/${encodeURIComponent(o.ref)}/refund`, { method: 'POST' }); toast(`Refund ${refund.status}`, { type: refund.status === 'failed' ? 'error' : 'success' }); closeLayer(); show(ctx.view); }
      catch (err) { toastError(err); setLoading(ev.currentTarget, false); }
    });
  }));
}
function confirmAction(msg) { return window.confirm(msg); }

async function orders() {
  view.innerHTML = `<div class="toolbar"><h2>Orders</h2>
    <div class="form-group"><label for="oStatus">Status</label><select id="oStatus"><option value="">All</option>${Object.keys(TRANSITIONS).map((s) => `<option value="${s}">${titleCase(s)}</option>`).join('')}</select></div>
    <div class="form-group"><label for="oQ">Search</label><input id="oQ" placeholder="Ref, phone or name" maxlength="40"></div>
    <button class="btn btn-outline" type="button" id="oRefresh">${icon('refresh')} Refresh</button></div><div id="oList"></div>`;
  const load = async () => {
    const qs = new URLSearchParams();
    if ($('#oStatus').value) qs.set('status', $('#oStatus').value);
    if ($('#oQ').value.trim()) qs.set('q', $('#oQ').value.trim());
    lastOrders = (await api(`/api/admin/orders?${qs}`)).orders;
    $('#oList').innerHTML = ordersTable(lastOrders);
    bindOrderActions();
  };
  $('#oStatus').addEventListener('change', load);
  let t; $('#oQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  $('#oRefresh').addEventListener('click', load);
  await load();
}

/* ---------------- Products ---------------- */
async function products() {
  const { products: list, categories } = await api('/api/admin/products');
  ctx.categories = categories;
  view.innerHTML = `<div class="toolbar"><h2>Products & Prices</h2>
    <div class="form-group"><label for="pCat">Category</label><select id="pCat"><option value="">All</option>${categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="form-group"><label for="pQ">Search (name, maker, country)</label><input id="pQ" maxlength="40"></div></div>
    <p class="muted small">Tick Halal only for products from a certified halal supplier (pork and alcohol are refused). Leave price empty for "price on request". Leave stock empty for unlimited. Prices are in GH₵ (stored in pesewas; 1 GH₵ = 100 OGY).</p><br>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Product</th><th>Category</th><th>Price (GH₵)</th><th>Sold per</th><th>Stock</th><th>Active</th><th>Featured</th><th>18+</th><th title="Certified halal. Not allowed for pork or alcohol">Halal</th><th></th></tr></thead><tbody id="pBody"></tbody></table></div>`;
  const body = $('#pBody');
  const draw = () => {
    const cat = Number($('#pCat').value) || null;
    const q = $('#pQ').value.trim().toLowerCase();
    body.innerHTML = list.filter((p) => (!cat || p.categoryId === cat) && (!q || `${p.name} ${p.brand?.name || ''} ${p.brand?.country || ''}`.toLowerCase().includes(q))).map((p) => `
      <tr data-id="${p.id}">
        <td>${p.emoji} <b>${esc(p.name)}</b>${p.localName ? `<br><small class="muted">${esc(p.localName)}</small>` : ''}${p.brand ? `<br><small class="muted">${esc(p.brand.name)} · ${esc(p.brand.country)}</small>` : ''}${p.verifyAbv ? '<br><small class="up" title="Alcohol content not confirmed. Check the label, then tick or untick 18+ and save.">⚠ Check label: alcohol content</small>' : ''}${!p.active ? '<br><small class="muted">Hidden from shop</small>' : ''}</td>
        <td><small>${esc(p.categoryName)}</small></td>
        <td><input class="w-sm" name="price" inputmode="decimal" value="${p.price ? (p.price / 100).toFixed(2) : ''}" aria-label="Price for ${esc(p.name)}"></td>
        <td><input name="priceUnitLabel" maxlength="60" value="${esc(p.priceUnit && p.price ? p.priceUnit : p.defaultUnit?.name || '')}" aria-label="Unit"></td>
        <td><input class="w-sm" name="stock" inputmode="numeric" value="${p.stock ?? ''}" placeholder="∞" aria-label="Stock"></td>
        <td><input type="checkbox" name="active" ${p.active ? 'checked' : ''} aria-label="Active"></td>
        <td><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''} aria-label="Featured"></td>
        <td><input type="checkbox" name="ageRestricted" ${p.ageRestricted ? 'checked' : ''} aria-label="Alcohol, 18+ only"></td>
        <td><input type="checkbox" name="halal" ${p.halal ? 'checked' : ''} aria-label="Halal certified"></td>
        <td><button class="btn btn-sm" type="button" data-save="${p.id}">Save</button></td>
      </tr>`).join('');
  };
  $('#pCat').addEventListener('change', draw);
  $('#pQ').addEventListener('input', draw);
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-save]');
    if (!b) return;
    const row = b.closest('tr');
    const get = (n) => row.querySelector(`[name="${n}"]`);
    const priceVal = get('price').value.trim();
    const stockVal = get('stock').value.trim();
    const patch = {
      price: priceVal === '' ? null : ghsToPesewas(priceVal),
      priceUnitLabel: get('priceUnitLabel').value.trim() || null,
      stock: stockVal === '' ? null : Number(stockVal),
      active: get('active').checked,
      featured: get('featured').checked,
      ageRestricted: get('ageRestricted').checked,
      halal: get('halal').checked
    };
    if (patch.price !== null && !(patch.price > 0)) { toast('Price must be a positive amount', { type: 'error' }); return; }
    if (patch.stock !== null && !(Number.isInteger(patch.stock) && patch.stock >= 0)) { toast('Stock must be a whole number', { type: 'error' }); return; }
    setLoading(b, true);
    try {
      const { product } = await api(`/api/admin/products/${b.dataset.save}`, { method: 'PATCH', body: patch });
      Object.assign(list.find((p) => p.id === product.id), product);
      toast(`${product.name} saved`, { type: 'success' });
    } catch (err) { toastError(err); } finally { setLoading(b, false); }
  });
  draw();
}

/* ---------------- Coupons ---------------- */
async function coupons() {
  const { coupons: list } = await api('/api/admin/coupons');
  view.innerHTML = `<div class="toolbar"><h2>Coupons</h2></div>
    <div class="panel"><h3>Issue a coupon</h3><p>For school feeding, relief programmes, staff rewards or customer service. The receiver gets the code by SMS.</p>
      <form class="stack" id="issueForm" novalidate>
        <div class="form-row">
          <div class="form-group"><label for="iAmt">Amount (GH₵)</label><input id="iAmt" required inputmode="decimal" placeholder="100"></div>
          <div class="form-group"><label for="iName">Receiver</label><input id="iName" name="recipientName" required maxlength="80"></div>
          <div class="form-group"><label for="iPhone">Phone</label><input id="iPhone" name="recipientPhone" type="tel" required maxlength="16"></div>
        </div>
        <div class="form-group"><label for="iMsg">Message <span class="opt">(optional)</span></label><input id="iMsg" name="message" maxlength="140"></div>
        <div class="form-error" role="alert" hidden></div>
        <button class="btn" type="submit">${icon('ticket')} Issue coupon</button>
      </form><div id="issued"></div></div><br>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Status</th><th>Receiver</th><th class="num">Balance</th><th class="num">Initial</th><th>Source</th><th>Created</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr><td><b>${esc(c.code)}</b></td><td>${statusChip(c.status)}</td><td>${esc(c.recipientName)}<br><small class="muted">${esc(c.recipientPhone)}</small></td>
      <td class="num">${ghs(c.balance)}</td><td class="num">${ghs(c.initial)}</td><td>${esc(c.source)}</td><td>${formatDate(c.createdAt)}</td>
      <td>${c.status === 'active' ? `<button class="btn btn-sm btn-outline" type="button" data-void="${esc(c.code)}">Void</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No coupons yet.</td></tr>'}
    </tbody></table></div>`;
  $('#issueForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (!checkForm(f)) return;
    const amount = ghsToPesewas($('#iAmt').value);
    if (!(amount >= 100)) { showErrors(f, { message: 'Amount must be at least GH₵1' }); return; }
    const btn = $('button[type=submit]', f);
    setLoading(btn, true);
    try {
      const { coupon } = await api('/api/admin/coupons', { method: 'POST', body: { ...formData(f), amount } });
      toast(`Coupon ${coupon.code} issued`, { type: 'success' });
      await coupons();
      $('#issued').innerHTML = `<div class="coupon-code">${esc(coupon.code)}</div>`;
    } catch (err) { showErrors(f, err); } finally { setLoading(btn, false); }
  });
  view.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmAction(`Void coupon ${b.dataset.void}? Its remaining balance can no longer be used.`)) return;
    try { await api(`/api/admin/coupons/${encodeURIComponent(b.dataset.void)}/void`, { method: 'POST' }); toast('Coupon voided'); coupons(); } catch (e) { toastError(e); }
  }));
}

/* ---------------- Farmers ---------------- */
async function farmers() {
  const [{ farmers: list }, { categories }] = await Promise.all([api('/api/admin/farmers'), api('/api/categories')]);
  ctx.categories = categories;
  view.innerHTML = `<div class="toolbar"><h2>Farmers</h2><button class="btn" type="button" id="addFarmer">${icon('plus')} Add farmer</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Enterprise</th><th>Location</th><th>Focus</th><th>Verified</th><th>Notes</th><th></th></tr></thead><tbody>
    ${list.map((f) => `<tr><td><b>${esc(f.name)}</b></td><td>${esc(f.enterprise || '—')}</td><td>${esc([f.location, f.region].filter(Boolean).join(' · ') || '—')}</td>
      <td><small>${f.focusCategories.map(esc).join(', ')}</small></td><td>${f.verified ? '<span class="good">Yes</span>' : '<span class="muted">Pending</span>'}</td>
      <td><div class="pre">${esc(f.notes)}</div></td>
      <td><div class="row-actions"><button class="btn btn-sm btn-outline" type="button" data-edit="${f.id}">Edit</button><button class="btn btn-sm btn-outline" type="button" data-del="${f.id}">Delete</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#addFarmer').addEventListener('click', () => farmerForm(null));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => farmerForm(list.find((f) => f.id === Number(b.dataset.edit)))));
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmAction('Delete this farmer from the directory?')) return;
    try { await api(`/api/admin/farmers/${b.dataset.del}`, { method: 'DELETE' }); toast('Farmer deleted'); farmers(); } catch (e) { toastError(e); }
  }));
}
function farmerForm(f) {
  const regions = ctx.config.regions;
  const body = modal(f ? 'Edit farmer' : 'Add farmer', `<form class="stack" id="farmerForm" novalidate>
    <div class="form-row"><div class="form-group"><label for="ffName">Name</label><input id="ffName" name="name" required maxlength="120" value="${esc(f?.name || '')}"></div>
    <div class="form-group"><label for="ffEnt">Enterprise</label><input id="ffEnt" name="enterprise" maxlength="120" value="${esc(f?.enterprise || '')}"></div></div>
    <div class="form-row"><div class="form-group"><label for="ffLoc">Location</label><input id="ffLoc" name="location" maxlength="200" value="${esc(f?.location || '')}"></div>
    <div class="form-group"><label for="ffReg">Region</label><select id="ffReg" name="region"><option value="">Unknown</option>${regions.map((r) => `<option ${f?.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></div></div>
    <div class="form-group"><label>Focus categories</label><div class="check-row">${ctx.categories.map((c) => `<label><input type="checkbox" value="${c.id}" class="ffCat" ${f?.focusCategoryIds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></div>
    <div class="form-group"><label for="ffNotes">Notes</label><textarea id="ffNotes" name="notes" maxlength="500" rows="3">${esc(f?.notes || '')}</textarea></div>
    <div class="check-row"><label><input type="checkbox" id="ffVer" ${f?.verified ? 'checked' : ''}> Verified partner</label></div>
    <div class="form-error" role="alert" hidden></div>
    <button class="btn btn-block" type="submit">Save</button></form>`);
  body.querySelector('#farmerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!checkForm(form)) return;
    const d = formData(form);
    const payload = { name: d.name, enterprise: d.enterprise || null, location: d.location || null, region: d.region || null, notes: d.notes || null,
      focusCategoryIds: $$('.ffCat:checked', form).map((x) => Number(x.value)), verified: $('#ffVer').checked };
    const btn = $('button[type=submit]', form);
    setLoading(btn, true);
    try {
      await api(f ? `/api/admin/farmers/${f.id}` : '/api/admin/farmers', { method: f ? 'PATCH' : 'POST', body: payload });
      closeLayer();
      toast('Farmer saved', { type: 'success' });
      farmers();
    } catch (err) { showErrors(form, err); } finally { setLoading(btn, false); }
  });
}

/* ---------------- Leads ---------------- */
async function leads() {
  view.innerHTML = `<div class="toolbar"><h2>Leads & requests</h2>
    <div class="form-group"><label for="lType">Type</label><select id="lType"><option value="">All</option>${['business', 'school', 'farmer', 'quote', 'newsletter', 'contact'].map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}</select></div></div><div id="lList"></div>`;
  const load = async () => {
    const { leads: list } = await api(`/api/admin/leads${$('#lType').value ? `?type=${$('#lType').value}` : ''}`);
    $('#lList').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Received</th><th>Type</th><th>Name</th><th>Contact</th><th>Region</th><th>Details</th><th>Status</th></tr></thead><tbody>
      ${list.map((l) => `<tr><td>${formatDate(l.createdAt)}</td><td>${esc(titleCase(l.type))}</td><td>${esc(l.name || '—')}</td>
        <td>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ''}${l.email ? `<br>${esc(l.email)}` : ''}</td><td>${esc(l.region || '—')}</td>
        <td><div class="pre">${esc(Object.entries(l.details).map(([k, v]) => `${titleCase(k.replace(/([A-Z])/g, ' $1'))}: ${v}`).join('\n'))}</div></td>
        <td><select data-lead="${l.id}" aria-label="Lead status">${['new', 'contacted', 'closed'].map((s) => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No leads yet.</td></tr>'}
      </tbody></table></div>`;
    $$('[data-lead]', view).forEach((s) => s.addEventListener('change', async () => {
      try { await api(`/api/admin/leads/${s.dataset.lead}`, { method: 'PATCH', body: { status: s.value } }); toast('Lead updated', { type: 'success' }); } catch (e) { toastError(e); }
    }));
  };
  $('#lType').addEventListener('change', load);
  await load();
}

/* ---------------- Users ---------------- */
async function users() {
  const { users: list } = await api('/api/admin/users');
  view.innerHTML = `<div class="toolbar"><h2>Customers</h2></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Type</th><th>Role</th><th class="num">Ogya</th><th>Joined</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || '—')}</td><td>${esc(titleCase(u.accountType))}</td><td>${esc(u.role)}</td>
      <td class="num">${ogy(u.ogyBalance)}</td><td>${formatDate(u.createdAt, false)}</td>
      <td><button class="btn btn-sm btn-outline" type="button" data-credit="${u.id}" data-name="${esc(u.name)}">Credit Ogya</button></td></tr>`).join('')}
    </tbody></table></div>`;
  view.querySelectorAll('[data-credit]').forEach((b) => b.addEventListener('click', () => {
    const body = modal(`Credit Ogya · ${b.dataset.name}`, `<form class="stack" id="creditForm" novalidate>
      <p class="muted small">Use for cash top-ups at a hub, refunds or goodwill. Every credit is recorded in the audit log.</p>
      <div class="form-group"><label for="crAmt">Amount (GH₵)</label><input id="crAmt" required inputmode="decimal"><span class="hint" id="crHint"></span></div>
      <div class="form-group"><label for="crNote">Reason</label><input id="crNote" name="note" required minlength="3" maxlength="120" placeholder="e.g. Cash top-up at Kumasi hub, receipt #123"></div>
      <div class="form-error" role="alert" hidden></div>
      <button class="btn btn-ogya btn-block" type="submit">Credit wallet</button></form>`);
    body.querySelector('#crAmt').addEventListener('input', (e) => { const v = ghsToPesewas(e.target.value); $('#crHint').textContent = v > 0 ? `= ${ogy(v)}` : ''; });
    body.querySelector('#creditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (!checkForm(form)) return;
      const amount = ghsToPesewas($('#crAmt').value);
      if (!(amount >= 1)) { showErrors(form, { message: 'Enter a positive amount' }); return; }
      const btn = $('button[type=submit]', form);
      setLoading(btn, true);
      try {
        await api(`/api/admin/users/${b.dataset.credit}/credit`, { method: 'POST', body: { amount, note: $('#crNote').value.trim() } });
        closeLayer();
        toast('Wallet credited', { type: 'success' });
        users();
      } catch (err) { showErrors(form, err); } finally { setLoading(btn, false); }
    });
  }));
}

/* ---------------- SMS ---------------- */
async function sms() {
  const { messages } = await api('/api/admin/sms');
  view.innerHTML = `<div class="toolbar"><h2>SMS (Sailup)</h2><span class="muted small">Mode: ${esc(ctx.config.smsMode)} · sign-in codes are never stored</span></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Sent</th><th>To</th><th>Purpose</th><th>Message</th><th>Status</th></tr></thead><tbody>
    ${messages.map((m) => `<tr><td>${formatDate(m.createdAt)}</td><td>${esc(m.to)}</td><td>${esc(titleCase(m.purpose))}</td><td><div class="pre">${esc(m.body)}</div></td>
      <td><span class="status ${m.status === 'failed' || m.status === 'rejected' ? 'cancelled' : m.status === 'delivered' ? 'delivered' : 'confirmed'}">${esc(m.status)}</span>${m.error ? `<br><small class="up">${esc(m.error)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No messages yet.</td></tr>'}
    </tbody></table></div>`;
}

/* ---------------- Audit ---------------- */
async function audit() {
  const { entries } = await api('/api/admin/audit');
  view.innerHTML = `<div class="toolbar"><h2>Audit log</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead><tbody>
    ${entries.map((a) => `<tr><td>${formatDate(a.createdAt)}</td><td>${esc(a.user || '—')}</td><td>${esc(a.action)}</td><td><div class="pre">${esc(a.detail)}</div></td><td>${esc(a.ip || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

boot();
