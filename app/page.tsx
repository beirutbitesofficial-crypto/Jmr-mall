"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Department = {
  id: number; meterSection: string; category: string; owner: string; phone: string;
  occupant: string; occupantNumber: string; rentStart: string; rentEnd: string; active: number;
};

type MonthlyRecord = {
  id: number; month: string; departmentId: number; meterFee: number; kiloPrice: number;
  rent: number; services: number; previousReading: number; currentReading: number; locked: number;
};

const emptyDepartment: Omit<Department, "id"> = {
  meterSection: "", category: "", owner: "", phone: "", occupant: "",
  occupantNumber: "", rentStart: "", rentEnd: "", active: 1,
};

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (value: string) => new Intl.DateTimeFormat("ar-LB", { month: "long", year: "numeric" }).format(new Date(`${value}-01T12:00:00`));
const currentMonth = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Beirut", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find(part => part.type === "year")?.value ?? String(new Date().getFullYear());
  const month = parts.find(part => part.type === "month")?.value ?? String(new Date().getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

type AuthState = "checking" | "signedOut" | "signedIn";
type ToastState = { message: string; tone: "success" | "error" } | null;

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [pin, setPin] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [page, setPage] = useState<"audit" | "departments" | "invoices">("audit");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [records, setRecords] = useState<MonthlyRecord[]>([]);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showDepartmentForm, setShowDepartmentForm] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [notificationsSeen, setNotificationsSeen] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "rent" | "electricity">("all");
  const [draft, setDraft] = useState(emptyDepartment);
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string, tone: "success" | "error" = "success") => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/data", { cache: "no-store" });
      if (response.status === 401) {
        setAuthState("signedOut");
        setDepartments([]);
        setRecords([]);
        return;
      }
      if (!response.ok) throw new Error("تعذّر تحميل البيانات");
      const data = await response.json();
      setDepartments(data.departments ?? []);
      setRecords(data.records ?? []);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر تحميل البيانات", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    let active = true;
    const checkSession = async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!active) return;
        if (response.ok) {
          setAuthState("signedIn");
          await refresh();
        } else {
          setAuthState("signedOut");
          setLoading(false);
        }
      } catch {
        if (active) {
          setAuthState("signedOut");
          setLoading(false);
        }
      }
    };
    void checkSession();
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const currentRecords = useMemo(() => records.filter(r => r.month === selectedMonth), [records, selectedMonth]);
  const activeDepartments = useMemo(() => departments.filter(d => d.active), [departments]);
  const rows = useMemo(() => currentRecords.map(record => ({ record, department: departments.find(d => d.id === record.departmentId)! })).filter(row => row.department && [row.department.meterSection, row.department.occupant, row.department.occupantNumber].join(" ").toLowerCase().includes(search.toLowerCase())), [currentRecords, departments, search]);
  const invoiceRows = useMemo(() => currentRecords.map(record => ({ record, department: departments.find(d => d.id === record.departmentId)! })).filter(row => row.department), [currentRecords, departments]);
  const locked = currentRecords.length > 0 && currentRecords.every(r => r.locked);
  const totals = currentRecords.reduce((sum, record) => {
    const usage = record.currentReading - record.previousReading;
    const subscription = usage * record.kiloPrice + record.meterFee;
    sum.rent += record.rent; sum.services += record.services; sum.subscription += subscription; sum.total += subscription + record.services + record.rent;
    return sum;
  }, { rent: 0, services: 0, subscription: 0, total: 0 });

  const api = async (body: unknown) => {
    setSaving(true);
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) {
        setAuthState("signedOut");
        throw new Error("انتهت الجلسة. أدخل رمز الدخول من جديد");
      }
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "تعذّر حفظ التغييرات");
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const createMonth = async () => {
    try {
      await api({ action: "createMonth", month: selectedMonth });
      notify("تم تجهيز الشهر ونقل القراءات السابقة");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر إنشاء الشهر", "error");
    }
  };

  const updateRecord = (id: number, field: keyof MonthlyRecord, value: number) => {
    setRecords(old => old.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const saveRecord = async (record: MonthlyRecord) => {
    if (record.currentReading < record.previousReading) {
      notify("العداد الحالي يجب أن يكون أكبر من أو يساوي العداد السابق", "error");
      return;
    }
    try {
      await api({ action: "updateRecord", record });
      notify("تم الحفظ");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر الحفظ", "error");
    }
  };

  const addDepartment = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api({ action: "addDepartment", department: draft, month: selectedMonth });
      setDraft(emptyDepartment);
      setShowDepartmentForm(false);
      notify("تمت إضافة القسم وتجهيز فواتيره للشهر");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّرت إضافة القسم", "error");
    }
  };

  const toggleLock = async () => {
    try {
      await api({ action: "lockMonth", month: selectedMonth, locked: locked ? 0 : 1 });
      notify(locked ? "تم فتح الشهر للتعديل" : "تم اعتماد وإقفال الشهر");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر تغيير حالة الشهر", "error");
    }
  };

  const submitPin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAuthError("");
    if (!/^\d{4,8}$/.test(pin)) {
      setAuthError("أدخل رمزاً من 4 إلى 8 أرقام");
      return;
    }
    setAuthBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        if (response.status === 429) setAuthError("محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً");
        else if (response.status === 401) setAuthError("رمز الدخول غير صحيح");
        else if (result?.error === "AUTH_NOT_CONFIGURED") setAuthError("رمز الدخول لم يُضبط بعد");
        else setAuthError("تعذّر التحقق من رمز الدخول");
        return;
      }
      setPin("");
      setLoading(true);
      setAuthState("signedIn");
      await refresh();
    } catch {
      setAuthError("تعذّر الاتصال بالنظام. حاول مجدداً");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    setAuthBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setDepartments([]);
      setRecords([]);
      setPage("audit");
      setShowProfileMenu(false);
      setShowNotifications(false);
      setAuthState("signedOut");
      setAuthBusy(false);
    }
  };

  const downloadExcel = async () => {
    setDownloading(true);
    try {
      const response = await fetch(`/api/export?month=${encodeURIComponent(selectedMonth)}`);
      if (response.status === 401) {
        setAuthState("signedOut");
        throw new Error("انتهت الجلسة. أدخل رمز الدخول من جديد");
      }
      if (!response.ok) throw new Error("تعذّر تجهيز ملف Excel");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `By-JMR-Mall-${selectedMonth}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify("تم تجهيز ملف Excel");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر تنزيل ملف Excel", "error");
    } finally {
      setDownloading(false);
    }
  };

  if (authState === "checking") {
    return <main className="auth-shell" dir="rtl"><div className="auth-loading"><span className="brand-mark">J</span><p>جاري تأمين النظام…</p></div></main>;
  }

  if (authState === "signedOut") {
    return (
      <main className="auth-shell" dir="rtl">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>
          <div className="login-copy"><span className="lock-mark">●</span><h1 id="login-title">تسجيل الدخول</h1><p>أدخل رمز الـ PIN للوصول إلى نظام التدقيق</p></div>
          <form onSubmit={submitPin}>
            <label className="pin-field"><span>رمز الدخول</span><input autoFocus autoComplete="current-password" inputMode="numeric" pattern="[0-9]*" type="password" maxLength={8} value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, ""))} placeholder="••••" aria-describedby={authError ? "pin-error" : undefined} /></label>
            {authError && <p className="auth-error" id="pin-error" role="alert">{authError}</p>}
            <button className="primary login-button" disabled={authBusy || pin.length < 4}>{authBusy ? "جاري التحقق…" : "دخول آمن"}</button>
          </form>
          <p className="login-foot">البيانات مشفّرة والجلسة تُغلق تلقائياً بعد 12 ساعة</p>
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell page-${page}`} dir="rtl">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">J</span><div><strong>BY JMR</strong><small>MALL AUDIT SYSTEM</small></div></div>
        <nav>
          <button type="button" aria-current={page === "audit" ? "page" : undefined} className={page === "audit" ? "active" : ""} onClick={() => setPage("audit")}><span>▦</span> التدقيق الشهري</button>
          <button type="button" aria-current={page === "departments" ? "page" : undefined} className={page === "departments" ? "active" : ""} onClick={() => setPage("departments")}><span>⌂</span> بيانات الأقسام</button>
          <button type="button" aria-current={page === "invoices" ? "page" : undefined} className={page === "invoices" ? "active" : ""} onClick={() => setPage("invoices")}><span>▤</span> الفواتير والطباعة</button>
        </nav>
        <div className="side-note"><span className="status-dot" /> النظام متصل ومحفوظ<small>آخر مزامنة: الآن</small></div>
        <div className="profile-area">
          <button type="button" className="profile profile-trigger" aria-label="قائمة الحساب" aria-expanded={showProfileMenu} onClick={() => { setShowProfileMenu(value => !value); setShowNotifications(false); }}><span className="avatar">JH</span><span className="profile-copy"><strong>Jad Harb</strong><small>المالك · مدير النظام</small></span><span aria-hidden="true">⋮</span></button>
          {showProfileMenu && <div className="profile-menu"><strong>Jad Harb</strong><small>جلسة دخول آمنة</small><button type="button" onClick={() => void logout()} disabled={authBusy}>تسجيل الخروج</button></div>}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">BY JMR MALL</p><h1>{page === "audit" ? "التدقيق الشهري" : page === "departments" ? "بيانات الأقسام والمستأجرين" : "الفواتير الشهرية"}</h1><p>{page === "audit" ? "مراجعة استهلاك العدادات ومستحقات الأقسام" : page === "departments" ? "المرجع الأساسي للأقسام والعقود والمستأجرين" : "فواتير الإيجار والكهرباء جاهزة للطباعة"}</p></div>
          <div className="top-actions">
            <span className={`save-state ${saving ? "saving" : ""}`}>{saving ? "جاري الحفظ…" : "✓ جميع التغييرات محفوظة"}</span>
            <div className="notification-area">
              <button type="button" className="icon-btn" aria-label="الإشعارات" aria-expanded={showNotifications} onClick={() => { setShowNotifications(value => !value); setNotificationsSeen(true); setShowProfileMenu(false); }}>♢{!notificationsSeen && <i />}</button>
              {showNotifications && <section className="notification-panel" aria-label="إشعارات النظام"><header><strong>إشعارات النظام</strong><button type="button" aria-label="إغلاق الإشعارات" onClick={() => setShowNotifications(false)}>×</button></header><div className="notice-item"><span className="status-dot" /><div><strong>النظام متصل</strong><small>كل البيانات محفوظة في قاعدة البيانات</small></div></div><div className="notice-item"><span className={locked ? "notice-dot locked" : "notice-dot"} /><div><strong>{currentRecords.length === 0 ? "الشهر غير مُنشأ" : locked ? "الشهر معتمد" : "الشهر قيد التعديل"}</strong><small>{monthLabel(selectedMonth)} · {currentRecords.length} سجل</small></div></div><div className="notice-item"><span className="notice-dot invoice" /><div><strong>الفواتير</strong><small>{invoiceRows.length ? `${invoiceRows.length * 2} فاتورة جاهزة للمعاينة` : "تظهر بعد إنشاء سجل الشهر"}</small></div></div></section>}
            </div>
            <button type="button" className="mobile-logout" aria-label="تسجيل الخروج" onClick={() => void logout()}>خروج</button>
          </div>
        </header>

        {page === "audit" ? (
          <>
            <div className="toolbar">
              <div className="month-control"><button type="button" aria-label="الشهر السابق" onClick={() => setSelectedMonth(previousMonth(selectedMonth, 1))}>‹</button><label><span>الفترة الحالية</span><input type="month" value={selectedMonth} onChange={e => { if (e.target.value) setSelectedMonth(e.target.value); }} /></label><button type="button" aria-label="الشهر التالي" onClick={() => setSelectedMonth(previousMonth(selectedMonth, -1))}>›</button></div>
              <div className="toolbar-actions"><button type="button" className="secondary" onClick={() => void downloadExcel()} disabled={downloading}>{downloading ? "جاري التجهيز…" : "↓ تحميل Excel"}</button><button type="button" className="secondary" onClick={() => window.print()} disabled={currentRecords.length === 0}>طباعة</button>{currentRecords.length > 0 && <button type="button" className={locked ? "secondary" : "primary"} onClick={() => void toggleLock()} disabled={saving}>{locked ? "فتح الشهر" : "اعتماد الشهر"} {locked ? "↻" : "✓"}</button>}</div>
            </div>

            <div className="stats">
              <Stat label="إجمالي الإيجارات" value={totals.rent} accent="blue" />
              <Stat label="إجمالي الخدمات" value={totals.services} accent="amber" />
              <Stat label="قيمة الاشتراك" value={totals.subscription} accent="violet" />
              <Stat label="المجموع" value={totals.total} accent="green" featured />
            </div>

            <section className="panel">
              <div className="panel-head"><div><h2>سجل {monthLabel(selectedMonth)}</h2><p>{rows.length} من أصل {activeDepartments.length} قسم فعّال</p></div><div className="search"><span>⌕</span><input aria-label="بحث بالاسم أو القسم أو العداد" placeholder="بحث بالاسم، القسم أو العداد…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
              {loading ? <div className="empty">جاري تحميل البيانات…</div> : currentRecords.length === 0 ? (
                <div className="empty"><div className="empty-icon">＋</div><h3>لم يتم إنشاء سجل لهذا الشهر</h3><p>سيتم إضافة الأقسام الفعّالة ونقل العداد الحالي من الشهر السابق تلقائياً.</p><button type="button" className="primary" onClick={() => void createMonth()} disabled={saving}>إنشاء سجل {monthLabel(selectedMonth)}</button></div>
              ) : (
                <div className="table-wrap"><table><thead><tr><th>عداد / قسم</th><th>اسم المستثمر</th><th>رقم المستثمر</th><th>رسم العداد</th><th>سعر الكيلو</th><th>قيمة الإيجار</th><th>قيمة الخدمات</th><th>العداد السابق</th><th>العداد الحالي</th><th>صرف العداد</th><th>قيمة الاشتراك</th><th>المجموع</th></tr></thead><tbody>
                  {rows.map(({ record, department }) => {
                    const difference = record.currentReading - record.previousReading;
                    const subscription = difference * record.kiloPrice + record.meterFee;
                    const total = subscription + record.services + record.rent;
                    const hasPreviousMonth = records.some(candidate => candidate.departmentId === record.departmentId && candidate.month < record.month);
                    return <tr key={record.id} className={difference < 0 ? "invalid" : ""}><td><strong>{department.meterSection}</strong><small>{department.category}</small></td><td>{department.occupant}</td><td className="mono">{department.occupantNumber}</td>{(["meterFee", "kiloPrice", "rent", "services", "previousReading", "currentReading"] as (keyof MonthlyRecord)[]).map(field => <td key={field}><input className="cell-input" aria-label={`${fieldLabel(field)} — ${department.meterSection}`} type="number" min="0" step="0.01" disabled={locked || saving || (field === "previousReading" && hasPreviousMonth)} value={record[field] as number} onChange={e => updateRecord(record.id, field, Number(e.target.value))} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={() => void saveRecord(records.find(r => r.id === record.id) ?? record)} /></td>)}<td className={difference < 0 ? "danger" : "mono strong"}>{difference}</td><td className="money">${money.format(subscription)}</td><td className="money total">${money.format(total)}</td></tr>;
                  })}
                </tbody><tfoot><tr><td colSpan={9}>المجموع الشهري</td><td>—</td><td>${money.format(totals.subscription)}</td><td>${money.format(totals.total)}</td></tr></tfoot></table></div>
              )}
            </section>
          </>
        ) : page === "departments" ? (
          <section className="panel departments-panel">
            <div className="panel-head"><div><h2>الأقسام المسجّلة</h2><p>{departments.length} سجل في قاعدة البيانات</p></div><button type="button" className="primary" onClick={() => setShowDepartmentForm(true)} disabled={saving}>＋ إضافة قسم جديد</button></div>
            {showDepartmentForm && <form className="department-form" onSubmit={addDepartment}><div className="form-title"><h3>إضافة قسم أو عداد</h3><button type="button" aria-label="إغلاق نموذج إضافة القسم" onClick={() => { setShowDepartmentForm(false); setDraft(emptyDepartment); }}>×</button></div><div className="form-grid">
              <Field label="عداد / قسم" value={draft.meterSection} onChange={v => setDraft({ ...draft, meterSection: v })} required />
              <Field label="نوعية القسم" value={draft.category} onChange={v => setDraft({ ...draft, category: v })} required />
              <Field label="صاحب القسم" value={draft.owner} onChange={v => setDraft({ ...draft, owner: v })} />
              <Field label="رقم التلفون" value={draft.phone} onChange={v => setDraft({ ...draft, phone: v })} type="tel" />
              <Field label="مستخدم القسم" value={draft.occupant} onChange={v => setDraft({ ...draft, occupant: v })} required />
              <Field label="رقم المستخدم" value={draft.occupantNumber} onChange={v => setDraft({ ...draft, occupantNumber: v })} />
              <Field label="تاريخ بدء الإيجار" value={draft.rentStart} onChange={v => setDraft({ ...draft, rentStart: v })} type="date" />
              <Field label="تاريخ انتهاء الإيجار" value={draft.rentEnd} onChange={v => setDraft({ ...draft, rentEnd: v })} type="date" />
            </div><div className="form-actions"><button type="button" className="secondary" onClick={() => { setShowDepartmentForm(false); setDraft(emptyDepartment); }} disabled={saving}>إلغاء</button><button className="primary" disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ القسم"}</button></div></form>}
            <div className="table-wrap"><table className="departments-table"><thead><tr><th>عداد / قسم</th><th>نوعية القسم</th><th>صاحب القسم</th><th>رقم التلفون</th><th>مستخدم القسم</th><th>رقم المستخدم</th><th>تاريخ بدء الإيجار</th><th>تاريخ انتهاء الإيجار</th></tr></thead><tbody>{departments.map(d => <tr key={d.id}><td><strong>{d.meterSection}</strong></td><td>{d.category}</td><td>{d.owner}</td><td className="mono">{d.phone}</td><td>{d.occupant}</td><td className="mono">{d.occupantNumber}</td><td>{d.rentStart || "—"}</td><td>{d.rentEnd || "—"}</td></tr>)}</tbody></table></div>
          </section>
        ) : (
          <section className="invoice-page">
            <div className="invoice-controls">
              <div className="month-control"><button type="button" aria-label="الشهر السابق" onClick={() => setSelectedMonth(previousMonth(selectedMonth, 1))}>‹</button><label><span>شهر الفواتير</span><input type="month" value={selectedMonth} onChange={e => { if (e.target.value) setSelectedMonth(e.target.value); }} /></label><button type="button" aria-label="الشهر التالي" onClick={() => setSelectedMonth(previousMonth(selectedMonth, -1))}>›</button></div>
              <div className="invoice-filter" role="group" aria-label="نوع الفواتير">
                <button type="button" aria-pressed={invoiceFilter === "all"} className={invoiceFilter === "all" ? "active" : ""} onClick={() => setInvoiceFilter("all")}>الكل</button>
                <button type="button" aria-pressed={invoiceFilter === "rent"} className={invoiceFilter === "rent" ? "active" : ""} onClick={() => setInvoiceFilter("rent")}>الإيجار</button>
                <button type="button" aria-pressed={invoiceFilter === "electricity"} className={invoiceFilter === "electricity" ? "active" : ""} onClick={() => setInvoiceFilter("electricity")}>الكهرباء فقط</button>
              </div>
              <button type="button" className="primary print-invoices" onClick={() => window.print()} disabled={invoiceRows.length === 0}>طباعة الفواتير ▣</button>
            </div>
            {loading ? <div className="empty invoice-empty">جاري تجهيز الفواتير…</div> : invoiceRows.length === 0 ? (
              <div className="empty invoice-empty"><div className="empty-icon">▤</div><h3>لا توجد فواتير لهذا الشهر</h3><p>أنشئ سجل الشهر أولاً، وبعد تعبئة الأرقام تصبح فواتير الإيجار والكهرباء جاهزة تلقائياً.</p><button type="button" className="primary" onClick={() => void createMonth()} disabled={saving}>إنشاء سجل {monthLabel(selectedMonth)}</button></div>
            ) : (
              <div className="invoice-sheet">
                <div className="invoice-sheet-head"><div><span>معاينة الطباعة</span><strong>{monthLabel(selectedMonth)}</strong></div><small>{invoiceRows.length} مستثمر · {invoiceFilter === "all" ? invoiceRows.length * 2 : invoiceRows.length} فاتورة</small></div>
                <div className="invoice-grid">
                  {invoiceRows.flatMap(({ record, department }) => {
                    const cards = [];
                    if (invoiceFilter === "all" || invoiceFilter === "rent") cards.push(<RentInvoice key={`rent-${record.id}`} month={selectedMonth} department={department} record={record} />);
                    if (invoiceFilter === "all" || invoiceFilter === "electricity") cards.push(<ElectricityInvoice key={`electricity-${record.id}`} month={selectedMonth} department={department} record={record} />);
                    return cards;
                  })}
                </div>
              </div>
            )}
          </section>
        )}
      </section>
      {toast && <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite">{toast.tone === "error" ? "!" : "✓"} {toast.message}</div>}
    </main>
  );
}

function previousMonth(value: string, amount: number) { const [year, month] = value.split("-").map(Number); const date = new Date(year, month - 1 - amount, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }
function fieldLabel(field: keyof MonthlyRecord) { return ({ meterFee: "رسم العداد", kiloPrice: "سعر الكيلو", rent: "قيمة الإيجار", services: "قيمة الخدمات", previousReading: "العداد السابق", currentReading: "العداد الحالي" } as Partial<Record<keyof MonthlyRecord, string>>)[field] ?? field; }
function Stat({ label, value, accent, featured = false }: { label: string; value: number; accent: string; featured?: boolean }) { return <div className={`stat ${featured ? "featured" : ""}`}><div><p>{label}</p><strong><small>$</small>{money.format(value)}</strong><span className={accent}>●</span></div><small>{featured ? "المبلغ المطلوب تحصيله" : "لهذه الفترة"}</small></div>; }
function Field({ label, value, onChange, type = "text", required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) { return <label className="field"><span>{label}</span><input type={type} value={value} onChange={e => onChange(e.target.value)} required={required} /></label>; }

function InvoiceHeader({ title, month }: { title: string; month: string }) {
  return <header className="invoice-card-head"><div><span>BY JMR MALL</span><strong>{title}</strong></div><time>{monthLabel(month)}</time></header>;
}

function InvoiceIdentity({ department }: { department: Department }) {
  return <div className="invoice-identity"><div><span>عداد / قسم</span><strong>{department.meterSection}</strong></div><div><span>اسم المستثمر</span><strong>{department.occupant}</strong></div><div><span>رقم المستثمر</span><strong>{department.occupantNumber || "—"}</strong></div></div>;
}

function RentInvoice({ month, department, record }: { month: string; department: Department; record: MonthlyRecord }) {
  const total = record.rent + record.services;
  return <article className="invoice-card rent-invoice"><InvoiceHeader title="فاتورة الإيجار" month={month} /><InvoiceIdentity department={department} /><div className="invoice-values two-values"><div><span>قيمة الإيجار</span><strong>${money.format(record.rent)}</strong></div><div><span>قيمة الخدمات</span><strong>${money.format(record.services)}</strong></div></div><footer className="invoice-total"><span>المجموع</span><strong>${money.format(total)}</strong></footer></article>;
}

function ElectricityInvoice({ month, department, record }: { month: string; department: Department; record: MonthlyRecord }) {
  const usage = record.currentReading - record.previousReading;
  const subscription = usage * record.kiloPrice + record.meterFee;
  return <article className="invoice-card electricity-invoice"><InvoiceHeader title="فاتورة الكهرباء" month={month} /><InvoiceIdentity department={department} /><div className="invoice-values electricity-values"><div><span>العداد السابق</span><strong>{record.previousReading}</strong></div><div><span>العداد الحالي</span><strong>{record.currentReading}</strong></div><div><span>صرف العداد</span><strong>{usage}</strong></div><div><span>سعر الكيلو</span><strong>${money.format(record.kiloPrice)}</strong></div><div><span>رسم العداد</span><strong>${money.format(record.meterFee)}</strong></div></div><footer className="invoice-total"><span>قيمة الاشتراك</span><strong>${money.format(subscription)}</strong></footer></article>;
}
