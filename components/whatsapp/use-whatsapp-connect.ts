"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEmbeddedSignup } from "./use-embedded-signup";

/**
 * Reusable "connect WhatsApp Business" orchestration.
 *
 * Wraps the official Meta Embedded Signup capture ({@link useEmbeddedSignup})
 * and the server-side exchange+persist call, exposing a single unified state
 * machine so any surface (inbox onboarding, reconnect banner, settings) can
 * drive the same connect flow without re-implementing it.
 *
 * There is NO fake Meta login here: the credential handshake happens only
 * inside Meta's own popup. The captured `code` leaves the browser once, over
 * HTTPS, to our own API — which exchanges it server-side (App Secret stays on
 * the server) and stores an encrypted token scoped to the authenticated
 * business. The `code`/token are never logged or persisted client-side.
 *
 * Unified status:
 *   idle       → nothing in flight (also the state after the user cancels the
 *                Meta popup, so they can simply try again)
 *   connecting → Meta popup open OR our backend is finishing the exchange
 *   connected  → backend persisted the connection (status = CONNECTED)
 *   error      → the Meta flow errored, or the backend exchange failed
 */
export type WhatsAppConnectStatus = "idle" | "connecting" | "connected" | "error";

export type WhatsAppConnectState = {
  status: WhatsAppConnectStatus;
  /**
   * Sub-phase of `connecting`, for surfaces that distinguish the two steps:
   *   "launching" → Meta's popup is open (button shows "פותחים חלון מאובטח…")
   *   "sending"   → popup closed, backend exchange in flight (show "מחברים…")
   * `null` when not connecting.
   */
  detail: "launching" | "sending" | null;
  /** Display phone number returned by the backend once connected. */
  connectedPhone: string | null;
  /** Launch the official Meta Embedded Signup popup. No-op while in flight. */
  start: () => void;
  /** Return to idle so the user can retry after a cancel/error. */
  reset: () => void;
};

type BackendStatus = "idle" | "sending" | "connected" | "error";

export function useWhatsAppConnect(
  onConnected?: (phone: string | null) => void
): WhatsAppConnectState {
  const { phase, result, launch, reset: resetSignup } = useEmbeddedSignup();
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("idle");
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const postedRef = useRef(false);

  // Keep the latest callback without re-running the post effect on every render.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // When Embedded Signup succeeds, hand the captured result to our backend.
  // This is the first (and only) time `code` leaves the browser; it goes to
  // our own API over HTTPS and is never logged.
  useEffect(() => {
    if (phase !== "success" || !result || postedRef.current) return;
    postedRef.current = true;
    setBackendStatus("sending");

    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    fetch("/api/integrations/whatsapp/embedded-signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        code: result.code,
        phoneNumberId: result.phoneNumberId,
        wabaId: result.wabaId,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          setBackendStatus("error");
          return;
        }
        const data = await res.json().catch(() => null);
        const phone = data?.connection?.displayPhoneNumber ?? null;
        setConnectedPhone(phone);
        setBackendStatus("connected");
        onConnectedRef.current?.(phone);
      })
      .catch(() => setBackendStatus("error"));
  }, [phase, result]);

  const start = useCallback(() => {
    if (phase === "launching" || backendStatus === "sending") return;
    void launch();
  }, [launch, phase, backendStatus]);

  const reset = useCallback(() => {
    postedRef.current = false;
    setBackendStatus("idle");
    setConnectedPhone(null);
    resetSignup();
  }, [resetSignup]);

  let status: WhatsAppConnectStatus;
  if (backendStatus === "connected") {
    status = "connected";
  } else if (backendStatus === "error") {
    status = "error";
  } else if (phase === "launching" || phase === "success" || backendStatus === "sending") {
    // "success" but backend not yet resolved counts as still connecting.
    status = "connecting";
  } else if (phase === "error") {
    status = "error";
  } else {
    // idle | cancelled — cancelling just returns the user to the start.
    status = "idle";
  }

  let detail: "launching" | "sending" | null = null;
  if (status === "connecting") {
    detail = backendStatus === "sending" || phase === "success" ? "sending" : "launching";
  }

  return { status, detail, connectedPhone, start, reset };
}
