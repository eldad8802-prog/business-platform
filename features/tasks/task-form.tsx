"use client";

/**
 * Daily Tasks — the one task form (owner-approved mockup "יצירה ופרטים"): a panel on desktop, a dialog on tablet,
 * a bottom sheet on mobile (the caller decides the frame). Used by the task centre and the secretary's capture.
 *
 *   - "מה צריך לעשות?" (required), "מתי" (היום / מחר / a day / ללא תאריך), "חזרה" (פעם אחת / כל יום / כל שבוע /
 *     כל חודש — weekly and monthly follow the chosen day), "קשור ל" (optional: an explicit pick, never a guess);
 *   - a summary sentence before saving;
 *   - a typed amount is not stored on a task: the form points to the commitment flow instead (spec 5.1).
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";

import {
  createSeries,
  createTask,
  errorText,
  searchLinks,
  uuidV7,
  type LinkOption,
  type RuleInput,
} from "@/lib/tasks/tasks-client";

import { addDays, chipLabel, todayKey, weekdayLong, weekdayOf, whenPhrase } from "./task-days";
import s from "./tasks.module.css";

type Repeat = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";

const AMOUNT_HINT = /(₪|ש"ח|שח|\d{3,})/;

export function TaskForm({
  origin = "OWNER",
  onDone,
  onCancel,
  titleId,
  heading,
}: {
  origin?: "OWNER" | "SECRETARY";
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  titleId?: string;
  heading?: string;
}) {
  const { t } = useI18n();
  const today = todayKey();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // One intent per opened form: a double click or a retry after a lost answer is the same create (12.9).
  const intent = useRef(uuidV7()).current;
  const [title, setTitle] = useState("");
  const [day, setDay] = useState<string | null>(today);
  const [custom, setCustom] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("ONCE");
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<LinkOption[] | null>(null);
  const [link, setLink] = useState<LinkOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (link || q.trim().length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchLinks(q)
        .then((r) => !cancelled && setOptions(r.options))
        .catch(() => !cancelled && setOptions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, link]);

  const startOn = day ?? today;
  const rule: RuleInput | null =
    repeat === "DAILY" ? { kind: "DAILY" }
    : repeat === "WEEKLY" ? { kind: "WEEKDAYS", weekdays: [weekdayOf(startOn)] }
    : repeat === "MONTHLY" ? { kind: "MONTH_DAY", monthDay: Math.min(Number(startOn.slice(8, 10)), 31) }
    : null;

  const cadence =
    repeat === "DAILY" ? t("tasks.form.daily")
    : repeat === "WEEKLY" ? t("tasks.form.cadenceWeekday", { weekday: weekdayLong(weekdayOf(startOn), t) })
    : repeat === "MONTHLY" ? t("tasks.form.cadenceMonthDay", { day: Number(startOn.slice(8, 10)) })
    : null;

  const clean = title.trim();
  const summary = !clean
    ? null
    : cadence
      ? startOn === today
        ? t("tasks.form.summarySeriesToday", { cadence, title: clean })
        : startOn === addDays(today, 1)
          ? t("tasks.form.summarySeriesTomorrow", { cadence, title: clean })
          : t("tasks.form.summarySeriesFrom", { cadence, date: chipLabel(startOn, t), title: clean })
      : day
        ? t("tasks.form.summaryRemind", { when: whenPhrase(day, today, t), title: clean })
        : t("tasks.form.summaryNoDate", { title: clean });

  async function save() {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const l = link ? { kind: link.kind, id: link.id } : null;
      if (rule) await createSeries(intent, { title: clean, link: l, rule, startOn });
      else await createTask(intent, { title: clean, dueOn: day, link: l, origin });
      await onDone();
    } catch (e) {
      setError(errorText(e, t));
      setBusy(false);
    }
  }

  const chosenOther = day && day !== today && day !== addDays(today, 1);

  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id={titleId}>{heading ?? t("tasks.common.newTask")}</h2>

      <div className={s.field}>
        <label htmlFor={`${ids}-t`}>{t("tasks.form.whatToDo")}</label>
        <input
          ref={inputRef}
          id={`${ids}-t`}
          className={s.input}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("tasks.form.placeholder")}
          autoComplete="off"
          required
        />
      </div>

      <fieldset className={s.field}>
        <legend>{t("tasks.form.when")}</legend>
        <div className={s.chips}>
          <Chip on={day === today && !custom} onClick={() => { setDay(today); setCustom(false); }}>{t("tasks.common.dayToday")}</Chip>
          <Chip on={day === addDays(today, 1) && !custom} onClick={() => { setDay(addDays(today, 1)); setCustom(false); }}>{t("tasks.common.tomorrow")}</Chip>
          <Chip on={custom || !!chosenOther} onClick={() => { setCustom(true); if (!day) setDay(addDays(today, 2)); }}>
            {chosenOther ? chipLabel(day!, t) : t("tasks.form.otherDate")}
          </Chip>
          {repeat === "ONCE" ? (
            <Chip on={day === null} onClick={() => { setDay(null); setCustom(false); }}>{t("tasks.form.noDate")}</Chip>
          ) : null}
        </div>
        {custom ? (
          <input
            type="date"
            className={s.input}
            aria-label={t("tasks.form.pickDate")}
            min={today}
            value={day ?? ""}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        ) : null}
      </fieldset>

      <fieldset className={s.field}>
        <legend>{t("tasks.form.repeat")}</legend>
        <div className={s.chips}>
          {(
            [
              ["ONCE", "tasks.form.once"],
              ["DAILY", "tasks.form.daily"],
              ["WEEKLY", "tasks.form.weekly"],
              ["MONTHLY", "tasks.form.monthly"],
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
              {t(label)}
            </Chip>
          ))}
        </div>
      </fieldset>

      <div className={s.field}>
        <label htmlFor={`${ids}-l`}>{t("tasks.form.linkLabel")}</label>
        {link ? (
          <div className={s.linked}>
            <span style={{ flex: 1 }}>
              {link.label} <span className={s.hint}>· {link.kind === "customer" ? t("tasks.common.customer") : t("tasks.common.supplier")}</span>
            </span>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => { setLink(null); setQ(""); }}>
              {t("tasks.form.remove")}
            </button>
          </div>
        ) : (
          <>
            <input
              id={`${ids}-l`}
              className={s.input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("tasks.form.searchPlaceholder")}
              autoComplete="off"
            />
            {options && q.trim().length >= 2 ? (
              <div className={s.pick} role="list">
                <div className={s.pickHead}>
                  {options.length === 0 ? t("tasks.form.notFound") : t("tasks.form.found", { count: options.length })}
                </div>
                {options.map((o) => (
                  <div key={`${o.kind}:${o.id}`} className={s.pickRow} role="listitem">
                    <span>
                      {o.label} <small>· {o.kind === "customer" ? t("tasks.common.customer") : t("tasks.common.supplier")}</small>
                    </span>
                    <button type="button" className={s.chip} onClick={() => setLink(o)}>
                      {t("tasks.form.choose")}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {summary ? <p className={s.summary} aria-live="polite">{summary}</p> : null}
      {AMOUNT_HINT.test(title) ? (
        <p className={s.hint}>
          {t("tasks.form.amountHint")}{" "}
          <Link href="/secretary?screen=bank" prefetch={false}>{t("tasks.form.amountHintLink")}</Link>.
        </p>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      <div className={s.actions}>
        <button type="submit" className={`${s.btn} ${s.pri}`} disabled={!clean || busy}>
          {busy ? t("tasks.form.saving") : t("tasks.common.save")}
        </button>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel} disabled={busy}>
          {t("tasks.common.cancel")}
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
