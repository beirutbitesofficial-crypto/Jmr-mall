import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

const fileUrl = (path) => new URL(path, projectRoot);
const readSource = (path) => readFile(fileUrl(path), "utf8");

function extractStringArray(source, identifier) {
  const match = source.match(
    new RegExp(`const\\s+${identifier}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`),
  );
  assert.ok(match, `Expected ${identifier} to be declared as an array`);

  const body = match[1];
  const nonStringContent = body
    .replace(/"[^"]*"/g, "")
    .replace(/[\s,]/g, "");
  assert.equal(
    nonStringContent,
    "",
    `${identifier} should contain only literal column labels`,
  );

  return [...body.matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

function functionSection(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `Expected function ${functionName} to exist`);

  if (!nextFunctionName) return source.slice(start);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  assert.notEqual(end, -1, `Expected function ${nextFunctionName} to exist`);
  return source.slice(start, end);
}

test("Excel export keeps the exact Page 1 and Page 2 columns", async () => {
  const source = await readSource("app/api/export/route.ts");

  assert.deepEqual(extractStringArray(source, "pageOneHeaders"), [
    "عداد / قسم",
    "نوعية القسم",
    "صاحب القسم",
    "رقم التلفون",
    "مستخدم القسم",
    "رقم المستخدم",
    "تاريخ بدء الإيجار",
    "تاريخ انتهاء الإيجار",
  ]);

  assert.deepEqual(extractStringArray(source, "pageTwoHeaders"), [
    "عداد / قسم",
    "اسم المستثمر",
    "رقم المستثمر",
    "رسم العداد",
    "سعر الكيلو",
    "قيمة الإيجار",
    "قيمة الخدمات",
    "العداد السابق",
    "العداد الحالي",
    "صرف العداد",
    "قيمة الاشتراك",
    "المجموع",
  ]);

  assert.match(
    source,
    /book_append_sheet\(workbook,\s*pageOne,\s*"Page 1"\)/,
  );
  assert.match(
    source,
    /book_append_sheet\(workbook,\s*pageTwo,\s*`Page 2 \$\{month\}`\)/,
  );
});

test("Excel and on-screen totals use the agreed meter formulas", async () => {
  const [exportSource, pageSource] = await Promise.all([
    readSource("app/api/export/route.ts"),
    readSource("app/page.tsx"),
  ]);

  const spreadsheetFormulas = [
    ["J", "`I${row}-H${row}`"],
    ["K", "`J${row}*E${row}+D${row}`"],
    ["L", "`K${row}+G${row}+F${row}`"],
  ];

  for (const [column, formula] of spreadsheetFormulas) {
    const cell = `pageTwo[\`${column}\${row}\`]`;
    const start = exportSource.indexOf(cell);
    assert.notEqual(start, -1, `Expected a formula assignment for column ${column}`);
    const end = exportSource.indexOf(";", start);
    const assignment = exportSource.slice(start, end);
    assert.ok(
      assignment.includes(`f: ${formula}`),
      `Expected column ${column} to use ${formula}`,
    );
  }

  for (const expression of [
    "const usage = record.currentReading - record.previousReading;",
    "const difference = record.currentReading - record.previousReading;",
    "const subscription = usage * record.kiloPrice + record.meterFee;",
    "const subscription = difference * record.kiloPrice + record.meterFee;",
    "const total = subscription + record.services + record.rent;",
    "const total = record.rent + record.services;",
  ]) {
    assert.ok(pageSource.includes(expression), `Missing UI formula: ${expression}`);
  }
});

test("printed rent and electricity invoices retain their required labels", async () => {
  const source = await readSource("app/page.tsx");
  const identity = functionSection(source, "InvoiceIdentity", "RentInvoice");
  const rent = functionSection(source, "RentInvoice", "ElectricityInvoice");
  const electricity = functionSection(source, "ElectricityInvoice");

  for (const label of ["عداد / قسم", "اسم المستثمر", "رقم المستثمر"]) {
    assert.ok(identity.includes(`>${label}<`), `Missing invoice identity label: ${label}`);
  }

  assert.ok(rent.includes('InvoiceHeader title="فاتورة الإيجار"'));
  for (const label of ["قيمة الإيجار", "قيمة الخدمات", "المجموع"]) {
    assert.ok(rent.includes(`>${label}<`), `Missing rent invoice label: ${label}`);
  }

  assert.ok(electricity.includes('InvoiceHeader title="فاتورة الكهرباء"'));
  for (const label of [
    "العداد السابق",
    "العداد الحالي",
    "صرف العداد",
    "سعر الكيلو",
    "رسم العداد",
    "قيمة الاشتراك",
  ]) {
    assert.ok(
      electricity.includes(`>${label}<`),
      `Missing electricity invoice label: ${label}`,
    );
  }
});

test("adding a department syncs the selected month for invoices", async () => {
  const [pageSource, dataSource] = await Promise.all([
    readSource("app/page.tsx"),
    readSource("app/api/data/route.ts"),
  ]);

  const addDepartmentStart = pageSource.indexOf("const addDepartment");
  const toggleLockStart = pageSource.indexOf("const toggleLock", addDepartmentStart);
  assert.notEqual(addDepartmentStart, -1, "Expected addDepartment to exist");
  assert.notEqual(toggleLockStart, -1, "Expected toggleLock to follow addDepartment");
  const addDepartment = pageSource.slice(addDepartmentStart, toggleLockStart);
  assert.match(
    addDepartment,
    /api\(\{\s*action:\s*"addDepartment",\s*department:\s*draft,\s*month:\s*selectedMonth\s*\}\)/,
    "The department request must carry the month currently shown to the user",
  );

  const addActionStart = dataSource.indexOf('if (body.action === "addDepartment")');
  const createMonthStart = dataSource.indexOf(
    '} else if (body.action === "createMonth")',
    addActionStart,
  );
  assert.notEqual(addActionStart, -1, "Expected the addDepartment action to exist");
  assert.notEqual(createMonthStart, -1, "Expected the createMonth action to follow addDepartment");
  const addAction = dataSource.slice(addActionStart, createMonthStart);

  assert.match(addAction, /validMonth\(body\.month\)/);
  assert.match(
    addAction,
    /await\s+syncMonth\(body\.month\)/,
    "A newly inserted department must immediately receive its selected-month record",
  );
});

test("month sync inserts only missing records and inherits the locked state", async () => {
  const source = await readSource("app/api/data/route.ts");
  const syncMonth = functionSection(source, "syncMonth", "GET");

  assert.match(
    syncMonth,
    /INSERT OR IGNORE INTO monthly_records\s*\(\s*month,\s*department_id,\s*previous_reading,\s*current_reading,\s*locked\s*\)/,
    "Month creation must be idempotent and include the locked column",
  );
  assert.match(
    syncMonth,
    /COALESCE\(\(\s*SELECT\s+MIN\(locked\)\s+FROM\s+monthly_records\s+WHERE\s+month\s*=\s*\?\s*\),\s*0\s*\)/i,
    "Missing records must inherit the existing month lock state",
  );
  assert.match(
    syncMonth,
    /\.bind\(\s*month,\s*id,\s*id,\s*month,\s*month\s*\)/,
    "The selected month must bind both the reading lookup and lock-state lookup",
  );

  const createMonthStart = source.indexOf('} else if (body.action === "createMonth")');
  const updateRecordStart = source.indexOf(
    '} else if (body.action === "updateRecord")',
    createMonthStart,
  );
  assert.notEqual(createMonthStart, -1, "Expected the createMonth action to exist");
  assert.notEqual(updateRecordStart, -1, "Expected updateRecord to follow createMonth");
  const createMonth = source.slice(createMonthStart, updateRecordStart);
  assert.match(createMonth, /await\s+syncMonth\(body\.month\)/);
});

test("PIN authentication exposes login, session, and logout routes", async () => {
  const [loginRoute, sessionRoute, logoutRoute, pinAuth] = await Promise.all([
    readSource("app/api/auth/login/route.ts"),
    readSource("app/api/auth/session/route.ts"),
    readSource("app/api/auth/logout/route.ts"),
    readSource("lib/pin-auth.ts"),
  ]);

  assert.match(loginRoute, /export\s+(?:async\s+)?function\s+POST\b/);
  assert.match(sessionRoute, /export\s+(?:async\s+)?function\s+GET\b/);
  assert.match(logoutRoute, /export\s+(?:async\s+)?function\s+POST\b/);

  const authSource = `${loginRoute}\n${sessionRoute}\n${logoutRoute}\n${pinAuth}`;
  assert.match(authSource, /\bJMR_APP_PIN\b/);
  assert.match(authSource, /\bJMR_SESSION_SECRET\b/);
});
