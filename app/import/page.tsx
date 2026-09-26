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
    <main dir="rtl" className="import-shell">
      <div className="import-page">
        <header className="topbar">
          <div>
            <p className="eyebrow">BY JMR MALL</p>
            <h1>استيراد Excel والبحث بالتاريخ</h1>
            <p>ارفع ملفات العميل القديمة، راجع المطابقة، وبعدها ثبّت التغييرات بأمان.</p>
          </div>
          <Link href="/" className="secondary">← رجوع للنظام</Link>
        </header>

        {(message || error) && <div className={`notice-banner ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error || message}</div>}

        <section className="panel import-section">
          <h2><span className="step">1</span>رفع ملف الشهر</h2>
          <p className="import-hint">الاستيراد بيكون لآخر شهر مفتوح، أو للشهر اللي بعد آخر شهر معتمد.</p>
          <div className="import-grid">
            <label className="field"><span>ملف Excel</span>
              <input type="file" accept=".xlsx,.xls,.xlsm" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setSheetName(""); }} />
            </label>
            <label className="field"><span>الشهر</span>
              <input type="month" value={month} disabled={busy} onChange={event => { setMonth(event.target.value); setPreview(null); }} />
            </label>
            {preview && preview.sheets.length > 1 && <label className="field"><span>الشيت</span>
              <select value={sheetName} disabled={busy} onChange={event => { setSheetName(event.target.value); setPreview(null); }}>
                <option value="">كل الشيتات — مع إزالة التكرار</option>
                {preview.sheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>}
          </div>

          <div className="import-options">
            <label className="option">
              <input type="checkbox" checked={createMissing} disabled={busy} onChange={event => { setCreateMissing(event.target.checked); setPreview(null); }} />
              <span><strong>إنشاء الأقسام غير الموجودة</strong><small>اتركها مطفأة إذا بدك النظام يستورد فقط الأقسام الموجودة مسبقاً.</small></span>
            </label>
            <label className="option">
              <input type="checkbox" checked={updateMaster} disabled={busy} onChange={event => { setUpdateMaster(event.target.checked); setPreview(null); }} />
              <span><strong>تحديث المعلومات الثابتة من Excel</strong><small>مثل المستثمر، الهاتف والعقد. إذا مطفأة، يتم استيراد البيانات الشهرية فقط.</small></span>
            </label>
          </div>

          <div className="import-actions">
            <button type="button" className="primary" disabled={busy || !file || !month} onClick={() => void send("preview")}>{busy ? "جاري القراءة…" : "معاينة الملف"}</button>
            {preview && importable > 0 && <button type="button" className="primary confirm" disabled={busy} onClick={() => void send("commit")}>تأكيد الاستيراد ({importable})</button>}
          </div>
        </section>

        {preview && <section className="panel import-section">
          <h2><span className="step">2</span>مراجعة قبل الحفظ</h2>
          <div className="import-summary">
            {[['إجمالي السجلات', preview.summary.total], ['مطابق', preview.summary.matched], ['سينشأ', preview.summary.willCreate], ['غير مطابق', preview.summary.unmatched], ['اختلاف بيانات ثابتة', preview.summary.withMasterDifferences]].map(([label, value]) => <div key={String(label)} className="summary-card"><small>{label}</small><strong>{value}</strong></div>)}
          </div>

          {preview.warnings.length > 0 && <div className="notice-banner warning"><div><strong>تنبيهات القراءة:</strong>{preview.warnings.slice(0, 8).map((warning, index) => <div key={index}>• {warning}</div>)}</div></div>}

          <div className="table-wrap framed">
            <table>
              <thead><tr>{["القسم / العداد", "المصدر", "الحالة", "حقول الشهر", "اختلافات ثابتة"].map(head => <th key={head}>{head}</th>)}</tr></thead>
              <tbody>{preview.rows.map((row, index) => <tr key={`${row.sourceSheet}-${row.sourceRow}-${index}`}>
                <td><strong>{row.meterSection}</strong></td>
                <td>{row.sourceSheet} / {row.sourceRow}</td>
                <td><span className={`badge ${row.status === "matched" ? "done" : row.status === "will-create" ? "pending" : "void"}`}>{row.status === "matched" ? "مطابق" : row.status === "will-create" ? "سينشأ" : "غير مطابق"}</span></td>
                <td>{row.monthlyFields.join("، ") || "—"}</td>
                <td>{row.masterDifferences.join("، ") || "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}

        <section className="panel import-section">
          <h2><span className="step">3</span>بحث بالبيانات القديمة</h2>
          <p className="import-hint">ابحث برقم العداد، اسم المستثمر أو رقم المستثمر وشوف كل الأشهر المحفوظة.</p>
          <form onSubmit={searchHistory} className="import-search">
            <input className="search-input" aria-label="بحث بالبيانات القديمة" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} placeholder="مثلاً 18003175 أو اسم المستثمر" />
            <button className="primary" disabled={historyBusy}>{historyBusy ? "بحث…" : "بحث"}</button>
          </form>
          {historyRows.length > 0 && <div className="table-wrap framed"><table>
            <thead><tr>{["الشهر", "القسم", "المستثمر", "السابقة", "الحالية", "سعر الكيلو", "بدل العداد", "الإيجار", "الخدمات"].map(head => <th key={head}>{head}</th>)}</tr></thead>
            <tbody>{historyRows.map(row => <tr key={row.id}><td>{row.month}</td><td><strong>{row.meterSection}</strong></td><td>{row.occupant || "—"}</td><td>{row.previousReading}</td><td>{row.currentReading}</td><td>{row.kiloPrice}</td><td>{row.meterFee}</td><td>{row.rent}</td><td>{row.services}</td></tr>)}</tbody>
          </table></div>}
          {!historyBusy && historyQuery.trim() && historyRows.length === 0 && <p className="import-hint">ما في نتائج بعد. اضغط بحث أو جرّب رقم/اسم مختلف.</p>}
        </section>
      </div>
    </main>
  );
}
