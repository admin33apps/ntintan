'use strict';
/**
 * SQLite database (Node's built-in node:sqlite). All money columns are
 * INTEGER pesewas (1 GHS = 100 pesewas = 100 OGY).
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    local_name TEXT,
    approx_weight TEXT,
    used_for TEXT
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    local_name TEXT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    default_unit_id INTEGER REFERENCES units(id),
    notes TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '🌱',
    price_pesewas INTEGER CHECK (price_pesewas IS NULL OR price_pesewas > 0),
    price_unit_id INTEGER REFERENCES units(id),
    price_unit_label TEXT,
    stock INTEGER CHECK (stock IS NULL OR stock >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    featured INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_products_category ON products(category_id);

  CREATE TABLE market_prices (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    price_type TEXT NOT NULL,
    unit_label TEXT NOT NULL,
    min_pesewas INTEGER NOT NULL,
    max_pesewas INTEGER NOT NULL,
    approximate INTEGER NOT NULL DEFAULT 0,
    market TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT (date('now'))
  );
  CREATE TABLE price_history (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_label TEXT NOT NULL,
    previous_peak_pesewas INTEGER NOT NULL,
    current_pesewas INTEGER NOT NULL,
    change_bps INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    previous_is_implied INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE farmers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    enterprise TEXT,
    location TEXT,
    region TEXT,
    focus_category_ids TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'household',
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
    password_hash TEXT NOT NULL,
    ogy_balance INTEGER NOT NULL DEFAULT 0 CHECK (ogy_balance >= 0),
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,               -- sha256(token)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id),
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    region TEXT NOT NULL,
    town TEXT NOT NULL,
    address TEXT NOT NULL,
    delivery_slot TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL CHECK (payment_method IN ('momo','card','ogya','cash','coupon')),
    status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','processing','out_for_delivery','delivered','cancelled')),
    subtotal INTEGER NOT NULL,
    delivery_fee INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    coupon_code TEXT,
    coupon_amount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL CHECK (total >= 0),
    paid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_orders_user ON orders(user_id);
  CREATE INDEX idx_orders_status ON orders(status);
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    unit_label TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    line_total INTEGER NOT NULL
  );
  CREATE INDEX idx_items_order ON order_items(order_id);

  CREATE TABLE coupons (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    initial_pesewas INTEGER NOT NULL CHECK (initial_pesewas > 0),
    balance_pesewas INTEGER NOT NULL CHECK (balance_pesewas >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending','active','void')),
    purchaser_user_id INTEGER REFERENCES users(id),
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'purchase',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE coupon_redemptions (
    id INTEGER PRIMARY KEY,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    amount INTEGER NOT NULL,
    reversed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE wallet_tx (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount_ogy INTEGER NOT NULL,     -- signed
    balance_after INTEGER NOT NULL,
    reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_wallet_user ON wallet_tx(user_id);

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL CHECK (purpose IN ('order','coupon','topup')),
    target_id INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id),
    amount_pesewas INTEGER NOT NULL CHECK (amount_pesewas > 0),
    currency TEXT NOT NULL DEFAULT 'GHS',
    channel TEXT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('initialized','success','failed','abandoned')),
    provider_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('business','school','farmer','newsletter','quote','contact')),
    name TEXT,
    phone TEXT,
    email TEXT,
    region TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `
];

// v2 — phone OTP accounts, SMS log, refunds, terms acceptance, privacy
MIGRATIONS.push({
  fkOff: true,
  sql: `
  CREATE TABLE users_v2 (
    id INTEGER PRIMARY KEY,
    phone TEXT UNIQUE,
    email TEXT UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'household',
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
    password_hash TEXT,
    ogy_balance INTEGER NOT NULL DEFAULT 0 CHECK (ogy_balance >= 0),
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    terms_version TEXT,
    terms_accepted_at TEXT,
    marketing_opt_in INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO users_v2 (id, phone, email, name, account_type, role, password_hash, ogy_balance, failed_logins, locked_until, created_at)
    SELECT id,
      CASE WHEN phone IS NOT NULL AND id = (SELECT MIN(u2.id) FROM users u2 WHERE u2.phone = users.phone) THEN phone ELSE NULL END,
      email, name, account_type, role, password_hash, ogy_balance, failed_logins, locked_until, created_at
    FROM users;
  DROP TABLE users;
  ALTER TABLE users_v2 RENAME TO users;

  CREATE TABLE otp_codes (
    id INTEGER PRIMARY KEY,
    phone TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('login','admin')),
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    signup_token_hash TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_otp_phone ON otp_codes(phone, purpose, created_at);

  CREATE TABLE sms_log (
    id INTEGER PRIMARY KEY,
    recipient TEXT NOT NULL,
    purpose TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','failed','expired','rejected','logged')),
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_sms_provider ON sms_log(provider_id);

  ALTER TABLE payments ADD COLUMN refund_status TEXT;
  ALTER TABLE payments ADD COLUMN refund_amount INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payments ADD COLUMN refund_error TEXT;
  ALTER TABLE orders ADD COLUMN terms_version TEXT;
  `
});

// v3 — drinks: sub-categories, age-restricted (alcohol) products, age confirmation on orders
MIGRATIONS.push(`
  ALTER TABLE products ADD COLUMN subcategory TEXT;
  ALTER TABLE products ADD COLUMN age_restricted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN age_confirmed INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_products_sub ON products(subcategory);
`);

// v4 — African beverage makers (brands) linked to products
MIGRATIONS.push(`
  CREATE TABLE brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL,
    country_codes TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT ''
  );
  ALTER TABLE products ADD COLUMN brand_id INTEGER REFERENCES brands(id);
  ALTER TABLE products ADD COLUMN verify_abv INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_products_brand ON products(brand_id);
`);

// v5 — halal-certified products (set by admins; never pork or alcohol)
MIGRATIONS.push(`
  ALTER TABLE products ADD COLUMN halal INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_products_halal ON products(halal);
`);

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    if (m.fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(m.sql);
        if (m.fkOff) {
          const bad = db.prepare('PRAGMA foreign_key_check').all();
          if (bad.length) throw new Error(`Migration ${v + 1} broke ${bad.length} foreign key(s)`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (m.fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** Run fn inside a transaction (nested calls reuse the outer transaction). */
function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.__inTx = false;
  }
}

module.exports = { open, tx };
