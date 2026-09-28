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
JMR_ADMIN_PASSWORD=<strong bootstrap password>
JMR_SESSION_SECRET=<random 64-char secret>
APP_ORIGIN=https://your-real-domain.example
```

The application uses the dedicated PostgreSQL schema `jmr` and sets `search_path` to `jmr, public` for every database connection. The Supabase migration `jmr_hostinger_accounting_v1` creates the production tables.

Do not add `JMR_APP_PIN` unless migrating an old setup. After the first login, create the permanent owner account from the application and use that account going forward.

## First sign-in and users

1. Set `JMR_ADMIN_USERNAME`, `JMR_ADMIN_PASSWORD` and `JMR_SESSION_SECRET` (at least 32 characters), then deploy.
2. Sign in with the admin username and password. This setup account can only create the owner account.
3. Create the owner account (password at least 12 characters). The setup account stops working as soon as the owner exists.
4. Sign in as the owner. Under **Users & roles**, add the other people:
   - **Owner**: everything, including approving months, reversing receipts and managing users.
   - **Accountant**: enters readings, shops and payments; cannot approve months or manage users.
   - **View only**: can see everything, cannot change anything.

Changing someone's password or role, or disabling them, signs them out on every device.
The app opens in English; the button at the top switches to Arabic, and the moon/sun button switches dark mode. Printed invoices stay in Arabic.
