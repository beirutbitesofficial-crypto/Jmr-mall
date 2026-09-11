import * as XLSX from "xlsx";
import { failure, jsonNoStore, requireSession, sameOrigin } from "@/lib/auth";
import { getDb, initDatabase } from "@/lib/jmr-db";
import { JmrError } from "@/lib/jmr-core";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

type ParsedRow = {
  sourceSheet: string;
  sourceRow: number;
  meterSection: string;
  category?: string;
  owner?: string;
  phone?: string;
  occupant?: string;
  occupantNumber?: string;
  rentStart?: string;
  rentEnd?: string;
  meterFee?: number;
  kiloPrice?: number;
  rent?: number;
  services?: number;
  previousReading?: number;
  currentReading?: number;
  score: number;
};

type DepartmentRow = {
  id: number;
  meterSection: string;
  category: string;
  owner: string;
  phone: string;
  occupant: string;
  occupantNumber: string;
  rentStart: string | null;
  rentEnd: string | null;
  active: number;
};

const headerAliases: Record<string, string[]> = {
  meterSection: ["رقم العداد", "عداد قسم", "عداد/قسم", "رقم القسم", "القسم", "section", "meter"],
  category: ["نوعية القسم", "نوع القسم", "category", "type"],
  owner: ["صاحب القسم", "مالك القسم", "المالك", "owner"],
  phone: ["رقم التليفون", "رقم التلفون", "رقم الهاتف", "هاتف", "phone", "mobile"],
  occupant: ["اسم المستثمر", "المستثمر", "مستخدم القسم", "المستأجر", "occupant", "tenant"],
  occupantNumber: ["رقم المستثمر", "رقم المستأجر", "رقم المستخدم", "occupant number", "tenant number"],
  rentStart: ["تاريخ بدء الايجار", "تاريخ بداية الايجار", "بدء الايجار", "rent start"],
  rentEnd: ["تاريخ انتهاء الايجار", "نهاية الايجار", "انتهاء الايجار", "rent end"],
  previousReading: ["القراءة السابقة", "قراءة سابقة", "العداد السابق", "عداد سابق", "previous reading", "previous"],
  currentReading: ["القراءة الحالية", "قراءة حالية", "العداد الحالي", "عداد حالي", "current reading", "current"],
  kiloPrice: ["سعر الكيلو", "سعر الكيلووات", "سعر الكيلو واط", "kilo price", "kw price"],
  meterFee: ["بدل العداد", "رسم العداد", "رسوم العداد", "meter fee"],
  rent: ["الايجار", "الإيجار", "بدل الايجار", "rent"],
  services: ["الخدمات", "بدل خدمات", "رسوم الخدمات", "services", "service"],
};

function normalizeArabicDigits(value: string): string {
  return value.replace(/[٠-٩]/g, char => String("٠١٢٣٤٥٦٧٨٩".indexOf(char)))
    .replace(/[۰-۹]/g, char => String("۰۱۲۳۴۵۶۷۸۹".indexOf(char)));
}

function normalizeHeader(value: unknown): string {
  return normalizeArabicDigits(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/[\s_\-–—:()\[\]{}]+/g, " ")
    .replace(/[^\p{L}\p{N} /]/gu, "")
    .trim();
}

const normalizedAliases = Object.fromEntries(
  Object.entries(headerAliases).map(([key, aliases]) => [key, aliases.map(normalizeHeader)]),
) as Record<string, string[]>;

function headerKey(value: unknown): string | null {
  const normalized = normalizeHeader(value);
  if (!normalized) return null;
  for (const [key, aliases] of Object.entries(normalizedAliases)) {
    if (aliases.some(alias => normalized === alias || normalized.includes(alias))) return key;
  }
  return null;
}

function textValue(value: unknown): string | undefined {
  const valueText = String(value ?? "").trim();
  if (!valueText || valueText === "-" || valueText === "—" || valueText.toLowerCase() === "x") return undefined;
  return valueText.slice(0, 180);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = normalizeArabicDigits(String(value ?? ""))
    .replace(/[$€£,%\s]/g, "")
    .replace(/,/g, "")
    .trim();
  if (!cleaned || cleaned === "-" || cleaned.toLowerCase() === "x") return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateValue(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = normalizeArabicDigits(String(value ?? "")).trim();
  if (!text) return undefined;
  const direct = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, "0")}-${direct[3].padStart(2, "0")}`;
  const reverse = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (reverse) return `${reverse[3]}-${reverse[2].padStart(2, "0")}-${reverse[1].padStart(2, "0")}`;
  return undefined;
}

function parseWorkbook(buffer: ArrayBuffer, requestedSheet?: string): { rows: ParsedRow[]; sheets: string[]; warnings: string[] } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true, dense: true });
  const sheets = workbook.SheetNames;
  const selected = requestedSheet && sheets.includes(requestedSheet) ? [requestedSheet] : sheets;
  const warnings: string[] = [];
  const candidates: ParsedRow[] = [];

  for (const sheetName of selected) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: "" });
    let headerRowIndex = -1;
    let mapping = new Map<number, string>();
    let bestMatches = 0;
    for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 35); rowIndex += 1) {
      const candidate = new Map<number, string>();
      matrix[rowIndex].forEach((cell, columnIndex) => {
        const key = headerKey(cell);
        if (key && !Array.from(candidate.values()).includes(key)) candidate.set(columnIndex, key);
      });
      if (candidate.size > bestMatches) {
        bestMatches = candidate.size;
        headerRowIndex = rowIndex;
        mapping = candidate;
      }
    }
    if (headerRowIndex < 0 || !Array.from(mapping.values()).includes("meterSection")) {
      warnings.push(`تم تجاهل الشيت ${sheetName}: ما لقينا عمود واضح لرقم العداد/القسم.`);
      continue;
    }

    for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
      const source = matrix[rowIndex];
      const object: Record<string, unknown> = {};
      for (const [columnIndex, key] of mapping.entries()) object[key] = source[columnIndex];
      const meterSection = textValue(object.meterSection);
      if (!meterSection) continue;
      const row: ParsedRow = {
        sourceSheet: sheetName,
        sourceRow: rowIndex + 1,
        meterSection,
        category: textValue(object.category),
        owner: textValue(object.owner),
        phone: textValue(object.phone),
        occupant: textValue(object.occupant),
        occupantNumber: textValue(object.occupantNumber),
        rentStart: dateValue(object.rentStart),
        rentEnd: dateValue(object.rentEnd),
        previousReading: numberValue(object.previousReading),
        currentReading: numberValue(object.currentReading),
        kiloPrice: numberValue(object.kiloPrice),
        meterFee: numberValue(object.meterFee),
        rent: numberValue(object.rent),
        services: numberValue(object.services),
        score: mapping.size,
      };
      candidates.push(row);
    }
  }

  const deduped = new Map<string, ParsedRow>();
  for (const row of candidates) {
    const key = normalizeHeader(row.meterSection);
    const prior = deduped.get(key);
    if (!prior || row.score > prior.score) deduped.set(key, row);
    else warnings.push(`تكرار ${row.meterSection} في ${row.sourceSheet}; اعتمدنا السطر الأكثر اكتمالاً.`);
  }
  return { rows: [...deduped.values()], sheets, warnings };
}

function monthValue(value: FormDataEntryValue | null): string {
  const month = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new JmrError("اختار شهر صحيح", 400);
  return month;
}

function normalizeMatch(value: string): string {
  return normalizeHeader(value).replace(/\s+/g, "");
}

async function getDepartments(): Promise<DepartmentRow[]> {
  const result = await getDb().prepare(`SELECT id, meter_section AS meterSection, category, owner, phone, occupant,
    occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active
    FROM departments ORDER BY meter_section`).all<DepartmentRow>();
  return result.results;
}

function changedText(incoming: string | undefined, existing: string | null | undefined): boolean {
  return incoming !== undefined && incoming.trim() !== String(existing ?? "").trim();
}

async function buildPreview(rows: ParsedRow[], month: string, createMissing: boolean, updateMaster: boolean) {
  const departments = await getDepartments();
  const bySection = new Map(departments.map(item => [normalizeMatch(item.meterSection), item]));
  const byOccupantNumber = new Map(departments.filter(item => item.occupantNumber).map(item => [normalizeMatch(item.occupantNumber), item]));
  const preview = [] as Array<Record<string, unknown>>;

  for (const row of rows) {
    const existing = bySection.get(normalizeMatch(row.meterSection))
      ?? (row.occupantNumber ? byOccupantNumber.get(normalizeMatch(row.occupantNumber)) : undefined);
    const masterChanges: string[] = [];
    if (existing) {
      if (changedText(row.category, existing.category)) masterChanges.push("نوع القسم");
      if (changedText(row.owner, existing.owner)) masterChanges.push("المالك");
      if (changedText(row.phone, existing.phone)) masterChanges.push("الهاتف");
      if (changedText(row.occupant, existing.occupant)) masterChanges.push("المستثمر");
      if (changedText(row.occupantNumber, existing.occupantNumber)) masterChanges.push("رقم المستثمر");
      if (changedText(row.rentStart, existing.rentStart)) masterChanges.push("بدء العقد");
      if (changedText(row.rentEnd, existing.rentEnd)) masterChanges.push("انتهاء العقد");
    }
    const monthlyFields = [
      ["القراءة السابقة", row.previousReading], ["القراءة الحالية", row.currentReading], ["سعر الكيلو", row.kiloPrice],
      ["بدل العداد", row.meterFee], ["الإيجار", row.rent], ["الخدمات", row.services],
    ].filter(([, value]) => value !== undefined).map(([label]) => label);
    preview.push({
      meterSection: row.meterSection,
      sourceSheet: row.sourceSheet,
      sourceRow: row.sourceRow,
      matched: Boolean(existing),
      departmentId: existing?.id ?? null,
      status: existing ? "matched" : createMissing ? "will-create" : "unmatched",
      masterChanges: updateMaster ? masterChanges : [],
      masterDifferences: masterChanges,
      monthlyFields,
      month,
    });
  }
  return preview;
}

async function ensureMonth(month: string): Promise<void> {
  const db = getDb();
  await db.prepare("INSERT OR IGNORE INTO month_status (month, locked) VALUES (?, 0)").bind(month).run();
  const status = await db.prepare("SELECT locked FROM month_status WHERE month=?").bind(month).first<{ locked: number }>();
  if (Number(status?.locked ?? 0) === 1) throw new JmrError("هالشهر معتمد. أعد فتحه قبل الاستيراد.", 409);
}

async function commitRows(rows: ParsedRow[], month: string, createMissing: boolean, updateMaster: boolean, actorName: string, actorId: string) {
  const db = getDb();
  await ensureMonth(month);
  let departments = await getDepartments();
  let bySection = new Map(departments.map(item => [normalizeMatch(item.meterSection), item]));
  let byOccupantNumber = new Map(departments.filter(item => item.occupantNumber).map(item => [normalizeMatch(item.occupantNumber), item]));
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    let department = bySection.get(normalizeMatch(row.meterSection))
      ?? (row.occupantNumber ? byOccupantNumber.get(normalizeMatch(row.occupantNumber)) : undefined);

    if (!department && createMissing) {
      await db.prepare(`INSERT INTO departments (meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).bind(
        row.meterSection, row.category ?? "", row.owner ?? "", row.phone ?? "", row.occupant ?? "", row.occupantNumber ?? "",
        row.rentStart ?? null, row.rentEnd ?? null,
      ).run();
      department = await db.prepare(`SELECT id, meter_section AS meterSection, category, owner, phone, occupant,
        occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active
        FROM departments WHERE lower(trim(meter_section))=lower(trim(?)) ORDER BY id DESC LIMIT 1`).bind(row.meterSection).first<DepartmentRow>() ?? undefined;
      if (department) {
        created += 1;
        departments.push(department);
        bySection.set(normalizeMatch(department.meterSection), department);
        if (department.occupantNumber) byOccupantNumber.set(normalizeMatch(department.occupantNumber), department);
      }
    }

    if (!department) { skipped += 1; continue; }

    if (updateMaster) {
      await db.prepare(`UPDATE departments SET category=?, owner=?, phone=?, occupant=?, occupant_number=?, rent_start=?, rent_end=? WHERE id=?`).bind(
        row.category ?? department.category,
        row.owner ?? department.owner,
        row.phone ?? department.phone,
        row.occupant ?? department.occupant,
        row.occupantNumber ?? department.occupantNumber,
        row.rentStart ?? department.rentStart,
        row.rentEnd ?? department.rentEnd,
        department.id,
      ).run();
    }

    const prior = await db.prepare(`SELECT current_reading AS currentReading FROM monthly_records
      WHERE department_id=? AND month<? ORDER BY month DESC LIMIT 1`).bind(department.id, month).first<{ currentReading: number }>();
    const previousReading = row.previousReading ?? Number(prior?.currentReading ?? 0);
    const currentReading = row.currentReading ?? previousReading;

    await db.prepare(`INSERT OR IGNORE INTO monthly_records (month, department_id, meter_fee, kilo_price, rent, services, previous_reading, current_reading, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
      month, department.id, row.meterFee ?? 0, row.kiloPrice ?? 0, row.rent ?? 0, row.services ?? 0, previousReading, currentReading,
    ).run();
    const record = await db.prepare("SELECT id FROM monthly_records WHERE month=? AND department_id=?").bind(month, department.id).first<{ id: number }>();
    if (!record) { skipped += 1; continue; }

    await db.prepare(`UPDATE monthly_records SET
      meter_fee=COALESCE(?, meter_fee), kilo_price=COALESCE(?, kilo_price), rent=COALESCE(?, rent), services=COALESCE(?, services),
      previous_reading=COALESCE(?, previous_reading), current_reading=COALESCE(?, current_reading), locked=0 WHERE id=?`).bind(
      row.meterFee ?? null, row.kiloPrice ?? null, row.rent ?? null, row.services ?? null,
      row.previousReading ?? previousReading, row.currentReading ?? currentReading, record.id,
    ).run();
    await db.prepare("INSERT OR IGNORE INTO record_meta (record_id, confirmed, revision) VALUES (?, 0, 1)").bind(record.id).run();
    await db.prepare(`INSERT OR IGNORE INTO monthly_snapshots (record_id, meter_section, category, owner, phone, occupant, occupant_number, rent_start, rent_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      record.id, row.meterSection, row.category ?? department.category, row.owner ?? department.owner, row.phone ?? department.phone,
      row.occupant ?? department.occupant, row.occupantNumber ?? department.occupantNumber,
      row.rentStart ?? department.rentStart, row.rentEnd ?? department.rentEnd,
    ).run();
    await db.prepare(`UPDATE monthly_snapshots SET meter_section=?, category=?, owner=?, phone=?, occupant=?, occupant_number=?, rent_start=?, rent_end=? WHERE record_id=?`).bind(
      row.meterSection, row.category ?? department.category, row.owner ?? department.owner, row.phone ?? department.phone,
      row.occupant ?? department.occupant, row.occupantNumber ?? department.occupantNumber,
      row.rentStart ?? department.rentStart, row.rentEnd ?? department.rentEnd, record.id,
    ).run();
    await db.prepare("UPDATE record_meta SET confirmed=0, revision=revision+1 WHERE record_id=?").bind(record.id).run();
    updated += 1;
  }

  await db.prepare(`INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), new Date().toISOString(), actorId, actorName, "excelImport",
    `استيراد Excel لشهر ${month}: ${updated} سجل، ${created} قسم جديد، ${skipped} متجاهل`,
  ).run();
  return { updated, created, skipped };
}

export async function GET(request: Request) {
  try {
    await requireSession(request);
    await initDatabase();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return jsonNoStore({ results: [] });
    const like = `%${q.toLowerCase()}%`;
    const result = await getDb().prepare(`SELECT r.id, r.month, r.previous_reading AS previousReading, r.current_reading AS currentReading,
      r.meter_fee AS meterFee, r.kilo_price AS kiloPrice, r.rent, r.services,
      s.meter_section AS meterSection, s.occupant, s.occupant_number AS occupantNumber
      FROM monthly_records r JOIN monthly_snapshots s ON s.record_id=r.id
      WHERE lower(s.meter_section) LIKE ? OR lower(s.occupant) LIKE ? OR lower(s.occupant_number) LIKE ?
      ORDER BY r.month DESC LIMIT 100`).bind(like, like, like).all();
    return jsonNoStore({ results: result.results });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await requireSession(request);
    await initDatabase();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new JmrError("اختار ملف Excel", 400);
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw new JmrError("حجم ملف Excel لازم يكون أقل من 10MB", 413);
    if (!/\.(xlsx|xls|xlsm)$/i.test(file.name)) throw new JmrError("الملف لازم يكون Excel (.xlsx أو .xls)", 415);
    const month = monthValue(form.get("month"));
    const mode = String(form.get("mode") ?? "preview");
    const createMissing = String(form.get("createMissing") ?? "false") === "true";
    const updateMaster = String(form.get("updateMaster") ?? "false") === "true";
    const sheetName = String(form.get("sheetName") ?? "").trim() || undefined;
    const parsed = parseWorkbook(await file.arrayBuffer(), sheetName);
    if (parsed.rows.length === 0) throw new JmrError("ما لقينا بيانات قابلة للاستيراد بالملف", 400);

    if (mode === "preview") {
      const preview = await buildPreview(parsed.rows, month, createMissing, updateMaster);
      return jsonNoStore({ ok: true, sheets: parsed.sheets, rows: preview, warnings: parsed.warnings,
        summary: {
          total: preview.length,
          matched: preview.filter(item => item.status === "matched").length,
          willCreate: preview.filter(item => item.status === "will-create").length,
          unmatched: preview.filter(item => item.status === "unmatched").length,
          withMasterDifferences: preview.filter(item => Array.isArray(item.masterDifferences) && item.masterDifferences.length > 0).length,
        },
      });
    }
    if (mode !== "commit") throw new JmrError("وضع الاستيراد غير صالح", 400);
    const result = await commitRows(parsed.rows, month, createMissing, updateMaster, actor.name, actor.id);
    return jsonNoStore({ ok: true, ...result, warnings: parsed.warnings, message: `تم استيراد ${result.updated} سجل لشهر ${month}` });
  } catch (error) {
    return failure(error);
  }
}
