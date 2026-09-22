import {
  clearFailedLogins,
  createSessionCookie,
  getAuthConfig,
  getLoginRateLimit,
  isCorrectPin,
  jsonNoStore,
  recordFailedLogin,
} from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = getAuthConfig();
  if (!config) {
    return jsonNoStore({ error: "AUTH_NOT_CONFIGURED" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonNoStore({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const pin = typeof body === "object" && body !== null && "pin" in body
    ? (body as { pin?: unknown }).pin
    : undefined;
  if (typeof pin !== "string" || pin.length === 0 || pin.length > 128) {
    return jsonNoStore({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const rateLimit = await getLoginRateLimit(request, config.secret);
    if (rateLimit.limited) {
      return jsonNoStore(
        { error: "RATE_LIMITED", retryAfter: rateLimit.retryAfter },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } },
      );
    }

    if (!(await isCorrectPin(pin, config.pin))) {
      await recordFailedLogin(request, config.secret);
      return jsonNoStore({ error: "INVALID_PIN" }, { status: 401 });
    }

    await clearFailedLogins(request, config.secret);
    const { cookie, session } = await createSessionCookie(config.secret);
    return jsonNoStore(
      {
        ok: true,
        authenticated: true,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      },
      { headers: { "Set-Cookie": cookie } },
    );
  } catch (error) {
    console.error("PIN login failed", error);
    return jsonNoStore({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
}
