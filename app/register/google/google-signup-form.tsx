"use client";

/**
 * The Google completion form. Prefilled from the ticket (the provider-verified address, shown read-only, and
 * the name Google gave, editable); asks for what signup always asks: the business name and the consent.
 * No password field: an account opened with Google has none until its owner sets one.
 *
 * Built from the signup form's own stylesheet, so it inherits its layout at every width (desktop two
 * columns, tablet and phone one) and its RTL. Hebrew only (owner decision, 22.10.2026).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { establishSessionFromCookie } from "@/components/auth/google-sign-in";
import { useI18n } from "@/components/i18n/I18nProvider";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import { SIGNUP_HONEYPOT_FIELD } from "@/lib/auth/signup-honeypot";

import styles from "../register.module.css";

type View = { email: string; name: string | null };
type Errors = { name?: string; businessName?: string; acceptTerms?: string; form?: string };

export default function GoogleSignupForm() {
  const router = useRouter();
  const { t } = useI18n();
  const honeypotRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "expired" | "completed">("loading");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/google/ticket", { cache: "no-store", credentials: "same-origin" });
        if (!alive) return;
        if (!res.ok) {
          setState("expired");
          return;
        }
        const body = (await res.json()) as View;
        setView(body);
        setName(body.name ?? "");
        setState("ready");
      } catch {
        if (alive) setState("expired");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The server ends the ticket; only its answer decides where the person goes. A failed cancel keeps them
  // here with the ticket still held, so they can try again — it is never shown as done.
  const cancel = async () => {
    setCancelling(true);
    setErrors((p) => ({ ...p, form: undefined }));
    try {
      const res = await fetch("/api/auth/google/ticket", { method: "DELETE", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.ok) {
        router.replace("/login?google=cancelled");
        return;
      }
      if (body.code === "ALREADY_COMPLETED") {
        setState("completed");
        return;
      }
      setErrors({ form: "הביטול לא הושלם. ההרשמה עדיין פתוחה, ואפשר לנסות לבטל שוב." });
    } catch {
      setErrors({ form: "הביטול לא הושלם. ההרשמה עדיין פתוחה, ואפשר לנסות לבטל שוב." });
    } finally {
      setCancelling(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const next: Errors = {};
    if (name.trim().length < 2) next.name = "יש להזין שם מלא";
    if (businessName.trim().length < 2) next.businessName = "יש להזין שם עסק";
    if (!acceptTerms) next.acceptTerms = "יש לאשר את תנאי השימוש ומדיניות הפרטיות";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch("/api/auth/google/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          businessName: businessName.trim(),
          acceptTerms,
          [SIGNUP_HONEYPOT_FIELD]: honeypotRef.current?.value ?? "",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; message?: string; field?: string };
      if (!res.ok) {
        if (body.code === "TICKET_REFUSED") {
          setState("expired");
          return;
        }
        if (body.field === "name" || body.field === "businessName" || body.field === "acceptTerms") {
          setErrors({ [body.field]: body.error });
          return;
        }
        setErrors({ form: body.message || body.error || "ההרשמה לא הושלמה. אפשר לנסות שוב." });
        return;
      }
      if (!(await establishSessionFromCookie())) {
        router.replace("/login");
        return;
      }
      router.replace("/setup");
    } catch {
      setErrors({ form: "ההרשמה לא הושלמה. אפשר לנסות שוב." });
    } finally {
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className={styles.page}>
      <div className={styles.formSide} style={{ gridColumn: "1 / -1" }}>
        {/* Its own header at every width: the signup's top bar is shown only beside its brand panel. */}
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

  if (state === "loading") return <div className={styles.page} aria-busy="true" />;

  // The signup was completed (in another tab or browser) before this cancel reached the server: the account
  // exists and the cancel changed nothing.
  if (state === "completed") {
    return shell(
      <div className={styles.form} data-testid="google-signup-completed">
        <div className={styles.head}>
          <h1 className={styles.title}>ההרשמה כבר הושלמה</h1>
          <p className={styles.loginLine}>החשבון בדוביז כבר נפתח עם הכתובת הזו, ולכן אין מה לבטל. אפשר להתחבר אליו.</p>
        </div>
        <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Link href="/login" className={styles.submit} style={{ textAlign: "center", textDecoration: "none" }} data-testid="google-signup-completed-login">
            מעבר להתחברות
          </Link>
        </div>
      </div>
    );
  }

  if (state === "expired" || !view) {
    return shell(
      <div className={styles.form} data-testid="google-signup-expired">
        <div className={styles.head}>
          <h1 className={styles.title}>ההרשמה עם Google לא זמינה</h1>
          <p className={styles.loginLine}>תוקף ההרשמה פג או שכבר הושלמה. אפשר להתחיל שוב עם Google, או להתחבר אם כבר נרשמת.</p>
        </div>
        <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <a className={styles.submit} href="/api/auth/google/start?from=register" style={{ textAlign: "center", textDecoration: "none" }}>
            להתחיל שוב עם Google
          </a>
          <Link href="/login" className={styles.link} style={{ textAlign: "center" }}>
            מעבר להתחברות
          </Link>
        </div>
      </div>
    );
  }

  const termsClass = [styles.terms, errors.acceptTerms ? styles.termsBad : acceptTerms ? styles.termsOn : ""].join(" ");

  return shell(
    <form className={styles.form} onSubmit={submit} noValidate data-testid="google-signup-form">
      <div
        aria-hidden="true"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", opacity: 0, pointerEvents: "none" }}
      >
        <label htmlFor="dz-confirm-field">אין למלא שדה זה</label>
        <input ref={honeypotRef} id="dz-confirm-field" name={SIGNUP_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div className={styles.head}>
        <h1 className={styles.title}>עוד רגע מסיימים</h1>
        <p className={styles.loginLine}>Google אישרה את הכתובת שלך. כדי לפתוח את החשבון בדוביז נשארו פרטי העסק ואישור התנאים.</p>
      </div>

      <div className={styles.field} style={{ marginBottom: 16 }}>
        <span className={styles.label}>אימייל (מאומת על ידי Google)</span>
        <div
          className={`${styles.input} ${styles.ltr}`}
          dir="ltr"
          data-testid="google-email"
          aria-readonly="true"
          style={{ display: "flex", alignItems: "center", height: "auto", minHeight: 48, padding: "12px 14px", overflowWrap: "anywhere", background: "var(--dz-surface-muted)" }}
        >
          {view.email}
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="g-name">שם מלא</label>
          <input
            id="g-name"
            className={`${styles.input} ${errors.name ? styles.invalid : ""}`}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "g-name-msg" : undefined}
          />
          {errors.name ? <p id="g-name-msg" role="alert" className={styles.error}>{errors.name}</p> : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="g-business">שם העסק</label>
          <input
            id="g-business"
            className={`${styles.input} ${errors.businessName ? styles.invalid : ""}`}
            autoComplete="organization"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            aria-invalid={!!errors.businessName}
            aria-describedby={errors.businessName ? "g-business-msg" : undefined}
          />
          {errors.businessName ? <p id="g-business-msg" role="alert" className={styles.error}>{errors.businessName}</p> : null}
        </div>
      </div>

      <label className={termsClass} htmlFor="g-terms">
        <input
          id="g-terms"
          type="checkbox"
          checked={acceptTerms}
          aria-invalid={!!errors.acceptTerms}
          aria-describedby={errors.acceptTerms ? "g-terms-msg" : undefined}
          onChange={(e) => {
            setAcceptTerms(e.target.checked);
            if (e.target.checked) setErrors((p) => ({ ...p, acceptTerms: undefined }));
          }}
        />
        <span className={styles.termsText}>
          {/* The very wording signup shows for the same consent (CURRENT_TERMS_VERSION). */}
          <span>
            {t("account.auth.register.terms.prefix")}{" "}
            <Link href="/terms" target="_blank" rel="noopener noreferrer">{t("account.auth.register.terms.termsLink")}</Link>{" "}
            {t("account.auth.register.terms.join")}{" "}
            <Link href="/privacy" target="_blank" rel="noopener noreferrer">{t("account.auth.register.terms.privacyLink")}</Link>
          </span>
          {errors.acceptTerms ? <span id="g-terms-msg" role="alert" className={styles.termsError}>{t("account.auth.register.terms.error")}</span> : null}
        </span>
      </label>

      {errors.form ? <p role="alert" aria-live="assertive" className={styles.formError} data-testid="google-signup-form-error">{errors.form}</p> : null}

      <div className={styles.actions} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <button type="submit" className={styles.submit} disabled={busy || cancelling} data-testid="google-signup-submit">
          {busy ? "פותחים את החשבון…" : "פתיחת החשבון"}
        </button>
        <button type="button" className={styles.link} onClick={cancel} disabled={busy || cancelling} data-testid="google-signup-cancel" style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          {cancelling ? "מבטלים…" : "ביטול וחזרה להתחברות"}
        </button>
      </div>
    </form>
  );
}
