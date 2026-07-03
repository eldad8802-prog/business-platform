"use client";

import { useEffect, useState } from "react";

/**
 * Read-only client hook for the WhatsApp connection status.
 *
 * READS the existing public connection endpoint only — it never writes, and
 * never touches WhatsAppConnection logic, Embedded Signup, or any Meta surface.
 *
 * The `disconnected` phase distinguishes two situations so callers can react
 * differently:
 *   - `previousStatus === null` → no connection row has ever existed for this
 *     business (never connected) — surfaces should show full onboarding.
 *   - `previousStatus !== null` → a row exists but is not `CONNECTED`
 *     (DISCONNECTED / REVOKED / REVOKED_BY_META / ERROR) — the business was
 *     connected before and the link broke, so a lighter reconnect prompt fits.
 *
 * Pass a `reloadKey` that changes (e.g. increment a counter) to re-fetch the
 * status after a connect/disconnect completes. Existing callers that don't
 * need to refresh can call it with no argument.
 */
export type WhatsAppPublicConnection = {
  status: string;
  displayPhoneNumber: string;
  phoneNumberId: string;
  /** From the same `PublicConnection` payload — surfaced for the settings card. */
  wabaId: string;
  /** ISO string or null. Rendered as "אומת לאחרונה" on the settings card. */
  lastVerifiedAt: string | null;
};

export type WhatsAppConnectionState =
  | { phase: "loading" }
  | { phase: "connected"; connection: WhatsAppPublicConnection }
  | {
      phase: "disconnected";
      /** null = never connected; otherwise the last non-CONNECTED status. */
      previousStatus: string | null;
      displayPhoneNumber: string | null;
    }
  | { phase: "error" };

export function useWhatsAppConnection(reloadKey = 0): WhatsAppConnectionState {
  const [state, setState] = useState<WhatsAppConnectionState>({
    phase: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    const rawToken =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    if (!rawToken) {
      // No auth in context — the host screen handles login. Treat as
      // "never connected" so the onboarding can appear once authed.
      setState({ phase: "disconnected", previousStatus: null, displayPhoneNumber: null });
      return;
    }

    setState({ phase: "loading" });

    fetch("/api/integrations/whatsapp/connection", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${rawToken}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        const data = await res.json().catch(() => null);
        const conn = data?.connection ?? null;
        if (cancelled) return;
        if (conn && conn.status === "CONNECTED") {
          setState({
            phase: "connected",
            connection: {
              status: conn.status,
              displayPhoneNumber:
                typeof conn.displayPhoneNumber === "string"
                  ? conn.displayPhoneNumber
                  : "",
              phoneNumberId:
                typeof conn.phoneNumberId === "string" ? conn.phoneNumberId : "",
              wabaId: typeof conn.wabaId === "string" ? conn.wabaId : "",
              lastVerifiedAt:
                typeof conn.lastVerifiedAt === "string"
                  ? conn.lastVerifiedAt
                  : null,
            },
          });
        } else if (conn) {
          setState({
            phase: "disconnected",
            previousStatus: typeof conn.status === "string" ? conn.status : null,
            displayPhoneNumber:
              typeof conn.displayPhoneNumber === "string"
                ? conn.displayPhoneNumber
                : null,
          });
        } else {
          setState({ phase: "disconnected", previousStatus: null, displayPhoneNumber: null });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return state;
}
