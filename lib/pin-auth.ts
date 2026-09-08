import { env } from "cloudflare:workers";

const SESSION_COOKIE_NAME = "__Host-jmr_session";
const SESSION_VERSION = 1;
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_RETENTION_SECONDS = 24 * 60 * 60;

const createAuthRateLimits = `CREATE TABLE IF NOT EXISTS auth_login_rate_limits (
  client_key TEXT PRIMARY KEY NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const createAuthRateLimitsUpdatedAtIndex =
  "CREATE INDEX IF NOT EXISTS idx_auth_login_rate_limits_updated_at ON auth_login_rate_limits(updated_at)";

type RuntimeEnv = {
  DB?: D1DatabaseBinding;
  JMR_APP_PIN?: string;
  JMR_SESSION_SECRET?: string;
};

type D1PreparedStatementBinding = {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type D1DatabaseBinding = {
  prepare(query: string): D1PreparedStatementBinding;
  batch(statements: D1PreparedStatementBinding[]): Promise<unknown[]>;
};

type AuthConfig = {
  pin: string;
  secret: string;
};

export type PinSession = {
  issuedAt: number;
  expiresAt: number;
};

type SessionPayload = {
  v: number;
  iat: number;
  exp: number;
  nonce: string;
};

type RateLimitRow = {
  failureCount: number;
  windowStartedAt: number;
};

export type RateLimitStatus = {
  limited: boolean;
  retryAfter: number;
};

function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export function getAuthConfig(): AuthConfig | null {
  const { JMR_APP_PIN: pin, JMR_SESSION_SECRET: secret } = runtimeEnv();
  if (typeof pin !== "string" || pin.length === 0) return null;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return { pin, secret };
}

function getD1(): D1DatabaseBinding {
  const db = runtimeEnv().DB;
  if (!db) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return db;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifySignature(value: string, signature: string, secret: string): Promise<boolean> {
  const signatureBytes = base64UrlToBytes(signature);
  if (!signatureBytes) return false;
  const key = await importSigningKey(secret);
  const signatureBuffer = new Uint8Array(signatureBytes.byteLength);
  signatureBuffer.set(signatureBytes);
  return crypto.subtle.verify("HMAC", key, signatureBuffer.buffer, new TextEncoder().encode(value));
}

async function equalSecretValues(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < candidateBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

export function jsonNoStore(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { ...init, headers: noStoreHeaders(init.headers) });
}

export async function createSessionCookie(secret: string): Promise<{ cookie: string; session: PinSession }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_DURATION_SECONDS;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    iat: issuedAt,
    exp: expiresAt,
    nonce: bytesToBase64Url(nonceBytes),
  };
  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload, secret);
  const value = `${encodedPayload}.${signature}`;
  const cookie = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${SESSION_DURATION_SECONDS}`,
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
  ].join("; ");
  return { cookie, session: { issuedAt, expiresAt } };
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export async function readPinSession(request: Request): Promise<PinSession | null> {
  const config = getAuthConfig();
  if (!config) return null;
  const value = parseCookies(request).get(SESSION_COOKIE_NAME);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!(await verifySignature(encodedPayload, signature, config.secret))) return null;

  const payloadBytes = base64UrlToBytes(encodedPayload);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<SessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.v !== SESSION_VERSION ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length === 0 ||
      (payload.iat as number) > now + 60 ||
      (payload.exp as number) <= now ||
      (payload.exp as number) - (payload.iat as number) !== SESSION_DURATION_SECONDS
    ) {
      return null;
    }
    return { issuedAt: payload.iat as number, expiresAt: payload.exp as number };
  } catch {
    return null;
  }
}

export async function requirePinSession(request: Request): Promise<Response | null> {
  const session = await readPinSession(request);
  if (session) return null;
  return jsonNoStore({ error: "UNAUTHORIZED" }, { status: 401 });
}

export async function isCorrectPin(candidate: string, expected: string): Promise<boolean> {
  return equalSecretValues(candidate, expected);
}

async function clientKey(request: Request, secret: string): Promise<string> {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || forwarded
    || "unknown";
  return sign(`login-rate-limit:${address}`, secret);
}

async function ensureRateLimitSchema(): Promise<void> {
  const db = getD1();
  await db.batch([
    db.prepare(createAuthRateLimits),
    db.prepare(createAuthRateLimitsUpdatedAtIndex),
  ]);
}

export async function getLoginRateLimit(request: Request, secret: string): Promise<RateLimitStatus> {
  await ensureRateLimitSchema();
  const db = getD1();
  const now = Math.floor(Date.now() / 1000);
  const key = await clientKey(request, secret);
  const row = await db.prepare(
    "SELECT failure_count AS failureCount, window_started_at AS windowStartedAt FROM auth_login_rate_limits WHERE client_key = ?",
  ).bind(key).first<RateLimitRow>();

  if (!row || row.failureCount < MAX_FAILED_ATTEMPTS) return { limited: false, retryAfter: 0 };
  const retryAfter = row.windowStartedAt + RATE_LIMIT_WINDOW_SECONDS - now;
  return retryAfter > 0
    ? { limited: true, retryAfter }
    : { limited: false, retryAfter: 0 };
}

export async function recordFailedLogin(request: Request, secret: string): Promise<void> {
  const db = getD1();
  const now = Math.floor(Date.now() / 1000);
  const resetBefore = now - RATE_LIMIT_WINDOW_SECONDS;
  const key = await clientKey(request, secret);
  await db.batch([
    db.prepare(`INSERT INTO auth_login_rate_limits (client_key, failure_count, window_started_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(client_key) DO UPDATE SET
        failure_count = CASE
          WHEN auth_login_rate_limits.window_started_at <= ? THEN 1
          ELSE auth_login_rate_limits.failure_count + 1
        END,
        window_started_at = CASE
          WHEN auth_login_rate_limits.window_started_at <= ? THEN excluded.window_started_at
          ELSE auth_login_rate_limits.window_started_at
        END,
        updated_at = excluded.updated_at`).bind(key, now, now, resetBefore, resetBefore),
    db.prepare("DELETE FROM auth_login_rate_limits WHERE updated_at < ?")
      .bind(now - RATE_LIMIT_RETENTION_SECONDS),
  ]);
}

export async function clearFailedLogins(request: Request, secret: string): Promise<void> {
  const key = await clientKey(request, secret);
  await getD1().prepare("DELETE FROM auth_login_rate_limits WHERE client_key = ?").bind(key).run();
}
