import { Pool, types, type CustomTypesConfig, type PoolClient } from "pg";
import type { Actor } from "@/lib/jmr-core";

export type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  meta?: { changes?: number };
};

type Prepared = { sql: string; values: unknown[] };

export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  _prepared(): Prepared;
};

export type D1Database = {
  prepare(query: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
};

type RuntimeEnv = {
  DATABASE_URL?: string;
  JMR_APP_PIN?: string;
  JMR_ADMIN_USERNAME?: string;
  JMR_ADMIN_PASSWORD?: string;
  JMR_SESSION_SECRET?: string;
  APP_ORIGIN?: string;
};

export function runtimeEnv(): RuntimeEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    JMR_APP_PIN: process.env.JMR_APP_PIN,
    JMR_ADMIN_USERNAME: process.env.JMR_ADMIN_USERNAME,
    JMR_ADMIN_PASSWORD: process.env.JMR_ADMIN_PASSWORD,
    JMR_SESSION_SECRET: process.env.JMR_SESSION_SECRET,
    APP_ORIGIN: process.env.APP_ORIGIN,
  };
}

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

// The live tables use bigint ids and timestamps, which pg returns as strings by default. The app
// compares and validates them as numbers ("Invalid ID" on save), so read them as numbers while
// they fit exactly.
const bigintAsNumber = (value: string): number | string => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
};
const typeParsers: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === types.builtins.INT8 && format !== "binary" ? bigintAsNumber : types.getTypeParser(oid, format)) as CustomTypesConfig["getTypeParser"],
};

function getPool(): Pool {
  const url = runtimeEnv().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the Hostinger PostgreSQL runtime.");
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
      options: "-c search_path=jmr,public",
      types: typeParsers,
    });
  }
  return pool;
}

function normalizeSql(sql: string): string {
  let result = sql.trim().replace(/\s+COLLATE\s+NOCASE/gi, "");
  let ignoreConflict = false;
  result = result.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, () => {
    ignoreConflict = true;
    return "INSERT INTO";
  });
  // PostgreSQL lowercases unquoted aliases ("AS meterSection" comes back as "metersection"),
  // while the app reads camelCase keys written for SQLite. Quoting keeps the alias as written.
  result = result.replace(/\bAS\s+([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, 'AS "$1"');
  let index = 0;
  result = result.replace(/\?/g, () => `$${++index}`);
  if (ignoreConflict && !/\bON\s+CONFLICT\b/i.test(result)) result += " ON CONFLICT DO NOTHING";
  return result;
}

function statement(sql: string, values: unknown[] = [], client?: PoolClient): D1Statement {
  return {
    bind(...nextValues: unknown[]) { return statement(sql, nextValues, client); },
    async first<T>() {
      const runner = client ?? getPool();
      const result = await runner.query(normalizeSql(sql), values);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async all<T>() {
      const runner = client ?? getPool();
      const result = await runner.query(normalizeSql(sql), values);
      return { results: result.rows as T[] };
    },
    async run<T>() {
      const runner = client ?? getPool();
      const result = await runner.query(normalizeSql(sql), values);
      return { results: result.rows as T[], meta: { changes: result.rowCount ?? 0 } };
    },
    _prepared() { return { sql, values }; },
  };
}

const db: D1Database = {
  prepare(query: string) { return statement(query); },
  async batch<T>(statements: D1Statement[]) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const results: D1Result<T>[] = [];
      for (const item of statements) {
        const prepared = item._prepared();
        results.push(await statement(prepared.sql, prepared.values, client).run<T>());
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export function getDb(): D1Database { return db; }

// Runs work that needs reads and writes on one connection inside one transaction, so a
// failure part-way leaves nothing half-written. Nested batches reuse the same transaction.
export async function transaction<T>(work: (tx: D1Database) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const tx: D1Database = {
    prepare(query: string) { return statement(query, [], client); },
    async batch<R>(statements: D1Statement[]) {
      const results: D1Result<R>[] = [];
      for (const item of statements) {
        const prepared = item._prepared();
        results.push(await statement(prepared.sql, prepared.values, client).run<R>());
      }
      return results;
    },
  };
  try {
    await client.query("BEGIN");
    const result = await work(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initDatabase(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const client = await getPool().connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS jmr");
      await client.query(`CREATE TABLE IF NOT EXISTS departments (
        id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        meter_section text NOT NULL UNIQUE, category text NOT NULL DEFAULT '', owner text NOT NULL DEFAULT '',
        phone text NOT NULL DEFAULT '', occupant text NOT NULL DEFAULT '', occupant_number text NOT NULL DEFAULT '',
        rent_start text NOT NULL DEFAULT '', rent_end text NOT NULL DEFAULT '', active integer NOT NULL DEFAULT 1,
        created_at bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL DEFAULT 0)`);
      // Sign-in tables. Databases set up by hand may lack them, or lack sessions.client_fingerprint,
      // which sign-in writes; without it every sign-in failed with a generic error.
      await client.query(`CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY NOT NULL, username text NOT NULL, name text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner','accountant','viewer')), active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        password_hash text NOT NULL, session_version integer NOT NULL DEFAULT 1, created_at text NOT NULL DEFAULT (now()::text))`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_jmr_users_username_nocase ON users ((lower(username)))");
      await client.query(`CREATE TABLE IF NOT EXISTS sessions (
        id text PRIMARY KEY NOT NULL, user_id text NOT NULL, session_version integer NOT NULL,
        expires_at bigint NOT NULL, created_at bigint NOT NULL)`);
      await client.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_fingerprint text");
      await client.query(`CREATE TABLE IF NOT EXISTS auth_login_rate_limits (
        client_key text PRIMARY KEY NOT NULL, failure_count integer NOT NULL DEFAULT 0,
        window_started_at bigint NOT NULL, updated_at bigint NOT NULL)`);
    } finally { client.release(); }
  })().catch(error => { initialized = null; throw error; });
  return initialized;
}

export async function closeDatabase(): Promise<void> {
  const current = pool;
  pool = null;
  initialized = null;
  await current?.end();
}

export async function usersCount(): Promise<number> {
  const row = await getDb().prepare("SELECT COUNT(*)::int AS count FROM users").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function audit(actor: Actor, action: string, entityType: string, entityId: string, details = ""): Promise<void> {
  await getDb().prepare(`INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(actor.id, actor.name, actor.role, action, entityType, entityId, details, Date.now()).run();
}
