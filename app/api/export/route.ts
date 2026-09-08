import { env } from "cloudflare:workers";
import * as XLSX from "xlsx";
import { requirePinSession } from "@/lib/pin-auth";

export const dynamic = "force-dynamic";

type DepartmentRow = {
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

type MonthlyRow = {
  departmentId: number;
  meterFee: number;
  kiloPrice: number;
  rent: number;
  services: number;
  previousReading: number;
  currentReading: number;
};

const pageOneHeaders = [
  "عداد / قسم", "نوعية القسم", "صاحب القسم", "رقم التلفون",
  "مستخدم القسم", "رقم المستخدم", "تاريخ بدء الإيجار", "تاريخ انتهاء الإيجار",
];

const pageTwoHeaders = [
  "عداد / قسم", "اسم المستثمر", "رقم المستثمر", "رسم العداد",
  "سعر الكيلو", "قيمة الإيجار", "قيمة الخدمات", "العداد السابق",
  "العداد الحالي", "صرف العداد", "قيمة الاشتراك", "المجموع",
];

function asDate(value: string) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function prepareSheet(sheet: XLSX.WorkSheet, widths: number[]) {
  sheet["!cols"] = widths.map(wch => ({ wch }));
  sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1:A1" };
  sheet["!rows"] = [{ hpt: 26 }];
}

export async function GET(request: Request) {
  const unauthorized = await requirePinSession(request);
  if (unauthorized) return unauthorized;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return Response.json({ error: "Invalid month" }, { status: 400 });
  }

  const [departmentsResult, recordsResult] = await Promise.all([
    env.DB.prepare("SELECT id, meter_section AS meterSection, category, owner, phone, occupant, occupant_number AS occupantNumber, rent_start AS rentStart, rent_end AS rentEnd, active FROM departments ORDER BY meter_section").all<DepartmentRow>(),
    env.DB.prepare("SELECT department_id AS departmentId, meter_fee AS meterFee, kilo_price AS kiloPrice, rent, services, previous_reading AS previousReading, current_reading AS currentReading FROM monthly_records WHERE month = ? ORDER BY department_id").bind(month).all<MonthlyRow>(),
  ]);

  const departments = departmentsResult.results;
  const records = new Map(recordsResult.results.map(record => [record.departmentId, record]));

  const pageOneRows = departments.map(department => [
    department.meterSection,
    department.category,
    department.owner,
    department.phone,
    department.occupant,
    department.occupantNumber,
    asDate(department.rentStart),
    asDate(department.rentEnd),
  ]);

  const activeDepartments = departments.filter(department => department.active);
  const pageTwoRows = activeDepartments.map(department => {
    const record = records.get(department.id);
    return [
      department.meterSection,
      department.occupant,
      department.occupantNumber,
      record?.meterFee ?? 0,
      record?.kiloPrice ?? 0,
      record?.rent ?? 0,
      record?.services ?? 0,
      record?.previousReading ?? 0,
      record?.currentReading ?? 0,
      0,
      0,
      0,
    ];
  });

  const pageOne = XLSX.utils.aoa_to_sheet([pageOneHeaders, ...pageOneRows], { cellDates: true });
  const pageTwo = XLSX.utils.aoa_to_sheet([pageTwoHeaders, ...pageTwoRows]);

  for (let row = 2; row <= pageTwoRows.length + 1; row += 1) {
    const usage = Number(pageTwo[`I${row}`]?.v ?? 0) - Number(pageTwo[`H${row}`]?.v ?? 0);
    const subscription = usage * Number(pageTwo[`E${row}`]?.v ?? 0) + Number(pageTwo[`D${row}`]?.v ?? 0);
    pageTwo[`J${row}`] = { t: "n", f: `I${row}-H${row}`, v: usage };
    pageTwo[`K${row}`] = { t: "n", f: `J${row}*E${row}+D${row}`, v: subscription };
    pageTwo[`L${row}`] = { t: "n", f: `K${row}+G${row}+F${row}`, v: subscription + Number(pageTwo[`G${row}`]?.v ?? 0) + Number(pageTwo[`F${row}`]?.v ?? 0) };
  }

  for (let row = 2; row <= pageOneRows.length + 1; row += 1) {
    if (pageOne[`G${row}`]) pageOne[`G${row}`].z = "yyyy-mm-dd";
    if (pageOne[`H${row}`]) pageOne[`H${row}`].z = "yyyy-mm-dd";
  }
  for (let row = 2; row <= pageTwoRows.length + 1; row += 1) {
    for (const column of ["D", "E", "F", "G", "K", "L"]) if (pageTwo[`${column}${row}`]) pageTwo[`${column}${row}`].z = '"$"#,##0.00';
    for (const column of ["H", "I", "J"]) if (pageTwo[`${column}${row}`]) pageTwo[`${column}${row}`].z = "#,##0.00";
  }

  prepareSheet(pageOne, [16, 18, 20, 17, 22, 18, 19, 19]);
  prepareSheet(pageTwo, [16, 22, 18, 15, 15, 16, 16, 17, 17, 16, 18, 18]);

  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(workbook, pageOne, "Page 1");
  XLSX.utils.book_append_sheet(workbook, pageTwo, `Page 2 ${month}`);
  workbook.CalcPr = { fullCalcOnLoad: "1", forceFullCalc: "1", calcMode: "auto" };

  const file = XLSX.write(workbook, { bookType: "xlsx", type: "array", cellDates: true });
  return new Response(file, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="By-JMR-Mall-${month}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
