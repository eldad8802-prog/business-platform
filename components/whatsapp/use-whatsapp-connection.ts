"use client";

import { useEffect, useState } from "react";

/**
 * Read-only client hook for the WhatsApp connection status.
 *
 * Ticket 1 (UI entry layer) only READS the existing public connection
 * endpoint — it never writes, and it never touches WhatsAppConnection logic,
 * Embedded Signup, or any Meta surface. Until a real connect path exists,
 * the endpoint returns `{ connection: null }`, so this resolves to
 * `disconnected` and the entry surfaces show.
 */
export type WhatsAppPublicConnection = {
  status: string;
  displayPhoneNumber: string;
  phoneNumberId: string;
};

export type WhatsAppConnectionState =
  | { phase: "loading" }
  | { phase: "connected"; connection: WhatsAppPublicConnection }
  | { phase: "disconnected" }
  | { phase: "error" };

export function useWhatsAppConnection(): WhatsAppConnectionState {
  const [state, setState] = useState<WhatsAppConnectionState>({
    phase: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    const rawToken =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    if (!rawToken) {
      // No auth in context — the host screen handles login. Treat as
      // "not connected" so the prompt can appear once authed.
      setState({ phase: "disconnected" });
      return;
    }

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
          setState({ phase: "connected", connection: conn });
        } else {
          setState({ phase: "disconnected" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
