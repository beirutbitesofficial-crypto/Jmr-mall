// End-to-end checks of the API routes against a real PostgreSQL database.
// Runs only when TEST_DATABASE_URL points at a disposable database: the jmr schema is dropped.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import pg from "pg";
import * as XLSX from "xlsx";

const url = process.env.TEST_DATABASE_URL;
register("./support/alias-loader.mjs", import.meta.url);

test("accounting rules hold on a real PostgreSQL database", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  process.env.DATABASE_URL = url;
  delete process.env.APP_ORIGIN;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS jmr CASCADE; CREATE SCHEMA jmr; SET search_path=jmr");
  await admin.query(await readFile(new URL("./support/schema.sql", import.meta.url), "utf8"));

  const data = await import("../app/api/data/route.ts");
  const importer = await import("../app/api/import/route.ts");
  const { transaction, getDb } = await import("../lib/jmr-db.ts");
  const { nextMonth } = await import("../lib/jmr-core.ts");
  const origin = "https://mall.example";
  const post = body => data.POST(new Request(`${origin}/api/data`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const ok = async (body, status = 200) => {
    const response = await post(body);
    const text = await response.text();
    assert.equal(response.status, status, `${body.action}: ${text}`);
    return JSON.parse(text);
  };
  const state = async () => (await data.GET(new Request(`${origin}/api/data`))).json();
  const importFile = async (month, rows, extra = {}) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const form = new FormData();
    form.set("file", new File([XLSX.write(book, { type: "array", bookType: "xlsx" })], "month.xlsx"));
    form.set("month", month);
    form.set("mode", "commit");
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return importer.POST(new Request(`${origin}/api/import`, { method: "POST", headers: { origin }, body: form }));
  };
  const beirutMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

  try {
    // A mistyped far-future first month would fix the whole sequence; it is refused.
    await ok({ action: "createMonth", month: "2099-01" }, 400);

    const department = { category: "محل", owner: "", phone: "", occupant: "مستأجر", occupantNumber: "", rentStart: "", rentEnd: "", active: 1 };
    await ok({ action: "addDepartment", department: { ...department, meterSection: "A-1" } });
    await ok({ action: "addDepartment", department: { ...department, meterSection: "B-2" } });
    const month = beirutMonth;
    await ok({ action: "createMonth", month });
    for (const record of (await state()).records) {
      await ok({ action: "updateRecord", id: record.id, expectedRevision: record.revision,
        record: { meterFee: 10, kiloPrice: 0.5, rent: 100, services: 20, previousReading: 0, currentReading: 100 } });
    }
    await ok({ action: "lockMonth", month, locked: 1 });

    // Two receipts saved at the same moment for the full balance: only one may go through.
    const recordA = (await state()).records.find(record => record.meterSection === "A-1");
    const payment = () => post({ action: "addPayment", recordId: recordA.id, kind: "rent", amount: 120, paidAt: new Date().toISOString().slice(0, 10), note: "", requestId: crypto.randomUUID() });
    const statuses = (await Promise.all([payment(), payment(), payment()])).map(response => response.status);
    assert.equal(statuses.filter(status => status === 200).length, 1, `statuses ${statuses}`);
    const paid = (await state()).payments.filter(item => item.recordId === recordA.id && !item.voidedAt).reduce((sum, item) => sum + Number(item.amount), 0);
    assert.equal(paid, 120);

    // Import may not change an approved month, skip a month, or open a second month.
    assert.equal((await importFile(month, [["رقم العداد", "العداد الحالي"], ["A-1", 150]])).status, 409);
    assert.equal((await importFile(nextMonth(nextMonth(month)), [["رقم العداد", "العداد الحالي"], ["A-1", 150]])).status, 409);

    // Importing the next month works like "إنشاء الشهر": every active department is included, a new
    // department without contract dates is created, and bad cells are dropped instead of saved.
    const next = nextMonth(month);
    const response = await importFile(next, [
      ["رقم العداد", "اسم المستثمر", "تاريخ بدء الايجار", "العداد الحالي", "الإيجار"],
      ["A-1", "مستأجر", "2026-02-31", 180, -5],
      ["C-3", "مستأجر جديد", "", 40, 300],
    ], { createMissing: "true" });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.warnings.some(warning => warning.includes("السالب")));
    const after = await state();
    const nextRecords = after.records.filter(record => record.month === next).map(record => record.meterSection).sort();
    assert.deepEqual(nextRecords, ["A-1", "B-2", "C-3"]);
    const importedA = after.records.find(record => record.month === next && record.meterSection === "A-1");
    assert.equal(importedA.previousReading, 100);
    assert.equal(importedA.currentReading, 180);
    assert.equal(importedA.rent, 0);
    assert.equal(importedA.rentStart, "");
    assert.equal(after.months.filter(item => Number(item.locked) === 0).length, 1);
    assert.equal((await importFile(nextMonth(next), [["رقم العداد", "العداد الحالي"], ["A-1", 200]])).status, 409);

    // A failure part-way through a transaction leaves nothing behind.
    await assert.rejects(transaction(async tx => {
      await tx.prepare("INSERT INTO audit_log (id, created_at, user_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
        .bind("rollback-probe", "now", "t", "t", "t", "t").run();
      throw new Error("stop");
    }), /stop/);
    assert.equal(await getDb().prepare("SELECT id FROM audit_log WHERE id='rollback-probe'").first(), null);

    // History search treats % and _ as text, not wildcards.
    const search = async q => (await (await importer.GET(new Request(`${origin}/api/import?q=${encodeURIComponent(q)}`))).json()).results;
    assert.equal((await search("%")).length, 0);
    assert.ok((await search("a-1")).length >= 2);

    // Behind Hostinger's proxy the request URL is internal; the Host header identifies the site.
    const proxied = new Request("http://127.0.0.1:3000/api/data", { method: "POST", headers: { origin, host: "mall.example", "content-type": "application/json" }, body: JSON.stringify({ action: "none" }) });
    assert.notEqual((await data.POST(proxied)).status, 403);
    const crossSite = new Request("http://127.0.0.1:3000/api/data", { method: "POST", headers: { origin: "https://evil.example", host: "mall.example", "content-type": "application/json" }, body: "{}" });
    assert.equal((await data.POST(crossSite)).status, 403);
  } finally {
    await admin.end();
    await (await import("../lib/jmr-db.ts")).closeDatabase();
  }
});
