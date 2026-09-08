# BY JMR Mall — Audit & Collection System

Production-oriented mall accounting app for monthly meter readings, rent/services invoices, collections, receipts, users, permissions, and audit history.

## Runtime

- Node.js: `>=22.13.0`
- App: Next.js 16 + Vinext
- Production runtime: Cloudflare Workers
- Database: Cloudflare D1, bound as **`DB`**
- Build command: `npm run build`
- Install command: `npm ci --include=dev`

This repository intentionally uses Cloudflare D1 APIs. A plain Hostinger Node deployment is **not** a drop-in target; moving to Hostinger requires a PostgreSQL storage adapter/migration instead of changing environment variables only.

## Production guarantees added in v2

- A new month can only be created after the previous month is approved.
- Once a later month exists, older months are immutable accounting history.
- Current readings start from the previous approved reading but remain **unconfirmed** until reviewed and saved.
- Approval, invoice export, printing, and collection require complete records.
- Each month stores a tenant/department snapshot so later contract edits do not rewrite historical invoices.
- Record revisions reject stale edits from another browser/session.
- Partial payments are supported and database-side checks prevent overpayment.
- Payment request IDs make retries idempotent and prevent duplicate receipts.
- Receipts are reversed with a reason instead of deleted.
- Owner / accountant / viewer permissions are enforced server-side.
- Password or permission changes invalidate old sessions.
- The last 200 audit events are visible to owners; the full log stays in D1.
- `/api/health` checks application/database readiness.
- `/api/backup` lets an owner download a business-data backup (passwords and sessions are deliberately excluded).

## First deployment

### 1. D1 binding

Create or attach a D1 database and bind it with the exact name:

```text
DB
```

The app creates its required tables and migrates the existing `departments` / `monthly_records` data on first request. Existing historical rows are preserved. Previously locked rows are marked confirmed; existing unlocked rows intentionally require review before approval.

### 2. Runtime secrets / variables

Set these in the **runtime environment** (not in source control):

```text
JMR_ADMIN_USERNAME=admin
JMR_ADMIN_PASSWORD=<strong initial setup password>
JMR_SESSION_SECRET=<random secret at least 32 characters>
APP_ORIGIN=https://your-real-domain.example
```

`JMR_ADMIN_USERNAME` + `JMR_ADMIN_PASSWORD` are used only while there are no application users. After the first owner account is created, normal database users take over.

For backwards compatibility only, `JMR_APP_PIN` can act as the initial password when `JMR_ADMIN_PASSWORD` is absent. Prefer the stronger admin password variable.

Generate a session secret with a password manager or a cryptographically secure random generator. Rotating `JMR_SESSION_SECRET` invalidates existing login cookies/sessions.

### 3. Build settings

```text
Branch: main (after the production PR is merged)
Root directory: .
Node version: 22.13.0 or newer
Install command: npm ci --include=dev
Build command: npm run build
Output: Vinext / Cloudflare Worker build (`dist`)
```

Do not configure `DATABASE_URL`, Prisma, MySQL, or PostgreSQL for this D1 build.

### 4. Pre-launch checks

```bash
npm test
npm run lint
npm run build
```

After deployment, request:

```text
GET /api/health
```

Expected response:

```json
{"ok":true}
```

Then sign in with the initial setup account, immediately create the permanent owner account, and sign back in with that account.

## Roles

- **Owner:** all operations, month approval/reopen, user management, receipt reversal, audit and backup access.
- **Accountant:** departments, meter/fee entry, and collections.
- **Viewer:** read, invoice view/print, and exports only.

## Monthly workflow

1. Update/archive department contracts as needed.
2. Create the next month only after the prior month is approved.
3. Review every department's readings and fees, then save each row.
4. Owner approves the month.
5. Print/export invoices.
6. Record full or partial payments and issue receipts.
7. If a receipt is wrong, the owner reverses it with a reason; it is never deleted.

## Backup policy

`/api/backup` is a convenient business-data export, not a replacement for infrastructure backups. Enable scheduled D1 backups/exports as part of production operations. Never store backup files publicly because they contain tenant, phone, contract, invoice, and payment data.
