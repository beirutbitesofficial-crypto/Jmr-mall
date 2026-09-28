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
  Object.assign(process.env, { JMR_SESSION_SECRET: "test-secret-with-more-than-thirty-two-chars", JMR_ADMIN_USERNAME: "jmradmin", JMR_ADMIN_PASSWORD: "setup-password-123" });
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS jmr CASCADE; CREATE SCHEMA jmr; SET search_path=jmr");
  await admin.query(await readFile(new URL("./support/schema.sql", import.meta.url), "utf8"));

  const data = await import("../app/api/data/route.ts");
  const loginRoute = await import("../app/api/auth/login/route.ts");
  const sessionRoute = await import("../app/api/auth/session/route.ts");
  const logoutRoute = await import("../app/api/auth/logout/route.ts");
  const importer = await import("../app/api/import/route.ts");
  const { transaction, getDb } = await import("../lib/jmr-db.ts");
  const { nextMonth } = await import("../lib/jmr-core.ts");
  const origin = "https://mall.example";
  let cookie = "";
  const signIn = async (username, password) => {
    const response = await loginRoute.POST(new Request(`${origin}/api/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username, password }) }));
    return { status: response.status, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const post = (body, as = cookie) => data.POST(new Request(`${origin}/api/data`, {
    method: "POST", headers: { origin, "content-type": "application/json", cookie: as }, body: JSON.stringify(body),
  }));
  const ok = async (body, status = 200) => {
    const response = await post(body);
    const text = await response.text();
    assert.equal(response.status, status, `${body.action}: ${text}`);
    return JSON.parse(text);
  };
  const state = async () => (await data.GET(new Request(`${origin}/api/data`, { headers: { cookie } }))).json();
  const importFile = async (month, rows, extra = {}) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const form = new FormData();
    form.set("file", new File([XLSX.write(book, { type: "array", bookType: "xlsx" })], "month.xlsx"));
    form.set("month", month);
    form.set("mode", "commit");
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return importer.POST(new Request(`${origin}/api/import`, { method: "POST", headers: { origin, cookie }, body: form }));
  };
  const beirutMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

  try {
    // ---- Sign-in: nothing is readable without a session ----
    assert.equal((await data.GET(new Request(`${origin}/api/data`))).status, 401);
    assert.equal((await signIn("jmradmin", "wrong-password")).status, 401);
    // First setup: the Hostinger admin credentials only allow creating the owner account.
    const setup = await signIn("jmradmin", "setup-password-123");
    assert.equal(setup.status, 200);
    cookie = setup.cookie;
    assert.equal((await state()).bootstrap, true);
    await ok({ action: "addDepartment", department: { meterSection: "X", category: "c", owner: "", phone: "", occupant: "o", occupantNumber: "", rentStart: "", rentEnd: "", active: 1 } }, 403);
    await ok({ action: "saveUser", user: { username: "owner", name: "Jad", role: "owner", active: 1 }, password: "owner-password-1" });
    assert.equal((await data.GET(new Request(`${origin}/api/data`, { headers: { cookie } }))).status, 401, "setup session ends once the owner exists");
    assert.equal((await signIn("jmradmin", "setup-password-123")).status, 401, "setup credentials stop working");
    // The owner signs in with the new password and the session is found again on the next request.
    const ownerLogin = await signIn("owner", "owner-password-1");
    assert.equal(ownerLogin.status, 200);
    cookie = ownerLogin.cookie;
    const session = await (await sessionRoute.GET(new Request(`${origin}/api/auth/session`, { headers: { cookie } }))).json();
    assert.equal(session.actor.role, "owner");
    assert.equal(session.actor.name, "Jad");

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
    const search = async q => (await (await importer.GET(new Request(`${origin}/api/import?q=${encodeURIComponent(q)}`, { headers: { cookie } }))).json()).results;
    assert.equal((await search("%")).length, 0);
    assert.ok((await search("a-1")).length >= 2);

    // Behind Hostinger's proxy the request URL is internal; the Host header identifies the site.
    const proxied = new Request("http://127.0.0.1:3000/api/data", { method: "POST", headers: { origin, host: "mall.example", "content-type": "application/json", cookie }, body: JSON.stringify({ action: "none" }) });
    assert.notEqual((await data.POST(proxied)).status, 403);
    const crossSite = new Request("http://127.0.0.1:3000/api/data", { method: "POST", headers: { origin: "https://evil.example", host: "mall.example", "content-type": "application/json" }, body: "{}" });
    assert.equal((await data.POST(crossSite)).status, 403);

    // ---- Users and roles ----
    await ok({ action: "saveUser", user: { username: "accountant", name: "Rana", role: "accountant", active: 1 }, password: "accountant-pass-1" });
    await ok({ action: "saveUser", user: { username: "viewer", name: "Sami", role: "viewer", active: 1 }, password: "viewer-password-1" });
    await ok({ action: "saveUser", user: { username: "short", name: "S", role: "viewer", active: 1 }, password: "too-short" }, 400);
    await ok({ action: "saveUser", user: { username: "Owner", name: "Dup", role: "viewer", active: 1 }, password: "duplicate-pass-1" }, 409);
    const accountant = (await signIn("accountant", "accountant-pass-1")).cookie;
    const viewer = (await signIn("viewer", "viewer-password-1")).cookie;
    const statusOf = async (body, as) => (await post(body, as)).status;
    assert.equal(await statusOf({ action: "lockMonth", month: next, locked: 1 }, accountant), 403, "only the owner approves");
    assert.equal(await statusOf({ action: "saveUser", user: { username: "x-user", name: "X", role: "owner", active: 1 }, password: "whatever-pass-1" }, accountant), 403, "only the owner manages users");
    const viewerRecord = (await state()).records.find(record => record.month === next);
    assert.equal(await statusOf({ action: "updateRecord", id: viewerRecord.id, expectedRevision: viewerRecord.revision, record: { meterFee: 1, kiloPrice: 1, rent: 1, services: 1, previousReading: 0, currentReading: 1 } }, viewer), 403, "view-only cannot edit");
    const viewerData = await (await data.GET(new Request(`${origin}/api/data`, { headers: { cookie: viewer } }))).json();
    assert.equal(viewerData.users.length, 0, "only the owner sees the user list");
    // Disabling an account ends its sessions immediately.
    const accountantUser = (await state()).users.find(user => user.username === "accountant");
    await ok({ action: "saveUser", id: accountantUser.id, user: { username: "accountant", name: "Rana", role: "accountant", active: 0 } });
    assert.equal((await data.GET(new Request(`${origin}/api/data`, { headers: { cookie: accountant } }))).status, 401);
    assert.equal((await signIn("accountant", "accountant-pass-1")).status, 401);
    // The owner cannot lock themselves out.
    const ownerUser = (await state()).users.find(user => user.username === "owner");
    await ok({ action: "saveUser", id: ownerUser.id, user: { username: "owner", name: "Jad", role: "viewer", active: 1 } }, 400);
    // Signing out ends only this browser's session.
    const second = (await signIn("owner", "owner-password-1")).cookie;
    await logoutRoute.POST(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { origin, cookie } }));
    assert.equal((await data.GET(new Request(`${origin}/api/data`, { headers: { cookie } }))).status, 401);
    assert.equal((await data.GET(new Request(`${origin}/api/data`, { headers: { cookie: second } }))).status, 200);
    // Five wrong passwords lock the account for 15 minutes, even when sent at the same time.
    const guesses = await Promise.all(Array.from({ length: 8 }, () => signIn("viewer", "wrong-password-123")));
    assert.ok(guesses.filter(result => result.status === 429).length >= 3, `statuses ${guesses.map(result => result.status)}`);
    assert.equal((await signIn("viewer", "viewer-password-1")).status, 429);
  } finally {
    await admin.end();
    await (await import("../lib/jmr-db.ts")).closeDatabase();
  }
});
