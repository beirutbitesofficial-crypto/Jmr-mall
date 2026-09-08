import { failure, jsonNoStore, login, readJsonObject } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request, 4_000);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = await login(request, username, password);
    return jsonNoStore(
      { ok: true, actor: result.actor, expiresAt: result.expiresAt },
      { headers: { "Set-Cookie": result.setCookie } },
    );
  } catch (error) {
    return failure(error);
  }
}
