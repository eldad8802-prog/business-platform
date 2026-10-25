"use client";

/**
 * The hub calendar: tasks and commitment dates on one month. Each kind keeps its own mark and its own words —
 * a task, a payment still due, a payment the ledger shows as paid, an item handled without a recorded payment,
 * and a forecast — so a forecast never reads as paid and "טופל" never reads as "שולם".
 *
 * Days are buttons; the chosen day lists its items below the grid with the kind in words (colour is never the
 * only signal). Arrow keys move between days.
 */

import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatMoney } from "@/lib/ui/money";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { CALENDAR_KIND_LABEL, eventsByDay, monthGrid, shiftMonth, type CalendarEvent, type CalendarKind } from "./secretary-hub-model";
import s from "./secretary-hub.module.css";

const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const KIND_CLASS: Record<CalendarKind, string> = { TASK: s.kTask, DUE: s.kDue, PAID: s.kPaid, HANDLED: s.kHandled, PROJECTED: s.kProjected, APPOINTMENT: s.kAppt };
const KINDS: CalendarKind[] = ["APPOINTMENT", "TASK", "DUE", "PAID", "HANDLED", "PROJECTED"];

function monthTitle(year: number, month: number): string {
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 15)));
}

function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

const DAY_KEY = /^d{4}-d{2}-d{2}$/;

export function SecretaryCalendar({ events, notes, loading, initialDay, title = "לוח שנה" }: { events: CalendarEvent[]; notes: string[]; loading: boolean; initialDay?: string | null; title?: string }) {
  const today = jerusalemDayKey(new Date());
  const start = initialDay && DAY_KEY.test(initialDay) ? initialDay : today;
  const [sy, sm] = start.split("-").map(Number);
  const [view, setView] = useState({ year: sy, month: sm });
  const [selected, setSelected] = useState<string>(start);
  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const gridRef = useRef<HTMLDivElement>(null);
  const chosen = byDay.get(selected) ?? [];

  const move = (delta: number) => {
    setView((v) => shiftMonth(v.year, v.month, delta));
  };

  const focusDay = (day: string) => {
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus());
  };

  const onKey = (e: KeyboardEvent, day: string) => {
    const step = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : e.key === "ArrowDown" ? 7 : e.key === "ArrowUp" ? -7 : 0;
    if (!step) return;
    e.preventDefault();
    const [y, m, d] = day.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + step));
    const key = next.toISOString().slice(0, 10);
    const ny = next.getUTCFullYear();
    const nm = next.getUTCMonth() + 1;
    if (ny !== view.year || nm !== view.month) setView({ year: ny, month: nm });
    setSelected(key);
    focusDay(key);
  };

  return (
    <section className={s.card} aria-labelledby="hub-calendar-title">
      <div className={s.calHead}>
        <h2 id="hub-calendar-title" className={s.cardTitle}>{title}</h2>
        <div className={s.calNav}>
          <button type="button" className={s.navBtn} onClick={() => move(-1)} aria-label="החודש הקודם">
            <Chevron dir="prev" />
          </button>
          <span className={s.calMonth} aria-live="polite">{monthTitle(view.year, view.month)}</span>
          <button type="button" className={s.navBtn} onClick={() => move(1)} aria-label="החודש הבא">
            <Chevron dir="next" />
          </button>
        </div>
      </div>

      <div className={s.grid} ref={gridRef} role="grid" aria-labelledby="hub-calendar-title" aria-busy={loading || undefined}>
        <div className={s.weekRow} role="row">
          {WEEKDAYS.map((w) => (
            <span key={w} className={s.weekday} role="columnheader">{w}</span>
          ))}
        </div>
        {grid.map((week, i) => (
          <div key={i} className={s.weekRow} role="row">
            {week.map((day, j) => {
              if (!day) return <span key={j} className={s.blank} role="gridcell" />;
              const list = byDay.get(day) ?? [];
              const kinds = KINDS.filter((k) => list.some((e) => e.kind === k));
              const label = `${longDay(day)}${list.length ? ` · ${kinds.map((k) => `${CALENDAR_KIND_LABEL[k]} ${list.filter((e) => e.kind === k).length}`).join(", ")}` : ""}`;
              return (
                <span key={day} role="gridcell" aria-selected={day === selected}>
                  <button
                    type="button"
                    data-day={day}
                    className={[s.day, day === today && s.today, day === selected && s.selected, day < today && s.past].filter(Boolean).join(" ")}
                    tabIndex={day === selected ? 0 : -1}
                    aria-label={label}
                    aria-current={day === today ? "date" : undefined}
                    onClick={() => setSelected(day)}
                    onKeyDown={(e) => onKey(e, day)}
                  >
                    <span className={s.dayNum}>{Number(day.slice(8))}</span>
                    {kinds.length ? (
                      <span className={s.marks} aria-hidden="true">
                        {kinds.slice(0, 4).map((k) => (
                          <span key={k} className={`${s.mark} ${KIND_CLASS[k]}`} />
                        ))}
                      </span>
                    ) : null}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>

      <div className={s.dayPanel} aria-live="polite">
        <h3 className={s.dayTitle}>{selected === today ? `היום · ${longDay(selected)}` : longDay(selected)}</h3>
        {chosen.length === 0 ? (
          <p className={s.muted}>{loading ? "טוען…" : "אין ביום הזה משימה או מועד תשלום."}</p>
        ) : (
          <ul className={s.dayList}>
            {chosen.map((e) => (
              <li key={e.key} className={s.dayItem}>
                <span className={`${s.mark} ${KIND_CLASS[e.kind]}`} aria-hidden="true" />
                <span className={s.dayItemMain}>
                  {e.href ? <Link href={e.href} className={s.dayItemTitle}>{e.title}</Link> : <span className={s.dayItemTitle}>{e.title}</span>}
                  <span className={s.kindLabel}>{CALENDAR_KIND_LABEL[e.kind]}</span>
                </span>
                {e.amount ? <bdi className={s.dayAmount}>{formatMoney(e.amount, e.currency)}</bdi> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ul className={s.legend} aria-label="מקרא">
        {KINDS.map((k) => (
          <li key={k}>
            <span className={`${s.mark} ${KIND_CLASS[k]}`} aria-hidden="true" />
            {CALENDAR_KIND_LABEL[k]}
          </li>
        ))}
      </ul>
      {notes.length ? (
        <ul className={s.notes}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Chevron({ dir }: { dir: "prev" | "next" }) {
  // RTL: "previous" points right, "next" points left.
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "prev" ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
    </svg>
  );
}

/**
 * What the week strip tells apart (owner-approved mockup): a task, an open commitment date, an open commitment
 * whose date has passed ("תשלום באיחור" — open and past due, the same rule as the briefing's OVERDUE), and,
 * when they fall in the week, paid / handled-without-payment / forecast. Nothing here changes a status.
 */
type WeekKind = "APPOINTMENT" | "TASK" | "DUE" | "LATE" | "PAID" | "HANDLED" | "PROJECTED";
const WEEK_KINDS: WeekKind[] = ["APPOINTMENT", "TASK", "DUE", "LATE", "PAID", "HANDLED", "PROJECTED"];
const WEEK_LABEL: Record<WeekKind, string> = {
  APPOINTMENT: "תור",
  TASK: "משימה",
  DUE: "התחייבות",
  LATE: "תשלום באיחור",
  PAID: "שולם",
  HANDLED: "טופל, לא נרשם תשלום",
  PROJECTED: "תחזית",
};
const WEEK_CLASS: Record<WeekKind, string> = { APPOINTMENT: s.kAppt, TASK: s.wTask, DUE: s.wDue, LATE: s.wLate, PAID: s.kPaid, HANDLED: s.kHandled, PROJECTED: s.kProjected };
/** Always in the legend, as in the mockup; the others only when they fall in this week. */
const WEEK_ALWAYS = new Set<WeekKind>(["TASK", "DUE", "LATE"]);

const weekKind = (e: CalendarEvent, today: string): WeekKind => (e.kind === "DUE" && e.day < today ? "LATE" : e.kind);

/**
 * The week strip on the main screen ("לוח השבוע"): Sunday to Saturday of this week, today marked, each day with
 * the marks of what falls on it. A day opens the full month at that day; "היום" opens it at today.
 */
export function SecretaryWeek({ events, loading, failed }: { events: CalendarEvent[]; loading: boolean; failed: boolean }) {
  const today = jerusalemDayKey(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const sunday = new Date(Date.UTC(y, m - 1, d));
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const days = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(sunday);
    x.setUTCDate(sunday.getUTCDate() + i);
    return x.toISOString().slice(0, 10);
  });
  const byDay = eventsByDay(events);
  const shown = new Set<WeekKind>(days.flatMap((day) => (byDay.get(day) ?? []).map((e) => weekKind(e, today))));
  const legend = WEEK_KINDS.filter((k) => WEEK_ALWAYS.has(k) || shown.has(k));

  return (
    <section className={s.card} aria-labelledby="hub-week-title" aria-busy={loading || undefined}>
      <div className={s.calHead}>
        <h2 id="hub-week-title" className={s.weekTitle}>
          <CalendarGlyph />
          לוח השבוע
        </h2>
        <Link href="/secretary?screen=calendar" className={s.fullLink}>
          לוח שנה מלא
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </Link>
      </div>
      <ol className={s.week}>
        {days.map((day, i) => {
          const list = (byDay.get(day) ?? []).map((e) => weekKind(e, today));
          const kinds = WEEK_KINDS.filter((k) => list.includes(k));
          const label = `${longDay(day)}${list.length ? ` · ${kinds.map((k) => `${WEEK_LABEL[k]} ${list.filter((x) => x === k).length}`).join(", ")}` : " · אין משימה או מועד תשלום"}`;
          return (
            <li key={day}>
              <Link
                href={`/secretary?screen=calendar&day=${day}`}
                className={[s.weekDay, day === today && s.weekToday].filter(Boolean).join(" ")}
                aria-label={label}
                aria-current={day === today ? "date" : undefined}
              >
                <span className={s.weekName} aria-hidden="true">{WEEKDAYS[i]}</span>
                <span className={s.weekNum} aria-hidden="true">{Number(day.slice(8))}</span>
                <span className={s.marks} aria-hidden="true">
                  {kinds.slice(0, 3).map((k) => (
                    <span key={k} className={`${s.mark} ${WEEK_CLASS[k]}`} />
                  ))}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {failed ? <p className={s.muted}>לא הצלחתי לטעון את מועדי ההתחייבויות.</p> : null}
      <div className={s.weekFoot}>
        <ul className={s.weekLegend} aria-label="מקרא">
          {legend.map((k) => (
            <li key={k}>
              <span className={`${s.mark} ${WEEK_CLASS[k]}`} aria-hidden="true" />
              {WEEK_LABEL[k]}
            </li>
          ))}
        </ul>
        <Link href={`/secretary?screen=calendar&day=${today}`} className={s.todayChip}>
          <CalendarGlyph />
          היום
        </Link>
      </div>
    </section>
  );
}

function CalendarGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </svg>
  );
}
