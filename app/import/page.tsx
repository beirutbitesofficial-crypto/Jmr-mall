"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type PreviewRow = {
  meterSection: string;
  sourceSheet: string;
  sourceRow: number;
  status: "matched" | "will-create" | "unmatched";
  masterDifferences: string[];
  masterChanges: string[];
  monthlyFields: string[];
};

type PreviewResponse = {
  ok: boolean;
  sheets: string[];
  rows: PreviewRow[];
  warnings: string[];
  summary: { total: number; matched: number; willCreate: number; unmatched: number; withMasterDifferences: number };
  error?: string;
};

type HistoryRow = {
  id: number;
  month: string;
  meterSection: string;
  occupant: string;
  occupantNumber: string;
  previousReading: number;
  currentReading: number;
  meterFee: number;
  kiloPrice: number;
  rent: number;
  services: number;
};

const currentMonth = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
};

async function parseJson(response: Response) {
  const result = await response.json().catch(() => ({ error: "تعذّر قراءة رد السيرفر" })) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "تعذّر تنفيذ الطلب");
  return result;
}

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [month, setMonth] = useState(currentMonth);
  const [sheetName, setSheetName] = useState("");
  const [createMissing, setCreateMissing] = useState(false);
  const [updateMaster, setUpdateMaster] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  const importable = useMemo(() => (preview?.summary.matched ?? 0) + (preview?.summary.willCreate ?? 0), [preview]);

  async function send(mode: "preview" | "commit") {
    if (!file) { setError("اختار ملف Excel أولاً"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("month", month);
      form.set("mode", mode);
      form.set("createMissing", String(createMissing));
      form.set("updateMaster", String(updateMaster));
      if (sheetName) form.set("sheetName", sheetName);
      const response = await fetch("/api/import", { method: "POST", body: form });
      const result = await parseJson(response);
      if (mode === "preview") {
        setPreview(result as unknown as PreviewResponse);
        setMessage("تمت قراءة الملف. راجع النتائج قبل التثبيت.");
      } else {
        setMessage(String(result.message ?? "تم الاستيراد"));
        setPreview(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تنفيذ الطلب");
    } finally {
      setBusy(false);
    }
  }

  async function searchHistory(event: React.FormEvent) {
    event.preventDefault();
    const q = historyQuery.trim();
    if (!q) { setHistoryRows([]); return; }
    setHistoryBusy(true); setError("");
    try {
      const response = await fetch(`/api/import?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const result = await parseJson(response) as { results?: HistoryRow[] };
      setHistoryRows(result.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر البحث");
    } finally {
      setHistoryBusy(false);
    }
  }

  return (
    <main dir="rtl" style={{ minHeight: "100vh", background: "#f4f7fb", color: "#172b47", padding: "24px" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gap: 18 }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: 0, fontWeight: 800, letterSpacing: 1, color: "#64748b" }}>BY JMR MALL</p>
            <h1 style={{ margin: "4px 0 6px", fontSize: 32 }}>استيراد Excel والبحث بالتاريخ</h1>
            <p style={{ margin: 0, color: "#64748b" }}>ارفع ملفات العميل القديمة، راجع المطابقة، وبعدها ثبّت التغييرات بأمان.</p>
          </div>
          <Link href="/" style={{ textDecoration: "none", border: "1px solid #cbd5e1", background: "white", color: "#172b47", padding: "10px 14px", borderRadius: 10, fontWeight: 800 }}>← رجوع للنظام</Link>
        </header>

        {(message || error) && <div style={{ padding: "14px 16px", borderRadius: 12, background: error ? "#fff0ee" : "#ecfdf3", border: `1px solid ${error ? "#f1b7b0" : "#a7e4bd"}`, color: error ? "#9f281f" : "#176441", fontWeight: 800 }}>{error || message}</div>}

        <section style={{ background: "white", border: "1px solid #dbe3ee", borderRadius: 16, padding: 20, boxShadow: "0 8px 28px #0f27470d" }}>
          <h2 style={{ marginTop: 0 }}>1) رفع ملف الشهر</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
            <label style={{ display: "grid", gap: 7, fontWeight: 800 }}>ملف Excel
              <input type="file" accept=".xlsx,.xls,.xlsm" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setSheetName(""); }} style={{ minHeight: 44 }} />
            </label>
            <label style={{ display: "grid", gap: 7, fontWeight: 800 }}>الشهر
              <input type="month" value={month} disabled={busy} onChange={event => { setMonth(event.target.value); setPreview(null); }} style={{ minHeight: 44, border: "1px solid #c8d2e0", borderRadius: 9, padding: "8px 10px" }} />
            </label>
            {preview && preview.sheets.length > 1 && <label style={{ display: "grid", gap: 7, fontWeight: 800 }}>الشيت
              <select value={sheetName} disabled={busy} onChange={event => { setSheetName(event.target.value); setPreview(null); }} style={{ minHeight: 44, border: "1px solid #c8d2e0", borderRadius: 9, padding: "8px 10px", background: "white" }}>
                <option value="">كل الشيتات — مع إزالة التكرار</option>
                {preview.sheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>}
          </div>

          <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
              <input type="checkbox" checked={createMissing} disabled={busy} onChange={event => { setCreateMissing(event.target.checked); setPreview(null); }} />
              <span><strong>إنشاء الأقسام غير الموجودة</strong><br /><small style={{ color: "#64748b" }}>اتركها مطفأة إذا بدك النظام يستورد فقط الأقسام الموجودة مسبقاً.</small></span>
            </label>
            <label style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
              <input type="checkbox" checked={updateMaster} disabled={busy} onChange={event => { setUpdateMaster(event.target.checked); setPreview(null); }} />
              <span><strong>تحديث المعلومات الثابتة من Excel</strong><br /><small style={{ color: "#64748b" }}>مثل المستثمر، الهاتف والعقد. إذا مطفأة، يتم استيراد البيانات الشهرية فقط.</small></span>
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
            <button type="button" disabled={busy || !file || !month} onClick={() => void send("preview")} style={{ border: 0, borderRadius: 10, padding: "11px 18px", background: "#173a6d", color: "white", fontWeight: 900, cursor: "pointer" }}>{busy ? "جاري القراءة…" : "معاينة الملف"}</button>
            {preview && importable > 0 && <button type="button" disabled={busy} onClick={() => void send("commit")} style={{ border: 0, borderRadius: 10, padding: "11px 18px", background: "#176441", color: "white", fontWeight: 900, cursor: "pointer" }}>تأكيد الاستيراد ({importable})</button>}
          </div>
        </section>

        {preview && <section style={{ background: "white", border: "1px solid #dbe3ee", borderRadius: 16, padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>2) مراجعة قبل الحفظ</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginBottom: 18 }}>
            {[['إجمالي السجلات', preview.summary.total], ['مطابق', preview.summary.matched], ['سينشأ', preview.summary.willCreate], ['غير مطابق', preview.summary.unmatched], ['اختلاف بيانات ثابتة', preview.summary.withMasterDifferences]].map(([label, value]) => <div key={String(label)} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}><small style={{ color: "#64748b" }}>{label}</small><strong style={{ display: "block", fontSize: 25, marginTop: 4 }}>{value}</strong></div>)}
          </div>

          {preview.warnings.length > 0 && <div style={{ background: "#fff8e7", border: "1px solid #ead8a5", borderRadius: 12, padding: 14, marginBottom: 16 }}><strong>تنبيهات القراءة:</strong>{preview.warnings.slice(0, 8).map((warning, index) => <div key={index} style={{ marginTop: 6 }}>• {warning}</div>)}</div>}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead><tr>{["القسم / العداد", "المصدر", "الحالة", "حقول الشهر", "اختلافات ثابتة"].map(head => <th key={head} style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #dbe3ee", background: "#f8fafc" }}>{head}</th>)}</tr></thead>
              <tbody>{preview.rows.map((row, index) => <tr key={`${row.sourceSheet}-${row.sourceRow}-${index}`}>
                <td style={{ padding: 10, borderBottom: "1px solid #edf1f5", fontWeight: 800 }}>{row.meterSection}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.sourceSheet} / {row.sourceRow}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.status === "matched" ? "✓ مطابق" : row.status === "will-create" ? "+ سينشأ" : "⚠ غير مطابق"}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.monthlyFields.join("، ") || "—"}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.masterDifferences.join("، ") || "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}

        <section style={{ background: "white", border: "1px solid #dbe3ee", borderRadius: 16, padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>3) بحث بالبيانات القديمة</h2>
          <p style={{ color: "#64748b" }}>ابحث برقم العداد، اسم المستثمر أو رقم المستثمر وشوف كل الأشهر المحفوظة.</p>
          <form onSubmit={searchHistory} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} placeholder="مثلاً 18003175 أو اسم المستثمر" style={{ flex: "1 1 280px", minHeight: 44, border: "1px solid #c8d2e0", borderRadius: 9, padding: "9px 12px" }} />
            <button disabled={historyBusy} style={{ border: 0, borderRadius: 10, padding: "10px 18px", background: "#173a6d", color: "white", fontWeight: 900 }}>{historyBusy ? "بحث…" : "بحث"}</button>
          </form>
          {historyRows.length > 0 && <div style={{ overflowX: "auto", marginTop: 16 }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead><tr>{["الشهر", "القسم", "المستثمر", "السابقة", "الحالية", "سعر الكيلو", "بدل العداد", "الإيجار", "الخدمات"].map(head => <th key={head} style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #dbe3ee", background: "#f8fafc" }}>{head}</th>)}</tr></thead>
            <tbody>{historyRows.map(row => <tr key={row.id}><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.month}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5", fontWeight: 800 }}>{row.meterSection}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.occupant || "—"}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.previousReading}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.currentReading}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.kiloPrice}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.meterFee}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.rent}</td><td style={{ padding: 10, borderBottom: "1px solid #edf1f5" }}>{row.services}</td></tr>)}</tbody>
          </table></div>}
          {!historyBusy && historyQuery.trim() && historyRows.length === 0 && <p style={{ marginTop: 14, color: "#64748b" }}>ما في نتائج بعد. اضغط بحث أو جرّب رقم/اسم مختلف.</p>}
        </section>
      </div>
    </main>
  );
}
