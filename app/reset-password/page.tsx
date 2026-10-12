"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-identity";
import { clearClientSession } from "@/lib/client-session";

type Phase =
  | { kind: "checking" }
  | { kind: "unusable"; message: string }
  | { kind: "form" }
  | { kind: "done" };

/** Reads `#t=<token>` and drops it from the address bar at once, so it is not left in history. */
function takeToken(): string | null {
  const match = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash);
  if (match) window.history.replaceState(null, "", window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = takeToken();
    if (!t) {
      // After this effect, not inside it (no synchronous cascade).
      queueMicrotask(() =>
        setPhase({ kind: "unusable", message: "הקישור לא שלם. כדאי לפתוח אותו שוב מהמייל, או לבקש קישור חדש." })
      );
      return;
    }
    queueMicrotask(() => setToken(t));
    fetch("/api/auth/password/reset/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ok && d?.status === "VALID") setPhase({ kind: "form" });
        else setPhase({ kind: "unusable", message: d?.error ?? "הקישור לא תקין. כדאי לבקש קישור חדש." });
      })
      .catch(() => setPhase({ kind: "form" })); // the submit re-checks everything anyway
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: { password?: string; confirm?: string } = {};
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`;
    if (confirm !== password) next.confirm = "הסיסמאות לא זהות";
    setFieldError(next);
    if (Object.keys(next).length > 0 || !token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // Every session of the account was just revoked — this browser's included.
        clearClientSession();
        setPhase({ kind: "done" });
      } else if (data?.field === "password") {
        setFieldError({ password: data.error });
      } else if (typeof data?.code === "string" && data.code.startsWith("TOKEN_")) {
        setPhase({ kind: "unusable", message: data.error });
      } else {
        setFormError(data?.error ?? "משהו השתבש אצלנו. כדאי לנסות שוב בעוד רגע.");
      }
    } catch {
      setFormError("אין חיבור כרגע. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.");
    } finally {
      setLoading(false);
    }
  }

  if (phase.kind === "checking") {
    return (
      <AuthCard title="בחירת סיסמה חדשה">
        <p className={s.info} role="status"><span className={s.spinner} aria-hidden="true" />בודקים את הקישור…</p>
      </AuthCard>
    );
  }

  if (phase.kind === "unusable") {
    return (
      <AuthCard title="אי אפשר להשתמש בקישור">
        <div className={s.alert} role="alert" data-testid="reset-unusable">{phase.message}</div>
        <PrimaryCta href="/forgot-password" block>בקשת קישור חדש</PrimaryCta>
        <p className={s.footer}><Link href="/login" className={s.link}>חזרה לכניסה</Link></p>
      </AuthCard>
    );
  }

  if (phase.kind === "done") {
    return (
      <AuthCard title="הסיסמה עודכנה" lede="מעכשיו נכנסים עם הסיסמה החדשה.">
        <p className={s.success} role="status" data-testid="reset-done">
          מטעמי אבטחה ניתקנו את החשבון מכל המכשירים. בכל מכשיר נכנסים מחדש עם הסיסמה החדשה.
        </p>
        <PrimaryCta href="/login?reset=done" block>לכניסה</PrimaryCta>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="בחירת סיסמה חדשה" lede="אחרי השינוי ננתק את החשבון מכל המכשירים, ונכנסים מחדש עם הסיסמה החדשה.">
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <div className={s.field}>
          <label className={s.label} htmlFor="reset-password">סיסמה חדשה</label>
          <div className={s.inputShell}>
            <input
              id="reset-password"
              type={show ? "text" : "password"}
              className={`${s.input} ${s.inputWithToggle} ${fieldError.password ? s.inputBad : ""}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              aria-invalid={!!fieldError.password}
              aria-describedby="reset-password-msg"
              dir="ltr"
            />
            <button type="button" className={s.toggle} onClick={() => setShow((v) => !v)} aria-pressed={show} aria-controls="reset-password" aria-label={show ? "הסתרת הסיסמה" : "הצגת הסיסמה"}>
              {show ? "הסתר" : "הצג"}
            </button>
          </div>
          {fieldError.password ? (
            <p id="reset-password-msg" role="alert" className={s.fieldError}>{fieldError.password}</p>
          ) : (
            <p id="reset-password-msg" className={s.helper}>לפחות {MIN_PASSWORD_LENGTH} תווים.</p>
          )}
        </div>
        <div className={s.field}>
          <label className={s.label} htmlFor="reset-confirm">אימות הסיסמה</label>
          <input
            id="reset-confirm"
            type={show ? "text" : "password"}
            className={`${s.input} ${fieldError.confirm ? s.inputBad : ""}`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={!!fieldError.confirm}
            aria-describedby="reset-confirm-msg"
            dir="ltr"
          />
          {fieldError.confirm ? <p id="reset-confirm-msg" role="alert" className={s.fieldError}>{fieldError.confirm}</p> : null}
        </div>
        {formError ? <div role="alert" aria-live="assertive" className={s.alert}>{formError}</div> : null}
        <PrimaryCta type="submit" block disabled={loading}>
          {loading ? <><span className={s.spinner} aria-hidden="true" />מעדכנים…</> : "שמירת הסיסמה"}
        </PrimaryCta>
      </form>
    </AuthCard>
  );
}
