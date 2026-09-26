# By JMR Mall — Hostinger edition

Next.js application for department records, monthly meter readings, rent/service invoices, backups and audit history. This version runs on a standard Node.js server and uses a dedicated, persistent MySQL/MariaDB database. It does not require Cloudflare D1 or ChatGPT sign-in.

## Hostinger deployment

1. Use a Hostinger plan with **Node.js Web Apps** enabled.
2. Create a **new, dedicated MySQL database** in hPanel → website dashboard → Databases → Management. Use the exact host/name/user shown there; do not reuse a database containing unrelated applications.
3. Import GitHub repository `beirutbitesofficial-crypto/Jmr-mall`, branch `main`.
4. Framework: **Next.js**. Root: `.`. Node: **22.x (22.13 or later)**. Install: `npm ci`. Build: `npm run build`. Start: `npm start`. Output, if requested: `.next`. The start script respects Hostinger's `PORT` environment variable.
5. Set the variables from `.env.example` in Hostinger's environment settings. Set `APP_ORIGIN` to the exact HTTPS site origin, without a trailing slash. Set a 4–8 digit PIN and a random session secret of at least 32 characters. Never commit real credentials.
6. Deploy and wait for a successful build/start. Open `/api/health`; it returns HTTP 200 with `{"ok":true}` only when MySQL is reachable and the schema is initialized.
7. Sign in and verify a test department, month, save, approval, Excel export and backup/restore on the actual host before relying on it for accounting.

The schema is created idempotently on the first database connection, or explicitly with `npm run db:migrate`. It does not drop/reset tables on redeploy. The database user needs permission to create the app's tables on first initialization. This schema is for a fresh Hostinger database, not an automatic conversion of another application's schema.

## Environment variables

| Variable | Value |
|---|---|
| `DB_HOST` | Exact MySQL server from hPanel |
| `DB_PORT` | Usually `3306` |
| `DB_NAME` | Full database name, including account prefix |
| `DB_USER` | Full database username |
| `DB_PASSWORD` | Database password |
| `DB_SSL` | `true` if the database server requires TLS; otherwise `false` |
| `DB_SSL_CA` | Optional CA certificate when using TLS |
| `JMR_APP_PIN` | Your 4–8 digit PIN (8 digits strongly recommended) |
| `JMR_SESSION_SECRET` | Random secret, at least 32 characters |
| `APP_ORIGIN` | Exact public HTTPS origin |

Alternatively, `DATABASE_URL=mysql://user:encoded-password@host:3306/database` replaces the five separate DB connection variables. SSL certificate verification stays enabled when TLS is enabled. Do not put DB variables or secrets under a `NEXT_PUBLIC_` prefix.

Generate a session secret using a password manager or `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, then put it in the hosting environment only.

## Move existing site data

The source repository contains **no tenant data and no production credentials**. On the old site's **النسخ الاحتياطية وسجل التعديلات** panel, download the current complete JSON backup. On the new Hostinger app, sign in, open the same panel and restore that file. Validate record counts, tenant names and monthly totals before switching customers to the new domain. The old site and new database are independent and do not synchronize.

Business-data restore replaces departments and monthly records transactionally, after validation and a pre-restore snapshot. It leaves the new database's existing audit history in place; historical audit entries in the imported file remain available in that source file, and are not merged into the new audit table.

## Safety and backups

The app guards month locks, nonnegative consumption, calendar dates, stale browser revisions and authenticated writes. Save/review each record before approving, exporting or printing a month. MySQL writes run in one connection/transaction, and stale revisions are rejected before modifying data. Database-backed storage survives app rebuilds.

Before each app mutation, a snapshot is stored in the same database; the last 100 snapshots are retained during ordinary mutations. These snapshots protect against editing mistakes, not database loss. Download off-site backups regularly and enable hosting/database backups. Shared PIN access records action/time rather than individual identity. Changing PIN or session secret invalidates prior signed sessions.

Sign-in is limited to 5 wrong PINs per address and 20 wrong PINs in total per 15 minutes. The total limit exists because client IP headers can be forged; the trade-off is that a flood of wrong guesses can also make the real owner wait up to 15 minutes. Use an 8-digit PIN so the total limit keeps guessing impractical. Logging out removes the session cookie from the browser; to cut off a session copied from another device, change the PIN or session secret.

Months can be created up to the month after the current one (Asia/Beirut). Months are created in order, so the app asks for confirmation before skipping months.

## Local verification

- `npm test`: contract checks, route behavior against an isolated SQLite test double, and transaction/revision tests against a mocked MySQL driver.
- `npm run typecheck`
- `npm run lint`
- `npm run build`

The automated test doubles do not substitute for an integration test on the actual MySQL/MariaDB server. No Hostinger database credentials are bundled, so final hosted database/login/export verification must be performed after environment configuration.
