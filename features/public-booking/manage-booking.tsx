"use client";

/**
 * /book/manage#<token> — the customer's own link (Milestone C, D9 + D12). It shows the request's or appointment's
 * state, and lets the customer withdraw a pending request or cancel a confirmed appointment inside the business's
 * self-cancel window. The token is read from the URL fragment (never sent to a server by the browser) and POSTed.
 * Nothing else is shown: no other appointment, no customer data, no staff contact.
 */
import { useEffect, useRef, useState } from "react";

import { manage } from "./public-booking-client";
import { classify, errorText, manageStateLabel, STATE_TONE, tokenFromHash, whenLong, whenShort, type ManageWire } from "./public-booking-model";
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
          <View view={load.view} headingRef={headingRef} confirm={confirm} setConfirm={setConfirm} busy={busy} err={err} onCancel={() => void cancel()} />
        )}
      </div>
      <p className={s.foot}>הזמנת תורים באמצעות דוביז</p>
    </main>
  );
}

function View({ view, headingRef, confirm, setConfirm, busy, err, onCancel }: {
  view: ManageWire;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
}) {
  const tone = STATE_TONE[view.state];
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
        {err ? <div className={s.banner} role="alert">{err}</div> : null}
      </div>
      {view.canCancel ? (
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
