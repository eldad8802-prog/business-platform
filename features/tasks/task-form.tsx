"use client";

/**
 * Daily Tasks — the one task form (owner-approved mockup "יצירה ופרטים"): a panel on desktop, a dialog on tablet,
 * a bottom sheet on mobile (the caller decides the frame). Used by the task centre and the secretary's capture.
 *
 *   - "מה צריך לעשות?" (required), "מתי" (היום / מחר / a day / ללא תאריך), "חזרה" (פעם אחת / כל יום / כל שבוע /
 *     כל חודש — weekly and monthly follow the chosen day), "קשור ל" (optional: an explicit pick, never a guess);
 *   - "שעה" (optional) and, with a time, "תזכורת" (בזמן / 15 דקות / שעה / יום לפני, or none) — the reminder is sent at
 *     the chosen moment even in quiet hours (owner decision 2026-10-21), and the form says so; "פירוט" (optional);
 *   - a summary sentence before saving;
 *   - a typed amount is not stored on a task: the form points to the commitment flow instead (spec 5.1).
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import {
  createSeries,
  createTask,
  errorText,
  searchLinks,
  uuidV7,
  type LinkOption,
  type RuleInput,
} from "@/lib/tasks/tasks-client";

import { clockLabel, offsetLabel, parseClock, REMIND_OFFSET_CHOICES } from "@/lib/services/tasks/task-schedule";

import { addDays, chipLabel, todayKey, weekdayLong, weekdayOf, whenPhrase } from "./task-days";
import s from "./tasks.module.css";

type Repeat = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";

const AMOUNT_HINT = /(₪|ש"ח|שח|\d{3,})/;

export function TaskForm({
  origin = "OWNER",
  onDone,
  onCancel,
  titleId,
  heading = "משימה חדשה",
}: {
  origin?: "OWNER" | "SECRETARY";
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  titleId?: string;
  heading?: string;
}) {
  const today = todayKey();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // One intent per opened form: a double click or a retry after a lost answer is the same create (12.9).
  const intent = useRef(uuidV7()).current;
  const [title, setTitle] = useState("");
  const [day, setDay] = useState<string | null>(today);
  const [custom, setCustom] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("ONCE");
  const [note, setNote] = useState("");
  const [clock, setClock] = useState("");
  const [remind, setRemind] = useState<number | null>(0);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<LinkOption[] | null>(null);
  const [link, setLink] = useState<LinkOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (link || q.trim().length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      searchLinks(q)
        .then((r) => !cancelled && setOptions(r.options))
        .catch(() => !cancelled && setOptions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, link]);

  const startOn = day ?? today;
  const rule: RuleInput | null =
    repeat === "DAILY" ? { kind: "DAILY" }
    : repeat === "WEEKLY" ? { kind: "WEEKDAYS", weekdays: [weekdayOf(startOn)] }
    : repeat === "MONTHLY" ? { kind: "MONTH_DAY", monthDay: Math.min(Number(startOn.slice(8, 10)), 31) }
    : null;

  const cadence =
    repeat === "DAILY" ? "כל יום"
    : repeat === "WEEKLY" ? `כל יום ${weekdayLong(weekdayOf(startOn))}`
    : repeat === "MONTHLY" ? `כל ${Number(startOn.slice(8, 10))} בחודש`
    : null;

  const clean = title.trim();
  const dueMinute = day && clock ? parseClock(clock) : null;
  const remindOffsetMinutes = dueMinute != null ? remind : null;
  const at = dueMinute != null ? ` ב־${clockLabel(dueMinute)}` : "";
  const remindPhrase = remindOffsetMinutes == null ? "" : ` · תזכורת ${offsetLabel(remindOffsetMinutes)}`;
  const summary = !clean
    ? null
    : cadence
      ? `${cadence}${at}, החל ${startOn === today ? "מהיום" : startOn === addDays(today, 1) ? "ממחר" : `מ${chipLabel(startOn)}`}: ${clean}${remindPhrase}`
      : day
        ? `${whenPhrase(day, today)}${at}: ${clean}${remindPhrase}`
        : `נשמר ברשימה, בלי תאריך: ${clean}`;

  async function save() {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const l = link ? { kind: link.kind, id: link.id } : null;
      const n = note.trim() ? note.trim() : null;
      if (rule) await createSeries(intent, { title: clean, note: n, link: l, rule, startOn, dueMinute, remindOffsetMinutes });
      else await createTask(intent, { title: clean, note: n, dueOn: day, link: l, origin, dueMinute, remindOffsetMinutes });
      await onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const chosenOther = day && day !== today && day !== addDays(today, 1);

  return (
    <form
      className={s.form}
      dir="rtl"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id={titleId}>{heading}</h2>

      <div className={s.field}>
        <label htmlFor={`${ids}-t`}>מה צריך לעשות?</label>
        <input
          ref={inputRef}
          id={`${ids}-t`}
          className={s.input}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="למשל: להתקשר לרואה החשבון"
          autoComplete="off"
          required
        />
      </div>

      <fieldset className={s.field}>
        <legend>מתי</legend>
        <div className={s.chips}>
          <Chip on={day === today && !custom} onClick={() => { setDay(today); setCustom(false); }}>היום</Chip>
          <Chip on={day === addDays(today, 1) && !custom} onClick={() => { setDay(addDays(today, 1)); setCustom(false); }}>מחר</Chip>
          <Chip on={custom || !!chosenOther} onClick={() => { setCustom(true); if (!day) setDay(addDays(today, 2)); }}>
            {chosenOther ? chipLabel(day!) : "תאריך אחר"}
          </Chip>
          {repeat === "ONCE" ? (
            <Chip on={day === null} onClick={() => { setDay(null); setCustom(false); }}>ללא תאריך</Chip>
          ) : null}
        </div>
        {custom ? (
          <input
            type="date"
            className={s.input}
            aria-label="בחירת תאריך"
            min={today}
            value={day ?? ""}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        ) : null}
      </fieldset>

      {day ? (
        <div className={s.field}>
          <label htmlFor={`${ids}-c`}>שעה (לא חובה)</label>
          <input
            id={`${ids}-c`}
            type="time"
            className={s.input}
            value={clock}
            step={60}
            onChange={(e) => setClock(e.target.value)}
          />
        </div>
      ) : null}

      {dueMinute != null ? (
        <fieldset className={s.field}>
          <legend>תזכורת</legend>
          <div className={s.chips}>
            {REMIND_OFFSET_CHOICES.map((c) => (
              <Chip key={c.minutes} on={remind === c.minutes} onClick={() => setRemind(c.minutes)}>{c.label}</Chip>
            ))}
            <Chip on={remind === null} onClick={() => setRemind(null)}>בלי תזכורת</Chip>
          </div>
          {remind !== null ? (
            <p className={s.hint}>התזכורת תישלח בדיוק בשעה שבחרת — גם בשעות השקטות — בתוך דוביז, ובטלפון אם הפעלת התראות.</p>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset className={s.field}>
        <legend>חזרה</legend>
        <div className={s.chips}>
          {(
            [
              ["ONCE", "פעם אחת"],
              ["DAILY", "כל יום"],
              ["WEEKLY", "כל שבוע"],
              ["MONTHLY", "כל חודש"],
            ] as const
          ).map(([k, label]) => (
            <Chip
              key={k}
              on={repeat === k}
              onClick={() => {
                setRepeat(k);
                if (k !== "ONCE" && day === null) setDay(today);
              }}
            >
              {label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <div className={s.field}>
        <label htmlFor={`${ids}-l`}>קשור ל (לא חובה)</label>
        {link ? (
          <div className={s.linked}>
            <span style={{ flex: 1 }}>
              {link.label} <span className={s.hint}>· {link.kind === "customer" ? "לקוח" : "ספק"}</span>
            </span>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => { setLink(null); setQ(""); }}>
              הסר
            </button>
          </div>
        ) : (
          <>
            <input
              id={`${ids}-l`}
              className={s.input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="חיפוש לקוח או ספק"
              autoComplete="off"
            />
            {options && q.trim().length >= 2 ? (
              <div className={s.pick} role="list">
                <div className={s.pickHead}>
                  {options.length === 0 ? "לא נמצא — אפשר לשמור בלי קישור" : `נמצאו ${options.length} — בחר אחד, או השאר בלי קישור`}
                </div>
                {options.map((o) => (
                  <div key={`${o.kind}:${o.id}`} className={s.pickRow} role="listitem">
                    <span>
                      {o.label} <small>· {o.kind === "customer" ? "לקוח" : "ספק"}</small>
                    </span>
                    <button type="button" className={s.chip} onClick={() => setLink(o)}>
                      בחר
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className={s.field}>
        <label htmlFor={`${ids}-n`}>פירוט (לא חובה)</label>
        <textarea
          id={`${ids}-n`}
          className={s.input}
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {summary ? <p className={s.summary} aria-live="polite">{summary}</p> : null}
      {AMOUNT_HINT.test(title) ? (
        <p className={s.hint}>
          הוקלד סכום? סכום לא נשמר על משימה. לתשלום שהעסק צריך לשלם —{" "}
          <Link href="/payables?new=1" prefetch={false}>קליטת התחייבות</Link>.
        </p>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      <div className={s.actions}>
        <button type="submit" className={`${s.btn} ${s.pri}`} disabled={!clean || busy}>
          {busy ? "שומר…" : "שמירה"}
        </button>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel} disabled={busy}>
          ביטול
        </button>
      </div>
    </form>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`${s.chip} ${on ? s.chipOn : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}
