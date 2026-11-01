"use client";

/**
 * Create or move an appointment (Appointments milestone B) — one form for the three kinds the owner books:
 *   תור ללקוח      a customer (search or new), a service (fills the length), a staff member, a time;
 *   פגישה פנימית   a title, who attends (a staff member or the business), a time;
 *   חסימת זמן      time closed for one staff member or for the whole business.
 *
 * The server decides; the form only prepares a request it will accept. Free times come from /slots for the chosen
 * day (the hours, exceptions, buffers and busy time are the server's); a taken time answers SLOT_CONFLICT and the
 * form offers the three nearest free times instead of failing. A time outside working hours or inside a closure is
 * allowed (the owner's calendar, the owner's call — the server books it with OUTSIDE_AVAILABILITY), but the form says so
 * BEFORE "קבע", with the reason, and the button reads "לקבוע בכל זאת". Decision 11: a customer with an open lead is linked to it; the lead's
 * stage is not touched here.
 */
import { useEffect, useRef, useState } from "react";

import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { useBreakpoint } from "@/lib/ui/use-breakpoint";
import { uuidV7 } from "@/lib/tasks/tasks-client";
import t from "@/features/tasks/tasks.module.css";

import {
  CalendarApiError,
  createAppointment,
  createCustomer,
  findSlots,
  forgetIntent,
  moveAppointment,
  openLeadOf,
  searchCustomers,
  type CustomerWire,
  type ServiceWire,
  type SlotWire,
} from "./calendar-client";
import {
  availabilityWarning,
  clock,
  clockOf,
  BLOCK_CONFLICT_TEXT,
  durationLabel,
  durationOf,
  errorText,
  FIELD_LABEL,
  instantAt,
  KIND_LABEL,
  LIMITS,
  LOCATION_LABEL,
  minuteInDay,
  noSlotsReason,
  parseClock,
  textProblem,
  type AppointmentWire,
  type Availability,
  type DayKey,
  type Names,
  type StaffWire,
} from "./calendar-model";
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import s from "./calendar.module.css";

type Kind = "CUSTOMER" | "INTERNAL" | "BLOCK";
const KINDS: Kind[] = ["CUSTOMER", "INTERNAL", "BLOCK"];
const LOCATIONS = ["IN_PERSON", "PHONE", "ONLINE"] as const;

export type Prefill = { day: DayKey; minute?: number; staffMemberId?: number | null; customer?: CustomerWire | null };

export type FormDone = { appointment: AppointmentWire; warnings: string[] };

function Counter({ value, max }: { value: string; max: number }) {
  const near = value.length > max * 0.8;
  if (!near) return null;
  return <span className={`${s.counter} ${value.length > max ? s.counterOver : ""}`}>{value.length.toLocaleString("he-IL")} / {max.toLocaleString("he-IL")}</span>;
}

/** The three free times nearest to the one asked for: the same day first, then the next days. */
function nearest(slots: SlotWire[], wanted: Date): SlotWire[] {
  return [...slots]
    .filter((x) => Date.parse(x.startsAt) !== wanted.getTime())
    .sort((a, b) => Math.abs(Date.parse(a.startsAt) - wanted.getTime()) - Math.abs(Date.parse(b.startsAt) - wanted.getTime()))
    .slice(0, 3)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

const slotLabel = (x: SlotWire, day: DayKey) => {
  const d = jerusalemDayKey(new Date(x.startsAt));
  const time = clockOf(new Date(x.startsAt));
  return d === day ? time : `${new Intl.DateTimeFormat("he-IL", { weekday: "short", timeZone: "Asia/Jerusalem" }).format(new Date(x.startsAt))} ${time}`;
};

const SLOTS_SHOWN = 12;

function OutsideWarning({ text }: { text: string }) {
  return (
    <div className={s.warnBox} role="status">
      <strong>שימו לב: השעה לא פנויה לפי הזמינות.</strong>
      <span>{text}</span>
      <span>אפשר לקבוע בכל זאת — התור יירשם מחוץ לשעות הפעילות.</span>
    </div>
  );
}

/**
 * The day's free times as chips — all of them: the first twelve, then "עוד N שעות פנויות" opens the rest (the list
 * the server answered, never cut silently).
 */
function SlotChips({ slots, time, onPick, emptyText }: { slots: SlotWire[]; time: string; onPick: (hhmm: string) => void; emptyText: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? slots : slots.slice(0, SLOTS_SHOWN);
  return (
    <div className={t.field}>
      <span className={t.hint}>{slots.length ? `שעות פנויות ביום הזה (${slots.length.toLocaleString("he-IL")}):` : emptyText}</span>
      {slots.length ? (
        <div className={`${t.chips} ${s.slotChips}`}>
          {shown.map((x) => {
            const label = clockOf(new Date(x.startsAt));
            return <button key={x.startsAt} type="button" aria-pressed={time === label} className={`${t.chip} ${time === label ? t.chipOn : ""}`} onClick={() => onPick(label)}>{label}</button>;
          })}
          {slots.length > SLOTS_SHOWN ? (
            <button type="button" className={`${t.chip} ${s.moreChip}`} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "פחות" : `עוד ${(slots.length - SLOTS_SHOWN).toLocaleString("he-IL")} שעות פנויות`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

export function AppointmentForm({
  prefill,
  staff,
  services,
  names,
  availability,
  onDone,
  onCancel,
  onCustomer,
}: {
  prefill: Prefill;
  staff: StaffWire[];
  services: ServiceWire[];
  names: Names;
  availability: Availability;
  onDone: (out: FormDone) => void;
  onCancel: () => void;
  onCustomer: (c: CustomerWire) => void;
}) {
  const bp = useBreakpoint();
  const activeStaff = staff.filter((x) => x.active);
  const activeServices = services.filter((x) => x.active);
  const [kind, setKind] = useState<Kind>("CUSTOMER");
  const [customer, setCustomer] = useState<CustomerWire | null>(prefill.customer ?? null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(prefill.staffMemberId ?? null);
  const [day, setDay] = useState<DayKey>(prefill.day);
  const [time, setTime] = useState(prefill.minute !== undefined ? clock(prefill.minute) : "");
  const [duration, setDuration] = useState<number>(30);
  const [durationTouched, setDurationTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [locationKind, setLocationKind] = useState<(typeof LOCATIONS)[number] | "">("");
  const [locationDetail, setLocationDetail] = useState("");
  const [proposed, setProposed] = useState(false);
  const [slots, setSlots] = useState<SlotWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlotWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(`appt:create:${uuidV7()}`);

  // The service's length (or this staff member's own length for it), unless the owner typed one.
  const service = activeServices.find((x) => x.id === serviceId) ?? null;
  const staffOverride = staffId !== null && serviceId !== null
    ? activeStaff.find((x) => x.id === staffId)?.services.find((x) => x.businessServiceId === serviceId)?.durationOverrideMinutes ?? null
    : null;
  const suggestedDuration = staffOverride ?? service?.durationMinutes ?? null;
  const effectiveDuration = !durationTouched && suggestedDuration ? suggestedDuration : duration;

  // Staff who perform the chosen service (a service that names nobody is open to everyone).
  const staffForService = serviceId === null || activeStaff.every((x) => !x.services.some((a) => a.businessServiceId === serviceId))
    ? activeStaff
    : activeStaff.filter((x) => x.services.some((a) => a.businessServiceId === serviceId));

  // Decision 11 — the customer's open lead, looked up once per customer.
  useEffect(() => {
    if (!customer || kind !== "CUSTOMER") return;
    let cancelled = false;
    openLeadOf(customer).then((id) => { if (!cancelled) setLeadId(id); });
    return () => { cancelled = true; };
  }, [customer, kind]);

  // Free times of the chosen day for this length and lane (a block needs none).
  useEffect(() => {
    if (kind === "BLOCK" || !effectiveDuration || effectiveDuration < LIMITS.minDuration) return;
    let cancelled = false;
    findSlots({ fromDay: day, toDay: day, businessServiceId: kind === "CUSTOMER" ? serviceId : null, durationMinutes: effectiveDuration, staffMemberId: staffId })
      .then((r) => { if (!cancelled) setSlots(r.slots); })
      .catch(() => { if (!cancelled) setSlots(null); });
    return () => { cancelled = true; };
  }, [day, effectiveDuration, kind, serviceId, staffId]);

  const problems = [
    kind === "CUSTOMER" && !customer ? "צריך לבחור לקוח." : null,
    kind === "INTERNAL" && !title.trim() ? "צריך כותרת לפגישה." : null,
    parseClock(time) === null ? "צריך שעת התחלה." : null,
    !(effectiveDuration >= LIMITS.minDuration && effectiveDuration <= LIMITS.maxDuration) ? `המשך צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.` : null,
    textProblem("הכותרת", title, LIMITS.title),
    textProblem("ההערות", notes, LIMITS.notes),
    textProblem("פרטי המיקום", locationDetail, LIMITS.locationDetail),
  ].filter((x): x is string => x !== null);

  const submit = async (startOverride?: string) => {
    setError(null);
    setConflict(null);
    if (problems.length && !startOverride) {
      setError(problems[0]);
      return;
    }
    const minute = parseClock(time)!;
    const startsAt = startOverride ?? instantAt(day, minute).toISOString();
    setBusy(true);
    try {
      const out = await createAppointment(intent.current, {
        kind,
        startsAt,
        durationMinutes: effectiveDuration,
        staffMemberId: staffId,
        businessServiceId: kind === "CUSTOMER" ? serviceId : null,
        customerId: kind === "CUSTOMER" ? customer!.id : null,
        leadId: kind === "CUSTOMER" ? leadId : null,
        title: title.trim() || null,
        notes: notes.trim() || null,
        locationKind: kind === "BLOCK" ? null : locationKind || null,
        locationDetail: kind === "BLOCK" ? null : locationDetail.trim() || null,
        status: kind === "BLOCK" || !proposed ? "CONFIRMED" : "PROPOSED",
      });
      onDone({ appointment: out.appointment, warnings: out.warnings ?? [] });
    } catch (e) {
      forgetIntent(intent.current);
      intent.current = `appt:create:${uuidV7()}`;
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      if (err.code === "SLOT_CONFLICT" && kind === "BLOCK") {
        setConflict(null);
        setError(BLOCK_CONFLICT_TEXT);
      } else if (err.code === "SLOT_CONFLICT") {
        const wanted = new Date(startsAt);
        const fresh = await findSlots({
          fromDay: day, toDay: addCalendarDays(day, 6), businessServiceId: kind === "CUSTOMER" ? serviceId : null,
          durationMinutes: effectiveDuration, staffMemberId: staffId,
        }).then((r) => r.slots).catch(() => [] as SlotWire[]);
        setConflict(nearest(fresh, wanted));
        setError(errorText(err.code));
      } else if (err.code === "INVALID_INPUT" && typeof err.details.field === "string") {
        setError(`${FIELD_LABEL[err.details.field] ?? "אחד השדות"}: ${errorText(err.code)}`);
      } else {
        setError(errorText(err.code, err.status));
      }
    } finally {
      setBusy(false);
    }
  };

  const daySlots = (slots ?? []).filter((x) => jerusalemDayKey(new Date(x.startsAt)) === day);
  const startMinute = parseClock(time);
  // A block closes time; it is never "outside" anything (the server warns only for the other kinds).
  const outside = kind !== "BLOCK" && startMinute !== null ? availabilityWarning(availability, staffId, day, startMinute, effectiveDuration, names) : null;

  return (
    <form className={t.form} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <h2 id="appointment-form-title">{kind === "BLOCK" ? "חסימת זמן" : kind === "INTERNAL" ? "פגישה חדשה" : "תור חדש"}</h2>

      <div className={s.seg} role="radiogroup" aria-label="סוג">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? s.segOn : ""} onClick={() => { setKind(k); setError(null); setConflict(null); }}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {kind === "CUSTOMER" ? (
        <CustomerField
          value={customer}
          onChange={(c) => { setCustomer(c); setLeadId(null); if (c) onCustomer(c); }}
          autoFocus={bp !== "mobile" && !customer}
        />
      ) : null}
      {kind === "CUSTOMER" && customer && leadId !== null ? <p className={s.note}>התור יקושר לליד הפתוח של {customer.name}. שלב הליד לא ישתנה.</p> : null}

      {kind === "CUSTOMER" ? (
        <div className={t.field}>
          <label htmlFor="appt-service">שירות</label>
          <select id="appt-service" className={t.input} value={serviceId ?? ""} onChange={(e) => { setServiceId(e.target.value ? Number(e.target.value) : null); setDurationTouched(false); }}>
            <option value="">ללא שירות מסוים</option>
            {activeServices.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.durationMinutes ? ` · ${durationLabel(x.durationMinutes)}` : ""}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className={t.field}>
          <label htmlFor="appt-title">{kind === "BLOCK" ? "תיאור (לא חובה)" : "כותרת"}</label>
          <input id="appt-title" className={t.input} value={title} maxLength={LIMITS.title + 50} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "BLOCK" ? "למשל: הפסקת צהריים" : "למשל: ישיבת צוות"} />
          <Counter value={title} max={LIMITS.title} />
        </div>
      )}

      {activeStaff.length ? (
        <div className={t.field}>
          <label htmlFor="appt-staff">{kind === "BLOCK" ? "למי לחסום" : kind === "INTERNAL" ? "משתתף" : "עובד"}</label>
          <select id="appt-staff" className={t.input} value={staffId ?? ""} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{kind === "BLOCK" ? "כל העסק" : "ללא עובד מסוים"}</option>
            {(kind === "CUSTOMER" ? staffForService : activeStaff).map((x) => (
              <option key={x.id} value={x.id}>{x.displayName}</option>
            ))}
          </select>
          {kind === "CUSTOMER" && serviceId !== null && staffForService.length < activeStaff.length ? <span className={t.hint}>מוצגים רק העובדים שמבצעים את השירות.</span> : null}
        </div>
      ) : null}

      <div className={s.row3}>
        <div className={t.field}>
          <label htmlFor="appt-day">תאריך</label>
          <input id="appt-day" type="date" className={t.input} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="appt-time">שעה</label>
          <input id="appt-time" type="time" step={300} className={t.input} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="appt-duration">משך (דק׳)</label>
          <input
            id="appt-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={t.input}
            value={effectiveDuration}
            onChange={(e) => { setDurationTouched(true); setDuration(Number(e.target.value)); }}
          />
        </div>
      </div>
      {outside ? <OutsideWarning text={outside} /> : null}

      {kind !== "BLOCK" && slots ? (
        <SlotChips key={`${day}:${effectiveDuration}:${serviceId}:${staffId}`} slots={daySlots} time={time} onPick={setTime} emptyText={`אין שעה פנויה ביום הזה. ${noSlotsReason(availability, staffId, day, names) ?? ""} אפשר לקבוע בכל זאת.`.replace(/\s+/g, " ")} />
      ) : null}

      {kind !== "BLOCK" ? (
        <div className={s.row2}>
          <div className={t.field}>
            <label htmlFor="appt-location">מיקום</label>
            <select id="appt-location" className={t.input} value={locationKind} onChange={(e) => setLocationKind(e.target.value as typeof locationKind)}>
              <option value="">לא צוין</option>
              {LOCATIONS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
            </select>
          </div>
          <div className={t.field}>
            <label htmlFor="appt-location-detail">פרטי מיקום</label>
            <input id="appt-location-detail" className={t.input} value={locationDetail} maxLength={LIMITS.locationDetail + 50} onChange={(e) => setLocationDetail(e.target.value)} placeholder="כתובת או קישור" />
            <Counter value={locationDetail} max={LIMITS.locationDetail} />
          </div>
        </div>
      ) : null}

      {kind === "CUSTOMER" ? (
        <div className={t.field}>
          <label htmlFor="appt-title-c">כותרת (לא חובה)</label>
          <input id="appt-title-c" className={t.input} value={title} maxLength={LIMITS.title + 50} onChange={(e) => setTitle(e.target.value)} placeholder={service?.name ?? "ברירת המחדל: שם השירות"} />
          <Counter value={title} max={LIMITS.title} />
        </div>
      ) : null}

      <div className={t.field}>
        <label htmlFor="appt-notes">הערות</label>
        <textarea id="appt-notes" className={t.input} rows={3} value={notes} maxLength={LIMITS.notes + 200} onChange={(e) => setNotes(e.target.value)} />
        <Counter value={notes} max={LIMITS.notes} />
      </div>

      {kind === "CUSTOMER" ? (
        <label className={s.note} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={proposed} onChange={(e) => setProposed(e.target.checked)} />
          עוד לא אושר מול הלקוח (יסומן כממתין לאישור)
        </label>
      ) : null}

      {error ? <p className={t.error} role="alert">{error}</p> : null}
      {conflict ? (
        <div className={s.conflict} role="status">
          {conflict.length ? (
            <>
              <span>שעות קרובות שפנויות:</span>
              <div className={t.chips}>
                {conflict.map((x) => (
                  <button key={x.startsAt} type="button" className={t.chip} disabled={busy} onClick={() => {
                    setDay(jerusalemDayKey(new Date(x.startsAt)));
                    setTime(clockOf(new Date(x.startsAt)));
                    void submit(x.startsAt);
                  }}>
                    {slotLabel(x, day)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <span>לא מצאתי שעה פנויה קרובה בשבוע הקרוב. אפשר לבחור שעה אחרת.</span>
          )}
        </div>
      ) : null}

      <div className={t.actions}>
        <button type="submit" className={`${t.btn} ${t.pri}`} disabled={busy}>{busy ? "שומר…" : kind === "BLOCK" ? "חסום" : outside ? "לקבוע בכל זאת" : "קבע"}</button>
        <button type="button" className={t.btn} onClick={onCancel} disabled={busy}>ביטול</button>
      </div>
      {names.staff.size === 0 && kind !== "BLOCK" ? <p className={t.hint}>אפשר להוסיף עובדים ושעות פעילות ב„עובדים וזמינות”.</p> : null}
    </form>
  );
}

// ── The customer field: search, pick, or create ──────────────────────────────────────────────────

function CustomerField({ value, onChange, autoFocus }: { value: CustomerWire | null; onChange: (c: CustomerWire | null) => void; autoFocus: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CustomerWire[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (value) return;
    let cancelled = false;
    const h = setTimeout(() => {
      searchCustomers(q, 8).then((r) => { if (!cancelled) setRows(r); }).catch(() => { if (!cancelled) setRows([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, value]);

  if (value) {
    return (
      <div className={t.field}>
        <span className={t.hint}>לקוח</span>
        <div className={t.linked}>
          <span style={{ flex: 1, minWidth: 0 }}>{value.name}{value.phone ? <small style={{ color: "var(--dz-text-muted)" }}> · <bdi dir="ltr">{formatPhoneForDisplay(value.phone)}</bdi></small> : null}</span>
          <button type="button" className={`${t.btn} ${t.ghost}`} onClick={() => onChange(null)}>החלפה</button>
        </div>
      </div>
    );
  }

  if (adding) {
    return (
      <fieldset className={t.field}>
        <legend>לקוח חדש</legend>
        <div className={s.row2}>
          <input className={t.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" aria-label="שם הלקוח" autoFocus maxLength={120} />
          <input className={t.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון (לא חובה)" aria-label="טלפון" inputMode="tel" dir="ltr" maxLength={30} />
        </div>
        {err ? <p className={t.error}>{err}</p> : null}
        <div className={t.actions}>
          <button type="button" className={`${t.btn} ${t.soft}`} onClick={async () => {
            if (!name.trim()) { setErr("צריך שם ללקוח."); return; }
            try {
              onChange(await createCustomer({ name: name.trim(), phone: phone.trim() || null }));
            } catch {
              setErr("לא הצלחתי להוסיף את הלקוח. אפשר לנסות שוב.");
            }
          }}>הוסף לקוח</button>
          <button type="button" className={`${t.btn} ${t.ghost}`} onClick={() => setAdding(false)}>חזרה לחיפוש</button>
        </div>
      </fieldset>
    );
  }

  return (
    <div className={t.field}>
      <label htmlFor="appt-customer">לקוח</label>
      <input id="appt-customer" className={t.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או טלפון" autoFocus={autoFocus} autoComplete="off" />
      <div className={s.results} role="listbox" aria-label="לקוחות">
        {rows === null ? <span className={s.result} style={{ cursor: "default" }}>מחפש…</span> : null}
        {rows?.map((c) => (
          <button key={c.id} type="button" role="option" aria-selected={false} className={s.result} onClick={() => onChange(c)}>
            <span>{c.name}</span>
            {c.phone ? <small><bdi dir="ltr">{formatPhoneForDisplay(c.phone)}</bdi></small> : null}
          </button>
        ))}
        <button type="button" className={s.result} onClick={() => { setAdding(true); setName(q); }}>
          <span>+ לקוח חדש{q.trim() ? `: ${q.trim()}` : ""}</span>
        </button>
      </div>
    </div>
  );
}

// ── Move ────────────────────────────────────────────────────────────────────────────────────────

export function MoveForm({
  appt,
  staff,
  names,
  availability,
  onDone,
  onCancel,
}: {
  appt: AppointmentWire;
  staff: StaffWire[];
  names: Names;
  availability: Availability;
  onDone: (out: FormDone) => void;
  onCancel: () => void;
}) {
  const start = new Date(appt.startsAt!);
  const startDay = jerusalemDayKey(start);
  const [day, setDay] = useState<DayKey>(startDay);
  const [time, setTime] = useState(clock(minuteInDay(start, startDay)));
  const [duration, setDuration] = useState<number>(durationOf(appt) ?? 30);
  const [staffId, setStaffId] = useState<number | null>(appt.staffMemberId);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlotWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef(`appt:move:${appt.id}:${uuidV7()}`);
  const activeStaff = staff.filter((x) => x.active || x.id === appt.staffMemberId);
  const [slots, setSlots] = useState<SlotWire[] | null>(null);

  // The chosen day's free times for this length and lane, as when booking (a block needs none). The appointment's
  // own current time is busy in that answer, so it is not offered — staying put needs no move.
  useEffect(() => {
    if (appt.kind === "BLOCK" || !(duration >= LIMITS.minDuration && duration <= LIMITS.maxDuration)) return;
    let cancelled = false;
    findSlots({ fromDay: day, toDay: day, businessServiceId: appt.kind === "CUSTOMER" ? appt.businessServiceId : null, durationMinutes: duration, staffMemberId: staffId })
      .then((r) => { if (!cancelled) setSlots(r.slots.filter((x) => jerusalemDayKey(new Date(x.startsAt)) === day)); })
      .catch(() => { if (!cancelled) setSlots(null); });
    return () => { cancelled = true; };
  }, [appt.kind, appt.businessServiceId, day, duration, staffId]);

  const submit = async (override?: string) => {
    setError(null);
    setConflict(null);
    const minute = parseClock(time);
    if (minute === null && !override) { setError("צריך שעת התחלה."); return; }
    if (!(duration >= LIMITS.minDuration && duration <= LIMITS.maxDuration)) { setError(`המשך צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.`); return; }
    const startsAt = override ?? instantAt(day, minute!).toISOString();
    setBusy(true);
    try {
      const out = await moveAppointment(intent.current, appt.id, {
        startsAt, durationMinutes: duration, ...(staffId !== appt.staffMemberId ? { staffMemberId: staffId } : {}), expectedVersion: appt.version,
      });
      onDone({ appointment: out.appointment, warnings: out.warnings ?? [] });
    } catch (e) {
      forgetIntent(intent.current);
      intent.current = `appt:move:${appt.id}:${uuidV7()}`;
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      setError(err.code === "SLOT_CONFLICT" && appt.kind === "BLOCK" ? BLOCK_CONFLICT_TEXT : errorText(err.code, err.status));
      if (err.code === "SLOT_CONFLICT" && appt.kind !== "BLOCK") {
        const fresh = await findSlots({
          fromDay: day, toDay: addCalendarDays(day, 6), businessServiceId: appt.businessServiceId, durationMinutes: duration, staffMemberId: staffId,
        }).then((r) => r.slots).catch(() => [] as SlotWire[]);
        setConflict(nearest(fresh, new Date(startsAt)));
      }
    } finally {
      setBusy(false);
    }
  };

  const moveMinute = parseClock(time);
  const moveOutside = appt.kind !== "BLOCK" && moveMinute !== null ? availabilityWarning(availability, staffId, day, moveMinute, duration, names) : null;

  return (
    <form className={t.form} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <h2 id="appointment-form-title">הזזת {appt.kind === "BLOCK" ? "חסימה" : appt.kind === "INTERNAL" ? "פגישה" : "תור"}</h2>
      <p className={s.note}>כרגע: {new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" }).format(start)} · {clockOf(start)}</p>
      <div className={s.row3}>
        <div className={t.field}>
          <label htmlFor="move-day">תאריך</label>
          <input id="move-day" type="date" className={t.input} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="move-time">שעה</label>
          <input id="move-time" type="time" step={300} className={t.input} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className={t.field}>
          <label htmlFor="move-duration">משך (דק׳)</label>
          <input id="move-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={t.input} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
        </div>
      </div>
      {moveOutside ? <OutsideWarning text={moveOutside} /> : null}
      {appt.kind !== "BLOCK" && slots ? (
        <SlotChips key={`${day}:${duration}:${staffId}`} slots={slots} time={time} onPick={setTime} emptyText={`אין שעה פנויה אחרת ביום הזה. ${noSlotsReason(availability, staffId, day, names) ?? ""} אפשר להזיז בכל זאת.`.replace(/\s+/g, " ")} />
      ) : null}
      {activeStaff.length ? (
        <div className={t.field}>
          <label htmlFor="move-staff">עובד</label>
          <select id="move-staff" className={t.input} value={staffId ?? ""} onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{appt.kind === "BLOCK" ? "כל העסק" : "ללא עובד מסוים"}</option>
            {activeStaff.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
          </select>
        </div>
      ) : null}
      {error ? <p className={t.error} role="alert">{error}</p> : null}
      {conflict?.length ? (
        <div className={s.conflict}>
          <span>שעות קרובות שפנויות:</span>
          <div className={t.chips}>
            {conflict.map((x) => (
              <button key={x.startsAt} type="button" className={t.chip} disabled={busy} onClick={() => { setDay(jerusalemDayKey(new Date(x.startsAt))); setTime(clockOf(new Date(x.startsAt))); void submit(x.startsAt); }}>
                {slotLabel(x, day)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className={t.actions}>
        <button type="submit" className={`${t.btn} ${t.pri}`} disabled={busy}>{busy ? "מזיז…" : moveOutside ? "להזיז בכל זאת" : "הזז"}</button>
        <button type="button" className={t.btn} onClick={onCancel} disabled={busy}>ביטול</button>
      </div>
    </form>
  );
}
