"use client";

/**
 * The emailed link's page. On load it only CHECKS (no change); the link happens on the button, and only where
 * the Google ticket it is bound to lives. The token is read from the fragment and then removed from the
 * address bar, so it does not linger in history. Hebrew only (owner decision, 22.10.2026).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { establishSessionFromCookie } from "@/components/auth/google-sign-in";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";

import styles from "../../../register/register.module.css";

type Status = "VALID" | "OTHER_BROWSER" | "USED" | "EXPIRED" | "SUPERSEDED" | "TICKET_ENDED" | "INVALID";

const MESSAGES: Record<Exclude<Status, "VALID">, { title: string; line: string }> = {
  OTHER_BROWSER: {
    title: "יש לפתוח את הקישור בדפדפן שבו התחלת",
    line: "הקישור עובד רק בדפדפן שבו לחצת על \"המשך עם Google\". אפשר לחזור לדפדפן ההוא ולפתוח שם את הקישור, או להתחיל כאן מחדש עם Google ולבקש קישור חדש.",
  },
  USED: { title: "הקישור כבר שומש", line: "כל קישור עובד פעם אחת. אם החיבור לא הושלם, אפשר להתחיל שוב עם Google." },
  EXPIRED: { title: "תוקף הקישור פג", line: "הקישור תקף ל־30 דקות. אפשר להתחיל שוב עם Google ולבקש קישור חדש." },
  SUPERSEDED: { title: "נשלח קישור חדש יותר", line: "רק הקישור האחרון שנשלח עובד. יש לפתוח את הקישור מההודעה האחרונה." },
  TICKET_ENDED: { title: "הבקשה לחיבור Google הסתיימה", line: "הבקשה בוטלה, הושלמה או שתוקפה פג. אפשר להתחיל שוב עם Google." },
  INVALID: { title: "הקישור אינו תקין", line: "אפשר להתחיל שוב עם Google, או להתחבר עם האימייל והסיסמה." },
};

export default function GoogleLinkConfirm() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const hash = window.location.hash;
    const t = hash.startsWith("#t=") ? decodeURIComponent(hash.slice(3)) : null;
    // The secret stays in this page's memory only: out of the address bar and the history.
    if (hash) window.history.replaceState(null, "", window.location.pathname);
    (async () => {
      if (!t) {
        if (alive) setStatus("INVALID");
        return;
      }
      try {
        const res = await fetch("/api/auth/google/link/email/check", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: t }),
        });
        const body = (await res.json().catch(() => ({}))) as { status?: Status };
        if (!alive) return;
        setToken(t);
        setStatus(res.ok && body.status ? body.status : "INVALID");
      } catch {
        if (alive) setStatus("INVALID");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/google/link/email/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (res.ok) {
        if (!(await establishSessionFromCookie())) {
          router.replace("/login");
          return;
        }
        router.replace("/app");
        return;
      }
      if (body.code === "TICKET_EXPIRED" || body.code === "LINK_REFUSED") {
        setStatus("TICKET_ENDED");
        return;
      }
      if (body.code === "LINK_INVALID") {
        setStatus("USED");
        return;
      }
      setError(body.error ?? "החיבור לא הושלם. אפשר לנסות שוב.");
    } catch {
      setError("החיבור לא הושלם. אפשר לנסות שוב.");
    } finally {
      setBusy(false);
    }
  };

  const linkButton = { display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" } as const;
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

  if (status === "loading") return <div className={styles.page} aria-busy="true" />;

  if (status === "VALID") {
    return shell(
      <div className={styles.form} data-testid="google-link-confirm">
        <div className={styles.head}>
          <h1 className={styles.title}>חיבור Google לחשבון</h1>
          <p className={styles.loginLine}>לחיצה על הכפתור תחבר את Google לחשבון שלך בדוביז ותכניס אותך לחשבון. מעכשיו אפשר יהיה להתחבר גם עם Google.</p>
        </div>
        {error ? <p role="alert" className={styles.formError} data-testid="google-link-confirm-error">{error}</p> : null}
        <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button type="button" className={styles.submit} onClick={confirm} disabled={busy} data-testid="google-link-confirm-submit">
            {busy ? "מחברים…" : "אישור החיבור"}
          </button>
          <Link href="/login" className={styles.link} style={{ textAlign: "center" }}>לא עכשיו</Link>
        </div>
      </div>
    );
  }

  const m = MESSAGES[status];
  return shell(
    <div className={styles.form} data-testid="google-link-confirm-blocked" data-status={status}>
      <div className={styles.head}>
        <h1 className={styles.title}>{m.title}</h1>
        <p className={styles.loginLine}>{m.line}</p>
      </div>
      <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <a className={styles.submit} href="/api/auth/google/start?from=login" style={linkButton}>להתחיל עם Google</a>
        <Link href="/login" className={styles.link} style={{ textAlign: "center" }}>מעבר להתחברות</Link>
      </div>
    </div>
  );
}
