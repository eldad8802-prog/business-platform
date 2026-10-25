"use client";

/**
 * One appointment (Appointments milestone B): what it is, when, with whom, where, its history from the journal, and
 * what the owner may do with it now — the lifecycle's own moves (appointment.lifecycle): אשר · הושלם · לא הגיע ·
 * הזז · ערוך · בטל. Every change sends the version it saw; a stale one answers VERSION_CONFLICT and the panel
 * reloads instead of overwriting. Cancelling asks why (the closed reason) and may keep a short free-text note.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { uuidV7 } from "@/lib/tasks/tasks-client";
import t from "@/features/tasks/tasks.module.css";

import { CalendarApiError, changeStatus, forgetIntent, getAppointment, updateDetails } from "./calendar-client";
import {
  ACTOR_LABEL,
  actionsFor,
  CANCEL_REASON_LABEL,
  clockOf,
  durationLabel,
  durationOf,
  errorText,
  EVENT_LABEL,
  headline,
  KIND_LABEL,
  LIMITS,
  LOCATION_LABEL,
  OWNER_CANCEL_REASONS,
  STATUS_LABEL,
  STATUS_TO,
  textProblem,
  timeLabel,
  type AppointmentWire,
  type HistoryWire,
  type Names,
} from "./calendar-model";
import s from "./calendar.module.css";

const DATE_LONG = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });
const STAMP = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

type Mode = "view" | "cancel" | "edit";

export function AppointmentDetails({
  id,
  names,
  onChanged,
  onMove,
  onClose,
}: {
  id: number;
  names: Names;
  /** After any change: the screen reloads the range and says `message`. */
  onChanged: (message: string) => void;
  onMove: (appt: AppointmentWire) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ appointment: AppointmentWire; history: HistoryWire[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getAppointment(id)
      .then((d) => { if (!cancelled) { setData(d); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [id, stamp]);

  if (loadError) {
    return (
      <div className={t.placeholder}>
        <p className={t.error}>{loadError}</p>
        <button type="button" className={t.btn} onClick={onClose}>סגירה</button>
      </div>
    );
  }
  if (!data) return <p className={t.hint} aria-busy="true">טוען…</p>;

  const a = data.appointment;
  const actions = actionsFor(a);
  const customer = a.customerId !== null ? names.customers.get(a.customerId) : undefined;
  const service = a.businessServiceId !== null ? names.services.get(a.businessServiceId) : undefined;
  const staff = a.staffMemberId !== null ? names.staff.get(a.staffMemberId) : undefined;
  const minutes = durationOf(a);

  const runStatus = async (to: keyof typeof STATUS_TO, extra: { cancelReason?: string; reason?: string | null } = {}) => {
    const intent = `appt:status:${a.id}:${to}:${a.version}`;
    setBusy(true);
    setError(null);
    try {
      await changeStatus(intent, a.id, { to: STATUS_TO[to], expectedVersion: a.version, ...extra });
      const words = { confirm: "התור אושר", complete: "סומן כהושלם", no_show: "סומן כלא הגיע", cancel: a.kind === "BLOCK" ? "החסימה בוטלה" : "בוטל" } as const;
      setMode("view");
      setStamp((x) => x + 1);
      onChanged(words[to]);
    } catch (e) {
      forgetIntent(intent);
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setError(errorText(err.code, err.status));
      if (err.code === "VERSION_CONFLICT" || err.code === "INVALID_TRANSITION") setStamp((x) => x + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className={t.detH}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={`${s.status} ${s[`st_${a.status}`]}`}>{a.kind === "BLOCK" ? KIND_LABEL.BLOCK : STATUS_LABEL[a.status]}</span>
          <h2 id="appointment-details-title">{headline(a, names)}</h2>
        </div>
        <button type="button" className={t.more} aria-label="סגירה" onClick={onClose}>✕</button>
      </div>

      <dl className={t.kv}>
        <dt>מתי</dt>
        <dd>{a.startsAt ? `${DATE_LONG.format(new Date(a.startsAt))} · ${timeLabel(a)}` : "ללא מועד"}{minutes ? ` (${durationLabel(minutes)})` : ""}</dd>
        {a.kind !== "BLOCK" ? <><dt>סוג</dt><dd>{KIND_LABEL[a.kind]}</dd></> : null}
        {a.customerId !== null ? (
          <><dt>לקוח</dt><dd><Link href={`/customers/${a.customerId}`} prefetch={false}>{customer ?? "כרטיס הלקוח"}</Link></dd></>
        ) : null}
        {service ? <><dt>שירות</dt><dd>{service}</dd></> : null}
        <dt>{a.kind === "BLOCK" ? "חסום עבור" : "עובד"}</dt>
        <dd>{staff ? <><span className={s.swatch} style={{ ["--lane" as string]: staff.color ?? undefined, display: "inline-block", verticalAlign: "middle", marginInlineEnd: 6 }} />{staff.displayName}</> : a.kind === "BLOCK" ? "כל העסק" : "ללא עובד מסוים"}</dd>
        {a.locationKind || a.locationDetail ? (
          <><dt>מיקום</dt><dd>{[a.locationKind ? LOCATION_LABEL[a.locationKind] : null, a.locationDetail].filter(Boolean).join(" · ")}</dd></>
        ) : null}
        {a.leadId !== null ? <><dt>ליד</dt><dd><Link href={`/leads/${a.leadId}`} prefetch={false}>הליד המקושר</Link></dd></> : null}
        {a.cancelReason ? <><dt>סיבת ביטול</dt><dd>{CANCEL_REASON_LABEL[a.cancelReason]}</dd></> : null}
      </dl>

      {a.notes ? <p className={t.noteText}>{a.notes}</p> : null}

      {mode === "view" && actions.length ? (
        <div className={t.actGroup}>
          <div className={t.actMain}>
            {actions.includes("confirm") ? <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={() => void runStatus("confirm")}>אשר</button> : null}
            {actions.includes("complete") ? <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={() => void runStatus("complete")}>הושלם</button> : null}
            {actions.includes("no_show") ? <button type="button" className={t.btn} disabled={busy} onClick={() => void runStatus("no_show")}>לא הגיע</button> : null}
            {actions.includes("move") ? <button type="button" className={t.btn} disabled={busy} onClick={() => onMove(a)}>הזז</button> : null}
          </div>
          <div className={t.actMore}>
            {actions.includes("edit") ? <button type="button" className={`${t.btn} ${t.ghost}`} disabled={busy} onClick={() => setMode("edit")}>עריכת פרטים</button> : null}
          </div>
          <div className={t.actEnd}>
            <button type="button" className={`${t.btn} ${t.ghost} ${t.danger}`} disabled={busy} onClick={() => setMode("cancel")}>{a.kind === "BLOCK" ? "ביטול החסימה" : "ביטול התור"}</button>
          </div>
        </div>
      ) : null}

      {mode === "cancel" ? <CancelBox appt={a} busy={busy} onCancel={() => setMode("view")} onConfirm={(reason, note) => void runStatus("cancel", { cancelReason: reason, reason: note })} /> : null}
      {mode === "edit" ? (
        <EditBox
          appt={a}
          onCancel={() => setMode("view")}
          onSaved={() => { setMode("view"); setStamp((x) => x + 1); onChanged("הפרטים נשמרו"); }}
          onStale={() => setStamp((x) => x + 1)}
        />
      ) : null}

      {error ? <p className={t.error} role="alert">{error}</p> : null}

      {data.history.length ? (
        <ul className={t.hist} aria-label="היסטוריה">
          {data.history.map((h, i) => (
            <li key={i}>
              <time dateTime={h.at}>{STAMP.format(new Date(h.at))}</time>
              <span>{EVENT_LABEL[h.type] ?? "שינוי"}{ACTOR_LABEL[h.actor] ? ` · ${ACTOR_LABEL[h.actor]}` : ""}{historyDetail(h)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A move's new time, when the journal says it (short tokens only — the journal never holds free text). */
function historyDetail(h: HistoryWire): string {
  if (h.type === "APPOINTMENT_RESCHEDULED" && typeof h.payload.toStartsAt === "string") {
    const d = new Date(h.payload.toStartsAt);
    if (!Number.isNaN(d.getTime())) return ` ל־${new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", timeZone: "Asia/Jerusalem" }).format(d)} ${clockOf(d)}`;
  }
  return "";
}

function CancelBox({ appt, busy, onCancel, onConfirm }: { appt: AppointmentWire; busy: boolean; onCancel: () => void; onConfirm: (reason: string, note: string | null) => void }) {
  const [reason, setReason] = useState<string>("OWNER_CANCELED");
  const [note, setNote] = useState("");
  // The note is added to the appointment's notes, which hold at most 4,000 characters (the database's bound).
  const room = LIMITS.notes - ((appt.notes?.length ?? 0) + (appt.notes ? 1 : 0));
  const problem = textProblem("ההסבר", note, LIMITS.cancelReason)
    ?? (note.trim().length > room ? `ההסבר יתווסף להערות התור, ונשאר בהן מקום ל־${Math.max(0, room).toLocaleString("he-IL")} תווים בלבד.` : null);
  return (
    <div className={t.form} style={{ gap: 10 }}>
      <span className={t.hint}>{appt.kind === "BLOCK" ? "לבטל את החסימה? הזמן יתפנה ביומן." : "למה התור מבוטל? הזמן יתפנה ביומן."}</span>
      {appt.kind !== "BLOCK" ? (
        <div className={t.chips} role="radiogroup" aria-label="סיבת הביטול">
          {OWNER_CANCEL_REASONS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={reason === r} className={`${t.chip} ${reason === r ? t.chipOn : ""}`} onClick={() => setReason(r)}>
              {CANCEL_REASON_LABEL[r]}
            </button>
          ))}
        </div>
      ) : null}
      <div className={t.field}>
        <label htmlFor="cancel-note">הסבר קצר (לא חובה)</label>
        <input id="cancel-note" className={t.input} value={note} maxLength={LIMITS.cancelReason + 50} onChange={(e) => setNote(e.target.value)} />
        {problem ? <span className={t.error}>{problem}</span> : null}
      </div>
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.danger}`} disabled={busy || !!problem} onClick={() => onConfirm(reason, note.trim() || null)}>
          {busy ? "מבטל…" : appt.kind === "BLOCK" ? "בטל את החסימה" : "בטל את התור"}
        </button>
        <button type="button" className={t.btn} onClick={onCancel} disabled={busy}>חזרה</button>
      </div>
    </div>
  );
}

function EditBox({ appt, onCancel, onSaved, onStale }: { appt: AppointmentWire; onCancel: () => void; onSaved: () => void; onStale: () => void }) {
  const [title, setTitle] = useState(appt.title ?? "");
  const [notes, setNotes] = useState(appt.notes ?? "");
  const [locationKind, setLocationKind] = useState(appt.locationKind ?? "");
  const [locationDetail, setLocationDetail] = useState(appt.locationDetail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(`appt:details:${appt.id}:${uuidV7()}`);
  const problem = textProblem("הכותרת", title, LIMITS.title) ?? textProblem("ההערות", notes, LIMITS.notes) ?? textProblem("פרטי המיקום", locationDetail, LIMITS.locationDetail);

  const save = async () => {
    if (problem) { setError(problem); return; }
    const body: Record<string, string | null> = {};
    if (title.trim() !== (appt.title ?? "")) body.title = title.trim() || null;
    if (notes.trim() !== (appt.notes ?? "")) body.notes = notes.trim() || null;
    if (appt.kind !== "BLOCK" && (locationKind || null) !== appt.locationKind) body.locationKind = locationKind || null;
    if (appt.kind !== "BLOCK" && locationDetail.trim() !== (appt.locationDetail ?? "")) body.locationDetail = locationDetail.trim() || null;
    if (!Object.keys(body).length) { onCancel(); return; }
    setBusy(true);
    setError(null);
    try {
      await updateDetails(intent.current, appt.id, { ...body, expectedVersion: appt.version });
      onSaved();
    } catch (e) {
      forgetIntent(intent.current);
      intent.current = `appt:details:${appt.id}:${uuidV7()}`;
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setError(errorText(err.code, err.status));
      if (err.code === "VERSION_CONFLICT") onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={t.form} style={{ gap: 10 }}>
      <div className={t.field}>
        <label htmlFor="edit-title">כותרת</label>
        <input id="edit-title" className={t.input} value={title} maxLength={LIMITS.title + 50} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {appt.kind !== "BLOCK" ? (
        <div className={s.row2}>
          <div className={t.field}>
            <label htmlFor="edit-location">מיקום</label>
            <select id="edit-location" className={t.input} value={locationKind} onChange={(e) => setLocationKind(e.target.value as typeof locationKind)}>
              <option value="">לא צוין</option>
              {(["IN_PERSON", "PHONE", "ONLINE"] as const).map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
            </select>
          </div>
          <div className={t.field}>
            <label htmlFor="edit-location-detail">פרטי מיקום</label>
            <input id="edit-location-detail" className={t.input} value={locationDetail} maxLength={LIMITS.locationDetail + 50} onChange={(e) => setLocationDetail(e.target.value)} />
          </div>
        </div>
      ) : null}
      <div className={t.field}>
        <label htmlFor="edit-notes">הערות</label>
        <textarea id="edit-notes" className={t.input} rows={4} value={notes} maxLength={LIMITS.notes + 200} onChange={(e) => setNotes(e.target.value)} />
        {notes.length > LIMITS.notes * 0.8 ? <span className={`${s.counter} ${notes.length > LIMITS.notes ? s.counterOver : ""}`}>{notes.length.toLocaleString("he-IL")} / {LIMITS.notes.toLocaleString("he-IL")}</span> : null}
      </div>
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      <div className={t.actions}>
        <button type="button" className={`${t.btn} ${t.pri}`} disabled={busy} onClick={() => void save()}>{busy ? "שומר…" : "שמירה"}</button>
        <button type="button" className={t.btn} disabled={busy} onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}
