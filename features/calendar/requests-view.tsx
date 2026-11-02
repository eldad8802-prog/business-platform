"use client";

/**
 * "בקשות" — requests from the business's booking link (Milestone C), design direction A.
 *
 *   ממתינות לאישור      who / what / when / with whom, how long it still holds its time (urgent under two hours), the
 *                       phone as plain call / WhatsApp links, the note, a possible match to an existing customer, and:
 *                       אישור · דחייה (each asked once more) · הצגה ביומן.
 *   לקשר לכרטיס לקוח    confirmed bookings from the link whose customer card is not linked yet (D6): link to the match,
 *                       or create a card from the request's name and phone — only by the owner's click.
 *   טופלו ב־24 השעות     what happened lately — a customer's cancellation of an approved booking reads "התור בוטל".
 *
 * Approve / decline go through the calendar's own status change, with the appointment's version: a request handled
 * meanwhile (another device, the customer withdrew, it lapsed) is refused and the list is reloaded with a message.
 * Opened from a push with an action (?request=&requestAction=), it asks for confirmation first — never acts alone.
 * Names are isolated (⁨…⁩), so a Latin name never sticks to its Hebrew prefix.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { telHref, whatsAppChatHref } from "@/components/customers/customer-contact";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

import {
  CalendarApiError,
  decideRequest,
  forgetIntent,
  linkRequestCustomer,
  listBookingRequests,
  type BookingRequestWire,
  type BookingRequestsWire,
} from "./calendar-client";
import { clockOf, errorText, requestOutcome, timeLeftLabel, todayKey, type DayKey } from "./calendar-model";
import { Empty, IconBell, IconChat, IconPhone, Loading, LoadError } from "./ui";
import s from "./calendar.module.css";

const whenText = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jerusalem" }).format(new Date(iso)) + " · " + clockOf(new Date(iso)) : "ללא שעה";

/** A name inside Hebrew text, isolated (FSI … PDI). */
const nm = (name: string) => `⁨${name}⁩`;

const STALE = new Set(["VERSION_CONFLICT", "REQUEST_EXPIRED", "INVALID_TRANSITION", "NOT_FOUND", "CONFLICT"]);

export function RequestsView({
  focusId,
  focusAction,
  onOpen,
  onChanged,
  flash,
}: {
  focusId: number | null;
  focusAction: "approve" | "decline" | null;
  onOpen: (day: DayKey, appointmentId: number) => void;
  onChanged: () => void;
  flash: (text: string) => void;
}) {
  const [data, setData] = useState<BookingRequestsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; action: "approve" | "decline" } | null>(null);
  const focused = useRef(false);

  const load = useCallback(() => listBookingRequests().then(
    (next) => {
      setData(next);
      setError(null);
      // Opened from a push: show that request once, and ask before acting on the chosen action.
      if (!focused.current && focusId !== null) {
        focused.current = true;
        if (focusAction && next.pending.some((r) => r.id === focusId)) setConfirm({ id: focusId, action: focusAction });
        window.requestAnimationFrame(() => document.getElementById(`request-${focusId}`)?.scrollIntoView({ block: "center" }));
      }
    },
    (e) => setError(e instanceof CalendarApiError ? errorText(e.code, e.status) : errorText("NETWORK")),
  ), [focusId, focusAction]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) { setNow(new Date()); void load(); } };
    const first = window.setTimeout(tick, 0);
    const h = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(h); };
  }, [load]);

  const run = async (r: BookingRequestWire, action: "approve" | "decline") => {
    const intent = `booking:${action}:${r.id}:${r.appointment.version}`;
    setBusy(r.id);
    try {
      await decideRequest(intent, r.id, action, r.appointment.version);
      flash(action === "approve" ? `התור של ${nm(r.contactName)} אושר` : `הבקשה של ${nm(r.contactName)} נדחתה`);
      setConfirm(null);
    } catch (e) {
      forgetIntent(intent);
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      flash(STALE.has(err.code) || err.code === "SLOT_CONFLICT"
        ? (err.code === "REQUEST_EXPIRED" ? "הבקשה כבר פגה, והשעה התפנתה." : "הבקשה כבר טופלה (אולי במכשיר אחר). הרשימה עודכנה.")
        : errorText(err.code, err.status));
      setConfirm(null);
    } finally {
      setBusy(null);
      await load();
      onChanged();
    }
  };

  const link = async (r: BookingRequestWire, input: { customerId: number } | { create: true }) => {
    setBusy(r.id);
    try {
      await linkRequestCustomer(r.id, input, r.appointment.version);
      flash("create" in input ? `נוצר כרטיס לקוח ל־${nm(r.contactName)}` : "התור קושר לכרטיס הלקוח");
    } catch (e) {
      const err = e instanceof CalendarApiError ? e : new CalendarApiError(0, "NETWORK");
      flash(err.details.reason === "PHONE_EXISTS" ? "כבר יש לקוח עם הטלפון הזה — אפשר לקשר אליו." : STALE.has(err.code) ? "התור השתנה בינתיים. הרשימה עודכנה." : errorText(err.code, err.status));
    } finally {
      setBusy(null);
      await load();
      onChanged();
    }
  };

  if (error && !data) return <LoadError text={`לא הצלחתי לטעון את הבקשות. ${error}`} onRetry={() => void load()} />;
  if (!data) return <Loading label="טוען בקשות" />;

  const empty = data.pending.length === 0 && data.toLink.length === 0 && data.recent.length === 0;

  const Phone = ({ phone }: { phone: string | null }) => {
    if (!phone) return null;
    const tel = telHref(phone);
    const wa = whatsAppChatHref(phone);
    return (
      <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
        <bdi dir="ltr">{formatPhoneForDisplay(phone)}</bdi>
        {tel ? <a href={tel} aria-label={`חיוג אל ${phone}`} className={s.linkBtn}><IconPhone size={16} /></a> : null}
        {wa ? <a href={wa} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp אל ${phone}`} className={s.linkBtn}><IconChat size={16} /></a> : null}
      </span>
    );
  };

  return (
    <div className={s.reqList}>
      {error ? <LoadError text={`הרשימה לא התעדכנה. ${error}`} onRetry={() => void load()} /> : null}
      <section aria-labelledby="req-pending-title" className={s.reqSection}>
        <h2 id="req-pending-title" className={s.reqHead}>ממתינות לאישור {data.pending.length ? <span className={s.badge}>{data.pending.length}</span> : null}</h2>
        {data.pending.length === 0 ? <p className={s.note}>אין בקשות שממתינות לך.</p> : null}
        {data.pending.map((r) => {
          const left = timeLeftLabel(r.expiresAt, now);
          const asking = confirm?.id === r.id ? confirm.action : null;
          return (
            <article key={r.id} id={`request-${r.id}`} className={`${s.req} ${focusId === r.id ? s.reqFocus : ""}`} aria-labelledby={`req-${r.id}-name`}>
              <div className={s.reqTop}>
                <h3 id={`req-${r.id}-name`} className={s.reqName}>{r.contactName}</h3>
                <span className={`${s.status} ${left.urgent ? s.st_NO_SHOW : s.st_PROPOSED}`}>ממתינה · {left.text}</span>
              </div>
              <p className={s.reqLine}>{r.serviceName ?? "תור"} · <bdi>{whenText(r.appointment.startsAt)}</bdi>{r.staffName ? ` · ${r.staffName}` : ""}</p>
              <p className={s.reqFacts}>
                <Phone phone={r.contactPhone} />
                {r.note ? <span>הערה: „{r.note}”</span> : null}
                {r.match ? <span className={s.reqMatch}>לקוח קיים לפי הטלפון: {r.match.name}</span> : <span>לקוח חדש</span>}
              </p>
              {asking ? (
                <div className={s.confirm} role="alertdialog" aria-labelledby={`req-${r.id}-confirm`}>
                  <strong id={`req-${r.id}-confirm`}>{asking === "approve" ? `לאשר את התור של ${nm(r.contactName)}?` : `לדחות את הבקשה של ${nm(r.contactName)}? השעה תתפנה.`}</strong>
                  <div className={s.confirmRow}>
                    <button type="button" className={`${s.btn} ${asking === "approve" ? s.btnPri : s.btnDangerFill}`} disabled={busy === r.id} autoFocus onClick={() => void run(r, asking)}>
                      {busy === r.id ? "שומר…" : asking === "approve" ? "כן, לאשר" : "כן, לדחות"}
                    </button>
                    <button type="button" className={s.btn} disabled={busy === r.id} onClick={() => setConfirm(null)}>חזרה</button>
                  </div>
                </div>
              ) : (
                <div className={s.actionsRow}>
                  <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy !== null} onClick={() => setConfirm({ id: r.id, action: "approve" })}>אישור</button>
                  <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={busy !== null} onClick={() => setConfirm({ id: r.id, action: "decline" })}>דחייה</button>
                  {r.appointment.startsAt ? (
                    <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={() => onOpen(todayKey(new Date(r.appointment.startsAt!)), r.appointment.id)}>הצגה ביומן</button>
                  ) : null}
                </div>
              )}
            </article>
          );
        })}
      </section>

      {data.toLink.length ? (
        <section aria-labelledby="req-link-title" className={s.reqSection}>
          <h2 id="req-link-title" className={s.reqHead}>לקשר לכרטיס לקוח <span className={s.badge}>{data.toLink.length}</span></h2>
          <p className={s.note}>תורים מהקישור שאושרו. הקישור לכרטיס לקוח נעשה רק כשמאשרים כאן.</p>
          {data.toLink.map((r) => (
            <article key={r.id} id={`request-${r.id}`} className={`${s.req} ${focusId === r.id ? s.reqFocus : ""}`} aria-labelledby={`req-${r.id}-lname`}>
              <div className={s.reqTop}>
                <h3 id={`req-${r.id}-lname`} className={s.reqName}>{r.contactName}</h3>
                <span className={`${s.status} ${s.st_CONFIRMED}`}>מאושר</span>
              </div>
              <p className={s.reqLine}>{r.serviceName ?? "תור"} · <bdi>{whenText(r.appointment.startsAt)}</bdi></p>
              <p className={s.reqFacts}><Phone phone={r.contactPhone} /></p>
              <div className={s.actionsRow}>
                {r.match ? (
                  <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy !== null} onClick={() => void link(r, { customerId: r.match!.customerId })}>לקשר ל־{nm(r.match.name)}</button>
                ) : (
                  <button type="button" className={`${s.btn} ${s.btnSoft}`} disabled={busy !== null} onClick={() => void link(r, { create: true })}>יצירת כרטיס לקוח</button>
                )}
                {r.appointment.startsAt ? (
                  <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={() => onOpen(todayKey(new Date(r.appointment.startsAt!)), r.appointment.id)}>הצגה ביומן</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {data.recent.length ? (
        <section aria-labelledby="req-recent-title" className={s.reqSection}>
          <h2 id="req-recent-title" className={s.reqHead}>טופלו ב־24 השעות האחרונות</h2>
          <ul className={s.reqRecent}>
            {data.recent.map((r) => {
              const out = requestOutcome(r);
              return (
                <li key={r.id}>
                  <span>{r.contactName} · {r.serviceName ?? "תור"} · <bdi>{whenText(r.appointment.startsAt)}</bdi></span>
                  <span className={`${s.status} ${out.tone === "ok" ? s.st_CONFIRMED : s.st_CANCELED}`}>{out.label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {empty ? (
        <Empty title="אין עדיין בקשות מהקישור" icon={<IconBell size={32} />}>
          <span>כשלקוחות יבקשו תור דרך קישור ההזמנות של העסק, הבקשות יופיעו כאן.</span>
        </Empty>
      ) : null}
      <p className={s.note}><Link href="/calendar/booking" prefetch={false} className={s.linkBtn}>הגדרות הזמנת תורים בקישור</Link></p>
    </div>
  );
}
