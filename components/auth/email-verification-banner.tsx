"use client";

import { useEffect, useState } from "react";

import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * A quiet line at the top of the app for an owner whose address is not verified yet, with "send the
 * link again". Rendered only when verification is ON (the shell layout decides on the server), and
 * only after the owner's own status says "not verified". Never blocks anything; can be hidden for the
 * rest of the browser session.
 */
const HIDDEN_KEY = "dz:verify-banner-hidden";

type State = { kind: "hidden" } | { kind: "show"; note: string | null; sending: boolean };

export function EmailVerificationBanner() {
  const [state, setState] = useState<State>({ kind: "hidden" });

  useEffect(() => {
    let alive = true;
    try {
      if (window.sessionStorage.getItem(HIDDEN_KEY) === "1") return;
    } catch {
      /* storage unavailable: show it */
    }
    fetch("/api/auth/email/status", { headers: buildClientAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.verificationEnabled === true && d?.verified === false) setState({ kind: "show", note: null, sending: false });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "hidden") return null;

  async function resend() {
    setState({ kind: "show", note: null, sending: true });
    try {
      const res = await fetch("/api/auth/email/resend", { method: "POST", headers: buildClientAuthHeaders() });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d?.alreadyVerified) {
        setState({ kind: "hidden" });
        return;
      }
      setState({ kind: "show", sending: false, note: d?.message ?? d?.error ?? "משהו השתבש. כדאי לנסות שוב." });
    } catch {
      setState({ kind: "show", sending: false, note: "אין חיבור כרגע. כדאי לנסות שוב." });
    }
  }

  function hide() {
    try {
      window.sessionStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      /* fine: hidden for this view only */
    }
    setState({ kind: "hidden" });
  }

  return (
    <div
      role="region"
      aria-label="אימות כתובת האימייל"
      data-testid="verify-banner"
      dir="rtl"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px 12px",
        padding: "10px 16px",
        background: "var(--dz-warning-bg-soft)",
        borderBottom: "1px solid var(--dz-warning-border)",
        color: "var(--dz-text-primary)",
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <span style={{ flex: "1 1 220px", minWidth: 0 }}>
        {state.note ?? "כדי לאבטח את החשבון, כדאי לאמת את כתובת האימייל — שלחנו אליה קישור."}
      </span>
      <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={resend}
          disabled={state.sending}
          style={{
            minHeight: 36,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid var(--dz-warning-border)",
            background: "var(--dz-surface-flat)",
            color: "var(--dz-text-primary)",
            fontWeight: 700,
            fontSize: 13,
            cursor: state.sending ? "default" : "pointer",
          }}
        >
          {state.sending ? "שולחים…" : "שליחה חוזרת"}
        </button>
        <button
          type="button"
          onClick={hide}
          aria-label="הסתרת ההודעה"
          style={{ minHeight: 36, minWidth: 36, borderRadius: 10, border: 0, background: "transparent", color: "var(--dz-text-secondary)", fontSize: 18, cursor: "pointer" }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
