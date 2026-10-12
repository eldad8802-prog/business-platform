"use client";

import Link from "next/link";
import { useState } from "react";

import { AuthCard, authCardStyles as s } from "@/components/auth/auth-card";
import { PrimaryCta } from "@/components/ui/primary-cta";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Ask for a reset link. Whatever the address, the answer on screen is the same — the server never
 * says whether an account exists, and neither does this page.
 */
export default function ForgotForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!EMAIL.test(email.trim())) {
      setFieldError("יש להזין כתובת אימייל תקינה");
      return;
    }
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSentMessage(data?.message ?? "אם הכתובת רשומה אצלנו, שלחנו אליה קישור לבחירת סיסמה חדשה.");
      } else if (data?.field === "email") {
        setFieldError(data.error);
      } else {
        setFormError(data?.error ?? "משהו השתבש אצלנו. כדאי לנסות שוב בעוד רגע.");
      }
    } catch {
      setFormError("אין חיבור כרגע. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.");
    } finally {
      setLoading(false);
    }
  }

  if (sentMessage) {
    return (
      <AuthCard title="בדקו את תיבת המייל" lede={sentMessage}>
        <p className={s.info} role="status" data-testid="forgot-sent">
          לא הגיע תוך כמה דקות? כדאי לבדוק בתיקיית הספאם, או לבקש שוב. נשלח קישור אחד בכל פעם — הקישור האחרון הוא זה שעובד.
        </p>
        <p className={s.footer}>
          <Link href="/login" className={s.link}>חזרה לכניסה</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="שכחתי סיסמה" lede="נשלח קישור לבחירת סיסמה חדשה לכתובת האימייל של החשבון.">
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <div className={s.field}>
          <label className={s.label} htmlFor="forgot-email">אימייל</label>
          <input
            id="forgot-email"
            type="email"
            className={`${s.input} ${fieldError ? s.inputBad : ""}`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            spellCheck={false}
            autoFocus
            placeholder="name@example.com"
            aria-invalid={!!fieldError}
            aria-describedby="forgot-email-msg"
            dir="ltr"
          />
          {fieldError ? (
            <p id="forgot-email-msg" role="alert" className={s.fieldError}>{fieldError}</p>
          ) : (
            <p id="forgot-email-msg" className={s.helper}>הכתובת שאיתה נכנסים ל־Dubiz.</p>
          )}
        </div>
        {formError ? <div role="alert" aria-live="assertive" className={s.alert}>{formError}</div> : null}
        <PrimaryCta type="submit" block disabled={loading}>
          {loading ? <><span className={s.spinner} aria-hidden="true" />שולחים…</> : "שליחת קישור"}
        </PrimaryCta>
        <p className={s.footer}>
          נזכרת? <Link href="/login" className={s.link}>חזרה לכניסה</Link>
        </p>
      </form>
    </AuthCard>
  );
}
