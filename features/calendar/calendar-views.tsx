"use client";

/**
 * The calendar's pictures (design direction A):
 *   DayStrip   the week's seven days — the count of appointments under each, closed days quieter; the chosen day filled.
 *   TimeGrid   day and week: hours on the start edge, one column per day (week), per staff lane (day on a wide screen) or
 *              one column for everyone (day on a phone, blocks side by side when they overlap). Four kinds of time, each
 *              told apart by more than colour (the legend says which): free (white — a tap books there), outside the
 *              hours (flat warm grey — still bookable, with a warning), closed (a labelled band with a lock), blocked (a
 *              grey block with its mark). Every appointment names its time and title and carries its state as an icon,
 *              even on a 15-minute block. One focusable target per hour books by keyboard too. On a pointer device an
 *              appointment is dragged to another time / day / lane (15-minute steps) and dropped as a move the server
 *              checks. The grid opens scrolled to now (today) or to the first open hour.
 *   WeekList   the phone's week: the seven days in order, each with its appointments as cards.
 *   MonthGrid  the month: each day's count, what is closed or different, the first appointments on a wide screen.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { addCalendarDays } from "@/lib/utils/jerusalem-day";

import {
  byDay,
  clock,
  closureBands,
  clockOf,
  dayAvailability,
  dayNumber,
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
  openWindows,
  snap,
  STATUS_LABEL,
  staffColor,
  timeLabel,
  WEEKDAY_LETTER,
  weekdayOfDay,
  type AppointmentWire,
  type Availability,
  type DayKey,
  type Names,
  type Placed,
  type WeekWindow,
} from "./calendar-model";
import { IconLock, markOf, StateMark } from "./ui";
import s from "./calendar.module.css";

const HOUR_PX = 64;
const INTERNAL_COLOR = "#3b5f86";

/** A grid column: a day (week), a staff lane (day, wide), or the whole business on one day (staffMemberId undefined). */
export type Column = { key: string; day: DayKey; staffMemberId: number | null | undefined; label: string; color?: string | null; today: boolean; inactive?: boolean };

export type DropTarget = { day: DayKey; staffMemberId: number | null | undefined; minute: number };

const laneStyle = (color: string): CSSProperties => ({ ["--lane" as string]: color });

export function blockColor(a: AppointmentWire, names: Names): string {
  return a.kind === "CUSTOMER" ? staffColor(a.staffMemberId, names) : a.kind === "INTERNAL" ? INTERNAL_COLOR : "#b9b0a7";
}

/** What a reader hears for an appointment: time, title, staff and state — the block shows the same in its own way. */
export function ariaFor(a: AppointmentWire, names: Names): string {
  const state = a.kind === "BLOCK" ? (a.status === "CANCELED" ? `${KIND_LABEL.BLOCK} · בוטלה` : KIND_LABEL.BLOCK) : STATUS_LABEL[a.status];
  const staff = a.staffMemberId !== null ? names.staff.get(a.staffMemberId)?.displayName : null;
  const kind = a.kind === "INTERNAL" ? ` · ${KIND_LABEL.INTERNAL}` : "";
  return [timeLabel(a), headline(a, names), staff, `${state}${kind}`].filter(Boolean).join(" · ");
}

function blockClass(a: AppointmentWire, selected: boolean, dragging: boolean, tight: boolean): string {
  return [
    s.block,
    tight ? s.blockTight : "",
    a.status === "CANCELED" ? s.blockCanceled : a.kind === "BLOCK" ? s.blockBlock : isTerminal(a.status) ? s.blockDone : a.status === "PROPOSED" ? s.blockProposed : "",
    selected ? s.blockSel : "",
    dragging ? s.dragging : "",
  ].filter(Boolean).join(" ");
}

// ── The week strip ──────────────────────────────────────────────────────────────────────────────

export function DayStrip({ days, day, today, appointments, availability, names, onDay }: {
  days: DayKey[];
  day: DayKey;
  today: DayKey;
  appointments: AppointmentWire[];
  availability: Availability;
  names: Names;
  onDay: (d: DayKey) => void;
}) {
  const map = useMemo(() => byDay(appointments.filter((a) => a.status !== "CANCELED" && a.kind !== "BLOCK")), [appointments]);
  return (
    <div className={s.strip} role="tablist" aria-label="ימי השבוע">
      {days.map((d) => {
        const n = map.get(d)?.length ?? 0;
        const shut = dayAvailability(availability, d, names).closed;
        return (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === day}
            className={`${s.stripDay} ${d === day ? s.stripOn : ""} ${d === today ? s.stripToday : ""} ${shut ? s.stripClosed : ""}`}
            onClick={() => onDay(d)}
            aria-label={`${dayTitle(d)}${d === today ? " · היום" : ""}${shut ? " · סגור" : ""} · ${n ? `${n} ${n === 1 ? "תור" : "תורים"}` : "אין תורים"}`}
          >
            <small>{WEEKDAY_LETTER[weekdayOfDay(d)].replace("׳", "")}</small>
            <b>{dayNumber(d)}</b>
            <i>{shut ? "סגור" : n ? `${n}` : " "}</i>
          </button>
        );
      })}
    </div>
  );
}

// ── Day / week grid ─────────────────────────────────────────────────────────────────────────────

export function TimeGrid({
  columns,
  appointments,
  names,
  hours,
  availability,
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
  availability: Availability;
  now: Date;
  selectedId: number | null;
  canDrag: boolean;
  onSelect: (id: number) => void;
  onCreateAt: (target: DropTarget) => void;
  onDrop: (appt: AppointmentWire, target: DropTarget) => void;
  onHeadClick?: (day: DayKey) => void;
}) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const { first, last } = gridHours(allPlaced, hours);
  const height = (last - first) * HOUR_PX;
  const pxPerMin = HOUR_PX / 60;
  const anyUntimed = perColumn.some((p) => p.untimed.length);

  const nowCol = columns.findIndex((c) => c.today);
  const nowMinute = nowCol >= 0 ? minuteInDay(now, columns[nowCol].day) : -1;
  const nowShown = nowCol >= 0 && nowMinute >= first * 60 && nowMinute <= last * 60;

  // Open at "now" (an hour of context above it), else at the first open hour of the first column.
  const firstOpen = useMemo(() => {
    const w = columns.length ? openWindows(availability, columns[0].staffMemberId ?? null, columns[0].day) : null;
    return w && w.length ? Math.min(...w.map((x) => x.startMinute)) : null;
  }, [availability, columns]);
  const scrollKey = `${columns.map((c) => c.key).join(",")}|${first}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = nowShown ? nowMinute - 60 : firstOpen !== null ? firstOpen - 30 : 0;
    el.scrollTop = Math.max(0, (target - first * 60) * pxPerMin);
    // Only when the picture changes (another day / lanes) — never while the owner scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

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

  return (
    <div className={s.grid} style={{ ["--cols" as string]: columns.length, ["--hour" as string]: `${HOUR_PX}px` }}>
      {columns.length > 1 ? (
        <div className={s.heads}>
          <span />
          {columns.map((c) =>
            onHeadClick ? (
              <button key={c.key} type="button" className={`${s.colHead} ${c.today ? s.colHeadToday : ""}`} onClick={() => onHeadClick(c.day)} aria-label={`${dayTitle(c.day)} — תצוגת יום`}>
                {c.label}
              </button>
            ) : (
              <span key={c.key} className={`${s.colHead} ${c.today ? s.colHeadToday : ""} ${c.inactive ? s.colHeadOff : ""}`}>
                {c.staffMemberId !== undefined ? <span className={s.dot} style={laneStyle(c.color ?? "#b9b0a7")} aria-hidden="true" /> : null}
                {c.label}
              </span>
            ),
          )}
        </div>
      ) : null}

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

      <div className={s.scroller} ref={scrollRef}>
        <div className={s.hours} style={{ height }} aria-hidden="true">
          {Array.from({ length: last - first }, (_, i) => (
            <div key={i} className={s.hourLabel}>{clock((first + i) * 60)}</div>
          ))}
        </div>
        <div className={s.lanes} ref={lanesRef} style={{ height }}>
          {columns.map((c, ci) => {
            const lane = c.staffMemberId ?? null;
            const out = outsideBands(openWindows(availability, lane, c.day), first * 60, last * 60);
            const closures = closureBands(availability, lane, c.day, names)
              .map((b) => ({ ...b, start: Math.max(b.start, first * 60), end: Math.min(b.end, last * 60) }))
              .filter((b) => b.end > b.start);
            return (
              <div key={c.key} className={s.lane} data-lane={c.key}>
                {Array.from({ length: last - first }, (_, i) => {
                  const hour = first + i;
                  return (
                    <div key={i} className={s.hourRow}>
                      <button
                        type="button"
                        className={s.hit}
                        aria-label={`קביעה ב${dayTitle(c.day)} בשעה ${clock(hour * 60)}${c.staffMemberId !== undefined ? ` · ${c.label}` : ""}`}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          const quarter = e.detail === 0 ? 0 : Math.min(45, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * 4) * 15));
                          onCreateAt({ day: c.day, staffMemberId: c.staffMemberId, minute: hour * 60 + quarter });
                        }}
                      >
                        <span className={s.hitLabel}>+ {clock(hour * 60)}</span>
                      </button>
                    </div>
                  );
                })}
                {out.map((b, i) => (
                  <div key={`o${i}`} className={s.out} style={{ top: (b.start - first * 60) * pxPerMin, height: (b.end - b.start) * pxPerMin }} />
                ))}
                {closures.map((b, i) => (
                  <div key={`x${i}`} className={s.closure} style={{ top: (b.start - first * 60) * pxPerMin, height: (b.end - b.start) * pxPerMin }} title={b.label}>
                    {(b.end - b.start) * pxPerMin >= 22 ? <span className={s.closureLabel}><IconLock size={14} />{b.label}</span> : null}
                  </div>
                ))}
                {perColumn[ci].timed.map((p) => {
                  const a = p.appt;
                  const isDragging = drag?.id === a.id;
                  const top = (p.start - first * 60) * pxPerMin;
                  const h = Math.max(24, (p.end - p.start) * pxPerMin - 3);
                  const width = 100 / p.cols;
                  const tight = h < 46;
                  const mark = markOf(a);
                  const staffName = c.staffMemberId === undefined && a.staffMemberId !== null ? names.staff.get(a.staffMemberId)?.displayName : null;
                  const style: CSSProperties = {
                    ...laneStyle(blockColor(a, names)),
                    top: top + 1 + (isDragging ? drag.dy : 0),
                    height: h,
                    insetInlineStart: `calc(${p.col * width}% + 3px)`,
                    width: `calc(${width}% - 6px)`,
                    ...(isDragging && drag.col !== ci ? { transform: `translateX(${drag.dx}px)` } : {}),
                  };
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={blockClass(a, selectedId === a.id, isDragging, tight)}
                      style={style}
                      aria-label={ariaFor(a, names)}
                      data-appointment={a.id}
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
                      <span className={s.blockRow}>
                        {mark ? <StateMark mark={mark} /> : null}
                        <span className={s.blockTitle}>{headline(a, names)}</span>
                        {tight || width < 50 ? null : <span className={s.blockTime}>{timeLabel(a)}</span>}
                      </span>
                      {!tight ? (
                        <span className={s.blockSub}>
                          {width < 50 ? timeLabel(a) : [staffName, a.kind === "INTERNAL" ? KIND_LABEL.INTERNAL : null, a.status !== "CONFIRMED" && a.kind !== "BLOCK" ? STATUS_LABEL[a.status] : null].filter(Boolean).join(" · ") || " "}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {ci === nowCol && nowShown ? <div className={s.now} style={{ top: (nowMinute - first * 60) * pxPerMin }} aria-hidden="true">{ci === columns.length - 1 || columns.length === 1 ? <span className={s.nowTime}>{clock(nowMinute)}</span> : null}</div> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The bands of a day outside its open windows, between `from` and `to` (minutes). None when nothing is known. */
function outsideBands(windows: Array<{ startMinute: number; endMinute: number }> | null, from: number, to: number): Array<{ start: number; end: number }> {
  if (!windows) return [];
  const out: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const w of [...windows].sort((a, b) => a.startMinute - b.startMinute)) {
    if (w.startMinute > cursor) out.push({ start: cursor, end: Math.min(w.startMinute, to) });
    cursor = Math.max(cursor, w.endMinute);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out.filter((b) => b.end > b.start);
}

// ── The legend ──────────────────────────────────────────────────────────────────────────────────

export function Legend() {
  return (
    <ul className={s.legend} aria-label="מקרא">
      <li><i className={`${s.swatch} ${s.swFree}`} aria-hidden="true" />פנוי</li>
      <li><i className={`${s.swatch} ${s.swOut}`} aria-hidden="true" />מחוץ לשעות</li>
      <li><i className={`${s.swatch} ${s.swClosed}`} aria-hidden="true" /><IconLock size={14} />סגור</li>
      <li><StateMark mark="BLOCK" />חסום</li>
      <li><StateMark mark="PROPOSED" />ממתין לאישור</li>
      <li><StateMark mark="COMPLETED" />התקיים</li>
      <li><StateMark mark="NO_SHOW" />לא הגיע</li>
      <li><StateMark mark="CANCELED" />בוטל</li>
      <li><StateMark mark="INTERNAL" />פגישה פנימית</li>
    </ul>
  );
}

// ── An appointment as a card (the phone's week, lists) ───────────────────────────────────────────

export function ApptCard({ a, names, onSelect }: { a: AppointmentWire; names: Names; onSelect: (id: number) => void }) {
  const staff = a.staffMemberId !== null ? names.staff.get(a.staffMemberId)?.displayName : null;
  const minutes = durationOf(a);
  const mark = markOf(a);
  const cls = a.status === "CANCELED" ? s.cardCanceled : a.kind === "BLOCK" ? s.cardBlock : isTerminal(a.status) ? s.cardDone : "";
  return (
    <button type="button" className={`${s.card} ${cls}`} style={laneStyle(blockColor(a, names))} onClick={() => onSelect(a.id)} aria-label={ariaFor(a, names)} data-appointment={a.id}>
      <span className={s.cardTime}>
        {a.startsAt ? clockOf(new Date(a.startsAt)) : "—"}
        {minutes ? <small>{minutes} דק׳</small> : null}
      </span>
      <span className={s.cardBody}>
        <span className={s.cardTitle}>{headline(a, names)}</span>
        <span className={s.cardFact}>{[a.kind !== "CUSTOMER" ? KIND_LABEL[a.kind] : null, staff, a.kind !== "BLOCK" && a.status !== "CONFIRMED" ? STATUS_LABEL[a.status] : null].filter(Boolean).join(" · ") || " "}</span>
      </span>
      {mark ? <StateMark mark={mark} size={14} /> : null}
    </button>
  );
}

// ── The phone's week ────────────────────────────────────────────────────────────────────────────

export function WeekList({ days, today, appointments, names, availability, onDay, onSelect }: {
  days: DayKey[];
  today: DayKey;
  appointments: AppointmentWire[];
  names: Names;
  availability: Availability;
  onDay: (d: DayKey) => void;
  onSelect: (id: number) => void;
}) {
  const map = useMemo(() => byDay(appointments), [appointments]);
  return (
    <div className={s.weekList}>
      {days.map((d) => {
        const list = map.get(d) ?? [];
        const live = list.filter((a) => a.status !== "CANCELED" && a.kind !== "BLOCK").length;
        const av = dayAvailability(availability, d, names);
        return (
          <section key={d} className={s.weekDay} aria-label={dayTitle(d)}>
            <button type="button" className={`${s.weekDayHead} ${d === today ? s.weekDayToday : ""}`} onClick={() => onDay(d)} aria-label={`${dayTitle(d)} — תצוגת יום`}>
              <b>{dayTitle(d)}{d === today ? " · היום" : ""}</b>
              <span>{av.closed ? "סגור" : live ? `${live} ${live === 1 ? "תור" : "תורים"}` : "אין תורים"}</span>
            </button>
            {av.notes.length ? <p className={s.dayEmpty}>{av.notes.join(" · ")}</p> : null}
            {list.map((a) => <ApptCard key={a.id} a={a} names={names} onSelect={onSelect} />)}
          </section>
        );
      })}
    </div>
  );
}

// ── Month ───────────────────────────────────────────────────────────────────────────────────────

export function MonthGrid({
  anchor,
  appointments,
  names,
  availability,
  today,
  compact,
  onDay,
}: {
  anchor: DayKey;
  appointments: AppointmentWire[];
  names: Names;
  availability: Availability;
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
  const map = useMemo(() => byDay(appointments.filter((a) => a.status !== "CANCELED" && a.kind !== "BLOCK")), [appointments]);

  return (
    <div className={s.month}>
      <div className={s.weekdays} aria-hidden="true">{WEEKDAY_LETTER.map((w) => <span key={w}>{w}</span>)}</div>
      {weeks.map((w, wi) => (
        <div key={wi} className={s.weekRow}>
          {w.map((d, di) => {
            if (!d) return <span key={di} className={`${s.cell} ${s.cellOut}`} aria-hidden="true" />;
            const list = map.get(d) ?? [];
            const av = dayAvailability(availability, d, names);
            const special = !av.closed && av.notes.length > 0;
            const label = `${dayTitle(d)}${d === today ? " · היום" : ""}${av.closed ? " · סגור" : ""}${av.notes.length ? ` · ${av.notes.join(" · ")}` : ""} · ${list.length ? `${list.length} ${list.length === 1 ? "תור" : "תורים"}` : "אין תורים"}`;
            return (
              <button key={d} type="button" className={`${s.cell} ${d === today ? s.cellToday : ""} ${av.closed ? s.cellClosed : ""}`} onClick={() => onDay(d)} aria-label={label} title={av.notes.join("\n") || undefined}>
                <span className={s.cellNum}>{dayNumber(d)}</span>
                {av.closed ? <span className={s.cellBadge} aria-hidden="true"><IconLock size={11} />סגור</span> : special ? <span className={`${s.cellBadge} ${s.cellBadgePart}`} aria-hidden="true">{compact ? "שונה" : "שעות שונות"}</span> : null}
                {list.length ? <span className={s.cellCount} aria-hidden="true">{compact ? list.length : `${list.length} ${list.length === 1 ? "תור" : "תורים"}`}</span> : null}
                {!compact ? (
                  <>
                    {list.slice(0, 3).map((a) => (
                      <span key={a.id} className={s.cellItem} style={laneStyle(blockColor(a, names))} aria-hidden="true">
                        {a.startsAt && isTimed(a) ? `${clockOf(new Date(a.startsAt))} ` : ""}{headline(a, names)}
                      </span>
                    ))}
                    {list.length > 3 ? <span className={s.cellMore} aria-hidden="true">ועוד {list.length - 3}</span> : null}
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function dayColumns(days: DayKey[], today: DayKey, label: (d: DayKey) => string): Column[] {
  return days.map((d) => ({ key: d, day: d, staffMemberId: undefined, label: label(d), today: d === today }));
}
