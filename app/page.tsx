"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isRecordReady, recordCharges, roundedMoney,
  type Actor, type AuditEntry, type Department, type MonthStatus, type MonthlyRecord,
  type Payment, type PaymentKind, type PublicUser, type Role,
} from "@/lib/jmr-core";
import { dictionary, monthName, translateMessage, type Lang } from "@/lib/i18n";
import { usePrefs } from "@/lib/prefs";

type Page = "audit" | "departments" | "invoices" | "payments" | "users" | "history";
type AuthState = "checking" | "signedOut" | "signedIn";
type Toast = { message: string; tone: "success" | "error" } | null;
type DataPayload = {
  actor: Actor;
  bootstrap: boolean;
  departments: Department[];
  records: MonthlyRecord[];
  months: MonthStatus[];
  payments: Payment[];
  users: PublicUser[];
  audit: AuditEntry[];
};

type DepartmentDraft = Omit<Department, "id">;
type RecordDraft = Pick<MonthlyRecord, "meterFee" | "kiloPrice" | "rent" | "services" | "previousReading" | "currentReading">;
type UserDraft = { id?: string; username: string; name: string; role: Role; active: number; password: string };
type PaymentDraft = { recordId: number; kind: PaymentKind; amount: string; paidAt: string; note: string; requestId: string };

const pages: Page[] = ["audit", "departments", "invoices", "payments", "users", "history"];
const emptyDepartment: DepartmentDraft = {
  meterSection: "", category: "", owner: "", phone: "", occupant: "", occupantNumber: "",
  rentStart: "", rentEnd: "", active: 1,
};
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
// Printed invoices and receipts are the mall's Arabic forms, so their month label stays Arabic.
const monthLabel = (value: string) => monthName(value, "ar");
const currentMonth = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find(part => part.type === "year")?.value ?? "2026";
  const month = parts.find(part => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
};
const today = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

async function apiJson(response: Response, lang: Lang) {
  const t = dictionary[lang];
  const result = await response.json().catch(() => ({ error: t.errors.unreadable })) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(translateMessage(typeof result.error === "string" ? result.error : t.errors.generic, lang)), { status: response.status });
  return result;
}

export default function Home() {
  const { lang, theme, toggleLang, toggleTheme } = usePrefs();
  const t = dictionary[lang];
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("jmradmin");
  const [password, setPassword] = useState("");
  const [data, setData] = useState<DataPayload | null>(null);
  const [page, setPage] = useState<Page>("audit");
  const [month, setMonth] = useState(currentMonth);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [departmentEdit, setDepartmentEdit] = useState<{ id?: number; draft: DepartmentDraft } | null>(null);
  // Typed-but-unsaved values per record, kept as text so a cleared cell stays empty.
  const [rowDrafts, setRowDrafts] = useState<Record<number, Partial<Record<keyof RecordDraft, string>>>>({});
  const [paymentEdit, setPaymentEdit] = useState<PaymentDraft | null>(null);
  const [voidEdit, setVoidEdit] = useState<{ id: string; reason: string } | null>(null);
  const [userEdit, setUserEdit] = useState<UserDraft | null>(null);
  const [receipt, setReceipt] = useState<Payment | null>(null);
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "rent" | "electricity">("all");
  const timer = useRef<number | null>(null);
  const mutex = useRef(false);
  const initialMonthResolved = useRef(false);
  const langRef = useRef<Lang>(lang);
  useEffect(() => { langRef.current = lang; }, [lang]);

  const notify = useCallback((message: string, tone: "success" | "error" = "success") => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast({ message: translateMessage(message, langRef.current), tone });
    timer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/data", { cache: "no-store" });
    if (response.status === 401) {
      setAuthState("signedOut");
      setData(null);
      throw Object.assign(new Error(dictionary[langRef.current].errors.sessionEnded), { status: 401 });
    }
    const result = await apiJson(response, langRef.current) as unknown as DataPayload;
    setData(result);
    if (!initialMonthResolved.current && result.months.length > 0) {
      initialMonthResolved.current = true;
      setMonth(result.months[0].month);
    }
    setAuthState("signedIn");
    setStale(false);
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async response => {
        if (!active) return;
        if (!response.ok) { setAuthState("signedOut"); return; }
        await refresh();
      })
      .catch(() => { if (active) setAuthState("signedOut"); });
    return () => { active = false; if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [refresh]);

  const run = useCallback(async (work: () => Promise<void>) => {
    if (mutex.current) return;
    mutex.current = true;
    setBusy(true);
    try { await work(); }
    catch (error) { notify(error instanceof Error ? error.message : dictionary[langRef.current].errors.generic, "error"); }
    finally { mutex.current = false; setBusy(false); }
  }, [notify]);

  async function action(body: Record<string, unknown>) {
    if (stale) throw new Error(t.errors.refreshFirst);
    const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 401) { setAuthState("signedOut"); setData(null); }
    const result = await apiJson(response, lang);
    try { await refresh(); }
    catch (error) {
      if ((error as { status?: number }).status !== 401) setStale(true);
      throw new Error(t.errors.screenStale);
    }
    return result;
  }

  const selectedStatus = data?.months.find(item => item.month === month) ?? null;
  const currentRecords = useMemo(() => (data?.records ?? []).filter(record => record.month === month), [data, month]);
  const locked = Number(selectedStatus?.locked ?? 0) === 1;
  const complete = currentRecords.filter(isRecordReady);
  const invoicesReady = locked && currentRecords.length > 0 && complete.length === currentRecords.length;
  const visibleRecords = currentRecords.filter(record => `${record.meterSection} ${record.occupant} ${record.occupantNumber}`.toLowerCase().includes(search.toLowerCase()));
  const owner = data?.actor.role === "owner";
  const writer = data?.actor.role !== "viewer";
  const formOpen = Boolean(departmentEdit || paymentEdit || voidEdit || userEdit);
  const hasDrafts = Object.keys(rowDrafts).length > 0;
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDrafts]);
  const editableMonth = Boolean(writer && selectedStatus && !locked && data && !data.bootstrap && data.months[0]?.month === month);
  const disabled = busy || stale || formOpen;

  const totals = complete.reduce((sum, record) => {
    const charges = recordCharges(record);
    sum.rent += charges.rent;
    sum.electricity += charges.electricity;
    sum.total += charges.total;
    return sum;
  }, { rent: 0, electricity: 0, total: 0 });
  const paidTotal = (data?.payments ?? []).filter(payment => !payment.voidedAt && currentRecords.some(record => record.id === payment.recordId))
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const missingDepartments = (data?.departments ?? []).filter(department => department.active === 1 && !currentRecords.some(record => record.departmentId === department.id));
  const monthPayments = (data?.payments ?? []).filter(payment => currentRecords.some(record => record.id === payment.recordId));

  function paidFor(recordId: number, kind: PaymentKind) {
    return roundedMoney((data?.payments ?? []).filter(payment => payment.recordId === recordId && payment.kind === kind && !payment.voidedAt)
      .reduce((sum, payment) => sum + Number(payment.amount), 0));
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      await apiJson(response, lang);
      setPassword("");
      await refresh();
      notify(t.signIn.done);
    });
  }

  async function logout() {
    if (hasDrafts && !window.confirm(t.discardDrafts)) return;
    await run(async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      setRowDrafts({}); setData(null); setAuthState("signedOut"); setPage("audit");
    });
  }

  async function saveDepartment(event: React.FormEvent) {
    event.preventDefault();
    if (!departmentEdit) return;
    await run(async () => {
      const result = await action({ action: departmentEdit.id ? "updateDepartment" : "addDepartment", id: departmentEdit.id, department: departmentEdit.draft, month });
      setDepartmentEdit(null);
      notify(String(result.message ?? t.saved));
    });
  }

  function draftValues(record: MonthlyRecord): RecordDraft {
    const draft = rowDrafts[record.id] ?? {};
    const value = (field: keyof RecordDraft) => {
      const raw = draft[field];
      return raw === undefined ? Number(record[field]) : raw.trim() === "" ? Number.NaN : Number(raw);
    };
    return { meterFee: value("meterFee"), kiloPrice: value("kiloPrice"), rent: value("rent"), services: value("services"), previousReading: value("previousReading"), currentReading: value("currentReading") };
  }

  function editCell(record: MonthlyRecord, field: keyof RecordDraft, raw: string) {
    setRowDrafts(old => ({ ...old, [record.id]: { ...old[record.id], [field]: raw } }));
  }

  async function saveRecord(record: MonthlyRecord) {
    const recordEdit = { record, draft: draftValues(record) };
    if (!Object.values(recordEdit.draft).every(value => Number.isFinite(value) && value >= 0)) { notify(t.audit.fillAll(record.meterSection), "error"); return; }
    if (recordEdit.draft.currentReading < recordEdit.draft.previousReading) { notify(t.audit.readingBelow(record.meterSection), "error"); return; }
    await run(async () => {
      const result = await action({ action: "updateRecord", id: recordEdit.record.id, expectedRevision: recordEdit.record.revision, record: recordEdit.draft });
      setRowDrafts(old => { const next = { ...old }; delete next[record.id]; return next; });
      notify(String(result.message ?? t.saved));
    });
  }

  async function savePayment(event: React.FormEvent) {
    event.preventDefault();
    if (!paymentEdit) return;
    await run(async () => {
      const result = await action({ action: "addPayment", ...paymentEdit, amount: Number(paymentEdit.amount) });
      setPaymentEdit(null);
      notify(String(result.message ?? t.saved));
    });
  }

  async function saveUser(event: React.FormEvent) {
    event.preventDefault();
    if (!userEdit || !data) return;
    await run(async () => {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "saveUser", id: userEdit.id, user: { username: userEdit.username, name: userEdit.name, role: userEdit.role, active: userEdit.active }, password: userEdit.password,
      }) });
      const result = await apiJson(response, lang);
      setUserEdit(null);
      if (data.bootstrap) {
        setData(null); setAuthState("signedOut"); setUsername(userEdit.username); setPassword("");
        notify(t.users.ownerCreated);
      } else {
        await refresh(); notify(String(result.message ?? t.users.saved));
      }
    });
  }

  async function downloadExcel() {
    await run(async () => {
      const response = await fetch(`/api/export?month=${encodeURIComponent(month)}`, { cache: "no-store" });
      if (!response.ok) { await apiJson(response, lang); return; }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `By-JMR-Mall-${month}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(t.excelReady);
    });
  }

  function startDepartment(department: Department) {
    // Keep every master-data field populated when opening Edit, even when legacy/imported rows contain NULLs.
    setDepartmentEdit({ id: department.id, draft: {
      meterSection: String(department.meterSection ?? ""),
      category: String(department.category ?? ""),
      owner: String(department.owner ?? ""),
      phone: String(department.phone ?? ""),
      occupant: String(department.occupant ?? ""),
      occupantNumber: String(department.occupantNumber ?? ""),
      rentStart: String(department.rentStart ?? ""),
      rentEnd: String(department.rentEnd ?? ""),
      active: Number(department.active) === 1 ? 1 : 0,
    } });
  }

  function printReceipt(payment: Payment) {
    setReceipt(payment);
    // Leave receipt mode once printing ends; otherwise the next "print invoices" prints this receipt.
    window.addEventListener("afterprint", () => setReceipt(null), { once: true });
    window.setTimeout(() => window.print(), 80);
  }

  const prefsControls = <div className="prefs">
    <button type="button" className="icon-button" onClick={toggleTheme} aria-label={theme === "dark" ? t.theme.light : t.theme.dark} title={theme === "dark" ? t.theme.light : t.theme.dark}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
    <button type="button" className="lang-button" onClick={toggleLang} aria-label={t.languageLabel} lang={lang === "ar" ? "en" : "ar"}>{t.language}</button>
  </div>;

  if (authState === "checking") return <main className="auth-shell"><div className="auth-loading"><span className="brand-mark">J</span><p>{t.loading}</p></div></main>;

  if (authState === "signedOut") return (
    <main className="auth-shell">
      <section className="login-card">
        <div className="login-top"><div className="login-brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>{prefsControls}</div>
        <div className="login-copy"><h1>{t.signIn.title}</h1><p>{t.signIn.subtitle}</p></div>
        <form onSubmit={signIn}>
          <Field label={t.signIn.username} value={username} onChange={setUsername} required autoComplete="username" />
          <Field label={t.signIn.password} type="password" value={password} onChange={setPassword} required autoComplete="current-password" />
          <button className="primary login-button" disabled={busy}>{busy ? t.signIn.checking : t.signIn.submit}</button>
        </form>
        <p className="login-foot">{t.signIn.firstSetup}</p>
      </section>
      {toast && <ToastView toast={toast} />}
    </main>
  );

  if (!data) return null;
  const navPages = pages.filter(item => owner || (item !== "users" && item !== "history"));
  const formatDate = (value: string) => new Date(value).toLocaleString(lang === "ar" ? "ar-LB" : "en-GB");

  return (
    <main className={`app-shell page-${page} ${receipt ? "printing-receipt" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>
        <nav>{navPages.map(item => <button key={item} type="button" className={`nav-${item} ${page === item ? "active" : ""}`} aria-current={page === item ? "page" : undefined} disabled={formOpen || busy || hasDrafts} onClick={() => { setPage(item); setSearch(""); }}><Icon name={item} /><span className="nav-label">{t.nav[item]}</span></button>)}<a className="nav-import" href="/import"><Icon name="import" /><span className="nav-label">{t.nav.import}</span></a></nav>
        <div className="side-note"><span className="avatar" aria-hidden="true">{data.actor.name.trim().slice(0, 1).toUpperCase()}</span><div><strong>{data.actor.name}</strong><small>{t.roles[data.actor.role]}</small></div><button className="secondary" disabled={busy || formOpen} onClick={() => void logout()}>{t.signOut}</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">BY JMR MALL</p><h1>{t.nav[page]}</h1><p>{t.appTagline}</p></div>
          <div className="top-actions"><span className={`save-state ${stale ? "error-text" : ""}`}>{busy ? t.sync.busy : stale ? t.sync.stale : t.sync.ok}</span><button className="secondary" disabled={busy || formOpen} onClick={() => { if (hasDrafts && !window.confirm(t.discardDrafts)) return; setRowDrafts({}); void run(async () => { await refresh(); notify(t.refreshed); }); }}>{t.refresh}</button>{prefsControls}<button className="secondary mobile-signout" disabled={busy || formOpen} onClick={() => void logout()}>{t.signOut}</button></div>
        </header>

        {data.bootstrap && <div className="notice-banner"><span><strong>{t.bootstrap.title}</strong> {t.bootstrap.body}</span><button className="primary" disabled={busy || formOpen} onClick={() => { setPage("users"); setUserEdit({ username: "", name: "", role: "owner", active: 1, password: "" }); }}>{t.bootstrap.action}</button></div>}
        {stale && <div className="notice-banner error">{t.staleBanner}</div>}

        {(page === "audit" || page === "invoices" || page === "payments") && <div className="toolbar">
          <label className="month-picker">{t.month}<input type="month" value={month} min="2000-01" max="2099-12" disabled={busy || formOpen || hasDrafts} onChange={event => event.target.value && setMonth(event.target.value)} /></label>
          <div className="toolbar-actions"><span className={`status-pill ${locked ? "approved" : ""}`}>{selectedStatus ? locked ? t.status.approved : t.status.draft : t.status.notCreated}</span>{invoicesReady && <button className="secondary" disabled={disabled} onClick={() => void downloadExcel()}>{t.downloadExcel}</button>}</div>
        </div>}

        {(page === "audit" || page === "payments") && <div className="stats">
          <Stat label={t.stats.rent} value={totals.rent} />
          <Stat label={t.stats.electricity} value={totals.electricity} />
          <Stat label={t.stats.collected} value={paidTotal} />
          <Stat label={t.stats.remaining} value={roundedMoney(totals.total - paidTotal)} />
        </div>}

        {page === "audit" && <section className="panel">
          <div className="panel-head"><div><h2>{monthName(month, lang)}</h2><p>{t.audit.complete(complete.length, currentRecords.length)}</p></div><div className="toolbar-actions"><input className="search-input" aria-label={t.audit.search} placeholder={t.audit.search} value={search} onChange={event => setSearch(event.target.value)} />{owner && selectedStatus && <button className="primary" disabled={disabled || data.bootstrap || hasDrafts} title={hasDrafts ? t.audit.saveFirst : undefined} onClick={() => { if (locked && !window.confirm(t.audit.reopenConfirm(monthName(month, lang)))) return; void run(async () => { const result = await action({ action: "lockMonth", month, locked: locked ? 0 : 1 }); notify(String(result.message ?? t.saved)); }); }}>{locked ? t.audit.reopen : t.audit.approve}</button>}</div></div>
          {!selectedStatus ? <div className="empty"><h3>{t.audit.notCreatedTitle}</h3><p>{t.audit.notCreatedBody}</p>{writer && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => void run(async () => { const result = await action({ action: "createMonth", month }); notify(String(result.message ?? t.audit.created)); })}>{t.audit.create}</button>}</div> : <div className="table-wrap sheet-wrap"><table className="sheet"><thead><tr>
            <th className="pin pin-1">{t.audit.cols.section}</th><th className="pin pin-2">{t.audit.cols.occupant}</th><th className="pin pin-3">{t.audit.cols.occupantNumber}</th>
            <th>{t.audit.cols.meterFee}</th><th>{t.audit.cols.kiloPrice}</th><th>{t.audit.cols.rent}</th><th>{t.audit.cols.services}</th><th>{t.audit.cols.previousReading}</th><th>{t.audit.cols.currentReading}</th>
            <th>{t.audit.cols.usage}</th><th>{t.audit.cols.subscription}</th><th>{t.audit.cols.total}</th><th>{t.audit.cols.status}</th>
          </tr></thead><tbody>{visibleRecords.map(record => {
            const values = draftValues(record);
            const known = Object.values(values).every(Number.isFinite);
            const usage = values.currentReading - values.previousReading;
            const subscription = roundedMoney(usage * values.kiloPrice + values.meterFee);
            const total = roundedMoney(subscription + values.rent + values.services);
            const dirty = Boolean(rowDrafts[record.id]);
            const hasPrior = data.records.some(item => item.departmentId === record.departmentId && item.month < record.month);
            const cell = (field: keyof RecordDraft, step = "0.01") => {
              const editable = editableMonth && !(field === "previousReading" && hasPrior);
              if (!editable) return <td className="num">{field === "meterFee" || field === "kiloPrice" || field === "rent" || field === "services" ? currency.format(Number(record[field])) : Number(record[field])}</td>;
              return <td><input className="cell-input" type="number" inputMode="decimal" min="0" step={step} disabled={busy || stale} aria-label={`${t.audit.cols[field]} — ${record.meterSection}`} value={rowDrafts[record.id]?.[field] ?? String(record[field])} onChange={event => editCell(record, field, event.target.value)} /></td>;
            };
            return <tr key={record.id} className={`${dirty ? "row-dirty" : ""} ${known && usage < 0 ? "invalid" : ""}`}>
              <td className="pin pin-1"><strong>{record.meterSection}</strong><small>{record.category}</small></td>
              <td className="pin pin-2">{record.occupant}</td>
              <td className="pin pin-3 num">{record.occupantNumber || "—"}</td>
              {cell("meterFee")}{cell("kiloPrice", "0.0001")}{cell("rent")}{cell("services")}{cell("previousReading")}{cell("currentReading")}
              <td className={`num ${known && usage < 0 ? "danger" : "strong"}`}>{known ? usage : "—"}</td>
              <td className="num">{known ? currency.format(subscription) : "—"}</td>
              <td className="num total">{known ? currency.format(total) : "—"}</td>
              <td className="status-cell"><div className="status-stack">{editableMonth && (dirty || !isRecordReady(record)) && <button className={dirty ? "primary" : "secondary"} disabled={busy || stale} onClick={() => void saveRecord(record)}>{dirty ? t.audit.save : t.audit.confirm}</button>}<span className={`badge ${dirty ? "pending" : isRecordReady(record) ? "done" : "pending"}`}>{dirty ? t.audit.unsaved : isRecordReady(record) ? t.audit.complete1 : t.audit.needsReview}</span></div></td>
            </tr>;
          })}</tbody><tfoot><tr><td className="pin pin-1" colSpan={3}>{t.audit.monthlyTotal}</td><td colSpan={6}></td><td>—</td>
            <td className="num">{currency.format(visibleRecords.reduce((sum, record) => { const v = draftValues(record); const u = v.currentReading - v.previousReading; return sum + (Object.values(v).every(Number.isFinite) ? roundedMoney(u * v.kiloPrice + v.meterFee) : 0); }, 0))}</td>
            <td className="num total">{currency.format(visibleRecords.reduce((sum, record) => { const v = draftValues(record); const u = v.currentReading - v.previousReading; return sum + (Object.values(v).every(Number.isFinite) ? roundedMoney(u * v.kiloPrice + v.meterFee + v.rent + v.services) : 0); }, 0))}</td><td></td></tr></tfoot></table></div>}
          {selectedStatus && !locked && missingDepartments.length > 0 && <div className="panel-footer"><strong>{t.audit.missing}</strong>{missingDepartments.map(department => <button key={department.id} className="secondary" disabled={disabled || data.bootstrap} onClick={() => void run(async () => { const result = await action({ action: "addToMonth", month, departmentId: department.id }); notify(String(result.message ?? t.audit.added)); })}>{t.audit.add(department.meterSection)}</button>)}</div>}
        </section>}

        {page === "departments" && <section className="panel">
          <div className="panel-head"><div><h2>{t.departments.title}</h2><p>{t.departments.subtitle}</p></div>{writer && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => setDepartmentEdit({ draft: { ...emptyDepartment } })}>{t.departments.add}</button>}</div>
          <div className="table-wrap"><table><thead><tr><th>{t.departments.cols.section}</th><th>{t.departments.cols.category}</th><th>{t.departments.cols.owner}</th><th>{t.departments.cols.occupant}</th><th>{t.departments.cols.contract}</th><th>{t.departments.cols.status}</th><th>{t.departments.cols.action}</th></tr></thead><tbody>{data.departments.map(department => <tr key={department.id}><td><strong>{department.meterSection}</strong></td><td>{department.category}</td><td>{department.owner}<small>{department.phone}</small></td><td>{department.occupant}<small>{department.occupantNumber}</small></td><td>{department.rentStart || "—"}<small>{department.rentEnd || "—"}</small></td><td><span className={`badge ${department.active ? "done" : "muted"}`}>{department.active ? t.departments.active : t.departments.archived}</span></td><td>{writer && <button className="secondary" disabled={disabled || data.bootstrap} onClick={() => startDepartment(department)}>{t.departments.edit}</button>}</td></tr>)}</tbody></table></div>
        </section>}

        {page === "invoices" && <section className="invoice-page">
          <div className="invoice-controls"><div className="invoice-filter" role="group" aria-label={t.invoices.filter}>{(["all", "rent", "electricity"] as const).map(kind => <button key={kind} className={invoiceFilter === kind ? "active" : ""} aria-pressed={invoiceFilter === kind} onClick={() => setInvoiceFilter(kind)}>{t.invoices[kind]}</button>)}</div><button className="primary" disabled={!invoicesReady || busy || formOpen} onClick={() => window.print()}>{t.invoices.print}</button></div>
          {!invoicesReady ? <div className="empty"><h3>{t.invoices.lockedTitle}</h3><p>{t.invoices.lockedBody}</p></div> : <div className="invoice-grid" dir="rtl" lang="ar">{currentRecords.flatMap(record => {
            const cards = [];
            if (invoiceFilter === "all" || invoiceFilter === "rent") cards.push(<RentInvoice key={`rent-${record.id}`} month={month} record={record} paid={paidFor(record.id, "rent")} />);
            if (invoiceFilter === "all" || invoiceFilter === "electricity") cards.push(<ElectricityInvoice key={`electricity-${record.id}`} month={month} record={record} paid={paidFor(record.id, "electricity")} />);
            return cards;
          })}</div>}
        </section>}

        {page === "payments" && <><section className="panel"><div className="panel-head"><div><h2>{t.payments.title}</h2><p>{t.payments.subtitle}</p></div></div>{!invoicesReady ? <div className="empty">{t.payments.locked}</div> : <div className="table-wrap"><table><thead><tr><th>{t.payments.cols.section}</th><th>{t.payments.cols.invoice}</th><th>{t.payments.cols.due}</th><th>{t.payments.cols.paid}</th><th>{t.payments.cols.remaining}</th><th>{t.payments.cols.action}</th></tr></thead><tbody>{currentRecords.flatMap(record => (["rent", "electricity"] as const).map(kind => {
          const due = recordCharges(record)[kind]; const paid = paidFor(record.id, kind); const balance = roundedMoney(due - paid);
          return <tr key={`${record.id}-${kind}`}><td><strong>{record.meterSection}</strong><small>{record.occupant}</small></td><td>{kind === "rent" ? t.payments.rentKind : t.payments.electricityKind}</td><td className="num">{currency.format(due)}</td><td className="num">{currency.format(paid)}</td><td className="num strong">{currency.format(balance)}</td><td>{writer && balance > 0 && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => setPaymentEdit({ recordId: record.id, kind, amount: balance.toFixed(2), paidAt: today(), note: "", requestId: crypto.randomUUID() })}>{t.payments.record}</button>}</td></tr>;
        }))}</tbody></table></div>}</section><section className="panel spaced"><div className="panel-head"><h2>{t.payments.receipts(monthPayments.length)}</h2></div><div className="table-wrap"><table><thead><tr><th>{t.payments.receiptCols.id}</th><th>{t.payments.receiptCols.section}</th><th>{t.payments.receiptCols.amount}</th><th>{t.payments.receiptCols.by}</th><th>{t.payments.receiptCols.status}</th><th>{t.payments.receiptCols.action}</th></tr></thead><tbody>{monthPayments.map(payment => {
          const record = currentRecords.find(item => item.id === payment.recordId);
          return <tr key={payment.id}><td><small className="receipt-id">{payment.id}</small></td><td>{record?.meterSection}<small>{payment.kind === "rent" ? t.payments.rentKind : t.payments.electricityKind}</small></td><td className="num">{currency.format(payment.amount)}<small>{payment.paidAt}</small></td><td>{payment.receivedBy}</td><td><span className={`badge ${payment.voidedAt ? "void" : "done"}`}>{payment.voidedAt ? t.payments.voided : t.payments.active}</span><small>{payment.voidReason}</small></td><td><button className="secondary" onClick={() => printReceipt(payment)}>{t.payments.print}</button>{owner && !payment.voidedAt && <button className="danger-button" disabled={disabled} onClick={() => setVoidEdit({ id: payment.id, reason: "" })}>{t.payments.void}</button>}</td></tr>;
        })}</tbody></table></div></section></>}

        {page === "users" && owner && <section className="panel"><div className="panel-head"><div><h2>{t.users.title}</h2><p>{t.users.subtitle}</p></div><button className="primary" disabled={disabled} onClick={() => setUserEdit({ username: "", name: "", role: data.bootstrap ? "owner" : "accountant", active: 1, password: "" })}>{t.users.add}</button></div>
          <div className="role-guide">{(["owner", "accountant", "viewer"] as const).map(role => <div key={role}><span className={`badge role-${role}`}>{t.roles[role]}</span><p>{t.roleHelp[role]}</p></div>)}</div>
          <div className="table-wrap"><table><thead><tr><th>{t.users.cols.name}</th><th>{t.users.cols.username}</th><th>{t.users.cols.role}</th><th>{t.users.cols.status}</th><th>{t.users.cols.action}</th></tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td><strong>{user.name}</strong>{user.id === data.actor.id && <small>{t.users.you}</small>}</td><td className="mono-text">{user.username}</td><td><span className={`badge role-${user.role}`}>{t.roles[user.role]}</span></td><td><span className={`badge ${user.active ? "done" : "muted"}`}>{user.active ? t.users.active : t.users.disabled}</span></td><td><button className="secondary" disabled={disabled} onClick={() => setUserEdit({ ...user, password: "" })}>{t.users.edit}</button></td></tr>)}</tbody></table></div></section>}

        {page === "history" && owner && <section className="panel"><div className="panel-head"><div><h2>{t.history.title}</h2><p>{t.history.subtitle}</p></div></div><div className="table-wrap"><table><thead><tr><th>{t.history.cols.date}</th><th>{t.history.cols.user}</th><th>{t.history.cols.action}</th><th>{t.history.cols.detail}</th></tr></thead><tbody>{data.audit.map(entry => <tr key={entry.id}><td className="nowrap">{formatDate(entry.createdAt)}</td><td>{entry.actorName}</td><td><code>{entry.action}</code></td><td>{entry.detail}</td></tr>)}</tbody></table></div></section>}
      </section>

      {departmentEdit && <Modal title={departmentEdit.id ? t.departments.editTitle : t.departments.addTitle} busy={busy} closeLabel={t.close} onClose={() => setDepartmentEdit(null)}><form onSubmit={saveDepartment}><div className="form-grid">
        <Field label={t.departments.fields.meterSection} value={departmentEdit.draft.meterSection} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, meterSection: value } })} required />
        <Field label={t.departments.fields.category} value={departmentEdit.draft.category} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, category: value } })} required />
        <Field label={t.departments.fields.owner} value={departmentEdit.draft.owner} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, owner: value } })} />
        <Field label={t.departments.fields.phone} value={departmentEdit.draft.phone} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, phone: value } })} />
        <Field label={t.departments.fields.occupant} value={departmentEdit.draft.occupant} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, occupant: value } })} required />
        <Field label={t.departments.fields.occupantNumber} value={departmentEdit.draft.occupantNumber} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, occupantNumber: value } })} />
        <Field label={t.departments.fields.rentStart} type="date" value={departmentEdit.draft.rentStart} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, rentStart: value } })} />
        <Field label={t.departments.fields.rentEnd} type="date" value={departmentEdit.draft.rentEnd} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, rentEnd: value } })} />
      </div><label className="check-field"><input type="checkbox" checked={departmentEdit.draft.active === 1} onChange={event => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, active: event.target.checked ? 1 : 0 } })} />{t.departments.activeCheck}</label><SaveButton busy={busy} label={t.save} busyLabel={t.saving} /></form></Modal>}

      {paymentEdit && <Modal title={t.payments.newTitle} busy={busy} closeLabel={t.close} onClose={() => setPaymentEdit(null)}><form onSubmit={savePayment}><Field label={t.payments.amount} type="number" value={paymentEdit.amount} onChange={value => setPaymentEdit({ ...paymentEdit, amount: value })} required min="0.01" step="0.01" /><Field label={t.payments.paidAt} type="date" value={paymentEdit.paidAt} onChange={value => setPaymentEdit({ ...paymentEdit, paidAt: value })} required /><Field label={t.payments.note} value={paymentEdit.note} onChange={value => setPaymentEdit({ ...paymentEdit, note: value })} /><p>{t.payments.idempotent}</p><SaveButton busy={busy} label={t.save} busyLabel={t.saving} /></form></Modal>}

      {voidEdit && <Modal title={t.payments.voidTitle} busy={busy} closeLabel={t.close} onClose={() => setVoidEdit(null)}><form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await action({ action: "voidPayment", id: voidEdit.id, reason: voidEdit.reason }); setVoidEdit(null); notify(String(result.message ?? t.saved)); }); }}><p>{t.payments.voidBody}</p><Field label={t.payments.voidReason} value={voidEdit.reason} onChange={value => setVoidEdit({ ...voidEdit, reason: value })} required /><SaveButton busy={busy} label={t.save} busyLabel={t.saving} /></form></Modal>}

      {userEdit && <Modal title={userEdit.id ? t.users.editTitle : t.users.addTitle} busy={busy} closeLabel={t.close} onClose={() => setUserEdit(null)}><form onSubmit={saveUser}>
        <Field label={t.users.fields.name} value={userEdit.name} onChange={value => setUserEdit({ ...userEdit, name: value })} required autoComplete="off" />
        <Field label={t.users.fields.username} value={userEdit.username} onChange={value => setUserEdit({ ...userEdit, username: value.toLowerCase() })} required autoComplete="off" />
        <p className="field-hint">{t.users.usernameHint}</p>
        <Field label={userEdit.id ? t.users.fields.passwordKeep : t.users.fields.passwordNew} type="password" value={userEdit.password} onChange={value => setUserEdit({ ...userEdit, password: value })} required={!userEdit.id} autoComplete="new-password" />
        <label className="field"><span>{t.users.fields.role}</span><select value={userEdit.role} disabled={data.bootstrap || userEdit.id === data.actor.id} onChange={event => setUserEdit({ ...userEdit, role: event.target.value as Role })}><option value="owner">{t.roles.owner}</option><option value="accountant">{t.roles.accountant}</option><option value="viewer">{t.roles.viewer}</option></select></label>
        <p className="field-hint">{t.roleHelp[userEdit.role]}</p>
        <label className="check-field"><input type="checkbox" checked={userEdit.active === 1} disabled={data.bootstrap || userEdit.id === data.actor.id} onChange={event => setUserEdit({ ...userEdit, active: event.target.checked ? 1 : 0 })} />{t.users.fields.active}</label>
        <SaveButton busy={busy} label={t.save} busyLabel={t.saving} /></form></Modal>}

      {receipt && <div className="receipt-print" dir="rtl" lang="ar"><Receipt payment={receipt} record={data.records.find(record => record.id === receipt.recordId)!} /></div>}
      {toast && <ToastView toast={toast} />}
    </main>
  );
}

const iconPaths: Record<string, string> = {
  audit: "M4 5h16v14H4zM4 10h16M9 10v9",
  departments: "M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6",
  invoices: "M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21zM10 8h4M10 12h4",
  payments: "M3 7h18v10H3zM3 11h18M7 15h3",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6",
  history: "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6L3 9M3 4v5h5",
  import: "M12 3v12M7 10l5 5 5-5M4 21h16",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
};
function Icon({ name }: { name: string }) {
  return <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}
function Field({ label, value, onChange, type = "text", required = false, ...rest }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; min?: string; step?: string; autoComplete?: string }) {
  return <label className="field"><span>{label}</span><input type={type} value={value} onChange={event => onChange(event.target.value)} required={required} {...rest} /></label>;
}
function SaveButton({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) { return <button className="primary form-save" disabled={busy}>{busy ? busyLabel : label}</button>; }
function Stat({ label, value }: { label: string; value: number }) { return <div className="stat"><p>{label}</p><strong>{currency.format(value)}</strong></div>; }
function ToastView({ toast }: { toast: NonNullable<Toast> }) { return <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? "!" : "✓"} {toast.message}</div>; }
function Modal({ title, busy, closeLabel, onClose, children }: { title: string; busy: boolean; closeLabel: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="edit-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><h2>{title}</h2><button type="button" aria-label={closeLabel} disabled={busy} onClick={onClose}>×</button></header>{children}</dialog>;
}

function InvoiceHeader({ title, month }: { title: string; month: string }) {
  return <header className="invoice-card-head"><div><span>BY JMR MALL</span><strong>{title}</strong></div><time>{monthLabel(month)}</time></header>;
}
function InvoiceIdentity({ record }: { record: MonthlyRecord }) {
  return <div className="invoice-identity"><div><span>عداد / قسم</span><strong>{record.meterSection}</strong></div><div><span>اسم المستثمر</span><strong>{record.occupant}</strong></div><div><span>رقم المستثمر</span><strong>{record.occupantNumber || "—"}</strong></div></div>;
}
function RentInvoice({ month, record, paid }: { month: string; record: MonthlyRecord; paid: number }) {
  const total = record.rent + record.services;
  return <article className="invoice-card rent-invoice"><InvoiceHeader title="فاتورة الإيجار" month={month} /><InvoiceIdentity record={record} /><div className="invoice-values two-values"><div><span>قيمة الإيجار</span><strong>{currency.format(record.rent)}</strong></div><div><span>قيمة الخدمات</span><strong>{currency.format(record.services)}</strong></div></div><footer className="invoice-total"><span>المجموع</span><strong>{currency.format(total)}</strong></footer><p className="invoice-balance">المدفوع: <bdi>{currency.format(paid)}</bdi> · المتبقي: <strong><bdi>{currency.format(roundedMoney(total - paid))}</bdi></strong></p></article>;
}
function ElectricityInvoice({ month, record, paid }: { month: string; record: MonthlyRecord; paid: number }) {
  const usage = record.currentReading - record.previousReading;
  const subscription = usage * record.kiloPrice + record.meterFee;
  const difference = record.currentReading - record.previousReading;
  const total = subscription + record.services + record.rent;
  void difference; void total;
  return <article className="invoice-card electricity-invoice"><InvoiceHeader title="فاتورة الكهرباء" month={month} /><InvoiceIdentity record={record} /><div className="invoice-values electricity-values"><div><span>العداد السابق</span><strong>{record.previousReading}</strong></div><div><span>العداد الحالي</span><strong>{record.currentReading}</strong></div><div><span>صرف العداد</span><strong>{usage}</strong></div><div><span>سعر الكيلو</span><strong>{currency.format(record.kiloPrice)}</strong></div><div><span>رسم العداد</span><strong>{currency.format(record.meterFee)}</strong></div></div><footer className="invoice-total"><span>قيمة الاشتراك</span><strong>{currency.format(roundedMoney(subscription))}</strong></footer><p className="invoice-balance">المدفوع: <bdi>{currency.format(paid)}</bdi> · المتبقي: <strong><bdi>{currency.format(roundedMoney(subscription - paid))}</bdi></strong></p></article>;
}
function Receipt({ payment, record }: { payment: Payment; record: MonthlyRecord }) {
  return <article className="invoice-card receipt-card"><InvoiceHeader title="إيصال قبض" month={record.month} /><p className="receipt-id">رقم الإيصال: {payment.id}</p><InvoiceIdentity record={record} /><p>نوع الفاتورة: {payment.kind === "rent" ? "الإيجار والخدمات" : "الكهرباء"}</p><footer className="invoice-total"><span>المبلغ المقبوض</span><strong>{currency.format(payment.amount)}</strong></footer><p>التاريخ: {payment.paidAt} · المحصّل: {payment.receivedBy}</p>{payment.note && <p>{payment.note}</p>}{payment.voidedAt && <p className="error-text">إيصال معكوس — {payment.voidReason} — بواسطة {payment.voidedBy}</p>}</article>;
}
