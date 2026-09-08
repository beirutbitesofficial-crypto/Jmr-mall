import { env } from "cloudflare:workers";
import type { Actor } from "@/lib/jmr-core";

export type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  meta?: { changes?: number };
};

export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type D1Database = {
  prepare(query: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
};

type RuntimeEnv = {
  DB?: D1Database;
  JMR_APP_PIN?: string;
  JMR_ADMIN_USERNAME?: string;
  JMR_ADMIN_PASSWORD?: string;
  JMR_SESSION_SECRET?: string;
  APP_ORIGIN?: string;
};

export function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export function getDb(): D1Database {
  const db = runtimeEnv().DB;
  if (!db) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return db;
}

const schema = [
  `CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_section TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    occupant TEXT NOT NULL DEFAULT '', occupant_number TEXT NOT NULL DEFAULT '', rent_start TEXT NOT NULL DEFAULT '',
    rent_end TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, department_id INTEGER NOT NULL,
    meter_fee REAL NOT NULL DEFAULT 0, kilo_price REAL NOT NULL DEFAULT 0, rent REAL NOT NULL DEFAULT 0,
    services REAL NOT NULL DEFAULT 0, previous_reading REAL NOT NULL DEFAULT 0, current_reading REAL NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id), UNIQUE(month, department_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_monthly_records_month ON monthly_records(month)`,
  `CREATE INDEX IF NOT EXISTS idx_monthly_records_department_month ON monthly_records(department_id, month)`,
  `CREATE TABLE IF NOT EXISTS month_status (
    month TEXT PRIMARY KEY NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT, approved_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS record_meta (
    record_id INTEGER PRIMARY KEY NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1, write_token TEXT,
    FOREIGN KEY (record_id) REFERENCES monthly_records(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_snapshots (
    record_id INTEGER PRIMARY KEY NOT NULL, meter_section TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', occupant TEXT NOT NULL DEFAULT '',
    occupant_number TEXT NOT NULL DEFAULT '', rent_start TEXT NOT NULL DEFAULT '', rent_end TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (record_id) REFERENCES monthly_records(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','accountant','viewer')), active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, session_version INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY NOT NULL, record_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('rent','electricity')),
    amount REAL NOT NULL CHECK(amount > 0), paid_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    received_by TEXT NOT NULL, created_at TEXT NOT NULL, voided_at TEXT, voided_by TEXT, void_reason TEXT,
    request_id TEXT NOT NULL UNIQUE, FOREIGN KEY (record_id) REFERENCES monthly_records(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_record_id ON payments(record_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, user_id TEXT NOT NULL,
    actor_name TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS auth_login_rate_limits (
    client_key TEXT PRIMARY KEY NOT NULL, failure_count INTEGER NOT NULL DEFAULT 0,
    window_started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_login_rate_limits_updated_at ON auth_login_rate_limits(updated_at)`,
];

export async function initDatabase(): Promise<void> {
  const db = getDb();
  await db.batch(schema.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO month_status (month, locked)
      SELECT month, MIN(locked) FROM monthly_records GROUP BY month`),
    db.prepare(`INSERT OR IGNORE INTO record_meta (record_id, confirmed, revision)
      SELECT id, CASE WHEN locked = 1 THEN 1 ELSE 0 END, 1 FROM monthly_records`),
    db.prepare(`INSERT OR IGNORE INTO monthly_snapshots (
      record_id, meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end
    ) SELECT r.id, d.meter_section, d.category, d.owner, d.phone, d.occupant, d.occupant_number, d.rent_start, d.rent_end
      FROM monthly_records r JOIN departments d ON d.id = r.department_id`),
    db.prepare(`UPDATE monthly_records SET locked = COALESCE(
      (SELECT locked FROM month_status m WHERE m.month = monthly_records.month), locked
    )`),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
  ]);
}

export async function writeAudit(actor: Actor, action: string, detail: string): Promise<void> {
  const db = getDb();
  await db.prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), actor.id, actor.name, action, detail)
    .run();
}

export async function usersCount(): Promise<number> {
  const row = await getDb().prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return Number(row?.count ?? 0);
}
