import { failure, hashPassword, jsonNoStore, readJsonObject, requireSession, sameOrigin } from "@/lib/auth";
import {
  assertJmr, cleanText, isRecordReady, JmrError, nextMonth, nonNegativeNumber,
  optionalDate, positiveId, recordCharges, requireMonth, roundedMoney, validDate,
  type Actor, type AuditEntry, type Department, type MonthStatus, type MonthlyRecord,
  type Payment, type PaymentKind, type PublicUser, type Role,
} from "@/lib/jmr-core";
import { getDb, initDatabase, usersCount } from "@/lib/jmr-db";

export const dynamic = "force-dynamic";

type Input = Record<string, unknown>;
type ExistingRecord = { id: number; month: string; departmentId: number; revision: number };

function auditStatement(actor: Actor, action: string, detail: string) {
  return getDb().prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), actor.id, actor.name, action, detail);
}

function requireWrite(actor: Actor): void {
  assertJmr(actor.role !== "viewer", "الحساب للعرض فقط", 403);
}

function requireOwner(actor: Actor): void {
  assertJmr(actor.role === "owner", "هالإجراء متاح للمالك فقط", 403);
}

function departmentInput(value: unknown): Omit<Department, "id"> {
  assertJmr(value && typeof value === "object" && !Array.isArray(value), "بيانات القسم غير صالحة");
  const source = value as Input;
  const rentStart = optionalDate(source.rentStart);
  const rentEnd = optionalDate(source.rentEnd);
  assertJmr(!rentStart || !rentEnd || rentEnd >= rentStart, "تاريخ انتهاء الإيجار لازم يكون بعد تاريخ البدء");
  assertJmr(source.active === 0 || source.active === 1, "حالة القسم غير صالحة");
  return {
    meterSection: cleanText(source.meterSection, 80, true),
    category: cleanText(source.category, 120, true),
    owner: cleanText(source.owner, 180),
    phone: cleanText(source.phone, 50),
    occupant: cleanText(source.occupant, 180, true),
    occupantNumber: cleanText(source.occupantNumber, 80),
    rentStart,
    rentEnd,
    active: source.active,
  };
}

function paymentKind(value: unknown): PaymentKind {
  assertJmr(value === "rent" || value === "electricity", "نوع الفاتورة غير صالح");
  return value;
}

function beirutToday(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function latestMonth(): Promise<MonthStatus | null> {
  return getDb().prepare(`SELECT month, locked, approved_at AS approvedAt, approved_by AS approvedBy
    FROM month_status ORDER BY month DESC LIMIT 1`).first<MonthStatus>();
}

async function syncDepartmentToMonth(departmentId: number, month: string): Promise<void> {
  const db = getDb();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO monthly_records (
      month, department_id, previous_reading, current_reading, locked
    ) SELECT ?, d.id,
      COALESCE((SELECT current_reading FROM monthly_records WHERE department_id = d.id AND month < ? ORDER BY month DESC LIMIT 1), 0),
      COALESCE((SELECT current_reading FROM monthly_records WHERE department_id = d.id AND month < ? ORDER BY month DESC LIMIT 1), 0), 0
      FROM departments d WHERE d.id = ? AND d.active = 1`).bind(month, month, month, departmentId),
    db.prepare(`INSERT OR IGNORE INTO record_meta (record_id, confirmed, revision)
      SELECT id, 0, 1 FROM monthly_records WHERE month = ? AND department_id = ?`).bind(month, departmentId),
    db.prepare(`INSERT OR IGNORE INTO monthly_snapshots (
      record_id, meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end
    ) SELECT r.id, d.meter_section, d.category, d.owner, d.phone, d.occupant, d.occupant_number, d.rent_start, d.rent_end
      FROM monthly_records r JOIN departments d ON d.id = r.department_id
      WHERE r.month = ? AND r.department_id = ?`).bind(month, departmentId),
  ]);
}

export async function GET(request: Request) {
  try {
    const actor = await requireSession(request);
    await initDatabase();
    const db = getDb();
    const [departments, records, months, payments] = await Promise.all([
      db.prepare(`SELECT id, meter_section AS meterSection, category, owner, phone, occupant,
        occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active
        FROM departments ORDER BY meter_section`).all<Department>(),
      db.prepare(`SELECT r.id, r.month, r.department_id AS departmentId, r.meter_fee AS meterFee,
        r.kilo_price AS kiloPrice, r.rent, r.services, r.previous_reading AS previousReading,
        r.current_reading AS currentReading, m.confirmed, m.revision,
        s.meter_section AS meterSection, s.category, s.owner, s.phone, s.occupant,
        s.occupant_number AS occupantNumber, s.rent_start AS rentStart, s.rent_end AS rentEnd
        FROM monthly_records r JOIN record_meta m ON m.record_id = r.id
        JOIN monthly_snapshots s ON s.record_id = r.id
        ORDER BY r.month DESC, s.meter_section`).all<MonthlyRecord>(),
      db.prepare(`SELECT month, locked, approved_at AS approvedAt, approved_by AS approvedBy
        FROM month_status ORDER BY month DESC`).all<MonthStatus>(),
      db.prepare(`SELECT id, record_id AS recordId, kind, amount, paid_at AS paidAt, note,
        received_by AS receivedBy, created_at AS createdAt, voided_at AS voidedAt,
        voided_by AS voidedBy, void_reason AS voidReason, request_id AS requestId
        FROM payments ORDER BY created_at DESC`).all<Payment>(),
    ]);

    const users = actor.role === "owner"
      ? (await db.prepare(`SELECT id, username, name, role, active, session_version AS sessionVersion
          FROM users ORDER BY name`).all<PublicUser>()).results
      : [];
    const audit = actor.role === "owner"
      ? (await db.prepare(`SELECT id, created_at AS createdAt, actor_name AS actorName, action, detail
          FROM audit_log ORDER BY created_at DESC LIMIT 200`).all<AuditEntry>()).results
      : [];

    return jsonNoStore({
      actor,
      bootstrap: actor.id === "bootstrap",
      departments: departments.results,
      records: records.results,
      months: months.results,
      payments: payments.results,
      users,
      audit,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await requireSession(request);
    await initDatabase();
    const body = await readJsonObject(request);
    const action = typeof body.action === "string" ? body.action : "";
    assertJmr(action.length > 0, "الإجراء غير صالح");
    if (actor.id === "bootstrap") assertJmr(action === "saveUser", "أنشئ حساب المالك أولاً", 403);
    requireWrite(actor);
    const db = getDb();

    if (action === "addDepartment") {
      const department = departmentInput(body.department);
      const duplicate = await db.prepare(`SELECT id FROM departments WHERE lower(trim(meter_section)) = lower(trim(?)) LIMIT 1`)
        .bind(department.meterSection).first<{ id: number }>();
      assertJmr(!duplicate, "عداد / قسم مسجّل مسبقاً", 409);
      const selectedMonth = typeof body.month === "string" ? body.month : "";
      const month = selectedMonth ? requireMonth(selectedMonth) : null;
      const monthRow = month ? await db.prepare("SELECT locked FROM month_status WHERE month = ?").bind(month).first<{ locked: number }>() : null;

      await db.batch([
        db.prepare(`INSERT INTO departments (meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(department.meterSection, department.category, department.owner, department.phone, department.occupant,
            department.occupantNumber, department.rentStart, department.rentEnd, department.active),
        auditStatement(actor, "addDepartment", `إضافة القسم ${department.meterSection}`),
      ]);
      const inserted = await db.prepare(`SELECT id FROM departments WHERE lower(trim(meter_section)) = lower(trim(?)) ORDER BY id DESC LIMIT 1`)
        .bind(department.meterSection).first<{ id: number }>();
      if (inserted && monthRow && Number(monthRow.locked) === 0 && department.active === 1) await syncDepartmentToMonth(inserted.id, month!);
      return jsonNoStore({ ok: true, message: "تمت إضافة القسم" });
    }

    if (action === "updateDepartment") {
      const id = positiveId(body.id);
      const department = departmentInput(body.department);
      const exists = await db.prepare("SELECT id FROM departments WHERE id = ?").bind(id).first();
      assertJmr(exists, "القسم غير موجود", 404);
      const duplicate = await db.prepare(`SELECT id FROM departments
        WHERE lower(trim(meter_section)) = lower(trim(?)) AND id <> ? LIMIT 1`)
        .bind(department.meterSection, id).first();
      assertJmr(!duplicate, "عداد / قسم مسجّل مسبقاً", 409);
      await db.batch([
        db.prepare(`UPDATE departments SET meter_section=?, category=?, owner=?, phone=?, occupant=?, occupant_number=?,
          rent_start=?, rent_end=?, active=? WHERE id=?`)
          .bind(department.meterSection, department.category, department.owner, department.phone, department.occupant,
            department.occupantNumber, department.rentStart, department.rentEnd, department.active, id),
        auditStatement(actor, "updateDepartment", `تعديل القسم ${department.meterSection}. الفواتير السابقة بقيت بنسختها المحفوظة.`),
      ]);
      return jsonNoStore({ ok: true, message: "تم تعديل القسم بدون تغيير الفواتير القديمة" });
    }

    if (action === "createMonth") {
      const month = requireMonth(body.month);
      const existing = await db.prepare("SELECT month FROM month_status WHERE month = ?").bind(month).first();
      assertJmr(!existing, "الشهر موجود مسبقاً", 409);
      const latest = await latestMonth();
      if (latest) {
        assertJmr(Number(latest.locked) === 1, "اعتمد الشهر المفتوح قبل إنشاء شهر جديد", 409);
        assertJmr(month === nextMonth(latest.month), `الشهر التالي لازم يكون ${nextMonth(latest.month)}`, 409);
      }
      const active = await db.prepare("SELECT COUNT(*) AS count FROM departments WHERE active = 1").first<{ count: number }>();
      assertJmr(Number(active?.count ?? 0) > 0, "أضف قسماً فعّالاً أولاً");
      await db.batch([
        db.prepare("INSERT INTO month_status (month, locked) VALUES (?, 0)").bind(month),
        db.prepare(`INSERT INTO monthly_records (month, department_id, previous_reading, current_reading, locked)
          SELECT ?, d.id,
            COALESCE((SELECT current_reading FROM monthly_records WHERE department_id=d.id AND month<? ORDER BY month DESC LIMIT 1),0),
            COALESCE((SELECT current_reading FROM monthly_records WHERE department_id=d.id AND month<? ORDER BY month DESC LIMIT 1),0), 0
          FROM departments d WHERE d.active=1`).bind(month, month, month),
        db.prepare(`INSERT OR IGNORE INTO record_meta (record_id, confirmed, revision)
          SELECT id, 0, 1 FROM monthly_records WHERE month = ?`).bind(month),
        db.prepare(`INSERT OR IGNORE INTO monthly_snapshots (record_id, meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end)
          SELECT r.id,d.meter_section,d.category,d.owner,d.phone,d.occupant,d.occupant_number,d.rent_start,d.rent_end
          FROM monthly_records r JOIN departments d ON d.id=r.department_id WHERE r.month=?`).bind(month),
        auditStatement(actor, "createMonth", `إنشاء شهر ${month}`),
      ]);
      return jsonNoStore({ ok: true, message: "تم إنشاء الشهر. القراءات الجديدة بحاجة مراجعة وحفظ." });
    }

    if (action === "addToMonth") {
      const month = requireMonth(body.month);
      const departmentId = positiveId(body.departmentId);
      const latest = await latestMonth();
      assertJmr(latest?.month === month && Number(latest.locked) === 0, "الإضافة متاحة لآخر شهر مفتوح فقط", 409);
      const department = await db.prepare("SELECT active, meter_section AS meterSection FROM departments WHERE id=?").bind(departmentId).first<{ active: number; meterSection: string }>();
      assertJmr(department && Number(department.active) === 1, "القسم غير موجود أو مؤرشف");
      const exists = await db.prepare("SELECT id FROM monthly_records WHERE month=? AND department_id=?").bind(month, departmentId).first();
      assertJmr(!exists, "القسم موجود بالشهر", 409);
      await syncDepartmentToMonth(departmentId, month);
      await db.batch([auditStatement(actor, "addToMonth", `إضافة ${department.meterSection} إلى ${month}`)]);
      return jsonNoStore({ ok: true, message: "تمت إضافة القسم للشهر" });
    }

    if (action === "updateRecord") {
      const id = positiveId(body.id);
      const expectedRevision = positiveId(body.expectedRevision);
      assertJmr(body.record && typeof body.record === "object" && !Array.isArray(body.record), "بيانات السجل غير صالحة");
      const input = body.record as Input;
      const existing = await db.prepare(`SELECT r.id, r.month, r.department_id AS departmentId, m.revision
        FROM monthly_records r JOIN record_meta m ON m.record_id=r.id WHERE r.id=?`).bind(id).first<ExistingRecord>();
      assertJmr(existing, "السجل غير موجود", 404);
      const latest = await latestMonth();
      assertJmr(latest?.month === existing.month && Number(latest.locked) === 0, "التعديل متاح لآخر شهر مفتوح فقط. الأشهر السابقة أرشيف ثابت.", 409);
      assertJmr(Number(existing.revision) === expectedRevision, "السجل تغيّر بجلسة تانية. حدّث الصفحة وراجع الأرقام.", 409);

      const meterFee = nonNegativeNumber(input.meterFee);
      const kiloPrice = nonNegativeNumber(input.kiloPrice, 1_000_000);
      const rent = nonNegativeNumber(input.rent);
      const services = nonNegativeNumber(input.services);
      const currentReading = nonNegativeNumber(input.currentReading, 10_000_000_000);
      const requestedPrevious = nonNegativeNumber(input.previousReading, 10_000_000_000);
      const prior = await db.prepare(`SELECT current_reading AS currentReading FROM monthly_records
        WHERE department_id=? AND month<? ORDER BY month DESC LIMIT 1`).bind(existing.departmentId, existing.month).first<{ currentReading: number }>();
      const previousReading = prior ? Number(prior.currentReading) : requestedPrevious;
      assertJmr(currentReading >= previousReading, "العداد الحالي لازم يكون أكبر أو يساوي العداد السابق");
      const calculated = recordCharges({ meterFee, kiloPrice, rent, services, previousReading, currentReading });
      assertJmr(calculated.total <= 100_000_000, "المجموع أكبر من الحد المسموح");

      const token = crypto.randomUUID();
      const results = await db.batch([
        db.prepare(`UPDATE record_meta SET revision=revision+1, write_token=?, confirmed=0
          WHERE record_id=? AND revision=?`).bind(token, id, expectedRevision),
        db.prepare(`UPDATE monthly_records SET meter_fee=?, kilo_price=?, rent=?, services=?, previous_reading=?, current_reading=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND EXISTS (SELECT 1 FROM record_meta WHERE record_id=? AND write_token=?)`)
          .bind(meterFee, kiloPrice, rent, services, previousReading, currentReading, id, id, token),
        db.prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM record_meta WHERE record_id=? AND write_token=?)`)
          .bind(crypto.randomUUID(), new Date().toISOString(), actor.id, actor.name, "updateRecord", `حفظ سجل ${existing.month} رقم ${id}`, id, token),
        db.prepare("UPDATE record_meta SET confirmed=1, write_token=NULL WHERE record_id=? AND write_token=?").bind(id, token),
      ]);
      assertJmr(Number(results[0]?.meta?.changes ?? 0) === 1, "السجل تغيّر بجلسة تانية. حدّث الصفحة وراجع الأرقام.", 409);
      return jsonNoStore({ ok: true, message: "تم حفظ السجل وتأكيد اكتماله" });
    }

    if (action === "lockMonth") {
      requireOwner(actor);
      const month = requireMonth(body.month);
      assertJmr(body.locked === 0 || body.locked === 1, "حالة الشهر غير صالحة");
      const row = await db.prepare("SELECT locked FROM month_status WHERE month=?").bind(month).first<{ locked: number }>();
      assertJmr(row, "الشهر غير موجود", 404);
      const latest = await latestMonth();
      assertJmr(latest?.month === month, "يمكن تغيير حالة آخر شهر فقط", 409);

      if (body.locked === 1) {
        const incomplete = await db.prepare(`SELECT COUNT(*) AS count FROM monthly_records r
          JOIN record_meta m ON m.record_id=r.id WHERE r.month=? AND (m.confirmed<>1 OR r.current_reading<r.previous_reading)`)
          .bind(month).first<{ count: number }>();
        const count = await db.prepare("SELECT COUNT(*) AS count FROM monthly_records WHERE month=?").bind(month).first<{ count: number }>();
        assertJmr(Number(count?.count ?? 0) > 0 && Number(incomplete?.count ?? 0) === 0, "أكمل واحفظ كل القراءات قبل اعتماد الشهر");
        const now = new Date().toISOString();
        await db.batch([
          db.prepare("UPDATE month_status SET locked=1, approved_at=?, approved_by=? WHERE month=?").bind(now, actor.name, month),
          db.prepare("UPDATE monthly_records SET locked=1 WHERE month=?").bind(month),
          auditStatement(actor, "lockMonth", `اعتماد شهر ${month}`),
        ]);
        return jsonNoStore({ ok: true, message: "تم اعتماد الشهر وإقفاله" });
      }

      const activePayments = await db.prepare(`SELECT COUNT(*) AS count FROM payments p JOIN monthly_records r ON r.id=p.record_id
        WHERE r.month=? AND p.voided_at IS NULL`).bind(month).first<{ count: number }>();
      assertJmr(Number(activePayments?.count ?? 0) === 0, "اعكس إيصالات الشهر قبل إعادة فتحه", 409);
      await db.batch([
        db.prepare("UPDATE month_status SET locked=0, approved_at=NULL, approved_by=NULL WHERE month=?").bind(month),
        db.prepare("UPDATE monthly_records SET locked=0 WHERE month=?").bind(month),
        auditStatement(actor, "unlockMonth", `إعادة فتح شهر ${month}`),
      ]);
      return jsonNoStore({ ok: true, message: "تم إعادة فتح الشهر" });
    }

    if (action === "addPayment") {
      const recordId = positiveId(body.recordId);
      const kind = paymentKind(body.kind);
      const amount = roundedMoney(nonNegativeNumber(body.amount));
      assertJmr(amount > 0, "المبلغ لازم يكون أكبر من صفر");
      const paidAt = cleanText(body.paidAt, 10, true);
      assertJmr(validDate(paidAt) && paidAt <= beirutToday(), "تاريخ الدفع غير صالح أو مستقبلي");
      const note = cleanText(body.note, 500);
      const requestId = cleanText(body.requestId, 80, true);
      assertJmr(/^[A-Za-z0-9-]{16,80}$/.test(requestId), "معرّف الدفعة غير صالح");

      const priorRequest = await db.prepare(`SELECT id, record_id AS recordId, kind, amount, paid_at AS paidAt, note
        FROM payments WHERE request_id=? LIMIT 1`).bind(requestId).first<{ id: string; recordId: number; kind: PaymentKind; amount: number; paidAt: string; note: string }>();
      if (priorRequest) {
        assertJmr(priorRequest.recordId === recordId && priorRequest.kind === kind && roundedMoney(Number(priorRequest.amount)) === amount && priorRequest.paidAt === paidAt && priorRequest.note === note,
          "معرّف الدفعة مستخدم لطلب مختلف", 409);
        return jsonNoStore({ ok: true, message: "الدفعة كانت مسجّلة مسبقاً", receiptId: priorRequest.id });
      }

      const record = await db.prepare(`SELECT r.id, r.meter_fee AS meterFee, r.kilo_price AS kiloPrice, r.rent, r.services,
        r.previous_reading AS previousReading, r.current_reading AS currentReading, m.confirmed, s.meter_section AS meterSection,
        ms.locked FROM monthly_records r JOIN record_meta m ON m.record_id=r.id JOIN monthly_snapshots s ON s.record_id=r.id
        JOIN month_status ms ON ms.month=r.month WHERE r.id=?`).bind(recordId)
        .first<MonthlyRecord & { locked: number }>();
      assertJmr(record && Number(record.locked) === 1 && isRecordReady(record), "اعتمد الشهر قبل تسجيل الدفعات", 409);
      const due = recordCharges(record)[kind];
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO payments (id, record_id, kind, amount, paid_at, note, received_by, created_at, request_id)
          SELECT ?,?,?,?,?,?,?,?,? WHERE ? <= ? - COALESCE((SELECT SUM(amount) FROM payments WHERE record_id=? AND kind=? AND voided_at IS NULL),0) + 0.0001`)
          .bind(id, recordId, kind, amount, paidAt, note, actor.name, createdAt, requestId, amount, due, recordId, kind),
        db.prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail)
          SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM payments WHERE id=?)`)
          .bind(crypto.randomUUID(), createdAt, actor.id, actor.name, "addPayment", `قبض ${amount.toFixed(2)} USD — ${record.meterSection}`, id),
      ]);
      const saved = await db.prepare("SELECT id FROM payments WHERE request_id=?").bind(requestId).first<{ id: string }>();
      assertJmr(saved, "الرصيد تغيّر بجلسة تانية. حدّث الصفحة وراجع المتبقي.", 409);
      return jsonNoStore({ ok: true, message: "تم تسجيل الدفعة وإصدار الإيصال", receiptId: saved.id });
    }

    if (action === "voidPayment") {
      requireOwner(actor);
      const id = cleanText(body.id, 80, true);
      const reason = cleanText(body.reason, 500, true);
      const payment = await db.prepare("SELECT id FROM payments WHERE id=? AND voided_at IS NULL").bind(id).first();
      assertJmr(payment, "الإيصال غير موجود أو معكوس مسبقاً", 404);
      const now = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE payments SET voided_at=?, voided_by=?, void_reason=? WHERE id=? AND voided_at IS NULL").bind(now, actor.name, reason, id),
        auditStatement(actor, "voidPayment", `عكس الإيصال ${id}: ${reason}`),
      ]);
      return jsonNoStore({ ok: true, message: "تم عكس الإيصال وحفظه بالأرشيف" });
    }

    if (action === "saveUser") {
      requireOwner(actor);
      assertJmr(body.user && typeof body.user === "object" && !Array.isArray(body.user), "بيانات المستخدم غير صالحة");
      const input = body.user as Input;
      const id = typeof body.id === "string" && body.id ? body.id : null;
      const username = cleanText(input.username, 64, true).toLowerCase();
      assertJmr(/^[a-z0-9._-]{3,64}$/.test(username), "اسم المستخدم لازم يكون 3–64 حرف إنكليزي أو رقم");
      const name = cleanText(input.name, 100, true);
      assertJmr(input.role === "owner" || input.role === "accountant" || input.role === "viewer", "الصلاحية غير صالحة");
      const role = input.role as Role;
      assertJmr(input.active === 0 || input.active === 1, "حالة الحساب غير صالحة");
      const active = input.active;
      const password = typeof body.password === "string" ? body.password : "";
      const existing = id ? await db.prepare(`SELECT id, username, role, active, password_hash AS passwordHash,
        session_version AS sessionVersion FROM users WHERE id=?`).bind(id).first<{ id: string; username: string; role: Role; active: number; passwordHash: string; sessionVersion: number }>() : null;
      if (id) assertJmr(existing, "الحساب غير موجود", 404);
      const duplicate = await db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?").bind(username, id ?? "").first();
      assertJmr(!duplicate, "اسم المستخدم موجود مسبقاً", 409);

      if (actor.id === "bootstrap") {
        assertJmr(!id && role === "owner" && active === 1, "أول حساب لازم يكون مالك فعّال");
      }
      if (id === actor.id) assertJmr(role === "owner" && active === 1, "ما فيك تعطّل حسابك أو تشيل صلاحية المالك");
      if (existing?.role === "owner" && (role !== "owner" || active === 0)) {
        const owners = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='owner' AND active=1 AND id<>?").bind(existing.id).first<{ count: number }>();
        assertJmr(Number(owners?.count ?? 0) > 0, "لازم يبقى مالك فعّال واحد على الأقل");
      }

      const userId = existing?.id ?? crypto.randomUUID();
      const passwordHash = password ? await hashPassword(password) : existing?.passwordHash;
      assertJmr(passwordHash, "كلمة المرور مطلوبة");
      const changedSecurity = !existing || Boolean(password) || existing.role !== role || Number(existing.active) !== active;
      const sessionVersion = existing ? Number(existing.sessionVersion) + (changedSecurity ? 1 : 0) : 1;
      const detail = `${existing ? "تعديل" : "إضافة"} المستخدم ${username} — ${role} — ${active ? "فعّال" : "معطّل"}`;
      await db.batch([
        existing
          ? db.prepare(`UPDATE users SET username=?, name=?, role=?, active=?, password_hash=?, session_version=? WHERE id=?`)
              .bind(username, name, role, active, passwordHash, sessionVersion, userId)
          : db.prepare(`INSERT INTO users (id, username, name, role, active, password_hash, session_version) VALUES (?,?,?,?,?,?,?)`)
              .bind(userId, username, name, role, active, passwordHash, sessionVersion),
        auditStatement(actor, "saveUser", detail),
      ]);
      if (existing && changedSecurity) await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
      if (actor.id === "bootstrap") await db.prepare("DELETE FROM sessions WHERE user_id='bootstrap'").run();
      assertJmr(await usersCount() > 0, "تعذّر إنشاء الحساب", 503);
      return jsonNoStore({ ok: true, message: actor.id === "bootstrap" ? "تم إنشاء حساب المالك. سجّل الدخول بالحساب الجديد." : "تم حفظ المستخدم" });
    }

    throw new JmrError("الإجراء غير معروف", 400);
  } catch (error) {
    return failure(error);
  }
}
