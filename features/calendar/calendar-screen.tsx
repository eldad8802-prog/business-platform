"use client";

/**
 * "יומן" — the owner's calendar, design direction A (owner-approved 2026-11-02).
 *
 *   head      Dubiz's back control (when the owner came from somewhere), "יומן" and the period, the settings entry.
 *   date      ‹ היום › · the week strip (day view) · יום / שבוע / חודש · the staff filter and "הצגת מבוטלים".
 *   day       a real time grid on every size: a lane per staff member on a wide screen (inactive ones too while they
 *             still have appointments that day), one column for everyone on a phone; free / outside the hours /
 *             closed / blocked told apart; a tap on free time books there with the time and the lane filled in.
 *   week      the 7-day grid on a wide screen; on a phone the week's days as a list.
 *   month     each day's count and what is closed or different; a day opens its day view.
 *   actions   "קביעת תור" and — when the booking link is open or a request waits — "בקשות" with its count.
 *
 * The URL holds the picture (?view=&day=&staff=&canceled=&appointment=), so a link from the Secretary, a customer card
 * or a notification opens exactly it. Opening an appointment or a form adds a history entry, so the phone's back
 * closes it first; a form with unsaved changes asks before it is dropped (back, the backdrop, Escape or ✕). A drag to a
 * time outside the hours asks first, like the form does, and every drag can be put back from its message.
 * Everything goes through the milestone A API; behind the `appointments` flag (OFF → nothing is fetched).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { useBreakpoint } from "@/lib/ui/use-breakpoint";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { uuidV7 } from "@/lib/tasks/tasks-client";
import { addCalendarDays } from "@/lib/utils/jerusalem-day";

import { AppointmentDetails } from "./appointment-details";
import { AppointmentForm, MoveForm, type FormDone, type Prefill } from "./appointment-form";
import { CalendarApiError, customerName, forgetIntent, moveAppointment, pendingRequestCount, type CustomerWire } from "./calendar-client";
import {
  availabilityWarning,
  BLOCK_CONFLICT_TEXT,
  byDay,
  dayLanes,
  dayShort,
  durationOf,
  errorText,
  instantAt,
  isTerminal,
  shiftAnchor,
  todayKey,
  VIEW_LABEL,
  viewRange,
  viewTitle,
  weekStart,
  type AppointmentWire,
  type CalendarView,
  type DayKey,
} from "./calendar-model";
import { DayStrip, Legend, MonthGrid, TimeGrid, WeekList, dayColumns, type Column, type DropTarget } from "./calendar-views";
import { RequestsView } from "./requests-view";
import { Chevron, Empty, FeatureOff, IconCalendar, IconGear, IconPlus, LeaveConfirm, Loading, LoadError, ScreenHead, useToast } from "./ui";
import { useCalendarData } from "./use-calendar-data";
import s from "./calendar.module.css";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS: CalendarView[] = ["day", "week", "month"];

export function CalendarScreen() {
  const on = useFeatureState("appointments");
  if (on === null) return <main className={s.screen}><Loading label="טוען את היומן" /></main>;
  if (!on) return <FeatureOff title="יומן" />;
  return <CalendarBody />;
}

type Sheet = { kind: "create"; prefill: Prefill } | { kind: "move"; appt: AppointmentWire };

function CalendarBody() {
  const bp = useBreakpoint();
  const phone = bp === "mobile";
  const router = useRouter();
  const params = useSearchParams();
  const [now, setNow] = useState(() => new Date());
  const today = todayKey(now);

  const urlView = params?.get("view");
  const showRequests = urlView === "requests";
  const view: CalendarView = VIEWS.includes(urlView as CalendarView) ? (urlView as CalendarView) : "day";
  const requestParam = Number(params?.get("request"));
  const focusRequest = Number.isInteger(requestParam) && requestParam > 0 ? requestParam : null;
  const requestActionParam = params?.get("requestAction");
  const focusAction = requestActionParam === "approve" || requestActionParam === "decline" ? requestActionParam : null;
  const urlDay = params?.get("day");
  const anchor: DayKey = urlDay && DAY_RE.test(urlDay) ? urlDay : today;
  const staffParam = params?.get("staff");
  const staffFilter: number | "none" | null = staffParam === "none" ? "none" : staffParam && /^\d+$/.test(staffParam) ? Number(staffParam) : null;
  const showCanceled = params?.get("canceled") === "1";
  const selectedParam = Number(params?.get("appointment"));
  const selectedId = Number.isInteger(selectedParam) && selectedParam > 0 ? selectedParam : null;
  const sheetParam = params?.get("sheet") === "1";

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [askLeave, setAskLeave] = useState(false);
  const dirty = useRef(false);
  const pushedDetail = useRef(false);
  const [pendingDrop, setPendingDrop] = useState<{ appt: AppointmentWire; target: DropTarget; warning: string } | null>(null);
  const { flash, node: toast } = useToast();

  // How many booking-link requests wait, and whether Dubiz has opened booking for the business. Until then the
  // calendar shows no requests entry (something customers cannot use yet), unless a request still waits.
  const [pendingCount, setPendingCount] = useState(0);
  const [bookingOpen, setBookingOpen] = useState(false);
  const refreshPending = useCallback(() => {
    pendingRequestCount().then((r) => { setPendingCount(r.pending); setBookingOpen(r.open === true); }).catch(() => undefined);
  }, []);
  const showBookingEntry = bookingOpen || pendingCount > 0 || showRequests;
  useEffect(() => {
    refreshPending();
    const h = window.setInterval(refreshPending, 60_000);
    return () => window.clearInterval(h);
  }, [refreshPending]);

  // The day view reads its week, so the strip can count every day.
  const dataView: CalendarView = view === "month" ? "month" : "week";
  const range = useMemo(() => viewRange(dataView, anchor), [dataView, anchor]);
  const data = useCalendarData(range, { includeCanceled: showCanceled });

  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(h);
  }, []);

  const urlWith = useCallback((patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const qs = q.toString();
    return qs ? `/calendar?${qs}` : "/calendar";
  }, [params]);
  const setUrl = useCallback((patch: Record<string, string | null>) => router.replace(urlWith(patch), { scroll: false }), [router, urlWith]);

  // ── sheets: a history entry each, so "back" closes them; unsaved changes ask first ──
  const openSheet = useCallback((next: Sheet) => {
    dirty.current = false;
    setAskLeave(false);
    setSheet(next);
    if (!sheetParam) router.push(urlWith({ sheet: "1" }), { scroll: false });
  }, [router, sheetParam, urlWith]);
  const closeSheet = useCallback(() => {
    dirty.current = false;
    setAskLeave(false);
    setSheet(null);
    if (params?.get("sheet") === "1") router.back();
  }, [params, router]);
  const requestClose = useCallback(() => {
    if (dirty.current) setAskLeave(true);
    else closeSheet();
  }, [closeSheet]);
  useEffect(() => {
    if (sheetParam || !sheet) return;
    // "back" left the sheet's entry: close — or, with unsaved changes, stay and ask.
    if (dirty.current) {
      router.push(urlWith({ sheet: "1" }), { scroll: false });
      setAskLeave(true);
    } else {
      void Promise.resolve().then(() => setSheet(null));
    }
  }, [sheetParam, sheet, router, urlWith]);
  useEffect(() => {
    // A reload or a shared link with ?sheet=1 has no form behind it.
    if (sheetParam && !sheet) setUrl({ sheet: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = useCallback((id: number | null) => {
    if (id === null) {
      if (pushedDetail.current) { pushedDetail.current = false; router.back(); }
      else setUrl({ appointment: null });
      return;
    }
    if (selectedId === null) { pushedDetail.current = true; router.push(urlWith({ appointment: String(id) }), { scroll: false }); }
    else setUrl({ appointment: String(id) });
  }, [router, selectedId, setUrl, urlWith]);
  useEffect(() => { if (selectedId === null) pushedDetail.current = false; }, [selectedId]);

  // ?new=1[&customerId=] — "קביעת תור" from a customer card or from "+". Opened once, then cleaned.
  useEffect(() => {
    if (params?.get("new") !== "1") return;
    const cid = Number(params.get("customerId"));
    const open = (customer: CustomerWire | null) => openSheet({ kind: "create", prefill: { day: anchor < today ? today : anchor, customer } });
    router.replace(urlWith({ new: null, customerId: null }), { scroll: false });
    if (Number.isInteger(cid) && cid > 0) {
      customerName(cid).then((c) => { data.rememberCustomer(c.id, c.name); open(c); }).catch(() => open(null));
    } else {
      void Promise.resolve().then(() => open(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const all = useMemo(() => (data.appointments.status === "ready" ? data.appointments.value : []), [data.appointments]);
  const appointments = useMemo(() => {
    if (staffFilter === null) return all;
    return all.filter((a) => (staffFilter === "none" ? a.staffMemberId === null : a.staffMemberId === staffFilter));
  }, [all, staffFilter]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addCalendarDays(weekStart(anchor), i)), [anchor]);
  const filterLane: number | null | undefined = staffFilter === null ? undefined : staffFilter === "none" ? null : staffFilter;

  const columns: Column[] = useMemo(() => {
    if (view === "week") return dayColumns(weekDays, today, dayShort);
    if (!phone && staffFilter === null && data.staff.length) {
      const lanes = dayLanes(data.staff, byDay(all).get(anchor) ?? []);
      return lanes.map((l) => ({ key: l.key, day: anchor, staffMemberId: l.staffMemberId, label: l.label, color: l.color, today: anchor === today, inactive: l.inactive }));
    }
    const label = filterLane === undefined ? "כולם" : filterLane === null ? "ללא עובד" : data.staff.find((m) => m.id === filterLane)?.displayName ?? "עובד";
    return [{ key: `d${anchor}`, day: anchor, staffMemberId: filterLane, label, today: anchor === today }];
  }, [view, weekDays, today, phone, staffFilter, data.staff, all, anchor, filterLane]);

  const doMove = async (appt: AppointmentWire, target: DropTarget) => {
    const intent = `appt:drag:${appt.id}:${appt.version}:${uuidV7()}`;
    const staffChange = target.staffMemberId !== undefined && target.staffMemberId !== appt.staffMemberId;
    try {
      const out = await moveAppointment(intent, appt.id, {
        startsAt: instantAt(target.day, target.minute).toISOString(),
        ...(staffChange ? { staffMemberId: target.staffMemberId as number | null } : {}),
        expectedVersion: appt.version,
      });
      await data.reload();
      // "החזרה למקום": an ordinary move back (journalled like any move), from the version this move produced — refused
      // with VERSION_CONFLICT if the appointment changed again meanwhile, so it never overwrites a newer change.
      flash(out.warnings?.includes("OUTSIDE_AVAILABILITY") ? "הוזז — מחוץ לשעות הפעילות" : "התור הוזז", {
        label: "החזרה למקום",
        run: async () => {
          const back = `appt:undo:${appt.id}:${out.appointment.version}`;
          try {
            await moveAppointment(back, appt.id, {
              startsAt: appt.startsAt!,
              ...(staffChange ? { staffMemberId: appt.staffMemberId } : {}),
              expectedVersion: out.appointment.version,
            });
            await data.reload();
            flash("התור חזר למקומו");
          } catch (e) {
            forgetIntent(back);
            const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
            await data.reload();
            flash(err.code === "VERSION_CONFLICT" ? "התור השתנה בינתיים, ולכן לא הוחזר." : errorText(err.code, err.status));
          }
        },
      });
    } catch (e) {
      forgetIntent(intent);
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      flash(err.code === "SLOT_CONFLICT" && appt.kind === "BLOCK" ? BLOCK_CONFLICT_TEXT : errorText(err.code, err.status));
      await data.reload();
    }
  };

  // A drop on time that is not open asks first — the same rule and words as the form (the owner may still move it).
  const onDrop = (appt: AppointmentWire, target: DropTarget) => {
    const lane = target.staffMemberId === undefined ? appt.staffMemberId : target.staffMemberId;
    const warning = appt.kind === "BLOCK" ? null : availabilityWarning(data.availability, lane, target.day, target.minute, durationOf(appt) ?? 30, data.names);
    if (warning) setPendingDrop({ appt, target, warning });
    else void doMove(appt, target);
  };

  const formDone = async (out: FormDone, verb: string) => {
    closeSheet();
    await data.reload();
    const d = out.appointment.startsAt ? todayKey(new Date(out.appointment.startsAt)) : anchor;
    setUrl({ day: d, appointment: String(out.appointment.id), sheet: null });
    flash(out.warnings.includes("OUTSIDE_AVAILABILITY") ? `${verb} — מחוץ לשעות הפעילות` : verb);
  };

  const newAt = (prefill: Partial<Prefill> = {}) =>
    openSheet({ kind: "create", prefill: { day: anchor < today ? today : anchor, staffMemberId: typeof staffFilter === "number" ? staffFilter : null, ...prefill } });

  const details = selectedId !== null ? (
    <AppointmentDetails
      key={selectedId}
      id={selectedId}
      names={data.names}
      onChanged={(m) => { void data.reload(); flash(m); }}
      onMove={(a) => openSheet({ kind: "move", appt: a })}
      onRebook={(customer) => openSheet({ kind: "create", prefill: { day: today, customer } })}
      onClose={() => select(null)}
    />
  ) : null;

  const loadFailed = data.appointments.status === "error" ? data.appointments : null;
  // No weekly hours at all (the business's and every staff member's), known for sure — said once, with the way to set them.
  const readyNoHoursYet = data.availabilityReady && !data.problems.has("availability") && data.appointments.status === "ready"
    && data.hours.length === 0 && [...data.availability.staff.values()].every((x) => x.rules.length === 0);
  const problemWords = [data.problems.has("staff") ? "העובדים" : null, data.problems.has("services") ? "השירותים" : null, data.problems.has("availability") ? "שעות הפעילות" : null].filter(Boolean);

  const prevNext = (delta: number) => setUrl({ day: shiftAnchor(view, anchor, delta), appointment: null });
  const periodTitle = viewTitle(view, anchor);
  const dayCount = (byDay(appointments).get(anchor) ?? []).filter((a) => a.status !== "CANCELED" && a.kind !== "BLOCK").length;

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.calTop}>
        <ScreenHead
          root
          title="יומן"
          subtitle={<span aria-live="polite">{periodTitle}</span>}
          end={<Link href="/calendar/manage" prefetch={false} className={s.iconBtn} aria-label="ניהול היומן" title="ניהול היומן"><IconGear size={22} /></Link>}
        />

        <div className={s.dateNav}>
          <button type="button" className={s.iconBtn} aria-label={view === "day" ? "היום הקודם" : view === "week" ? "השבוע הקודם" : "החודש הקודם"} onClick={() => prevNext(-1)}><Chevron dir="prev" /></button>
          <button type="button" className={`${s.btn} ${s.today}`} onClick={() => setUrl({ day: today, appointment: null })} aria-current={anchor === today ? "date" : undefined}>היום</button>
          <button type="button" className={s.iconBtn} aria-label={view === "day" ? "היום הבא" : view === "week" ? "השבוע הבא" : "החודש הבא"} onClick={() => prevNext(1)}><Chevron dir="next" /></button>
        </div>

        {view === "day" && !showRequests ? (
          <DayStrip days={weekDays} day={anchor} today={today} appointments={appointments} availability={data.availability} names={data.names} onDay={(d) => setUrl({ day: d, appointment: null })} />
        ) : null}

        <div className={s.calBar}>
          <div className={s.tabs} role="tablist" aria-label="תצוגה">
            {VIEWS.map((v) => (
              <button key={v} type="button" role="tab" className={s.tab} aria-selected={!showRequests && view === v} onClick={() => setUrl({ view: v, request: null, requestAction: null })}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          {!showRequests ? (
            <div className={s.filter}>
              {data.staff.length ? (
                <select className={s.filterSelect} aria-label="סינון לפי עובד" value={staffFilter === null ? "" : String(staffFilter)} onChange={(e) => setUrl({ staff: e.target.value || null })}>
                  <option value="">כל הצוות</option>
                  <option value="none">ללא עובד</option>
                  {data.staff.map((x) => <option key={x.id} value={x.id}>{x.displayName}{x.active ? "" : " (לא פעיל)"}</option>)}
                </select>
              ) : null}
              <label className={s.toggleLine}>
                <input type="checkbox" checked={showCanceled} onChange={(e) => setUrl({ canceled: e.target.checked ? "1" : null })} />
                הצגת מבוטלים
              </label>
            </div>
          ) : null}
        </div>
      </div>

      {loadFailed ? (
        <LoadError text={loadFailed.httpStatus === 404 ? "היומן אינו פעיל לעסק." : `לא הצלחתי לטעון את התורים. ${errorText(loadFailed.code, loadFailed.httpStatus)}`} onRetry={data.retry} />
      ) : null}
      {problemWords.length && !loadFailed ? (
        <LoadError text={`לא הצלחתי לטעון את ${problemWords.join(", ")}. מה שמוצג עשוי להיות חלקי.`} onRetry={data.retry} />
      ) : null}
      {readyNoHoursYet && !showRequests ? (
        <div className={`${s.banner} ${s.bannerInfo}`} role="note">
          <span className={s.bannerText}>
            <strong>עוד לא הוגדרו שעות פעילות.</strong>
            <span>בלי שעות היומן לא יודע מתי העסק פתוח, ולכן לא מציע שעות פנויות. אפשר לקבוע תורים בכל שעה.</span>
          </span>
          <Link href="/calendar/hours" prefetch={false} className={`${s.btn} ${s.btnSm} ${s.btnSoft}`}>הגדרת שעות</Link>
        </div>
      ) : null}

      <div className={s.cols}>
        <div className={s.main}>
          {showRequests ? (
            <RequestsView
              focusId={focusRequest}
              focusAction={focusAction}
              onOpen={(d, id) => setUrl({ view: "day", day: d, appointment: String(id), request: null, requestAction: null })}
              onChanged={() => { refreshPending(); void data.reload(); }}
              flash={flash}
            />
          ) : null}
          {!showRequests && data.appointments.status === "loading" ? <Loading label="טוען את היומן" rows={6} /> : null}
          {!showRequests && data.appointments.status === "ready" ? (
            <>
              {view === "month" ? (
                <MonthGrid anchor={anchor} appointments={appointments} names={data.names} availability={data.availability} today={today} compact={phone} onDay={(d) => setUrl({ view: "day", day: d })} />
              ) : view === "week" && phone ? (
                <WeekList days={weekDays} today={today} appointments={appointments} names={data.names} availability={data.availability} onDay={(d) => setUrl({ view: "day", day: d })} onSelect={select} />
              ) : (
                <>
                  {view === "day" && dayCount === 0 && !(byDay(appointments).get(anchor) ?? []).length ? (
                    <p className={s.note}>{anchor === today ? "אין תורים היום." : "אין תורים ביום הזה."} נגיעה בשעה פנויה קובעת בה תור.</p>
                  ) : null}
                  <TimeGrid
                    columns={columns}
                    appointments={appointments}
                    names={data.names}
                    hours={data.hours}
                    availability={data.availability}
                    now={now}
                    selectedId={selectedId}
                    canDrag={!phone}
                    onSelect={select}
                    onCreateAt={(target) => newAt({ day: target.day, minute: target.minute, staffMemberId: target.staffMemberId === undefined ? (typeof staffFilter === "number" ? staffFilter : null) : target.staffMemberId })}
                    onDrop={onDrop}
                    onHeadClick={view === "week" ? (d) => setUrl({ view: "day", day: d }) : undefined}
                  />
                </>
              )}
              <Legend />
            </>
          ) : null}
          {data.appointments.status === "ready" && !showRequests && all.length === 0 && view !== "day" && !data.staff.length && !loadFailed ? (
            <Empty title="אין עדיין תורים" icon={<IconCalendar size={32} />}>
              <span>אפשר לקבוע תור ראשון, או להגדיר שעות, צוות ושירותים ב„ניהול היומן”.</span>
            </Empty>
          ) : null}

          <div className={s.calActions}>
            <button type="button" className={`${s.btn} ${s.btnPri}`} onClick={() => newAt()}><IconPlus size={20} /> קביעת תור</button>
            {showBookingEntry ? (
              showRequests ? (
                <button type="button" className={s.btn} onClick={() => setUrl({ view: "day", request: null, requestAction: null })}><IconCalendar size={20} /> חזרה ליומן</button>
              ) : (
                <button type="button" className={s.btn} onClick={() => setUrl({ view: "requests", appointment: null })} aria-label={pendingCount ? `בקשות · ${pendingCount} ממתינות` : "בקשות"}>
                  בקשות{pendingCount ? <span className={s.badge} aria-hidden="true">{pendingCount}</span> : null}
                </button>
              )
            ) : null}
          </div>
        </div>

        <aside className={s.side} aria-label="פרטי התור">
          {bp === "desktop" ? details ?? (
            <div className={s.placeholder}>
              <span>בוחרים תור ביומן כדי לראות את פרטיו, או נוגעים בשעה פנויה כדי לקבוע בה.</span>
              <button type="button" className={`${s.btn} ${s.btnSoft}`} onClick={() => newAt()}><IconPlus size={18} /> קביעת תור</button>
            </div>
          ) : null}
        </aside>
      </div>

      <AdaptiveOverlay className={s.theme} open={bp !== "desktop" && selectedId !== null && !sheet} onClose={() => select(null)} labelledBy="appointment-details-title">
        {bp !== "desktop" ? details : null}
      </AdaptiveOverlay>

      <AdaptiveOverlay className={s.theme} open={!!sheet} onClose={requestClose} labelledBy="appointment-form-title">
        {askLeave ? <LeaveConfirm onStay={() => setAskLeave(false)} onLeave={closeSheet} /> : null}
        {sheet?.kind === "create" ? (
          <AppointmentForm
            key={`${sheet.prefill.day}:${sheet.prefill.minute ?? ""}:${sheet.prefill.staffMemberId ?? ""}:${sheet.prefill.customer?.id ?? ""}`}
            prefill={sheet.prefill}
            staff={data.staff}
            services={data.services}
            names={data.names}
            availability={data.availability}
            onCustomer={(c) => data.rememberCustomer(c.id, c.name)}
            onDirty={(d) => { dirty.current = d; }}
            onDone={(out) => void formDone(out, out.appointment.kind === "BLOCK" ? "הזמן נחסם" : out.appointment.kind === "INTERNAL" ? "הפגישה נקבעה" : "התור נקבע")}
            onCancel={requestClose}
          />
        ) : null}
        {sheet?.kind === "move" && !isTerminal(sheet.appt.status) ? (
          <MoveForm
            appt={sheet.appt}
            staff={data.staff}
            names={data.names}
            availability={data.availability}
            onDirty={(d) => { dirty.current = d; }}
            onDone={(out) => void formDone(out, "המועד שונה")}
            onCancel={requestClose}
          />
        ) : null}
      </AdaptiveOverlay>

      <AdaptiveOverlay className={s.theme} variant="confirm" open={!!pendingDrop} onClose={() => setPendingDrop(null)} labelledBy="drop-q">
        {pendingDrop ? (
          <div className={s.sheet}>
            <h2 id="drop-q" className={s.detTitle} style={{ fontSize: 19 }}>להזיז לשעה שאינה פנויה?</h2>
            <div className={s.warnBox}><span>{pendingDrop.warning}</span></div>
            <div className={s.confirmRow}>
              <button type="button" className={`${s.btn} ${s.btnPri}`} onClick={() => { const p = pendingDrop; setPendingDrop(null); void doMove(p.appt, p.target); }}>להזיז בכל זאת</button>
              <button type="button" className={s.btn} autoFocus onClick={() => setPendingDrop(null)}>להשאיר במקום</button>
            </div>
          </div>
        ) : null}
      </AdaptiveOverlay>

      {toast}
    </main>
  );
}
