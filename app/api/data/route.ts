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
  confirmed INTEGER NOT NULL DEFAULT 0,
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100000000 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function validDate(value: string): boolean {
  return value === "" || (/^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value);
}

export async function init() {
  const db = env.DB;
  await db.batch([
    db.prepare(createDepartments), db.prepare(createRecords),
    db.prepare("CREATE TABLE IF NOT EXISTS jmr_revision (id INTEGER PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=0))"),
    db.prepare("INSERT OR IGNORE INTO jmr_revision VALUES (1,0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS jmr_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, action TEXT NOT NULL, detail TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS jmr_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, payload TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_monthly_records_month ON monthly_records(month)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_monthly_records_department_month ON monthly_records(department_id, month)"),
  ]);
}

export async function GET(request: Request) {
  const unauthorized = await requirePinSession(request);
  if (unauthorized) return unauthorized;
  await init();
  const [departments, records] = await Promise.all([
    env.DB.prepare("SELECT id, meter_section AS meterSection, category, owner, phone, occupant, occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active FROM departments ORDER BY meter_section").all(),
    env.DB.prepare("SELECT id, month, department_id AS departmentId, meter_fee AS meterFee, kilo_price AS kiloPrice, rent, services, previous_reading AS previousReading, current_reading AS currentReading, locked, confirmed FROM monthly_records ORDER BY month DESC, department_id").all(),
  ]);
  const revision = await env.DB.prepare("SELECT version FROM jmr_revision WHERE id=1").first<{version:number}>();
  const audit = await env.DB.prepare("SELECT * FROM jmr_audit ORDER BY id DESC LIMIT 200").all();
  return Response.json({ departments: departments.results, records: records.results, version: revision?.version, audit: audit.results }, {headers:{"Cache-Control":"no-store"}});
}

export async function POST(request: Request) {
  try { return await mutate(request); } catch(error) {
    if (/CHECK constraint/i.test(String(error))) return Response.json({error:"تغيّرت البيانات بجهاز آخر. أعد تحميل البيانات وراجع التعديلات."},{status:409});
    console.error("JMR save failed", error);
    return Response.json({error:"تعذّر الحفظ. احتفظ بتعديلاتك وحاول مجدداً."},{status:503});
  }
}
async function mutate(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({error:"مصدر الطلب غير مسموح"},{status:403});
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

  if (!Number.isSafeInteger(body.version) || (body.version as number)<0) return Response.json({error:"حدّث الصفحة قبل الحفظ"},{status:409});
  const statements: ReturnType<typeof env.DB.prepare>[] = [];
  if (body.action === "addDepartment") {
    if (!isObject(body.department)) return Response.json({ error: "بيانات القسم غير صالحة" }, { status: 400 });
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
    statements.push(env.DB.prepare("INSERT INTO departments (meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)").bind(meterSection, category, owner, phone, occupant, occupantNumber, rentStart, rentEnd));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO monthly_records (month,department_id) SELECT DISTINCT month,(SELECT id FROM departments WHERE meter_section=? ORDER BY id DESC LIMIT 1) FROM monthly_records WHERE month NOT IN (SELECT month FROM monthly_records WHERE locked=1)`).bind(meterSection));
  } else if (body.action === "createMonth") {
    if (!validMonth(body.month)) return Response.json({ error: "الشهر غير صالح" }, { status: 400 });
    const month = body.month;
    const exists = await env.DB.prepare("SELECT id FROM monthly_records WHERE month=? LIMIT 1").bind(month).first();
    if(exists) return Response.json({error:"الشهر موجود"},{status:409});
    const latest = await env.DB.prepare("SELECT MAX(month) AS month FROM monthly_records").first<{month:string|null}>();
    if(latest?.month && month <= latest.month) return Response.json({error:"أنشئ الأشهر بالترتيب الزمني"},{status:409});
    const active = await env.DB.prepare("SELECT id FROM departments WHERE active = 1").all<{ id: number }>();
    const inserts = active.results.map(({ id }) => env.DB.prepare(`INSERT OR IGNORE INTO monthly_records (month, department_id, previous_reading, current_reading)
      VALUES (?, ?, COALESCE((SELECT current_reading FROM monthly_records WHERE department_id = ? AND month < ? ORDER BY month DESC LIMIT 1), 0), COALESCE((SELECT current_reading FROM monthly_records WHERE department_id = ? AND month < ? ORDER BY month DESC LIMIT 1), 0))`).bind(month, id, id, month, id, month));
    if (inserts.length) statements.push(...inserts);
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
    const next = await env.DB.prepare("SELECT locked,current_reading AS currentReading,previous_reading AS previousReading FROM monthly_records WHERE department_id=? AND month>? ORDER BY month LIMIT 1").bind(existing.departmentId,existing.month).first<{locked:number;currentReading:number;previousReading:number}>();
    if(next && currentReading!==next.previousReading && (next.locked || currentReading>next.currentReading)) return Response.json({error:"التعديل يؤثر على شهر مقفّل أو يجعل استهلاك الشهر التالي سالباً"},{status:409});
    statements.push(
      env.DB.prepare("UPDATE monthly_records SET meter_fee=?, kilo_price=?, rent=?, services=?, previous_reading=?, current_reading=?, confirmed=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(meterFee, kiloPrice, rent, services, previousReading, currentReading, id),
      env.DB.prepare("UPDATE monthly_records SET previous_reading=?, confirmed=0, updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT id FROM monthly_records WHERE department_id=? AND month>? ORDER BY month ASC LIMIT 1) AND previous_reading<>? AND locked=0").bind(currentReading, existing.departmentId, existing.month, currentReading),
    );
  } else if (body.action === "lockMonth") {
    if (!validMonth(body.month) || (body.locked !== 0 && body.locked !== 1)) return Response.json({ error: "بيانات اعتماد الشهر غير صالحة" }, { status: 400 });
    if(body.locked===1) {
      const invalid = await env.DB.prepare("SELECT id FROM monthly_records WHERE month=? AND (current_reading<previous_reading OR confirmed=0) LIMIT 1").bind(body.month).first();
      if(invalid) return Response.json({error:"احفظ وراجع كل سجلات الشهر قبل اعتماده"},{status:400});
    }
    statements.push(env.DB.prepare("UPDATE monthly_records SET locked = ? WHERE month = ?").bind(body.locked, body.month));
  } else {
    return Response.json({ error: "unknown action" }, { status: 400 });
  }
  const snapshot = await GET(request).then(r=>r.json());
  await env.DB.batch([
    env.DB.prepare("UPDATE jmr_revision SET version=CASE WHEN version=? THEN version+1 ELSE -1 END WHERE id=1").bind(body.version),
    env.DB.prepare("INSERT INTO jmr_backups(payload) VALUES (?)").bind(JSON.stringify(snapshot)),
    ...statements,
    env.DB.prepare("INSERT INTO jmr_audit(action,detail) VALUES (?,?)").bind(body.action,JSON.stringify(body)),
    env.DB.prepare("DELETE FROM jmr_backups WHERE id NOT IN (SELECT id FROM jmr_backups ORDER BY id DESC LIMIT 100)"),
  ]);
  return Response.json({ ok: true });
}
