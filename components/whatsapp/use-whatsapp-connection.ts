"use client";

import { useEffect, useState } from "react";
import { connectionStateFromResponse } from "./connection-view";

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
  /** ISO string or null — when the server row last changed. */
  updatedAt: string | null;
};


export type WhatsAppConnectionState =
  | { phase: "loading" }
  | { phase: "connected"; connection: WhatsAppPublicConnection }
  | {
      phase: "disconnected";
      /** null = never connected; otherwise the last non-CONNECTED status. */
      previousStatus: string | null;
      displayPhoneNumber: string | null;
      /**
       * The server's row when one exists (status is anything but CONNECTED):
       * surfaces that must show the TRUE state (settings) read it; the inbox
       * keeps using previousStatus only.
       */
      connection: WhatsAppPublicConnection | null;
    }
  | {
      phase: "error";
      /** HTTP status of the failed status read; null for a network failure. */
      httpStatus: number | null;
    };

/** A status read that has not answered by then is an error, not an endless "טוען…". */
export const CONNECTION_READ_TIMEOUT_MS = 20_000;

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
      setState({ phase: "disconnected", previousStatus: null, displayPhoneNumber: null, connection: null });
      return;
    }

    setState({ phase: "loading" });

    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), CONNECTION_READ_TIMEOUT_MS);

    fetch("/api/integrations/whatsapp/connection", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${rawToken}` },
      signal: abort.signal,
    })
      .then(async (res) => {
        if (cancelled) return;
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (cancelled) return;
        setState(connectionStateFromResponse(res.status, data));
      })
      .catch(() => {
        if (!cancelled) setState(connectionStateFromResponse(null, null));
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [reloadKey]);

  return state;
}
