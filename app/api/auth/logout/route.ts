import { clearSessionCookie, jsonNoStore } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

export async function POST() {
  return jsonNoStore(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookie() } },
  );
}
