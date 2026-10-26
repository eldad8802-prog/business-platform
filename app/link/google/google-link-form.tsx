"use client";

/**
 * The link screen: an existing account's owner proves ownership before Google is connected to it.
 * Two ways — the account's password, or a single-use link to the account's inbox — and a cancel that ends
 * the ticket on the server. Nothing the page sends names an account: the server resolves it from the ticket.
 *
 * Built from the signup form's stylesheet, so it inherits its layout at every width (desktop, tablet and
 * phone) and its RTL. Hebrew only (owner decision, 22.10.2026).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { establishSessionFromCookie } from "@/components/auth/google-sign-in";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";

import styles from "../../register/register.module.css";

type View = { email: string; name: string | null };
type Screen = "loading" | "ready" | "expired" | "linked";

const RETRY = "הפעולה לא הושלמה. אפשר לנסות שוב.";

export default function GoogleLinkForm() {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [screen, setScreen] = useState<Screen>("loading");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [busy, setBusy] = useState<"password" | "email" | "cancel" | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/google/link", { cache: "no-store", credentials: "same-origin" });
        if (!alive) return;
        if (!res.ok) {
          setScreen("expired");
          return;
        }
        setView((await res.json()) as View);
        setScreen("ready");
      } catch {
        if (alive) setScreen("expired");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const signedIn = async () => {
    if (!(await establishSessionFromCookie())) {
      router.replace("/login");
      return;
    }
    router.replace("/app");
  };

  const submitPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    setWarning(null);
    if (!password) {
      setPasswordError("יש להזין את הסיסמה של החשבון.");
      return;
    }
    setPasswordError(null);
    setBusy("password");
    try {
      const res = await fetch("/api/auth/google/link/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; warning?: string };
      if (res.ok) {
        await signedIn();
        return;
      }
      if (body.code === "TICKET_EXPIRED" || body.code === "LINK_REFUSED") {
        setScreen("expired");
        return;
      }
      if (body.code === "INVALID_PASSWORD") {
        setPasswordError(body.error ?? "הסיסמה שגויה.");
        setWarning(body.warning ?? null);
        return;
      }
      setFormError(body.error ?? RETRY);
    } catch {
      setFormError(RETRY);
    } finally {
      setBusy(null);
    }
  };

  const sendEmail = async () => {
    setFormError(null);
    setBusy("email");
    try {
      const res = await fetch("/api/auth/google/link/email", { method: "POST", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (res.ok) {
        setEmailSent(true);
        return;
      }
      if (body.code === "TICKET_EXPIRED") {
        setScreen("expired");
        return;
      }
      setFormError(body.error ?? RETRY);
    } catch {
      setFormError(RETRY);
    } finally {
      setBusy(null);
    }
  };

  // The server ends the ticket; only its answer decides where the person goes.
  const cancel = async () => {
    setFormError(null);
    setBusy("cancel");
    try {
      const res = await fetch("/api/auth/google/link", { method: "DELETE", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.ok) {
        router.replace("/login?google=cancelled");
        return;
      }
      if (body.code === "ALREADY_LINKED") {
        setScreen("linked");
        return;
      }
      setFormError("הביטול לא הושלם. אפשר לנסות לבטל שוב.");
    } catch {
      setFormError("הביטול לא הושלם. אפשר לנסות לבטל שוב.");
    } finally {
      setBusy(null);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className={styles.page}>
      <div className={styles.formSide} style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: 520, margin: "0 auto 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={styles.logoMark} aria-hidden="true">d</span>
            <span className={styles.logoWord} dir="ltr">dubiz</span>
          </div>
          <AccessibilityTrigger className={styles.a11yBtn} label="הגדרות נגישות" />
        </div>
        {children}
      </div>
    </div>
  );
  const linkButton = { display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" } as const;

  if (screen === "loading") return <div className={styles.page} aria-busy="true" />;

  if (screen === "linked") {
    return shell(
      <div className={styles.form} data-testid="google-link-linked">
        <div className={styles.head}>
          <h1 className={styles.title}>Google כבר חובר לחשבון</h1>
          <p className={styles.loginLine}>החיבור הושלם בדפדפן אחר. אפשר להתחבר לחשבון.</p>
        </div>
        <div className={styles.actions}>
          <Link href="/login" className={styles.submit} style={linkButton}>מעבר להתחברות</Link>
        </div>
      </div>
    );
  }

  if (screen === "expired" || !view) {
    return shell(
      <div className={styles.form} data-testid="google-link-expired">
        <div className={styles.head}>
          <h1 className={styles.title}>החיבור ל־Google לא זמין</h1>
          <p className={styles.loginLine}>תוקף הבקשה פג או שהיא כבר הסתיימה. אפשר להתחיל שוב עם Google, או להתחבר עם האימייל והסיסמה.</p>
        </div>
        <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <a className={styles.submit} href="/api/auth/google/start?from=login" style={linkButton}>להתחיל שוב עם Google</a>
          <Link href="/login" className={styles.link} style={{ textAlign: "center" }}>מעבר להתחברות</Link>
        </div>
      </div>
    );
  }

  return shell(
    <div className={styles.form} data-testid="google-link-screen">
      <div className={styles.head}>
        <h1 className={styles.title}>כבר יש לך חשבון בדוביז</h1>
        <p className={styles.loginLine}>
          Google אישרה את הכתובת שלך. החשבון בדוביז עם הכתובת הזו עדיין לא מחובר ל־Google. כדי לחבר אותו, צריך להראות שהחשבון שלך.
        </p>
      </div>

      <div className={styles.field} style={{ marginBottom: 20 }}>
        <span className={styles.label}>החשבון</span>
        <div
          className={`${styles.input} ${styles.ltr}`}
          dir="ltr"
          data-testid="google-link-email"
          aria-readonly="true"
          style={{ display: "flex", alignItems: "center", height: "auto", minHeight: 48, padding: "12px 14px", overflowWrap: "anywhere", background: "var(--dz-surface-muted)" }}
        >
          {view.email}
        </div>
      </div>

      <form onSubmit={submitPassword} noValidate data-testid="google-link-password-form" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="link-password">הסיסמה של החשבון בדוביז</label>
          <input
            id="link-password"
            type="password"
            autoComplete="current-password"
            className={`${styles.input} ${passwordError ? styles.invalid : ""}`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!passwordError}
            aria-describedby={passwordError ? "link-password-msg" : undefined}
          />
          {passwordError ? <p id="link-password-msg" role="alert" className={styles.error} data-testid="google-link-password-error">{passwordError}</p> : null}
          {warning ? <p role="status" className={styles.error} data-testid="google-link-password-warning">{warning}</p> : null}
        </div>
        <button type="submit" className={styles.submit} disabled={busy !== null} data-testid="google-link-password-submit">
          {busy === "password" ? "מחברים…" : "חיבור והתחברות"}
        </button>
      </form>

      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0", color: "var(--dz-text-secondary)", fontSize: 14 }} aria-hidden="true">
        <span style={{ flex: 1, height: 1, background: "var(--dz-border-subtle, #dfe3df)" }} />
        או
        <span style={{ flex: 1, height: 1, background: "var(--dz-border-subtle, #dfe3df)" }} />
      </div>

      {emailSent ? (
        <div role="status" data-testid="google-link-email-sent" style={{ borderRadius: 14, padding: "14px 16px", background: "var(--dz-surface-muted)", fontSize: 15, lineHeight: 1.6 }}>
          אם אפשר לחבר את החשבון, שלחנו קישור לכתובת של החשבון. יש לפתוח אותו בדפדפן הזה. הקישור תקף ל־30 דקות ולשימוש אחד.
          <div style={{ marginTop: 8 }}>
            <button type="button" className={styles.link} onClick={sendEmail} disabled={busy !== null} data-testid="google-link-email-again" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
              שליחה חוזרת
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.submit} onClick={sendEmail} disabled={busy !== null} data-testid="google-link-email-send"
          style={{ background: "transparent", color: "var(--dz-text-primary)", border: "1px solid var(--dz-border-subtle, #dfe3df)" }}>
          {busy === "email" ? "שולחים…" : "שלחו לי קישור לאימייל של החשבון"}
        </button>
      )}

      {formError ? <p role="alert" aria-live="assertive" className={styles.formError} data-testid="google-link-form-error">{formError}</p> : null}

      <div className={styles.actions} style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
        <button type="button" className={styles.link} onClick={cancel} disabled={busy !== null} data-testid="google-link-cancel" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          {busy === "cancel" ? "מבטלים…" : "ביטול וחזרה להתחברות"}
        </button>
      </div>
    </div>
  );
}
