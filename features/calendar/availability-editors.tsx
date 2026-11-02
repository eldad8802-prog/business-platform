"use client";

/**
 * The two availability editors, used by the business ("שעות פעילות", "ימים מיוחדים") and by every staff member's page
 * — one behaviour in both places.
 *
 *   HoursEditor   the week: each day open or closed, one or more ranges (a break = two ranges), "+ הפסקה" adds the
 *                 next range after the day's last one (never past midnight), "העתקה לימים אחרים" copies a day. Times
 *                 are picked on a quarter-hour grid that reaches 24:00 (and keeps an off-grid saved value). One save
 *                 states the whole week (the API's PUT). A staff member with no hours of their own works by the
 *                 business's — shown read-only, with "שעות נפרדות לעובד" starting from a copy of them.
 *   SpecialDays   a closed day, a part-day closure or different hours on one date (the API holds one date per entry),
 *                 listed from today on; added and removed at once.
 * A read that fails says so — it is never shown as "closed every day" or "no special days".
 */
import { useEffect, useState } from "react";

import { addCalendarDays } from "@/lib/utils/jerusalem-day";

import { addException, CalendarApiError, forgetIntent, getAvailability, removeException, replaceWeeklyRules, type ExceptionWire, type RuleWire } from "./calendar-client";
import {
  dayTitle,
  errorText,
  exceptionText,
  LIMITS,
  nextRange,
  textProblem,
  timeOptionLabel,
  timeOptions,
  todayKey,
  windowsByWeekday,
  windowsProblem,
} from "./calendar-model";
import { IconCopy, IconLock, IconPlus, IconX, Loading, LoadError, Seg, Switch, useBeforeUnload } from "./ui";
import s from "./calendar.module.css";

export const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

type Win = { startMinute: number; endMinute: number };
type Week = Win[][];

const weekOf = (rules: RuleWire[]): Week => windowsByWeekday(rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })))
  .map((d) => d.map((w) => ({ startMinute: w.startMinute, endMinute: w.endMinute })));
const sameWeek = (a: Week, b: Week) => JSON.stringify(a) === JSON.stringify(b);

export function TimeSelect({ value, kind, onChange, label, id }: { value: number; kind: "start" | "end"; onChange: (m: number) => void; label: string; id?: string }) {
  return (
    <select id={id} className={s.timeSel} aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {timeOptions(kind, value).map((m) => <option key={m} value={m}>{timeOptionLabel(m)}</option>)}
    </select>
  );
}

function ReadOnlyWeek({ week }: { week: Week }) {
  return (
    <div>
      {week.map((ranges, d) => (
        <div key={d} className={s.dayLine}>
          <span className={s.dayName}>{DAY_NAMES[d]}</span>
          <span className={s.closedWord}>
            {ranges.length ? ranges.map((r, i) => <bdi key={i} dir="ltr" style={{ marginInlineEnd: 12 }}>{timeOptionLabel(r.startMinute)}–{timeOptionLabel(r.endMinute)}</bdi>) : "סגור"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HoursEditor({ staffMemberId, onSaved, onDirty }: { staffMemberId: number | null; onSaved: (message: string) => void; onDirty?: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<Week | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [inherited, setInherited] = useState<Week | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [dayErrors, setDayErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTo, setCopyTo] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getAvailability(staffMemberId)
      .then(async (r) => {
        const business = staffMemberId !== null && r.rules.length === 0 ? weekOf((await getAvailability(null)).rules) : null;
        if (cancelled) return;
        const w = weekOf(r.rules);
        setSaved(w);
        setWeek(w);
        setInherited(business);
        setEditing(false);
        setLoadError(null);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [staffMemberId, tick]);

  const dirty = !!week && !!saved && !sameWeek(week, saved);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  useBeforeUnload(dirty);

  if (loadError) return <LoadError text={`לא הצלחתי לטעון את השעות. ${loadError}`} onRetry={() => { setLoadError(null); setTick((x) => x + 1); }} />;
  if (!week || !saved) return <Loading label="טוען שעות" rows={7} />;

  const savedEmpty = saved.every((d) => d.length === 0);
  if (staffMemberId !== null && savedEmpty && inherited && !editing) {
    return (
      <div className={s.sheet}>
        <p className={s.note}>לעובד אין שעות משלו, ולכן הוא עובד לפי שעות העסק:</p>
        <ReadOnlyWeek week={inherited} />
        <button type="button" className={`${s.btn} ${s.btnSoft}`} style={{ alignSelf: "flex-start" }} onClick={() => { setWeek(inherited.map((d) => d.map((r) => ({ ...r })))); setEditing(true); }}>
          שעות נפרדות לעובד
        </button>
      </div>
    );
  }

  const setDay = (i: number, ranges: Win[]) => { setWeek(week.map((d, j) => (j === i ? ranges : d))); setDayErrors((e) => { const n = { ...e }; delete n[i]; return n; }); };

  const save = async (next: Week = week) => {
    const errs: Record<number, string> = {};
    next.forEach((ranges, d) => { const p = windowsProblem(ranges); if (p) errs[d] = p; });
    setDayErrors(errs);
    if (Object.keys(errs).length) { setError("יש ימים עם טווח שעות לא תקין — מסומנים למעלה."); return; }
    const rules: RuleWire[] = next.flatMap((ranges, weekday) => ranges.map((w) => ({ weekday, startMinute: w.startMinute, endMinute: w.endMinute })));
    const intent = `hours:${staffMemberId ?? "biz"}:${JSON.stringify(rules)}`;
    setBusy(true);
    setError(null);
    try {
      await replaceWeeklyRules(intent, staffMemberId, rules);
      setSaved(next);
      setWeek(next);
      if (staffMemberId !== null && rules.length === 0) {
        const business = await getAvailability(null).catch(() => null);
        if (business) setInherited(weekOf(business.rules));
        setEditing(false);
      }
      onSaved(staffMemberId !== null && rules.length === 0 ? "העובד חזר לשעות העסק" : "השעות נשמרו");
    } catch (e) {
      forgetIntent(intent);
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.sheet}>
      {staffMemberId !== null && savedEmpty ? <p className={s.note}>השעות שיישמרו כאן יחליפו לעובד את שעות העסק.</p> : null}
      <div>
        {week.map((ranges, d) => (
          <div key={d} className={s.dayLine}>
            <span className={s.dayName}>
              <Switch label={`${DAY_NAMES[d]} פתוח`} checked={ranges.length > 0} onChange={(on) => setDay(d, on ? [nextRange([])!] : [])} />
              {DAY_NAMES[d]}
            </span>
            <div className={s.ranges}>
              {ranges.length === 0 ? <span className={s.closedWord}>סגור</span> : null}
              {ranges.map((r, i) => (
                <div key={i} className={s.range}>
                  <span className={s.rangeKind}>{i === 0 ? "" : "אחרי הפסקה"}</span>
                  <TimeSelect kind="start" value={r.startMinute} label={`יום ${DAY_NAMES[d]}, טווח ${i + 1}, משעה`} onChange={(m) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, startMinute: m } : x)))} />
                  <span aria-hidden="true">–</span>
                  <TimeSelect kind="end" value={r.endMinute} label={`יום ${DAY_NAMES[d]}, טווח ${i + 1}, עד שעה`} onChange={(m) => setDay(d, ranges.map((x, k) => (k === i ? { ...x, endMinute: m } : x)))} />
                  <button type="button" className={s.iconBtn} aria-label={`הסרת הטווח ${i + 1} ביום ${DAY_NAMES[d]}`} onClick={() => setDay(d, ranges.filter((_, k) => k !== i))}><IconX size={18} /></button>
                </div>
              ))}
              {dayErrors[d] ? <p className={s.fieldErr} role="alert">{dayErrors[d]}</p> : null}
              {ranges.length ? (
                <div className={s.rangeTools}>
                  <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={!nextRange(ranges)} onClick={() => { const n = nextRange(ranges); if (n) setDay(d, [...ranges, n]); }}>
                    <IconPlus size={16} /> הפסקה וטווח נוסף
                  </button>
                  <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} aria-expanded={copyFrom === d} onClick={() => { setCopyFrom(copyFrom === d ? null : d); setCopyTo(new Set()); }}>
                    <IconCopy size={16} /> העתקה לימים אחרים
                  </button>
                </div>
              ) : null}
              {copyFrom === d ? (
                <div className={s.copyBox}>
                  <span className={s.label}>להעתיק את השעות של יום {DAY_NAMES[d]} אל:</span>
                  <div className={s.chips}>
                    {DAY_NAMES.map((n, j) => j === d ? null : (
                      <button key={j} type="button" role="checkbox" aria-checked={copyTo.has(j)} className={s.chip} onClick={() => { const next = new Set(copyTo); if (next.has(j)) next.delete(j); else next.add(j); setCopyTo(next); }}>{n}</button>
                    ))}
                  </div>
                  <div className={s.confirmRow}>
                    <button type="button" className={`${s.btn} ${s.btnPri} ${s.btnSm}`} disabled={!copyTo.size} onClick={() => { setWeek(week.map((x, j) => (copyTo.has(j) ? ranges.map((r) => ({ ...r })) : x))); setCopyFrom(null); }}>העתקה</button>
                    <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setCopyFrom(null)}>סגירה</button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <div className={s.saveBar}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || !dirty} onClick={() => void save()}>{busy ? "שומר…" : "שמירת השעות"}</button>
        {dirty ? <button type="button" className={s.btn} disabled={busy} onClick={() => { setWeek(saved); setDayErrors({}); setError(null); if (staffMemberId !== null && savedEmpty) setEditing(false); }}>ביטול השינויים</button> : <span className={s.hint}>אין שינויים שלא נשמרו.</span>}
        {staffMemberId !== null && !savedEmpty && !dirty ? (
          <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void save(week.map(() => []))}>חזרה לשעות העסק</button>
        ) : null}
      </div>
    </div>
  );
}

type ExKind = "ALL" | "PART" | "OPEN";

export function SpecialDays({ staffMemberId, onChanged }: { staffMemberId: number | null; onChanged: (message: string) => void }) {
  const today = todayKey(new Date());
  const [list, setList] = useState<ExceptionWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stamp, setStamp] = useState(0);
  const [day, setDay] = useState(addCalendarDays(today, 1));
  const [kind, setKind] = useState<ExKind>("ALL");
  const [start, setStart] = useState(540);
  const [end, setEnd] = useState(780);
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = staffMemberId ?? "biz";

  useEffect(() => {
    let cancelled = false;
    getAvailability(staffMemberId, today)
      .then((r) => { if (!cancelled) { setList([...r.exceptions].sort((a, b) => a.dayKey.localeCompare(b.dayKey))); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [staffMemberId, today, stamp]);

  const add = async () => {
    const problem = textProblem("התיאור", label.trim(), LIMITS.exceptionLabel);
    if (problem) { setError(problem); return; }
    if (kind !== "ALL" && end <= start) { setError("שעת הסיום צריכה להיות אחרי שעת ההתחלה."); return; }
    const body = {
      staffMemberId, dayKey: day, kind: kind === "OPEN" ? ("OPEN_HOURS" as const) : ("CLOSED" as const),
      startMinute: kind === "ALL" ? null : start, endMinute: kind === "ALL" ? null : end, label: label.trim() || null,
    };
    const intent = `exception:add:${JSON.stringify(body)}`;
    setBusy(true);
    setError(null);
    try {
      await addException(intent, body);
      setLabel("");
      setKind("ALL");
      setDay(addCalendarDays(today, 1));
      setStamp((x) => x + 1);
      onChanged("היום המיוחד נשמר");
    } catch (e) {
      forgetIntent(intent);
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.sheet}>
      {loadError ? <LoadError text={`לא הצלחתי לטעון את הימים המיוחדים. ${loadError}`} onRetry={() => setStamp((x) => x + 1)} /> : null}
      {!loadError && list === null ? <Loading label="טוען ימים מיוחדים" rows={2} /> : null}
      {list?.length ? (
        <ul className={s.list} aria-label="ימים מיוחדים קרובים">
          {list.map((x) => (
            <li key={x.id} className={`${s.listRow} ${s.listRowStatic}`}>
              <span className={s.lineIcon}>{x.kind === "CLOSED" ? <IconLock size={20} /> : null}</span>
              <span className={s.rowText}>
                <span className={s.rowTitle} style={{ fontSize: 16 }}>{dayTitle(x.dayKey)}</span>
                <span className={s.rowSub}>{exceptionText(x)}</span>
              </span>
              {confirming === x.id ? (
                <span className={s.confirmRow}>
                  <button type="button" className={`${s.btn} ${s.btnDangerFill} ${s.btnSm}`} disabled={busy} onClick={async () => {
                    const intent = `exception:remove:${x.id}`;
                    setBusy(true);
                    try { await removeException(intent, x.id); setConfirming(null); setStamp((v) => v + 1); onChanged("היום המיוחד הוסר"); } catch (e) { forgetIntent(intent); setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); } finally { setBusy(false); }
                  }}>כן, להסיר</button>
                  <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={busy} onClick={() => setConfirming(null)}>חזרה</button>
                </span>
              ) : (
                <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnDanger}`} aria-label={`הסרת היום המיוחד ${dayTitle(x.dayKey)}`} onClick={() => setConfirming(x.id)}>הסרה</button>
              )}
            </li>
          ))}
        </ul>
      ) : list ? <p className={s.note}>אין ימים מיוחדים קרובים.</p> : null}

      <div className={s.copyBox}>
        <span className={s.label} style={{ fontSize: 16, color: "var(--ap-ink)", fontWeight: 600 }}>הוספת יום מיוחד</span>
        <div className={s.field}>
          <label className={s.label} htmlFor={`ex-day-${scope}`}>תאריך</label>
          <input id={`ex-day-${scope}`} type="date" className={s.input} value={day} min={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        <Seg label="מה קורה ביום הזה" value={kind} onChange={setKind} small options={[["ALL", "סגור כל היום"], ["PART", "סגור בחלק מהיום"], ["OPEN", "שעות שונות"]]} />
        {kind !== "ALL" ? (
          <div className={s.range}>
            <TimeSelect kind="start" value={start} label="משעה" onChange={setStart} />
            <span aria-hidden="true">–</span>
            <TimeSelect kind="end" value={end} label="עד שעה" onChange={setEnd} />
          </div>
        ) : null}
        <div className={s.field}>
          <label className={s.label} htmlFor={`ex-label-${scope}`}>תיאור (לא חובה)</label>
          <input id={`ex-label-${scope}`} className={s.input} value={label} maxLength={LIMITS.exceptionLabel + 20} onChange={(e) => setLabel(e.target.value)} placeholder="למשל: ערב חג" />
        </div>
        {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
        <button type="button" className={`${s.btn} ${s.btnPri}`} style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void add()}>{busy ? "שומר…" : "הוספה"}</button>
      </div>
    </div>
  );
}
