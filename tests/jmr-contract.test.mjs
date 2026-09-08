import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

function extractStringArray(source, identifier) {
  const match = source.match(new RegExp(`const\\s+${identifier}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`));
  assert.ok(match, `Expected ${identifier}`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map(entry => entry[1]);
}

test("Hostinger build uses Next.js and PostgreSQL", async () => {
  const [pkg, db, env] = await Promise.all([read("package.json"), read("lib/jmr-db.ts"), read(".env.example")]);
  assert.match(pkg, /"build": "next build"/);
  assert.match(pkg, /"pg": "8\.16\.3"/);
  assert.match(db, /from "pg"/);
  assert.match(db, /DATABASE_URL/);
  assert.match(db, /SET search_path TO jmr, public/);
  assert.match(env, /DATABASE_URL=/);
});

test("Excel keeps the agreed Page 1 / Page 2 contract and adds collection sheets", async () => {
  const source = await read("app/api/export/route.ts");
  assert.deepEqual(extractStringArray(source, "pageOneHeaders"), [
    "عداد / قسم", "نوعية القسم", "صاحب القسم", "رقم التلفون",
    "مستخدم القسم", "رقم المستخدم", "تاريخ بدء الإيجار", "تاريخ انتهاء الإيجار",
  ]);
  assert.deepEqual(extractStringArray(source, "pageTwoHeaders"), [
    "عداد / قسم", "اسم المستثمر", "رقم المستثمر", "رسم العداد",
    "سعر الكيلو", "قيمة الإيجار", "قيمة الخدمات", "العداد السابق",
    "العداد الحالي", "صرف العداد", "قيمة الاشتراك", "المجموع",
  ]);
  for (const formula of ["`I${row}-H${row}`", "`J${row}*E${row}+D${row}`", "`K${row}+G${row}+F${row}`"]) {
    assert.ok(source.includes(`f: ${formula}`), `Missing spreadsheet formula ${formula}`);
  }
  assert.match(source, /book_append_sheet\(workbook,\s*balances,\s*"الأرصدة"\)/);
  assert.match(source, /book_append_sheet\(workbook,\s*receipts,\s*"الإيصالات"\)/);
});

test("historical tenant data is snapshotted and exports read the snapshot", async () => {
  const [db, api, exportRoute] = await Promise.all([read("lib/jmr-db.ts"), read("app/api/data/route.ts"), read("app/api/export/route.ts")]);
  assert.match(db, /CREATE TABLE IF NOT EXISTS monthly_snapshots/);
  assert.match(db, /INSERT OR IGNORE INTO monthly_snapshots/);
  assert.match(api, /JOIN monthly_snapshots s ON s\.record_id = r\.id/);
  assert.match(exportRoute, /JOIN monthly_snapshots s ON s\.record_id=r\.id/);
  assert.match(api, /الفواتير السابقة بقيت بنسختها المحفوظة/);
});

test("months are sequential and prior history is immutable", async () => {
  const source = await read("app/api/data/route.ts");
  assert.match(source, /اعتمد الشهر المفتوح قبل إنشاء شهر جديد/);
  assert.match(source, /month === nextMonth\(latest\.month\)/);
  assert.match(source, /التعديل متاح لآخر شهر مفتوح فقط\. الأشهر السابقة أرشيف ثابت\./);
  assert.match(source, /يمكن تغيير حالة آخر شهر فقط/);
});

test("approval requires every row to be confirmed and readings non-negative", async () => {
  const source = await read("app/api/data/route.ts");
  assert.match(source, /m\.confirmed<>1 OR r\.current_reading<r\.previous_reading/);
  assert.match(source, /أكمل واحفظ كل القراءات قبل اعتماد الشهر/);
  assert.match(source, /currentReading >= previousReading/);
  assert.match(source, /SET confirmed=1, write_token=NULL/);
});

test("record writes use a revision and write token to reject stale browser edits", async () => {
  const [db, source] = await Promise.all([read("lib/jmr-db.ts"), read("app/api/data/route.ts")]);
  assert.match(db, /revision INTEGER NOT NULL DEFAULT 1[\s\S]*write_token TEXT/);
  assert.match(source, /expectedRevision/);
  assert.match(source, /WHERE record_id=\? AND revision=\?/);
  assert.match(source, /write_token=\?/);
  assert.match(source, /السجل تغيّر بجلسة تانية/);
});

test("payments are idempotent and database-side balance checks prevent overpayment", async () => {
  const [db, source] = await Promise.all([read("lib/jmr-db.ts"), read("app/api/data/route.ts")]);
  assert.match(db, /request_id TEXT NOT NULL UNIQUE/);
  assert.match(source, /priorRequest/);
  assert.match(source, /INSERT OR IGNORE INTO payments/);
  assert.match(source, /WHERE \? <= \? - COALESCE\(\(SELECT SUM\(amount\)/);
  assert.match(source, /الرصيد تغيّر بجلسة تانية/);
  assert.match(source, /void_reason/);
});

test("authentication uses server-side sessions, roles, password hashing and bootstrap credentials", async () => {
  const [auth, login, session, data] = await Promise.all([
    read("lib/auth.ts"), read("app/api/auth/login/route.ts"), read("app/api/auth/session/route.ts"), read("app/api/data/route.ts"),
  ]);
  assert.match(auth, /PBKDF2/);
  assert.match(auth, /120_000/);
  assert.match(auth, /JMR_SESSION_SECRET/);
  assert.match(auth, /JMR_ADMIN_PASSWORD/);
  assert.match(auth, /INSERT INTO sessions/);
  assert.match(auth, /SameSite=Strict/);
  assert.match(login, /username/);
  assert.match(login, /password/);
  assert.match(session, /actor/);
  assert.match(data, /role !== "viewer"/);
  assert.match(data, /role === "owner"/);
});

test("UI never exposes final invoices or collection before approval", async () => {
  const source = await read("app/page.tsx");
  assert.match(source, /const invoicesReady = locked && currentRecords\.length > 0 && complete\.length === currentRecords\.length/);
  assert.match(source, /الفواتير النهائية بعد الاعتماد فقط/);
  assert.match(source, /التحصيل بيفتح بعد اعتماد الشهر/);
  assert.match(source, /expectedRevision: recordEdit\.record\.revision/);
  assert.ok(!source.includes("onBlur={() => void saveRecord"), "Cell blur must not silently save local edits");
});

test("invoice labels remain compatible with printed forms", async () => {
  const source = await read("app/page.tsx");
  for (const label of ["عداد / قسم", "اسم المستثمر", "رقم المستثمر", "قيمة الإيجار", "قيمة الخدمات", "المجموع", "العداد السابق", "العداد الحالي", "صرف العداد", "سعر الكيلو", "رسم العداد", "قيمة الاشتراك"]) {
    assert.ok(source.includes(`>${label}<`), `Missing invoice label: ${label}`);
  }
});

test("production headers and health endpoint exist", async () => {
  const [config, health] = await Promise.all([read("next.config.ts"), read("app/api/health/route.ts")]);
  assert.match(config, /X-Frame-Options/);
  assert.match(config, /X-Content-Type-Options/);
  assert.match(config, /Strict-Transport-Security/);
  assert.match(health, /SELECT 1 AS ok/);
});
