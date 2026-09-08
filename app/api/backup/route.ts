import { failure, requireSession } from "@/lib/auth";
import { assertJmr } from "@/lib/jmr-core";
import { getDb, initDatabase } from "@/lib/jmr-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireSession(request);
    assertJmr(actor.role === "owner", "النسخة الاحتياطية متاحة للمالك فقط", 403);
    await initDatabase();
    const db = getDb();
    const [departments, records, months, snapshots, meta, payments, audit] = await Promise.all([
      db.prepare("SELECT * FROM departments ORDER BY id").all(),
      db.prepare("SELECT * FROM monthly_records ORDER BY month,id").all(),
      db.prepare("SELECT * FROM month_status ORDER BY month").all(),
      db.prepare("SELECT * FROM monthly_snapshots ORDER BY record_id").all(),
      db.prepare("SELECT record_id, confirmed, revision FROM record_meta ORDER BY record_id").all(),
      db.prepare("SELECT * FROM payments ORDER BY created_at,id").all(),
      db.prepare("SELECT * FROM audit_log ORDER BY created_at,id").all(),
    ]);
    const payload = {
      format: "jmr-business-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      exportedBy: actor.name,
      data: {
        departments: departments.results,
        monthlyRecords: records.results,
        monthStatus: months.results,
        monthlySnapshots: snapshots.results,
        recordMeta: meta.results,
        payments: payments.results,
        audit: audit.results,
      },
      note: "Passwords and active login sessions are intentionally excluded. Keep a database-native D1 backup as well.",
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="JMR-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
