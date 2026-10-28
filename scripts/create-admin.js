'use strict';
// Usage: npm run create-admin -- admin@example.com "A long password" 0241234567 ["Full Name"]
// The phone receives the one-time code for 2-step sign-in (required in production).
const config = require('../src/config');
const db = require('../src/db').open(config.DATABASE_PATH);
const { v } = require('../src/lib/validate');
const [email, password, phoneRaw, name = 'Administrator'] = process.argv.slice(2);
let phone = null;
try { phone = phoneRaw ? v.phone()(phoneRaw) : null; } catch { console.error('Phone must be a valid Ghana number, e.g. 0241234567'); process.exit(1); }
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !password || password.length < 12 || (config.isProd && !phone)) {
  console.error('Usage: npm run create-admin -- <email> "<password, 12+ chars>" <phone> ["Full Name"]');
  process.exit(1);
}
const auth = require('../src/services/auth')({ db, config, audit: () => {}, otp: null, sms: null });
const id = auth.createAdmin(email.toLowerCase(), password, name, phone);
console.log(`Admin ready: ${email} (user #${id})${phone ? `, 2-step codes go to ${phone}` : ' — no phone set (2-step disabled, dev only)'}`);
db.close();
