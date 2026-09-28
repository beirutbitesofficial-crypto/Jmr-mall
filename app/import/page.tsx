"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { dictionary, translateMessage, type Lang } from "@/lib/i18n";
import { usePrefs } from "@/lib/prefs";

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

async function parseJson(response: Response, lang: Lang) {
  const t = dictionary[lang];
  const result = await response.json().catch(() => ({ error: t.errors.unreadable })) as Record<string, unknown>;
  if (!response.ok) throw new Error(translateMessage(typeof result.error === "string" ? result.error : t.errors.generic, lang));
  return result;
}

export default function ImportPage() {
  const { lang, theme, toggleLang, toggleTheme } = usePrefs();
  const t = dictionary[lang];
  const ti = t.importPage;
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
    if (!file) { setError(ti.chooseFile); return; }
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
      const result = await parseJson(response, lang);
      if (mode === "preview") {
        setPreview(result as unknown as PreviewResponse);
        setMessage(ti.previewed);
      } else {
        setMessage(translateMessage(String(result.message ?? ti.imported), lang));
        setPreview(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.generic);
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
      const result = await parseJson(response, lang) as { results?: HistoryRow[] };
      setHistoryRows(result.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errors.generic);
    } finally {
      setHistoryBusy(false);
    }
  }

  return (
    <main className="import-shell">
      <div className="import-page">
        <header className="topbar">
          <div>
            <p className="eyebrow">BY JMR MALL</p>
            <h1>{ti.title}</h1>
            <p>{ti.subtitle}</p>
          </div>
          <div className="top-actions"><div className="prefs"><button type="button" className="icon-button" onClick={toggleTheme} aria-label={theme === "dark" ? t.theme.light : t.theme.dark} title={theme === "dark" ? t.theme.light : t.theme.dark}>{theme === "dark" ? "☀" : "☾"}</button><button type="button" className="lang-button" onClick={toggleLang} aria-label={t.languageLabel}>{t.language}</button></div><Link href="/" className="secondary">{ti.back}</Link></div>
        </header>

        {(message || error) && <div className={`notice-banner ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error || message}</div>}

        <section className="panel import-section">
          <h2><span className="step">1</span>{ti.step1}</h2>
          <p className="import-hint">{ti.rule}</p>
          <div className="import-grid">
            <label className="field"><span>{ti.file}</span>
              <input type="file" accept=".xlsx,.xls,.xlsm" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setSheetName(""); }} />
            </label>
            <label className="field"><span>{ti.month}</span>
              <input type="month" value={month} disabled={busy} onChange={event => { setMonth(event.target.value); setPreview(null); }} />
            </label>
            {preview && preview.sheets.length > 1 && <label className="field"><span>{ti.sheet}</span>
              <select value={sheetName} disabled={busy} onChange={event => { setSheetName(event.target.value); setPreview(null); }}>
                <option value="">{ti.allSheets}</option>
                {preview.sheets.map(sheet => <option key={sheet} value={sheet}>{sheet}</option>)}
              </select>
            </label>}
          </div>

          <div className="import-options">
            <label className="option">
              <input type="checkbox" checked={createMissing} disabled={busy} onChange={event => { setCreateMissing(event.target.checked); setPreview(null); }} />
              <span><strong>{ti.createMissing}</strong><small>{ti.createMissingHint}</small></span>
            </label>
            <label className="option">
              <input type="checkbox" checked={updateMaster} disabled={busy} onChange={event => { setUpdateMaster(event.target.checked); setPreview(null); }} />
              <span><strong>{ti.updateMaster}</strong><small>{ti.updateMasterHint}</small></span>
            </label>
          </div>

          <div className="import-actions">
            <button type="button" className="primary" disabled={busy || !file || !month} onClick={() => void send("preview")}>{busy ? ti.reading : ti.preview}</button>
            {preview && importable > 0 && <button type="button" className="primary confirm" disabled={busy} onClick={() => void send("commit")}>{ti.commit(importable)}</button>}
          </div>
        </section>

        {preview && <section className="panel import-section">
          <h2><span className="step">2</span>{ti.step2}</h2>
          <div className="import-summary">
            {[[ti.summary.total, preview.summary.total], [ti.summary.matched, preview.summary.matched], [ti.summary.willCreate, preview.summary.willCreate], [ti.summary.unmatched, preview.summary.unmatched], [ti.summary.differences, preview.summary.withMasterDifferences]].map(([label, value]) => <div key={String(label)} className="summary-card"><small>{label}</small><strong>{value}</strong></div>)}
          </div>

          {preview.warnings.length > 0 && <div className="notice-banner warning"><div><strong>{ti.warnings}</strong>{preview.warnings.slice(0, 8).map((warning, index) => <div key={index}>• {translateMessage(warning, lang)}</div>)}</div></div>}

          <div className="table-wrap framed">
            <table>
              <thead><tr>{[ti.cols.section, ti.cols.source, ti.cols.status, ti.cols.monthly, ti.cols.differences].map(head => <th key={head}>{head}</th>)}</tr></thead>
              <tbody>{preview.rows.map((row, index) => <tr key={`${row.sourceSheet}-${row.sourceRow}-${index}`}>
                <td><strong>{row.meterSection}</strong></td>
                <td>{row.sourceSheet} / {row.sourceRow}</td>
                <td><span className={`badge ${row.status === "matched" ? "done" : row.status === "will-create" ? "pending" : "void"}`}>{row.status === "matched" ? ti.matched : row.status === "will-create" ? ti.willCreate : ti.unmatched}</span></td>
                <td>{row.monthlyFields.map(field => translateMessage(field, lang)).join(lang === "ar" ? "، " : ", ") || "—"}</td>
                <td>{row.masterDifferences.map(field => translateMessage(field, lang)).join(lang === "ar" ? "، " : ", ") || "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}

        <section className="panel import-section">
          <h2><span className="step">3</span>{ti.step3}</h2>
          <p className="import-hint">{ti.searchHint}</p>
          <form onSubmit={searchHistory} className="import-search">
            <input className="search-input" aria-label={ti.step3} value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} placeholder={ti.searchPlaceholder} />
            <button className="primary" disabled={historyBusy}>{historyBusy ? ti.searching : ti.search}</button>
          </form>
          {historyRows.length > 0 && <div className="table-wrap framed"><table>
            <thead><tr>{ti.historyCols.map(head => <th key={head}>{head}</th>)}</tr></thead>
            <tbody>{historyRows.map(row => <tr key={row.id}><td>{row.month}</td><td><strong>{row.meterSection}</strong></td><td>{row.occupant || "—"}</td><td>{row.previousReading}</td><td>{row.currentReading}</td><td>{row.kiloPrice}</td><td>{row.meterFee}</td><td>{row.rent}</td><td>{row.services}</td></tr>)}</tbody>
          </table></div>}
          {!historyBusy && historyQuery.trim() && historyRows.length === 0 && <p className="import-hint">{ti.noResults}</p>}
        </section>
      </div>
    </main>
  );
}
