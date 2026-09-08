import { getDb, initDatabase } from "@/lib/jmr-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await initDatabase();
    await getDb().prepare("SELECT 1 AS ok").first();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
