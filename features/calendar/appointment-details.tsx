"use client";

/**
 * One appointment (design direction A): its state in words and an icon, who and what, when, the staff member's colour,
 * a call and a WhatsApp link when a phone is known (plain links — nothing is sent by Dubiz), its details, its history,
 * and what the owner may do NOW — the lifecycle's own moves (appointment.lifecycle), one main action for the state:
 *   ממתין לאישור → אישור התור · מאושר, לפני ההתחלה → שינוי מועד · מאושר, אחרי ההתחלה → התקיים / לא הגיע
 *   (each asks once more and says it cannot be undone) · חסימה → שינוי מועד · סופי → קביעת תור חדש ללקוח.
 * Every change sends the version it saw; a stale one answers VERSION_CONFLICT and the panel reloads instead of
 * overwriting. Cancelling asks why (the closed reason) and may keep a short note.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { telHref, whatsAppChatHref } from "@/components/customers/customer-contact";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { uuidV7 } from "@/lib/tasks/tasks-client";

import { CalendarApiError, changeStatus, customerName, forgetIntent, getAppointment, updateDetails, type CustomerWire } from "./calendar-client";
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
  isTerminal,
  KIND_LABEL,
  LIMITS,
  LOCATION_LABEL,
  OWNER_CANCEL_REASONS,
  requestOutcome,
  STATUS_LABEL,
  STATUS_TO,
  textProblem,
  timeLabel,
  type AppointmentWire,
  type HistoryWire,
  type Names,
} from "./calendar-model";
import { Chevron, IconChat, IconEdit, IconMove, IconPhone, IconPlus, IconUser, IconX, Loading, markOf, StateMark } from "./ui";
import s from "./calendar.module.css";

const DATE_LONG = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });
const STAMP = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

type Mode = "view" | "cancel" | "edit" | "complete" | "no_show";

export function AppointmentDetails({
  id,
  names,
  onChanged,
  onMove,
  onRebook,
  onClose,
}: {
  id: number;
  names: Names;
  /** After any change: the screen reloads the range and says `message`. */
  onChanged: (message: string) => void;
  onMove: (appt: AppointmentWire) => void;
  /** "קביעת תור חדש" for the same customer, after a final state. */
  onRebook: (customer: CustomerWire) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ appointment: AppointmentWire; history: HistoryWire[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerWire | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getAppointment(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadError(null);
        // The customer's phone (for the call / WhatsApp links) — the card's first section; nothing if it fails.
        if (d.appointment.customerId !== null) customerName(d.appointment.customerId).then((c) => { if (!cancelled) setCustomer(c); }).catch(() => undefined);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")); });
    return () => { cancelled = true; };
  }, [id, stamp]);

  if (loadError) {
    return (
      <div className={s.placeholder}>
        <p className={s.fieldErr} role="alert">{loadError}</p>
        <div className={s.actionsRow}>
          <button type="button" className={s.btn} onClick={() => { setLoadError(null); setStamp((x) => x + 1); }}>לנסות שוב</button>
          <button type="button" className={s.btn} onClick={onClose}>סגירה</button>
        </div>
      </div>
    );
  }
  if (!data) return <Loading label="טוען את פרטי התור" rows={5} />;

  const a = data.appointment;
  const now = new Date();
  const actions = actionsFor(a, now);
  const custName = a.customerName ?? (a.customerId !== null ? names.customers.get(a.customerId) : undefined) ?? customer?.name;
  const service = a.businessServiceId !== null ? names.services.get(a.businessServiceId) : undefined;
  const staff = a.staffMemberId !== null ? names.staff.get(a.staffMemberId) : undefined;
  const minutes = durationOf(a);
  const phone = customer?.phone ?? a.booking?.contactPhone ?? null;
  const tel = a.kind === "CUSTOMER" ? telHref(phone) : null;
  const whatsapp = a.kind === "CUSTOMER" ? whatsAppChatHref(phone) : null;
  const mark = markOf(a);
  const stateWord = a.kind === "BLOCK" ? (a.status === "CANCELED" ? "החסימה בוטלה" : KIND_LABEL.BLOCK) : STATUS_LABEL[a.status];
  const what = a.kind === "BLOCK" ? "החסימה" : a.kind === "INTERNAL" ? "הפגישה" : "התור";

  const runStatus = async (to: keyof typeof STATUS_TO, extra: { cancelReason?: string; reason?: string | null } = {}) => {
    // One status change at a time: a second tap while the first is on its way is ignored.
    if (inFlight.current) return;
    inFlight.current = true;
    const intent = `appt:status:${a.id}:${to}:${a.version}`;
    setBusy(true);
    setError(null);
    try {
      await changeStatus(intent, a.id, { to: STATUS_TO[to], expectedVersion: a.version, ...extra });
      const words = { confirm: "התור אושר", complete: "סומן שהתור התקיים", no_show: "סומן שהלקוח לא הגיע", cancel: a.kind === "BLOCK" ? "החסימה בוטלה" : a.kind === "INTERNAL" ? "הפגישה בוטלה" : "התור בוטל" } as const;
      setMode("view");
      setStamp((x) => x + 1);
      onChanged(words[to]);
    } catch (e) {
      forgetIntent(intent);
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setError(errorText(typeof err.details.reason === "string" ? err.details.reason : err.code, err.status));
      if (err.code === "VERSION_CONFLICT" || err.code === "INVALID_TRANSITION") setStamp((x) => x + 1);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const started = !a.startsAt || Date.parse(a.startsAt) <= now.getTime();

  return (
    <div className={s.sheet}>
      <div className={s.sheetHead}>
        <button type="button" className={`${s.iconBtn} ${s.sheetClose}`} aria-label="סגירה" onClick={onClose}><IconX size={20} /></button>
        <span className={`${s.status} ${s[`st_${a.kind === "BLOCK" && a.status !== "CANCELED" ? "BLOCK" : a.status}`]} ${s.sheetEnd}`}>
          {mark ? <StateMark mark={mark} /> : null}{stateWord}
        </span>
      </div>

      <div className={s.detTop}>
        <h2 id="appointment-details-title" className={s.detTitle}>{headline(a, names)}</h2>
        <p className={s.detWhen}>
          {a.startsAt ? <>{DATE_LONG.format(new Date(a.startsAt))} · <bdi dir="ltr">{timeLabel(a).replace(/[⁦⁩]/g, "")}</bdi></> : "ללא מועד"}
          {minutes ? ` (${durationLabel(minutes)})` : ""}
        </p>
        {staff || a.kind === "BLOCK" ? (
          <p className={s.detWhen} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {staff ? <><span className={s.dot} style={{ ["--lane" as string]: staff.color ?? "#b9b0a7" }} aria-hidden="true" />{staff.displayName}{staff.active ? "" : " (לא פעיל)"}</> : "כל העסק"}
          </p>
        ) : null}
      </div>

      {tel || whatsapp || a.customerId !== null ? (
        <div className={s.quick}>
          {tel ? <a className={s.btn} href={tel}><IconPhone size={18} /> חיוג</a> : null}
          {whatsapp ? <a className={s.btn} href={whatsapp} target="_blank" rel="noopener noreferrer"><IconChat size={18} /> WhatsApp</a> : null}
          {a.customerId !== null ? <Link className={s.btn} href={`/customers/${a.customerId}`} prefetch={false}><IconUser size={18} /> כרטיס לקוח</Link> : null}
        </div>
      ) : null}

      {mode === "view" ? (
        <div className={s.actionsCol}>
          {a.status === "PROPOSED" && actions.includes("confirm") ? (
            <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy} onClick={() => void runStatus("confirm")}>אישור {what}</button>
          ) : null}
          {actions.includes("complete") ? (
            <div className={s.actionsRow}>
              <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy} onClick={() => setMode("complete")}>התקיים</button>
              {actions.includes("no_show") ? <button type="button" className={s.btn} disabled={busy} onClick={() => setMode("no_show")}>לא הגיע</button> : null}
            </div>
          ) : null}
          {actions.length ? (
            <div className={s.actionsRow}>
              {actions.includes("move") ? <button type="button" className={`${s.btn} ${a.status === "CONFIRMED" && !started || a.kind === "BLOCK" ? s.btnPri : ""}`} disabled={busy} onClick={() => onMove(a)}><IconMove size={18} /> שינוי מועד</button> : null}
              {actions.includes("edit") ? <button type="button" className={s.btn} disabled={busy} onClick={() => setMode("edit")}><IconEdit size={18} /> עריכת פרטים</button> : null}
            </div>
          ) : null}
          {actions.includes("cancel") ? (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} style={{ color: "var(--ap-bad)", alignSelf: "flex-start" }} disabled={busy} onClick={() => setMode("cancel")}>
              {a.kind === "BLOCK" ? "הסרת החסימה" : a.kind === "INTERNAL" ? "ביטול הפגישה" : "ביטול התור"}
            </button>
          ) : null}
          {isTerminal(a.status) ? (
            <>
              <p className={s.finalNote}>{a.kind === "BLOCK" ? "החסימה הוסרה, והזמן פנוי ביומן." : `זה סטטוס סופי — אי אפשר לשנות את ${what} הזה.`}</p>
              {a.kind === "CUSTOMER" && a.customerId !== null && custName ? (
                <button type="button" className={`${s.btn} ${s.btnSoft}`} onClick={() => onRebook({ id: a.customerId!, name: custName, phone: customer?.phone ?? null })}>
                  <IconPlus size={18} /> קביעת תור חדש ל{custName}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {mode === "complete" || mode === "no_show" ? (
        <FinalConfirm
          kind={mode}
          busy={busy}
          onBack={() => setMode("view")}
          onConfirm={() => void runStatus(mode)}
        />
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

      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}

      <dl className={s.kv}>
        {a.kind !== "BLOCK" ? <><dt>סוג</dt><dd>{KIND_LABEL[a.kind]}</dd></> : null}
        {a.customerId !== null ? (
          <><dt>לקוח</dt><dd><Link href={`/customers/${a.customerId}`} prefetch={false}>{custName ?? "כרטיס הלקוח"}</Link>{phone && !a.booking ? <> · <bdi dir="ltr">{formatPhoneForDisplay(phone)}</bdi></> : null}</dd></>
        ) : null}
        {service ? <><dt>שירות</dt><dd>{service}</dd></> : null}
        {a.locationKind || a.locationDetail ? (
          <><dt>מיקום</dt><dd>{[a.locationKind ? LOCATION_LABEL[a.locationKind] : null].filter(Boolean).join("")}{a.locationKind && a.locationDetail ? " · " : ""}{a.locationDetail ? (/^https?:\/\//i.test(a.locationDetail) ? <a href={a.locationDetail} target="_blank" rel="noopener noreferrer" dir="ltr">{a.locationDetail}</a> : a.locationDetail) : null}</dd></>
        ) : null}
        {a.leadId !== null ? <><dt>ליד</dt><dd><Link href={`/leads/${a.leadId}`} prefetch={false}>הליד המקושר</Link></dd></> : null}
        {a.cancelReason ? <><dt>סיבת ביטול</dt><dd>{CANCEL_REASON_LABEL[a.cancelReason]}</dd></> : null}
        {a.booking ? (
          <>
            <dt>מקור</dt>
            <dd>
              הזמנה מהקישור · {requestOutcome({ status: a.booking.status, appointment: { status: a.status } }).label}
              {a.booking.status === "PENDING" ? <> · <Link href={`/calendar?view=requests&request=${a.booking.requestId}`} prefetch={false}>לבקשה</Link></> : null}
            </dd>
            <dt>מבקש/ת</dt>
            <dd>
              {a.booking.contactName}
              {a.booking.contactPhone ? <> · <bdi dir="ltr">{formatPhoneForDisplay(a.booking.contactPhone)}</bdi></> : null}
              {a.customerId === null ? <span className={s.hint}> · עוד לא מקושר/ת לכרטיס לקוח</span> : null}
            </dd>
            {a.booking.note ? <><dt>הערת הלקוח</dt><dd>{a.booking.note}</dd></> : null}
          </>
        ) : null}
      </dl>

      {a.notes ? <p className={s.notes}>{a.notes}</p> : null}

      {data.history.length ? (
        <div>
          <button type="button" className={s.fold} aria-expanded={showHistory} aria-controls={`hist-${a.id}`} onClick={() => setShowHistory(!showHistory)}>
            <span>היסטוריה ({data.history.length.toLocaleString("he-IL")})</span><Chevron dir={showHistory ? "up" : "down"} />
          </button>
          {showHistory ? (
            <ul className={s.hist} id={`hist-${a.id}`} aria-label="היסטוריה">
              {data.history.map((h, i) => (
                <li key={i}>
                  <time dateTime={h.at} dir="ltr">{STAMP.format(new Date(h.at))}</time>
                  <span>{EVENT_LABEL[h.type] ?? "שינוי"}{ACTOR_LABEL[h.actor] ? ` · ${ACTOR_LABEL[h.actor]}` : ""}{historyDetail(h, names)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the journal says about a change, in words (its payload holds short tokens only, never free text): a move's new
 * day and time, and the staff member it moved from and to; a cancellation's closed reason. Dates and times are
 * left-to-right isolates, so "27.10 12:00" never flips inside the Hebrew line.
 */
function historyDetail(h: HistoryWire, names: Names): string {
  const iso = (x: string) => `⁦${x}⁩`;
  const staffName = (v: unknown) => (typeof v === "number" ? names.staff.get(v)?.displayName ?? "עובד" : "ללא עובד");
  if (h.type === "APPOINTMENT_RESCHEDULED") {
    const parts: string[] = [];
    if (typeof h.payload.toStartsAt === "string") {
      const d = new Date(h.payload.toStartsAt);
      if (!Number.isNaN(d.getTime())) {
        parts.push(`ל־${iso(`${new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", timeZone: "Asia/Jerusalem" }).format(d)} ${clockOf(d)}`)}`);
      }
    }
    if ("toStaffMemberId" in h.payload && h.payload.fromStaffMemberId !== h.payload.toStaffMemberId) {
      parts.push(`מ${staffName(h.payload.fromStaffMemberId)} ל${staffName(h.payload.toStaffMemberId)}`);
    }
    return parts.length ? ` ${parts.join(" · ")}` : "";
  }
  if (h.type === "APPOINTMENT_CANCELED" && typeof h.payload.cancelReason === "string" && h.payload.cancelReason in CANCEL_REASON_LABEL) {
    return ` · ${CANCEL_REASON_LABEL[h.payload.cancelReason as keyof typeof CANCEL_REASON_LABEL]}`;
  }
  return "";
}

/** How long a confirm button waits after its box opens: the second tap of an opening double tap lands on nothing. */
const CONFIRM_ARM_MS = 700;

function useArmed() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const h = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => window.clearTimeout(h);
  }, []);
  return armed;
}

/** "התקיים" / "לא הגיע" are final: asked once more, saying so. */
function FinalConfirm({ kind, busy, onBack, onConfirm }: { kind: "complete" | "no_show"; busy: boolean; onBack: () => void; onConfirm: () => void }) {
  const armed = useArmed();
  return (
    <div className={s.confirm} role="alertdialog" aria-labelledby="final-q" aria-describedby="final-d">
      <strong id="final-q">{kind === "complete" ? "לסמן שהתור התקיים?" : "לסמן שהלקוח לא הגיע?"}</strong>
      <span id="final-d">אחרי הסימון אי אפשר להחזיר אותו.</span>
      <div className={s.confirmRow}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || !armed} onClick={onConfirm}>{busy ? "שומר…" : kind === "complete" ? "כן, התקיים" : "כן, לא הגיע"}</button>
        <button type="button" className={s.btn} disabled={busy} onClick={onBack}>חזרה</button>
      </div>
    </div>
  );
}

/**
 * The cancellation question. Safe against a double tap on the phone: the confirm button is disabled for a moment
 * after the box opens, and the button that sits where "ביטול התור" was is "חזרה" — a tap that lands there by
 * accident keeps the appointment.
 */
function CancelBox({ appt, busy, onCancel, onConfirm }: { appt: AppointmentWire; busy: boolean; onCancel: () => void; onConfirm: (reason: string, note: string | null) => void }) {
  const [reason, setReason] = useState<string>("OWNER_CANCELED");
  const [note, setNote] = useState("");
  const armed = useArmed();
  // The note is added to the appointment's notes, which hold at most 4,000 characters (the database's bound).
  const room = LIMITS.notes - ((appt.notes?.length ?? 0) + (appt.notes ? 1 : 0));
  const problem = textProblem("ההסבר", note, LIMITS.cancelReason)
    ?? (note.trim().length > room ? `ההסבר יתווסף להערות התור, ונשאר בהן מקום ל־${Math.max(0, room).toLocaleString("he-IL")} תווים בלבד.` : null);
  const block = appt.kind === "BLOCK";
  return (
    <div className={s.confirm}>
      <strong>{block ? "להסיר את החסימה? הזמן יתפנה ביומן." : appt.kind === "INTERNAL" ? "לבטל את הפגישה? הזמן יתפנה ביומן." : "למה התור מבוטל? הזמן יתפנה ביומן."}</strong>
      {!block ? (
        <div className={s.chips} role="radiogroup" aria-label="סיבת הביטול">
          {OWNER_CANCEL_REASONS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={reason === r} className={s.chip} onClick={() => setReason(r)}>
              {CANCEL_REASON_LABEL[r]}
            </button>
          ))}
        </div>
      ) : null}
      <div className={s.field}>
        <label className={s.label} htmlFor="cancel-note">הסבר קצר (לא חובה)</label>
        <input id="cancel-note" className={s.input} value={note} maxLength={LIMITS.cancelReason + 50} onChange={(e) => setNote(e.target.value)} />
        {problem ? <span className={s.fieldErr}>{problem}</span> : null}
      </div>
      <div className={s.actionsCol}>
        <button type="button" className={`${s.btn} ${s.btnDangerFill}`} disabled={busy || !!problem || !armed} aria-disabled={busy || !!problem || !armed} onClick={() => onConfirm(reason, note.trim() || null)}>
          {busy ? "מבטל…" : block ? "כן, להסיר את החסימה" : appt.kind === "INTERNAL" ? "כן, לבטל את הפגישה" : "כן, לבטל את התור"}
        </button>
        <button type="button" className={s.btn} onClick={onCancel} disabled={busy}>
          {block ? "חזרה, להשאיר את החסימה" : "חזרה, להשאיר את התור"}
        </button>
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
    <div className={s.confirm}>
      <strong>עריכת פרטים</strong>
      <div className={s.field}>
        <label className={s.label} htmlFor="edit-title">כותרת</label>
        <input id="edit-title" className={s.input} value={title} maxLength={LIMITS.title + 50} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {appt.kind !== "BLOCK" ? (
        <div className={s.row2}>
          <div className={s.field}>
            <label className={s.label} htmlFor="edit-location">מיקום</label>
            <select id="edit-location" className={s.input} value={locationKind} onChange={(e) => setLocationKind(e.target.value as typeof locationKind)}>
              <option value="">לא צוין</option>
              {(["IN_PERSON", "PHONE", "ONLINE"] as const).map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
            </select>
          </div>
          <div className={s.field}>
            <label className={s.label} htmlFor="edit-location-detail">פרטי מיקום</label>
            <input id="edit-location-detail" className={s.input} value={locationDetail} maxLength={LIMITS.locationDetail + 50} onChange={(e) => setLocationDetail(e.target.value)} />
          </div>
        </div>
      ) : null}
      <div className={s.field}>
        <label className={s.label} htmlFor="edit-notes">הערות</label>
        <textarea id="edit-notes" className={s.input} rows={4} value={notes} maxLength={LIMITS.notes + 200} onChange={(e) => setNotes(e.target.value)} />
        {notes.length > LIMITS.notes * 0.8 ? <span className={`${s.counter} ${notes.length > LIMITS.notes ? s.counterOver : ""}`}>{notes.length.toLocaleString("he-IL")} / {LIMITS.notes.toLocaleString("he-IL")}</span> : null}
      </div>
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      <div className={s.confirmRow}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy} onClick={() => void save()}>{busy ? "שומר…" : "שמירה"}</button>
        <button type="button" className={s.btn} disabled={busy} onClick={onCancel}>סגירה</button>
      </div>
    </div>
  );
}

