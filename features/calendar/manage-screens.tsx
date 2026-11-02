"use client";

/**
 * "ניהול היומן" (/calendar/manage) — the calendar's settings in one place, design direction A: a row per subject with
 * the state it is in, each opening its own page:
 *   שעות פעילות          /calendar/hours           the business's week ("א׳–ה׳ 09:00–17:00")
 *   ימים מיוחדים          /calendar/special-days    closures and different hours of the business (staff: on their page)
 *   צוות                  /calendar/staff           names, colours, hours, services
 *   שירותים               /calendar/services        length, who performs, booking rules
 *   הזמנת תורים בקישור    /calendar/booking         "עדיין לא פתוח" until Dubiz opens it — the settings can be prepared
 * A summary that could not be read says so; it never reads as "none".
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { HoursEditor, SpecialDays } from "./availability-editors";
import { getAvailability, getBookingAdmin, listServices, listStaff, type BookingAdminWire, type ExceptionWire, type RuleWire, type ServiceWire } from "./calendar-client";
import { hoursSummary, todayKey, type StaffWire } from "./calendar-model";
import { Chevron, FeatureOff, IconCalendar, IconClock, IconLink, IconScissors, IconUsers, LeaveConfirm, Loading, ScreenHead, useToast } from "./ui";
import s from "./calendar.module.css";

type Read<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error" };

function useRead<T>(load: () => Promise<T>, on: boolean | null): Read<T> {
  const [r, setR] = useState<Read<T>>({ state: "loading" });
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    load().then((value) => { if (!cancelled) setR({ state: "ready", value }); }).catch(() => { if (!cancelled) setR({ state: "error" }); });
    return () => { cancelled = true; };
  }, [load, on]);
  return r;
}

function Row({ href, icon, title, sub, tag }: { href: string; icon: ReactNode; title: string; sub: ReactNode; tag?: ReactNode }) {
  return (
    <li>
      <Link href={href} prefetch={false} className={s.row}>
        <span className={s.rowIcon}>{icon}</span>
        <span className={s.rowText}>
          <span className={s.rowTitle}>{title}</span>
          <span className={s.rowSub}>{sub}</span>
        </span>
        <span className={s.rowEnd}>{tag}<Chevron dir="open" /></span>
      </Link>
    </li>
  );
}

const NOT_READ = "לא הצלחתי לטעון";

export function ManageScreen() {
  const on = useFeatureState("appointments");
  const today = todayKey(new Date());
  const avail = useRead(useCallback(() => getAvailability(null, today), [today]), on);
  const staff = useRead(useCallback(() => listStaff(), []), on);
  const services = useRead(useCallback(() => listServices().then((v) => v.filter((x) => x.active)), []), on);
  const booking = useRead(useCallback(() => getBookingAdmin(), []), on);

  if (on === false) return <FeatureOff title="ניהול היומן" />;

  const hoursText = avail.state === "ready" ? hoursSummary(avail.value.rules as RuleWire[]) ?? "עוד לא הוגדרו" : avail.state === "error" ? NOT_READ : "…";
  const specialText = avail.state === "ready" ? specialSummary(avail.value.exceptions) : avail.state === "error" ? NOT_READ : "…";
  const staffText = staff.state === "ready" ? staffSummary(staff.value) : staff.state === "error" ? NOT_READ : "…";
  const servicesText = services.state === "ready" ? servicesSummary(services.value) : services.state === "error" ? NOT_READ : "…";
  const bookingTag = booking.state === "ready" ? bookingState(booking.value) : null;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="ניהול היומן" subtitle="הגדרות וניהול המערכת" fallback="/calendar" />
        <ul className={s.list} style={{ marginTop: 20 }}>
          <Row href="/calendar/hours" icon={<IconClock size={28} />} title="שעות פעילות" sub={<bdi>{hoursText}</bdi>} tag={avail.state === "ready" && !avail.value.rules.length ? <span className={`${s.tag} ${s.tagWarn}`}>לא הוגדרו</span> : null} />
          <Row href="/calendar/staff" icon={<IconUsers size={28} />} title="צוות" sub={staffText} />
          <Row href="/calendar/services" icon={<IconScissors size={28} />} title="שירותים" sub={servicesText} />
          <Row href="/calendar/special-days" icon={<IconCalendar size={28} />} title="ימים מיוחדים" sub={specialText} />
          <Row
            href="/calendar/booking"
            icon={<IconLink size={28} />}
            title="הזמנת תורים בקישור"
            sub={booking.state === "error" ? NOT_READ : bookingTag?.sub ?? "…"}
            tag={bookingTag ? <span className={`${s.tag} ${bookingTag.on ? s.tagOn : ""}`}>{bookingTag.tag}</span> : null}
          />
        </ul>
        <p className={s.note} style={{ marginTop: 16 }}>לעובדים אין כניסה לדוביז — רק שם וצבע ביומן.</p>
      </div>
    </main>
  );
}

function specialSummary(list: ExceptionWire[]): string {
  if (!list.length) return "חופשות ושעות שונות · אין ימים קרובים";
  return `${list.length.toLocaleString("he-IL")} ${list.length === 1 ? "יום מיוחד קרוב" : "ימים מיוחדים קרובים"}`;
}

function staffSummary(list: StaffWire[]): string {
  if (!list.length) return "עוד אין עובדים — היומן עובד לפי שעות העסק";
  const active = list.filter((m) => m.active);
  const names = active.slice(0, 3).map((m) => m.displayName).join(", ");
  const rest = active.length > 3 ? ` ועוד ${active.length - 3}` : "";
  const off = list.length - active.length;
  return `${names || "אין עובדים פעילים"}${rest}${off ? ` · ${off} לא פעיל${off === 1 ? "" : "ים"}` : ""}`;
}

function servicesSummary(list: ServiceWire[]): string {
  if (!list.length) return "עוד אין שירותים";
  return `${list.length.toLocaleString("he-IL")} ${list.length === 1 ? "שירות" : "שירותים"}`;
}

export function bookingState(b: BookingAdminWire): { tag: string; sub: string; on: boolean } {
  if (!b.platform.open) return { tag: "עדיין לא פתוח", sub: "אפשר להכין הגדרות כבר עכשיו", on: false };
  if (!b.settings.enabled) return { tag: "כבוי", sub: "לקוחות לא יכולים לבקש תור", on: false };
  return { tag: "פעיל", sub: "לקוחות יכולים לבקש תור דרך הקישור", on: true };
}

/** A settings page with unsaved changes: Dubiz's back asks first. */
function useLeaveGuard() {
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const onBeforeLeave = (proceed: () => void) => { if (dirty) setLeaving(() => proceed); else proceed(); };
  const node = leaving ? <LeaveConfirm onStay={() => setLeaving(null)} onLeave={() => { const go = leaving; setLeaving(null); setDirty(false); go(); }} /> : null;
  return { setDirty, onBeforeLeave, node };
}

export function HoursScreen() {
  const on = useFeatureState("appointments");
  const { flash, node: toast } = useToast();
  const guard = useLeaveGuard();
  if (on === false) return <FeatureOff title="שעות פעילות" />;
  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="שעות פעילות" subtitle="מתי העסק פתוח לתורים" fallback="/calendar/manage" onBeforeLeave={guard.onBeforeLeave} />
        {guard.node}
        <p className={s.note} style={{ margin: "14px 0 4px" }}>השעות קובעות אילו שעות היומן מציע כפנויות. אפשר תמיד לקבוע גם מחוץ להן.</p>
        {on ? <HoursEditor staffMemberId={null} onSaved={flash} onDirty={guard.setDirty} /> : <Loading />}
      </div>
      {toast}
    </main>
  );
}

export function SpecialDaysScreen() {
  const on = useFeatureState("appointments");
  const { flash, node: toast } = useToast();
  if (on === false) return <FeatureOff title="ימים מיוחדים" />;
  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="ימים מיוחדים" subtitle="חג, חופשה, יום קצר או שעות שונות" fallback="/calendar/manage" />
        <p className={s.note} style={{ margin: "14px 0 4px" }}>יום מיוחד גובר על השעות הקבועות באותו תאריך. ימים מיוחדים של עובד מוגדרים בעמוד שלו.</p>
        {on ? <SpecialDays staffMemberId={null} onChanged={flash} /> : <Loading />}
      </div>
      {toast}
    </main>
  );
}

export { useLeaveGuard };
