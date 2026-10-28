'use strict';
const { HttpError } = require('../lib/http');

module.exports = function catalogService({ db }) {
  const PRODUCT_SQL = `
    SELECT p.*, c.name AS category_name, c.slug AS category_slug,
           b.name AS brand_name, b.country AS brand_country, b.country_codes AS brand_codes,
           du.name AS default_unit_name, du.local_name AS default_unit_local, du.approx_weight AS default_unit_weight,
           pu.name AS price_unit_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN units du ON du.id = p.default_unit_id
    LEFT JOIN units pu ON pu.id = p.price_unit_id
    LEFT JOIN brands b ON b.id = p.brand_id`;

  const mapProduct = (r) => ({
    id: r.id,
    name: r.name,
    localName: r.local_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categorySlug: r.category_slug,
    subcategory: r.subcategory || null,
    ageRestricted: Boolean(r.age_restricted),
    verifyAbv: Boolean(r.verify_abv),
    halal: Boolean(r.halal),
    brand: r.brand_id ? { id: r.brand_id, name: r.brand_name, country: r.brand_country, countryCodes: r.brand_codes ? r.brand_codes.split(',') : [] } : null,
    notes: r.notes,
    emoji: r.emoji,
    defaultUnit: r.default_unit_id ? { id: r.default_unit_id, name: r.default_unit_name, localName: r.default_unit_local, approxWeight: r.default_unit_weight } : null,
    price: r.price_pesewas,                     // pesewas; null = price on request
    priceUnit: r.price_pesewas ? (r.price_unit_label || r.price_unit_name || r.default_unit_name || 'unit') : null,
    purchasable: Boolean(r.active && r.price_pesewas && (r.stock === null || r.stock > 0)),
    inStock: r.stock === null || r.stock > 0,
    stock: r.stock,
    active: Boolean(r.active),
    featured: Boolean(r.featured),
    updatedAt: r.updated_at
  });

  function categories() {
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
      FROM categories c ORDER BY c.id`).all()
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, productCount: c.product_count }));
  }

  function units() {
    return db.prepare('SELECT * FROM units ORDER BY id').all()
      .map((u) => ({ id: u.id, name: u.name, localName: u.local_name, approxWeight: u.approx_weight, usedFor: u.used_for }));
  }

  function products({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE p.active = 1';
    return db.prepare(`${PRODUCT_SQL} ${where} ORDER BY p.featured DESC, (p.price_pesewas IS NULL), p.category_id, p.name`).all().map(mapProduct);
  }

  function product(id, { includeInactive = false } = {}) {
    const r = db.prepare(`${PRODUCT_SQL} WHERE p.id = ?`).get(id);
    if (!r || (!r.active && !includeInactive)) throw new HttpError(404, 'Product not found');
    return mapProduct(r);
  }

  function marketPrices() {
    return db.prepare(`SELECT m.*, p.name AS product_name, p.emoji FROM market_prices m JOIN products p ON p.id = m.product_id ORDER BY m.price_type DESC, m.id`).all()
      .map((m) => ({
        id: m.id, productId: m.product_id, productName: m.product_name, emoji: m.emoji, priceType: m.price_type,
        unit: m.unit_label, min: m.min_pesewas, max: m.max_pesewas, approximate: Boolean(m.approximate),
        market: m.market, notes: m.notes, recordedAt: m.recorded_at
      }));
  }

  function priceHistory() {
    return db.prepare(`SELECT h.*, p.name AS product_name, p.emoji FROM price_history h JOIN products p ON p.id = h.product_id ORDER BY h.id`).all()
      .map((h) => ({
        id: h.id, productId: h.product_id, productName: h.product_name, emoji: h.emoji, unit: h.unit_label,
        previousPeak: h.previous_peak_pesewas, current: h.current_pesewas, changePct: h.change_bps / 100,
        reason: h.reason, previousIsImplied: Boolean(h.previous_is_implied)
      }));
  }

  function brands() {
    return db.prepare(`SELECT b.*,
        (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.active = 1) AS product_count,
        (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.active = 1 AND p.age_restricted = 1) AS alcohol_count,
        (SELECT group_concat(name, '|') FROM (SELECT name FROM products p WHERE p.brand_id = b.id AND p.active = 1 ORDER BY p.id)) AS product_names
      FROM brands b ORDER BY b.name`).all().map((b) => ({
      id: b.id, name: b.name, country: b.country, countryCodes: b.country_codes ? b.country_codes.split(',') : [], notes: b.notes,
      productCount: b.product_count, alcoholCount: b.alcohol_count, products: b.product_names ? b.product_names.split('|') : []
    }));
  }

  // Personal names are only returned to admins; the public directory shows farm/enterprise names.
  function farmers({ includeUnverified = true, includePersonal = false } = {}) {
    const cats = Object.fromEntries(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
    const rows = db.prepare(`SELECT * FROM farmers ${includeUnverified ? '' : 'WHERE verified = 1'} ORDER BY verified DESC, id`).all();
    return rows.map((f) => {
      const ids = f.focus_category_ids ? f.focus_category_ids.split(',').map(Number).filter(Boolean) : [];
      const out = {
        id: f.id, enterprise: f.enterprise, location: f.location, region: f.region,
        focusCategoryIds: ids, focusCategories: ids.map((i) => cats[i]).filter(Boolean), notes: f.notes, verified: Boolean(f.verified)
      };
      if (includePersonal) out.name = f.name;
      return out;
    });
  }

  function updateProduct(id, patch) {
    product(id, { includeInactive: true });
    const sets = [];
    const vals = [];
    const map = { price: 'price_pesewas', priceUnitLabel: 'price_unit_label', stock: 'stock', active: 'active', featured: 'featured', notes: 'notes', emoji: 'emoji', ageRestricted: 'age_restricted', verifyAbv: 'verify_abv', halal: 'halal' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    db.prepare(`UPDATE products SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
    return product(id, { includeInactive: true });
  }

  function upsertFarmer(id, f) {
    const vals = [f.name, f.enterprise, f.location, f.region, (f.focusCategoryIds || []).join(','), f.notes || '', f.verified ? 1 : 0];
    if (id) {
      const r = db.prepare('UPDATE farmers SET name=?, enterprise=?, location=?, region=?, focus_category_ids=?, notes=?, verified=? WHERE id = ?').run(...vals, id);
      if (!r.changes) throw new HttpError(404, 'Farmer not found');
      return id;
    }
    return Number(db.prepare('INSERT INTO farmers (name, enterprise, location, region, focus_category_ids, notes, verified) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...vals).lastInsertRowid);
  }

  function deleteFarmer(id) {
    if (!db.prepare('DELETE FROM farmers WHERE id = ?').run(id).changes) throw new HttpError(404, 'Farmer not found');
  }

  return { categories, units, products, product, marketPrices, priceHistory, farmers, brands, updateProduct, upsertFarmer, deleteFarmer };
};
