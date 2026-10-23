"use client";

/**
 * "תזכורות לטלפון" — the one place push is switched on (owner-approved plan 2026-10-21). It says plainly what this
 * device needs (iPhone: add to the home screen first), asks for permission only on a tap, and says that a reminder
 * is sent at the chosen time even in quiet hours. Hidden once push is on (a small "כבוי" link stays available).
 */
import { useEffect, useState } from "react";

import { disablePush, enablePush, pushState, pushSupport, type PushState } from "@/lib/push/push-client";

import s from "./tasks.module.css";

export function PushCard() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [support] = useState<ReturnType<typeof pushSupport> | null>(() => (typeof window === "undefined" ? null : pushSupport()));

  useEffect(() => {
    let cancelled = false;
    pushState()
      .then((x) => !cancelled && setState(x))
      .catch(() => !cancelled && setState("unavailable"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading" || !support) return null;

  if (state === "on") {
    return (
      <p className={s.hint} style={{ margin: "4px 0 8px" }}>
        תזכורות לטלפון פעילות במכשיר הזה.{" "}
        <button type="button" className={`${s.btn} ${s.ghost}`} disabled={busy} onClick={async () => { setBusy(true); setState(await disablePush()); setBusy(false); }}>
          כיבוי
        </button>
      </p>
    );
  }

  let body: React.ReactNode;
  if (support.kind === "ios-needs-install") {
    body = (
      <>
        <strong>באייפון:</strong> כדי לקבל תזכורות גם כשדוביז סגורה, יש להוסיף את דוביז למסך הבית — ב־Safari: כפתור השיתוף ←
        &quot;הוסף למסך הבית&quot;, ואז לפתוח את דוביז מהאייקון ולהפעיל כאן. (נדרש iOS 16.4 ומעלה.)
      </>
    );
  } else if (support.kind === "ios-too-old") {
    body = <>תזכורות לטלפון באייפון דורשות iOS 16.4 ומעלה. התזכורות יופיעו בתוך דוביז ובפעמון.</>;
  } else if (state === "denied") {
    body = <>ההתראות חסומות בדפדפן הזה. אפשר לאפשר אותן בהגדרות האתר בדפדפן, ואז לחזור לכאן.</>;
  } else if (state === "unavailable") {
    body = <>במכשיר או בדפדפן הזה אין התראות לטלפון. התזכורות יופיעו בתוך דוביז ובפעמון.</>;
  } else {
    body = (
      <>
        קבל את התזכורות שקבעת גם כשדוביז סגורה. התזכורת נשלחת בדיוק בשעה שבחרת — גם בשעות השקטות.{" "}
        <button type="button" className={`${s.btn} ${s.pri}`} disabled={busy} onClick={async () => { setBusy(true); setState(await enablePush()); setBusy(false); }}>
          {busy ? "מפעיל…" : "הפעלת תזכורות לטלפון"}
        </button>
      </>
    );
  }
  return (
    <div className={`${s.fact} ${s.factNeutral}`} role="note" style={{ margin: "4px 0 8px" }}>
      {body}
    </div>
  );
}
