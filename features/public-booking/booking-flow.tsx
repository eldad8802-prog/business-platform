"use client";

/**
 * /book/<publicId> — a customer asks for an appointment (Milestone C, segment 3). No account, no password.
 *
 *   service → staff (only when the business lets the customer choose and shows who works there, D7/D8)
 *   → day and time (only times the server computes as free now) → name and phone, an optional note (D4)
 *   → the answer: "נקבע" (automatic approval) or "ממתינה לאישור" (manual, D2), with the customer's own link to check
 *     the status and cancel within the business's window (D9, D12).
 *
 * The server decides everything again under the business's lock; this page only offers what it was told is free.
 * A time taken while the customer was filling in is replaced by the three nearest free ones. One idempotency key per
 * attempt: a double tap or a retry returns the same booking, never a second one. While public booking is not open for
 * the business, every door answers 404 and the page says the link is unavailable — nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { addCalendarDays, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { getProfile, getSlots, manage, submitRequest, type Answer } from "./public-booking-client";
import {
  checkContact,
  classify,
  clock,
  CONTACT,
  durationLabel,
  errorText,
  fieldOf,
  firstOpenDay,
  longDay,
  manageUrl,
  nearestAlternatives,
  newRequestKey,
  priceLabel,
  serviceBookable,
  slotsByDay,
  stepsFor,
  STATE_LABEL,
  weekDays,
  whenLong,
  whenShort,
  type ContactErrors,
  type ManageWire,
  type ProfileWire,
  type ServiceWire,
  type SlotsWire,
  type Step,
  type SubmitWire,
} from "./public-booking-model";
import s from "./public-booking.module.css";

const STEP_TITLE: Record<Step, string> = { service: "איזה שירות?", staff: "אצל מי?", time: "מתי?", details: "הפרטים שלך" };
const MAX_WEEKS_AHEAD = 12;
const ANY = "any" as const;

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; kind: "unavailable" | "busy" | "generic"; message: string };

function loadOf<T>(a: Answer<T>): Load<T> {
  if (a.ok) return { state: "ready", data: a.data };
  const kind = classify(a.status, a.code);
  return { state: "error", kind: kind === "unavailable" ? "unavailable" : kind === "busy" ? "busy" : "generic", message: errorText(kind === "unavailable" ? "unavailable" : kind === "busy" ? "busy" : "generic", kind === "unavailable" ? undefined : a.message) };
}

export function BookingFlow({ publicId }: { publicId: string }) {
  const [profile, setProfile] = useState<Load<ProfileWire>>({ state: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [staff, setStaff] = useState<number | typeof ANY>(ANY);
  const [weekStart, setWeekStart] = useState<JerusalemDayKey>(() => jerusalemDayKey(new Date()));
  const [slots, setSlots] = useState<Load<SlotsWire>>({ state: "loading" });
  const [slotTick, setSlotTick] = useState(0);
  const [day, setDay] = useState<JerusalemDayKey | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ at: string; alternatives: string[] } | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [trap, setTrap] = useState("");
  const [errors, setErrors] = useState<ContactErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SubmitWire | null>(null);
  const keyRef = useRef<string | null>(null);
  // A synchronous guard: two taps in the same tick must not both send (the state flag updates a render later).
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const today = useMemo(() => jerusalemDayKey(new Date()), []);

  // ── the business ──
  useEffect(() => {
    let live = true;
    getProfile(publicId).then((a) => { if (live) setProfile(loadOf(a)); });
    return () => { live = false; };
  }, [publicId, reloadTick]);

  const prof = profile.state === "ready" ? profile.data : null;
  const service: ServiceWire | null = prof?.services.find((x) => x.id === serviceId) ?? null;
  const steps = prof ? stepsFor(prof, service) : (["service", "time", "details"] as Step[]);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const staffId = staff === ANY ? null : staff;

  // ── free times for the chosen week ──
  const slotKey = service ? `${service.id}:${staffId ?? ANY}:${weekStart}:${slotTick}` : null;
  useEffect(() => {
    if (!service || step !== "time") return;
    let live = true;
    const t = window.setTimeout(() => {
      setSlots({ state: "loading" });
      getSlots(publicId, { serviceId: service.id, staffId, fromDay: weekStart, toDay: addCalendarDays(weekStart, 6) }).then((a) => {
        if (!live) return;
        const l = loadOf(a);
        setSlots(l);
        if (l.state === "ready") {
          const cells = weekDays(weekStart, l.data.slots, new Date());
          setDay((d) => (d && cells.some((c) => c.day === d && c.count > 0) ? d : firstOpenDay(cells)));
        }
      });
    }, 0);
    return () => { live = false; window.clearTimeout(t); };
    // slotKey carries the service, the staff choice and the week.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, slotKey, step]);

  // ── focus follows the step (screen readers hear the new question) ──
  useEffect(() => { headingRef.current?.focus(); }, [step, result]);

  const freshKey = () => { keyRef.current = null; };
  const go = (to: Step) => { setFormError(null); setStep(to); window.scrollTo?.({ top: 0 }); };
  const next = () => { const i = steps.indexOf(step); if (i < steps.length - 1) go(steps[i + 1]); };
  const back = () => { const i = steps.indexOf(step); if (i > 0) go(steps[i - 1]); };

  const pickService = (id: number) => {
    if (id !== serviceId) { setStaff(ANY); setStartsAt(null); setDay(null); setTaken(null); freshKey(); }
    setServiceId(id);
  };
  const pickStaff = (v: number | typeof ANY) => {
    if (v !== staff) { setStartsAt(null); setDay(null); setTaken(null); freshKey(); }
    setStaff(v);
  };
  const pickTime = (iso: string) => { setStartsAt(iso); setTaken(null); freshKey(); };
  const moveWeek = (delta: number) => { setWeekStart((w) => addCalendarDays(w, delta * 7)); setDay(null); setStartsAt(null); };

  const submit = useCallback(async () => {
    if (!service || !startsAt || inFlight.current) return;
    const errs = checkContact(name, phone, note);
    setErrors(errs);
    if (Object.keys(errs).length) { setFormError("כדאי לתקן את השדות המסומנים."); return; }
    inFlight.current = true;
    setSending(true);
    setFormError(null);
    // The same attempt keeps its key: a double tap or a retry after a lost answer returns the same booking.
    keyRef.current ??= newRequestKey();
    const a = await submitRequest(publicId, keyRef.current, {
      serviceId: service.id,
      ...(staffId !== null ? { staffId } : {}),
      startsAt,
      name: name.replace(/\s+/g, " ").trim(),
      phone: phone.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      website: trap,
    });
    inFlight.current = false;
    setSending(false);
    if (a.ok) { setResult(a.data); return; }
    const kind = classify(a.status, a.code);
    if (kind === "taken") {
      // Someone took the time while the customer was filling in: back to the times, with the nearest free ones.
      freshKey();
      const d = jerusalemDayKey(new Date(startsAt));
      const from = d < weekStart || d > addCalendarDays(weekStart, 6) ? d : weekStart;
      const r = await getSlots(publicId, { serviceId: service.id, staffId, fromDay: from, toDay: addCalendarDays(from, 6) });
      const fresh = r.ok ? r.data.slots : [];
      setWeekStart(from);
      if (r.ok) setSlots({ state: "ready", data: r.data });
      setTaken({ at: startsAt, alternatives: nearestAlternatives(fresh, startsAt) });
      setStartsAt(null);
      setDay(d);
      go("time");
      return;
    }
    if (kind === "field") {
      const f = fieldOf(a.details);
      if (f) setErrors({ [f]: f === "phone" ? "מספר הטלפון לא נראה תקין." : f === "name" ? "צריך שם מלא." : "ההערה לא תקינה." });
      else freshKey();
      setFormError(errorText("field", a.message));
      return;
    }
    if (kind === "unavailable") { setProfile({ state: "error", kind: "unavailable", message: errorText("unavailable") }); return; }
    // limit / busy / network / anything else: the same key is kept, so trying again cannot book twice.
    setFormError(a.status === 0 ? "אין חיבור כרגע. אפשר לנסות שוב — הבקשה לא תישלח פעמיים." : errorText(kind, a.message));
  }, [name, note, phone, publicId, service, staffId, startsAt, trap, weekStart]);

  // ── whole-page states ──
  if (profile.state === "loading") {
    return (
      <Shell>
        <div className={s.top}><div className={s.logo} aria-hidden="true">·</div><div className={s.biz}><p className={s.bizSub} aria-busy="true">טוען…</p></div></div>
        <div className={s.skeleton} aria-hidden="true"><div className={s.skel} /><div className={s.skel} /><div className={s.skel} /></div>
      </Shell>
    );
  }
  if (profile.state === "error") {
    return (
      <Shell>
        <div className={s.center}>
          <h1 className={s.doneTitle} ref={headingRef} tabIndex={-1}>{profile.kind === "unavailable" ? "הקישור אינו זמין" : "לא הצלחנו לטעון את העמוד"}</h1>
          <p className={s.hint}>{profile.kind === "unavailable" ? "ייתכן שהעסק הפסיק לקבל הזמנות דרך הקישור, או שהקישור הוחלף. אפשר לפנות לעסק ישירות." : profile.message}</p>
          {profile.kind !== "unavailable" ? <button type="button" className={`${s.btn} ${s.small}`} onClick={() => { setProfile({ state: "loading" }); setReloadTick((n) => n + 1); }}>נסה שוב</button> : null}
        </div>
      </Shell>
    );
  }

  const p = profile.data;
  if (result) return <Shell><Business p={p} /><Answer result={result} business={p.business.name} headingRef={headingRef} /></Shell>;

  const bookable = p.services.filter((x) => serviceBookable(p, x));
  if (bookable.length === 0) {
    return (
      <Shell>
        <Business p={p} />
        <div className={s.center}>
          <h1 className={s.doneTitle} ref={headingRef} tabIndex={-1}>אין כרגע שירותים פתוחים להזמנה</h1>
          <p className={s.hint}>אפשר לפנות לעסק ישירות.</p>
        </div>
      </Shell>
    );
  }

  const cells = slots.state === "ready" ? weekDays(weekStart, slots.data.slots, new Date()) : [];
  const dayTimes = slots.state === "ready" && day ? slotsByDay(slots.data.slots).get(day) ?? [] : [];
  const canNext =
    step === "service" ? !!service
      : step === "staff" ? true
        : step === "time" ? !!startsAt
          : true;
  const chosenStaff = staffId !== null ? service?.staff?.find((x) => x.id === staffId)?.name ?? null : null;

  return (
    <Shell>
      <Business p={p} />
      <div className={s.progress}>
        <div className={s.bars} aria-hidden="true">{steps.map((x, i) => <span key={x} className={`${s.bar} ${i <= stepIndex ? s.barOn : ""}`} />)}</div>
        <span className={s.stepOf}>שלב {stepIndex + 1} מתוך {steps.length}</span>
      </div>

      <div className={s.body}>
        <h2 className={s.h} ref={headingRef} tabIndex={-1}>{STEP_TITLE[step]}</h2>

        {step === "service" ? (
          <>
            <div className={s.list} role="radiogroup" aria-label="שירות">
              {bookable.map((x) => {
                const pr = priceLabel(x.price);
                const on = x.id === serviceId;
                return (
                  <button key={x.id} type="button" role="radio" aria-checked={on} className={`${s.option} ${on ? s.optionOn : ""}`} onClick={() => pickService(x.id)}>
                    <span className={s.optionMain}><span className={s.optionName}>{x.name}</span><span className={s.optionMeta}>{durationLabel(x.durationMinutes)}{x.approval === "AUTO" ? " · נקבע מיד" : " · באישור העסק"}</span></span>
                    {pr ? <span className={s.price}>{pr}</span> : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {step === "staff" && service ? (
          <>
            <p className={s.summary}>{service.name} · {durationLabel(service.durationMinutes)}</p>
            <div className={s.list} role="radiogroup" aria-label="איש צוות">
              {p.staffChoice === "OPTIONAL" ? (
                <button type="button" role="radio" aria-checked={staff === ANY} className={`${s.option} ${staff === ANY ? s.optionOn : ""}`} onClick={() => pickStaff(ANY)}>
                  <span className={s.avatar} aria-hidden="true">✓</span>
                  <span className={s.optionMain}><span className={s.optionName}>כל איש צוות פנוי</span><span className={s.optionMeta}>הכי הרבה שעות לבחירה</span></span>
                </button>
              ) : null}
              {(service.staff ?? []).map((m) => {
                const on = staff === m.id;
                return (
                  <button key={m.id} type="button" role="radio" aria-checked={on} className={`${s.option} ${on ? s.optionOn : ""}`} onClick={() => pickStaff(m.id)}>
                    <span className={s.avatar} style={m.color ? { background: m.color } : undefined} aria-hidden="true">{m.name.slice(0, 1)}</span>
                    <span className={s.optionMain}><span className={s.optionName}>{m.name}</span></span>
                  </button>
                );
              })}
            </div>
            {p.staffChoice === "REQUIRED" && staff === ANY ? <p className={s.hint}>העסק מבקש לבחור איש צוות.</p> : null}
          </>
        ) : null}

        {step === "time" && service ? (
          <>
            <p className={s.summary}>{service.name}{chosenStaff ? ` · ${chosenStaff}` : steps.includes("staff") ? " · כל איש צוות פנוי" : ""}</p>
            {taken ? (
              <div className={s.banner} role="alert">
                השעה {clock(taken.at)} נתפסה בזמן שמילאת את הפרטים.
                {taken.alternatives.length ? " אלה השעות הקרובות שעדיין פנויות:" : " אפשר לבחור שעה אחרת."}
                {taken.alternatives.length ? (
                  <div className={s.bannerActions}>
                    {taken.alternatives.map((iso) => <button key={iso} type="button" className={`${s.time}`} onClick={() => { setDay(jerusalemDayKey(new Date(iso))); pickTime(iso); }}>{whenShort(iso)}</button>)}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className={s.weekNav}>
              <button type="button" className={s.iconBtn} onClick={() => moveWeek(-1)} disabled={weekStart <= today} aria-label="השבוע הקודם">→</button>
              <span className={s.weekLabel}>{longDay(weekStart)} – {longDay(addCalendarDays(weekStart, 6))}</span>
              <button type="button" className={s.iconBtn} onClick={() => moveWeek(1)} disabled={weekStart >= addCalendarDays(today, MAX_WEEKS_AHEAD * 7)} aria-label="השבוע הבא">←</button>
            </div>
            {slots.state === "loading" ? <div className={s.skeleton} style={{ padding: 0 }} aria-busy="true"><div className={s.skel} /><span className={s.srOnly}>טוען שעות פנויות…</span></div> : null}
            {slots.state === "error" ? (
              <div className={s.banner} role="alert">
                {slots.message}
                <div className={s.bannerActions}><button type="button" className={`${s.btn} ${s.small} ${s.ghost}`} onClick={() => setSlotTick((n) => n + 1)}>נסה שוב</button></div>
              </div>
            ) : null}
            {slots.state === "ready" ? (
              <>
                <div className={s.days} role="radiogroup" aria-label="יום">
                  {cells.map((c) => {
                    const on = c.day === day;
                    const closed = c.count === 0;
                    return (
                      <button key={c.day} type="button" role="radio" aria-checked={on} aria-disabled={closed} disabled={closed}
                        aria-label={`${longDay(c.day)}${closed ? " · אין שעות פנויות" : ` · ${c.count} שעות פנויות`}`}
                        className={`${s.day} ${on ? s.dayOn : ""} ${closed ? s.dayClosed : ""} ${c.today ? s.dayToday : ""}`}
                        onClick={() => { setDay(c.day); setStartsAt(null); }}>
                        {c.weekday}<b>{c.num}</b>
                      </button>
                    );
                  })}
                </div>
                {cells.every((c) => c.count === 0) ? (
                  <div className={`${s.note} ${s.noteInfo}`} role="status">
                    אין שעות פנויות בשבוע הזה.
                    <div className={s.bannerActions}><button type="button" className={`${s.btn} ${s.small} ${s.ghost}`} onClick={() => moveWeek(1)}>לשבוע הבא</button></div>
                  </div>
                ) : day ? (
                  <>
                    <p className={s.hint}>{longDay(day)} · מוצגות רק שעות שפנויות עכשיו</p>
                    <div className={s.times} role="radiogroup" aria-label="שעה">
                      {dayTimes.map((iso) => {
                        const on = iso === startsAt;
                        return <button key={iso} type="button" role="radio" aria-checked={on} className={`${s.time} ${on ? s.timeOn : ""}`} onClick={() => pickTime(iso)}>{clock(iso)}</button>;
                      })}
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {step === "details" && service && startsAt ? (
          <form className={s.list} noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} id="bk-form">
            <p className={s.summary}>{service.name} · {whenLong(startsAt)}{chosenStaff ? ` · ${chosenStaff}` : ""}</p>
            <div className={s.field}>
              <label className={s.label} htmlFor="bk-name">שם מלא</label>
              <input id="bk-name" className={`${s.input} ${errors.name ? s.inputBad : ""}`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={CONTACT.nameMax}
                aria-invalid={!!errors.name} aria-describedby={errors.name ? "bk-name-err" : undefined} required />
              {errors.name ? <span className={s.fieldErr} id="bk-name-err">{errors.name}</span> : null}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="bk-phone">טלפון</label>
              <input id="bk-phone" className={`${s.input} ${s.ltr} ${errors.phone ? s.inputBad : ""}`} value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={CONTACT.phoneMax}
                aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "bk-phone-err" : "bk-phone-hint"} required />
              {errors.phone ? <span className={s.fieldErr} id="bk-phone-err">{errors.phone}</span> : <span className={s.hint} id="bk-phone-hint">העסק ישתמש בו כדי לחזור אליך לגבי התור.</span>}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="bk-note">הערה לעסק (לא חובה)</label>
              <textarea id="bk-note" className={`${s.input} ${s.textarea} ${errors.note ? s.inputBad : ""}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={CONTACT.noteMax}
                aria-invalid={!!errors.note} aria-describedby={errors.note ? "bk-note-err" : undefined} />
              {errors.note ? <span className={s.fieldErr} id="bk-note-err">{errors.note}</span> : null}
            </div>
            {/* Bots fill every field; people never see this one. */}
            <div className={s.trap} aria-hidden="true">
              <label htmlFor="bk-website">אתר</label>
              <input id="bk-website" name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
            </div>
            <p className={s.note}>{service.approval === "AUTO" ? "התור ייקבע מיד אם השעה עדיין פנויה." : "התור יאושר על ידי העסק. השעה שמורה לך עד שיענה."} {p.selfCancel.enabled ? "תקבל קישור אישי לבדיקת המצב ולביטול." : "תקבל קישור אישי לבדיקת המצב."}</p>
            {formError ? <div className={s.banner} role="alert">{formError}</div> : null}
          </form>
        ) : null}
      </div>

      <div className={s.cta}>
        {step !== "service" && service ? (
          <div className={s.ctaSum}><span>{service.name}</span><span>{startsAt ? whenShort(startsAt) : durationLabel(service.durationMinutes)}</span></div>
        ) : null}
        <div className={s.ctaRow}>
          {stepIndex > 0 ? <button type="button" className={`${s.btn} ${s.ghost}`} onClick={back} disabled={sending}>חזרה</button> : null}
          {/* Distinct keys: React must never turn the "continue" button into the submit button while it is being
              clicked — the browser would then complete that click as a form submission. */}
          {step === "details" ? (
            <button key="send" type="submit" form="bk-form" className={s.btn} disabled={sending} aria-busy={sending}>{sending ? "שולח…" : service?.approval === "AUTO" ? "קביעת התור" : "שליחת בקשה לתור"}</button>
          ) : (
            <button key="next" type="button" className={s.btn} onClick={next} disabled={!canNext || (step === "staff" && p.staffChoice === "REQUIRED" && staff === ANY)}>המשך</button>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className={s.page} dir="rtl" lang="he">
      <div className={s.sheet}>{children}</div>
      <p className={s.foot}>הזמנת תורים באמצעות דוביז</p>
    </main>
  );
}

function Business({ p }: { p: ProfileWire }) {
  const b = p.business;
  const sub = [b.category, [b.address, b.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  return (
    <div className={s.top}>
      <div className={s.logo} aria-hidden="true">{b.name.trim().slice(0, 1) || "·"}</div>
      <div className={s.biz}>
        <h1 className={s.bizName}>{b.name}</h1>
        {sub ? <span className={s.bizSub}>{sub}</span> : null}
        {b.phone ? <span className={s.bizSub}><a href={`tel:${b.phone}`} dir="ltr">{b.phone}</a></span> : null}
      </div>
    </div>
  );
}

function Answer({ result, business, headingRef }: { result: SubmitWire; business: string; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const [view, setView] = useState<ManageWire | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const link = typeof window !== "undefined" ? manageUrl(window.location.origin, result.manageToken) : "";
  const state = view?.state ?? result.status;
  const off = state !== "PENDING" && state !== "CONFIRMED";
  const tone = state === "CONFIRMED" ? "ok" : state === "PENDING" ? "wait" : "off";

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    const a = await manage(result.manageToken, "cancel");
    setBusy(false);
    setConfirm(false);
    if (a.ok) setView(a.data);
    else setErr(errorText(classify(a.status, a.code), a.message));
  };

  return (
    <>
      <div className={s.done}>
        <div className={`${s.ring} ${tone === "ok" ? s.ringOk : tone === "wait" ? s.ringWait : s.ringOff}`} aria-hidden="true">{tone === "ok" ? "✓" : tone === "wait" ? "⏳" : "–"}</div>
        <h2 className={s.doneTitle} ref={headingRef} tabIndex={-1}>
          {state === "CONFIRMED" ? `התור נקבע ב${business}` : state === "PENDING" ? `הבקשה נשלחה ל${business}` : STATE_LABEL[state]}
        </h2>
        <span className={`${s.badge} ${tone === "ok" ? s.badgeOk : tone === "wait" ? s.badgeWait : s.badgeOff}`}>{STATE_LABEL[state]}</span>
        <dl className={s.receipt}>
          <div><dt>שירות</dt><dd>{result.serviceName}</dd></div>
          <div><dt>מתי</dt><dd>{whenLong(result.startsAt, result.endsAt)}</dd></div>
          <div><dt>אצל</dt><dd>{result.staffName ?? "ייקבע על ידי העסק"}</dd></div>
        </dl>
        {state === "PENDING" && result.expiresAt ? <p className={s.hint}>השעה שמורה לך עד שהעסק יענה, ולא אחרי {whenShort(result.expiresAt)}. אם לא יענה עד אז, הבקשה תפוג.</p> : null}
        {!off ? (
          <div className={s.linkBox}>
            <p className={s.hint}><b>כדאי לשמור את הקישור הזה.</b> דרכו אפשר לבדוק אם העסק אישר{result.selfCancelUntil || state === "PENDING" ? " ולבטל" : ""}. לא נשלחות הודעות — זה הקישור היחיד.</p>
            <div className={s.linkRow}>
              <code className={s.linkCode} dir="ltr">{link}</code>
              <button type="button" className={`${s.btn} ${s.small}`} onClick={() => { navigator.clipboard?.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }).catch(() => undefined); }}>{copied ? "הועתק" : "העתקה"}</button>
            </div>
            <span role="status" className={s.srOnly}>{copied ? "הקישור הועתק" : ""}</span>
          </div>
        ) : null}
        {state === "CONFIRMED" && result.selfCancelUntil ? <p className={s.hint}>אפשר לבטל דרך הקישור עד {whenShort(result.selfCancelUntil)}.</p> : null}
        {err ? <div className={s.banner} role="alert">{err}</div> : null}
      </div>
      {!off ? (
        <div className={s.cta}>
          {confirm ? (
            <div className={s.confirm} role="alertdialog" aria-labelledby="bk-cancel-q">
              <span id="bk-cancel-q">{state === "PENDING" ? "לבטל את הבקשה? השעה תשוחרר." : "לבטל את התור? השעה תשוחרר."}</span>
              <div className={s.ctaRow}>
                <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void cancel()} disabled={busy}>{busy ? "מבטל…" : "כן, לבטל"}</button>
                <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setConfirm(false)} disabled={busy}>חזרה</button>
              </div>
            </div>
          ) : (
            <div className={s.ctaRow}>
              <a className={`${s.btn} ${s.ghost}`} href={link} style={{ display: "grid", placeItems: "center", textDecoration: "none", flex: 1 }}>פתיחת הקישור</a>
              {state === "PENDING" || result.selfCancelUntil ? <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => setConfirm(true)}>{state === "PENDING" ? "ביטול הבקשה" : "ביטול התור"}</button> : null}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
