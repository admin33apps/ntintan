/* Shared browser helpers: API client (CSRF-aware), formatting, toasts, forms, dialogs. */

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="/img/icons.svg#${name}"/></svg>`;

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};

/* ---------- Money ---------- */
const nf2 = new Intl.NumberFormat('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-GH', { maximumFractionDigits: 0 });
export const ghs = (pesewas) => 'GH₵' + nf2.format((pesewas || 0) / 100);
export const ogy = (amount) => nf0.format(amount || 0) + ' OGY'; // 1 OGY = 1 pesewa
export const num = (n) => nf0.format(n || 0);

export function formatDate(sqlUtc, withTime = true) {
  if (!sqlUtc) return '';
  const d = new Date(String(sqlUtc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return sqlUtc;
  return d.toLocaleString('en-GH', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ---------- API client ---------- */
export class ApiError extends Error {
  constructor(message, status, code, fields) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

let csrfToken = null;
export async function loadSession() {
  const res = await fetch('/api/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const data = await res.json();
  csrfToken = data.csrfToken;
  return data.user;
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('You appear to be offline. Check your connection and try again.', 0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.ok) return data;
  const err = data?.error || {};
  if (res.status === 403 && err.code === 'csrf' && retry) {
    await loadSession();
    return api(path, { method, body, retry: false });
  }
  throw new ApiError(err.message || `Request failed (${res.status})`, res.status, err.code, err.fields);
}

/* ---------- Toasts ---------- */
export function toast(message, { type = 'info', action, onAction, duration = 3500 } = {}) {
  const stack = $('#toasts');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  t.innerHTML = `${icon(iconName)}<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  if (action) t.querySelector('button').addEventListener('click', () => { onAction?.(); dismiss(); });
  stack.appendChild(t);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(dismiss, duration);
}
export const toastError = (e) => toast(e?.message || 'Something went wrong. Please try again.', { type: 'error', duration: 5000 });

/* ---------- Forms ---------- */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button') continue;
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.dataset.int !== undefined) v = v === '' ? '' : Number(v);
    if (v === '' && !el.required) continue;
    out[el.name] = v;
  }
  return out;
}

export function clearErrors(form) {
  $$('[aria-invalid="true"]', form).forEach((el) => el.removeAttribute('aria-invalid'));
  $$('.field-error', form).forEach((el) => el.remove());
  form.querySelectorAll?.('label.check + .field-error').forEach((el) => el.remove());
  const box = $('.form-error', form);
  if (box) { box.hidden = true; box.textContent = ''; }
}

export function showErrors(form, err) {
  clearErrors(form);
  let placed = false;
  if (err?.fields) {
    for (const [name, msg] of Object.entries(err.fields)) {
      const el = form.elements.namedItem(name);
      if (!el || !el.closest) continue;
      el.setAttribute('aria-invalid', 'true');
      const note = document.createElement('span');
      note.className = 'field-error';
      note.textContent = msg.charAt(0).toUpperCase() + msg.slice(1);
      placeNote(el, note);
      if (!placed) el.focus();
      placed = true;
    }
  }
  const box = $('.form-error', form);
  if (box) { box.textContent = err?.message || 'Please check the form.'; box.hidden = false; }
  else if (!placed) toastError(err);
}

function placeNote(el, note) {
  const group = el.closest('.form-group');
  if (group) group.appendChild(note);
  else el.closest('label')?.after(note);
}

/** Client-side check using native constraints; returns true when valid. */
export function checkForm(form) {
  clearErrors(form);
  for (const el of form.elements) {
    if (!el.willValidate || el.checkValidity()) continue;
    el.setAttribute('aria-invalid', 'true');
    const note = document.createElement('span');
    note.className = 'field-error';
    note.textContent = el.validity.valueMissing ? (el.type === 'checkbox' ? 'Please tick this box to continue' : 'This field is required') : el.validationMessage;
    placeNote(el, note);
    el.focus();
    return false;
  }
  return true;
}

export function setLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

/* ---------- Dialogs (modal + drawer) with focus management ---------- */
let lastFocus = null;
let openLayer = null;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openLayerEl(el, { drawer = false } = {}) {
  closeLayer(false);
  lastFocus = document.activeElement;
  openLayer = el;
  if (drawer) {
    $('#overlay').hidden = false;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  } else {
    el.hidden = false;
  }
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => {
    const target = $('[autofocus]', el) || $$(FOCUSABLE, el).find((x) => !x.classList.contains('icon-close') && x.offsetParent !== null) || el;
    target.focus({ preventScroll: true });
  });
}

export function closeLayer(restore = true) {
  if (!openLayer) return;
  const el = openLayer;
  openLayer = null;
  if (el.classList.contains('drawer')) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    $('#overlay').hidden = true;
  } else {
    el.hidden = true;
  }
  document.body.classList.remove('no-scroll');
  if (restore && lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

export const currentLayer = () => openLayer;

document.addEventListener('keydown', (e) => {
  if (!openLayer) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLayer(); return; }
  if (e.key !== 'Tab') return;
  const items = $$(FOCUSABLE, openLayer).filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.getAttribute?.('aria-invalid') !== 'true') return;
  el.removeAttribute('aria-invalid');
  el.closest('.form-group')?.querySelectorAll('.field-error').forEach((n) => n.remove());
  const lbl = el.closest('label.check');
  if (lbl?.nextElementSibling?.classList.contains('field-error')) lbl.nextElementSibling.remove();
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if ((el.tagName === 'SELECT' || el.type === 'checkbox') && el.getAttribute('aria-invalid') === 'true') {
    const lbl = el.closest('label.check');
    if (lbl?.nextElementSibling?.classList.contains('field-error')) lbl.nextElementSibling.remove();
    el.removeAttribute('aria-invalid');
    el.closest('.form-group')?.querySelectorAll('.field-error').forEach((n) => n.remove());
  }
});

/** Only allow redirects to our own origin or Paystack's hosted checkout. */
export function safeRedirect(url) {
  try {
    const u = new URL(url, location.href);
    const ok = u.origin === location.origin || (u.protocol === 'https:' && /(^|\.)paystack\.com$/.test(u.hostname));
    if (!ok) throw new Error('blocked');
    location.assign(u.href);
  } catch {
    toast('Payment page could not be opened. Please try again.', { type: 'error' });
  }
}
