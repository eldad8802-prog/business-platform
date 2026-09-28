"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFacebookSdk } from "./facebook-sdk";
import { getEmbeddedSignupConfig } from "./embedded-signup-config";
import {
  createEmbeddedSignupController,
  type EmbeddedSignupController,
  type EmbeddedSignupEnv,
  type EmbeddedSignupState,
} from "./embedded-signup-controller";

export type {
  EmbeddedSignupErrorCode,
  EmbeddedSignupPhase,
  EmbeddedSignupResult,
} from "./embedded-signup-controller";

/**
 * Embedded Signup orchestration (CAPTURE ONLY) — thin React wrapper over the
 * framework-agnostic {@link createEmbeddedSignupController}.
 *
 * On mount it preloads the Facebook SDK so the connect button can call
 * `FB.login` synchronously inside the click (never after an async wait, which
 * previously broke the user gesture and could block the popup). All the flow
 * logic — launch, bounded waits, listener/timer cleanup — lives in the
 * controller and is unit-tested there.
 *
 * On success it captures `code` + identifiers IN MEMORY only; nothing is sent
 * to our backend, persisted, logged, or written to URL/localStorage/
 * sessionStorage here (the backend exchange lives in `use-whatsapp-connect`).
 */

/**
 * ABSOLUTE ceiling for one Embedded Signup attempt. Meta sends no progress
 * events while the owner is inside its popup (login, business portfolio, WABA,
 * phone number, OTP), so this cannot be an inactivity timer: a real owner can
 * legitimately take several minutes. It is armed once at launch and nothing
 * Meta sends can extend it. A blocked or hidden popup does not have to wait
 * for it — the owner can cancel at any time from the launching state.
 */
export const LAUNCH_DEADLINE_MS = 10 * 60_000;

function browserEnv(): EmbeddedSignupEnv {
  return {
    getConfig: getEmbeddedSignupConfig,
    loadSdk: loadFacebookSdk,
    getReadyFb: () =>
      typeof window !== "undefined" ? window.FB ?? null : null,
    // A "message" MessageEvent structurally satisfies MessageEventLike; the
    // double-cast keeps the SAME function reference so add/remove still match.
    addMessageListener: (fn) =>
      window.addEventListener("message", fn as unknown as EventListener),
    removeMessageListener: (fn) =>
      window.removeEventListener("message", fn as unknown as EventListener),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    timeoutMs: LAUNCH_DEADLINE_MS,
  };
}

export function useEmbeddedSignup() {
  const [state, setState] = useState<EmbeddedSignupState>({
    phase: "idle",
    result: null,
    error: null,
  });
  const ctrlRef = useRef<EmbeddedSignupController | null>(null);

  useEffect(() => {
    const ctrl = createEmbeddedSignupController(browserEnv());
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    // Preload the SDK now so the first click opens Meta's popup synchronously.
    ctrl.preload();

    return () => {
      unsubscribe();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, []);

  const launch = useCallback(() => {
    ctrlRef.current?.launch();
  }, []);

  const reset = useCallback(() => {
    ctrlRef.current?.reset();
  }, []);

  return { phase: state.phase, result: state.result, error: state.error, launch, reset };
}
