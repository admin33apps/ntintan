'use strict';
// Pre-launch check: npm run check:prod
// Loads .env exactly as the server does and reports anything that would break or embarrass a launch.
const config = require('../src/config'); // throws on fatal misconfiguration (missing keys, simulate mode in prod, …)
const env = process.env;

const errors = [];
const warnings = [];
const placeholder = /example\.com|xxxx|change-me|^0240000000$|^0300000000$|CS000000000/;

if (!config.isProd) errors.push('NODE_ENV is not "production"');
if (env.DOMAIN && config.PUBLIC_URL !== `https://${env.DOMAIN}`) errors.push(`PUBLIC_URL (${config.PUBLIC_URL}) should be https://${env.DOMAIN}`);
if (!env.DOMAIN) warnings.push('DOMAIN is not set (required for Docker Compose / Caddy)');
for (const k of ['DOMAIN', 'PUBLIC_URL', 'APP_SECRET', 'SAILUP_API_KEY', 'PAYSTACK_SECRET_KEY', 'ADMIN_EMAIL', 'ADMIN_PHONE', 'CUSTOMER_EMAIL_DOMAIN']) {
  if (env[k] && placeholder.test(env[k])) errors.push(`${k} still has the example value`);
}
for (const [k, val] of Object.entries(config.LEGAL)) {
  if (val.startsWith('[') || placeholder.test(val)) warnings.push(`LEGAL_${k} is not set (legal pages show a placeholder)`);
}
if (config.PAYMENTS_MODE === 'paystack' && config.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) warnings.push('Paystack is using a TEST key: no real money will be collected');
if (config.PAYMENTS_MODE === 'disabled') warnings.push('PAYMENTS_MODE=disabled: only cash on delivery, wallet and coupons are offered');
if (config.SMS_MODE === 'sailup' && !config.SAILUP_WEBHOOK_SECRET) warnings.push('SAILUP_WEBHOOK_SECRET is empty: SMS delivery status will not be tracked');
if (config.DEMO_MODE) warnings.push('DEMO_MODE is on: this is a preview site (no real payments or SMS). Turn it off for the real shop');
if (config.ADMIN_PASSWORD) warnings.push('ADMIN_PASSWORD is set: remove ADMIN_EMAIL/ADMIN_PASSWORD from .env after the first start');

console.log(`Ntintan pre-launch check — ${config.PUBLIC_URL} (payments: ${config.PAYMENTS_MODE}, sms: ${config.SMS_MODE})`);
warnings.forEach((w) => console.log(`  WARN  ${w}`));
errors.forEach((e) => console.log(`  FAIL  ${e}`));
if (errors.length) { console.log(`\n${errors.length} problem(s) must be fixed before launch.`); process.exit(1); }
console.log(warnings.length ? '\nReady to launch, but review the warnings above.' : '\nAll checks passed. Ready to launch.');
