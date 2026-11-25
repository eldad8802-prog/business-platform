"use client";

/**
 * /book/manage#<token> — the customer's own link (Milestone C, D9 + D12). It shows the request's or appointment's
 * state, and lets the customer withdraw a pending request or cancel a confirmed appointment inside the business's
 * self-cancel window. The token is read from the URL fragment (never sent to a server by the browser) and POSTed.
 * Nothing else is shown: no other appointment, no customer data, no staff contact.
 *
 * G15 (appointments completion): while the business allows it and its window is open, a confirmed appointment can be
 * moved to another free time — the same service, the same staff member, only times the server computes as free now.
 */
import { useEffect, useRef, useState } from "react";

import { addCalendarDays, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { manage, reschedule, rescheduleSlots } from "./public-booking-client";
import {
  classify, clock, errorText, firstOpenDay, longDay, manageStateLabel, slotsByDay, STATE_TONE, tokenFromHash, weekDays, whenLong, whenShort,
  type ManageWire, type RescheduleSlotsWire,
} from "./public-booking-model";
import s from "./public-booking.module.css";

type Load = { state: "loading" } | { state: "ready"; view: ManageWire } | { state: "gone" } | { state: "error"; message: string };

export function ManageBooking() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const read = () => setToken(tokenFromHash(window.location.hash));
    const t = window.setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => { window.clearTimeout(t); window.removeEventListener("hashchange", read); };
  }, []);

  useEffect(() => {
    if (token === undefined) return;
    let live = true;
    const t = window.setTimeout(() => {
      if (token === null) { setLoad({ state: "gone" }); return; }
      setLoad({ state: "loading" });
      manage(token, "view").then((a) => {
        if (!live) return;
        if (a.ok) setLoad({ state: "ready", view: a.data });
        else if (classify(a.status, a.code) === "unavailable") setLoad({ state: "gone" });
        else setLoad({ state: "error", message: a.status === 0 ? "אין חיבור כרגע. אפשר לנסות שוב בעוד רגע." : errorText(classify(a.status, a.code), a.message) });
      });
    }, 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [token, tick]);

  useEffect(() => { headingRef.current?.focus(); }, [load.state]);

  const cancel = async () => {
    if (!token) return;
    setBusy(true);
    setErr(null);
    const a = await manage(token, "cancel");
    setBusy(false);
    setConfirm(false);
    if (a.ok) setLoad({ state: "ready", view: a.data });
    else setErr(errorText(classify(a.status, a.code), a.message));
  };

  return (
    <main className={s.page} dir="rtl" lang="he">
      <div className={s.sheet}>
        {load.state === "loading" ? (
          <div className={s.center} aria-busy="true"><p className={s.hint}>טוען…</p></div>
        ) : load.state === "gone" ? (
          <div className={s.center}>
            <h1 className={s.doneTitle} ref={headingRef} tabIndex={-1}>הקישור אינו זמין</h1>
            <p className={s.hint}>ייתכן שהקישור לא הועתק במלואו, שהוחלף בקישור חדש, או שעבר זמן רב מאז התור. אפשר לפנות לעסק ישירות.</p>
          </div>
        ) : load.state === "error" ? (
          <div className={s.center}>
            <h1 className={s.doneTitle} ref={headingRef} tabIndex={-1}>לא הצלחנו לטעון את התור</h1>
            <p className={s.hint}>{load.message}</p>
            <button type="button" className={`${s.btn} ${s.small}`} onClick={() => setTick((n) => n + 1)}>נסה שוב</button>
          </div>
        ) : (
          <View view={load.view} headingRef={headingRef} confirm={confirm} setConfirm={setConfirm} busy={busy} err={err} onCancel={() => void cancel()}
            token={token ?? null} onMoved={(v) => setLoad({ state: "ready", view: v })} />
        )}
      </div>
      <p className={s.foot}>הזמנת תורים באמצעות דוביז</p>
    </main>
  );
}

function View({ view, headingRef, confirm, setConfirm, busy, err, onCancel, token, onMoved }: {
  view: ManageWire;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  token: string | null;
  onMoved: (v: ManageWire) => void;
}) {
  const tone = STATE_TONE[view.state];
  const [moving, setMoving] = useState(false);
  return (
    <>
      <div className={s.top}>
        <div className={s.logo} aria-hidden="true">{view.businessName.trim().slice(0, 1) || "·"}</div>
        <div className={s.biz}><span className={s.bizName}>{view.businessName}</span><span className={s.bizSub}>התור שלך</span></div>
      </div>
      <div className={s.done}>
        <div className={`${s.ring} ${tone === "ok" ? s.ringOk : tone === "wait" ? s.ringWait : s.ringOff}`} aria-hidden="true">{tone === "ok" ? "✓" : tone === "wait" ? "⏳" : "–"}</div>
        <h1 className={s.doneTitle} ref={headingRef} tabIndex={-1}>{manageStateLabel(view)}</h1>
        <dl className={s.receipt}>
          <div><dt>שירות</dt><dd>{view.serviceName}</dd></div>
          {view.startsAt ? <div><dt>מתי</dt><dd>{whenLong(view.startsAt)}</dd></div> : null}
          {view.staffName ? <div><dt>אצל</dt><dd>{view.staffName}</dd></div> : null}
        </dl>
        {view.state === "PENDING" && view.expiresAt ? <p className={s.hint}>העסק עוד לא ענה. השעה שמורה לך עד {whenShort(view.expiresAt)}, ואז הבקשה תפוג.</p> : null}
        {view.state === "CONFIRMED" && view.cancelUntil ? <p className={s.hint}>אפשר לבטל דרך הקישור עד {whenShort(view.cancelUntil)}.</p> : null}
        {view.state === "CONFIRMED" && !view.canCancel ? <p className={s.hint}>{view.selfCancelEnabled === false ? "ביטול דרך הקישור לא אפשרי בעסק הזה. לשינוי או ביטול אפשר לפנות לעסק ישירות." : "כבר אי אפשר לבטל דרך הקישור. אפשר לפנות לעסק ישירות."}</p> : null}
        {view.state === "DECLINED" || view.state === "EXPIRED" ? <p className={s.hint}>השעה שוחררה. אפשר לפנות לעסק או לבקש תור אחר דרך הקישור של העסק.</p> : null}
        {view.state === "CONFIRMED" && view.canReschedule && view.rescheduleUntil ? <p className={s.hint}>אפשר לשנות את המועד דרך הקישור עד {whenShort(view.rescheduleUntil)}.</p> : null}
        {err ? <div className={s.banner} role="alert">{err}</div> : null}
      </div>
      {moving && token ? <Reschedule token={token} current={view.startsAt} onDone={(v) => { setMoving(false); if (v) onMoved(v); }} /> : null}
      {view.canReschedule && !moving && !confirm ? (
        <div className={s.cta} style={{ paddingBottom: 0 }}>
          <button type="button" className={`${s.btn} ${s.ghost}`} style={{ flex: 1 }} onClick={() => setMoving(true)}>שינוי מועד</button>
        </div>
      ) : null}
      {view.canCancel && !moving ? (
        <div className={s.cta}>
          {confirm ? (
            <div className={s.confirm} role="alertdialog" aria-labelledby="mg-cancel-q">
              <span id="mg-cancel-q">{view.state === "PENDING" ? "לבטל את הבקשה? השעה תשוחרר." : "לבטל את התור? השעה תשוחרר."}</span>
              <div className={s.ctaRow}>
                <button type="button" className={`${s.btn} ${s.danger}`} onClick={onCancel} disabled={busy}>{busy ? "מבטל…" : "כן, לבטל"}</button>
                <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setConfirm(false)} disabled={busy}>חזרה</button>
              </div>
            </div>
          ) : (
            <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => setConfirm(true)}>{view.state === "PENDING" ? "ביטול הבקשה" : "ביטול התור"}</button>
          )}
        </div>
      ) : null}
    </>
  );
}

/** G15: pick a new free time for the confirmed appointment (a week at a time, within the business's horizon). */
function Reschedule({ token, current, onDone }: { token: string; current: string | null; onDone: (v: ManageWire | null) => void }) {
  const today = jerusalemDayKey(new Date());
  const [weekStart, setWeekStart] = useState<JerusalemDayKey>(today);
  const [data, setData] = useState<RescheduleSlotsWire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState<JerusalemDayKey | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    rescheduleSlots(token, weekStart, addCalendarDays(weekStart, 6)).then((a) => {
      if (!live) return;
      if (!a.ok) { setErr(errorText(classify(a.status, a.code), a.message)); return; }
      setData(a.data);
      setDay(firstOpenDay(weekDays(weekStart, a.data.slots, new Date())));
    });
    return () => { live = false; };
  }, [token, weekStart]);

  const lastDay = addCalendarDays(today, data?.maxAdvanceDays ?? 60);
  const cells = data ? weekDays(weekStart, data.slots, new Date()) : [];
  const times = data && day ? slotsByDay(data.slots).get(day) ?? [] : [];

  const save = async () => {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    const a = await reschedule(token, pick);
    setBusy(false);
    if (a.ok) { onDone(a.data); return; }
    setErr(errorText(classify(a.status, a.code), a.message));
    if (classify(a.status, a.code) === "taken") { setPick(null); setWeekStart((w) => w); }
  };

  return (
    <div className={s.body}>
      <h2 className={s.h}>בחירת מועד חדש</h2>
      {current ? <p className={s.summary}>המועד הנוכחי: {whenLong(current)}</p> : null}
      <div className={s.weekNav}>
        <button type="button" className={s.iconBtn} onClick={() => { setWeekStart(addCalendarDays(weekStart, -7)); setPick(null); }} disabled={weekStart <= today} aria-label="השבוע הקודם">→</button>
        <span className={s.weekLabel}>{longDay(weekStart)} – {longDay(addCalendarDays(weekStart, 6))}</span>
        <button type="button" className={s.iconBtn} onClick={() => { setWeekStart(addCalendarDays(weekStart, 7)); setPick(null); }} disabled={addCalendarDays(weekStart, 7) > lastDay} aria-label="השבוע הבא">←</button>
      </div>
      {!data && !err ? <p className={s.hint} aria-busy="true">טוען שעות פנויות…</p> : null}
      {data ? (
        <>
          <div className={s.days} role="radiogroup" aria-label="יום">
            {cells.map((c) => (
              <button key={c.day} type="button" role="radio" aria-checked={c.day === day} disabled={c.count === 0}
                className={`${s.day} ${c.day === day ? s.dayOn : ""} ${c.count === 0 ? s.dayClosed : ""} ${c.today ? s.dayToday : ""}`}
                onClick={() => { setDay(c.day); setPick(null); }}>{c.weekday}<b>{c.num}</b></button>
            ))}
          </div>
          {cells.every((c) => c.count === 0) ? <p className={s.hint}>אין שעות פנויות בשבוע הזה.</p> : (
            <div className={s.times} role="radiogroup" aria-label="שעה">
              {times.map((iso) => <button key={iso} type="button" role="radio" aria-checked={iso === pick} className={`${s.time} ${iso === pick ? s.timeOn : ""}`} onClick={() => setPick(iso)}>{clock(iso)}</button>)}
            </div>
          )}
        </>
      ) : null}
      {err ? <div className={s.banner} role="alert">{err}</div> : null}
      <div className={s.ctaRow}>
        <button type="button" className={s.btn} disabled={!pick || busy} aria-busy={busy} onClick={() => void save()}>{busy ? "שומר…" : pick ? `העברה ל-${whenShort(pick)}` : "בחירת שעה"}</button>
        <button type="button" className={`${s.btn} ${s.ghost}`} disabled={busy} onClick={() => onDone(null)}>חזרה</button>
      </div>
    </div>
  );
}
