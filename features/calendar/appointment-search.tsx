"use client";

/**
 * G8 — "חיפוש תור" in the calendar's header: a customer's name or phone (2 characters at least), upcoming appointments
 * first (soonest first), then recent past ones (latest first), at most 30. A result opens the appointment on its day.
 * Existing pieces only: the form's input and the customer field's result list (same classes), the header's icon button.
 */
import { useEffect, useState } from "react";

import { formatPhoneForDisplay } from "@/lib/format/phone-display";

import { CalendarApiError, searchAppointments, type SearchHitWire } from "./calendar-client";
import { errorText, STATUS_LABEL, type Names } from "./calendar-model";
import { IconX } from "./ui";
import s from "./calendar.module.css";

const WHEN = new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

export function AppointmentSearch({ names, onOpen, onClose }: { names: Names; onOpen: (hit: SearchHitWire) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchHitWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const query = q.trim();
  const ready = query.length >= 2;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const h = window.setTimeout(() => {
      setRows(null);
      setError(null);
      searchAppointments(query)
        .then((r) => { if (!cancelled) setRows(r); })
        .catch((e) => { if (!cancelled) { setRows([]); setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); } });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(h); };
  }, [query, ready, tick]);

  const upcoming = rows?.filter((r) => r.upcoming) ?? [];
  const past = rows?.filter((r) => !r.upcoming) ?? [];
  const line = (r: SearchHitWire) => {
    const who = r.customerName ?? r.title ?? "תור";
    const service = r.businessServiceId !== null ? names.services.get(r.businessServiceId) : undefined;
    const staff = r.staffMemberId !== null ? names.staff.get(r.staffMemberId)?.displayName : undefined;
    return (
      <button key={r.id} type="button" role="option" aria-selected={false} className={s.result} onClick={() => onOpen(r)}>
        <span>{who}{service ? ` · ${service}` : ""}</span>
        <small>
          {r.startsAt ? <bdi dir="ltr">{WHEN.format(new Date(r.startsAt))}</bdi> : null}
          {staff ? ` · ${staff}` : ""}
          {r.status !== "CONFIRMED" ? ` · ${STATUS_LABEL[r.status as keyof typeof STATUS_LABEL] ?? ""}` : ""}
        </small>
      </button>
    );
  };

  return (
    <div className={s.line} role="search">
      <label className={s.label} htmlFor="appt-search">חיפוש תור</label>
      <div className={s.lineMain}>
        <input id="appt-search" type="search" className={s.input} value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off"
          placeholder="שם לקוח או טלפון" aria-describedby="appt-search-hint" />
        <button type="button" className={s.iconBtn} aria-label="סגירת החיפוש" onClick={onClose}><IconX size={20} /></button>
      </div>
      {!ready ? <p className={s.hint} id="appt-search-hint">לפחות 2 תווים. תורים קרובים מופיעים ראשונים.</p> : null}
      {ready ? (
        <div className={s.results} role="listbox" aria-label="תוצאות החיפוש">
          {rows === null ? <span className={`${s.result} ${s.resultNone}`}>מחפש…</span> : null}
          {error ? <span className={`${s.result} ${s.resultNone}`}>{error} <button type="button" className={s.linkBtn} onClick={() => setTick((x) => x + 1)}>לנסות שוב</button></span> : null}
          {rows && !error && !rows.length ? (
            <span className={`${s.result} ${s.resultNone}`}>
              לא נמצא תור ל„{/^[\d\s+().-]+$/.test(query) ? <bdi dir="ltr">{formatPhoneForDisplay(query)}</bdi> : query}”.
            </span>
          ) : null}
          {upcoming.length ? <span className={`${s.result} ${s.resultNone}`}><strong>קרובים</strong></span> : null}
          {upcoming.map(line)}
          {past.length ? <span className={`${s.result} ${s.resultNone}`}><strong>קודמים</strong></span> : null}
          {past.map(line)}
        </div>
      ) : null}
    </div>
  );
}
