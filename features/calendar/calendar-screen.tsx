"use client";

/**
 * "יומן ותורים" — the owner's calendar (Appointments milestone B, owner-approved plan).
 *
 *   desktop  week by default (day / week / month), a column per day — or per staff member in the day view — and the
 *            details panel beside the grid; drag an appointment to move it; click empty time to book there.
 *   tablet   the same grid; details and forms in a dialog.
 *   phone    the day's agenda under a strip of the week's days (month shows load dots); details and forms as bottom
 *            sheets; "תור חדש" stays in the header.
 *
 * The URL holds the picture (?view=&day=&staff=&appointment=), so a link — from the Secretary, a customer card or a
 * notification later — opens exactly it. Everything shown and changed goes through the milestone A API; the page is
 * behind the `appointments` flag: OFF, nothing is fetched and the screen says the calendar is not active.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { useBreakpoint } from "@/lib/ui/use-breakpoint";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { uuidV7 } from "@/lib/tasks/tasks-client";
import t from "@/features/tasks/tasks.module.css";

import { AppointmentDetails } from "./appointment-details";
import { AppointmentForm, MoveForm, type FormDone, type Prefill } from "./appointment-form";
import { CalendarApiError, customerName, forgetIntent, moveAppointment, type CustomerWire } from "./calendar-client";
import {
  errorText,
  instantAt,
  isTerminal,
  shiftAnchor,
  todayKey,
  viewRange,
  viewTitle,
  VIEW_LABEL,
  weekStart,
  type AppointmentWire,
  type CalendarView,
  type DayKey,
} from "./calendar-model";
import { MobileAgenda, MonthGrid, TimeGrid, dayColumns, type Column, type DropTarget } from "./calendar-views";
import { useCalendarData } from "./use-calendar-data";
import { addCalendarDays } from "@/lib/utils/jerusalem-day";
import s from "./calendar.module.css";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS: CalendarView[] = ["day", "week", "month"];

export function CalendarScreen() {
  const on = useFeatureState("appointments");
  if (on === null) return <main className={s.screen}><CalendarSkeleton /></main>;
  if (!on) return <CalendarOff />;
  return <CalendarBody />;
}

function CalendarBody() {
  const bp = useBreakpoint();
  const router = useRouter();
  const params = useSearchParams();
  const [now, setNow] = useState(() => new Date());
  const today = todayKey(now);

  const urlView = params?.get("view");
  const view: CalendarView = VIEWS.includes(urlView as CalendarView) ? (urlView as CalendarView) : bp === "mobile" ? "day" : "week";
  const urlDay = params?.get("day");
  const anchor: DayKey = urlDay && DAY_RE.test(urlDay) ? urlDay : today;
  const staffParam = params?.get("staff");
  const staffFilter: number | "none" | null = staffParam === "none" ? "none" : staffParam && /^\d+$/.test(staffParam) ? Number(staffParam) : null;
  const selectedParam = Number(params?.get("appointment"));
  const selectedId = Number.isInteger(selectedParam) && selectedParam > 0 ? selectedParam : null;

  const [creating, setCreating] = useState<Prefill | null>(null);
  const [moving, setMoving] = useState<AppointmentWire | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The last drag, undoable from its toast: where the appointment was, and the version the move produced.
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<void> } | null>(null);

  // The phone's week is the strip; its data is the whole week so the strip can count.
  const dataView: CalendarView = bp === "mobile" && view !== "month" ? "week" : view;
  const range = useMemo(() => viewRange(dataView, anchor), [dataView, anchor]);
  const data = useCalendarData(range);

  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(h);
  }, []);

  const setUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const q = new URLSearchParams(params?.toString() ?? "");
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      const qs = q.toString();
      router.replace(qs ? `/calendar?${qs}` : "/calendar", { scroll: false });
    },
    [params, router],
  );

  const flash = useCallback((text: string) => {
    setUndo(null);
    setToast(text);
    window.setTimeout(() => setToast((x) => (x === text ? null : x)), 6000);
  }, []);

  // ?new=1[&customerId=] — "קבע תור" from a customer card, "+" from the navigation. Opened once, then cleaned.
  useEffect(() => {
    if (params?.get("new") !== "1") return;
    const cid = Number(params.get("customerId"));
    const open = (customer: CustomerWire | null) => setCreating({ day: anchor, customer });
    if (Number.isInteger(cid) && cid > 0) {
      customerName(cid).then((c) => { data.rememberCustomer(c.id, c.name); open(c); }).catch(() => open(null));
    } else {
      void Promise.resolve().then(() => open(null));
    }
    setUrl({ new: null, customerId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const appointments = useMemo(() => {
    const list = data.appointments.status === "ready" ? data.appointments.value : [];
    if (staffFilter === null) return list;
    return list.filter((a) => (staffFilter === "none" ? a.staffMemberId === null : a.staffMemberId === staffFilter));
  }, [data.appointments, staffFilter]);

  const activeStaff = data.staff.filter((x) => x.active);

  const columns: Column[] = useMemo(() => {
    if (view === "week") return dayColumns(range.days, today, true);
    if (view === "day" && activeStaff.length && staffFilter === null) {
      return [
        { key: "biz", day: anchor, staffMemberId: null, label: "כללי", color: null, today: anchor === today },
        ...activeStaff.map((x) => ({ key: `s${x.id}`, day: anchor, staffMemberId: x.id, label: x.displayName, color: x.color, today: anchor === today })),
      ];
    }
    return dayColumns([anchor], today, false);
  }, [view, range.days, today, activeStaff, staffFilter, anchor]);

  const onDrop = async (appt: AppointmentWire, target: DropTarget) => {
    const intent = `appt:drag:${appt.id}:${appt.version}:${uuidV7()}`;
    const staffChange = target.staffMemberId !== undefined && target.staffMemberId !== appt.staffMemberId;
    try {
      const out = await moveAppointment(intent, appt.id, {
        startsAt: instantAt(target.day, target.minute).toISOString(),
        ...(staffChange ? { staffMemberId: target.staffMemberId as number | null } : {}),
        expectedVersion: appt.version,
      });
      await data.reload();
      flash(out.warnings?.includes("OUTSIDE_AVAILABILITY") ? "הוזז — מחוץ לשעות הפעילות" : "הוזז");
      // "ביטול": an ordinary move back (journalled like any move), from the version this move produced — refused
      // with VERSION_CONFLICT if the appointment changed again meanwhile, so it can never overwrite a newer change.
      setUndo({
        text: "ביטול",
        run: async () => {
          const back = `appt:undo:${appt.id}:${out.appointment.version}`;
          try {
            await moveAppointment(back, appt.id, {
              startsAt: appt.startsAt!,
              ...(staffChange ? { staffMemberId: appt.staffMemberId } : {}),
              expectedVersion: out.appointment.version,
            });
            await data.reload();
            flash("ההזזה בוטלה — התור חזר למקומו");
          } catch (e) {
            forgetIntent(back);
            const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
            await data.reload();
            flash(err.code === "VERSION_CONFLICT" ? "התור השתנה בינתיים, ולכן ההזזה לא בוטלה." : errorText(err.code, err.status));
          }
        },
      });
    } catch (e) {
      forgetIntent(intent);
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      flash(errorText(err.code, err.status));
      await data.reload();
    }
  };

  const formDone = async (out: FormDone, verb: string) => {
    setCreating(null);
    setMoving(null);
    await data.reload();
    const d = out.appointment.startsAt ? todayKey(new Date(out.appointment.startsAt)) : anchor;
    setUrl({ day: d, appointment: String(out.appointment.id) });
    flash(out.warnings.includes("OUTSIDE_AVAILABILITY") ? `${verb} — מחוץ לשעות הפעילות` : verb);
  };

  const select = (id: number | null) => setUrl({ appointment: id === null ? null : String(id) });

  const details = selectedId !== null ? (
    <AppointmentDetails
      key={selectedId}
      id={selectedId}
      names={data.names}
      onChanged={(m) => { void data.reload(); flash(m); }}
      onMove={(a) => setMoving(a)}
      onClose={() => select(null)}
    />
  ) : null;

  const loadFailed = data.appointments.status === "error" ? data.appointments : null;
  const hasStaff = data.staff.length > 0;

  return (
    <main className={s.screen} data-page-intent="content">
      <header className={s.top}>
        <h1 className={s.title}>יומן ותורים</h1>
        <span className={s.grow} />
        <div className={s.links}>
          <Link href="/calendar/staff" prefetch={false} className={`${t.btn} ${t.ghost}`}>עובדים וזמינות</Link>
          <Link href="/calendar/services" prefetch={false} className={`${t.btn} ${t.ghost}`}>שירותים</Link>
        </div>
        <button type="button" className={`${t.btn} ${t.pri} ${t.newBtn}`} onClick={() => setCreating({ day: anchor })}>
          <PlusIcon /> תור חדש
        </button>
      </header>

      <div className={s.bar}>
        <div className={s.nav}>
          <button type="button" className={s.navBtn} aria-label="הקודם" onClick={() => setUrl({ day: shiftAnchor(dataView === "week" && bp === "mobile" ? "week" : view, anchor, -1) })}><Chevron dir="prev" /></button>
          <button type="button" className={t.btn} onClick={() => setUrl({ day: today })}>היום</button>
          <button type="button" className={s.navBtn} aria-label="הבא" onClick={() => setUrl({ day: shiftAnchor(dataView === "week" && bp === "mobile" ? "week" : view, anchor, 1) })}><Chevron dir="next" /></button>
        </div>
        <span className={s.period} aria-live="polite">{viewTitle(bp === "mobile" && view !== "month" ? "week" : view, anchor)}</span>
        <span className={s.grow} />
        {hasStaff ? (
          <select
            className={s.select}
            aria-label="סינון לפי עובד"
            value={staffFilter === null ? "" : String(staffFilter)}
            onChange={(e) => setUrl({ staff: e.target.value || null })}
          >
            <option value="">כל העובדים</option>
            <option value="none">ללא עובד</option>
            {data.staff.map((x) => <option key={x.id} value={x.id}>{x.displayName}{x.active ? "" : " (לא פעיל)"}</option>)}
          </select>
        ) : null}
        <div className={s.seg} role="tablist" aria-label="תצוגה">
          {VIEWS.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? s.segOn : ""} onClick={() => setUrl({ view: v })}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      {loadFailed ? (
        <div className={`${t.banner} ${t.bannerBad}`} role="alert">
          <span>{loadFailed.httpStatus === 404 ? "היומן אינו פעיל לעסק." : errorText(loadFailed.code, loadFailed.httpStatus)}</span>
          <span className={t.grow} />
          <button type="button" className={t.btn} onClick={() => void data.reload()}>נסה שוב</button>
        </div>
      ) : null}

      <div className={s.cols}>
        <div className={s.main}>
          {data.appointments.status === "loading" ? <CalendarSkeleton /> : null}
          {data.appointments.status === "ready" ? (
            view === "month" ? (
              <MonthGrid
                anchor={anchor}
                appointments={appointments}
                names={data.names}
                availability={data.availability}
                today={today}
                compact={bp === "mobile"}
                onDay={(d) => setUrl({ view: "day", day: d })}
              />
            ) : bp === "mobile" ? (
              <MobileAgenda
                days={Array.from({ length: 7 }, (_, i) => addCalendarDays(weekStart(anchor), i))}
                day={anchor}
                today={today}
                appointments={appointments}
                names={data.names}
                availability={data.availability}
                onDay={(d) => setUrl({ day: d })}
                onSelect={(id) => select(id)}
                onNew={() => setCreating({ day: anchor })}
              />
            ) : (
              <TimeGrid
                columns={columns}
                appointments={appointments}
                names={data.names}
                hours={data.hours}
                availability={data.availability}
                now={now}
                selectedId={selectedId}
                canDrag
                onSelect={(id) => select(id)}
                onCreateAt={(target) => setCreating({ day: target.day, minute: target.minute, staffMemberId: target.staffMemberId ?? null })}
                onDrop={(a, target) => void onDrop(a, target)}
                onHeadClick={view === "week" ? (d) => setUrl({ view: "day", day: d }) : undefined}
              />
            )
          ) : null}
          {data.appointments.status === "ready" && !hasStaff && !appointments.length ? (
            <p className={s.note}>
              טיפ: ב<Link href="/calendar/staff" prefetch={false}>עובדים וזמינות</Link> מגדירים שעות פעילות ועובדים, וב<Link href="/calendar/services" prefetch={false}>שירותים</Link> — מרווחים בין תורים. היומן מציע שעות פנויות לפיהם.
            </p>
          ) : null}
        </div>

        <aside className={s.detail} aria-label="פרטי התור">
          {bp === "desktop" ? details ?? (
            <div className={t.placeholder}>
              <span>בוחרים תור ביומן כדי לראות את הפרטים, או לוחצים על שעה פנויה כדי לקבוע.</span>
              <button type="button" className={`${t.btn} ${t.soft}`} onClick={() => setCreating({ day: anchor })}><PlusIcon /> תור חדש</button>
            </div>
          ) : null}
        </aside>
      </div>

      <AdaptiveOverlay open={bp !== "desktop" && selectedId !== null && !moving && !creating} onClose={() => select(null)} labelledBy="appointment-details-title">
        <div style={{ padding: bp === "mobile" ? "4px 2px 12px" : 0 }}>{bp !== "desktop" ? details : null}</div>
      </AdaptiveOverlay>
      <AdaptiveOverlay open={!!creating} onClose={() => setCreating(null)} labelledBy="appointment-form-title">
        {creating ? (
          <AppointmentForm
            key={`${creating.day}:${creating.minute ?? ""}:${creating.staffMemberId ?? ""}:${creating.customer?.id ?? ""}`}
            prefill={creating}
            staff={data.staff}
            services={data.services}
            names={data.names}
            onCustomer={(c) => data.rememberCustomer(c.id, c.name)}
            onDone={(out) => void formDone(out, out.appointment.kind === "BLOCK" ? "הזמן נחסם" : "נקבע")}
            onCancel={() => setCreating(null)}
          />
        ) : null}
      </AdaptiveOverlay>
      <AdaptiveOverlay open={!!moving} onClose={() => setMoving(null)} labelledBy="appointment-form-title">
        {moving && !isTerminal(moving.status) ? (
          <MoveForm appt={moving} staff={data.staff} onDone={(out) => void formDone(out, "הוזז")} onCancel={() => setMoving(null)} />
        ) : null}
      </AdaptiveOverlay>

      {toast ? (
        <div className={t.toast} role="status">
          <span>{toast}</span>
          {undo ? <button type="button" onClick={() => { const u = undo; setUndo(null); void u.run(); }}>{undo.text}</button> : null}
        </div>
      ) : null}
    </main>
  );
}

function CalendarOff() {
  return (
    <main className={s.screen}>
      <header className={s.top}><h1 className={s.title}>יומן ותורים</h1></header>
      <section className={s.empty}>
        <span className={s.ring} aria-hidden="true"><CalendarGlyph /></span>
        <h2>היומן עדיין לא פעיל לעסק שלך</h2>
        <span>כשהיומן ייפתח, יופיע כאן לוח התורים והפגישות של העסק.</span>
        <Link href="/" prefetch={false} className={t.btn}>חזרה לבית</Link>
      </section>
    </main>
  );
}

function CalendarSkeleton() {
  return (
    <section className={t.bucket} aria-busy="true" aria-label="טוען את היומן">
      <div className={t.rows}>
        {[80, 62, 70, 54, 66, 58].map((w, i) => (
          <div key={i} className={t.skel}><span className={t.bar} style={{ width: `${w}%` }} /></div>
        ))}
      </div>
    </section>
  );
}

function PlusIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function Chevron({ dir }: { dir: "prev" | "next" }) {
  // RTL: "previous" points right, "next" points left.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "prev" ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function CalendarGlyph() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
}
