import type { EmbeddedSignupConfig } from "./embedded-signup-config";
import type { FacebookSdk } from "./facebook-sdk";

/**
 * Framework-agnostic controller for the Meta Embedded Signup capture.
 *
 * The imperative flow (preload the SDK, open FB.login from within the user
 * gesture, listen for the WA_EMBEDDED_SIGNUP messages, recover from a stuck
 * "launching" via a timeout) lives here as plain JS with injected dependencies
 * so it can be unit-tested without a browser or React. The React hook
 * ({@link ../whatsapp/use-embedded-signup}) is a thin wrapper that mirrors the
 * emitted state into component state.
 *
 * Root cause this addresses: the previous hook called `FB.login` only AFTER
 * `await loadFacebookSdk()`. On the first click the SDK loads over the network,
 * so by the time `FB.login` ran the user gesture was gone and the popup could
 * be blocked, leaving `phase` stuck at "launching" forever. Here the SDK is
 * preloaded on mount and `launch()` is fully synchronous, so `FB.login` runs
 * inside the click; a timeout guarantees recovery if no callback/event arrives.
 */

export type EmbeddedSignupPhase =
  | "idle"
  | "launching"
  | "success"
  | "cancelled"
  | "error";

export type EmbeddedSignupResult = {
  /** Sensitive — held in memory only, never logged or persisted. */
  code: string;
  phoneNumberId?: string;
  wabaId?: string;
  businessId?: string;
};

export type EmbeddedSignupState = {
  phase: EmbeddedSignupPhase;
  result: EmbeddedSignupResult | null;
};

/** Minimal shape of a window "message" event the controller reads. */
export type MessageEventLike = { origin: string; data: unknown };

/**
 * Injected environment. In the browser these map to window/SDK primitives; in
 * tests they are fakes. Keeping them here is what makes the flow testable.
 */
export type EmbeddedSignupEnv = {
  getConfig: () => EmbeddedSignupConfig | null;
  loadSdk: (config: EmbeddedSignupConfig) => Promise<FacebookSdk>;
  /** Synchronous check for an already-initialized SDK (e.g. `window.FB`). */
  getReadyFb: () => FacebookSdk | null;
  addMessageListener: (fn: (ev: MessageEventLike) => void) => void;
  removeMessageListener: (fn: (ev: MessageEventLike) => void) => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** Recovery ceiling (ms) for a "launching" that never resolves. */
  timeoutMs: number;
};

export function isFacebookOrigin(origin: string): boolean {
  return (
    typeof origin === "string" &&
    (origin === "https://www.facebook.com" ||
      origin === "https://web.facebook.com" ||
      origin.endsWith(".facebook.com"))
  );
}

export type EmbeddedSignupController = {
  /** Start loading the SDK so a later click can open the popup synchronously. */
  preload: () => void;
  /** Open Meta's popup. MUST be called synchronously from the click handler. */
  launch: () => void;
  /** Return to idle (clears listener + timer) so the user can retry. */
  reset: () => void;
  /** Tear down all listeners/timers/subscribers. */
  dispose: () => void;
  subscribe: (fn: (s: EmbeddedSignupState) => void) => () => void;
  getState: () => EmbeddedSignupState;
};

export function createEmbeddedSignupController(
  env: EmbeddedSignupEnv
): EmbeddedSignupController {
  let phase: EmbeddedSignupPhase = "idle";
  let result: EmbeddedSignupResult | null = null;
  let ids: Pick<
    EmbeddedSignupResult,
    "phoneNumberId" | "wabaId" | "businessId"
  > = {};
  let listener: ((ev: MessageEventLike) => void) | null = null;
  let timerId: number | null = null;
  let fb: FacebookSdk | null = null;
  let sdkState: "idle" | "loading" | "ready" | "error" = "idle";
  const subscribers = new Set<(s: EmbeddedSignupState) => void>();

  function emit() {
    const snapshot: EmbeddedSignupState = { phase, result };
    subscribers.forEach((fn) => fn(snapshot));
  }

  function setPhase(
    next: EmbeddedSignupPhase | ((p: EmbeddedSignupPhase) => EmbeddedSignupPhase)
  ) {
    phase = typeof next === "function" ? next(phase) : next;
    emit();
  }

  function clearTimer() {
    if (timerId !== null) {
      env.clearTimer(timerId);
      timerId = null;
    }
  }

  function removeListener() {
    if (listener) {
      env.removeMessageListener(listener);
      listener = null;
    }
  }

  function armTimer() {
    clearTimer();
    timerId = env.setTimer(() => {
      timerId = null;
      removeListener();
      // Only a still-"launching" flow is stuck; a late callback that already
      // moved us to success/cancel/error must not be overwritten.
      setPhase((p) => (p === "launching" ? "error" : p));
    }, env.timeoutMs);
  }

  function preload() {
    if (sdkState === "loading" || sdkState === "ready") return;
    const config = env.getConfig();
    if (!config) {
      sdkState = "error";
      return;
    }
    sdkState = "loading";
    env.loadSdk(config).then(
      (loaded) => {
        fb = loaded;
        sdkState = "ready";
      },
      () => {
        sdkState = "error";
      }
    );
  }

  function onMessage(ev: MessageEventLike) {
    if (!isFacebookOrigin(ev.origin)) return;
    let payload: unknown;
    try {
      payload = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    } catch {
      return;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { type?: unknown }).type !== "WA_EMBEDDED_SIGNUP"
    ) {
      return;
    }

    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    if (data.phone_number_id) ids.phoneNumberId = String(data.phone_number_id);
    if (data.waba_id) ids.wabaId = String(data.waba_id);
    if (data.business_id) ids.businessId = String(data.business_id);

    const evt = (payload as { event?: unknown }).event;
    if (evt === "CANCEL") {
      clearTimer();
      removeListener();
      setPhase((p) => (p === "success" ? p : "cancelled"));
    } else if (evt === "ERROR") {
      clearTimer();
      removeListener();
      setPhase((p) => (p === "success" ? p : "error"));
    } else {
      // Progress activity from Meta's popup — reset the stuck-recovery timer so
      // a user who is actively completing the flow is never cut off early.
      armTimer();
    }
  }

  function launch() {
    const config = env.getConfig();
    if (!config) {
      setPhase("error");
      return;
    }

    const readyFb = fb ?? env.getReadyFb();
    if (!readyFb) {
      // SDK not ready yet (still preloading, or the load failed). Never leave
      // the user stuck in "launching": surface a clear, retryable error and
      // kick a background (re)load so the next click can open the popup.
      setPhase("error");
      preload();
      return;
    }

    result = null;
    ids = {};
    setPhase("launching");

    listener = onMessage;
    env.addMessageListener(listener);
    armTimer();

    try {
      // Synchronous — called within the user gesture, with no await before it.
      readyFb.login(
        (response) => {
          clearTimer();
          removeListener();
          const code = response?.authResponse?.code;
          if (code) {
            result = { code, ...ids };
            setPhase("success");
          } else {
            // Popup closed / cancelled without returning a code.
            setPhase((p) => (p === "success" ? p : "cancelled"));
          }
        },
        {
          config_id: config.configId,
          response_type: "code",
          override_default_response_type: true,
          // Coexistence path — onboard an existing WhatsApp Business App number.
          extras: {
            setup: {},
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: "3",
          },
        }
      );
    } catch {
      clearTimer();
      removeListener();
      setPhase("error");
    }
  }

  function reset() {
    clearTimer();
    removeListener();
    ids = {};
    result = null;
    setPhase("idle");
  }

  function dispose() {
    clearTimer();
    removeListener();
    subscribers.clear();
  }

  function subscribe(fn: (s: EmbeddedSignupState) => void) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function getState(): EmbeddedSignupState {
    return { phase, result };
  }

  return { preload, launch, reset, dispose, subscribe, getState };
}
