import { failure, readJsonObject, requireSession, sameOrigin } from "@/lib/auth";
import { assertJmr, isObject, JmrError, type Actor } from "@/lib/jmr-core";
import { getDb, initDatabase, transaction, type D1Database } from "@/lib/jmr-db";

export const dynamic = "force-dynamic";

// Business tables in the order they are deleted (children first); restore inserts in reverse.
// Users and sessions are never part of a backup, a restore or a factory reset, so nobody is
// locked out by one.
const TABLES = [
  { key: "payments", table: "payments", order: "created_at,id" },
  { key: "recordMeta", table: "record_meta", order: "record_id" },
  { key: "monthlySnapshots", table: "monthly_snapshots", order: "record_id" },
  { key: "monthlyRecords", table: "monthly_records", order: "month,id" },
  { key: "monthStatus", table: "month_status", order: "month" },
  { key: "departments", table: "departments", order: "id" },
  { key: "audit", table: "audit_log", order: "created_at,id" },
] as const;
const IDENTITY_TABLES = ["departments", "monthly_records"] as const;

function requireOwner(actor: Actor): void {
  assertJmr(actor.role === "owner", "النسخة الاحتياطية متاحة للمالك فقط", 403);
}

function audit(db: D1Database, actor: Actor, action: string, detail: string) {
  return db.prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), actor.id, actor.name, action, detail).run();
}

async function deleteBusinessData(db: D1Database): Promise<void> {
  for (const { table } of TABLES) await db.prepare(`DELETE FROM ${table}`).run();
}

// After rows are written with their own ids, new rows must continue after the highest id.
async function resetIdSequences(db: D1Database): Promise<void> {
  for (const table of IDENTITY_TABLES) {
    await db.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`).run();
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requireSession(request);
    requireOwner(actor);
    await initDatabase();
    const db = getDb();
    const results = await Promise.all(TABLES.map(({ table, order }) =>
      db.prepare(table === "record_meta"
        ? "SELECT record_id, confirmed, revision FROM record_meta ORDER BY record_id"
        : `SELECT * FROM ${table} ORDER BY ${order}`).all()));
    const data = Object.fromEntries(TABLES.map(({ key }, index) => [key, results[index].results ?? []]));
    const exportedAt = new Date().toISOString();
    const payload = {
      format: "jmr-business-backup",
      version: 2,
      exportedAt,
      exportedBy: actor.name,
      data,
      note: "Shops, months, readings, payments and the change log. Passwords and sign-in sessions are not included.",
    };
    await db.prepare(`INSERT INTO app_settings (key, value) VALUES ('last_backup_at', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(exportedAt).run();
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="JMR-backup-${exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}

// POST { action: "restore", confirm: "RESTORE", backup } replaces all business data with the backup.
// POST { action: "factoryReset", confirm: "RESET" } deletes all business data.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await requireSession(request);
    requireOwner(actor);
    await initDatabase();
    const body = await readJsonObject(request, 25_000_000);

    if (body.action === "factoryReset") {
      assertJmr(body.confirm === "RESET", "اكتب RESET للتأكيد");
      await transaction(async tx => {
        await deleteBusinessData(tx);
        await resetIdSequences(tx);
        await audit(tx, actor, "factoryReset", "إعادة ضبط المصنع: حذف كل الأقسام والأشهر والقراءات والدفعات. الحسابات بقيت.");
      });
      return Response.json({ ok: true, message: "تمت إعادة ضبط التطبيق. الحسابات بقيت كما هي." }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "restore") {
      assertJmr(body.confirm === "RESTORE", "اكتب RESTORE للتأكيد");
      const backup = body.backup;
      assertJmr(isObject(backup) && backup.format === "jmr-business-backup" && backup.version === 2 && isObject(backup.data),
        "الملف مش نسخة احتياطية من هالتطبيق");
      const data = backup.data as Record<string, unknown>;
      for (const { key } of TABLES) assertJmr(Array.isArray(data[key]) && (data[key] as unknown[]).every(isObject), `النسخة ناقصة: ${key}`);

      const counts = await transaction(async tx => {
        const columns = new Map<string, Set<string>>();
        for (const { table } of TABLES) {
          const found = await tx.prepare(`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = ?`).bind(table).all<{ name: string }>();
          columns.set(table, new Set((found.results ?? []).map(row => row.name)));
        }
        await deleteBusinessData(tx);
        const restored: Record<string, number> = {};
        for (const { key, table } of [...TABLES].reverse()) {
          const allowed = columns.get(table)!;
          const rows = data[key] as Record<string, unknown>[];
          for (const row of rows) {
            // Only known column names are used, so a crafted file cannot inject SQL.
            const names = Object.keys(row).filter(name => allowed.has(name));
            assertJmr(names.length > 0, `صف غير صالح في ${key}`);
            const override = (IDENTITY_TABLES as readonly string[]).includes(table) ? " OVERRIDING SYSTEM VALUE" : "";
            await tx.prepare(`INSERT INTO ${table} (${names.map(name => `"${name}"`).join(", ")})${override}
              VALUES (${names.map(() => "?").join(", ")})`).bind(...names.map(name => row[name] ?? null)).run();
          }
          restored[key] = rows.length;
        }
        await resetIdSequences(tx);
        await audit(tx, actor, "restoreBackup",
          `استرجاع نسخة ${String(backup.exportedAt ?? "")}: ${restored.departments} قسم، ${restored.monthStatus} شهر، ${restored.payments} دفعة`);
        return restored;
      });
      return Response.json({ ok: true, message: "تم استرجاع النسخة الاحتياطية", counts }, { headers: { "Cache-Control": "no-store" } });
    }

    throw new JmrError("الإجراء غير معروف", 400);
  } catch (error) {
    return failure(error);
  }
}
