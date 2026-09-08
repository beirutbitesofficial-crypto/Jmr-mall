"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isRecordReady, recordCharges, roleLabel, roundedMoney,
  type Actor, type AuditEntry, type Department, type MonthStatus, type MonthlyRecord,
  type Payment, type PaymentKind, type PublicUser, type Role,
} from "@/lib/jmr-core";

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

const emptyDepartment: DepartmentDraft = {
  meterSection: "", category: "", owner: "", phone: "", occupant: "", occupantNumber: "",
  rentStart: "", rentEnd: "", active: 1,
};
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const monthLabel = (value: string) => new Intl.DateTimeFormat("ar-LB", { month: "long", year: "numeric" }).format(new Date(`${value}-01T12:00:00Z`));
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
const pageNames: Record<Page, string> = {
  audit: "التدقيق الشهري", departments: "الأقسام والمستأجرون", invoices: "الفواتير والطباعة",
  payments: "التحصيل والإيصالات", users: "المستخدمون والصلاحيات", history: "سجل التعديلات",
};

async function apiJson(response: Response) {
  const result = await response.json().catch(() => ({ error: "تعذّر قراءة رد الخادم" })) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof result.error === "string" ? result.error : "تعذّر إتمام الطلب"), { status: response.status });
  return result;
}

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [data, setData] = useState<DataPayload | null>(null);
  const [page, setPage] = useState<Page>("audit");
  const [month, setMonth] = useState(currentMonth);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [departmentEdit, setDepartmentEdit] = useState<{ id?: number; draft: DepartmentDraft } | null>(null);
  const [recordEdit, setRecordEdit] = useState<{ record: MonthlyRecord; draft: RecordDraft } | null>(null);
  const [paymentEdit, setPaymentEdit] = useState<PaymentDraft | null>(null);
  const [voidEdit, setVoidEdit] = useState<{ id: string; reason: string } | null>(null);
  const [userEdit, setUserEdit] = useState<UserDraft | null>(null);
  const [receipt, setReceipt] = useState<Payment | null>(null);
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "rent" | "electricity">("all");
  const timer = useRef<number | null>(null);
  const mutex = useRef(false);

  const notify = useCallback((message: string, tone: "success" | "error" = "success") => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/data", { cache: "no-store" });
    if (response.status === 401) {
      setAuthState("signedOut");
      setData(null);
      throw Object.assign(new Error("انتهت الجلسة. سجّل الدخول من جديد"), { status: 401 });
    }
    const result = await apiJson(response) as unknown as DataPayload;
    setData(result);
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
    catch (error) { notify(error instanceof Error ? error.message : "تعذّر إتمام الطلب", "error"); }
    finally { mutex.current = false; setBusy(false); }
  }, [notify]);

  async function action(body: Record<string, unknown>) {
    if (stale) throw new Error("حدّث البيانات أولاً قبل أي تعديل جديد");
    const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 401) { setAuthState("signedOut"); setData(null); }
    const result = await apiJson(response);
    try { await refresh(); }
    catch (error) {
      if ((error as { status?: number }).status !== 401) setStale(true);
      throw new Error("الطلب وصل للسيرفر، بس تعذّر تحديث الشاشة. اضغط تحديث قبل أي تعديل جديد.");
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
  const formOpen = Boolean(departmentEdit || recordEdit || paymentEdit || voidEdit || userEdit);
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
      await apiJson(response);
      setPassword("");
      await refresh();
      notify("تم تسجيل الدخول");
    });
  }

  async function logout() {
    await run(async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      setData(null); setAuthState("signedOut"); setPage("audit");
    });
  }

  async function saveDepartment(event: React.FormEvent) {
    event.preventDefault();
    if (!departmentEdit) return;
    await run(async () => {
      const result = await action({ action: departmentEdit.id ? "updateDepartment" : "addDepartment", id: departmentEdit.id, department: departmentEdit.draft, month });
      setDepartmentEdit(null);
      notify(String(result.message ?? "تم الحفظ"));
    });
  }

  async function saveRecord(event: React.FormEvent) {
    event.preventDefault();
    if (!recordEdit) return;
    await run(async () => {
      const result = await action({ action: "updateRecord", id: recordEdit.record.id, expectedRevision: recordEdit.record.revision, record: recordEdit.draft });
      setRecordEdit(null);
      notify(String(result.message ?? "تم الحفظ"));
    });
  }

  async function savePayment(event: React.FormEvent) {
    event.preventDefault();
    if (!paymentEdit) return;
    await run(async () => {
      const result = await action({ action: "addPayment", ...paymentEdit, amount: Number(paymentEdit.amount) });
      setPaymentEdit(null);
      notify(String(result.message ?? "تم تسجيل الدفعة"));
    });
  }

  async function saveUser(event: React.FormEvent) {
    event.preventDefault();
    if (!userEdit || !data) return;
    await run(async () => {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "saveUser", id: userEdit.id, user: { username: userEdit.username, name: userEdit.name, role: userEdit.role, active: userEdit.active }, password: userEdit.password,
      }) });
      const result = await apiJson(response);
      setUserEdit(null);
      if (data.bootstrap) {
        setData(null); setAuthState("signedOut");
        notify("تم إنشاء حساب المالك. سجّل الدخول بالحساب الجديد.");
      } else {
        await refresh(); notify(String(result.message ?? "تم حفظ المستخدم"));
      }
    });
  }

  async function downloadExcel() {
    await run(async () => {
      const response = await fetch(`/api/export?month=${encodeURIComponent(month)}`, { cache: "no-store" });
      if (!response.ok) { await apiJson(response); return; }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `By-JMR-Mall-${month}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("تم تجهيز ملف Excel");
    });
  }

  function startRecord(record: MonthlyRecord) {
    setRecordEdit({ record, draft: {
      meterFee: record.meterFee, kiloPrice: record.kiloPrice, rent: record.rent, services: record.services,
      previousReading: record.previousReading, currentReading: record.currentReading,
    } });
  }

  function printReceipt(payment: Payment) {
    setReceipt(payment);
    window.setTimeout(() => window.print(), 80);
  }

  if (authState === "checking") return <main className="auth-shell" dir="rtl"><div className="auth-loading"><span className="brand-mark">J</span><p>جاري تحميل النظام…</p></div></main>;

  if (authState === "signedOut") return (
    <main className="auth-shell" dir="rtl">
      <section className="login-card">
        <div className="login-brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>
        <div className="login-copy"><h1>تسجيل الدخول</h1><p>حساب شخصي وصلاحيات منفصلة لكل مستخدم.</p></div>
        <form onSubmit={signIn}>
          <Field label="اسم المستخدم" value={username} onChange={setUsername} required autoComplete="username" />
          <Field label="كلمة المرور" type="password" value={password} onChange={setPassword} required autoComplete="current-password" />
          <button className="primary login-button" disabled={busy}>{busy ? "جاري التحقق…" : "دخول آمن"}</button>
        </form>
        <p className="login-foot">بالإعداد الأول: اسم المستخدم الافتراضي admin وكلمة المرور من JMR_ADMIN_PASSWORD.</p>
      </section>
      {toast && <ToastView toast={toast} />}
    </main>
  );

  if (!data) return null;
  const navPages = (Object.keys(pageNames) as Page[]).filter(item => owner || (item !== "users" && item !== "history"));

  return (
    <main className={`app-shell page-${page} ${receipt ? "printing-receipt" : ""}`} dir="rtl">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>
        <nav>{navPages.map(item => <button key={item} type="button" className={page === item ? "active" : ""} aria-current={page === item ? "page" : undefined} disabled={formOpen || busy} onClick={() => { setPage(item); setSearch(""); }}>{pageNames[item]}</button>)}</nav>
        <div className="side-note"><strong>{data.actor.name}</strong><small>{roleLabel(data.actor.role)}</small><button className="secondary" disabled={busy || formOpen} onClick={() => void logout()}>تسجيل الخروج</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">BY JMR MALL</p><h1>{pageNames[page]}</h1><p>أرقام ثابتة، صلاحيات واضحة، وسجل كامل لكل تعديل.</p></div>
          <div className="top-actions"><span className={`save-state ${stale ? "error-text" : ""}`}>{busy ? "جاري تنفيذ الطلب…" : stale ? "العرض يحتاج تحديث قبل أي تعديل" : "✓ البيانات متزامنة"}</span><button className="secondary" disabled={busy || formOpen} onClick={() => void run(async () => { await refresh(); notify("تم تحديث البيانات"); })}>تحديث</button></div>
        </header>

        {data.bootstrap && <div className="notice-banner"><strong>إعداد أول مرة:</strong> أنشئ حساب مالك قوي. بعده حساب الإعداد بيتوقف تلقائياً.<button className="primary" disabled={busy || formOpen} onClick={() => { setPage("users"); setUserEdit({ username: "", name: "", role: "owner", active: 1, password: "" }); }}>إنشاء حساب المالك</button></div>}
        {stale && <div className="notice-banner error">توقّف التعديل مؤقتاً. اضغط تحديث وتأكد من الأرقام قبل المتابعة.</div>}

        {(page === "audit" || page === "invoices" || page === "payments") && <div className="toolbar">
          <label className="month-picker">الشهر<input type="month" value={month} min="2000-01" max="2099-12" disabled={busy || formOpen} onChange={event => event.target.value && setMonth(event.target.value)} /></label>
          <div className="toolbar-actions"><span className={`status-pill ${locked ? "approved" : ""}`}>{selectedStatus ? locked ? "معتمد" : "مسودة" : "غير مُنشأ"}</span>{invoicesReady && <button className="secondary" disabled={disabled} onClick={() => void downloadExcel()}>تحميل Excel</button>}</div>
        </div>}

        {(page === "audit" || page === "payments") && <div className="stats">
          <Stat label="الإيجار والخدمات" value={totals.rent} />
          <Stat label="الكهرباء" value={totals.electricity} />
          <Stat label="المحصّل" value={paidTotal} />
          <Stat label="المتبقي" value={roundedMoney(totals.total - paidTotal)} />
        </div>}

        {page === "audit" && <section className="panel">
          <div className="panel-head"><div><h2>{monthLabel(month)}</h2><p>{complete.length} / {currentRecords.length} سجل مكتمل</p></div><div className="toolbar-actions"><input className="search-input" aria-label="بحث" placeholder="بحث بالقسم أو المستثمر…" value={search} onChange={event => setSearch(event.target.value)} />{owner && selectedStatus && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => void run(async () => { const result = await action({ action: "lockMonth", month, locked: locked ? 0 : 1 }); notify(String(result.message ?? "تم")); })}>{locked ? "إعادة فتح الشهر" : "اعتماد الشهر"}</button>}</div></div>
          {!selectedStatus ? <div className="empty"><h3>الشهر غير مُنشأ</h3><p>الشهر الجديد بياخد القراءة النهائية من الشهر المعتمد السابق، لكن بيضل غير مكتمل لحد ما تراجع وتحفظ كل سجل.</p>{writer && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => void run(async () => { const result = await action({ action: "createMonth", month }); notify(String(result.message ?? "تم إنشاء الشهر")); })}>إنشاء الشهر</button>}</div> : <div className="table-wrap"><table><thead><tr><th>القسم / المستثمر</th><th>السابقة</th><th>الحالية</th><th>الاستهلاك</th><th>الإيجار والخدمات</th><th>الكهرباء</th><th>المجموع</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{visibleRecords.map(record => {
            const charges = recordCharges(record);
            return <tr key={record.id}><td><strong>{record.meterSection}</strong><small>{record.occupant}</small></td><td>{record.previousReading}</td><td>{record.currentReading}</td><td>{charges.usage}</td><td>{currency.format(charges.rent)}</td><td>{currency.format(charges.electricity)}</td><td>{currency.format(charges.total)}</td><td>{isRecordReady(record) ? "مكتمل" : "يحتاج مراجعة"}</td><td>{writer && !locked && <button className="secondary" disabled={disabled || data.bootstrap} onClick={() => startRecord(record)}>مراجعة وحفظ</button>}</td></tr>;
          })}</tbody></table></div>}
          {selectedStatus && !locked && missingDepartments.length > 0 && <div className="panel-footer"><strong>أقسام فعّالة مش موجودة بهالشهر:</strong>{missingDepartments.map(department => <button key={department.id} className="secondary" disabled={disabled || data.bootstrap} onClick={() => void run(async () => { const result = await action({ action: "addToMonth", month, departmentId: department.id }); notify(String(result.message ?? "تمت الإضافة")); })}>إضافة {department.meterSection}</button>)}</div>}
        </section>}

        {page === "departments" && <section className="panel">
          <div className="panel-head"><div><h2>الأقسام والعقود</h2><p>أي تعديل جديد ما بيغيّر نسخة المستأجر الموجودة بالفواتير السابقة.</p></div>{writer && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => setDepartmentEdit({ draft: { ...emptyDepartment } })}>إضافة قسم</button>}</div>
          <div className="table-wrap"><table><thead><tr><th>القسم</th><th>النوع</th><th>المالك</th><th>المستثمر</th><th>العقد</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.departments.map(department => <tr key={department.id}><td>{department.meterSection}</td><td>{department.category}</td><td>{department.owner}<small>{department.phone}</small></td><td>{department.occupant}<small>{department.occupantNumber}</small></td><td>{department.rentStart || "—"}<small>{department.rentEnd || "—"}</small></td><td>{department.active ? "فعّال" : "مؤرشف"}</td><td>{writer && <button className="secondary" disabled={disabled || data.bootstrap} onClick={() => setDepartmentEdit({ id: department.id, draft: { ...department } })}>تعديل / أرشفة</button>}</td></tr>)}</tbody></table></div>
        </section>}

        {page === "invoices" && <section className="invoice-page">
          <div className="invoice-controls"><div className="invoice-filter" role="group" aria-label="نوع الفاتورة">{(["all", "rent", "electricity"] as const).map(kind => <button key={kind} className={invoiceFilter === kind ? "active" : ""} aria-pressed={invoiceFilter === kind} onClick={() => setInvoiceFilter(kind)}>{kind === "all" ? "الكل" : kind === "rent" ? "الإيجار" : "الكهرباء"}</button>)}</div><button className="primary" disabled={!invoicesReady || busy || formOpen} onClick={() => window.print()}>طباعة الفواتير</button></div>
          {!invoicesReady ? <div className="empty"><h3>الفواتير النهائية بعد الاعتماد فقط</h3><p>أكمل كل السجلات واعتمد الشهر. هيك ما بتنطبع فاتورة ناقصة أو بأرقام مؤقتة.</p></div> : <div className="invoice-grid">{currentRecords.flatMap(record => {
            const cards = [];
            if (invoiceFilter === "all" || invoiceFilter === "rent") cards.push(<RentInvoice key={`rent-${record.id}`} month={month} record={record} paid={paidFor(record.id, "rent")} />);
            if (invoiceFilter === "all" || invoiceFilter === "electricity") cards.push(<ElectricityInvoice key={`electricity-${record.id}`} month={month} record={record} paid={paidFor(record.id, "electricity")} />);
            return cards;
          })}</div>}
        </section>}

        {page === "payments" && <><section className="panel"><div className="panel-head"><div><h2>أرصدة الفواتير</h2><p>الدفعات الجزئية مسموحة، بس النظام ما بيسمح يتجاوز المقبوض قيمة الفاتورة.</p></div></div>{!invoicesReady ? <div className="empty">التحصيل بيفتح بعد اعتماد الشهر.</div> : <div className="table-wrap"><table><thead><tr><th>القسم</th><th>الفاتورة</th><th>المستحق</th><th>المدفوع</th><th>المتبقي</th><th>إجراء</th></tr></thead><tbody>{currentRecords.flatMap(record => (["rent", "electricity"] as const).map(kind => {
          const due = recordCharges(record)[kind]; const paid = paidFor(record.id, kind); const balance = roundedMoney(due - paid);
          return <tr key={`${record.id}-${kind}`}><td>{record.meterSection}<small>{record.occupant}</small></td><td>{kind === "rent" ? "الإيجار والخدمات" : "الكهرباء"}</td><td>{currency.format(due)}</td><td>{currency.format(paid)}</td><td>{currency.format(balance)}</td><td>{writer && balance > 0 && <button className="primary" disabled={disabled || data.bootstrap} onClick={() => setPaymentEdit({ recordId: record.id, kind, amount: balance.toFixed(2), paidAt: today(), note: "", requestId: crypto.randomUUID() })}>تسجيل دفعة</button>}</td></tr>;
        }))}</tbody></table></div>}</section><section className="panel spaced"><div className="panel-head"><h2>الإيصالات ({monthPayments.length})</h2></div><div className="table-wrap"><table><thead><tr><th>الإيصال</th><th>القسم / النوع</th><th>المبلغ</th><th>المحصّل</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{monthPayments.map(payment => {
          const record = currentRecords.find(item => item.id === payment.recordId);
          return <tr key={payment.id}><td><small className="receipt-id">{payment.id}</small></td><td>{record?.meterSection}<small>{payment.kind === "rent" ? "إيجار وخدمات" : "كهرباء"}</small></td><td>{currency.format(payment.amount)}<small>{payment.paidAt}</small></td><td>{payment.receivedBy}</td><td>{payment.voidedAt ? "معكوس" : "فعّال"}<small>{payment.voidReason}</small></td><td><button className="secondary" onClick={() => printReceipt(payment)}>طباعة</button>{owner && !payment.voidedAt && <button className="danger-button" disabled={disabled} onClick={() => setVoidEdit({ id: payment.id, reason: "" })}>عكس</button>}</td></tr>;
        })}</tbody></table></div></section></>}

        {page === "users" && owner && <section className="panel"><div className="panel-head"><div><h2>الحسابات والصلاحيات</h2><p>تغيير كلمة المرور أو الصلاحية بيلغي جلسات المستخدم القديمة.</p></div><button className="primary" disabled={disabled} onClick={() => setUserEdit({ username: "", name: "", role: data.bootstrap ? "owner" : "accountant", active: 1, password: "" })}>إضافة مستخدم</button></div><div className="table-wrap"><table><thead><tr><th>الاسم</th><th>المستخدم</th><th>الصلاحية</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td>{user.name}</td><td>{user.username}</td><td>{roleLabel(user.role)}</td><td>{user.active ? "فعّال" : "معطّل"}</td><td><button className="secondary" disabled={disabled} onClick={() => setUserEdit({ ...user, password: "" })}>تعديل</button></td></tr>)}</tbody></table></div></section>}

        {page === "history" && owner && <section className="panel"><div className="panel-head"><div><h2>آخر 200 عملية</h2><p>مين عمل شو ومتى، بدون حذف السجل المحاسبي.</p></div></div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>{data.audit.map(entry => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString("ar-LB")}</td><td>{entry.actorName}</td><td>{entry.action}</td><td>{entry.detail}</td></tr>)}</tbody></table></div></section>}
      </section>

      {departmentEdit && <Modal title={departmentEdit.id ? "تعديل القسم" : "إضافة قسم"} busy={busy} onClose={() => setDepartmentEdit(null)}><form onSubmit={saveDepartment}><div className="form-grid">
        <Field label="عداد / قسم" value={departmentEdit.draft.meterSection} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, meterSection: value } })} required />
        <Field label="نوعية القسم" value={departmentEdit.draft.category} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, category: value } })} required />
        <Field label="صاحب القسم" value={departmentEdit.draft.owner} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, owner: value } })} />
        <Field label="رقم التلفون" value={departmentEdit.draft.phone} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, phone: value } })} />
        <Field label="مستخدم القسم" value={departmentEdit.draft.occupant} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, occupant: value } })} required />
        <Field label="رقم المستخدم" value={departmentEdit.draft.occupantNumber} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, occupantNumber: value } })} />
        <Field label="تاريخ بدء الإيجار" type="date" value={departmentEdit.draft.rentStart} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, rentStart: value } })} />
        <Field label="تاريخ انتهاء الإيجار" type="date" value={departmentEdit.draft.rentEnd} onChange={value => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, rentEnd: value } })} />
      </div><label className="check-field"><input type="checkbox" checked={departmentEdit.draft.active === 1} onChange={event => setDepartmentEdit({ ...departmentEdit, draft: { ...departmentEdit.draft, active: event.target.checked ? 1 : 0 } })} />قسم فعّال</label><SaveButton busy={busy} /></form></Modal>}

      {recordEdit && <Modal title={`${recordEdit.record.meterSection} — ${monthLabel(recordEdit.record.month)}`} busy={busy} onClose={() => setRecordEdit(null)}><form onSubmit={saveRecord}><p>الحفظ بيأكد اكتمال السجل. القراءة السابقة بتتحدد من الشهر السابق على السيرفر.</p><div className="form-grid">
        <NumberField label="رسم العداد ($)" value={recordEdit.draft.meterFee} onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, meterFee: value } })} />
        <NumberField label="سعر الكيلو ($)" value={recordEdit.draft.kiloPrice} step="0.0001" onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, kiloPrice: value } })} />
        <NumberField label="قيمة الإيجار ($)" value={recordEdit.draft.rent} onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, rent: value } })} />
        <NumberField label="قيمة الخدمات ($)" value={recordEdit.draft.services} onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, services: value } })} />
        <NumberField label="العداد السابق" value={recordEdit.draft.previousReading} disabled={data.records.some(item => item.departmentId === recordEdit.record.departmentId && item.month < recordEdit.record.month)} onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, previousReading: value } })} />
        <NumberField label="العداد الحالي" value={recordEdit.draft.currentReading} onChange={value => setRecordEdit({ ...recordEdit, draft: { ...recordEdit.draft, currentReading: value } })} />
      </div><SaveButton busy={busy} /></form></Modal>}

      {paymentEdit && <Modal title="تسجيل دفعة" busy={busy} onClose={() => setPaymentEdit(null)}><form onSubmit={savePayment}><Field label="المبلغ بالدولار" type="number" value={paymentEdit.amount} onChange={value => setPaymentEdit({ ...paymentEdit, amount: value })} required min="0.01" step="0.01" /><Field label="تاريخ الدفع" type="date" value={paymentEdit.paidAt} onChange={value => setPaymentEdit({ ...paymentEdit, paidAt: value })} required /><Field label="ملاحظة" value={paymentEdit.note} onChange={value => setPaymentEdit({ ...paymentEdit, note: value })} /><p>حتى لو انقطع الاتصال وأعدت نفس الطلب، معرّف الدفعة بيمنع تسجيلها مرتين.</p><SaveButton busy={busy} /></form></Modal>}

      {voidEdit && <Modal title="عكس إيصال" busy={busy} onClose={() => setVoidEdit(null)}><form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await action({ action: "voidPayment", id: voidEdit.id, reason: voidEdit.reason }); setVoidEdit(null); notify(String(result.message ?? "تم العكس")); }); }}><p>الإيصال ما بينحذف. بيضل بالأرشيف مع سبب العكس واسم المستخدم.</p><Field label="سبب العكس" value={voidEdit.reason} onChange={value => setVoidEdit({ ...voidEdit, reason: value })} required /><SaveButton busy={busy} /></form></Modal>}

      {userEdit && <Modal title={userEdit.id ? "تعديل المستخدم" : "إضافة مستخدم"} busy={busy} onClose={() => setUserEdit(null)}><form onSubmit={saveUser}><Field label="الاسم" value={userEdit.name} onChange={value => setUserEdit({ ...userEdit, name: value })} required /><Field label="اسم المستخدم" value={userEdit.username} onChange={value => setUserEdit({ ...userEdit, username: value })} required /><Field label={userEdit.id ? "كلمة مرور جديدة — اتركها فارغة للإبقاء على الحالية" : "كلمة المرور — 12 حرف على الأقل"} type="password" value={userEdit.password} onChange={value => setUserEdit({ ...userEdit, password: value })} required={!userEdit.id} autoComplete="new-password" /><label className="field"><span>الصلاحية</span><select value={userEdit.role} disabled={data.bootstrap} onChange={event => setUserEdit({ ...userEdit, role: event.target.value as Role })}><option value="owner">المالك</option><option value="accountant">المحاسب</option><option value="viewer">عرض فقط</option></select></label><label className="check-field"><input type="checkbox" checked={userEdit.active === 1} disabled={data.bootstrap} onChange={event => setUserEdit({ ...userEdit, active: event.target.checked ? 1 : 0 })} />حساب فعّال</label><SaveButton busy={busy} /></form></Modal>}

      {receipt && <div className="receipt-print"><Receipt payment={receipt} record={data.records.find(record => record.id === receipt.recordId)!} /></div>}
      {toast && <ToastView toast={toast} />}
    </main>
  );
}

function Field({ label, value, onChange, type = "text", required = false, ...rest }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; min?: string; step?: string; autoComplete?: string }) {
  return <label className="field"><span>{label}</span><input type={type} value={value} onChange={event => onChange(event.target.value)} required={required} {...rest} /></label>;
}
function NumberField({ label, value, onChange, step = "0.01", disabled = false }: { label: string; value: number; onChange: (value: number) => void; step?: string; disabled?: boolean }) {
  return <label className="field"><span>{label}</span><input type="number" min="0" step={step} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))} required /></label>;
}
function SaveButton({ busy }: { busy: boolean }) { return <button className="primary form-save" disabled={busy}>{busy ? "جاري الحفظ…" : "حفظ وتأكيد"}</button>; }
function Stat({ label, value }: { label: string; value: number }) { return <div className="stat"><p>{label}</p><strong>{currency.format(value)}</strong></div>; }
function ToastView({ toast }: { toast: NonNullable<Toast> }) { return <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>{toast.tone === "error" ? "!" : "✓"} {toast.message}</div>; }
function Modal({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="edit-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><h2>{title}</h2><button type="button" aria-label="إغلاق" disabled={busy} onClick={onClose}>×</button></header>{children}</dialog>;
}

function InvoiceHeader({ title, month }: { title: string; month: string }) {
  return <header className="invoice-card-head"><div><span>BY JMR MALL</span><strong>{title}</strong></div><time>{monthLabel(month)}</time></header>;
}
function InvoiceIdentity({ record }: { record: MonthlyRecord }) {
  return <div className="invoice-identity"><div><span>عداد / قسم</span><strong>{record.meterSection}</strong></div><div><span>اسم المستثمر</span><strong>{record.occupant}</strong></div><div><span>رقم المستثمر</span><strong>{record.occupantNumber || "—"}</strong></div></div>;
}
function RentInvoice({ month, record, paid }: { month: string; record: MonthlyRecord; paid: number }) {
  const total = record.rent + record.services;
  return <article className="invoice-card rent-invoice"><InvoiceHeader title="فاتورة الإيجار" month={month} /><InvoiceIdentity record={record} /><div className="invoice-values two-values"><div><span>قيمة الإيجار</span><strong>{currency.format(record.rent)}</strong></div><div><span>قيمة الخدمات</span><strong>{currency.format(record.services)}</strong></div></div><footer className="invoice-total"><span>المجموع</span><strong>{currency.format(total)}</strong></footer><p>المدفوع: {currency.format(paid)} · المتبقي: <strong>{currency.format(roundedMoney(total - paid))}</strong></p></article>;
}
function ElectricityInvoice({ month, record, paid }: { month: string; record: MonthlyRecord; paid: number }) {
  const usage = record.currentReading - record.previousReading;
  const subscription = usage * record.kiloPrice + record.meterFee;
  const difference = record.currentReading - record.previousReading;
  const total = subscription + record.services + record.rent;
  void difference; void total;
  return <article className="invoice-card electricity-invoice"><InvoiceHeader title="فاتورة الكهرباء" month={month} /><InvoiceIdentity record={record} /><div className="invoice-values electricity-values"><div><span>العداد السابق</span><strong>{record.previousReading}</strong></div><div><span>العداد الحالي</span><strong>{record.currentReading}</strong></div><div><span>صرف العداد</span><strong>{usage}</strong></div><div><span>سعر الكيلو</span><strong>{currency.format(record.kiloPrice)}</strong></div><div><span>رسم العداد</span><strong>{currency.format(record.meterFee)}</strong></div></div><footer className="invoice-total"><span>قيمة الاشتراك</span><strong>{currency.format(roundedMoney(subscription))}</strong></footer><p>المدفوع: {currency.format(paid)} · المتبقي: <strong>{currency.format(roundedMoney(subscription - paid))}</strong></p></article>;
}
function Receipt({ payment, record }: { payment: Payment; record: MonthlyRecord }) {
  return <article className="invoice-card receipt-card"><InvoiceHeader title="إيصال قبض" month={record.month} /><p className="receipt-id">رقم الإيصال: {payment.id}</p><InvoiceIdentity record={record} /><p>نوع الفاتورة: {payment.kind === "rent" ? "الإيجار والخدمات" : "الكهرباء"}</p><footer className="invoice-total"><span>المبلغ المقبوض</span><strong>{currency.format(payment.amount)}</strong></footer><p>التاريخ: {payment.paidAt} · المحصّل: {payment.receivedBy}</p>{payment.note && <p>{payment.note}</p>}{payment.voidedAt && <p className="error-text">إيصال معكوس — {payment.voidReason} — بواسطة {payment.voidedBy}</p>}</article>;
}
