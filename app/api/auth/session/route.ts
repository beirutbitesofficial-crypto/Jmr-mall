import { failure, jsonNoStore, readSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await readSession(request);
    if (!actor) return jsonNoStore({ authenticated: false }, { status: 401 });
    return jsonNoStore({ authenticated: true, actor });
  } catch (error) {
    return failure(error);
  }
}
