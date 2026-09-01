"use client";

/**
 * MFA step-up challenge for the Platform Admin console (CASA 3.3.1).
 *
 * Mounted once per privileged surface. It registers the handler that
 * `lib/platform-admin/fetch-platform-admin.ts` calls when the server answers a
 * privileged request with 403 + `ADMIN_MFA_REQUIRED`, shows a focused prompt,
 * exchanges the six-digit code for a bounded elevation, and lets the original
 * request retry exactly once.
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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerAdminStepUpHandler,
  setAdminElevation,
  verifyAdminMfaCode,
} from "@/lib/platform-admin/admin-elevation";
import { PA } from "./platform-admin-styles";

type Waiter = (elevation: string | null) => void;

export function AdminStepUpDialog() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiters = useRef<Waiter[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const settle = useCallback((elevation: string | null) => {
    const pending = waiters.current;
    waiters.current = [];
    setOpen(false);
    setCode("");
    setError(null);
    setBusy(false);
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

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Resolve any outstanding waiter if this component unmounts mid-challenge,
  // so a privileged request can never hang forever on a promise nobody owns.
  useEffect(() => {
    return () => {
      const pending = waiters.current;
      waiters.current = [];
      for (const resolve of pending) resolve(null);
    };
  }, []);

  async function submit() {
    // Six digits for TOTP, or a longer recovery code. Anything shorter is a
    // typo, and sending it would burn one of the server's rate-limited attempts.
    const submitted = code.trim();
    if (submitted.length < 6) {
      setError("הזן את הקוד בן 6 הספרות מאפליקציית האימות, או קוד שחזור.");
      return;
    }

    const bearer =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!bearer) {
      settle(null);
      return;
    }

    setBusy(true);
    setError(null);
    const result = await verifyAdminMfaCode(submitted, bearer);
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
      // Never send the admin into re-enrollment from a failed verification.
      setError("לא נמצא אמצעי אימות פעיל לחשבון הזה. פנה למנהל המערכת.");
      return;
    }
    if (result.reason === "replayed_code") {
      setError("הקוד הזה כבר נוצל. המתן לקוד הבא ונסה שוב.");
      return;
    }
    setError("הקוד שגוי או פג תוקפו. נסה שוב עם קוד עדכני.");
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-step-up-title"
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(420px, 100%)",
          background: PA.cardBg,
          color: PA.ink,
          border: `1px solid ${PA.border}`,
          borderRadius: PA.radius,
          padding: 20,
          display: "grid",
          gap: 12,
        }}
      >
        <h2 id="admin-step-up-title" style={{ margin: 0, fontSize: 18 }}>
          נדרש אימות דו-שלבי
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: PA.inkSecondary }}>
          הפעולה הזו מוגנת. הזן את הקוד בן 6 הספרות שמוצג באפליקציית האימות שלך.
        </p>

        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void submit();
            if (e.key === "Escape" && !busy) settle(null);
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          disabled={busy}
          aria-label="קוד אימות"
          aria-invalid={error ? true : undefined}
          style={{
            fontSize: 20,
            letterSpacing: 4,
            textAlign: "center",
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${PA.border}`,
            background: PA.pageBg,
            color: PA.ink,
            direction: "ltr",
          }}
        />

        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: PA.urgent.ink }}>
            {error}
          </p>
        ) : null}

        <p style={{ margin: 0, fontSize: 12, color: PA.inkMuted }}>
          אין גישה לאפליקציה? אפשר להזין כאן קוד שחזור חד-פעמי.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || code.trim().length === 0}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${PA.info.border}`,
              background: PA.info.bg,
              color: PA.info.ink,
              cursor: busy ? "default" : "pointer",
              opacity: busy || code.trim().length === 0 ? 0.6 : 1,
            }}
          >
            {busy ? "מאמת…" : "אשר"}
          </button>
          <button
            type="button"
            onClick={() => settle(null)}
            disabled={busy}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${PA.border}`,
              background: "transparent",
              color: PA.ink,
              cursor: busy ? "default" : "pointer",
            }}
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
