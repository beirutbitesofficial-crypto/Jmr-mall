import { failure, jsonNoStore, logout } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const setCookie = await logout(request);
    return jsonNoStore({ ok: true }, { headers: { "Set-Cookie": setCookie } });
  } catch (error) {
    return failure(error);
  }
}
