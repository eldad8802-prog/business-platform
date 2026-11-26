"use client";

/**
 * G7 — the "חגים" tab of the special-days screen (design proposal e, owner-approved 2026-11-24; business scope only).
 * The Israeli holidays still ahead, from a static, verified table (lib/services/appointment/israeli-holidays.ts),
 * grouped by Hebrew year ("חגי תשפ״ז — סגור"): one row per holiday with its dates, the main holidays ticked, Chol
 * HaMoed and Yom HaZikaron offered unticked. "ערבי חג — יום קצר עד" sets the closing time of each ticked holiday's
 * eve (13:00; "ללא" keeps eves as they are). The counts are asked from the server whenever the choice changes (a dry
 * run): how many days will change and how many existing appointments fall on them — those are never cancelled.
 * "החלה על N ימים" writes them as special days; a day that already has the same closure is left alone.
 */
import { useEffect, useMemo, useState } from "react";

import { HEBREW_YEARS, holidayGroupRows, idsForRows, type HolidayGroupRow } from "@/lib/services/appointment/israeli-holidays";

import { applyHolidays, CalendarApiError, type ClosureOutcomeWire } from "./calendar-client";
import { clock, errorText } from "./calendar-model";
import s from "./calendar.module.css";

const YEAR_NAME: Record<number, string> = { 5787: "תשפ״ז", 5788: "תשפ״ח" };
/** Eve closing times offered: 11:00–16:00 every half hour. */
const EVE_TIMES = Array.from({ length: 11 }, (_, i) => 660 + i * 30);
const NO_EVES = -1;

const dm = (dayKey: string) => `${Number(dayKey.slice(8, 10))}.${Number(dayKey.slice(5, 7))}`;
const dates = (r: HolidayGroupRow) => (r.fromDay === r.toDay ? dm(r.fromDay) : `${dm(r.fromDay)}–${dm(r.toDay)}`);

export function HolidayClosures({ today, onChanged }: { today: string; onChanged: (message: string) => void }) {
  const years = useMemo(() => HEBREW_YEARS.map((y) => ({ year: y, rows: holidayGroupRows(y, today) })).filter((y) => y.rows.length > 0), [today]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(years.flatMap((y) => y.rows.filter((r) => r.defaultOn).map((r) => r.id))));
  const [eveMinute, setEveMinute] = useState(780);
  const [preview, setPreview] = useState<ClosureOutcomeWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const ids = useMemo(
    () => idsForRows(years.flatMap((y) => y.rows).filter((r) => picked.has(r.id)), eveMinute !== NO_EVES),
    [years, picked, eveMinute],
  );
  const closing = eveMinute === NO_EVES ? 780 : eveMinute;

  useEffect(() => {
    if (!ids.length) return;
    let cancelled = false;
    const h = window.setTimeout(() => {
      setPreview(null);
      applyHolidays({ holidays: ids, eveClosingMinute: closing, dryRun: true })
        .then((r) => { if (!cancelled) { setPreview(r); setError(null); } })
        .catch((e) => { if (!cancelled) setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(h); };
  }, [ids, closing, tick]);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await applyHolidays({ holidays: ids, eveClosingMinute: closing });
      setTick((x) => x + 1);
      onChanged(out.created ? `נוספו ${out.created.toLocaleString("he-IL")} ימים מיוחדים לחגים` : "כל החגים שנבחרו כבר היו מוגדרים");
    } catch (e) {
      setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK"));
    } finally {
      setBusy(false);
    }
  };

  if (!years.length) return <p className={s.note}>אין חגים ברשימה מהיום והלאה.</p>;
  const shown = ids.length ? preview : null;

  return (
    <div className={s.copyBox}>
      {years.map((y) => (
        <section key={y.year} aria-label={`חגי ${YEAR_NAME[y.year]}`}>
          <span className={s.label}>חגי {YEAR_NAME[y.year]} — סגור</span>
          <ul className={s.list}>
            {y.rows.map((r) => (
              <li key={r.id} className={s.setRow}>
                <label className={s.check} htmlFor={`hol-${r.id}`}>
                  <input id={`hol-${r.id}`} type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                  {r.name}
                </label>
                <span className={s.hint} dir="ltr">{dates(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className={s.setRow}>
        <label htmlFor="hol-eve">ערבי חג — יום קצר עד</label>
        <select id="hol-eve" className={s.input} style={{ maxWidth: 150 }} value={eveMinute} onChange={(e) => setEveMinute(Number(e.target.value))}>
          {EVE_TIMES.map((m) => <option key={m} value={m}>{clock(m)}</option>)}
          <option value={NO_EVES}>ללא (רגיל)</option>
        </select>
      </div>
      {shown ? (
        <div className={s.warnBox} role="status">
          {shown.appointmentsAffected
            ? <span>{shown.appointmentsAffected.toLocaleString("he-IL")} תורים קיימים נופלים בימים שנבחרו. הם לא יבוטלו; אפשר לראות אותם ביומן ולהזיז.</span>
            : <span>אין תורים קיימים בימים שנבחרו.</span>}
          {shown.skipped ? <span>{shown.skipped.toLocaleString("he-IL")} ימים כבר מוגדרים ולא ישתנו.</span> : null}
        </div>
      ) : null}
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <button type="button" className={`${s.btn} ${s.btnPri} ${s.btnWide}`} disabled={busy || !ids.length || !shown || !shown.created} onClick={() => void apply()}>
        {busy ? "שומר…" : shown ? `החלה על ${shown.created.toLocaleString("he-IL")} ימים` : ids.length ? "בודק…" : "לא נבחר חג"}
      </button>
    </div>
  );
}
