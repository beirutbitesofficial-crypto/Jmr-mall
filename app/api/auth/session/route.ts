import { jsonNoStore, readPinSession } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await readPinSession(request);
  if (!session) return jsonNoStore({ authenticated: false }, { status: 401 });
  return jsonNoStore({
    authenticated: true,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
