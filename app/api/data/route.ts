import { env, init, snapshot } from "@/lib/database";
import { isAllowedOrigin, requirePinSession } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

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

const MAX_REQUEST_BYTES = 100_000;

// Latest month that may be created: the current month in Beirut plus one, so next month
// can be prepared early but a mistyped far-future month cannot block earlier months.
function latestAllowedMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

// Snapshot saved as the automatic backup before every change; a failed read must stop
// the change instead of storing an error message as the backup.
async function currentData(request: Request): Promise<JsonObject> {
  const response = await snapshot(() => readData(request));
  if (!response.ok) throw new Error("Snapshot before change failed");
  return response.json();
}

export async function GET(request: Request) {
  const denied=await requirePinSession(request);if(denied)return denied;
  try { return await snapshot(()=>readData(request)); } catch {return Response.json({error:"تعذّر تحميل البيانات"},{status:503});}
}
async function readData(request: Request) {
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
    if (/CHECK constraint|REVISION_CONFLICT/i.test(String(error))) return Response.json({error:"تغيّرت البيانات بجهاز آخر. أعد تحميل البيانات وراجع التعديلات."},{status:409});
    console.error("JMR save failed", error);
    return Response.json({error:"تعذّر الحفظ. احتفظ بتعديلاتك وحاول مجدداً."},{status:503});
  }
}
async function mutate(request: Request) {
  if (!isAllowedOrigin(request)) return Response.json({error:"مصدر الطلب غير مسموح"},{status:403});
  const unauthorized = await requirePinSession(request);
  if (unauthorized) return unauthorized;
  await init();
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_BYTES) return Response.json({ error: "الطلب كبير جداً" }, { status: 413 });
    body = JSON.parse(raw);
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
    if (month > latestAllowedMonth()) return Response.json({ error: "لا يمكن إنشاء شهر بعد الشهر القادم" }, { status: 400 });
    const exists = await env.DB.prepare("SELECT id FROM monthly_records WHERE month=? LIMIT 1").bind(month).first();
    if(exists) return Response.json({error:"الشهر موجود"},{status:409});
    const latest = await env.DB.prepare("SELECT MAX(month) AS month FROM monthly_records").first<{month:string|null}>();
    if(latest?.month && month <= latest.month) return Response.json({error:"أنشئ الأشهر بالترتيب الزمني"},{status:409});
    const active = await env.DB.prepare("SELECT id FROM departments WHERE active = 1").all<{ id: number }>();
    const inserts = [];
    for(const {id} of active.results) {
      const prior = await env.DB.prepare("SELECT current_reading AS value FROM monthly_records WHERE department_id=? AND month<? ORDER BY month DESC LIMIT 1").bind(id,month).first<{value:number}>();
      const reading=prior?.value??0;
      inserts.push(env.DB.prepare("INSERT OR IGNORE INTO monthly_records (month,department_id,previous_reading,current_reading) VALUES (?,?,?,?)").bind(month,id,reading,reading));
    }
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
      env.DB.prepare("UPDATE monthly_records SET previous_reading=?, confirmed=0, updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT id FROM (SELECT id FROM monthly_records WHERE department_id=? AND month>? ORDER BY month ASC LIMIT 1) AS next_record) AND previous_reading<>? AND locked=0").bind(currentReading, existing.departmentId, existing.month, currentReading),
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
  const before = await currentData(request);
  await env.DB.batch([
    env.DB.prepare("UPDATE jmr_revision SET version=CASE WHEN version=? THEN version+1 ELSE -1 END WHERE id=1").bind(body.version),
    env.DB.prepare("INSERT INTO jmr_backups(payload) VALUES (?)").bind(JSON.stringify(before)),
    ...statements,
    env.DB.prepare("INSERT INTO jmr_audit(action,detail) VALUES (?,?)").bind(body.action,JSON.stringify(body)),
    env.DB.prepare("DELETE FROM jmr_backups WHERE id NOT IN (SELECT id FROM (SELECT id FROM jmr_backups ORDER BY id DESC LIMIT 100) AS retained_backups)"),
  ]);
  return Response.json({ ok: true });
}
