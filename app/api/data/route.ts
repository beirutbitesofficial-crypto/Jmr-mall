import { env } from "cloudflare:workers";
import { requirePinSession } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

const createDepartments = `CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_section TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  occupant TEXT NOT NULL DEFAULT '',
  occupant_number TEXT NOT NULL DEFAULT '',
  rent_start TEXT NOT NULL DEFAULT '',
  rent_end TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const createRecords = `CREATE TABLE IF NOT EXISTS monthly_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  department_id INTEGER NOT NULL,
  meter_fee REAL NOT NULL DEFAULT 0,
  kilo_price REAL NOT NULL DEFAULT 0,
  rent REAL NOT NULL DEFAULT 0,
  services REAL NOT NULL DEFAULT 0,
  previous_reading REAL NOT NULL DEFAULT 0,
  current_reading REAL NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  UNIQUE(month, department_id)
)`;

type JsonObject = Record<string, unknown>;

type StoredMonthlyRecord = {
  locked: number;
  departmentId: number;
  month: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function cleanText(value: unknown, maximum = 180): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length <= maximum ? cleaned : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function validDate(value: string): boolean {
  return value === "" || /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/.test(value);
}

async function init() {
  const db = env.DB;
  await db.batch([
    db.prepare(createDepartments), db.prepare(createRecords),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_monthly_records_month ON monthly_records(month)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_monthly_records_department_month ON monthly_records(department_id, month)"),
  ]);
}

async function syncMonth(month: string) {
  const active = await env.DB.prepare("SELECT id FROM departments WHERE active = 1").all<{ id: number }>();
  const inserts = active.results.map(({ id }) => env.DB.prepare(`INSERT OR IGNORE INTO monthly_records (month, department_id, previous_reading, current_reading, locked)
    VALUES (?, ?, COALESCE((SELECT current_reading FROM monthly_records WHERE department_id = ? AND month < ? ORDER BY month DESC LIMIT 1), 0), 0,
      COALESCE((SELECT MIN(locked) FROM monthly_records WHERE month = ?), 0))`).bind(month, id, id, month, month));
  if (inserts.length) await env.DB.batch(inserts);
}

export async function GET(request: Request) {
  const unauthorized = await requirePinSession(request);
  if (unauthorized) return unauthorized;
  await init();
  const [departments, records] = await Promise.all([
    env.DB.prepare("SELECT id, meter_section AS meterSection, category, owner, phone, occupant, occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active FROM departments ORDER BY meter_section").all(),
    env.DB.prepare("SELECT id, month, department_id AS departmentId, meter_fee AS meterFee, kilo_price AS kiloPrice, rent, services, previous_reading AS previousReading, current_reading AS currentReading, locked FROM monthly_records ORDER BY month DESC, department_id").all(),
  ]);
  return Response.json({ departments: departments.results, records: records.results });
}

export async function POST(request: Request) {
  const unauthorized = await requirePinSession(request);
  if (unauthorized) return unauthorized;
  await init();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  if (!isObject(body) || typeof body.action !== "string") {
    return Response.json({ error: "طلب غير صالح" }, { status: 400 });
  }

  if (body.action === "addDepartment") {
    if (!isObject(body.department)) return Response.json({ error: "بيانات القسم غير صالحة" }, { status: 400 });
    if (!validMonth(body.month)) return Response.json({ error: "الشهر غير صالح" }, { status: 400 });
    const source = body.department;
    const meterSection = cleanText(source.meterSection, 80);
    const category = cleanText(source.category, 120);
    const owner = cleanText(source.owner);
    const phone = cleanText(source.phone, 50);
    const occupant = cleanText(source.occupant);
    const occupantNumber = cleanText(source.occupantNumber, 80);
    const rentStart = cleanText(source.rentStart, 10);
    const rentEnd = cleanText(source.rentEnd, 10);
    if (!meterSection || !category || !occupant || owner === null || phone === null || occupantNumber === null || rentStart === null || rentEnd === null || !validDate(rentStart) || !validDate(rentEnd)) {
      return Response.json({ error: "تحقق من بيانات القسم والتواريخ" }, { status: 400 });
    }
    if (rentStart && rentEnd && rentEnd < rentStart) {
      return Response.json({ error: "تاريخ انتهاء الإيجار يجب أن يكون بعد تاريخ البدء" }, { status: 400 });
    }
    const duplicate = await env.DB.prepare("SELECT id FROM departments WHERE lower(trim(meter_section)) = lower(?) LIMIT 1").bind(meterSection).first();
    if (duplicate) return Response.json({ error: "عداد / قسم مسجّل مسبقاً" }, { status: 409 });
    await env.DB.prepare("INSERT INTO departments (meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(meterSection, category, owner, phone, occupant, occupantNumber, rentStart, rentEnd).run();
    await syncMonth(body.month);
  } else if (body.action === "createMonth") {
    if (!validMonth(body.month)) return Response.json({ error: "الشهر غير صالح" }, { status: 400 });
    await syncMonth(body.month);
  } else if (body.action === "updateRecord") {
    if (!isObject(body.record)) return Response.json({ error: "بيانات السجل غير صالحة" }, { status: 400 });
    const source = body.record;
    const id = positiveInteger(source.id);
    const meterFee = nonNegativeNumber(source.meterFee);
    const kiloPrice = nonNegativeNumber(source.kiloPrice);
    const rent = nonNegativeNumber(source.rent);
    const services = nonNegativeNumber(source.services);
    const requestedPreviousReading = nonNegativeNumber(source.previousReading);
    const currentReading = nonNegativeNumber(source.currentReading);
    if (id === null || meterFee === null || kiloPrice === null || rent === null || services === null || requestedPreviousReading === null || currentReading === null) {
      return Response.json({ error: "كل القيم يجب أن تكون أرقاماً موجبة" }, { status: 400 });
    }
    const existing = await env.DB.prepare("SELECT locked, department_id AS departmentId, month FROM monthly_records WHERE id = ?").bind(id).first<StoredMonthlyRecord>();
    if (!existing) return Response.json({ error: "السجل غير موجود" }, { status: 404 });
    if (existing.locked) return Response.json({ error: "الشهر معتمد ومقفل" }, { status: 409 });
    const prior = await env.DB.prepare("SELECT current_reading AS currentReading FROM monthly_records WHERE department_id = ? AND month < ? ORDER BY month DESC LIMIT 1").bind(existing.departmentId, existing.month).first<{ currentReading: number }>();
    const previousReading = prior ? prior.currentReading : requestedPreviousReading;
    if (currentReading < previousReading) return Response.json({ error: "العداد الحالي يجب أن يكون أكبر من أو يساوي العداد السابق" }, { status: 400 });
    await env.DB.batch([
      env.DB.prepare("UPDATE monthly_records SET meter_fee=?, kilo_price=?, rent=?, services=?, previous_reading=?, current_reading=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(meterFee, kiloPrice, rent, services, previousReading, currentReading, id),
      env.DB.prepare("UPDATE monthly_records SET previous_reading=?, updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT id FROM monthly_records WHERE department_id=? AND month>? ORDER BY month ASC LIMIT 1)").bind(currentReading, existing.departmentId, existing.month),
    ]);
  } else if (body.action === "lockMonth") {
    if (!validMonth(body.month) || (body.locked !== 0 && body.locked !== 1)) return Response.json({ error: "بيانات اعتماد الشهر غير صالحة" }, { status: 400 });
    await env.DB.prepare("UPDATE monthly_records SET locked = ? WHERE month = ?").bind(body.locked, body.month).run();
  } else {
    return Response.json({ error: "unknown action" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
