export type Role = "owner" | "accountant" | "viewer";

export type Actor = {
  id: string;
  name: string;
  role: Role;
  sessionVersion: number;
};

export type Department = {
  id: number;
  meterSection: string;
  category: string;
  owner: string;
  phone: string;
  occupant: string;
  occupantNumber: string;
  rentStart: string;
  rentEnd: string;
  active: number;
};

export type MonthlyRecord = {
  id: number;
  month: string;
  departmentId: number;
  meterFee: number;
  kiloPrice: number;
  rent: number;
  services: number;
  previousReading: number;
  currentReading: number;
  confirmed: number;
  revision: number;
  meterSection: string;
  category: string;
  owner: string;
  phone: string;
  occupant: string;
  occupantNumber: string;
  rentStart: string;
  rentEnd: string;
};

export type MonthStatus = {
  month: string;
  locked: number;
  approvedAt: string | null;
  approvedBy: string | null;
};

export type PaymentKind = "rent" | "electricity";

export type Payment = {
  id: string;
  recordId: number;
  kind: PaymentKind;
  amount: number;
  paidAt: string;
  note: string;
  receivedBy: string;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  requestId: string;
};

export type PublicUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  active: number;
  sessionVersion: number;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  actorName: string;
  action: string;
  detail: string;
};

export class JmrError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export function assertJmr(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new JmrError(message, status);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanText(value: unknown, maximum = 180, required = false): string {
  assertJmr(typeof value === "string", "تحقق من الحقول النصية");
  const cleaned = value.trim();
  assertJmr(cleaned.length <= maximum && (!required || cleaned.length > 0), "تحقق من الحقول المطلوبة وطول النص");
  return cleaned;
}

export function validMonth(value: unknown): value is string {
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

export function requireMonth(value: unknown): string {
  assertJmr(validMonth(value), "الشهر غير صالح");
  return value;
}

export function validDate(value: string): boolean {
  if (!/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function optionalDate(value: unknown): string {
  const cleaned = cleanText(value, 10);
  assertJmr(cleaned === "" || validDate(cleaned), "التاريخ غير صالح");
  return cleaned;
}

export function positiveId(value: unknown): number {
  assertJmr(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "المعرّف غير صالح");
  return value;
}

export function nonNegativeNumber(value: unknown, maximum = 100_000_000): number {
  assertJmr(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum, "القيمة الرقمية غير صالحة");
  return value;
}

export function roundedMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function recordCharges(record: Pick<MonthlyRecord, "meterFee" | "kiloPrice" | "rent" | "services" | "previousReading" | "currentReading">) {
  const usage = record.currentReading - record.previousReading;
  const electricity = roundedMoney(usage * record.kiloPrice + record.meterFee);
  const rent = roundedMoney(record.rent + record.services);
  return { usage, electricity, rent, total: roundedMoney(electricity + rent) };
}

export function isRecordReady(record: Pick<MonthlyRecord, "confirmed" | "previousReading" | "currentReading">): boolean {
  return record.confirmed === 1 && record.currentReading >= record.previousReading;
}

export function nextMonth(value: string): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function roleLabel(role: Role): string {
  return role === "owner" ? "المالك" : role === "accountant" ? "المحاسب" : "عرض فقط";
}
