# By JMR Mall

Arabic mall department, meter reading, rent and service audit application. This repository replaces the previous application with the deployed PIN-based version from source commit `26cd8719a46db27ae72080c0f99260a29daa86b4`.

Previous repository main is preserved at `backup/before-sites-replacement-20260922` (commit `c6a1608dc7abafe795241b2cb6bec19c7c6d8cc5`). The replacement intentionally uses the site's shared PIN flow; the previous version's individual accounts, collection/payment features and roles are not part of this app.

## Runtime and verification

- Node.js 22.13+ for development/build; tests using node:sqlite require Node 22.13+.
- Production: Cloudflare Workers with a D1 database bound as `DB`.
- `npm ci`, `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
- Build output: `dist`. This is a Worker build, not a static site or a standard Node server.
- Apply the SQL migrations in `drizzle/`, in journal order, before serving the corresponding code. Existing live Sites data is not stored in this repository.
- Set runtime secrets `JMR_APP_PIN` (4–8 digits for this UI) and `JMR_SESSION_SECRET` (a long randomly generated value). Never commit their real values. A PIN or session-secret change invalidates existing sessions.

The retained `.openai/hosting.json` is non-secret source metadata for the original hosted site, not a portable database credential. A separate deployment needs its own D1 binding, migration setup and secrets. Do not deploy this build directly to a Hostinger Node application: it requires a database/runtime port first. No new hosting deployment, DNS change, or data transfer is performed by replacing this GitHub repository.

## Included behavior

- Confirmed records before month approval, export and printing.
- Guards against negative consumption and changes affecting a locked later month.
- Explicit row saving and whole-dataset optimistic revision checks.
- New departments are added to open months.
- Valid calendar dates and bounded nonnegative numeric inputs.
- Automatic pre-change snapshots (last 100), downloadable backups and validated transactional restore.
- Audit history identifies operations/times; shared PIN access does not identify individual people.

The UI's backup tool exports the currently stored data, not unsaved local edits. Keep a separate off-site backup; same-database snapshots do not protect against loss of the database itself. Never put tenant data, exported backups, session cookies or production secrets in this public repository.

## Customer URL

Use a custom domain on the hosting provider for a branded customer-facing URL. Moving source code to GitHub alone does not change the current live URL. The app uses its own PIN screen and does not require a ChatGPT account to authenticate.
