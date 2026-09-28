"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEmbeddedSignup, type EmbeddedSignupErrorCode, type EmbeddedSignupResult } from "./use-embedded-signup";
import { isWaDiagEnabled } from "./embedded-signup-controller";
import { submitEmbeddedSignup, type SubmitErrorCode } from "./embedded-signup-submit";

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
 *   idle       → nothing in flight (also the state after the owner cancels the
 *                Meta popup, so they can simply try again)
 *   connecting → Meta popup open OR our backend is finishing the exchange
 *   connected  → backend persisted the connection (status = CONNECTED)
 *   error      → the Meta flow errored, or the backend exchange failed;
 *                `errorCode` names which step
 *
 * Both waits are bounded: the popup by the controller's absolute deadline, the
 * backend by {@link submitEmbeddedSignup}'s timeout.
 */
export type WhatsAppConnectStatus = "idle" | "connecting" | "connected" | "error";

export type WhatsAppConnectErrorCode = EmbeddedSignupErrorCode | SubmitErrorCode;

export type WhatsAppConnectState = {
  status: WhatsAppConnectStatus;
  /**
   * Sub-phase of `connecting`, for surfaces that distinguish the two steps:
   *   "launching" → Meta's popup is open (button shows "פותחים חלון מאובטח…")
   *   "sending"   → popup closed, backend exchange in flight (show "מחברים…")
   * `null` when not connecting.
   */
  detail: "launching" | "sending" | null;
  /** Why the attempt failed; `null` unless `status === "error"`. */
  errorCode: WhatsAppConnectErrorCode | null;
  /** Display phone number returned by the backend once connected. */
  connectedPhone: string | null;
  /** Launch the official Meta Embedded Signup popup. No-op while in flight. */
  start: () => void;
  /** Return to idle so the owner can retry after a cancel/error. */
  reset: () => void;
  /** Abandon a popup that never came back (blocked / hidden / closed). */
  cancel: () => void;
};

type BackendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "connected" }
  | { kind: "error"; code: SubmitErrorCode };

function diagEnabled(): boolean {
  try {
    return typeof window !== "undefined" && isWaDiagEnabled(window.location.search);
  } catch {
    return false;
  }
}

/**
 * @param onConnected fires once the backend persisted the connection.
 * @param onUncertain fires when the backend call timed out or failed on the
 *   network: the server may still have finished, so the host should re-read the
 *   connection instead of trusting the error alone.
 */
export function useWhatsAppConnect(
  onConnected?: (phone: string | null) => void,
  onUncertain?: () => void
): WhatsAppConnectState {
  const { phase, result, error: signupError, launch, reset: resetSignup } = useEmbeddedSignup();
  const [backend, setBackend] = useState<BackendState>({ kind: "idle" });
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  // The result object already handed to the backend — each capture is posted
  // exactly once, and a new attempt produces a new object.
  const postedRef = useRef<EmbeddedSignupResult | null>(null);
  const mountedRef = useRef(true);

  // Keep the latest callbacks without re-running the post effect on every render.
  const onConnectedRef = useRef(onConnected);
  const onUncertainRef = useRef(onUncertain);
  useEffect(() => {
    onConnectedRef.current = onConnected;
    onUncertainRef.current = onUncertain;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // When Embedded Signup succeeds, hand the captured result to our backend.
  // This is the first (and only) time `code` leaves the browser; it goes to
  // our own API over HTTPS and is never logged.
  useEffect(() => {
    if (phase !== "success" || !result || postedRef.current === result) return;
    postedRef.current = result;
    setBackend({ kind: "sending" });

    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const startedAt = Date.now();

    void submitEmbeddedSignup(result, token, {
      fetch: (input, init) => fetch(input, init),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
    }).then((outcome) => {
      if (diagEnabled()) {
        // Safe fields only: never the code, the ids or the token.
        console.log("[WA_ES_DIAG] backend", {
          ok: outcome.ok,
          httpStatus: outcome.httpStatus,
          error: outcome.ok ? null : outcome.error,
          stage: outcome.ok ? null : outcome.stage,
          serverCode: outcome.ok ? null : outcome.serverCode,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (!mountedRef.current || postedRef.current !== result) return;
      if (!outcome.ok) {
        setBackend({ kind: "error", code: outcome.error });
        if (outcome.error === "timeout" || outcome.error === "network") {
          onUncertainRef.current?.();
        }
        return;
      }
      setConnectedPhone(outcome.displayPhoneNumber);
      setBackend({ kind: "connected" });
      onConnectedRef.current?.(outcome.displayPhoneNumber);
    });
  }, [phase, result]);

  const start = useCallback(() => {
    if (phase === "launching" || backend.kind === "sending") return;
    postedRef.current = null;
    setBackend({ kind: "idle" });
    launch();
  }, [launch, phase, backend.kind]);

  const reset = useCallback(() => {
    postedRef.current = null;
    setBackend({ kind: "idle" });
    setConnectedPhone(null);
    resetSignup();
  }, [resetSignup]);

  let status: WhatsAppConnectStatus;
  let errorCode: WhatsAppConnectErrorCode | null = null;
  if (backend.kind === "connected") {
    status = "connected";
  } else if (backend.kind === "error") {
    status = "error";
    errorCode = backend.code;
  } else if (backend.kind === "sending" || phase === "launching" || phase === "success") {
    // "success" but backend not yet resolved counts as still connecting.
    status = "connecting";
  } else if (phase === "error") {
    status = "error";
    errorCode = signupError;
  } else {
    // idle | cancelled — cancelling just returns the owner to the start.
    status = "idle";
  }

  let detail: "launching" | "sending" | null = null;
  if (status === "connecting") {
    detail = backend.kind === "sending" || phase === "success" ? "sending" : "launching";
  }

  return { status, detail, errorCode, connectedPhone, start, reset, cancel: reset };
}
