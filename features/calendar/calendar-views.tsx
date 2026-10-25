"use client";

/**
 * The calendar's three pictures (Appointments milestone B):
 *   TimeGrid      day and week — hour rows, one column per day (week) or per staff lane (day, when there is staff);
 *                 closed time shaded from the business's weekly hours; a red line at "now"; a click on empty time
 *                 books there; on a pointer device an appointment is dragged to another time / day / lane (15-minute
 *                 steps) and dropped as a move the server checks.
 *   MonthGrid     the month's days with their first appointments; a day opens the day view.
 *   MobileAgenda  the phone: a scrolling strip of days and the chosen day's appointments as cards.
 * Colour is never the only signal: every block names its time, its title, and its state in words for readers.
 */
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { addCalendarDays } from "@/lib/utils/jerusalem-day";
import t from "@/features/tasks/tasks.module.css";

import {
  byDay,
  clock,
  dayNumber,
  dayShort,
  dayTitle,
  durationOf,
  gridHours,
  headline,
  isTerminal,
  isTimed,
  KIND_LABEL,
  layoutDay,
  minuteInDay,
  monthOf,
  snap,
  STATUS_LABEL,
  staffColor,
  timeLabel,
  WEEKDAY_LETTER,
  weekdayOfDay,
  type AppointmentWire,
  type DayKey,
  type Names,
  type Placed,
  type WeekWindow,
} from "./calendar-model";
import s from "./calendar.module.css";

const HOUR_PX = 56;

export type Column = { key: string; day: DayKey; staffMemberId: number | null | undefined; label: string; color?: string | null; today: boolean };

export type DropTarget = { day: DayKey; staffMemberId: number | null | undefined; minute: number };

const laneStyle = (color: string): CSSProperties => ({ ["--lane" as string]: color });

function blockClass(a: AppointmentWire, selected: boolean, dragging: boolean): string {
  return [
    s.block,
    a.kind === "BLOCK" ? s.blockBlock : a.kind === "INTERNAL" ? s.blockInternal : "",
    a.status === "PROPOSED" ? s.blockProposed : "",
    isTerminal(a.status) ? s.blockDone : "",
    selected ? s.blockSel : "",
    dragging ? s.dragging : "",
  ].filter(Boolean).join(" ");
}

function ariaFor(a: AppointmentWire, names: Names): string {
  const state = a.kind === "BLOCK" ? KIND_LABEL.BLOCK : STATUS_LABEL[a.status];
  return `${timeLabel(a)} · ${headline(a, names)} · ${state}`;
}

// ── Day / week ──────────────────────────────────────────────────────────────────────────────────

export function TimeGrid({
  columns,
  appointments,
  names,
  hours,
  now,
  selectedId,
  canDrag,
  onSelect,
  onCreateAt,
  onDrop,
  onHeadClick,
}: {
  columns: Column[];
  appointments: AppointmentWire[];
  names: Names;
  hours: WeekWindow[];
  now: Date;
  selectedId: number | null;
  canDrag: boolean;
  onSelect: (id: number) => void;
  onCreateAt: (target: DropTarget) => void;
  onDrop: (appt: AppointmentWire, target: DropTarget) => void;
  onHeadClick?: (day: DayKey) => void;
}) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; dy: number; dx: number; col: number } | null>(null);
  const dragStart = useRef<{ id: number; x: number; y: number; col: number; moved: boolean } | null>(null);
  // The click that ends a drag is not a tap on the appointment.
  const swallowClick = useRef(false);

  const perColumn = useMemo(() => {
    const days = byDay(appointments);
    return columns.map((c) => {
      const list = (days.get(c.day) ?? []).filter((a) => c.staffMemberId === undefined || a.staffMemberId === c.staffMemberId);
      return { timed: layoutDay(list, c.day), untimed: list.filter((a) => !isTimed(a)) };
    });
  }, [appointments, columns]);

  const allPlaced = perColumn.flatMap((p) => p.timed);
  const byWeekday = useMemo(() => {
    const out: WeekWindow[][] = Array.from({ length: 7 }, () => []);
    for (const h of hours) out[h.weekday]?.push(h);
    return out;
  }, [hours]);
  const { first, last } = gridHours(allPlaced, hours);
  const height = (last - first) * HOUR_PX;
  const pxPerMin = HOUR_PX / 60;
  const anyUntimed = perColumn.some((p) => p.untimed.length);

  const minuteAtY = (clientY: number, laneEl: HTMLElement) => {
    const top = laneEl.getBoundingClientRect().top;
    return snap(first * 60 + (clientY - top) / pxPerMin);
  };

  const colAtX = (clientX: number): number | null => {
    const el = lanesRef.current;
    if (!el) return null;
    const lanes = Array.from(el.children) as HTMLElement[];
    const i = lanes.findIndex((l) => {
      const r = l.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right;
    });
    return i >= 0 ? i : null;
  };

  const onPointerDown = (e: ReactPointerEvent, a: AppointmentWire, col: number) => {
    if (!canDrag || e.pointerType === "touch" || e.button !== 0 || isTerminal(a.status) || !isTimed(a)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { id: a.id, x: e.clientX, y: e.clientY, col, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const st = dragStart.current;
    if (!st) return;
    const dy = e.clientY - st.y;
    const dx = e.clientX - st.x;
    if (!st.moved && Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
    st.moved = true;
    setDrag({ id: st.id, dy: Math.round(dy / (pxPerMin * 15)) * 15 * pxPerMin, dx, col: colAtX(e.clientX) ?? st.col });
  };
  const onPointerUp = (e: ReactPointerEvent, a: AppointmentWire, placed: Placed) => {
    const st = dragStart.current;
    dragStart.current = null;
    if (!st) return;
    if (!st.moved) {
      setDrag(null);
      return;
    }
    swallowClick.current = true;
    const col = colAtX(e.clientX) ?? st.col;
    const deltaMin = Math.round((e.clientY - st.y) / pxPerMin / 15) * 15;
    const minute = snap(placed.start + deltaMin);
    setDrag(null);
    const target = columns[col];
    if (!target) return;
    if (minute === placed.start && target.day === columns[st.col].day && target.staffMemberId === columns[st.col].staffMemberId) return;
    onDrop(a, { day: target.day, staffMemberId: target.staffMemberId, minute });
  };

  const nowCol = columns.findIndex((c) => c.today);
  const nowMinute = nowCol >= 0 ? minuteInDay(now, columns[nowCol].day) : -1;

  return (
    <div className={s.grid} style={{ ["--cols" as string]: columns.length }}>
      <div className={s.heads}>
        <span />
        {columns.map((c) =>
          onHeadClick ? (
            <button key={c.key} type="button" className={`${s.head} ${c.today ? s.headToday : ""}`} onClick={() => onHeadClick(c.day)} aria-label={`${dayTitle(c.day)} — תצוגת יום`}>
              {c.label}
            </button>
          ) : (
            <span key={c.key} className={`${s.head} ${c.today ? s.headToday : ""}`}>
              {c.color !== undefined ? <span className={s.headDot} style={c.color ? laneStyle(c.color) : undefined} /> : null}
              {c.label}
            </span>
          ),
        )}
      </div>

      {anyUntimed ? (
        <div className={s.untimedRow}>
          <span className={s.untimedLabel}>ללא שעה</span>
          {perColumn.map((p, i) => (
            <div key={columns[i].key} className={s.untimedCell}>
              {p.untimed.map((a) => (
                <button key={a.id} type="button" className={s.pill} onClick={() => onSelect(a.id)} aria-label={ariaFor(a, names)}>
                  {headline(a, names)}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className={s.scroller}>
        <div className={s.hours} style={{ height }}>
          {Array.from({ length: last - first }, (_, i) => (
            <div key={i} className={s.hourLabel}>{clock((first + i) * 60)}</div>
          ))}
        </div>
        <div className={s.lanes} ref={lanesRef} style={{ height }}>
          {columns.map((c, ci) => {
            const windows = byWeekday[weekdayOfDay(c.day)];
            const closed = closedBands(windows, first * 60, last * 60, hours.length > 0);
            return (
              <div
                key={c.key}
                className={`${s.lane} ${c.today ? s.laneToday : ""}`}
                onClick={(e) => {
                  if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
                  onCreateAt({ day: c.day, staffMemberId: c.staffMemberId, minute: minuteAtY(e.clientY, e.currentTarget) });
                }}
              >
                {Array.from({ length: last - first }, (_, i) => <div key={i} className={s.hourLine} data-bg="1" />)}
                {closed.map((b, i) => (
                  <div key={i} className={s.closed} style={{ top: (b.start - first * 60) * pxPerMin, height: (b.end - b.start) * pxPerMin }} />
                ))}
                {perColumn[ci].timed.map((p) => {
                  const a = p.appt;
                  const isDragging = drag?.id === a.id;
                  const top = (p.start - first * 60) * pxPerMin;
                  const h = Math.max(22, (p.end - p.start) * pxPerMin - 2);
                  const width = 100 / p.cols;
                  const color = a.kind === "CUSTOMER" ? staffColor(a.staffMemberId, names) : a.kind === "INTERNAL" ? "var(--dz-info)" : "var(--dz-text-muted)";
                  const style: CSSProperties = {
                    ...laneStyle(color),
                    top: top + (isDragging ? drag.dy : 0),
                    height: h,
                    insetInlineStart: `calc(${p.col * width}% + 2px)`,
                    width: `calc(${width}% - 4px)`,
                    ...(isDragging && drag.col !== ci ? { transform: `translateX(${drag.dx}px)` } : {}),
                  };
                  const minutes = durationOf(a) ?? 0;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={blockClass(a, selectedId === a.id, isDragging)}
                      style={style}
                      aria-label={ariaFor(a, names)}
                      onPointerDown={(e) => onPointerDown(e, a, ci)}
                      onPointerMove={onPointerMove}
                      onPointerUp={(e) => onPointerUp(e, a, p)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (swallowClick.current) {
                          swallowClick.current = false;
                          return;
                        }
                        onSelect(a.id);
                      }}
                    >
                      <span className={s.blockTitle}>{headline(a, names)}</span>
                      {h >= 34 || minutes >= 30 ? <span className={s.blockTime}>{timeLabel(a)}</span> : null}
                    </button>
                  );
                })}
                {ci === nowCol && nowMinute >= first * 60 && nowMinute <= last * 60 ? (
                  <div className={s.now} style={{ top: (nowMinute - first * 60) * pxPerMin }} aria-hidden="true" />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The closed bands of a day between `from` and `to` (minutes): everything outside its windows. None while no hours are set. */
function closedBands(windows: WeekWindow[], from: number, to: number, hoursKnown: boolean): Array<{ start: number; end: number }> {
  if (!hoursKnown) return [];
  const out: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const w of [...windows].sort((a, b) => a.startMinute - b.startMinute)) {
    if (w.startMinute > cursor) out.push({ start: cursor, end: Math.min(w.startMinute, to) });
    cursor = Math.max(cursor, w.endMinute);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out.filter((b) => b.end > b.start);
}

// ── Month ───────────────────────────────────────────────────────────────────────────────────────

export function MonthGrid({
  anchor,
  appointments,
  names,
  today,
  compact,
  onDay,
}: {
  anchor: DayKey;
  appointments: AppointmentWire[];
  names: Names;
  today: DayKey;
  compact: boolean;
  onDay: (day: DayKey) => void;
}) {
  const { year, month } = monthOf(anchor);
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const lead = weekdayOfDay(first);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<DayKey | null> = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => addCalendarDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<DayKey | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const map = useMemo(() => byDay(appointments.filter((a) => a.status !== "CANCELED")), [appointments]);

  return (
    <div className={s.month}>
      <div className={s.weekdays}>{WEEKDAY_LETTER.map((w) => <span key={w}>{w}</span>)}</div>
      {weeks.map((w, wi) => (
        <div key={wi} className={s.weekRow}>
          {w.map((d, di) => {
            if (!d) return <span key={di} className={`${s.cell} ${s.cellOut}`} aria-hidden="true" />;
            const list = map.get(d) ?? [];
            const label = `${dayTitle(d)}${list.length ? ` · ${list.length} ${list.length === 1 ? "תור" : "תורים"}` : " · אין תורים"}`;
            return (
              <button key={d} type="button" className={`${s.cell} ${d === today ? s.cellToday : ""}`} onClick={() => onDay(d)} aria-label={label}>
                <span className={s.cellNum}>{dayNumber(d)}</span>
                {compact ? (
                  list.length ? (
                    <span className={s.dots} aria-hidden="true">
                      {list.slice(0, 4).map((a) => <span key={a.id} className={s.dot} style={laneStyle(staffColor(a.staffMemberId, names))} />)}
                    </span>
                  ) : null
                ) : (
                  <>
                    {list.slice(0, 3).map((a) => (
                      <span key={a.id} className={s.cellItem} style={laneStyle(staffColor(a.staffMemberId, names))} aria-hidden="true">
                        {a.startsAt && isTimed(a) ? `${timeLabel(a).slice(0, 5)} ` : ""}{headline(a, names)}
                      </span>
                    ))}
                    {list.length > 3 ? <span className={s.cellMore} aria-hidden="true">ועוד {list.length - 3}</span> : null}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Phone ───────────────────────────────────────────────────────────────────────────────────────

export function MobileAgenda({
  days,
  day,
  today,
  appointments,
  names,
  onDay,
  onSelect,
  onNew,
}: {
  days: DayKey[];
  day: DayKey;
  today: DayKey;
  appointments: AppointmentWire[];
  names: Names;
  onDay: (day: DayKey) => void;
  onSelect: (id: number) => void;
  onNew: () => void;
}) {
  const map = useMemo(() => byDay(appointments), [appointments]);
  const list = map.get(day) ?? [];
  return (
    <>
      <div className={s.strip} role="tablist" aria-label="ימים">
        {days.map((d) => {
          const n = (map.get(d) ?? []).filter((a) => a.status !== "CANCELED").length;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={d === day}
              className={`${s.stripDay} ${d === day ? s.stripOn : ""} ${d === today ? s.stripToday : ""}`}
              onClick={() => onDay(d)}
              aria-label={`${dayTitle(d)}${n ? ` · ${n} תורים` : ""}`}
            >
              <small>{WEEKDAY_LETTER[weekdayOfDay(d)]}</small>
              <b>{dayNumber(d)}</b>
              <small>{n ? `${n}` : " "}</small>
            </button>
          );
        })}
      </div>
      <h2 className={s.sub} style={{ margin: 0 }}>{dayTitle(day)}</h2>
      {list.length ? (
        <div className={s.agenda}>
          {list.map((a) => {
            const staff = a.staffMemberId !== null ? names.staff.get(a.staffMemberId)?.displayName : null;
            const color = a.kind === "CUSTOMER" ? staffColor(a.staffMemberId, names) : a.kind === "INTERNAL" ? "var(--dz-info)" : "var(--dz-text-muted)";
            const minutes = durationOf(a);
            return (
              <button key={a.id} type="button" className={`${s.card} ${isTerminal(a.status) ? s.blockDone : ""}`} style={laneStyle(color)} onClick={() => onSelect(a.id)}>
                <span className={s.cardTime}>
                  {a.startsAt ? timeLabel(a).slice(0, 5) : "—"}
                  {minutes ? <small>{minutes} דק׳</small> : null}
                </span>
                <span className={s.cardBody}>
                  <span className={s.cardTitle}>{headline(a, names)}</span>
                  <span className={s.cardFact}>{[a.kind !== "CUSTOMER" ? KIND_LABEL[a.kind] : null, staff].filter(Boolean).join(" · ") || " "}</span>
                </span>
                {a.kind !== "BLOCK" ? <span className={`${s.status} ${s[`st_${a.status}`]}`}>{STATUS_LABEL[a.status]}</span> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <section className={s.empty}>
          <span className={s.ring} aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
          </span>
          <h2>{day === today ? "אין תורים היום" : "אין תורים ביום הזה"}</h2>
          <button type="button" className={`${t.btn} ${t.pri}`} onClick={onNew}>תור חדש</button>
        </section>
      )}
    </>
  );
}

export function dayColumns(days: DayKey[], today: DayKey, short: boolean): Column[] {
  return days.map((d) => ({ key: d, day: d, staffMemberId: undefined, label: short ? dayShort(d) : dayTitle(d), today: d === today }));
}
