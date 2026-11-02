"use client";

/**
 * "הזמנת תורים בקישור" (/calendar/booking) — the business's public booking link and its rules (Milestone C), design
 * direction A. Each change is saved at once, with the version it was read at.
 *
 *   the state      while Dubiz has not opened public booking for the business (the platform's flag) the page says so
 *                  in one line, and the switch that would open the link is shown OFF and disabled — nothing looks active
 *                  only to fail after a tap. Everything else can be prepared; it takes effect when booking opens.
 *   הקישור         one switch "לקוחות יכולים לבקש תור" (off = new requests stop now), the link to copy, a new link if it
 *                  leaked (asked first).
 *   אישור          the default for a newly opened service, self-cancellation and its window; how long a request holds
 *                  its time is the platform's rule and is only stated.
 *   מה פתוח         services (open + approval) and staff (offered + order).
 *   בחירת עובד      none / optional / required, and how one is picked when the customer does not choose. A combination
 *                  that would leave the link with no bookable service is named before it is saved, with the fix.
 *   מה מוצג         address, business details, prices, staff names.
 *   מגבלות          open requests per phone (pending requests + future bookings confirmed automatically from the link),
 *                  never above the platform's ceiling; the platform's own limits are stated.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

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
import { bookingDeadEnd, errorText } from "./calendar-model";
import { bookingState } from "./manage-screens";
import { Chevron, FeatureOff, IconAlert, Loading, LoadError, ScreenHead, Seg, Switch, useToast } from "./ui";
import s from "./calendar.module.css";

const WINDOWS = [0, 2, 6, 12, 24, 48, 72];
const windowLabel = (h: number) => (h === 0 ? "עד תחילת התור" : `עד ${h} שעות לפני`);

export function BookingSettingsScreen() {
  const on = useFeatureState("appointments");
  const [data, setData] = useState<BookingAdminWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { flash, node: toast } = useToast();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);

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

  /** Swap two staff members in the owner's order ("סדר עדיפות קבוע"); orders are made distinct first. */
  const moveStaff = async (index: number, delta: -1 | 1) => {
    if (!data) return;
    const list = data.staff.filter((m) => m.active);
    const a = list[index];
    const b = list[index + delta];
    if (!a || !b) return;
    setBusy(true);
    try {
      await setStaffPublic(a.id, { sortOrder: (index + delta) * 10, expectedVersion: a.version });
      await setStaffPublic(b.id, { sortOrder: index * 10, expectedVersion: b.version });
      await load();
      flash("הסדר נשמר");
    } catch (e) {
      await stale(e);
    } finally {
      setBusy(false);
    }
  };

  if (on === false) return <FeatureOff title="הזמנת תורים בקישור" />;

  const st = data?.settings;
  const link = st?.linkPath && typeof window !== "undefined" ? `${window.location.origin}${st.linkPath}` : null;
  const activeStaff = data?.staff.filter((m) => m.active) ?? [];
  const state = data ? bookingState(data) : null;
  const deadEnd = st ? bookingDeadEnd(st, activeStaff.length > 0) : null;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="הזמנת תורים בקישור" subtitle={state ? state.tag : undefined} fallback="/calendar/manage" />
        {error && !data ? <LoadError text={`לא הצלחתי לטעון את ההגדרות. ${error}`} onRetry={() => void load()} /> : null}
        {!data && !error ? <Loading label="טוען הגדרות" /> : null}

        {data && st ? (
          <>
            {!data.platform.open ? (
              <div className={`${s.banner} ${s.bannerInfo}`} role="status" style={{ marginTop: 16 }}>
                <span className={s.bannerText}>
                  <strong>ההזמנה בקישור עוד לא פתוחה לעסק שלך.</strong>
                  <span>דוביז תפתח אותה בהמשך. עד אז אין קישור ולקוחות לא יכולים לבקש תור — אפשר כבר להכין את ההגדרות.</span>
                </span>
              </div>
            ) : null}

            <section className={s.section} aria-labelledby="bk-link">
              <h2 id="bk-link">הקישור</h2>
              <div className={s.setRow}>
                <label htmlFor="bk-enabled">
                  לקוחות יכולים לבקש תור
                  <small>{!data.platform.open ? "ייפתח אחרי שדוביז תפתח את ההזמנה בקישור." : st.enabled ? "כיבוי עוצר בקשות חדשות מיד. תורים קיימים נשארים." : "כבוי — הקישור לא מקבל בקשות."}</small>
                </label>
                <Switch id="bk-enabled" label="לקוחות יכולים לבקש תור" checked={st.enabled} disabled={busy || (!data.platform.open && !st.enabled)} onChange={(v) => void save({ enabled: v }, v ? "הקישור הופעל" : "בקשות חדשות נעצרו")} />
              </div>
              {link ? (
                <div className={s.linkCode}>
                  <code dir="ltr">{link}</code>
                  <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => {
                    navigator.clipboard?.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => undefined);
                  }}>{copied ? "הועתק" : "העתקה"}</button>
                </div>
              ) : <p className={s.note}>{data.platform.open ? "הקישור ייווצר בפעם הראשונה שמפעילים את ההזמנות." : "הקישור יופיע כאן אחרי שההזמנה תיפתח."}</p>}
              {link ? (
                confirmRotate ? (
                  <div className={s.confirm} role="alertdialog" aria-labelledby="bk-rotate-q">
                    <strong id="bk-rotate-q">להחליף את הקישור? הקישור הקודם יפסיק לעבוד מיד, גם אצל מי שכבר קיבל אותו.</strong>
                    <div className={s.confirmRow}>
                      <button type="button" className={`${s.btn} ${s.btnDangerFill}`} disabled={busy} onClick={async () => {
                        setBusy(true);
                        try { setData(await rotateBookingLink(st.version)); flash("נוצר קישור חדש"); } catch (e) { await stale(e); } finally { setBusy(false); setConfirmRotate(false); }
                      }}>כן, להחליף</button>
                      <button type="button" className={s.btn} onClick={() => setConfirmRotate(false)}>חזרה</button>
                    </div>
                  </div>
                ) : <button type="button" className={`${s.btn} ${s.btnGhost}`} style={{ alignSelf: "flex-start" }} onClick={() => setConfirmRotate(true)}>החלפת הקישור</button>
              ) : null}
            </section>

            <section className={s.section} aria-labelledby="bk-approve">
              <h2 id="bk-approve">אישור תורים</h2>
              <div className={s.setRow}>
                <span>ברירת המחדל לשירות שנפתח להזמנה</span>
                <Seg small label="ברירת מחדל לאישור" value={st.defaultApprovalMode} disabled={busy} options={[["MANUAL", "באישור שלי"], ["AUTO", "אוטומטי"]]} onChange={(v) => void save({ defaultApprovalMode: v })} />
              </div>
              <p className={s.hint}>בקשה ממתינה שומרת את השעה עד 12 שעות, או עד תחילת התור — המוקדם מביניהם. אחרי שעתיים בלי תשובה תגיע תזכורת לנייד, וכל שעתיים נוספות.</p>
              <div className={s.setRow}>
                <label htmlFor="bk-cancel">הלקוח יכול לבטל בעצמו</label>
                <Switch id="bk-cancel" label="הלקוח יכול לבטל בעצמו" checked={st.selfCancelEnabled} disabled={busy} onChange={(v) => void save({ selfCancelEnabled: v })} />
              </div>
              {st.selfCancelEnabled ? (
                <div className={s.setRow}>
                  <label htmlFor="bk-window">ביטול עצמי אפשרי</label>
                  <select id="bk-window" className={s.filterSelect} value={st.selfCancelWindowHours} disabled={busy} onChange={(e) => void save({ selfCancelWindowHours: Number(e.target.value) })}>
                    {[...new Set([...WINDOWS, st.selfCancelWindowHours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{windowLabel(h)}</option>)}
                  </select>
                </div>
              ) : null}
            </section>

            <section className={s.section} aria-labelledby="bk-services">
              <h2 id="bk-services">שירותים פתוחים להזמנה</h2>
              {data.services.length === 0 ? <p className={s.note}>אין עדיין שירותים. אפשר להוסיף ב<Link href="/calendar/services" prefetch={false} className={s.linkBtn}>שירותים</Link>.</p> : null}
              {data.services.map((x) => (
                <div key={x.id} className={s.sheet} style={{ gap: 6, paddingBlock: 6, borderBottom: "1px solid var(--ap-line-soft)" }}>
                  <div className={s.setRow}>
                    <label htmlFor={`bk-svc-${x.id}`}>{x.name}<small>{x.durationMinutes ? `${x.durationMinutes} דק׳` : "ללא משך — צריך משך כדי לפתוח להזמנה"}</small></label>
                    <Switch id={`bk-svc-${x.id}`} label={`${x.name} פתוח להזמנה`} checked={x.publicBookable} disabled={busy || !x.durationMinutes}
                      onChange={(v) => void saveService(x.id, v ? { publicBookable: true, approvalMode: x.policyVersion === null ? st.defaultApprovalMode : x.approvalMode } : { publicBookable: false }, x.policyVersion)} />
                  </div>
                  {x.publicBookable ? (
                    <Seg small label={`אישור עבור ${x.name}`} value={x.approvalMode} disabled={busy} options={[["MANUAL", "באישור שלי"], ["AUTO", "אוטומטי"]]} onChange={(v) => void saveService(x.id, { approvalMode: v }, x.policyVersion)} />
                  ) : null}
                </div>
              ))}
              <p className={s.hint}>זמני הכנה, שעות מוצעות, הזמנה מראש וטווח נקבעים ב<Link href="/calendar/services" prefetch={false} className={s.linkBtn}>שירותים</Link>, וחלים גם על הקישור.</p>
            </section>

            <section className={s.section} aria-labelledby="bk-staff">
              <h2 id="bk-staff">עובדים בקישור</h2>
              {activeStaff.length === 0 ? <p className={s.note}>אין עובדים — הקישור יציע את השעות של העסק עצמו.</p> : (
                <>
                  <div className={s.setRow}>
                    <span>הלקוח בוחר עובד</span>
                    <Seg small label="הלקוח בוחר עובד" value={st.staffChoiceMode} disabled={busy} options={[["NONE", "לא"], ["OPTIONAL", "אם רוצה"], ["REQUIRED", "חובה"]]} onChange={(v) => void save({ staffChoiceMode: v })} />
                  </div>
                  {deadEnd ? (
                    <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
                      <IconAlert size={20} />
                      <span className={s.bannerText}>{deadEnd}</span>
                      <span className={s.confirmRow} style={{ width: "100%" }}>
                        <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => void save({ showStaffNames: true }, "שמות העובדים מוצגים")}>להציג את השמות</button>
                        <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => void save({ staffChoiceMode: "OPTIONAL" }, "הבחירה שונתה ל„אם רוצה”")}>לשנות ל„אם רוצה”</button>
                      </span>
                    </div>
                  ) : null}
                  <div className={s.setRow}>
                    <span>כשהלקוח לא בוחר</span>
                    <Seg small label="שיטת שיבוץ" value={st.assignmentMode} disabled={busy} options={[["BALANCED", "חלוקה שווה"], ["PRIORITY", "לפי הסדר"]]} onChange={(v) => void save({ assignmentMode: v }, "השיטה נשמרה — חלה על הזמנות חדשות")} />
                  </div>
                  <p className={s.hint}>{st.assignmentMode === "BALANCED" ? "העובד הפנוי עם הכי מעט תורים באותו יום. בשוויון — לפי הסדר שלמטה." : "העובד הפנוי הראשון לפי הסדר שלמטה."}</p>
                  {activeStaff.map((m, i) => (
                    <div key={m.id} className={s.setRow}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className={s.dot} style={{ ["--lane" as string]: m.color ?? "#b9b0a7" }} aria-hidden="true" />{m.displayName}</span>
                      <span className={s.order}>
                        <button type="button" className={s.iconBtn} aria-label={`להקדים את ${m.displayName}`} disabled={busy || i === 0} onClick={() => void moveStaff(i, -1)}><Chevron dir="up" /></button>
                        <button type="button" className={s.iconBtn} aria-label={`לאחר את ${m.displayName}`} disabled={busy || i === activeStaff.length - 1} onClick={() => void moveStaff(i, 1)}><Chevron dir="down" /></button>
                        <Switch id={`bk-staff-${m.id}`} label={`${m.displayName} זמין להזמנה`} checked={m.publicBookable} disabled={busy} onChange={(v) => void saveStaff(m.id, { publicBookable: v }, m.version)} />
                      </span>
                    </div>
                  ))}
                  <p className={s.hint}>עובד מוצע בקישור רק אם הוא זמין להזמנה ומבצע את השירות, ורק בשעות שבהן גם העסק פתוח. שינוי כאן לא משנה תורים קיימים.</p>
                </>
              )}
            </section>

            <section className={s.section} aria-labelledby="bk-public">
              <h2 id="bk-public">מה רואים בקישור</h2>
              <p className={s.hint}>שם העסק, שם השירות והמשך מוצגים תמיד. פרטי לקוחות ופרטי קשר של עובדים לא מוצגים.</p>
              {([
                ["showAddress", "כתובת ועיר"],
                ["showBusinessDetails", "סוג העסק וטלפון העסק"],
                ["showPrices", "מחירי השירותים"],
                ["showStaffNames", "שמות העובדים"],
              ] as const).map(([k, label]) => (
                <div key={k} className={s.setRow}>
                  <label htmlFor={`bk-${k}`}>{label}</label>
                  <Switch id={`bk-${k}`} label={label} checked={st[k]} disabled={busy} onChange={(v) => void save({ [k]: v } as Partial<BookingSettingsWire>)} />
                </div>
              ))}
            </section>

            <section className={s.section} aria-labelledby="bk-limits">
              <h2 id="bk-limits">מגבלות</h2>
              <div className={s.setRow}>
                <label htmlFor="bk-cap">
                  בקשות פתוחות לכל טלפון
                  <small>נספרות בקשות שממתינות לאישור, ותורים עתידיים שנקבעו מהקישור באישור אוטומטי.</small>
                </label>
                <select id="bk-cap" className={s.filterSelect} value={st.maxOpenRequestsPerPhone} disabled={busy} onChange={(e) => void save({ maxOpenRequestsPerPhone: Number(e.target.value) })}>
                  {Array.from({ length: data.platform.limits.maxOpenRequestsPerPhone }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <p className={s.hint}>
                מגבלות האבטחה של דוביז (קבועות): עד {data.platform.limits.maxOpenRequestsPerPhone} בקשות פתוחות לטלפון,
                {" "}{data.platform.limits.submitPerIpPerMinute} שליחות בדקה ו־{data.platform.limits.submitPerIpPerHour} בשעה מכל רשת,
                {" "}ועד {data.platform.limits.submitPerBusinessPerHour} בקשות בשעה לעסק.
              </p>
            </section>
            <p className={s.note}><Link href="/calendar?view=requests" prefetch={false} className={s.linkBtn}>לרשימת הבקשות</Link></p>
          </>
        ) : null}
      </div>
      {toast}
    </main>
  );
}
