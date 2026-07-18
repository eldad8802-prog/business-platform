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
 * logic — launch, timeout recovery, listener/timer cleanup — lives in the
 * controller and is unit-tested there.
 *
 * On success it captures `code` + identifiers IN MEMORY only; nothing is sent
 * to our backend, persisted, logged, or written to URL/localStorage/
 * sessionStorage here (the backend exchange lives in `use-whatsapp-connect`).
 */

/**
 * Recovery ceiling for a "launching" popup that never returns a callback or
 * event. Chosen at 60s: long enough that a user actively completing Meta's
 * popup is not cut off (and any Embedded Signup progress message resets the
 * timer), short enough that a blocked/abandoned popup returns to a clear,
 * retryable error instead of an infinite spinner.
 */
const LAUNCH_TIMEOUT_MS = 60_000;

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
    timeoutMs: LAUNCH_TIMEOUT_MS,
  };
}

export function useEmbeddedSignup() {
  const [state, setState] = useState<EmbeddedSignupState>({
    phase: "idle",
    result: null,
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

  return { phase: state.phase, result: state.result, launch, reset };
}
