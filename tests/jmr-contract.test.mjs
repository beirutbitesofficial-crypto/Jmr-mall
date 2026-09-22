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
