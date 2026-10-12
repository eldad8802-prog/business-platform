"use client";

import { useEffect, useRef, useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";

type Phase = { kind: "working" } | { kind: "verified"; message: string } | { kind: "failed"; message: string };

/**
 * Opened from the verification email. The link is the proof — no session is needed, so it works on
 * any device. The token is read from the fragment and dropped from the address bar at once.
 */
export default function VerifyEmailPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // a link is spent once; StrictMode must not post it twice
    once.current = true;
    const match = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash);
    if (match) window.history.replaceState(null, "", window.location.pathname);
    if (!match) {
      // After this effect, not inside it (no synchronous cascade).
      queueMicrotask(() => setPhase({ kind: "failed", message: "הקישור לא שלם. כדאי לפתוח אותו שוב מהמייל." }));
      return;
    }
    fetch("/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(match[1]) }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ok) setPhase({ kind: "verified", message: d?.message ?? "כתובת האימייל אומתה. תודה!" });
        else setPhase({ kind: "failed", message: d?.error ?? "הקישור לא תקין." });
      })
      .catch(() => setPhase({ kind: "failed", message: "אין חיבור כרגע. כדאי לרענן את הדף ולנסות שוב." }));
  }, []);

  if (phase.kind === "working") {
    return (
      <AuthCard title="אימות כתובת האימייל">
        <p className={s.info} role="status"><span className={s.spinner} aria-hidden="true" />מאמתים…</p>
      </AuthCard>
    );
  }
  if (phase.kind === "verified") {
    return (
      <AuthCard title="הכתובת אומתה" lede={phase.message}>
        <p className={s.success} role="status" data-testid="verify-done">אפשר להמשיך לעבוד כרגיל.</p>
        <PrimaryCta href="/app" block>כניסה ל־Dubiz</PrimaryCta>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="לא הצלחנו לאמת את הכתובת">
      <div className={s.alert} role="alert" data-testid="verify-failed">{phase.message}</div>
      <p className={s.info}>אפשר לבקש קישור חדש מתוך Dubiz, בפס שמופיע בראש המסך.</p>
      <PrimaryCta href="/app" block>כניסה ל־Dubiz</PrimaryCta>
    </AuthCard>
  );
}
