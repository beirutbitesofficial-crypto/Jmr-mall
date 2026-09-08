import { assertJmr, isObject, JmrError, type Actor, type Role } from "@/lib/jmr-core";
import { getDb, initDatabase, runtimeEnv, usersCount } from "@/lib/jmr-db";

const COOKIE = "__Host-jmr_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_FAILURES = 5;
const MAX_CLIENT_FAILURES = 25;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const matches = value.match(/.{2}/g) ?? [];
  return Uint8Array.from(matches, pair => Number.parseInt(pair, 16));
}

export async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(result));
}

async function equalSecrets(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function hashPassword(password: string, salt?: string): Promise<string> {
  assertJmr(password.length >= 12 && password.length <= 128, "كلمة المرور لازم تكون بين 12 و128 حرف");
  const actualSalt = salt ?? hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(actualSalt), iterations: 120_000 },
    key,
    256,
  );
  return `pbkdf2-sha256$120000$${actualSalt}$${hex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterations, salt] = stored.split("$");
  if (algorithm !== "pbkdf2-sha256" || iterations !== "120000" || !/^[a-f0-9]{32}$/.test(salt ?? "")) return false;
  if (password.length < 12 || password.length > 128) return false;
  return equalSecrets(await hashPassword(password, salt), stored);
}

function sessionSecret(): string {
  const secret = runtimeEnv().JMR_SESSION_SECRET;
  assertJmr(typeof secret === "string" && secret.length >= 32, "JMR_SESSION_SECRET لازم يكون 32 حرف أو أكتر", 503);
  return secret;
}

function parseCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

function cookie(token: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function jsonNoStore(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { ...init, headers });
}

export function sameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  assertJmr(site !== "cross-site", "طلب من مصدر غير مسموح", 403);
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = runtimeEnv().APP_ORIGIN ?? new URL(request.url).origin;
  assertJmr(origin === expected, "طلب من مصدر غير مسموح", 403);
}

export async function readJsonObject(request: Request, maximum = 32_000): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  assertJmr(contentType.startsWith("application/json"), "نوع الطلب غير صالح", 415);
  const text = await request.text();
  assertJmr(text.length <= maximum, "الطلب كبير جداً", 413);
  try {
    const value: unknown = JSON.parse(text);
    assertJmr(isObject(value), "طلب غير صالح");
    return value;
  } catch (error) {
    if (error instanceof JmrError) throw error;
    throw new JmrError("طلب غير صالح");
  }
}

function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

async function rateKey(scope: string, value: string): Promise<string> {
  return digest(`${scope}:${value}:${sessionSecret()}`);
}

async function consumeFailure(key: string, maximum: number): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const resetBefore = now - RATE_WINDOW_MS;
  const result = await db.prepare(`INSERT INTO auth_login_rate_limits (client_key, failure_count, window_started_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(client_key) DO UPDATE SET
      failure_count = CASE WHEN auth_login_rate_limits.window_started_at <= ? THEN 1 ELSE auth_login_rate_limits.failure_count + 1 END,
      window_started_at = CASE WHEN auth_login_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE auth_login_rate_limits.window_started_at END,
      updated_at = excluded.updated_at
    RETURNING failure_count AS failureCount, window_started_at AS windowStartedAt`)
    .bind(key, now, now, resetBefore, resetBefore)
    .first<{ failureCount: number; windowStartedAt: number }>();
  assertJmr(Boolean(result) && Number(result?.failureCount) <= maximum, "محاولات كثيرة. انتظر 15 دقيقة", 429);
}

async function alreadyLimited(key: string, maximum: number): Promise<boolean> {
  const row = await getDb().prepare(`SELECT failure_count AS failureCount, window_started_at AS windowStartedAt
    FROM auth_login_rate_limits WHERE client_key = ?`).bind(key).first<{ failureCount: number; windowStartedAt: number }>();
  if (!row || Number(row.failureCount) < maximum) return false;
  return Number(row.windowStartedAt) > Date.now() - RATE_WINDOW_MS;
}

async function clearFailures(...keys: string[]): Promise<void> {
  const db = getDb();
  if (keys.length === 0) return;
  await db.batch(keys.map(key => db.prepare("DELETE FROM auth_login_rate_limits WHERE client_key = ?").bind(key)));
}

type UserRow = {
  id: string;
  username: string;
  name: string;
  role: Role;
  active: number;
  passwordHash: string;
  sessionVersion: number;
};

export async function login(request: Request, username: string, password: string): Promise<{ actor: Actor; setCookie: string; expiresAt: string }> {
  sameOrigin(request);
  await initDatabase();
  assertJmr(username.length >= 3 && username.length <= 64 && password.length > 0 && password.length <= 128, "بيانات الدخول غير صحيحة", 401);

  const normalized = username.trim().toLowerCase();
  const accountKey = await rateKey("account", normalized);
  const clientKey = await rateKey("client", clientAddress(request));
  assertJmr(!(await alreadyLimited(accountKey, MAX_ACCOUNT_FAILURES)) && !(await alreadyLimited(clientKey, MAX_CLIENT_FAILURES)), "محاولات كثيرة. انتظر 15 دقيقة", 429);

  const count = await usersCount();
  let actor: Actor | null = null;
  if (count === 0) {
    const expectedUser = (runtimeEnv().JMR_ADMIN_USERNAME ?? "admin").trim().toLowerCase();
    const expectedPassword = runtimeEnv().JMR_ADMIN_PASSWORD ?? runtimeEnv().JMR_APP_PIN;
    assertJmr(typeof expectedPassword === "string" && expectedPassword.length >= 4, "أضف JMR_ADMIN_PASSWORD لإعداد الحساب الأول", 503);
    if (normalized === expectedUser && await equalSecrets(password, expectedPassword)) {
      actor = { id: "bootstrap", name: "إعداد المالك", role: "owner", sessionVersion: 0 };
    }
  } else {
    const user = await getDb().prepare(`SELECT id, username, name, role, active, password_hash AS passwordHash,
      session_version AS sessionVersion FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`)
      .bind(normalized).first<UserRow>();
    if (user && Number(user.active) === 1 && await verifyPassword(password, user.passwordHash)) {
      actor = { id: user.id, name: user.name, role: user.role, sessionVersion: Number(user.sessionVersion) };
    }
  }

  if (!actor) {
    await Promise.all([consumeFailure(accountKey, MAX_ACCOUNT_FAILURES), consumeFailure(clientKey, MAX_CLIENT_FAILURES)]);
    throw new JmrError("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
  }

  await clearFailures(accountKey, clientKey);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const sessionId = await digest(`${token}:${sessionSecret()}`);
  const expires = Date.now() + SESSION_MS;
  await getDb().prepare(`INSERT INTO sessions (id, user_id, session_version, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(sessionId, actor.id, actor.sessionVersion, expires, Date.now()).run();
  return { actor, setCookie: cookie(token, SESSION_MS / 1000), expiresAt: new Date(expires).toISOString() };
}

export async function readSession(request: Request): Promise<Actor | null> {
  await initDatabase();
  const token = parseCookie(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const id = await digest(`${token}:${sessionSecret()}`);
  const stored = await getDb().prepare(`SELECT user_id AS userId, session_version AS sessionVersion, expires_at AS expiresAt
    FROM sessions WHERE id = ? LIMIT 1`).bind(id).first<{ userId: string; sessionVersion: number; expiresAt: number }>();
  if (!stored || Number(stored.expiresAt) <= Date.now()) return null;

  if (stored.userId === "bootstrap") {
    if (await usersCount() === 0) return { id: "bootstrap", name: "إعداد المالك", role: "owner", sessionVersion: 0 };
    return null;
  }

  const user = await getDb().prepare(`SELECT id, name, role, active, session_version AS sessionVersion
    FROM users WHERE id = ? LIMIT 1`).bind(stored.userId).first<{ id: string; name: string; role: Role; active: number; sessionVersion: number }>();
  if (!user || Number(user.active) !== 1 || Number(user.sessionVersion) !== Number(stored.sessionVersion)) return null;
  return { id: user.id, name: user.name, role: user.role, sessionVersion: Number(user.sessionVersion) };
}

export async function requireSession(request: Request): Promise<Actor> {
  const actor = await readSession(request);
  assertJmr(actor, "انتهت الجلسة. سجّل الدخول من جديد", 401);
  return actor;
}

export async function logout(request: Request): Promise<string> {
  sameOrigin(request);
  const token = parseCookie(request);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const id = await digest(`${token}:${sessionSecret()}`);
    await getDb().prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  }
  return cookie("", 0);
}

export function failure(error: unknown): Response {
  if (error instanceof JmrError) {
    const headers = error.status === 429 ? { "Retry-After": "900" } : undefined;
    return jsonNoStore({ error: error.message }, { status: error.status, headers });
  }
  console.error("JMR request failed", error instanceof Error ? error.message : "unknown error");
  return jsonNoStore({ error: "تعذّر إتمام الطلب. ما تعتبر التعديل محفوظ قبل ما يظهر تأكيد النجاح." }, { status: 503 });
}
