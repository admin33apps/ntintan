# Ntintan Groceries

Ghana's farm-to-table marketplace: fresh produce, proteins and staples sold in local market measures (Olonka, ololo, suro, heaps, buckets), live market prices, a farmer directory, food coupons, an Ogya Coin wallet (**100 OGY = GH₵1**), restaurant and school-feeding supply, and an admin back office.

- **Sign-in:** phone number + one-time SMS code delivered by **[Sailup](https://www.sailup.io/docs)**. Staff use a password plus an SMS code (2-step).
- **Payments:** **Paystack** for MTN MoMo, Telecel Cash, AirtelTigo Money and cards, with automatic refunds when a paid order is cancelled.
- **Legal:** a Terms of Sale & Customer Conditions page (`/terms`) and a Privacy Notice & Data Policy (`/privacy`). The structure follows Jumia Ghana's buyer terms, but the text was written for Ntintan and Ghanaian law. Customers can download or delete their own data, as the Data Protection Act, 2012 (Act 843) provides.

- **Zero third-party dependencies.** It runs on Node.js built-ins only: `http`, `crypto`, `zlib` and the built-in `node:sqlite` database. There is no npm supply-chain risk and nothing to `npm install`.
- **Server-side money.** All prices, discounts, delivery fees and totals are computed on the server and stored as integer pesewas. Anything the browser sends as a price is ignored.
- **The original monochrome Ntintan theme**, with no inline scripts or styles, so a strict Content-Security-Policy can be enforced.

---

## Quick start (development)

Requires **Node.js 22.13 or newer**.

```bash
cp .env.example .env
# edit .env: NODE_ENV=development, PAYMENTS_MODE=simulate, SMS_MODE=log,
#            ADMIN_EMAIL / ADMIN_PASSWORD (12+ chars) / ADMIN_PHONE
npm start
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

With `PAYMENTS_MODE=simulate`, MoMo and card payments go to a local **test payment** page where you can approve or decline. With `SMS_MODE=log`, no SMS is sent. Sign-in codes are printed in the server log and shown in a yellow "development mode" box on the sign-in screen. **The server refuses to start with either setting in production.**

Run the test suite (49 integration tests, including mock Paystack and Sailup servers):

```bash
npm test
```

---

## What's included

| Area | Features |
|---|---|
| **Catalogue** | 9 categories, 72 products with local names, 17 local measures. Products with a price can be bought now; the rest show **Request quote**. Admins can set a price for any product in the dashboard. |
| **Wine & African Drinks** | 127 drinks in 4 groups (wine; beers, ciders & spirits; soft drinks; premium water). 111 named products come from **30 African makers in 15 countries**, such as ABL, Kasapreko, GIHOC, Guinness Nigeria, EABL, SAB, KWV, Distell and Twellium (`src/seed-brands.js`). The other 16 are traditional drinks: palm wine, pito, akpeteshie, sobolo, asaana, brukina and glass-bottled waters. Customers can filter by country (with flags) and maker, and the **Meet the Makers** directory has a card per maker. Search covers maker and country. Alcohol is marked 18+, hidden until the age check (including product names in the makers directory), and carries the FDA warnings. Checkout requires an 18+ confirmation, and the rider checks ID. Alcohol can't be bought on school accounts or with programme coupons. Four drinks whose alcohol content wasn't certain are listed as 18+ and flagged *Check label* in admin until confirmed. All drinks start as "Price on request". |
| **Market Watch** | Wholesale, spot and retail prices (GH₵ and OGY), price-trend cards (cassava −25.1%, tomatoes −53.7%, plantain +10%) and bell-icon price alerts. |
| **Farmers** | Directory of the 11 farmers/enterprises. Smallholders whose details are unconfirmed are marked "details being confirmed". |
| **Bag & checkout** | Quantity steppers, undo on remove, a free-delivery progress bar, and a server-priced order summary. Payment by cash on delivery, Ogya wallet (5% off), coupon, MTN MoMo / Telecel Cash / AirtelTigo Money, or card via Paystack. Covers all 16 regions, GhanaPost GPS addresses and delivery time slots. |
| **Orders** | Order numbers like `NTN-XXXXXX`, tracking by order number + phone, an order history page, and the workflow pending payment → confirmed → processing → out for delivery → delivered. Cancelling an order restores stock, coupon balances and Ogya automatically. Unpaid online orders are cancelled after 60 minutes. |
| **Ogya wallet** | Balances are stored in OGY (1 OGY = 1 pesewa). Top-up by MoMo/card, or cash credited by an admin (recorded in the audit log). Full transaction history. |
| **Food coupons** | GH₵50 / 100 / 250 / 500, paid with Ogya or online. Codes look like `NTN-XXXX-XXXX`. Balances can be spent across several orders. Admins can issue coupons for schools or relief programmes and void them. The balance check reveals no personal data. |
| **Partners** | Restaurant/hotel quotes, school-feeding partnerships, farmer registration, product quotes and the newsletter. All arrive in Admin → Leads. |
| **Sign-in (OTP)** | Phone number, then a 6-digit SMS code. Codes are random, stored only as an HMAC, expire after 5 minutes and are single use. Each code allows 5 wrong attempts, there's a 60-second resend cooldown, a limit of 5 codes per number per hour, and 10 requests per IP every 15 minutes. New customers complete their name, optional email, account type, and terms acceptance (18+) after verifying the code, so the sign-in screen never reveals whether a number is registered. Staff can't use the customer flow. |
| **Legal & privacy** | `/terms` and `/privacy` are filled in from your `LEGAL_*` settings. Customers tick the terms at sign-up and checkout, and the accepted version is stored on each order and account. Raising `TERMS_VERSION` asks everyone to accept again. In **Account → Profile**, customers can edit their details and marketing choice, download a JSON copy of their data, and delete their account. Deletion anonymises the account but keeps order and financial records without identity. A nightly job applies the retention periods stated in the Privacy Notice. |
| **Refunds** | When you cancel a paid MoMo or card order in admin, the customer is refunded through the Paystack Refund API. A payment that arrives after an order was auto-cancelled is refunded automatically. Refund status (pending / processed / failed) is updated from Paystack webhooks and shown on the order, with a retry button. Ogya and coupon payments are returned instantly. |
| **Admin** | Dashboard (revenue, open orders, wallet liability, coupon balances, low stock), orders, products & prices, coupons, farmers (create/edit/delete), leads, customers (credit Ogya), audit log. |
| **UX** | Responsive down to 320 px, dark mode (remembered), GH₵/OGY display toggle, keyboard accessible (focus trapping, Esc to close, `/` to search), reduced-motion support, skeleton loading, friendly error messages. |

---

## Security

| Control | Implementation |
|---|---|
| Customer auth | Phone + one-time SMS code (no passwords to leak). Codes are stored as HMAC-SHA256, compared in constant time, and failed attempts are always counted. |
| Staff auth | Password (scrypt) **plus** an SMS code to the admin's phone. A password alone gives no access. |
| Passwords | scrypt (N=16384, r=8, p=1) with a per-user salt; timing-safe comparison. Unknown emails take the same time as wrong passwords. |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie (with the `__Host-` prefix in production). Only the SHA-256 of the token is stored. Sessions are rotated on login and all revoked on password change. They expire after 7 days. |
| CSRF | A double-submit token (`X-CSRF-Token` header must match the cookie) plus an `Origin` check on every state-changing request. |
| Brute force | Per-IP rate limits (API, auth, lookups, writes). Accounts lock for 15 minutes after 5 failed logins. |
| Input | Every endpoint validates input against a schema (types, lengths, enums, Ghana phone numbers), strips control characters, and rejects bodies over 64 KB or non-JSON. |
| SQL | Parameterised statements only. |
| XSS | All output is escaped in the browser. Strict CSP: `script-src 'self'; style-src 'self'`, with no inline code and no third-party scripts. |
| Headers | CSP, HSTS (production), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP. |
| SMS | Sailup Bearer API key kept server-side. Sign-in codes are never written to the SMS log. Delivery webhooks are verified with HMAC-SHA256 over `timestamp.body`, and anything older than 5 minutes is rejected. Messages are kept GSM-7 safe (no ₵ or emoji) so each fits one 160-character SMS. |
| Payments | Paystack **verify-after-callback**: amount and currency are re-checked against the database before an order is fulfilled. Webhooks are verified with HMAC-SHA512 in constant time. Fulfilment is idempotent, so replays are harmless. Redirects are only allowed to Paystack or this site. |
| Money integrity | Integer pesewas, `CHECK` constraints (balances can't go negative), transactions for every multi-step change, atomic stock decrements. |
| Static files | Path-traversal protection, dotfiles blocked, the simulator page is hidden outside simulate mode. |
| Config | The server refuses to start in production with a weak `APP_SECRET`, a non-HTTPS `PUBLIC_URL` or simulated payments. |
| Audit | Logins, failures, orders, cancellations, payments, price edits, wallet credits and coupon issue/void are all logged. |
| Privacy | SMS log lines mask phone numbers. Public order views don't expose addresses or phone numbers. |

---

## Deploying to production

### Option A: Docker Compose (recommended)

1. Point your domain's DNS (`A` records for `your-domain` and `www.your-domain`) at the server, and open ports 80 and 443.
2. Create `.env` from `.env.example` with **production** values:
   - `NODE_ENV=production`
   - `DOMAIN=your-domain` and `PUBLIC_URL=https://your-domain`
   - `APP_SECRET`: generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters), `ADMIN_PHONE`. Remove the email and password after the first start.
   - `PAYMENTS_MODE=paystack` and `PAYSTACK_SECRET_KEY=sk_live_…`
   - `SMS_MODE=sailup`, `SAILUP_API_KEY`, `SAILUP_SENDER_ID`
   - every `LEGAL_*` value
3. Check the configuration: `docker compose run --rm --no-deps app node scripts/check-config.js` (or `npm run check:prod` without Docker). Fix every `FAIL`.
4. `docker compose up -d --build`
5. Check `https://your-domain/healthz` returns `{"status":"ok"}`, then sign in at `/admin`.

Caddy issues and renews the HTTPS certificate automatically. The database lives on the `ntintan-data` volume, and the `backup` service writes a copy to `/data/backups` every 24 hours. Container logs are capped at 50 MB per service.

To update: copy the new code to the server and run `docker compose up -d --build` again. Data on the volume is kept.

### Investor preview on Render (free, demo mode)

`render.yaml` deploys a **demo** copy: production security and HTTPS, but simulated payments ("Approve payment" on a test page), sign-in codes shown on screen instead of SMS, an orange "Preview / demo site" banner and no search-engine indexing. Live Paystack keys are refused in demo mode.

1. Push this project to a GitHub repository (the `data/` folder and `.env` are ignored and must not be uploaded).
2. On [render.com](https://render.com), sign up with GitHub, then **New → Blueprint** and pick the repository. Fill in:
   - `PUBLIC_URL`: `https://your-domain` (exactly the address investors will use)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters), `ADMIN_PHONE`: the demo admin login to share with investors
3. When the deploy is live, open the service → **Settings → Custom Domains** → add `your-domain`. Render also adds `www.your-domain` as a redirect.
4. At your DNS provider (Namecheap: **Domain List → Manage → Advanced DNS**), delete the existing parking/redirect records for `@` and `www`, then add the records Render shows:
   - `A Record`, host `@`, value: the IP Render shows
   - `CNAME Record`, host `www`, value: `your-service.onrender.com.`
5. Back in Render, click **Verify**. HTTPS is issued automatically, usually within minutes (DNS can take up to a few hours).

Free-plan limits: the site sleeps after ~15 minutes without visitors, and the next visit takes about a minute to wake it (open it yourself just before a meeting). Test orders and accounts are wiped on every restart or deploy; the catalogue and demo admin come back automatically.

### Option B: systemd

```bash
sudo useradd --system --home /opt/ntintan ntintan
sudo cp -r . /opt/ntintan && sudo chown -R ntintan:ntintan /opt/ntintan
sudo cp deploy/ntintan.service /etc/systemd/system/ && sudo systemctl enable --now ntintan
```

Put Nginx or Caddy in front for TLS and set `TRUST_PROXY=1`.

### Sailup setup (SMS sign-in codes and notifications)

1. Create a Sailup account at sailup.io and a project. Buy credits (from GH₵0.02 per SMS; topped up through Paystack).
2. Register a **sender ID** (for example `NTINTAN`) in the dashboard and wait for approval. Messages can't be sent until it's approved.
3. Under Developer Settings, create a project API key (it starts `sailup_`). Set:
   - `SMS_MODE=sailup`
   - `SAILUP_API_KEY=sailup_…`
   - `SAILUP_SENDER_ID=NTINTAN`
4. Optional: add the webhook `https://your-domain/api/sms/webhook` and set `SAILUP_WEBHOOK_SECRET`, so delivery status shows in **Admin → SMS**.
5. Make sure `ADMIN_PHONE` (or the phone passed to `npm run create-admin`) is a real number. Staff sign-in codes go there.

Sailup doesn't provide an OTP endpoint, so Ntintan generates and checks codes itself and uses Sailup only to deliver them.

### Paystack setup

1. Create a Paystack business account for Ghana and complete compliance (KYC) so you get **live** keys.
2. Dashboard → Settings → API Keys & Webhooks:
   - **Callback URL:** `https://your-domain/payment/callback`
   - **Webhook URL:** `https://your-domain/api/payments/webhook` (receives `charge.*` and `refund.*` events)
3. Enable the Mobile Money and Card channels for GHS.
4. Test end to end with your `sk_test_…` key before switching to `sk_live_…`.

### Backups

`npm run backup` writes a consistent online copy (`VACUUM INTO`) to `BACKUP_DIR` and keeps the latest 30. With Docker Compose the `backup` service does this every 24 hours. With systemd, schedule it nightly (`deploy/backup.cron`). Either way, copy backups off the server, for example to S3 or Backblaze. From Docker: `docker compose cp app:/data/backups ./backups`.

### Admin accounts

```bash
npm run create-admin -- you@yourdomain.com "a long unique passphrase" 0241234567 "Your Name"
```

---

## Things to connect before launch

| Item | Status | What to do |
|---|---|---|
| **Paystack** (MoMo, card, refunds) | Implemented and tested against a mock Paystack API | Add live keys, callback and webhook URLs (above). Test end to end with `sk_test_…` first. |
| **Sailup** (sign-in codes, order and coupon SMS) | Implemented and tested against a mock Sailup API | Add the API key and an approved sender ID (above), then send yourself a real code before launch. |
| **Company details on legal pages** | Placeholders such as `[Company legal name — set LEGAL_COMPANY_NAME]` show until set, and the server warns at start-up | Set every `LEGAL_*` variable, including your Data Protection Commission registration number. |
| **Legal review** | Written for Ghanaian law, using Jumia Ghana's buyer terms as a structural reference | Have a Ghanaian lawyer review `/terms` and `/privacy` before launch, especially the Ogya Coin and coupon sections (see below), returns timeframes and the liability cap. |
| **Data Protection Commission** | Act 843 requires data controllers to register | Register at dataprotection.org.gh, then put the number in `LEGAL_DPC_NUMBER`. |
| **Ogya Coin & coupons** | Described in the terms as closed-loop prepaid store credit (no cash-out, interest or transfer) | Wallets and stored value can fall under Ghana's **Payment Systems and Services Act, 2019 (Act 987)**. Confirm with your lawyer, or with the Bank of Ghana, whether the closed-loop design needs a licence or a licensed partner before taking real top-ups. |
| **Alcohol licensing & advertising** | Age checks, warnings and ID-on-delivery rules are built in | Get a retail liquor licence from your district assembly (Liquor Licensing Act, 1970 (Act 331)) and set `LEGAL_LIQUOR_LICENCE`. The FDA's *Guidelines for Advertisement of Regulated Products* (2023) say alcohol promotion online needs FDA approval. Get approval before marketing drinks, and don't use celebrities or make health claims. Note that an Alcohol Control Regulations Bill was announced in Parliament in February 2026 and could change these rules. Only sell FDA-registered products. |
| **Product prices & photos** | 4 retail prices from your data; others show "Request quote" | Set prices in Admin → Products and add real photos. |
| **Scaling** | A single server with SQLite | For several servers, move rate limiting to Redis and the database to PostgreSQL. |

## Project layout

```
server.js                 HTTP server, graceful shutdown
src/config.js             env loading + production safety checks
src/db.js                 schema & migrations (node:sqlite, WAL)
src/seed.js               reference data (categories, units, products, farmers, prices, traditional drinks)
src/seed-brands.js        African beverage makers and their key products
src/app.js                routes, middleware, static files, background jobs
src/lib/                  http toolkit, security primitives, validation
src/services/             auth (OTP + staff 2-step), otp, sms (Sailup), catalog, orders, payments (Paystack + refunds),
                          wallet, coupons, misc (leads, audit, retention, stats)
public/                   storefront, admin, terms.html, privacy.html, CSS, JS modules, SVG icons
test/                     node:test integration tests (incl. mock Paystack and Sailup)
deploy/                   Caddyfile, systemd unit, backup cron
Dockerfile, docker-compose.yml
```

## API overview

Public: `GET /api/config, /api/session, /api/brands, /api/categories, /api/products, /api/products/:id, /api/units, /api/market-prices, /api/farmers` · `POST /api/orders/quote, /api/orders, /api/orders/track, /api/coupons/check, /api/leads/:type, /api/payments/verify` · webhooks `POST /api/payments/webhook` (Paystack), `POST /api/sms/webhook` (Sailup)

Auth: `POST /api/auth/otp/request | otp/verify | otp/complete` (customers) · `POST /api/auth/admin/login | admin/verify` (staff 2-step) · `POST /api/auth/logout | password`

Signed in: `GET /api/me, /api/me/export, /api/orders/mine, /api/wallet, /api/coupons/mine` · `PATCH /api/me` · `POST /api/me/accept-terms, /api/me/delete, /api/wallet/topup, /api/coupons`

Admin: `/api/admin/stats | orders (+ /:ref/refund) | products | coupons | farmers | leads | users | sms | audit`

Pages: `/` shop · `/terms` · `/privacy` · `/admin` · `/payment/callback`

Every response is JSON. Errors look like `{ "error": { "message", "code", "fields" } }`.
