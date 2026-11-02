"use client";

/**
 * Book or move (design direction A) — one short form for the three kinds the owner books:
 *   תור ללקוח      customer → service and staff → when (the day's free times first, another time on request) →
 *                  length (visible, editable); everything else under "עוד פרטים";
 *   פגישה          subject → with whom → when → length;
 *   חסימת זמן      why (optional) → for whom (the whole business or one staff member) → from–to.
 *
 * The server decides; the form only prepares a request it will accept. Free times come from /slots for the chosen
 * day; a taken time answers SLOT_CONFLICT and the form offers the three nearest free times instead of failing. A time
 * outside the hours or inside a closure may still be booked (the owner's call — the server books it with
 * OUTSIDE_AVAILABILITY), but the form says so BEFORE saving and the button reads "לקבוע בכל זאת". Problems are shown
 * next to their fields, all at once. A customer with an open lead is linked to it (decision 11); the lead's stage is
 * not touched. The form tells its screen whether anything was changed, so closing asks first.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { useBreakpoint } from "@/lib/ui/use-breakpoint";
import { uuidV7 } from "@/lib/tasks/tasks-client";
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";

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
  BLOCK_CONFLICT_TEXT,
  clock,
  clockOf,
  dayTitle,
  durationLabel,
  durationOf,
  errorText,
  FIELD_LABEL,
  instantAt,
  keepStaffFor,
  LIMITS,
  LOCATION_LABEL,
  minuteInDay,
  noSlotsReason,
  parseClock,
  staffForService,
  textProblem,
  timeLabel,
  type AppointmentWire,
  type Availability,
  type DayKey,
  type Names,
  type StaffWire,
} from "./calendar-model";
import { Chevron, IconCalendar, IconClock, IconScissors, IconUser, IconUsers, IconX } from "./ui";
import s from "./calendar.module.css";

type Kind = "CUSTOMER" | "INTERNAL" | "BLOCK";
const KIND_TAB: Array<[Kind, string]> = [["CUSTOMER", "תור ללקוח"], ["INTERNAL", "פגישה"], ["BLOCK", "חסימה"]];
const LOCATIONS = ["IN_PERSON", "PHONE", "ONLINE"] as const;

export type Prefill = { day: DayKey; minute?: number; staffMemberId?: number | null; customer?: CustomerWire | null };

export type FormDone = { appointment: AppointmentWire; warnings: string[] };

type FieldKey = "customer" | "title" | "time" | "duration" | "notes" | "locationDetail" | "end";

const SLOTS_SHOWN = 9;

function Counter({ value, max }: { value: string; max: number }) {
  if (value.length <= max * 0.8) return null;
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

function FieldErr({ id, text }: { id: string; text?: string }) {
  return text ? <p className={s.fieldErr} id={id}>{text}</p> : null;
}

function Line({ label, icon, htmlFor, children, error, errorId }: { label: string; icon?: ReactNode; htmlFor?: string; children: ReactNode; error?: string; errorId?: string }) {
  return (
    <div className={s.line}>
      {htmlFor ? <label className={s.label} htmlFor={htmlFor}>{label}</label> : <span className={s.label}>{label}</span>}
      <div className={s.lineMain}>
        {icon ? <span className={s.lineIcon}>{icon}</span> : null}
        {children}
      </div>
      {error && errorId ? <FieldErr id={errorId} text={error} /> : null}
    </div>
  );
}

function OutsideWarning({ text, verb }: { text: string; verb: string }) {
  return (
    <div className={s.warnBox} role="status">
      <strong>השעה לא פנויה לפי הזמינות.</strong>
      <span>{text}</span>
      <span>אפשר {verb} בכל זאת — התור יירשם מחוץ לשעות הפעילות.</span>
    </div>
  );
}

/**
 * The day's free times — all of them: the first nine, then "עוד N" opens the rest (the list the server answered,
 * never cut silently) — and "שעה אחרת" for any time at all.
 */
function TimePick({ slots, slotsState, time, onTime, emptyText, onRetry, forceOther }: {
  slots: SlotWire[];
  slotsState: "loading" | "ready" | "error" | "none";
  time: string;
  onTime: (hhmm: string) => void;
  emptyText: string;
  onRetry: () => void;
  forceOther: boolean;
}) {
  const [all, setAll] = useState(false);
  const labels = slots.map((x) => clockOf(new Date(x.startsAt)));
  const [other, setOther] = useState(forceOther || (time !== "" && !labels.includes(time)));
  const shown = all ? slots : slots.slice(0, SLOTS_SHOWN);
  return (
    <div className={s.line}>
      <span className={s.label} id="free-times-label">{slotsState === "ready" && slots.length ? `שעות פנויות (${slots.length.toLocaleString("he-IL")})` : "שעה"}</span>
      {slotsState === "loading" ? <p className={s.hint} aria-busy="true">מחפש שעות פנויות…</p> : null}
      {slotsState === "error" ? (
        <p className={s.fieldErr}>לא הצלחתי לטעון את השעות הפנויות. <button type="button" className={s.linkBtn} onClick={onRetry}>לנסות שוב</button> · אפשר לבחור שעה ידנית.</p>
      ) : null}
      {slotsState === "ready" && !slots.length ? <p className={s.hint}>{emptyText}</p> : null}
      {slotsState === "ready" && slots.length ? (
        <div className={`${s.chipGrid} ${s.slotChips}`} role="group" aria-labelledby="free-times-label">
          {shown.map((x) => {
            const label = clockOf(new Date(x.startsAt));
            return <button key={x.startsAt} type="button" aria-pressed={time === label} className={s.chip} onClick={() => { onTime(label); setOther(false); }}>{label}</button>;
          })}
          {slots.length > SLOTS_SHOWN ? (
            <button type="button" className={`${s.chip} ${s.chipMore}`} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "פחות" : `עוד ${(slots.length - SLOTS_SHOWN).toLocaleString("he-IL")}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {other ? (
        <div className={s.field}>
          <label className={s.label} htmlFor="appt-time">שעה אחרת</label>
          <input id="appt-time" type="time" step={300} className={s.input} value={time} onChange={(e) => onTime(e.target.value)} />
        </div>
      ) : (
        <button type="button" className={s.linkBtn} style={{ alignSelf: "flex-start" }} onClick={() => setOther(true)}>שעה אחרת</button>
      )}
    </div>
  );
}

function SheetHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className={s.sheetHead}>
      <button type="button" className={`${s.iconBtn} ${s.sheetClose}`} aria-label="סגירה" onClick={onClose}><IconX size={20} /></button>
      <h2 id="appointment-form-title">{title}</h2>
    </div>
  );
}

const DATE_LONG = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });

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
  onDirty,
}: {
  prefill: Prefill;
  staff: StaffWire[];
  services: ServiceWire[];
  names: Names;
  availability: Availability;
  onDone: (out: FormDone) => void;
  onCancel: () => void;
  onCustomer: (c: CustomerWire) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const bp = useBreakpoint();
  const activeStaff = staff.filter((x) => x.active);
  const activeServices = services.filter((x) => x.active);
  const [kind, setKind] = useState<Kind>("CUSTOMER");
  const [customer, setCustomer] = useState<CustomerWire | null>(prefill.customer ?? null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staffId, setStaffId] = useState<number | null>(prefill.staffMemberId ?? null);
  const [staffCleared, setStaffCleared] = useState<string | null>(null);
  const [day, setDay] = useState<DayKey>(prefill.day);
  const [time, setTime] = useState(prefill.minute !== undefined ? clock(prefill.minute) : "");
  const [duration, setDuration] = useState<number>(30);
  const [durationTouched, setDurationTouched] = useState(false);
  const [blockEnd, setBlockEnd] = useState(prefill.minute !== undefined ? clock(Math.min(prefill.minute + 60, 1435)) : "");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [locationKind, setLocationKind] = useState<(typeof LOCATIONS)[number] | "">("");
  const [locationDetail, setLocationDetail] = useState("");
  const [proposed, setProposed] = useState(false);
  const [more, setMore] = useState(false);
  const [slots, setSlots] = useState<SlotWire[]>([]);
  const [slotsState, setSlotsState] = useState<"loading" | "ready" | "error" | "none">("none");
  const [slotsTick, setSlotsTick] = useState(0);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlotWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  // The moment the form opened: "השעה כבר עברה" is said against it (render stays pure).
  const [openedAt] = useState(() => Date.now());
  const intent = useRef(`appt:create:${uuidV7()}`);
  const touch = () => { if (!touched) setTouched(true); };
  useEffect(() => { onDirty(touched); }, [touched, onDirty]);

  // The service's length (or this staff member's own length for it), unless the owner typed one.
  const service = activeServices.find((x) => x.id === serviceId) ?? null;
  const staffOverride = staffId !== null && serviceId !== null
    ? activeStaff.find((x) => x.id === staffId)?.services.find((x) => x.businessServiceId === serviceId)?.durationOverrideMinutes ?? null
    : null;
  const suggestedDuration = staffOverride ?? service?.durationMinutes ?? null;
  const startMinute = parseClock(time);
  const endMinute = blockEnd === "24:00" ? 1440 : parseClock(blockEnd);
  const blockMinutes = startMinute !== null && endMinute !== null ? endMinute - startMinute : 0;
  const effectiveDuration = kind === "BLOCK" ? blockMinutes : !durationTouched && suggestedDuration ? suggestedDuration : duration;

  const staffChoices = kind === "CUSTOMER" ? staffForService(staff, serviceId) : activeStaff;

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
    const t = window.setTimeout(() => {
      setSlotsState("loading");
      findSlots({ fromDay: day, toDay: day, businessServiceId: kind === "CUSTOMER" ? serviceId : null, durationMinutes: effectiveDuration, staffMemberId: staffId })
        .then((r) => { if (!cancelled) { setSlots(r.slots.filter((x) => jerusalemDayKey(new Date(x.startsAt)) === day)); setSlotsState("ready"); } })
        .catch(() => { if (!cancelled) { setSlots([]); setSlotsState("error"); } });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [day, effectiveDuration, kind, serviceId, staffId, slotsTick]);

  const fieldErrors: Partial<Record<FieldKey, string>> = {};
  if (kind === "CUSTOMER" && !customer) fieldErrors.customer = "צריך לבחור לקוח.";
  if (kind === "INTERNAL" && !title.trim()) fieldErrors.title = "צריך נושא לפגישה.";
  else if (textProblem("הכותרת", title, LIMITS.title)) fieldErrors.title = textProblem("הכותרת", title, LIMITS.title)!;
  if (startMinute === null) fieldErrors.time = kind === "BLOCK" ? "צריך שעת התחלה." : "צריך לבחור שעה.";
  if (kind === "BLOCK") {
    if (endMinute === null) fieldErrors.end = "צריך שעת סיום.";
    else if (startMinute !== null && endMinute <= startMinute) fieldErrors.end = "שעת הסיום צריכה להיות אחרי שעת ההתחלה.";
    else if (startMinute !== null && blockMinutes < LIMITS.minDuration) fieldErrors.end = `חסימה קצרה מ־${LIMITS.minDuration} דקות.`;
  } else if (!(effectiveDuration >= LIMITS.minDuration && effectiveDuration <= LIMITS.maxDuration)) {
    fieldErrors.duration = `המשך צריך להיות בין ${LIMITS.minDuration} ל־${LIMITS.maxDuration.toLocaleString("he-IL")} דקות.`;
  }
  if (textProblem("ההערות", notes, LIMITS.notes)) fieldErrors.notes = textProblem("ההערות", notes, LIMITS.notes)!;
  if (textProblem("פרטי המיקום", locationDetail, LIMITS.locationDetail)) fieldErrors.locationDetail = textProblem("פרטי המיקום", locationDetail, LIMITS.locationDetail)!;
  const shownErrors = tried ? fieldErrors : {};
  const anyError = Object.keys(fieldErrors).length > 0;

  const submit = async (startOverride?: string) => {
    setError(null);
    setConflict(null);
    if (anyError && !startOverride) {
      setTried(true);
      if (fieldErrors.notes || fieldErrors.locationDetail || (fieldErrors.title && kind === "CUSTOMER")) setMore(true);
      return;
    }
    const startsAt = startOverride ?? instantAt(day, startMinute!).toISOString();
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
      onDirty(false);
      onDone({ appointment: out.appointment, warnings: out.warnings ?? [] });
    } catch (e) {
      forgetIntent(intent.current);
      intent.current = `appt:create:${uuidV7()}`;
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      if (err.code === "SLOT_CONFLICT" && kind === "BLOCK") {
        const ids = Array.isArray(err.details.conflictingAppointmentIds) ? (err.details.conflictingAppointmentIds as number[]) : [];
        setError(ids.length ? `${BLOCK_CONFLICT_TEXT} (${ids.length.toLocaleString("he-IL")} ${ids.length === 1 ? "תור" : "תורים"} בזמן הזה)` : BLOCK_CONFLICT_TEXT);
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

  const anyHours = availability.business.rules.length > 0 || [...availability.staff.values()].some((x) => x.rules.length > 0);
  // A block closes time; it is never "outside" anything (the server warns only for the other kinds).
  const outside = kind !== "BLOCK" && startMinute !== null ? availabilityWarning(availability, staffId, day, startMinute, effectiveDuration, names) : null;
  const past = startMinute !== null && instantAt(day, startMinute).getTime() < openedAt;
  const emptyText = !anyHours
    ? "עוד לא הוגדרו שעות פעילות, ולכן אין שעות מוצעות. אפשר לבחור כל שעה."
    : `אין שעה פנויה ביום הזה. ${noSlotsReason(availability, staffId, day, names) ?? ""} אפשר לבחור שעה אחרת.`.replace(/\s+/g, " ");
  const endsAt = startMinute !== null && effectiveDuration > 0 ? clock(startMinute + effectiveDuration) : null;
  const staffName = staffId !== null ? activeStaff.find((x) => x.id === staffId)?.displayName : null;
  const titleText = kind === "BLOCK" ? "חסימת זמן" : kind === "INTERNAL" ? "פגישה חדשה" : "קביעת תור";
  const verb = kind === "BLOCK" ? "חסימת הזמן" : outside ? "לקבוע בכל זאת" : kind === "INTERNAL" ? "קביעת פגישה" : "קביעת תור";

  return (
    <form className={`${s.sheet} ${s.form}`} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <SheetHead title={titleText} onClose={onCancel} />

      <div className={s.seg} role="radiogroup" aria-label="סוג">
        {KIND_TAB.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setError(null); setConflict(null); touch(); }}>
            {label}
          </button>
        ))}
      </div>

      <div>
        {kind === "CUSTOMER" ? (
          <CustomerField
            value={customer}
            error={shownErrors.customer}
            onChange={(c) => { setCustomer(c); setLeadId(null); touch(); if (c) onCustomer(c); }}
            autoFocus={bp !== "mobile" && !customer}
          />
        ) : null}
        {kind === "CUSTOMER" && customer && leadId !== null ? <p className={s.note} style={{ paddingTop: 6 }}>התור יקושר לליד הפתוח של {customer.name}. שלב הליד לא משתנה.</p> : null}

        {kind === "CUSTOMER" ? (
          <Line label="שירות" icon={<IconScissors />} htmlFor="appt-service">
            <select id="appt-service" className={s.lineSelect} value={serviceId ?? ""} onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              const kept = keepStaffFor(staff, next, staffId);
              setStaffCleared(kept === null && staffId !== null ? (activeStaff.find((x) => x.id === staffId)?.displayName ?? "העובד") : null);
              setServiceId(next); setStaffId(kept); setDurationTouched(false); touch();
            }}>
              <option value="">ללא שירות מסוים</option>
              {activeServices.map((x) => <option key={x.id} value={x.id}>{x.name}{x.durationMinutes ? ` · ${durationLabel(x.durationMinutes)}` : ""}</option>)}
            </select>
            <Chevron dir="down" />
          </Line>
        ) : (
          <Line label={kind === "BLOCK" ? "סיבה (לא חובה)" : "נושא"} htmlFor="appt-title" error={shownErrors.title} errorId="appt-title-err">
            <input id="appt-title" className={`${s.input} ${shownErrors.title ? s.inputBad : ""}`} value={title} maxLength={LIMITS.title + 50}
              aria-invalid={!!shownErrors.title} aria-describedby={shownErrors.title ? "appt-title-err" : undefined}
              onChange={(e) => { setTitle(e.target.value); touch(); }} placeholder={kind === "BLOCK" ? "למשל: הפסקת צהריים" : "למשל: ישיבת צוות"} />
          </Line>
        )}

        {activeStaff.length ? (
          <Line label={kind === "BLOCK" ? "למי לחסום" : kind === "INTERNAL" ? "עם מי" : "צוות"} icon={<IconUser />} htmlFor="appt-staff">
            <select id="appt-staff" className={s.lineSelect} value={staffId ?? ""} onChange={(e) => { setStaffId(e.target.value ? Number(e.target.value) : null); setStaffCleared(null); touch(); }}>
              <option value="">{kind === "BLOCK" ? "כל העסק" : "ללא עובד"}</option>
              {staffChoices.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
            </select>
            <Chevron dir="down" />
          </Line>
        ) : null}
        {staffCleared ? <p className={s.note} role="status" style={{ paddingTop: 6 }}>{staffCleared} לא מבצע/ת את השירות הזה, ולכן הבחירה נוקתה.</p> : null}
        {kind === "CUSTOMER" && serviceId !== null && staffChoices.length < activeStaff.length ? <p className={s.note} style={{ paddingTop: 6 }}>מוצגים רק מי שמבצעים את השירות.</p> : null}

        <Line label="תאריך" icon={<IconCalendar />} htmlFor="appt-day">
          <span className={s.dateLine}>{dayTitle(day)}<input id="appt-day" type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); touch(); } }} /></span>
          <Chevron dir="down" />
        </Line>

        {kind === "BLOCK" ? (
          <div className={s.line}>
            <div className={s.row2}>
              <div className={s.field}>
                <label className={s.label} htmlFor="appt-time">משעה</label>
                <input id="appt-time" type="time" step={300} className={`${s.input} ${shownErrors.time ? s.inputBad : ""}`} value={time} onChange={(e) => { setTime(e.target.value); touch(); }} />
              </div>
              <div className={s.field}>
                <label className={s.label} htmlFor="appt-end">עד שעה</label>
                <input id="appt-end" type="time" step={300} className={`${s.input} ${shownErrors.end ? s.inputBad : ""}`} value={blockEnd} onChange={(e) => { setBlockEnd(e.target.value); touch(); }} aria-describedby={shownErrors.end ? "appt-end-err" : undefined} />
              </div>
            </div>
            <FieldErr id="appt-time-err" text={shownErrors.time} />
            <FieldErr id="appt-end-err" text={shownErrors.end} />
            <p className={s.hint}>חסימה של יום שלם או של כמה ימים — דרך „ימים מיוחדים” בניהול היומן.</p>
          </div>
        ) : (
          <>
            <TimePick
              key={`${day}:${effectiveDuration}:${serviceId}:${staffId}`}
              slots={slots}
              slotsState={slotsState}
              time={time}
              onTime={(v) => { setTime(v); touch(); }}
              emptyText={emptyText}
              onRetry={() => setSlotsTick((x) => x + 1)}
              forceOther={prefill.minute !== undefined}
            />
            <FieldErr id="appt-time-err" text={shownErrors.time} />
            <Line label="משך" icon={<IconClock />} htmlFor="appt-duration" error={shownErrors.duration} errorId="appt-duration-err">
              <input id="appt-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5}
                className={`${s.input} ${shownErrors.duration ? s.inputBad : ""}`} style={{ maxWidth: 110 }} value={Number.isFinite(effectiveDuration) ? effectiveDuration : ""}
                aria-describedby={shownErrors.duration ? "appt-duration-err" : "appt-duration-hint"}
                onChange={(e) => { setDurationTouched(true); setDuration(Number(e.target.value)); touch(); }} />
              <span className={s.hint} id="appt-duration-hint">דק׳{endsAt ? ` · עד ${endsAt}` : ""}{!durationTouched && suggestedDuration ? (staffOverride ? " · המשך של העובד" : " · משך השירות") : ""}</span>
            </Line>
          </>
        )}
      </div>

      {outside ? <OutsideWarning text={outside} verb="לקבוע" /> : null}
      {past ? <p className={s.note} role="status">השעה כבר עברה.</p> : null}

      {startMinute !== null && kind !== "BLOCK" ? (
        <section className={s.summaryBox} aria-label="סיכום">
          <h3>סיכום התור</h3>
          <span className={s.summaryItem}><IconCalendar size={18} />{dayTitle(day)}</span>
          {kind === "CUSTOMER" ? <span className={s.summaryItem}><IconUser size={18} />{customer?.name ?? "לקוח לא נבחר"}</span> : <span className={s.summaryItem}><IconUsers size={18} />{title.trim() || "פגישה"}</span>}
          <span className={s.summaryItem}><IconClock size={18} /><bdi dir="ltr">{time}{endsAt ? `–${endsAt}` : ""}</bdi></span>
          {kind === "CUSTOMER" ? <span className={s.summaryItem}><IconScissors size={18} />{service ? `${service.name} (${durationLabel(effectiveDuration)})` : durationLabel(effectiveDuration)}</span> : <span className={s.summaryItem}>{durationLabel(effectiveDuration)}</span>}
          {staffName ? <span className={s.summaryItem}><IconUser size={18} />{staffName}</span> : null}
        </section>
      ) : null}

      <div>
        <button type="button" className={s.fold} aria-expanded={more} aria-controls="appt-more" onClick={() => setMore(!more)}>
          <span>עוד פרטים</span><Chevron dir={more ? "up" : "down"} />
        </button>
        {more ? (
          <div className={s.foldBody} id="appt-more">
            {kind !== "BLOCK" ? (
              <div className={s.row2}>
                <div className={s.field}>
                  <label className={s.label} htmlFor="appt-location">מיקום</label>
                  <select id="appt-location" className={s.input} value={locationKind} onChange={(e) => { setLocationKind(e.target.value as typeof locationKind); touch(); }}>
                    <option value="">לא צוין</option>
                    {LOCATIONS.map((l) => <option key={l} value={l}>{LOCATION_LABEL[l]}</option>)}
                  </select>
                </div>
                <div className={s.field}>
                  <label className={s.label} htmlFor="appt-location-detail">פרטי מיקום</label>
                  <input id="appt-location-detail" className={`${s.input} ${shownErrors.locationDetail ? s.inputBad : ""}`} value={locationDetail} maxLength={LIMITS.locationDetail + 50} onChange={(e) => { setLocationDetail(e.target.value); touch(); }} placeholder="כתובת או קישור" />
                  <Counter value={locationDetail} max={LIMITS.locationDetail} />
                  <FieldErr id="appt-location-detail-err" text={shownErrors.locationDetail} />
                </div>
              </div>
            ) : null}
            {kind === "CUSTOMER" ? (
              <div className={s.field}>
                <label className={s.label} htmlFor="appt-title-c">כותרת (לא חובה)</label>
                <input id="appt-title-c" className={`${s.input} ${shownErrors.title ? s.inputBad : ""}`} value={title} maxLength={LIMITS.title + 50} onChange={(e) => { setTitle(e.target.value); touch(); }} placeholder={service?.name ?? "ברירת המחדל: שם השירות"} />
                <Counter value={title} max={LIMITS.title} />
                <FieldErr id="appt-title-c-err" text={shownErrors.title} />
              </div>
            ) : null}
            <div className={s.field}>
              <label className={s.label} htmlFor="appt-notes">הערות</label>
              <textarea id="appt-notes" className={`${s.input} ${shownErrors.notes ? s.inputBad : ""}`} rows={3} value={notes} maxLength={LIMITS.notes + 200} onChange={(e) => { setNotes(e.target.value); touch(); }} />
              <Counter value={notes} max={LIMITS.notes} />
              <FieldErr id="appt-notes-err" text={shownErrors.notes} />
            </div>
            {kind === "CUSTOMER" ? (
              <label className={s.check}>
                <input type="checkbox" checked={proposed} onChange={(e) => { setProposed(e.target.checked); touch(); }} />
                עוד לא אושר מול הלקוח (יסומן „ממתין לאישור”)
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

      {tried && anyError ? <p className={s.fieldErr} role="alert">כדאי להשלים את השדות המסומנים.</p> : null}
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      {conflict ? (
        <div className={s.conflict} role="status">
          {conflict.length ? (
            <>
              <span>שעות קרובות שפנויות:</span>
              <div className={s.chips}>
                {conflict.map((x) => (
                  <button key={x.startsAt} type="button" className={s.chip} disabled={busy} onClick={() => {
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

      <div className={s.sheetFoot}>
        <button type="submit" className={`${s.btn} ${s.btnPri} ${s.btnWide}`} disabled={busy}>{busy ? "שומר…" : verb}</button>
      </div>
    </form>
  );
}

// ── The customer field: search, pick, or create ──────────────────────────────────────────────────

function CustomerField({ value, onChange, autoFocus, error }: { value: CustomerWire | null; onChange: (c: CustomerWire | null) => void; autoFocus: boolean; error?: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CustomerWire[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (value || adding) return;
    let cancelled = false;
    const h = setTimeout(() => {
      setRows(null);
      searchCustomers(q, 8).then((r) => { if (!cancelled) { setRows(r); setFailed(false); } }).catch(() => { if (!cancelled) { setRows([]); setFailed(true); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, value, adding, tick]);

  if (value) {
    return (
      <Line label="לקוח" icon={<IconUser />}>
        <span className={s.lineValue}>
          {value.name}
          {value.phone ? <small><bdi dir="ltr">{formatPhoneForDisplay(value.phone)}</bdi></small> : null}
        </span>
        <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnSoft}`} onClick={() => { setAdding(true); setName(""); setPhone(""); onChange(null); }}>לקוח חדש</button>
        <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => onChange(null)}>החלפה</button>
      </Line>
    );
  }

  if (adding) {
    return (
      <fieldset className={`${s.line} ${s.field}`}>
        <legend className={s.label}>לקוח חדש</legend>
        <div className={s.row2}>
          <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" aria-label="שם הלקוח" autoFocus maxLength={120} />
          <input className={s.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון (לא חובה)" aria-label="טלפון" inputMode="tel" dir="ltr" maxLength={30} />
        </div>
        {err ? <p className={s.fieldErr} role="alert">{err}</p> : null}
        <div className={s.chips}>
          <button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} disabled={saving} onClick={async () => {
            if (!name.trim()) { setErr("צריך שם ללקוח."); return; }
            setSaving(true);
            try {
              onChange(await createCustomer({ name: name.trim(), phone: phone.trim() || null }));
            } catch {
              setErr("לא הצלחתי להוסיף את הלקוח. אפשר לנסות שוב.");
            } finally {
              setSaving(false);
            }
          }}>{saving ? "מוסיף…" : "הוספת הלקוח"}</button>
          <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => { setAdding(false); setErr(null); }}>חזרה לחיפוש</button>
        </div>
      </fieldset>
    );
  }

  return (
    <div className={s.line}>
      <label className={s.label} htmlFor="appt-customer">לקוח</label>
      <div className={s.lineMain}>
        <span className={s.lineIcon}><IconUser /></span>
        <input id="appt-customer" className={`${s.input} ${error ? s.inputBad : ""}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם או טלפון" autoFocus={autoFocus} autoComplete="off"
          aria-invalid={!!error} aria-describedby={error ? "appt-customer-err" : undefined} />
        <button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={() => { setAdding(true); setName(/\d{5,}/.test(q) ? "" : q.trim()); setPhone(/\d{5,}/.test(q) ? q.trim() : ""); }}>לקוח חדש</button>
      </div>
      <FieldErr id="appt-customer-err" text={error} />
      <div className={s.results} role="listbox" aria-label="לקוחות">
        {rows === null ? <span className={`${s.result} ${s.resultNone}`}>מחפש…</span> : null}
        {failed ? <span className={`${s.result} ${s.resultNone}`}>החיפוש נכשל. <button type="button" className={s.linkBtn} onClick={() => setTick((x) => x + 1)}>לנסות שוב</button></span> : null}
        {rows && !failed && !rows.length ? <span className={`${s.result} ${s.resultNone}`}>{q.trim() ? `לא נמצא לקוח בשם או בטלפון „${q.trim()}”.` : "אין עדיין לקוחות."}</span> : null}
        {rows?.map((c) => (
          <button key={c.id} type="button" role="option" aria-selected={false} className={s.result} onClick={() => onChange(c)}>
            <span>{c.name}</span>
            {c.phone ? <small><bdi dir="ltr">{formatPhoneForDisplay(c.phone)}</bdi></small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Move (שינוי מועד) ────────────────────────────────────────────────────────────────────────────

export function MoveForm({
  appt,
  staff,
  names,
  availability,
  onDone,
  onCancel,
  onDirty,
}: {
  appt: AppointmentWire;
  staff: StaffWire[];
  names: Names;
  availability: Availability;
  onDone: (out: FormDone) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
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
  const [touched, setTouched] = useState(false);
  const intent = useRef(`appt:move:${appt.id}:${uuidV7()}`);
  // Who may take it: for a customer appointment with a service, those who perform the service (and whoever has it now).
  const choices = (appt.kind === "CUSTOMER" ? staffForService(staff, appt.businessServiceId) : staff.filter((x) => x.active));
  const staffList = [...choices, ...staff.filter((x) => x.id === appt.staffMemberId && !choices.some((c) => c.id === x.id))];
  const [slots, setSlots] = useState<SlotWire[]>([]);
  const [slotsState, setSlotsState] = useState<"loading" | "ready" | "error" | "none">("none");
  const [slotsTick, setSlotsTick] = useState(0);
  const touch = () => { if (!touched) setTouched(true); };
  useEffect(() => { onDirty(touched); }, [touched, onDirty]);

  // The chosen day's free times for this length and lane. The appointment's own current time is busy in that answer,
  // so it is not offered — staying put needs no move.
  useEffect(() => {
    if (appt.kind === "BLOCK" || !(duration >= LIMITS.minDuration && duration <= LIMITS.maxDuration)) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      setSlotsState("loading");
      findSlots({ fromDay: day, toDay: day, businessServiceId: appt.kind === "CUSTOMER" ? appt.businessServiceId : null, durationMinutes: duration, staffMemberId: staffId })
        .then((r) => { if (!cancelled) { setSlots(r.slots.filter((x) => jerusalemDayKey(new Date(x.startsAt)) === day)); setSlotsState("ready"); } })
        .catch(() => { if (!cancelled) { setSlots([]); setSlotsState("error"); } });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [appt.kind, appt.businessServiceId, day, duration, staffId, slotsTick]);

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
      onDirty(false);
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
  const anyHours = availability.business.rules.length > 0 || [...availability.staff.values()].some((x) => x.rules.length > 0);
  const what = appt.kind === "BLOCK" ? "החסימה" : appt.kind === "INTERNAL" ? "הפגישה" : "התור";

  return (
    <form className={`${s.sheet} ${s.form}`} onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <SheetHead title="שינוי מועד" onClose={onCancel} />
      <p className={s.note}>כרגע: {DATE_LONG.format(start)} · <bdi dir="ltr">{timeLabel(appt).replace(/[⁦⁩]/g, "")}</bdi></p>
      <div>
        <Line label="תאריך" icon={<IconCalendar />} htmlFor="move-day">
          <span className={s.dateLine}>{dayTitle(day)}<input id="move-day" type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); touch(); } }} /></span>
          <Chevron dir="down" />
        </Line>
        {appt.kind !== "BLOCK" ? (
          <TimePick
            key={`${day}:${duration}:${staffId}`}
            slots={slots}
            slotsState={slotsState}
            time={time}
            onTime={(v) => { setTime(v); touch(); }}
            emptyText={!anyHours ? "עוד לא הוגדרו שעות פעילות, ולכן אין שעות מוצעות. אפשר לבחור כל שעה." : `אין שעה פנויה אחרת ביום הזה. ${noSlotsReason(availability, staffId, day, names) ?? ""} אפשר לבחור שעה אחרת.`.replace(/\s+/g, " ")}
            onRetry={() => setSlotsTick((x) => x + 1)}
            forceOther={false}
          />
        ) : (
          <Line label="שעה" icon={<IconClock />} htmlFor="appt-time">
            <input id="appt-time" type="time" step={300} className={s.input} value={time} onChange={(e) => { setTime(e.target.value); touch(); }} />
          </Line>
        )}
        <Line label="משך" icon={<IconClock />} htmlFor="move-duration">
          <input id="move-duration" type="number" inputMode="numeric" min={LIMITS.minDuration} max={LIMITS.maxDuration} step={5} className={s.input} style={{ maxWidth: 110 }} value={duration} onChange={(e) => { setDuration(Number(e.target.value)); touch(); }} />
          <span className={s.hint}>דק׳</span>
        </Line>
        {staffList.length ? (
          <Line label={appt.kind === "BLOCK" ? "למי לחסום" : "צוות"} icon={<IconUser />} htmlFor="move-staff">
            <select id="move-staff" className={s.lineSelect} value={staffId ?? ""} onChange={(e) => { setStaffId(e.target.value ? Number(e.target.value) : null); touch(); }}>
              <option value="">{appt.kind === "BLOCK" ? "כל העסק" : "ללא עובד"}</option>
              {staffList.map((x) => <option key={x.id} value={x.id}>{x.displayName}{x.active ? "" : " (לא פעיל)"}</option>)}
            </select>
            <Chevron dir="down" />
          </Line>
        ) : null}
      </div>
      {moveOutside ? <OutsideWarning text={moveOutside} verb="להזיז" /> : null}
      {error ? <p className={s.fieldErr} role="alert">{error}</p> : null}
      {conflict?.length ? (
        <div className={s.conflict}>
          <span>שעות קרובות שפנויות:</span>
          <div className={s.chips}>
            {conflict.map((x) => (
              <button key={x.startsAt} type="button" className={s.chip} disabled={busy} onClick={() => { setDay(jerusalemDayKey(new Date(x.startsAt))); setTime(clockOf(new Date(x.startsAt))); void submit(x.startsAt); }}>
                {slotLabel(x, day)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className={s.sheetFoot}>
        <button type="submit" className={`${s.btn} ${s.btnPri} ${s.btnWide}`} disabled={busy}>{busy ? "מזיז…" : moveOutside ? "להזיז בכל זאת" : `הזזת ${what}`}</button>
      </div>
    </form>
  );
}
