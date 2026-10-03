# Hostinger deployment

Use these settings in Hostinger:

- Node version: `22.x`
- Root directory: `./`
- Package manager: `npm`
- Build command: `npm run build`
- Output directory: `.next`
- Start command (if Hostinger asks): `npm run start`

Required environment variables:

```text
DATABASE_URL=<Supabase PostgreSQL connection string>
JMR_ADMIN_USERNAME=jmradmin
JMR_ADMIN_PASSWORD=<main owner password, 12+ characters>
JMR_SESSION_SECRET=<random 64-char secret>
APP_ORIGIN=https://your-real-domain.example
```

The application uses the dedicated PostgreSQL schema `jmr` and sets `search_path` to `jmr, public` for every database connection. The Supabase migration `jmr_hostinger_accounting_v1` creates the production tables.

`JMR_ADMIN_USERNAME` and `JMR_ADMIN_PASSWORD` are the main owner account. `JMR_APP_PIN` is no longer used.

## First sign-in and users

1. Set `JMR_ADMIN_USERNAME`, `JMR_ADMIN_PASSWORD` (12–128 characters) and `JMR_SESSION_SECRET` (at least 32 characters), then deploy.
2. Sign in with that username and password. This is the main owner account: on every start the app creates it if it is missing, and keeps it an active owner with the password from Hostinger. It works even if the database already has other users.
3. To change the main password, change `JMR_ADMIN_PASSWORD` in Hostinger and redeploy. Locked out? The same steps get you back in.
4. Under **Users & roles**, add the other people:
   - **Owner**: everything, including approving months, reversing receipts and managing users.
   - **Accountant**: enters readings, shops and payments; cannot approve months or manage users.
   - **View only**: can see everything, cannot change anything.

Changing someone's password or role, or disabling them, signs them out on every device.
The app opens in English; the button at the top switches to Arabic, and the moon/sun button switches dark mode. Printed invoices stay in Arabic.
