"use client";

/**
 * "הזמנות מהקישור" (/calendar/booking) — the business's public booking link and its rules (Milestone C, segment 2).
 *
 * What the owner decides here (each change is saved at once, with the version it was read at):
 *   the link       on / off for the business (and "עצירת הזמנות עכשיו"), the link to copy, a new link if it leaked;
 *   approval       the default for a newly opened service (D2) and per service; how long a request holds its time is
 *                  the platform's rule (12 hours, or until the appointment starts — D3) and is only shown;
 *   services       which services are open on the link, and approved by the owner or automatically;
 *   staff          who is offered on the link (D7), whether the customer chooses, and how a staff member is picked
 *                  when they do not (D8, with the owner's order for "סדר עדיפות קבוע");
 *   cancellation   self-cancellation on / off and its window (D9);
 *   what is shown  address, business details, prices, staff names (D10) — the business name, the service and its
 *                  length are always shown;
 *   limits         open requests per phone, never above the platform's ceiling; the ceilings are shown, not editable.
 * Turning the link on works only while Dubiz has opened public booking for the business (the platform's flag); until
 * then everything can be prepared and the screen says so.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import t from "@/features/tasks/tasks.module.css";

import {
  CalendarApiError,
  forgetIntent,
  getBookingAdmin,
  rotateBookingLink,
  saveBookingSettings,
  savePolicy,
  setStaffPublic,
  type BookingAdminWire,
  type BookingSettingsWire,
} from "./calendar-client";
import { errorText } from "./calendar-model";
import s from "./calendar.module.css";

const WINDOWS = [0, 2, 6, 12, 24, 48, 72];
const windowLabel = (h: number) => (h === 0 ? "עד תחילת התור" : `עד ${h} שעות לפני`);

function Toggle({ id, checked, onChange, disabled, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`${s.switch} ${checked ? s.switchOn : ""}`} onClick={() => onChange(!checked)}>
      <span aria-hidden="true" />
    </button>
  );
}

function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className={s.seg} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} className={value === v ? s.segOn : ""} onClick={() => value !== v && onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function BookingSettingsScreen() {
  const on = useFeatureState("appointments");
  const [data, setData] = useState<BookingAdminWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 4000);
  };

  const load = useCallback(() => getBookingAdmin().then(
    (next) => { setData(next); setError(null); },
    (e) => setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")),
  ), []);

  useEffect(() => {
    if (!on) return;
    const h = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(h);
  }, [on, load]);

  const stale = async (e: unknown) => {
    const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
    flash(err.code === "VERSION_CONFLICT" ? "ההגדרות השתנו בינתיים (אולי במסך אחר). מוצג המצב העדכני." : errorText(err.code, err.status));
    await load();
  };

  const save = async (patch: Partial<BookingSettingsWire>, message = "נשמר") => {
    if (!data) return;
    setBusy(true);
    try {
      setData(await saveBookingSettings({ ...patch, expectedVersion: data.settings.version }));
      flash(message);
    } catch (e) {
      await stale(e);
    } finally {
      setBusy(false);
    }
  };

  const saveService = async (id: number, patch: { publicBookable?: boolean; approvalMode?: "MANUAL" | "AUTO" }, version: number | null) => {
    const intent = `booking:service:${id}:${version ?? 0}:${JSON.stringify(patch)}`;
    setBusy(true);
    try {
      await savePolicy(intent, id, { ...patch, expectedVersion: version });
      await load();
      flash("נשמר");
    } catch (e) {
      forgetIntent(intent);
      await stale(e);
    } finally {
      setBusy(false);
    }
  };

  const saveStaff = async (id: number, patch: { publicBookable?: boolean; sortOrder?: number }, version: number) => {
    setBusy(true);
    try {
      await setStaffPublic(id, { ...patch, expectedVersion: version });
      await load();
      flash("נשמר");
    } catch (e) {
      await stale(e);
    } finally {
      setBusy(false);
    }
  };

  /** Swap two staff members in the owner's order (D8 "סדר עדיפות קבוע"); orders are made distinct first. */
  const moveStaff = async (index: number, delta: -1 | 1) => {
    if (!data) return;
    const list = data.staff.filter((m) => m.active);
    const a = list[index];
    const b = list[index + delta];
    if (!a || !b) return;
    setBusy(true);
    try {
      const aOrder = (index + delta) * 10;
      const bOrder = index * 10;
      await setStaffPublic(a.id, { sortOrder: aOrder, expectedVersion: a.version });
      await setStaffPublic(b.id, { sortOrder: bOrder, expectedVersion: b.version });
      await load();
      flash("הסדר נשמר");
    } catch (e) {
      await stale(e);
    } finally {
      setBusy(false);
    }
  };

  if (on === false) {
    return (
      <main className={s.screen}>
        <header className={s.top}><h1 className={s.title}>הזמנות מהקישור</h1></header>
        <section className={s.empty}><h2>היומן עדיין לא פעיל לעסק שלך</h2></section>
      </main>
    );
  }

  const st = data?.settings;
  const link = st?.linkPath && typeof window !== "undefined" ? `${window.location.origin}${st.linkPath}` : null;
  const activeStaff = data?.staff.filter((m) => m.active) ?? [];
  const openServices = data?.services.filter((x) => x.publicBookable).length ?? 0;
  const publicStaff = activeStaff.filter((m) => m.publicBookable).length;

  return (
    <main className={s.screen} data-page-intent="content">
      <header className={s.top}>
        <h1 className={s.title}>הזמנות מהקישור</h1>
        <span className={s.grow} />
        <Link href="/calendar?view=requests" prefetch={false} className={`${t.btn} ${t.ghost}`}>לבקשות</Link>
        <Link href="/calendar" prefetch={false} className={`${t.btn} ${t.ghost}`}>חזרה ליומן</Link>
      </header>
      <p className={s.note}>לקוחות יכולים לבקש תור דרך קישור אישי של העסק, בלי חשבון בדוביז. כל בקשה נבדקת מול השעות והתורים שביומן, ואתה מחליט איך היא מאושרת.</p>
      {error ? <div className={`${t.banner} ${t.bannerBad}`} role="alert">{error}</div> : null}
      {!data && !error ? <p className={t.hint} aria-busy="true">טוען…</p> : null}

      {data && st ? (
        <>
          {!data.platform.open ? (
            <div className={s.warnBox} role="status">
              <strong>הקישור עוד לא פתוח לציבור.</strong>
              <span>דוביז תפתח את ההזמנות לעסק שלך בהמשך. אפשר כבר עכשיו להכין שירותים, עובדים והגדרות — הם ייכנסו לתוקף כשההזמנות ייפתחו.</span>
            </div>
          ) : null}

          <div className={s.bkGrid}>
            <section className={s.panel} aria-labelledby="bk-link">
              <h2 id="bk-link">הקישור שלך</h2>
              <div className={s.bkRow}>
                <label htmlFor="bk-enabled">לקוחות יכולים לבקש תור</label>
                <Toggle id="bk-enabled" label="לקוחות יכולים לבקש תור" checked={st.enabled} disabled={busy} onChange={(v) => void save({ enabled: v }, v ? "הקישור הופעל" : "הזמנות חדשות נעצרו")} />
              </div>
              {link ? (
                <div className={s.bkLink}>
                  <code dir="ltr">{link}</code>
                  <button type="button" className={t.btn} onClick={() => {
                    navigator.clipboard?.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => undefined);
                  }}>{copied ? "הועתק" : "העתקה"}</button>
                </div>
              ) : <p className={t.hint}>הקישור ייווצר בפעם הראשונה שמפעילים את ההזמנות.</p>}
              {st.enabled ? (
                <button type="button" className={`${t.btn} ${t.danger}`} disabled={busy} onClick={() => void save({ enabled: false }, "הזמנות חדשות נעצרו")}>עצירת הזמנות חדשות עכשיו</button>
              ) : null}
              {link ? (
                confirmRotate ? (
                  <div className={s.reqConfirm} role="alertdialog" aria-labelledby="bk-rotate-q">
                    <span id="bk-rotate-q">להחליף את הקישור? הקישור הקודם יפסיק לעבוד מיד, גם אצל מי שכבר קיבל אותו.</span>
                    <div className={t.actions}>
                      <button type="button" className={`${t.btn} ${t.danger}`} disabled={busy} onClick={async () => {
                        setBusy(true);
                        try { setData(await rotateBookingLink(st.version)); flash("נוצר קישור חדש"); } catch (e) { await stale(e); } finally { setBusy(false); setConfirmRotate(false); }
                      }}>כן, להחליף</button>
                      <button type="button" className={t.btn} onClick={() => setConfirmRotate(false)}>חזרה</button>
                    </div>
                  </div>
                ) : <button type="button" className={`${t.btn} ${t.ghost}`} onClick={() => setConfirmRotate(true)}>החלפת הקישור</button>
              ) : null}
            </section>

            <section className={s.panel} aria-labelledby="bk-approve">
              <h2 id="bk-approve">אישור תורים</h2>
              <div className={s.bkRow}>
                <span>ברירת מחדל לשירות שנפתח להזמנה</span>
                <Seg label="ברירת מחדל לאישור" value={st.defaultApprovalMode} disabled={busy} options={[["MANUAL", "אני מאשר"], ["AUTO", "אוטומטי"]]} onChange={(v) => void save({ defaultApprovalMode: v })} />
              </div>
              <p className={t.hint}>בקשה ממתינה שומרת את השעה עד 12 שעות, או עד תחילת התור — המוקדם מביניהם. אחרי שעתיים בלי תשובה תקבל תזכורת לנייד, וכל שעתיים נוספות.</p>
              <div className={s.bkRow}>
                <label htmlFor="bk-cancel">הלקוח יכול לבטל בעצמו</label>
                <Toggle id="bk-cancel" label="הלקוח יכול לבטל בעצמו" checked={st.selfCancelEnabled} disabled={busy} onChange={(v) => void save({ selfCancelEnabled: v })} />
              </div>
              {st.selfCancelEnabled ? (
                <div className={s.bkRow}>
                  <label htmlFor="bk-window">ביטול עצמי אפשרי</label>
                  <select id="bk-window" className={s.select} value={st.selfCancelWindowHours} disabled={busy} onChange={(e) => void save({ selfCancelWindowHours: Number(e.target.value) })}>
                    {[...new Set([...WINDOWS, st.selfCancelWindowHours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{windowLabel(h)}</option>)}
                  </select>
                </div>
              ) : null}
            </section>

            <section className={s.panel} aria-labelledby="bk-services">
              <h2 id="bk-services">שירותים פתוחים להזמנה {openServices ? <span className={s.reqCount}>{openServices}</span> : null}</h2>
              {data.services.length === 0 ? <p className={t.hint}>אין עדיין שירותים. אפשר להוסיף ב<Link href="/calendar/services" prefetch={false}>שירותים</Link>.</p> : null}
              {data.services.map((x) => (
                <div key={x.id} className={s.bkItem}>
                  <div className={s.bkRow}>
                    <span className={s.bkName}>{x.name}<small> · {x.durationMinutes ? `${x.durationMinutes} דק׳` : "ללא משך"}</small></span>
                    <Toggle id={`bk-svc-${x.id}`} label={`${x.name} פתוח להזמנה`} checked={x.publicBookable} disabled={busy || !x.durationMinutes}
                      onChange={(v) => void saveService(x.id, v ? { publicBookable: true, approvalMode: x.policyVersion === null ? st.defaultApprovalMode : x.approvalMode } : { publicBookable: false }, x.policyVersion)} />
                  </div>
                  {!x.durationMinutes ? <span className={t.hint}>צריך משך לשירות כדי לפתוח אותו להזמנה.</span> : null}
                  {x.publicBookable ? (
                    <Seg label={`אישור עבור ${x.name}`} value={x.approvalMode} disabled={busy} options={[["MANUAL", "אני מאשר"], ["AUTO", "אוטומטי"]]} onChange={(v) => void saveService(x.id, { approvalMode: v }, x.policyVersion)} />
                  ) : null}
                </div>
              ))}
              <p className={t.hint}>מרווחים, קפיצות בין שעות, התראה מינימלית וטווח נקבעים ב<Link href="/calendar/services" prefetch={false}>שירותים</Link>, וחלים גם על הקישור.</p>
            </section>

            <section className={s.panel} aria-labelledby="bk-staff">
              <h2 id="bk-staff">עובדים {publicStaff ? <span className={s.reqCount}>{publicStaff}</span> : null}</h2>
              {activeStaff.length === 0 ? <p className={t.hint}>אין עובדים — הקישור יציע את השעות של העסק עצמו.</p> : (
                <>
                  <div className={s.bkRow}>
                    <span>הלקוח בוחר עובד</span>
                    <Seg label="הלקוח בוחר עובד" value={st.staffChoiceMode} disabled={busy} options={[["NONE", "לא"], ["OPTIONAL", "אם רוצה"], ["REQUIRED", "חובה"]]} onChange={(v) => void save({ staffChoiceMode: v })} />
                  </div>
                  <div className={s.bkRow}>
                    <span>כשהלקוח לא בוחר</span>
                    <Seg label="שיטת שיבוץ" value={st.assignmentMode} disabled={busy} options={[["BALANCED", "חלוקה מאוזנת"], ["PRIORITY", "סדר עדיפות קבוע"]]} onChange={(v) => void save({ assignmentMode: v }, "השיטה נשמרה — חלה על הזמנות חדשות")} />
                  </div>
                  <p className={t.hint}>{st.assignmentMode === "BALANCED" ? "העובד הפנוי עם הכי מעט תורים באותו יום. בשוויון — לפי הסדר שלמטה." : "העובד הפנוי הראשון לפי הסדר שלמטה."}</p>
                  {activeStaff.map((m, i) => (
                    <div key={m.id} className={s.bkRow}>
                      <span className={s.bkName}><span className={s.swatch} style={{ ["--lane" as string]: m.color ?? "var(--dz-brand)", display: "inline-block", width: 10, height: 10, marginInlineEnd: 6 }} />{m.displayName}</span>
                      <span className={s.bkOrder}>
                        <button type="button" className={`${t.btn} ${t.ghost}`} aria-label={`להקדים את ${m.displayName}`} disabled={busy || i === 0} onClick={() => void moveStaff(i, -1)}>▲</button>
                        <button type="button" className={`${t.btn} ${t.ghost}`} aria-label={`לאחר את ${m.displayName}`} disabled={busy || i === activeStaff.length - 1} onClick={() => void moveStaff(i, 1)}>▼</button>
                        <Toggle id={`bk-staff-${m.id}`} label={`${m.displayName} זמין להזמנה`} checked={m.publicBookable} disabled={busy} onChange={(v) => void saveStaff(m.id, { publicBookable: v }, m.version)} />
                      </span>
                    </div>
                  ))}
                  <p className={t.hint}>עובד מוצע בקישור רק אם הוא זמין להזמנה ומבצע את השירות. שינוי כאן לא משנה תורים קיימים.</p>
                </>
              )}
            </section>

            <section className={s.panel} aria-labelledby="bk-public">
              <h2 id="bk-public">מה מוצג בקישור</h2>
              <p className={t.hint}>שם העסק, שם השירות והמשך מוצגים תמיד. פרטי לקוחות ופרטי קשר של עובדים לא מוצגים לעולם.</p>
              {([
                ["showAddress", "כתובת ועיר"],
                ["showBusinessDetails", "סוג העסק וטלפון העסק"],
                ["showPrices", "מחירי השירותים"],
                ["showStaffNames", "שמות העובדים"],
              ] as const).map(([k, label]) => (
                <div key={k} className={s.bkRow}>
                  <label htmlFor={`bk-${k}`}>{label}</label>
                  <Toggle id={`bk-${k}`} label={label} checked={st[k]} disabled={busy} onChange={(v) => void save({ [k]: v } as Partial<BookingSettingsWire>)} />
                </div>
              ))}
            </section>

            <section className={s.panel} aria-labelledby="bk-limits">
              <h2 id="bk-limits">מגבלות</h2>
              <div className={s.bkRow}>
                <label htmlFor="bk-cap">בקשות פתוחות לכל טלפון</label>
                <select id="bk-cap" className={s.select} value={st.maxOpenRequestsPerPhone} disabled={busy} onChange={(e) => void save({ maxOpenRequestsPerPhone: Number(e.target.value) })}>
                  {Array.from({ length: data.platform.limits.maxOpenRequestsPerPhone }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <p className={t.hint}>
                מגבלות האבטחה של דוביז (לא ניתנות לשינוי): עד {data.platform.limits.maxOpenRequestsPerPhone} בקשות פתוחות לטלפון,
                {" "}{data.platform.limits.submitPerIpPerMinute} שליחות בדקה ו־{data.platform.limits.submitPerIpPerHour} בשעה מכל רשת,
                {" "}ועד {data.platform.limits.submitPerBusinessPerHour} בקשות בשעה לעסק.
              </p>
            </section>
          </div>
        </>
      ) : null}
      {toast ? <div className={t.toast} role="status"><span>{toast}</span></div> : null}
    </main>
  );
}
