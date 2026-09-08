import * as XLSX from "xlsx";
import { failure, requireSession } from "@/lib/auth";
import { assertJmr, recordCharges, roundedMoney, validMonth, type MonthlyRecord, type Payment } from "@/lib/jmr-core";
import { getDb, initDatabase } from "@/lib/jmr-db";

export const dynamic = "force-dynamic";

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
  try {
    await requireSession(request);
    await initDatabase();
    const month = new URL(request.url).searchParams.get("month") ?? "";
    assertJmr(validMonth(month), "الشهر غير صالح");
    const db = getDb();
    const monthStatus = await db.prepare("SELECT locked FROM month_status WHERE month=?").bind(month).first<{ locked: number }>();
    assertJmr(monthStatus && Number(monthStatus.locked) === 1, "اعتمد الشهر قبل تنزيل Excel", 409);

    const records = (await db.prepare(`SELECT r.id, r.month, r.department_id AS departmentId,
      r.meter_fee AS meterFee, r.kilo_price AS kiloPrice, r.rent, r.services,
      r.previous_reading AS previousReading, r.current_reading AS currentReading,
      m.confirmed, m.revision, s.meter_section AS meterSection, s.category, s.owner,
      s.phone, s.occupant, s.occupant_number AS occupantNumber, s.rent_start AS rentStart,
      s.rent_end AS rentEnd FROM monthly_records r
      JOIN record_meta m ON m.record_id=r.id JOIN monthly_snapshots s ON s.record_id=r.id
      WHERE r.month=? ORDER BY s.meter_section`).bind(month).all<MonthlyRecord>()).results;
    assertJmr(records.length > 0 && records.every(record => record.confirmed === 1 && record.currentReading >= record.previousReading),
      "في سجلات غير مكتملة. راجع الشهر قبل التصدير", 409);

    const payments = (await db.prepare(`SELECT id, record_id AS recordId, kind, amount, paid_at AS paidAt, note,
      received_by AS receivedBy, created_at AS createdAt, voided_at AS voidedAt, voided_by AS voidedBy,
      void_reason AS voidReason, request_id AS requestId FROM payments
      WHERE record_id IN (SELECT id FROM monthly_records WHERE month=?) ORDER BY created_at`).bind(month).all<Payment>()).results;

    const pageOneRows = records.map(record => [
      record.meterSection, record.category, record.owner, record.phone,
      record.occupant, record.occupantNumber, asDate(record.rentStart), asDate(record.rentEnd),
    ]);
    const pageTwoRows = records.map(record => [
      record.meterSection, record.occupant, record.occupantNumber,
      record.meterFee, record.kiloPrice, record.rent, record.services,
      record.previousReading, record.currentReading, 0, 0, 0,
    ]);

    const pageOne = XLSX.utils.aoa_to_sheet([pageOneHeaders, ...pageOneRows], { cellDates: true });
    const pageTwo = XLSX.utils.aoa_to_sheet([pageTwoHeaders, ...pageTwoRows]);

    for (let row = 2; row <= pageTwoRows.length + 1; row += 1) {
      const usage = Number(pageTwo[`I${row}`]?.v ?? 0) - Number(pageTwo[`H${row}`]?.v ?? 0);
      const subscription = usage * Number(pageTwo[`E${row}`]?.v ?? 0) + Number(pageTwo[`D${row}`]?.v ?? 0);
      pageTwo[`J${row}`] = { t: "n", f: `I${row}-H${row}`, v: usage };
      pageTwo[`K${row}`] = { t: "n", f: `J${row}*E${row}+D${row}`, v: roundedMoney(subscription) };
      pageTwo[`L${row}`] = { t: "n", f: `K${row}+G${row}+F${row}`, v: roundedMoney(subscription + Number(pageTwo[`G${row}`]?.v ?? 0) + Number(pageTwo[`F${row}`]?.v ?? 0)) };
    }

    for (let row = 2; row <= pageOneRows.length + 1; row += 1) {
      if (pageOne[`G${row}`]) pageOne[`G${row}`].z = "yyyy-mm-dd";
      if (pageOne[`H${row}`]) pageOne[`H${row}`].z = "yyyy-mm-dd";
    }
    for (let row = 2; row <= pageTwoRows.length + 1; row += 1) {
      for (const column of ["D", "E", "F", "G", "K", "L"]) if (pageTwo[`${column}${row}`]) pageTwo[`${column}${row}`].z = '"$"#,##0.00';
      for (const column of ["H", "I", "J"]) if (pageTwo[`${column}${row}`]) pageTwo[`${column}${row}`].z = "#,##0.00";
    }

    const balanceRows = records.flatMap(record => {
      const charges = recordCharges(record);
      return (["rent", "electricity"] as const).map(kind => {
        const paid = roundedMoney(payments.filter(payment => payment.recordId === record.id && payment.kind === kind && !payment.voidedAt)
          .reduce((sum, payment) => sum + Number(payment.amount), 0));
        const due = charges[kind];
        return [record.meterSection, record.occupant, kind === "rent" ? "الإيجار والخدمات" : "الكهرباء", due, paid, roundedMoney(due - paid)];
      });
    });
    const balances = XLSX.utils.aoa_to_sheet([["القسم", "المستثمر", "نوع الفاتورة", "المستحق", "المدفوع", "المتبقي"], ...balanceRows]);
    const receiptRows = payments.map(payment => {
      const record = records.find(item => item.id === payment.recordId)!;
      return [payment.id, record.meterSection, payment.kind === "rent" ? "الإيجار والخدمات" : "الكهرباء", payment.amount,
        payment.paidAt, payment.receivedBy, payment.voidedAt ? "معكوس" : "فعّال", payment.voidReason ?? ""];
    });
    const receipts = XLSX.utils.aoa_to_sheet([["رقم الإيصال", "القسم", "نوع الفاتورة", "المبلغ", "التاريخ", "المحصّل", "الحالة", "سبب العكس"], ...receiptRows]);

    prepareSheet(pageOne, [16, 18, 20, 17, 22, 18, 19, 19]);
    prepareSheet(pageTwo, [16, 22, 18, 15, 15, 16, 16, 17, 17, 16, 18, 18]);
    prepareSheet(balances, [16, 22, 20, 16, 16, 16]);
    prepareSheet(receipts, [40, 16, 20, 16, 15, 20, 12, 32]);

    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(workbook, pageOne, "Page 1");
    XLSX.utils.book_append_sheet(workbook, pageTwo, `Page 2 ${month}`);
    XLSX.utils.book_append_sheet(workbook, balances, "الأرصدة");
    XLSX.utils.book_append_sheet(workbook, receipts, "الإيصالات");
    workbook.CalcPr = { fullCalcOnLoad: "1", forceFullCalc: "1", calcMode: "auto" };

    const file = XLSX.write(workbook, { bookType: "xlsx", type: "array", cellDates: true });
    return new Response(file, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="By-JMR-Mall-${month}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
