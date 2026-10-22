"use client";

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * A line at the top of the app for an owner whose account was opened with email verification and whose
 * address is not verified yet, with "send the link again". Shown only when verification is ON and the
 * owner's own status says required + not verified — an account that existed before verification never
 * sees it. Never blocks anything; it stays until the address is verified.
 */
type State = { kind: "hidden" } | { kind: "show"; note: string | null; sending: boolean };

export function EmailVerificationBanner() {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ kind: "hidden" });

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/email/status", { headers: buildClientAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.verificationEnabled === true && d?.required === true && d?.verified === false) {
          setState({ kind: "show", note: null, sending: false });
        }
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
      if (res.ok && (d?.alreadyVerified || d?.notRequired)) {
        setState({ kind: "hidden" });
        return;
      }
      setState({ kind: "show", sending: false, note: d?.message ?? d?.error ?? t("account.auth.banner.error") });
    } catch {
      setState({ kind: "show", sending: false, note: t("account.auth.banner.offline") });
    }
  }

  return (
    <div
      role="region"
      aria-label={t("account.auth.banner.regionLabel")}
      data-testid="verify-banner"
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
        {state.note ?? t("account.auth.banner.message")}
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
          {state.sending ? t("account.auth.common.sending") : t("account.auth.banner.resend")}
        </button>
      </span>
    </div>
  );
}
