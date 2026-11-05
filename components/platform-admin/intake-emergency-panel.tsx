"use client";

/**
 * Leads L1.5-a — the intake EMERGENCY SWITCH console (Hebrew, RTL, mobile first).
 *
 * One card per intake source: its switch state, when it last changed and by whom. Changing a switch opens an inline
 * confirmation that explains what it does, asks for a reason and for the source key typed again; the server enforces
 * platform admin + a FRESH MFA step-up (the request core opens the prompt), the operational gate, the typed
 * confirmation, a stale check against the state shown here, the FG lock, and audits every attempt. One change at a
 * time: every action is disabled while a request is in flight.
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchIntakeEmergencyStates,
  postIntakeEmergency,
  PlatformAdminFetchError,
  type IntakeEmergencyFeatureView,
} from "@/lib/platform-admin/fetch-platform-admin";
import { consoleStyles as s } from "./console/admin-console";

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; features: IntakeEmergencyFeatureView[]; operational: boolean };
type Flash = { kind: "ok" | "fail"; text: string } | null;

const REASON_MIN = 10;

const FAILURE_TEXT: Record<string, string> = {
  stale: "המצב השתנה בינתיים (כנראה על ידי מנהל אחר). המסך רוענן — בדקו ונסו שוב.",
  busy: "המערכת עסוקה בכתיבת פניות כרגע ולא הספיקה להחיל את השינוי תוך 5 שניות. לא בוצע שינוי — נסו שוב.",
  refused: "מסד הנתונים דחה את הבקשה (מקור, סיבה או מבצע לא תקינים). לא בוצע שינוי.",
  unavailable: "מתג החירום עדיין לא זמין בסביבה הזו (המיגרציה לא הוחלה). לא בוצע שינוי.",
  not_operational: "מתג החירום טרם הופעל מבצעית בסביבה הזו. לא בוצע שינוי.",
};

function failureText(error: unknown): string {
  if (error instanceof PlatformAdminFetchError) {
    if (error.status === 403) return "נדרש אימות דו־שלבי טרי (עד 5 דקות). הפעולה לא בוצעה.";
    if (FAILURE_TEXT[error.message]) return FAILURE_TEXT[error.message];
    if (error.status === 400) return "הבקשה לא תקינה — בדקו את הסיבה ואת מזהה המקור. לא בוצע שינוי.";
    if (error.status === 503) return FAILURE_TEXT.not_operational;
  }
  return "הפעולה נכשלה. לא בוצע שינוי.";
}

function when(iso: string | null): string {
  if (!iso) return "לא שונה מעולם";
  return new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}

export function IntakeEmergencyPanel() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchIntakeEmergencyStates();
      setLoad({ kind: "ready", features: data.features, operational: data.operational });
    } catch (error) {
      setLoad({ kind: "error", message: error instanceof PlatformAdminFetchError && error.status === 403 ? "אין הרשאה." : "טעינת המצב נכשלה." });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchIntakeEmergencyStates().then(
      (data) => { if (!cancelled) setLoad({ kind: "ready", features: data.features, operational: data.operational }); },
      (error) => { if (!cancelled) setLoad({ kind: "error", message: error instanceof PlatformAdminFetchError && error.status === 403 ? "אין הרשאה." : "טעינת המצב נכשלה." }); }
    );
    return () => { cancelled = true; };
  }, []);

  const start = (featureKey: string) => {
    setOpen(featureKey);
    setReason("");
    setConfirm("");
    setFlash(null);
  };

  const submit = async (f: IntakeEmergencyFeatureView) => {
    if (busy) return; // one change at a time
    setBusy(true);
    setFlash(null);
    try {
      const { result } = await postIntakeEmergency({ featureKey: f.featureKey, on: !f.emergencyOn, expectedOn: f.emergencyOn, reason: reason.trim(), confirm });
      setFlash({ kind: "ok", text: result.isOn ? `מתג החירום הופעל עבור ${f.displayName}. פניות מאומתות נשמרות וממתינות ואינן מעובדות.` : `מתג החירום כובה עבור ${f.displayName}. הפניות שהמתינו ישוחררו לעיבוד בבדיקה הבאה (עד כ־10 דקות).` });
      setOpen(null);
    } catch (error) {
      setFlash({ kind: "fail", text: failureText(error) });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  if (load.kind === "loading") return <div className={s.stateBox} aria-busy="true">טוען את מצב מקורות הקליטה…</div>;
  if (load.kind === "error") {
    return (
      <div className={`${s.stateBox} ${s.stateError}`} role="alert">
        <p>{load.message}</p>
        <button type="button" className={s.btn} onClick={() => { setLoad({ kind: "loading" }); void refresh(); }}>נסו שוב</button>
      </div>
    );
  }

  return (
    <div dir="rtl">
      <div className={s.note} role="note">
        <strong>מה עושה מתג החירום?</strong> כשהוא מופעל למקור, פניות מאומתות מאותו מקור <strong>נשמרות וממתינות</strong> —
        לא נוצרים מהן לידים, הזמנות או שיחות — עד שהמתג יכובה. זה נועד לתקלה אצל ספק או בעיבוד, לא לסגירת מקור לעסק
        (לזה משמשת הרשאת העסק). המתג חל על <strong>כל העסקים</strong>.
      </div>
      {!load.operational && (
        <div className={`${s.stateBox} ${s.stateError}`} role="status">
          המתג טרם הופעל מבצעית בסביבה הזו — אפשר לראות את המצב, אבל לא לשנות אותו.
        </div>
      )}
      {flash && (
        <div className={flash.kind === "ok" ? s.stateBox : `${s.stateBox} ${s.stateError}`} role={flash.kind === "ok" ? "status" : "alert"}>
          {flash.text}
        </div>
      )}
      <div className={s.cards}>
        {load.features.map((f) => {
          const isOpen = open === f.featureKey;
          const canSubmit = !busy && reason.trim().length >= REASON_MIN && confirm === f.featureKey;
          return (
            <section key={f.featureKey} className={f.emergencyOn ? `${s.card} ${s.cardAttention}` : s.card} aria-labelledby={`em-${f.featureKey}`}>
              <div className={s.cardHead}>
                <h2 id={`em-${f.featureKey}`}>{f.displayName}</h2>
                <span className={f.emergencyOn ? `${s.pill} ${s.pillBad}` : `${s.pill} ${s.pillOk}`}>
                  {f.emergencyOn ? "מתג חירום מופעל — פניות ממתינות" : "פעיל כרגיל"}
                </span>
              </div>
              <p className={s.muted}>
                <bdi>{f.featureKey}</bdi> · שינוי אחרון: {when(f.updatedAt)}
                {f.updatedByEmail ? <> · על ידי <bdi>{f.updatedByEmail}</bdi></> : null}
              </p>
              {!isOpen ? (
                <button
                  type="button"
                  className={f.emergencyOn ? `${s.btn} ${s.btnPrimary}` : `${s.btn} ${s.btnDanger}`}
                  disabled={busy || !load.operational || open !== null}
                  onClick={() => start(f.featureKey)}
                >
                  {f.emergencyOn ? "כיבוי מתג החירום" : "הפעלת מתג החירום"}
                </button>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(f); }} aria-label={`אישור שינוי עבור ${f.displayName}`}>
                  <p role="alert" className={s.error}>
                    {f.emergencyOn
                      ? "כיבוי המתג ישחרר את כל הפניות שממתינות ממקור זה לעיבוד (לידים, הזמנות או שיחות ייווצרו מהן), אחרי בדיקת הרשאות מחודשת."
                      : "הפעלת המתג תעצור את עיבוד כל הפניות ממקור זה בכל העסקים. הן יישמרו וימתינו עד הכיבוי — שום ליד, הזמנה או שיחה לא ייווצרו בינתיים."}
                  </p>
                  <label className={s.field}>
                    סיבה (לפחות {REASON_MIN} תווים, תירשם ביומן הביקורת)
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} disabled={busy} required />
                  </label>
                  <label className={s.field}>
                    להקליד שוב את מזהה המקור לאישור: <bdi>{f.featureKey}</bdi>
                    <input value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" autoComplete="off" spellCheck={false} disabled={busy} required />
                  </label>
                  <div className={s.actions}>
                    <button type="submit" className={f.emergencyOn ? `${s.btn} ${s.btnPrimary}` : `${s.btn} ${s.btnDanger}`} disabled={!canSubmit} aria-busy={busy}>
                      {busy ? "מבצע…" : f.emergencyOn ? "לכבות את המתג" : "להפעיל את המתג"}
                    </button>
                    <button type="button" className={s.btn} disabled={busy} onClick={() => setOpen(null)}>ביטול</button>
                  </div>
                </form>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
