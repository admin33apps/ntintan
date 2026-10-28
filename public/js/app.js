import {
  $, $$, esc, icon, store, ghs, ogy, num, formatDate, titleCase, api, loadSession,
  toast, toastError, formData, checkForm, showErrors, clearErrors, setLoading,
  openLayerEl, closeLayer, currentLayer, safeRedirect
} from './lib.js';

/* =====================================================================
   State
   ===================================================================== */
const S = {
  config: null,
  user: null,
  categories: [],
  products: [],
  units: [],
  market: [],
  history: [],
  farmers: [],
  filter: 'all',
  query: '',
  sort: 'featured',
  pageSize: 16,
  shown: 16,
  currency: store.get('ntn_cur', 'GHS') === 'OGY' ? 'OGY' : 'GHS',
  cart: sanitizeCart(store.get('ntn_cart', {})),
  wish: new Set(store.get('ntn_wish', [])),
  payMethod: 'cash',
  couponCode: null,
  voucherAmount: 10000,
  quoteSeq: 0,
  ageOk: (() => { const a = store.get('ntn_age_ok', null); return Boolean(a && Date.now() - a < 30 * 86400e3); })(),
  drinkSub: 'wine',
  drinkCountry: '',
  drinkMaker: '',
  drinkShown: 12,
  halalShown: 8,
  brands: []
};
const flag = (code) => (/^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
const flags = (codes) => (codes || []).map(flag).join(' ');
const COUNTRY_NAMES = { GH: 'Ghana', EG: 'Egypt', ZA: 'South Africa', CM: 'Cameroon', RW: 'Rwanda', KE: 'Kenya', UG: 'Uganda', MA: 'Morocco', NA: 'Namibia', NG: 'Nigeria', MU: 'Mauritius', TN: 'Tunisia', SC: 'Seychelles', TZ: 'Tanzania', CI: "Côte d'Ivoire" };
const ALCOHOL_WARNING = "Drink responsibly · Not for sale to persons under 18 · Not recommended for pregnant or breastfeeding women · Don't drink and drive";

function sanitizeCart(c) {
  const out = {};
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    for (const [k, v] of Object.entries(c)) {
      const id = Number(k), q = Number(v);
      if (Number.isInteger(id) && id > 0 && Number.isInteger(q) && q > 0 && q <= 999) out[id] = q;
    }
  }
  return out;
}

const byId = (id) => S.products.find((p) => p.id === Number(id));
const price = (p) => (S.currency === 'OGY' ? ogy(p) : ghs(p));
const altPrice = (p) => (S.currency === 'OGY' ? ghs(p) : ogy(p));

/* =====================================================================
   Theme
   ===================================================================== */
const darkToggle = $('#darkToggle');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  darkToggle.checked = t === 'dark';
}
applyTheme(store.get('ntn_theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
darkToggle.addEventListener('change', () => {
  const t = darkToggle.checked ? 'dark' : 'light';
  applyTheme(t);
  store.set('ntn_theme', t);
});
$('#year').textContent = new Date().getFullYear();

/* =====================================================================
   Boot
   ===================================================================== */
async function boot() {
  try {
    S.user = await loadSession();
    const [config, cats, prods, market, farmers, units, brands] = await Promise.all([
      api('/api/config'), api('/api/categories'), api('/api/products'), api('/api/market-prices'), api('/api/farmers'), api('/api/units'), api('/api/brands')
    ]);
    S.brands = brands.brands;
    S.config = config;
    S.categories = cats.categories;
    S.products = prods.products;
    S.market = market.marketPrices;
    S.history = market.priceHistory;
    S.farmers = farmers.farmers;
    S.units = units.units;
  } catch (e) {
    $('#productGrid').innerHTML = `<div class="empty-state">${icon('alert')}<p>We couldn't load the market right now.</p><button class="btn btn-outline" type="button" id="retryBoot">Try again</button></div>`;
    $('#retryBoot')?.addEventListener('click', () => location.reload());
    toastError(e);
    return;
  }
  pruneCart();
  fillStaticSelects();
  renderCurrencyToggle();
  renderNavCategories();
  renderCategoryGrid();
  renderTabs();
  renderProducts();
  renderMarket();
  renderMakerSelects();
  renderHalal();
  renderDrinks();
  renderMakers();
  renderFarmers();
  renderMeasures();
  renderVouchers();
  renderCouponMethods();
  showPartner('business');
  renderNotifications();
  renderUser();
  renderCart();
  handlePaymentReturn();
  handleDeepLink();
}

function fillStaticSelects() {
  const regionOpts = '<option value="">Select region</option>' + S.config.regions.map((r) => `<option>${esc(r)}</option>`).join('');
  $$('.region-select').forEach((s) => { s.innerHTML = regionOpts; });
  $('#coSlot').innerHTML = S.config.deliverySlots.map((s) => `<option>${esc(s)}</option>`).join('');
  $('#announce').textContent = S.config.demo
    ? 'Preview / demo site · No real orders, payments or SMS · Sign-in codes appear on screen · Use “Approve payment” to test checkout'
    : `Farm-to-door delivery across all 16 regions · Free delivery over ${ghs(S.config.freeDeliveryThreshold)} · 100 OGY = GH₵1`;
  $('#announce').classList.toggle('demo', Boolean(S.config.demo));
}

function pruneCart() {
  let removed = 0;
  for (const id of Object.keys(S.cart)) {
    const p = byId(id);
    if (!p || !p.purchasable) { delete S.cart[id]; removed++; }
  }
  if (removed) { saveCart(); toast(`${removed} item(s) in your bag are no longer available and were removed.`); }
}

/* =====================================================================
   Currency toggle
   ===================================================================== */
function renderCurrencyToggle() {
  $$('.currency-toggle button').forEach((b) => {
    const on = b.dataset.currency === S.currency;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
$$('.currency-toggle button').forEach((b) => b.addEventListener('click', () => {
  S.currency = b.dataset.currency;
  store.set('ntn_cur', S.currency);
  renderCurrencyToggle();
  renderProductGrids();
  renderCart();
  renderMarket();
  renderVouchers();
  if (!$('#checkoutModal').hidden) refreshQuote();
}));

/* =====================================================================
   Navigation
   ===================================================================== */
const nav = $('#mainNav');
const menuBtn = $('#menuBtn');
const isMobile = () => matchMedia('(max-width: 992px)').matches;
function setMenu(open) {
  nav.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.innerHTML = icon(open ? 'x' : 'menu');
}
menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
$$('.nav-item.has-dropdown > .nav-link').forEach((btn) => btn.addEventListener('click', () => {
  const item = btn.parentElement;
  if (!isMobile()) return;
  const open = !item.classList.contains('open');
  item.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
}));

function renderNavCategories() {
  $('#navCategories').innerHTML = `<a href="#products" class="dropdown-item" data-filter="all">All products <small>${S.products.length}</small></a>` +
    S.categories.map((c) => `<a href="#products" class="dropdown-item" data-filter="cat-${c.id}">${esc(c.name)} <small>${c.productCount}</small></a>`).join('');
}

/* Global delegated actions */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-filter], [data-partner], [data-open], [data-drinks], [data-add], [data-inc], [data-dec], [data-remove], [data-wish], [data-qv], [data-quote], [data-close]');
  if (!el) return;
  const d = el.dataset;
  if (d.close !== undefined) { closeLayer(); if (!d.filter && !d.partner && !d.open) return; }
  if (d.add) { changeQty(Number(d.add), 1, true); return; }
  if (d.inc) { changeQty(Number(d.inc), 1); return; }
  if (d.dec) { changeQty(Number(d.dec), -1); return; }
  if (d.remove) { removeItem(Number(d.remove)); return; }
  if (d.wish) { e.stopPropagation(); toggleWish(Number(d.wish), el); return; }
  if (d.qv) { openQuickView(Number(d.qv)); return; }
  if (d.quote) { openQuote(Number(d.quote)); return; }
  e.preventDefault();
  setMenu(false);
  if (d.filter) { setFilter(d.filter); scrollToEl('#products'); }
  if (d.partner) { showPartner(d.partner); scrollToEl('#partners'); }
  if (d.drinks) showDrinks(d.drinks);
  if (d.open === 'wallet') openAccount('wallet');
  if (d.open === 'track') openLayerEl($('#trackModal'));
  if (d.open === 'chat') openChat();
});
$$('.main-nav a[href^="#"]:not([data-filter]):not([data-partner]), .notif-more').forEach((a) => a.addEventListener('click', () => {
  setMenu(false);
  closeNotif();
}));

function scrollToEl(sel) {
  const el = $(sel);
  if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

$('#logo').addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

/* =====================================================================
   Hero slider
   ===================================================================== */
(function hero() {
  const slides = $$('.hero-slide');
  const dots = $$('.hero-control');
  let i = 0;
  let timer;
  const show = (n) => {
    i = (n + slides.length) % slides.length;
    slides.forEach((s, k) => { s.classList.toggle('active', k === i); s.setAttribute('aria-hidden', String(k !== i)); });
    dots.forEach((d, k) => { d.classList.toggle('active', k === i); d.setAttribute('aria-current', String(k === i)); });
  };
  const start = () => {
    clearInterval(timer);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => show(i + 1), 6500);
  };
  dots.forEach((d, k) => d.addEventListener('click', () => { show(k); start(); }));
  $('.hero-arrow.prev').addEventListener('click', () => { show(i - 1); start(); });
  $('.hero-arrow.next').addEventListener('click', () => { show(i + 1); start(); });
  const hero = $('.hero');
  hero.addEventListener('mouseenter', () => clearInterval(timer));
  hero.addEventListener('mouseleave', start);
  hero.addEventListener('focusin', () => clearInterval(timer));
  let x0 = null;
  hero.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  hero.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) { show(i + (dx < 0 ? 1 : -1)); start(); }
    x0 = null;
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? clearInterval(timer) : start()));
  show(0);
  start();
})();

/* =====================================================================
   Categories & products
   ===================================================================== */
function renderCategoryGrid() {
  const emoji = (id) => S.products.find((p) => p.categoryId === id)?.emoji || '🌱';
  $('#categoryGrid').innerHTML = S.categories.map((c) => `
    <button class="category-card" type="button" data-filter="cat-${c.id}">
      <span class="bg cat-bg-${c.id}" aria-hidden="true"></span>
      <span class="emoji-mark" aria-hidden="true">${emoji(c.id)}</span>
      <span class="category-content"><h3>${esc(c.name)}</h3><p>${esc(c.description)}</p><span class="go">${c.productCount} products</span></span>
    </button>`).join('');
}

const visible = (p) => S.ageOk || !p.ageRestricted;
const SUB_LABELS = { wine: 'Wine', alcoholic: 'Beer & Spirits', non_alcoholic: 'Soft Drinks', water: 'Premium Water' };
const shortMaker = (n) => n.replace(/\s*\(.*\)\s*$/, '').replace(/\b(Company|Limited|PLC|Ltd|Industries|Industrial|Group)\b\.?/g, '').replace(/\s+/g, ' ').trim();
const categoryLabel = (p) => (p.categoryId === 10 && SUB_LABELS[p.subcategory]) || p.categoryName;
function tabDefs() {
  const shown = S.products.filter(visible);
  return [
    { key: 'all', label: 'All', count: shown.length },
    { key: 'buy', label: 'Buy Now', count: shown.filter((p) => p.purchasable).length },
    { key: 'halal', label: 'Halal', count: shown.filter((p) => p.halal).length },
    ...S.categories.map((c) => ({ key: `cat-${c.id}`, label: c.id === 10 ? 'Drinks' : c.name.split(/[,&(]/)[0].trim(), count: shown.filter((p) => p.categoryId === c.id).length, title: c.name }))
  ];
}

function renderTabs() {
  $('#filterTabs').innerHTML = tabDefs().map((t) =>
    `<button class="filter-tab ${S.filter === t.key ? 'active' : ''}" type="button" role="tab" aria-selected="${S.filter === t.key}" data-tab="${t.key}" ${t.title ? `title="${esc(t.title)}"` : ''}>${esc(t.label)}<span class="count">${t.count}</span></button>`).join('');
}
$('#filterTabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) setFilter(t.dataset.tab);
});

function setFilter(key) {
  S.filter = key;
  S.shown = S.pageSize;
  if (S.query) { S.query = ''; $('#searchInput').value = ''; }
  renderTabs();
  renderProducts();
  $('.filter-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function filtered() {
  const q = S.query;
  let list = S.products.filter((p) => {
    if (!visible(p)) return false;
    if (S.filter === 'buy' && !p.purchasable) return false;
    if (S.filter === 'halal' && !p.halal) return false;
    if (S.filter.startsWith('cat-') && p.categoryId !== Number(S.filter.slice(4))) return false;
    if (!q) return true;
    return [p.name, p.localName, p.notes, p.categoryName, p.defaultUnit?.name, p.defaultUnit?.localName, p.brand?.name, p.brand?.country, p.halal && 'halal'].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  const priced = (p) => (p.price ?? Infinity);
  if (S.sort === 'low') list = [...list].sort((a, b) => priced(a) - priced(b));
  if (S.sort === 'high') list = [...list].sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  if (S.sort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function unitText(p) {
  if (p.purchasable || p.price) return `per ${p.priceUnit}`;
  if (p.defaultUnit) return `Sold by ${p.defaultUnit.name}${p.defaultUnit.localName ? ` (${p.defaultUnit.localName})` : ''}`;
  return 'Sold by arrangement';
}

function cardCta(p) {
  if (!p.purchasable) {
    return p.price && !p.inStock
      ? '<button class="btn btn-outline" type="button" disabled>Sold out</button>'
      : `<button class="btn btn-outline" type="button" data-quote="${p.id}">${icon('file')} Request quote</button>`;
  }
  const q = S.cart[p.id];
  return q
    ? `<div class="stepper"><button type="button" data-dec="${p.id}" aria-label="Remove one ${esc(p.name)}">${icon('minus')}</button><span aria-live="polite">${q} in bag</span><button type="button" data-inc="${p.id}" aria-label="Add one ${esc(p.name)}">${icon('plus')}</button></div>`
    : `<button class="btn btn-outline" type="button" data-add="${p.id}">${icon('bag')} Add to bag</button>`;
}

function productCard(p) {
  const liked = S.wish.has(p.id);
  const badge = (p.purchasable ? (p.featured ? '<div class="product-badge">Fresh</div>' : '') : '<div class="product-badge soft">On request</div>')
    + (p.ageRestricted ? '<div class="product-badge age" title="Not for sale to persons under 18">18+</div>' : '')
    + (p.halal ? '<div class="product-badge halal" title="Halal certified. Certificate available on request">Halal</div>' : '');
  return `
    <article class="product-card">
      ${badge}
      <div class="product-media">
        <button class="product-img" type="button" data-qv="${p.id}" aria-label="View details for ${esc(p.name)}">
          <span class="emoji" aria-hidden="true">${p.emoji}</span>
        </button>
        <div class="product-actions">
          <button class="product-action ${liked ? 'liked' : ''}" type="button" data-wish="${p.id}" aria-pressed="${liked}" aria-label="${liked ? 'Remove from' : 'Save to'} favourites">${icon('heart')}</button>
          <button class="product-action" type="button" data-qv="${p.id}" aria-label="Quick view">${icon('eye')}</button>
        </div>
      </div>
      <div class="product-content">
        <div class="product-category">${esc(categoryLabel(p))}</div>
        <h3 class="product-title">${esc(p.name)}</h3>
        <div class="product-local">${p.brand ? `<span class="product-maker" title="${esc(p.brand.name)}, ${esc(p.brand.country)}">${flags(p.brand.countryCodes)} ${esc(shortMaker(p.brand.name))}</span>` : p.localName ? esc(p.localName) : ''}</div>
        <div class="product-unit">${esc(unitText(p))}</div>
        <div class="product-price">${p.price ? `<span class="current-price">${price(p.price)}</span><span class="price-alt">${altPrice(p.price)}</span>` : '<span class="on-request">Price on request</span>'}</div>
        ${p.ageRestricted ? '<div class="card-warning">Drink responsibly · 18+ only</div>' : ''}
        <div class="card-cta" data-cta="${p.id}">${cardCta(p)}</div>
      </div>
    </article>`;
}

function renderProducts() {
  const list = filtered();
  const grid = $('#productGrid');
  grid.setAttribute('aria-busy', 'false');
  const note = $('#resultsNote');
  const hiddenAlcohol = !S.ageOk && (S.filter === 'cat-10' || S.query) && S.products.some((p) => p.ageRestricted && (S.filter === 'cat-10' || p.name.toLowerCase().includes(S.query)));
  if (S.query) note.innerHTML = `${list.length} result${list.length === 1 ? '' : 's'} for “${esc(S.query)}”<button type="button" id="clearSearch">Clear</button>`;
  else note.textContent = '';
  if (hiddenAlcohol) note.innerHTML += ` <span class="muted">Alcoholic drinks are hidden.</span> <button type="button" data-drinks="wine">Show them (18+)</button>`;
  grid.innerHTML = list.length
    ? list.slice(0, S.shown).map(productCard).join('')
    : `<div class="empty-state">${icon('search')}<p>Nothing matches “${esc(S.query)}”.</p><p class="small">Try “gari”, “tomato” or “Olonka”, or <button class="text-link" type="button" data-filter="all">browse everything</button>.</p></div>`;
  const more = $('#loadMore');
  more.hidden = list.length <= S.shown;
  more.textContent = `Show more (${list.length - S.shown} left)`;
}
function renderProductGrids() { renderProducts(); renderHalal(); renderDrinks(); }
$('#loadMore').addEventListener('click', () => { S.shown += S.pageSize; renderProducts(); });
$('#sortSelect').addEventListener('change', (e) => { S.sort = e.target.value; renderProducts(); });

let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.query = e.target.value.trim().toLowerCase().slice(0, 60);
    S.shown = S.pageSize;
    if (S.query && S.filter !== 'all') { S.filter = 'all'; renderTabs(); }
    renderProducts();
  }, 150);
});
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); scrollToEl('#products'); });
document.addEventListener('click', (e) => {
  if (e.target.id === 'clearSearch') { S.query = ''; $('#searchInput').value = ''; renderProducts(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !currentLayer() && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#searchInput').focus(); }
});

function toggleWish(id, btn) {
  const on = !S.wish.has(id);
  on ? S.wish.add(id) : S.wish.delete(id);
  store.set('ntn_wish', [...S.wish]);
  btn.classList.toggle('liked', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', `${on ? 'Remove from' : 'Save to'} favourites`);
  toast(on ? `${byId(id).name} saved to favourites` : 'Removed from favourites');
}

/* Drinks section (age-gated alcohol) */
function drinkPool(sub) {
  return S.products.filter((p) => p.categoryId === 10 && p.subcategory === sub);
}
function renderMakerSelects() {
  const sel = $('#makerSelect');
  sel.innerHTML = '<option value="">All makers</option>' + S.brands.map((b) => `<option value="${b.id}">${esc(shortMaker(b.name))} · ${esc(b.country.split(' (')[0])}</option>`).join('');
  const countries = [...new Set(S.brands.flatMap((b) => b.countryCodes))].sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b));
  $('#makerCountry').innerHTML = '<option value="">All countries</option>' + countries.map((c) => `<option value="${c}">${flag(c)} ${esc(COUNTRY_NAMES[c] || c)}</option>`).join('');
}
function renderHalal() {
  const list = S.products.filter((p) => p.halal).sort((a, b) => (b.purchasable - a.purchasable) || a.name.localeCompare(b.name));
  $('#halalGrid').innerHTML = list.slice(0, S.halalShown).map(productCard).join('')
    || `<div class="empty-state">${icon('info')}<p>Halal products are being added.</p><p class="small">Need halal meat now? <button class="text-link" type="button" data-partner="business">Ask for a quote</button> and we'll reply within 24 hours.</p></div>`;
  const more = $('#halalMore');
  more.hidden = list.length <= S.halalShown;
  more.textContent = `Show more halal foods (${list.length - S.halalShown} left)`;
  const priced = list.filter((p) => p.purchasable).length;
  $('#halalNote').textContent = list.length && priced < list.length ? 'Items marked "Price on request" are sourced to order. Ask for a quote and we will reply within 24 hours.' : '';
}
$('#halalMore').addEventListener('click', () => { S.halalShown += 8; renderHalal(); });

function renderDrinks() {
  const sub = S.drinkSub;
  const alcoholic = sub === 'wine' || sub === 'alcoholic';
  $$('#drinkTabs [data-sub]').forEach((b) => { const on = b.dataset.sub === sub; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const gate = alcoholic && !S.ageOk;
  $('#ageGate').hidden = !gate;
  $('#drinkFilters').hidden = gate;
  const pool = gate ? [] : drinkPool(sub);
  // country chips for this tab
  const counts = {};
  pool.forEach((p) => (p.brand?.countryCodes || ['GH']).forEach((c) => { counts[c] = (counts[c] || 0) + 1; }));
  if (S.drinkCountry && !counts[S.drinkCountry]) S.drinkCountry = '';
  $('#countryChips').innerHTML = `<button type="button" class="country-chip ${S.drinkCountry ? '' : 'active'}" data-country="" aria-pressed="${!S.drinkCountry}">All Africa <small>${pool.length}</small></button>` +
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<button type="button" class="country-chip ${S.drinkCountry === c ? 'active' : ''}" data-country="${c}" aria-pressed="${S.drinkCountry === c}">${flag(c)} ${esc(COUNTRY_NAMES[c] || c)} <small>${n}</small></button>`).join('');
  $$('#makerSelect option').forEach((o) => { if (o.value) o.hidden = !pool.some((p) => String(p.brand?.id) === o.value); });
  if (S.drinkMaker && !pool.some((p) => String(p.brand?.id) === S.drinkMaker)) S.drinkMaker = '';
  $('#makerSelect').value = S.drinkMaker;
  const list = pool.filter((p) => (!S.drinkCountry || (p.brand?.countryCodes || ['GH']).includes(S.drinkCountry)) && (!S.drinkMaker || String(p.brand?.id) === S.drinkMaker))
    .sort((a, b) => (b.purchasable - a.purchasable) || ((a.brand ? 1 : 0) - (b.brand ? 1 : 0)) || a.name.localeCompare(b.name));
  $('#drinkGrid').innerHTML = list.slice(0, S.drinkShown).map(productCard).join('') || (gate ? '' : `<div class="empty-state">${icon('search')}<p>No drinks match these filters.</p></div>`);
  $('#drinkGrid').hidden = gate;
  $('#drinkMore').hidden = gate || list.length <= S.drinkShown;
  $('#drinkMore').textContent = `Show more drinks (${list.length - S.drinkShown} left)`;
  $('#drinkCount').textContent = gate ? '' : `${list.length} drink${list.length === 1 ? '' : 's'}`;
  $('#drinkReset').hidden = !S.drinkCountry && !S.drinkMaker;
  $('#alcoholWarning').hidden = !alcoholic || gate;
  const priced = list.filter((p) => p.purchasable).length;
  $('#drinksNote').textContent = gate || !list.length ? '' : priced < list.length ? 'Items marked "Price on request" are sourced to order from authorised distributors. Ask for a quote and we will reply within 24 hours.' : '';
}
$('#countryChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-country]');
  if (!b) return;
  S.drinkCountry = b.dataset.country;
  S.drinkMaker = '';
  S.drinkShown = 12;
  renderDrinks();
});
$('#makerSelect').addEventListener('change', (e) => { S.drinkMaker = e.target.value; S.drinkShown = 12; renderDrinks(); });
$('#drinkReset').addEventListener('click', () => { S.drinkCountry = ''; S.drinkMaker = ''; S.drinkShown = 12; renderDrinks(); });
$('#drinkMore').addEventListener('click', () => { S.drinkShown += 12; renderDrinks(); });

/* Makers directory */
function renderMakers() {
  const country = $('#makerCountry').value;
  const list = S.brands.filter((b) => !country || b.countryCodes.includes(country));
  $('#makerGrid').innerHTML = list.map((b) => {
    const prods = S.products.filter((p) => p.brand?.id === b.id);
    return `<article class="maker-card">
      <div class="flag" aria-hidden="true">${flags(b.countryCodes)}</div>
      <h3>${esc(b.name)}</h3>
      <div class="country">${esc(b.country)}</div>
      <div class="chips">${prods.filter(visible).map((p) => `<button type="button" class="chip" data-maker-product="${p.id}">${p.ageRestricted ? '18+ · ' : ''}${esc(p.name)}</button>`).join('')}${S.ageOk ? '' : (() => { const n = prods.filter((p) => !visible(p)).length; return n ? `<span class="chip muted">${n} alcoholic drink${n === 1 ? '' : 's'} · 18+</span>` : ''; })()}</div>
      ${b.notes ? `<p class="note">${esc(b.notes)}</p>` : ''}
      <button type="button" class="text-link" data-maker="${b.id}">View drinks (${prods.length})</button>
    </article>`;
  }).join('');
}
$('#makerCountry').addEventListener('change', renderMakers);
$('#makerGrid').addEventListener('click', (e) => {
  const prod = e.target.closest('[data-maker-product]');
  if (prod) { openQuickView(Number(prod.dataset.makerProduct)); return; }
  const m = e.target.closest('[data-maker]');
  if (!m) return;
  const prods = S.products.filter((p) => String(p.brand?.id) === m.dataset.maker);
  const order = S.ageOk ? ['alcoholic', 'wine', 'non_alcoholic', 'water'] : ['non_alcoholic', 'water', 'alcoholic', 'wine'];
  S.drinkSub = order.find((sub) => prods.some((p) => p.subcategory === sub)) || 'non_alcoholic';
  S.drinkCountry = '';
  S.drinkMaker = m.dataset.maker;
  S.drinkShown = 12;
  renderDrinks();
  scrollToEl('#drinks');
});

function showDrinks(sub) {
  S.drinkSub = sub;
  S.drinkShown = 12;
  renderDrinks();
  scrollToEl('#drinks');
}
$('#drinkTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (!b) return;
  S.drinkSub = b.dataset.sub;
  S.drinkShown = 12;
  renderDrinks();
});
$('#ageYes').addEventListener('click', () => {
  S.ageOk = true;
  store.set('ntn_age_ok', Date.now());
  renderDrinks();
  renderMakers();
  renderTabs();
  renderProducts();
});
$('#ageNo').addEventListener('click', () => {
  S.drinkSub = 'non_alcoholic';
  renderDrinks();
  toast("No problem — here are our alcohol-free drinks.");
});

/* Quick view */
function openQuickView(id) {
  const p = byId(id);
  if (!p) return;
  if (!visible(p)) { showDrinks('wine'); return; }
  const mp = S.market.filter((m) => m.productId === p.id);
  const hist = S.history.find((h) => h.productId === p.id);
  const unit = p.defaultUnit;
  let qty = 1;
  $('#quickViewContent').innerHTML = `
    <div class="quick-view-img" aria-hidden="true">${p.emoji}</div>
    <div class="quick-view-details">
      <div class="product-category">${esc(p.categoryName)}</div>
      <h2 class="quick-view-title">${esc(p.name)}${p.localName ? ` <span class="muted">· ${esc(p.localName)}</span>` : ''}</h2>
      <div class="quick-view-price">${p.price ? `${price(p.price)} <span class="price-alt">per ${esc(p.priceUnit)} · ${altPrice(p.price)}</span>` : '<span class="on-request">Price on request</span>'}</div>
      ${p.notes ? `<div class="quick-view-description">${esc(p.notes)}</div>` : ''}
      <div class="qv-meta">
        ${p.brand ? `<div><span>Made by</span><span>${esc(p.brand.name)} · ${flags(p.brand.countryCodes)} ${esc(p.brand.country)}</span></div>` : ''}
        ${p.verifyAbv ? '<div><span>Alcohol</span><span>Listed as 18+ until the label is confirmed</span></div>' : ''}
        ${p.halal ? '<div><span>Halal</span><span>From a certified halal supplier · certificate on request · packed apart from pork and alcohol</span></div>' : ''}
        ${unit ? `<div><span>Market measure</span><span>${esc(unit.name)}${unit.localName ? ` (${esc(unit.localName)})` : ''}${unit.approxWeight ? ` · ${esc(unit.approxWeight)}` : ''}</span></div>` : ''}
        ${mp.map((m) => `<div><span>${esc(titleCase(m.priceType))} price</span><span>${rangeText(m)} / ${esc(m.unit)}${m.market ? ` · ${esc(m.market)}` : ''}</span></div>`).join('')}
        ${hist ? `<div><span>Trend</span><span class="${hist.changePct < 0 ? 'down' : 'up'}">${hist.changePct > 0 ? '▲' : '▼'} ${Math.abs(hist.changePct).toFixed(1)}% — ${esc(hist.reason)}</span></div>` : ''}
        <div><span>Delivery</span><span>All 16 regions · free over ${ghs(S.config.freeDeliveryThreshold)}</span></div>
      </div>
      ${p.ageRestricted ? `<div class="qv-warning">${esc(ALCOHOL_WARNING)}. ID is checked on delivery.</div>` : ''}
      <div class="quick-view-actions">
        ${p.purchasable ? `
          <div class="quantity-selector"><button class="quantity-btn" type="button" id="qvDec" aria-label="Decrease">${icon('minus')}</button><input class="quantity-input" id="qvQty" value="1" readonly aria-label="Quantity"><button class="quantity-btn" type="button" id="qvInc" aria-label="Increase">${icon('plus')}</button></div>
          <button class="btn" type="button" id="qvAdd">Add to Bag · ${price(p.price)}</button>`
        : `<button class="btn btn-block" type="button" data-quote="${p.id}">${icon('file')} Request a quote</button>`}
      </div>
    </div>`;
  if (p.purchasable) {
    const upd = () => { $('#qvQty').value = qty; $('#qvAdd').textContent = `Add to Bag · ${price(p.price * qty)}`; };
    $('#qvDec').addEventListener('click', () => { if (qty > 1) { qty--; upd(); } });
    $('#qvInc').addEventListener('click', () => { if (qty < 999) { qty++; upd(); } });
    $('#qvAdd').addEventListener('click', () => { closeLayer(); changeQty(p.id, qty, true, qty); });
  }
  openLayerEl($('#quickViewModal'));
}

/* Quote request */
function openQuote(id) {
  const p = byId(id);
  if (!p) return;
  const f = $('#quoteForm');
  f.reset();
  clearErrors(f);
  $('#quoteProductId').value = String(p.id);
  $('#quoteProduct').textContent = `${p.emoji} ${p.name}${p.defaultUnit ? ` — usually sold by ${p.defaultUnit.name}` : ''}`;
  if (S.user) { f.elements.name.value = S.user.name || ''; f.elements.phone.value = S.user.phone || ''; }
  openLayerEl($('#quoteModal'));
}

/* =====================================================================
   Cart
   ===================================================================== */
function saveCart() { store.set('ntn_cart', S.cart); }
const cartCount = () => Object.values(S.cart).reduce((a, b) => a + b, 0);
const cartSubtotal = () => Object.entries(S.cart).reduce((s, [id, q]) => s + (byId(id)?.price || 0) * q, 0);
const cartItems = () => Object.entries(S.cart).map(([productId, qty]) => ({ productId: Number(productId), qty }));

function changeQty(id, delta, announce = false, amount = 1) {
  const p = byId(id);
  if (!p || !p.purchasable) return;
  const next = Math.min(999, (S.cart[id] || 0) + delta * (delta > 0 ? amount : 1));
  if (p.stock !== null && next > p.stock) { toast(`Only ${p.stock} × ${p.name} available`, { type: 'error' }); return; }
  if (next <= 0) delete S.cart[id]; else S.cart[id] = next;
  saveCart();
  refreshCta(p);
  renderCart();
  const badge = $('#bagCount');
  badge.classList.add('bump');
  setTimeout(() => badge.classList.remove('bump'), 200);
  if (announce) toast(`${amount > 1 ? amount + ' × ' : ''}${p.name} added to bag`, { type: 'success', action: 'View bag', onAction: openCart });
  if (!$('#checkoutModal').hidden) refreshQuote();
}

function removeItem(id) {
  const q = S.cart[id];
  const p = byId(id);
  delete S.cart[id];
  saveCart();
  refreshCta(p);
  renderCart();
  toast(`${p?.name || 'Item'} removed`, { action: 'Undo', onAction: () => { S.cart[id] = q; saveCart(); renderCart(); refreshCta(p); } });
}

// A product can appear in several grids (The Market, Halal, Drinks): update every copy of its button.
function refreshCta(p) {
  if (p) $$(`[data-cta="${p.id}"]`).forEach((el) => { el.innerHTML = cardCta(p); });
}

function renderCart() {
  const n = cartCount();
  const sub = cartSubtotal();
  const badge = $('#bagCount');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  $('#drawerCount').textContent = n ? `(${n})` : '';
  const threshold = S.config?.freeDeliveryThreshold ?? 30000;
  $('#shipBar').hidden = n === 0;
  $('#shipText').innerHTML = sub >= threshold ? `${icon('check')} You qualify for free delivery` : `You're <b>${price(threshold - sub)}</b> away from free delivery`;
  $('#shipFill').style.width = `${Math.min(100, (sub / threshold) * 100)}%`;
  if (!n) {
    $('#cartItems').innerHTML = `<div class="cart-empty">${icon('bag')}<p>Your bag is empty</p><button class="btn btn-outline" type="button" data-close data-filter="buy">Start shopping</button></div>`;
    $('#cartFoot').innerHTML = '';
    return;
  }
  $('#cartItems').innerHTML = Object.keys(S.cart).map((id) => {
    const p = byId(id);
    return `<div class="cart-item">
      <div class="cart-thumb" aria-hidden="true">${p.emoji}</div>
      <div class="cart-info"><b>${esc(p.name)}</b><small>${price(p.price)} · per ${esc(p.priceUnit)}</small>
        <div class="mini-stepper"><button type="button" data-dec="${id}" aria-label="Decrease ${esc(p.name)}">${icon('minus')}</button><span aria-live="polite">${S.cart[id]}</span><button type="button" data-inc="${id}" aria-label="Increase ${esc(p.name)}">${icon('plus')}</button></div>
      </div>
      <div class="cart-right"><b>${price(p.price * S.cart[id])}</b><button class="remove-item" type="button" data-remove="${id}">${icon('trash')} Remove</button></div>
    </div>`;
  }).join('');
  const fee = sub >= threshold ? 0 : (S.config?.deliveryFee ?? 2500);
  $('#cartFoot').innerHTML = `
    <div class="sum-row"><span>Subtotal</span><span>${price(sub)}</span></div>
    <div class="sum-row"><span>Delivery</span><span>${fee ? price(fee) : '<span class="good">Free</span>'}</span></div>
    <div class="sum-row total"><span>Estimated total</span><span>${price(sub + fee)}</span></div>
    <button class="btn btn-block" type="button" id="toCheckout">Proceed to checkout</button>
    <button class="text-link center-block" type="button" data-close>Continue shopping</button>`;
  $('#toCheckout').addEventListener('click', openCheckout);
}

function openCart() { $('#toasts').innerHTML = ''; openLayerEl($('#cartDrawer'), { drawer: true }); }
$('#bagBtn').addEventListener('click', openCart);
$('#overlay').addEventListener('click', () => closeLayer());
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) closeLayer(); }));

/* =====================================================================
   Checkout
   ===================================================================== */
const PAY_METHODS = {
  momo: { label: 'Mobile Money', sub: 'MTN · Telecel · AT', icon: 'phone', info: 'You\'ll be taken to Paystack to approve the payment on your phone (MTN MoMo, Telecel Cash or AirtelTigo Money).' },
  card: { label: 'Card', sub: 'Visa · Mastercard', icon: 'card', info: 'You\'ll enter your card details on Paystack\'s secure page. We never see or store card numbers.' },
  ogya: { label: 'Ogya Coin', sub: '', icon: 'coins', info: '' },
  cash: { label: 'Cash', sub: 'On delivery', icon: 'cash', info: 'Pay the rider when your order arrives. Exact change helps.' }
};

function renderPayOptions() {
  const online = S.config.onlinePayments;
  const methods = ['cash', ...(online ? ['momo', 'card'] : []), 'ogya'];
  if (!methods.includes(S.payMethod)) S.payMethod = 'cash';
  const disc = S.config.ogyaDiscountBps / 100;
  PAY_METHODS.ogya.sub = disc ? `Save ${disc}%` : '';
  $('#payOptions').innerHTML = methods.map((m) => `
    <button type="button" class="payment-option ${S.payMethod === m ? 'active' : ''}" role="radio" aria-checked="${S.payMethod === m}" data-method="${m}">
      ${icon(PAY_METHODS[m].icon)}<span>${PAY_METHODS[m].label}</span><small>${PAY_METHODS[m].sub}</small>
    </button>`).join('');
  renderPayInfo();
}

function renderPayInfo() {
  let html = esc(PAY_METHODS[S.payMethod].info);
  if (S.payMethod === 'ogya') {
    html = S.user
      ? `Wallet balance: <b>${ogy(S.user.ogyBalance)}</b> (≈ ${ghs(S.user.ogyBalance)}). ${S.config.ogyaDiscountBps / 100}% off your items. <button type="button" class="text-link" id="payTopup">Top up</button>`
      : `<button type="button" class="text-link" id="paySignIn">Sign in</button> to pay with your Ogya wallet and save ${S.config.ogyaDiscountBps / 100}%.`;
  }
  if (!S.config.onlinePayments && S.payMethod === 'cash') html += ' Online MoMo and card payments are coming soon.';
  $('#payInfo').innerHTML = html;
  $('#payTopup')?.addEventListener('click', () => openAccount('wallet', { resumeCheckout: true }));
  $('#paySignIn')?.addEventListener('click', () => openAccount('signin', { resumeCheckout: true }));
}

$('#payOptions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-method]');
  if (!b) return;
  S.payMethod = b.dataset.method;
  $$('.payment-option').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', String(on)); });
  renderPayInfo();
  refreshQuote();
});

function openCheckout() {
  if (!cartCount()) { toast('Your bag is empty'); return; }
  const f = $('#checkoutForm');
  clearErrors(f);
  $('#checkoutView').hidden = false;
  $('#successView').hidden = true;
  if (S.user) {
    if (!f.elements.name.value) f.elements.name.value = S.user.name || '';
    if (!f.elements.phone.value) f.elements.phone.value = S.user.phone || '';
    if (!f.elements.email.value) f.elements.email.value = S.user.email || '';
  }
  const saved = store.get('ntn_delivery', null);
  if (saved && !f.elements.region.value) { f.elements.region.value = saved.region || ''; f.elements.town.value = saved.town || ''; }
  if (S.user && !S.user.needsTerms) $('#coTerms').checked = true;
  renderPayOptions();
  openLayerEl($('#checkoutModal'));
  refreshQuote();
}

async function refreshQuote() {
  const seq = ++S.quoteSeq;
  const btn = $('#placeOrder');
  if (!cartCount()) { closeLayer(); toast('Your bag is empty'); return; }
  $('#osTotals').innerHTML = '<p class="muted small">Calculating…</p>';
  btn.disabled = true;
  try {
    const { quote } = await api('/api/orders/quote', { method: 'POST', body: { items: cartItems(), paymentMethod: S.payMethod, couponCode: S.couponCode || undefined } });
    if (seq !== S.quoteSeq) return;
    $('#osItems').innerHTML = quote.lines.map((l) => `<div class="os-line"><span>${l.qty} × ${esc(l.name)} <small>(${esc(l.unitLabel)})</small></span><span>${price(l.lineTotal)}</span></div>`).join('');
    $('#osTotals').innerHTML = `
      <div class="os-line"><span>Subtotal</span><span>${price(quote.subtotal)}</span></div>
      <div class="os-line"><span>Delivery</span><span>${quote.deliveryFee ? price(quote.deliveryFee) : 'Free'}</span></div>
      ${quote.discount ? `<div class="os-line"><span>Ogya discount</span><span class="good">−${price(quote.discount)}</span></div>` : ''}
      ${quote.couponAmount ? `<div class="os-line"><span>Coupon ${esc(quote.couponCode)}</span><span class="good">−${price(quote.couponAmount)}</span></div>` : ''}
      <div class="sum-row total"><span>To pay</span><span>${price(quote.total)}</span></div>
      ${S.currency === 'GHS' ? `<div class="os-line"><span></span><span class="price-alt">${ogy(quote.total)}</span></div>` : ''}`;
    const ageRow = $('#ageRow');
    ageRow.hidden = !quote.ageRestricted;
    $('#coAge').disabled = !quote.ageRestricted;
    $('#coAge').required = Boolean(quote.ageRestricted);
    if (!quote.ageRestricted) $('#coAge').checked = false;
    btn.textContent = quote.total === 0 ? 'Place order · covered by coupon' : `Place order · ${price(quote.total)}`;
    btn.disabled = false;
    $('#checkoutError').hidden = true;
  } catch (e) {
    if (seq !== S.quoteSeq) return;
    if (e.code === 'coupon_invalid' || e.code === 'coupon_empty') {
      S.couponCode = null;
      $('#coCoupon').value = '';
      toast(e.message, { type: 'error' });
      return refreshQuote();
    }
    $('#osTotals').innerHTML = '';
    const box = $('#checkoutError');
    box.textContent = e.message;
    box.hidden = false;
    if (e.code === 'unavailable' || e.code === 'price_on_request' || e.code === 'out_of_stock') {
      reloadProducts();
    }
  }
}

async function reloadProducts() {
  try {
    S.products = (await api('/api/products')).products;
    pruneCart();
    renderProductGrids();
    renderCart();
  } catch { /* keep current */ }
}

$('#applyCoupon').addEventListener('click', () => {
  const code = $('#coCoupon').value.trim().toUpperCase();
  S.couponCode = code || null;
  refreshQuote().then(() => { if (S.couponCode) toast('Coupon applied', { type: 'success' }); });
});
$('#coCoupon').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#applyCoupon').click(); } });

$('#checkoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  if (S.payMethod === 'ogya' && !S.user) { openAccount('signin', { resumeCheckout: true }); toast('Sign in to pay with Ogya Coin'); return; }
  const btn = $('#placeOrder');
  setLoading(btn, true);
  const data = formData(f);
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      body: { ...data, items: cartItems(), paymentMethod: S.payMethod, couponCode: S.couponCode || undefined }
    });
    store.set('ntn_delivery', { region: data.region, town: data.town });
    if (res.payment?.authorizationUrl) {
      store.set('ntn_pending_order', res.order.ref);
      safeRedirect(res.payment.authorizationUrl);
      return;
    }
    S.cart = {};
    saveCart();
    S.couponCode = null;
    $('#coCoupon').value = '';
    renderCart();
    renderProductGrids();
    if (S.payMethod === 'ogya' || S.user?.needsTerms) refreshUser();
    showOrderSuccess(res.order);
  } catch (err) {
    showErrors(f, err);
    if (err.code === 'insufficient_ogya') $('#checkoutError').innerHTML = `${esc(err.message)} <button type="button" class="text-link" id="errTopup">Top up wallet</button>`;
    $('#errTopup')?.addEventListener('click', () => openAccount('wallet', { resumeCheckout: true }));
  } finally {
    setLoading(btn, false);
  }
});

function showOrderSuccess(order) {
  const msgs = {
    cash: `Pay ${ghs(order.total)} to the rider on delivery.`,
    ogya: `${ogy(order.total)} was paid from your Ogya wallet.`,
    coupon: 'Your coupon covered the full amount.',
    momo: 'Payment received. Thank you!',
    card: 'Payment received. Thank you!'
  };
  $('#successTitle').textContent = 'Order placed';
  $('#successMsg').textContent = `${msgs[order.paymentMethod] || ''} Delivery: ${order.deliverySlot}.${order.ageRestricted ? ' Your order contains alcohol: the receiver must be 18+ and show ID to the rider.' : ''} We'll text you updates. Keep your order number to track it.`;
  $('#orderRef').textContent = order.ref;
  $('#checkoutView').hidden = true;
  $('#successView').hidden = false;
  if ($('#checkoutModal').hidden) openLayerEl($('#checkoutModal'));
}

/* =====================================================================
   Payment return (Paystack callback / simulator)
   ===================================================================== */
async function handlePaymentReturn() {
  if (location.pathname !== '/payment/callback') return;
  const params = new URLSearchParams(location.search);
  const reference = (params.get('reference') || params.get('trxref') || '').toUpperCase();
  history.replaceState(null, '', '/');
  if (!/^[A-Z0-9]{8,40}$/.test(reference)) return;
  const icn = $('#payResultIcon');
  openLayerEl($('#payResultModal'));
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await api('/api/payments/verify', { method: 'POST', body: { reference } });
      const p = res.payment;
      if (p.status === 'success') {
        icn.classList.remove('fail');
        icn.innerHTML = icon('check');
        if (p.purpose === 'order') {
          S.cart = {}; saveCart(); renderCart(); renderProductGrids();
          $('#payResultTitle').textContent = 'Payment received — order confirmed';
          $('#payResultMsg').textContent = `We've received ${ghs(p.amount)}. We'll text you as your order moves. Keep your order number to track it.`;
          $('#payResultRef').textContent = res.order?.ref || '';
          $('#payResultRef').hidden = !res.order;
        } else if (p.purpose === 'topup') {
          $('#payResultTitle').textContent = 'Wallet topped up';
          $('#payResultMsg').textContent = `${ogy(p.amount)} has been added to your Ogya wallet.`;
          refreshUser();
        } else {
          $('#payResultTitle').textContent = 'Coupon purchased';
          $('#payResultMsg').textContent = 'Your food coupon is active and the receiver has been sent the code. You can see it under Account → Coupons.';
        }
        store.remove('ntn_pending_order');
        return;
      }
      if (p.status === 'failed' || p.status === 'abandoned') {
        icn.classList.add('fail');
        icn.innerHTML = icon('x');
        $('#payResultTitle').textContent = 'Payment not completed';
        $('#payResultMsg').textContent = 'No money was taken. Your bag is still saved — you can try again or choose cash on delivery.';
        return;
      }
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) { $('#payResultTitle').textContent = 'We could not confirm this payment'; $('#payResultMsg').textContent = e.message; return; }
    }
    $('#payResultMsg').textContent = 'Waiting for confirmation from your mobile money provider…';
    await new Promise((r) => setTimeout(r, 2500));
  }
  $('#payResultTitle').textContent = 'Still confirming…';
  $('#payResultMsg').textContent = "Your payment is taking longer than usual. If you approved it, your order will be confirmed automatically and you'll get an SMS. You can also track it with your order number.";
}

/* =====================================================================
   Account, wallet, orders, coupons
   ===================================================================== */
function renderUser() {
  const u = S.user;
  $('#accountLbl').textContent = u ? u.name.split(' ')[0].slice(0, 12) : 'Account';
  $('#walletBal').textContent = u ? ogy(u.ogyBalance) : 'Sign in';
  $('#guestTabs').hidden = Boolean(u);
  $('#userTabs').hidden = !u;
  $('#couponSignInNote').textContent = u ? 'The code is shown here and sent to the receiver by SMS.' : "You'll need to sign in so you can see the code and track it.";
  if (u) {
    $('#acName').textContent = u.name;
    $('#acEmail').textContent = u.phone || u.email || '';
    $('#wBal').textContent = ogy(u.ogyBalance);
    $('#wGhs').textContent = `≈ ${ghs(u.ogyBalance)}`;
    $('#termsBanner').hidden = !u.needsTerms;
  }
  const online = S.config?.onlinePayments;
  $('#topupForm').hidden = !online;
  $('#topupDisabled').hidden = Boolean(online);
  renderCouponMethods();
}

async function refreshUser() {
  try { S.user = (await api('/api/me')).user; } catch { S.user = null; }
  renderUser();
}

function showTab(scope, name) {
  $$(`${scope} .tab-btn`).forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $$(`${scope} .tab-content`).forEach((c) => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'wallet') loadWallet();
  if (name === 'orders') loadMyOrders();
  if (name === 'mycoupons') loadMyCoupons();
  if (name === 'profile') loadProfile();
}
$$('#userTabs .tab-btn').forEach((b) => b.addEventListener('click', () => showTab('#userTabs', b.dataset.tab)));

function openAccount(tab, { resumeCheckout = false } = {}) {
  S.resumeCheckout = resumeCheckout;
  if (S.user) showTab('#userTabs', ['wallet', 'orders', 'mycoupons', 'profile'].includes(tab) ? tab : 'wallet');
  else otpStep('phone');
  openLayerEl($('#accountModal'));
}
$('#accountBtn').addEventListener('click', () => openAccount('wallet'));
$('#walletBtn').addEventListener('click', () => openAccount('wallet'));

/* ---------- Phone + SMS code sign-in (Sailup) ---------- */
const otpState = { phone: '', signupToken: null, timer: null };
function otpStep(step) {
  $('#otpPhoneForm').hidden = step !== 'phone';
  $('#otpCodeForm').hidden = step !== 'code';
  $('#otpProfileForm').hidden = step !== 'profile';
  $('#accountTitle').textContent = step === 'profile' ? 'Create your account' : 'Sign in';
  const focus = { phone: '#otpPhone', code: '#otpCode', profile: '#pfName' }[step];
  requestAnimationFrame(() => $(focus)?.focus());
}
function startResendTimer(seconds) {
  clearInterval(otpState.timer);
  const btn = $('#otpResend');
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    if (left <= 0) { clearInterval(otpState.timer); btn.disabled = false; btn.textContent = 'Resend code'; return; }
    btn.textContent = `Resend code in ${left}s`;
    left--;
  };
  tick();
  otpState.timer = setInterval(tick, 1000);
}
async function sendOtp(phone, btn) {
  setLoading(btn, true);
  try {
    const r = await api('/api/auth/otp/request', { method: 'POST', body: { phone } });
    otpState.phone = phone;
    $('#otpPhoneShown').textContent = phone;
    $('#otpCode').value = '';
    const hint = $('#otpDevHint');
    hint.hidden = !r.devCode;
    hint.textContent = r.devCode ? `Development mode (no SMS sent): your code is ${r.devCode}` : '';
    clearErrors($('#otpCodeForm'));
    otpStep('code');
    startResendTimer(r.resendInSeconds || 60);
    toast('Code sent by SMS', { type: 'success' });
    return true;
  } catch (err) {
    showErrors($('#otpPhoneForm').hidden ? $('#otpCodeForm') : $('#otpPhoneForm'), err);
    if (err.code === 'otp_cooldown' && !$('#otpCodeForm').hidden) startResendTimer(Number((err.message.match(/\d+/) || [60])[0]));
    return false;
  } finally { setLoading(btn, false); }
}
$('#otpPhoneForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  sendOtp(f.elements.phone.value.trim(), $('button[type=submit]', f));
});
$('#otpResend').addEventListener('click', (e) => sendOtp(otpState.phone, e.currentTarget));
$('#otpChange').addEventListener('click', () => { clearInterval(otpState.timer); otpStep('phone'); });
$('#otpCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('#otpCodeForm').requestSubmit();
});
$('#otpCodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  if (btn.disabled) return;
  setLoading(btn, true);
  try {
    const r = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: otpState.phone, code: f.elements.code.value } });
    clearInterval(otpState.timer);
    if (r.needsProfile) {
      otpState.signupToken = r.signupToken;
      $('#otpProfileForm').reset();
      otpStep('profile');
      return;
    }
    S.user = r.user;
    renderUser();
    toast(`Welcome back, ${S.user.name.split(' ')[0]}!`, { type: 'success' });
    afterAuth();
  } catch (err) {
    showErrors(f, err);
    if (err.code === 'otp_locked' || err.code === 'otp_expired' || err.code === 'otp_missing') { $('#otpResend').disabled = false; $('#otpResend').textContent = 'Resend code'; }
  } finally { setLoading(btn, false); }
});
$('#otpProfileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    const r = await api('/api/auth/otp/complete', { method: 'POST', body: { ...formData(f), signupToken: otpState.signupToken } });
    S.user = r.user;
    renderUser();
    toast(`Akwaaba, ${S.user.name.split(' ')[0]}! Your account is ready.`, { type: 'success' });
    afterAuth();
  } catch (err) {
    showErrors(f, err);
    if (err.code === 'signup_expired') { toast(err.message, { type: 'error' }); otpStep('phone'); }
  } finally { setLoading(btn, false); }
});

function afterAuth() {
  if (S.resumeCheckout && cartCount()) { S.resumeCheckout = false; openCheckout(); return; }
  showTab('#userTabs', 'wallet');
}

$('#acceptTermsBtn').addEventListener('click', async (e) => {
  setLoading(e.currentTarget, true);
  try { S.user = (await api('/api/me/accept-terms', { method: 'POST' })).user; renderUser(); toast('Thank you', { type: 'success' }); }
  catch (err) { toastError(err); } finally { setLoading(e.currentTarget, false); }
});

/* ---------- Profile & privacy rights ---------- */
function loadProfile() {
  const u = S.user;
  if (!u) return;
  const f = $('#profileForm');
  clearErrors(f);
  f.elements.name.value = u.name || '';
  f.elements.email.value = u.email || '';
  f.elements.accountType.value = ['household', 'restaurant', 'school', 'farmer'].includes(u.accountType) ? u.accountType : 'household';
  $('#prPhone').value = u.phone || '';
  $('#prMarketing').checked = Boolean(u.marketingOptIn);
  $('#deleteForm').hidden = true;
}
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  const d = formData(f);
  try {
    S.user = (await api('/api/me', { method: 'PATCH', body: { name: d.name, email: d.email || null, accountType: d.accountType, marketingOptIn: $('#prMarketing').checked } })).user;
    renderUser();
    toast('Profile saved', { type: 'success' });
  } catch (err) { showErrors(f, err); } finally { setLoading(btn, false); }
});
$('#deleteBtn').addEventListener('click', () => {
  const f = $('#deleteForm');
  f.hidden = !f.hidden;
  const bal = S.user?.ogyBalance || 0;
  $('#deleteWalletNote').hidden = bal <= 0;
  $('#forfeitRow').hidden = bal <= 0;
  $('#deleteWalletNote').textContent = bal > 0 ? `You still have ${ogy(bal)} (${ghs(bal)}) in your wallet.` : '';
  if (!f.hidden) $('#delConfirm').focus();
});
$('#deleteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    await api('/api/me/delete', { method: 'POST', body: { confirm: f.elements.confirm.value.trim(), confirmForfeit: f.elements.confirmForfeit.checked } });
    S.user = null;
    store.remove('ntn_delivery');
    store.remove('ntn_pending_order');
    await loadSession();
    renderUser();
    closeLayer();
    toast('Your account has been deleted.', { type: 'success', duration: 6000 });
  } catch (err) {
    showErrors(f, err);
    if (err.code === 'wallet_not_empty') { $('#forfeitRow').hidden = false; }
  } finally { setLoading(btn, false); }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  S.user = null;
  await loadSession();
  renderUser();
  closeLayer();
  toast('Signed out');
});

async function loadWallet() {
  if (!S.user) return;
  $('#walletTx').innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const w = await api('/api/wallet');
    S.user.ogyBalance = w.balance;
    renderUser();
    $('#walletTx').innerHTML = w.history.length ? w.history.map((t) => `
      <div class="tx"><div>${esc(titleCase(t.type))}<small>${formatDate(t.createdAt)}${t.reference ? ' · ' + esc(t.reference) : ''}</small></div>
      <b class="${t.amount > 0 ? 'good' : 'up'}">${t.amount > 0 ? '+' : '−'}${ogy(Math.abs(t.amount))}</b></div>`).join('')
      : '<p class="muted small">No activity yet.</p>';
  } catch (e) { $('#walletTx').innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}

$('#topPresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-amt]');
  if (b) { $('#topAmt').value = b.dataset.amt; updateTopHint(); }
});
function updateTopHint() {
  const v = Math.round(parseFloat($('#topAmt').value || '0') * 100);
  $('#topHint').textContent = v > 0 ? `You'll receive ${ogy(v)}.` : "You'll receive 100 OGY for every GH₵1.";
}
$('#topAmt').addEventListener('input', updateTopHint);
$('#topupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const amount = Math.round(parseFloat($('#topAmt').value) * 100);
  if (!(amount >= 100)) { showErrors(f, { message: 'Minimum top-up is GH₵1', fields: { amount: 'must be at least GH₵1' } }); return; }
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    const { payment } = await api('/api/wallet/topup', { method: 'POST', body: { amount, method: $('#topMethod').value } });
    safeRedirect(payment.authorizationUrl);
  } catch (err) { showErrors(f, err); setLoading(btn, false); }
});

const ORDER_STEPS = ['confirmed', 'processing', 'out_for_delivery', 'delivered'];
function orderTimeline(o) {
  if (o.status === 'cancelled') return '<p class="up small">This order was cancelled.</p>';
  if (o.status === 'pending_payment') return '<p class="small">Waiting for payment confirmation.</p>';
  const idx = ORDER_STEPS.indexOf(o.status);
  return `<ol class="timeline">${ORDER_STEPS.map((s, i) => `<li class="${i <= idx ? 'done' : ''}">${titleCase(s)}</li>`).join('')}</ol>`;
}
function orderRow(o) {
  return `<div class="list-row"><div><b>${esc(o.ref)}</b> <span class="status ${o.status}">${titleCase(o.status)}</span>
    <small>${formatDate(o.createdAt)} · ${o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join(', ')}</small></div><b>${ghs(o.total)}</b></div>`;
}
async function loadMyOrders() {
  const box = $('#myOrders');
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { orders } = await api('/api/orders/mine');
    box.innerHTML = orders.length ? orders.map(orderRow).join('') : '<p class="muted small">No orders yet.</p>';
  } catch (e) { box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}
async function loadMyCoupons() {
  const box = $('#myCoupons');
  box.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const { coupons } = await api('/api/coupons/mine');
    box.innerHTML = coupons.length ? coupons.map((c) => `<div class="list-row"><div><b>${esc(c.code)}</b> <span class="status ${c.status}">${c.status}</span>
      <small>For ${esc(c.recipientName)} · ${formatDate(c.createdAt, false)}</small></div><div class="num"><b>${ghs(c.balance)}</b><small>of ${ghs(c.initial)}</small></div></div>`).join('')
      : '<p class="muted small">No coupons yet. <a class="text-link" href="#coupons" data-close>Gift one</a></p>';
  } catch (e) { box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}

/* Track */
$('#trackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    const { order } = await api('/api/orders/track', { method: 'POST', body: formData(f) });
    $('#trackResult').innerHTML = `<div class="panel">${orderRow(order)}${orderTimeline(order)}<p class="small muted">Delivery: ${esc(order.deliverySlot)} · ${esc(order.town)}, ${esc(order.region)}</p></div>`;
  } catch (err) {
    $('#trackResult').innerHTML = '';
    showErrors(f, err);
  } finally { setLoading(btn, false); }
});

/* =====================================================================
   Coupons
   ===================================================================== */
function renderVouchers() {
  const labels = { 5000: 'Top-up basket', 10000: 'Weekly essentials', 25000: 'Family market run', 50000: 'Monthly provisions' };
  $('#voucherGrid').innerHTML = S.config.couponPresets.map((a) => `
    <button class="voucher ${S.voucherAmount === a ? 'selected' : ''}" type="button" role="radio" aria-checked="${S.voucherAmount === a}" data-v="${a}">
      ${icon('check', 'check')}<small>Ntintan Coupon</small><b>${ghs(a).replace('.00', '')}</b><span>${labels[a] || ''} · ${ogy(a)}</span>
    </button>`).join('');
  $('#cBtnLabel').textContent = `Buy ${ghs(S.voucherAmount)} coupon`;
}
$('#voucherGrid').addEventListener('click', (e) => {
  const v = e.target.closest('[data-v]');
  if (!v) return;
  S.voucherAmount = Number(v.dataset.v);
  renderVouchers();
});

function renderCouponMethods() {
  if (!S.config) return;
  const opts = [];
  if (S.user) opts.push(`<option value="ogya">Ogya wallet (${ogy(S.user.ogyBalance)})</option>`);
  if (S.config.onlinePayments) opts.push('<option value="momo">Mobile Money</option>', '<option value="card">Debit / credit card</option>');
  if (!opts.length) opts.push('<option value="ogya">Ogya wallet (sign in)</option>');
  $('#cMethod').innerHTML = opts.join('');
}

$('#couponForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  if (!S.user) { openAccount('signin'); toast('Sign in to buy a coupon'); return; }
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    const res = await api('/api/coupons', { method: 'POST', body: { ...formData(f), amount: S.voucherAmount } });
    if (res.payment) { safeRedirect(res.payment.authorizationUrl); return; }
    const c = res.coupon;
    $('#couponCreated').innerHTML = `<div class="small">${ghs(c.initial)} coupon for <b>${esc(c.recipientName)}</b></div><div class="coupon-code">${esc(c.code)}</div><button type="button" class="text-link" id="copyCode">${icon('copy')} Copy code</button>`;
    $('#copyCode').addEventListener('click', () => navigator.clipboard?.writeText(c.code).then(() => toast('Code copied', { type: 'success' }), () => toast('Copy failed — select the code instead')));
    f.reset();
    refreshUser();
    toast('Coupon created and sent to the receiver', { type: 'success' });
  } catch (err) { showErrors(f, err); } finally { setLoading(btn, false); }
});

$('#checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  const box = $('#couponResult');
  try {
    const { coupon } = await api('/api/coupons/check', { method: 'POST', body: { code: f.elements.code.value.trim().toUpperCase() } });
    box.innerHTML = `<div class="os-line"><span>Balance on ${esc(coupon.code)}</span><b>${ghs(coupon.balance)}</b></div><p class="small muted">${coupon.status === 'active' && coupon.balance > 0 ? 'Enter this code at checkout.' : 'This coupon can no longer be used.'}</p>`;
  } catch (err) {
    box.innerHTML = `<p class="up small">${icon('alert')} ${esc(err.status === 404 ? 'Code not found. Check it and try again.' : err.message)}</p>`;
  } finally { setLoading(btn, false); }
});

/* =====================================================================
   Partner & lead forms
   ===================================================================== */
const PARTNER_INFO = {
  business: { t: "Your kitchen's supply chain, sorted", p: 'From a chop bar in Adum to a hotel in Airport City: set your order once and we deliver on schedule.', b: [['calendar', 'Scheduled deliveries', 'Daily or weekly standing orders before your kitchen opens.'], ['tag', 'Wholesale pricing', 'Tonne, sack and crate prices from our market data.'], ['file', 'Invoices & credit terms', 'Monthly invoicing for approved businesses.'], ['shield', 'Quality guarantee', 'Anything below standard is replaced on the next drop.']] },
  school: { t: 'Feed more children, better, for less', p: 'Order by menu, not by item. Tell us pupil numbers and the timetable and we calculate and deliver the ingredients.', b: [['utensils', 'Menu-based ordering', 'Jollof, beans & gari, banku & okro — scaled per pupil.'], ['pin', 'Full traceability', 'Every delivery records farm, date and quantity.'], ['users', 'Buy local first', "Sourced from farmers in or near the school's district."], ['chart', 'Termly reports', 'Cost-per-pupil summaries for administrators.']] },
  farmer: { t: 'Sell your harvest to all of Ghana', p: 'Less spoilage, fewer middlemen, faster payment. We collect from farm gates and aggregation points.', b: [['phone', 'List by phone', "Tell us what's ready and when. No smartphone needed."], ['truck', 'We collect', 'Pickup from your farm or the nearest collection point.'], ['coins', 'Paid by MoMo', 'Payment sent when produce is graded and collected.'], ['handshake', 'Steady buyers', 'Households, restaurants and school programmes.']] }
};
function showPartner(k) {
  if (!PARTNER_INFO[k]) return;
  $$('#partnerTabs .tab-btn').forEach((b) => { const on = b.dataset.ptab === k; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $$('#partners .lead-form').forEach((f) => f.classList.toggle('active', f.id === `ptab-${k}`));
  const i = PARTNER_INFO[k];
  $('#partnerInfo').innerHTML = `<h3>${esc(i.t)}</h3><p>${esc(i.p)}</p>` + i.b.map(([ic, t, d]) => `<div class="benefit"><span class="ic">${icon(ic)}</span><div><b>${esc(t)}</b><span>${esc(d)}</span></div></div>`).join('');
}
$('#partnerTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-ptab]'); if (b) showPartner(b.dataset.ptab); });

$$('.lead-form').forEach((f) => f.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkForm(f)) return;
  const btn = $('button[type=submit]', f);
  setLoading(btn, true);
  try {
    await api(`/api/leads/${f.dataset.lead}`, { method: 'POST', body: formData(f) });
    f.reset();
    toast(f.dataset.msg, { type: 'success', duration: 5000 });
    if (f.hasAttribute('data-close-after')) closeLayer();
  } catch (err) { showErrors(f, err); } finally { setLoading(btn, false); }
}));

/* =====================================================================
   Market watch, farmers, measures, alerts
   ===================================================================== */
function rangeText(m, fmt = price) {
  const base = m.min === m.max ? fmt(m.min) : `${fmt(m.min)} – ${fmt(m.max)}`;
  return (m.approximate ? '~' : '') + base;
}

function renderMarket() {
  $('#trendGrid').innerHTML = S.history.map((h) => {
    const max = Math.max(h.previousPeak, h.current);
    const down = h.changePct < 0;
    return `<article class="trend-card">
      <header><h3>${h.emoji} ${esc(h.productName)}<small>${esc(h.unit)}</small></h3>
        <span class="trend-pill ${down ? 'down' : 'up'}">${icon(down ? 'trend-down' : 'trend-up')} ${down ? '' : '+'}${h.changePct.toFixed(1)}%</span></header>
      <div class="bars">
        <div class="bar-row"><span>${h.previousIsImplied ? 'Before*' : 'Peak'}</span><div class="bar prev"><i data-w="${(h.previousPeak / max) * 100}"></i></div><b>${price(h.previousPeak)}</b></div>
        <div class="bar-row"><span>Now</span><div class="bar"><i data-w="${(h.current / max) * 100}"></i></div><b>${price(h.current)}</b></div>
      </div>
      <p>${esc(h.reason)}${h.previousIsImplied ? ' · *implied previous price' : ''}</p>
    </article>`;
  }).join('');
  requestAnimationFrame(() => $$('#trendGrid .bar i').forEach((b) => { b.style.width = `${b.dataset.w}%`; }));

  $('#marketTable tbody').innerHTML = S.market.map((m) => {
    const p = byId(m.productId);
    return `<tr>
      <td>${m.emoji} ${p ? `<button type="button" class="link-btn" data-qv="${m.productId}">${esc(m.productName)}</button>` : esc(m.productName)}</td>
      <td><span class="type-chip ${m.priceType}">${esc(m.priceType)}</span></td>
      <td>${esc(m.unit)}</td>
      <td class="num">${rangeText(m, ghs)}</td>
      <td class="num">${rangeText(m, ogy)}</td>
      <td>${esc(m.market || '—')}</td>
      <td>${esc(m.notes || '—')}</td></tr>`;
  }).join('');
}

function initials(name) { return name.split(/\s+/).map((w) => w[0]).filter((c) => /[A-Za-z]/.test(c)).slice(0, 2).join('').toUpperCase(); }
function renderFarmers() {
  $('#farmerGrid').innerHTML = S.farmers.map((f) => {
    const farm = f.enterprise || 'Smallholder farm';
    return `
    <article class="farmer-card">
      <div class="top"><span class="avatar" aria-hidden="true">${esc(initials(farm))}</span>
        <div><h3>${esc(farm)}</h3>${f.enterprise ? '' : '<div class="ent">Name to be confirmed</div>'}</div></div>
      ${f.verified ? `<span class="verified">${icon('shield')} Verified partner</span>` : `<span class="verified unverified">${icon('info')} Details being confirmed</span>`}
      <p>${esc(f.notes)}</p>
      ${f.location || f.region ? `<div class="loc">${icon('pin')} ${esc([f.location, f.region].filter(Boolean).join(' · '))}</div>` : ''}
      <div class="chips">${f.focusCategories.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
    </article>`;
  }).join('');
}

function renderMeasures() {
  $('#measureGrid').innerHTML = S.units.map((u) => `
    <div class="measure"><b>${esc(u.name)}</b>${u.localName ? `<em>${esc(u.localName)}</em>` : ''}
      <div class="w">${esc(u.approxWeight || '')}</div><p>${esc(u.usedFor || '')}</p></div>`).join('');
}

const bell = $('#bellToggle');
const panel = $('#notifPanel');
function renderNotifications() {
  $('#notifList').innerHTML = S.history.map((h) => `
    <div class="notif-item">${icon(h.changePct < 0 ? 'trend-down' : 'trend-up', h.changePct < 0 ? 'down' : 'up')}
      <div>${esc(h.productName)} ${h.changePct < 0 ? 'down' : 'up'} ${Math.abs(h.changePct).toFixed(0)}% — now ${ghs(h.current)} ${esc(h.unit)}<small>${esc(h.reason)}</small></div></div>`).join('') || '<div class="notif-item">No alerts right now.</div>';
  const key = S.history.map((h) => `${h.id}:${h.current}`).join(',');
  $('#notifDot').hidden = !S.history.length || store.get('ntn_alerts_seen', '') === key;
  bell.addEventListener('change', () => {
    panel.classList.toggle('open', bell.checked);
    if (bell.checked) { $('#notifDot').hidden = true; store.set('ntn_alerts_seen', key); }
  });
}
function closeNotif() { panel.classList.remove('open'); bell.checked = false; }
document.addEventListener('click', (e) => { if (!e.target.closest('#alertsWrap') && panel.classList.contains('open')) closeNotif(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closeNotif(); });

/* =====================================================================
   Help chat (FAQ)
   ===================================================================== */
const chatWin = $('#chatWindow');
const chatMsgs = $('#chatMessages');
function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = `message ${who}-message`;
  d.textContent = text;
  chatMsgs.appendChild(d);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}
function openChat() {
  chatWin.hidden = false;
  $('#chatBubble').setAttribute('aria-expanded', 'true');
  if (!chatMsgs.children.length) addMsg("Akwaaba! Ask me about delivery, payments, food coupons, local measures, bulk orders or selling your harvest.", 'bot');
  setTimeout(() => $('#chatInput').focus(), 50);
}
function closeChat() { chatWin.hidden = true; $('#chatBubble').setAttribute('aria-expanded', 'false'); }
$('#chatBubble').addEventListener('click', () => (chatWin.hidden ? openChat() : closeChat()));
$('#closeChat').addEventListener('click', closeChat);
function reply(q) {
  q = q.toLowerCase();
  const fee = S.config ? ghs(S.config.deliveryFee) : 'GH₵25', free = S.config ? ghs(S.config.freeDeliveryThreshold) : 'GH₵300';
  if (/coupon|voucher|gift|send food/.test(q)) return 'Food coupons come in GH₵50, 100, 250 and 500. Sign in, choose an amount in Food Coupons and enter the receiver\'s phone. They get a code to use at checkout; unused balance stays on the code.';
  if (/halal|muslim|eid|sallah|zabiha|ram\b/.test(q)) return 'See Halal Foods: halal beef, goat, mutton, chicken and guinea fowl from certified abattoirs and butchers, and live rams for Eid and naming ceremonies. Ask for the halal certificate with your order. Halal orders are packed apart from pork and alcohol.';
  if (/wine|beer|drink|alcohol|spirit|gin|water|sobolo|asaana|palm wine|pito|juice/.test(q)) return 'See Wine & African Drinks: African wines and palm wine, Ghanaian beers and spirits (18+ only — ID checked on delivery), local soft drinks like sobolo, asaana and brukina, and premium still or sparkling water in glass bottles. Drink responsibly.';
  if (/measure|olonka|ololo|suro|kotokuo|heap|bucket|tin|unit/.test(q)) return 'We sell in local measures: an Olonka is about 2.5 kg, a margarine tin ~0.5 kg, a paint bucket 4.5 L, a bag/sack (kotokuo) 50 or 100 kg, and a heap is 3, 5 or 10 tubers. See the Local Measures Guide for all of them.';
  if (/school|feeding|pupil|caterer/.test(q)) return 'School caterers and feeding programmes order by menu and pupil count. Use the Schools tab under Partner with Ntintan and we\'ll call you within 24 hours.';
  if (/restaurant|hotel|bulk|wholesale|chop|tonne|sack/.test(q)) return 'For bulk and wholesale (sacks, crates, tonnes) use Request quote on any product, or the Restaurants form under Partner with Ntintan.';
  if (/sell|farmer|cooperative|harvest/.test(q)) return 'Farmers and co-ops register under Partner with Ntintan → Farmers. A field officer verifies you, we collect your produce and pay by Mobile Money.';
  if (/deliver|shipping|region|when|time/.test(q)) return `We deliver to all 16 regions. Delivery is ${fee}, free over ${free}. Choose a time slot at checkout and track your order with its number and your phone.`;
  if (/pay|momo|mtn|telecel|airteltigo|card|cash/.test(q)) return 'You can pay cash on delivery, with your Ogya wallet, or by MoMo/card through Paystack where available. Coupons work with any method.';
  if (/ogya|coin|token|wallet|ogy/.test(q)) return 'Ogya Coin is our wallet currency: 100 OGY = GH₵1. Top up from your account and get a discount when you pay with Ogya.';
  if (/price|market|cost|cheap/.test(q)) return 'See Market Watch for current wholesale and retail prices. Tomatoes and cassava are down a lot from their peaks right now.';
  if (/track|order|where/.test(q)) return 'Use Track Order in the menu with your order number (NTN-…) and the phone you used.';
  if (/hello|hi\b|hey|akwaaba|maakye/.test(q)) return 'Akwaaba! How can I help?';
  if (/thank|medaase/.test(q)) return 'Medaase! Anything else?';
  return 'I can help with delivery, payments, coupons, measures, bulk supply, school feeding or selling produce. For anything else, leave your number in the Restaurants form and we\'ll call you.';
}
function sendChat(t) {
  t = t.trim().slice(0, 300);
  if (!t) return;
  addMsg(t, 'user');
  $('#chatInput').value = '';
  setTimeout(() => addMsg(reply(t), 'bot'), 350);
}
$('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chatInput').value); });
$('#quickReplies').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') sendChat(e.target.textContent); });

/* Deep links: #products?cat=, ?track= */
function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('track');
  if (ref) { $('#tRef').value = ref.slice(0, 20); openLayerEl($('#trackModal')); }
}

boot();
