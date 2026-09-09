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
