'use strict';
/**
 * Configuration loader. Reads .env (if present) without overriding real
 * environment variables, validates values and freezes the result.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

if (process.env.NODE_ENV !== 'test') loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const int = (name, def, min = 0) => {
  const v = env[name] === undefined || env[name] === '' ? def : Number(env[name]);
  if (!Number.isInteger(v) || v < min) throw new Error(`Config ${name} must be an integer >= ${min}`);
  return v;
};

const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
// Public demo/preview (e.g. for investors): production security, but simulated payments and on-screen sign-in codes,
// a "demo" banner on every page and no search-engine indexing. Never use for a real shop.
const DEMO_MODE = env.DEMO_MODE === '1' || env.DEMO_MODE === 'true';

let APP_SECRET = env.APP_SECRET || '';
if (APP_SECRET.length < 32) {
  if (isProd) throw new Error('APP_SECRET must be set to at least 32 characters in production');
  APP_SECRET = 'dev-only-insecure-secret-do-not-use-in-production-0000';
}

let PAYMENTS_MODE = (env.PAYMENTS_MODE || (isProd ? 'disabled' : 'simulate')).toLowerCase();
if (!['paystack', 'simulate', 'disabled'].includes(PAYMENTS_MODE)) throw new Error('PAYMENTS_MODE must be paystack, simulate or disabled');
if (PAYMENTS_MODE === 'simulate' && isProd && !DEMO_MODE) throw new Error('PAYMENTS_MODE=simulate is not allowed in production (set DEMO_MODE=1 for a public demo)');
if (DEMO_MODE && PAYMENTS_MODE === 'paystack' && /^sk_live_/.test(env.PAYSTACK_SECRET_KEY || '')) throw new Error('DEMO_MODE must not use a live Paystack key');
if (PAYMENTS_MODE === 'paystack' && !/^sk_(live|test)_/.test(env.PAYSTACK_SECRET_KEY || '')) {
  throw new Error('PAYMENTS_MODE=paystack requires PAYSTACK_SECRET_KEY (sk_live_… or sk_test_…)');
}

let SMS_MODE = (env.SMS_MODE || (isProd ? 'sailup' : 'log')).toLowerCase();
if (!['sailup', 'log'].includes(SMS_MODE)) throw new Error('SMS_MODE must be sailup or log');
if (SMS_MODE === 'log' && isProd && !DEMO_MODE) throw new Error('SMS_MODE=log is not allowed in production (customers could not receive login codes)');
if (SMS_MODE === 'sailup') {
  if (!/^sailup_/.test(env.SAILUP_API_KEY || '')) throw new Error('SMS_MODE=sailup requires SAILUP_API_KEY (starts with sailup_)');
  if (!/^[A-Za-z0-9 ]{3,11}$/.test(env.SAILUP_SENDER_ID || '')) throw new Error('SMS_MODE=sailup requires SAILUP_SENDER_ID (registered sender name, 3–11 letters/digits)');
}

const PORT = int('PORT', 3000, 0);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
if (isProd && !PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL must use https:// in production');

const config = Object.freeze({
  ROOT,
  NODE_ENV,
  isProd,
  DEMO_MODE,
  HOST: env.HOST || '0.0.0.0',
  PORT,
  PUBLIC_URL,
  TRUST_PROXY: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  DATABASE_PATH: path.resolve(ROOT, env.DATABASE_PATH || './data/ntintan.db'),
  BACKUP_DIR: path.resolve(ROOT, env.BACKUP_DIR || './data/backups'),
  APP_SECRET,
  ADMIN_EMAIL: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  PAYMENTS_MODE,
  PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY || '',
  PAYSTACK_BASE: env.PAYSTACK_BASE || 'https://api.paystack.co',
  SMS_MODE,
  SAILUP_API_KEY: env.SAILUP_API_KEY || '',
  SAILUP_SENDER_ID: env.SAILUP_SENDER_ID || '',
  SAILUP_BASE: (env.SAILUP_BASE || 'https://api.sailup.io/v1').replace(/\/+$/, ''),
  SAILUP_WEBHOOK_SECRET: env.SAILUP_WEBHOOK_SECRET || '',
  ADMIN_PHONE: env.ADMIN_PHONE || '',
  OTP_TTL_MINUTES: int('OTP_TTL_MINUTES', 5, 1),
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_SECONDS: int('OTP_RESEND_SECONDS', 60, 10),
  OTP_MAX_PER_HOUR: int('OTP_MAX_PER_HOUR', 5, 1),
  TERMS_VERSION: env.TERMS_VERSION || '2026-10-28.1',
  LEGAL: Object.freeze({
    COMPANY_NAME: env.LEGAL_COMPANY_NAME || '[Company legal name — set LEGAL_COMPANY_NAME]',
    TRADING_NAME: env.LEGAL_TRADING_NAME || 'Ntintan Groceries',
    REG_NUMBER: env.LEGAL_REG_NUMBER || '[Registrar-General company number — set LEGAL_REG_NUMBER]',
    ADDRESS: env.LEGAL_ADDRESS || '[Registered office address and GhanaPost GPS — set LEGAL_ADDRESS]',
    SUPPORT_PHONE: env.LEGAL_SUPPORT_PHONE || '[Support phone — set LEGAL_SUPPORT_PHONE]',
    SUPPORT_EMAIL: env.LEGAL_SUPPORT_EMAIL || '[support email — set LEGAL_SUPPORT_EMAIL]',
    PRIVACY_EMAIL: env.LEGAL_PRIVACY_EMAIL || env.LEGAL_SUPPORT_EMAIL || '[privacy email — set LEGAL_PRIVACY_EMAIL]',
    DPC_NUMBER: env.LEGAL_DPC_NUMBER || '[Data Protection Commission registration no. — set LEGAL_DPC_NUMBER]',
    HOSTING_LOCATION: env.LEGAL_HOSTING_LOCATION || '[hosting country — set LEGAL_HOSTING_LOCATION]',
    LIQUOR_LICENCE: env.LEGAL_LIQUOR_LICENCE || '[liquor licence no. and issuing assembly — set LEGAL_LIQUOR_LICENCE]'
  }),
  CUSTOMER_EMAIL_DOMAIN: env.CUSTOMER_EMAIL_DOMAIN || 'customers.ntintan.local',
  DELIVERY_FEE: int('DELIVERY_FEE_PESEWAS', 2500),
  FREE_DELIVERY_THRESHOLD: int('FREE_DELIVERY_THRESHOLD_PESEWAS', 30000),
  OGYA_DISCOUNT_BPS: int('OGYA_DISCOUNT_BPS', 500),
  UNPAID_ORDER_TTL_MINUTES: int('UNPAID_ORDER_TTL_MINUTES', 60, 5),
  SESSION_TTL_DAYS: 7,
  MAX_BODY_BYTES: 64 * 1024,
  OGY_PER_GHS: 100 // 100 OGY = 1 GHS → 1 OGY = 1 pesewa
});

if (DEMO_MODE) console.warn('[setup] DEMO_MODE is on: simulated payments, sign-in codes shown on screen, hidden from search engines. Not for real customers.');
if (isProd && !DEMO_MODE) {
  const missing = Object.entries(config.LEGAL).filter(([, v]) => v.startsWith('[')).map(([k]) => `LEGAL_${k}`);
  if (missing.length) console.warn(`[setup] Legal pages show placeholders until you set: ${missing.join(', ')}`);
}

module.exports = config;
