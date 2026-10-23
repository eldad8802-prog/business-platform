"use client";

/**
 * MFA step-up challenge for the Platform Admin console (CASA 3.3.1).
 *
 * Mounted once per privileged surface. It registers the handler that
 * `lib/platform-admin/fetch-platform-admin.ts` calls when the server answers a
 * privileged request with 403 + `ADMIN_MFA_REQUIRED`, shows a focused prompt,
 * exchanges a factor for a bounded elevation, and lets the original request
 * retry exactly once.
 *
 * Factors offered (A1): a passkey (Face ID / fingerprint / device PIN) when
 * this admin has one and passkeys are on here; the six-digit authenticator
 * code; a single-use recovery code. With no factor at all, the prompt sends the
 * admin to the security screen to set one up — never to "contact support".
 *
 * The code lives in React state for the moment it takes to submit it and is
 * cleared immediately afterwards. It is never logged, never persisted, and
 * never placed in a URL. The elevation it produces is held in memory only —
 * see lib/platform-admin/admin-elevation.ts for why.
 *
 * Concurrency: several panels load in parallel, so several requests can be
 * challenged at once. They all await ONE prompt; the elevation obtained
 * resolves every waiter.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerAdminStepUpHandler,
  setAdminElevation,
  verifyAdminMfaCode,
  verifyAdminWithPasskey,
} from "@/lib/platform-admin/admin-elevation";
import { fetchPlatformAdminSession } from "@/lib/platform-admin/fetch-platform-admin";
import { ConsoleIcon } from "./console/console-icons";
import styles from "./console/admin-console.module.css";

type Waiter = (elevation: string | null) => void;

type Factors = { enrolled: boolean; passkeys: boolean } | null;

export function AdminStepUpDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [factors, setFactors] = useState<Factors>(null);
  const waiters = useRef<Waiter[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const settle = useCallback((elevation: string | null) => {
    const pending = waiters.current;
    waiters.current = [];
    setOpen(false);
    setCode("");
    setError(null);
    setBusy(false);
    setFactors(null);
    for (const resolve of pending) resolve(elevation);
  }, []);

  useEffect(() => {
    return registerAdminStepUpHandler(
      () =>
        new Promise<string | null>((resolve) => {
          waiters.current.push(resolve);
          setOpen(true);
        })
    );
  }, []);

  // Which factors to offer — read from the identity-only session probe.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchPlatformAdminSession().then(
      (s) =>
        !cancelled &&
        setFactors({
          enrolled: s.mfa.enrolled,
          passkeys: s.mfa.passkeys.available && s.mfa.passkeys.count > 0,
        }),
      () => !cancelled && setFactors({ enrolled: true, passkeys: false })
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open && factors?.enrolled) inputRef.current?.focus();
  }, [open, factors]);

  // Resolve any outstanding waiter if this component unmounts mid-challenge,
  // so a privileged request can never hang forever on a promise nobody owns.
  useEffect(() => {
    return () => {
      const pending = waiters.current;
      waiters.current = [];
      for (const resolve of pending) resolve(null);
    };
  }, []);

  function bearer(): string | null {
    return typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
  }

  async function submit() {
    // Six digits for TOTP, or a longer recovery code. Anything shorter is a
    // typo, and sending it would burn one of the server's rate-limited attempts.
    const submitted = code.trim();
    if (submitted.length < 6) {
      setError("הזן את הקוד בן 6 הספרות מאפליקציית האימות, או קוד שחזור.");
      return;
    }

    const token = bearer();
    if (!token) {
      settle(null);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await verifyAdminMfaCode(submitted, token);
    // The submitted code has served its purpose — drop it before anything else.
    setCode("");

    if (result.ok) {
      setAdminElevation(result.elevation, result.expiresInSeconds);
      settle(result.elevation);
      return;
    }

    setBusy(false);
    if (result.status === 429) {
      setError("יותר מדי ניסיונות. המתן מעט ונסה שוב.");
      return;
    }
    if (result.reason === "not_enrolled" || result.reason === "no_record") {
      setError("לא הוגדרה אפליקציית אימות לחשבון הזה. אפשר להגדיר אותה במסך האבטחה.");
      return;
    }
    if (result.reason === "replayed_code") {
      setError("הקוד הזה כבר נוצל. המתן לקוד הבא ונסה שוב.");
      return;
    }
    setError("הקוד שגוי או פג תוקפו. נסה שוב עם קוד עדכני.");
  }

  async function stepUpWithPasskey() {
    const token = bearer();
    if (!token) {
      settle(null);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifyAdminWithPasskey(token);
    if (result.ok) {
      setAdminElevation(result.elevation, result.expiresInSeconds);
      settle(result.elevation);
      return;
    }
    setBusy(false);
    if (result.reason === "cancelled") {
      setError("האימות בוטל. אפשר לנסות שוב או להזין קוד.");
    } else if (result.status === 429) {
      setError("יותר מדי ניסיונות. המתן מעט ונסה שוב.");
    } else {
      setError("האימות עם מפתח הגישה נכשל. אפשר להזין קוד במקום.");
    }
  }

  if (!open) return null;

  const noFactor = factors !== null && !factors.enrolled && !factors.passkeys;

  return (
    <div className={styles.backdrop}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-step-up-title"
        aria-describedby="admin-step-up-desc"
        dir="rtl"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) settle(null);
        }}
      >
        <h2 id="admin-step-up-title">נדרש אימות נוסף</h2>
        <p id="admin-step-up-desc">
          {noFactor
            ? "אזור הניהול מוגן באימות דו-שלבי, ועדיין לא הוגדר אמצעי אימות לחשבון הזה."
            : "הנתונים כאן מוגנים. אמת שאתה זה אתה כדי להמשיך. הגישה תישאר פתוחה ל־15 דקות במכשיר הזה."}
        </p>

        {factors === null ? (
          <div className={styles.skeleton} style={{ height: 50 }} aria-hidden="true" />
        ) : noFactor ? (
          <div className={styles.actions}>
            <Link href="/admin/security" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => settle(null)}>
              להגדרת אימות דו-שלבי
            </Link>
            <button type="button" className={styles.btn} onClick={() => settle(null)}>
              ביטול
            </button>
          </div>
        ) : (
          <>
            {factors.passkeys ? (
              <>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`}
                  onClick={() => void stepUpWithPasskey()}
                  disabled={busy}
                >
                  <ConsoleIcon name="face" size={22} />
                  {busy ? "ממתין למכשיר…" : "אימות עם Face ID / מפתח גישה"}
                </button>
                {factors.enrolled ? <div className={styles.divider}>או קוד מאפליקציית האימות</div> : null}
              </>
            ) : null}

            {factors.enrolled ? (
              <label className={styles.field} htmlFor="admin-step-up-code">
                קוד אימות או קוד שחזור
                <input
                  id="admin-step-up-code"
                  ref={inputRef}
                  className={styles.codeInput}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy) void submit();
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  disabled={busy}
                  aria-invalid={error ? true : undefined}
                />
              </label>
            ) : null}

            {error ? (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            ) : null}

            <div className={styles.actions}>
              {factors.enrolled ? (
                <button
                  type="button"
                  className={`${styles.btn} ${factors.passkeys ? "" : styles.btnPrimary}`}
                  onClick={() => void submit()}
                  disabled={busy || code.trim().length === 0}
                >
                  {busy ? "מאמת…" : "אישור"}
                </button>
              ) : null}
              <button type="button" className={styles.btn} onClick={() => settle(null)} disabled={busy}>
                ביטול
              </button>
            </div>
            {factors.enrolled ? (
              <p className={styles.note}>אין גישה לאפליקציה? אפשר להזין כאן קוד שחזור חד-פעמי.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
