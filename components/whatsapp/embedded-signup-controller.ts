import type { EmbeddedSignupConfig } from "./embedded-signup-config";
import { isFacebookSdkInitialized, type FacebookSdk } from "./facebook-sdk";

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
 * Temporary diagnostics sink (see {@link defaultBrowserDiag}). Every method is
 * side-effect-only: it MUST NOT change phase/timer/listener/flow, and MUST emit
 * only non-secret data (booleans, the public graph version, a timestamp).
 */
export type EmbeddedSignupDiag = {
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Window/loader/config facts — booleans + graph version + timestamp only. */
  snapshot: () => Record<string, unknown>;
  isWindowFb: (candidate: unknown) => boolean;
  now: () => number;
};

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
  /**
   * Optional diagnostics override (used by tests). When omitted, the controller
   * falls back to {@link defaultBrowserDiag}, which is active ONLY when the page
   * URL carries `?waDiag=1`; otherwise diagnostics are fully off (null). Logging
   * never changes flow and never emits secrets.
   */
  diag?: EmbeddedSignupDiag;
};

export function isFacebookOrigin(origin: string): boolean {
  return (
    typeof origin === "string" &&
    (origin === "https://www.facebook.com" ||
      origin === "https://web.facebook.com" ||
      origin.endsWith(".facebook.com"))
  );
}

/**
 * Diagnostics gate — true only when the page URL carries `?waDiag=1`. Pure and
 * testable; when false, diagnostics are off. TEMPORARY (remove with the diag).
 */
export function isWaDiagEnabled(search: string | undefined | null): boolean {
  if (!search) return false;
  try {
    return new URLSearchParams(search).get("waDiag") === "1";
  } catch {
    return false;
  }
}

// TODO(wa-diag): Remove this temporary runtime instrumentation
// after the Embedded Signup investigation is complete.
// Everything gated behind the `[WA_ES_DIAG]` diagnostics — the
// `EmbeddedSignupDiag` type, `isWaDiagEnabled`, `defaultBrowserDiag`, the
// `diag`/`launchStartedAt`/`callbackReceived`/`messageReceived` state, all
// `diag.log(...)` calls, and `isFacebookSdkInitialized()` in facebook-sdk.ts —
// is temporary and must be removed together in a dedicated cleanup PR.
/**
 * TEMPORARY browser diagnostics sink — active ONLY when `?waDiag=1` is present.
 * Emits `[WA_ES_DIAG]` console lines carrying booleans + the (public) graph
 * version + a timestamp. It NEVER emits App ID / Config ID values, access
 * tokens, the auth code, phone number / WABA / business ids, or auth headers.
 * Returns null when disabled or off-browser, so normal users get zero logging
 * and zero behavior change.
 */
function defaultBrowserDiag(env: EmbeddedSignupEnv): EmbeddedSignupDiag | null {
  if (typeof window === "undefined") return null;
  let search: string | undefined;
  try {
    search = window.location.search;
  } catch {
    return null;
  }
  if (!isWaDiagEnabled(search)) return null;
  return {
    log: (event, data) => {
      try {
        console.log("[WA_ES_DIAG] " + event, data ?? {});
      } catch {
        /* diagnostics must never affect the flow */
      }
    },
    now: () => Date.now(),
    isWindowFb: (candidate) =>
      typeof window !== "undefined" && candidate === window.FB,
    snapshot: () => {
      const cfg = env.getConfig();
      return {
        windowFbExists: typeof window !== "undefined" && !!window.FB,
        sdkScriptExists:
          typeof document !== "undefined" &&
          !!document.getElementById("facebook-jssdk"),
        sdkInitialized: isFacebookSdkInitialized(),
        configIdPresent: !!cfg?.configId,
        appIdPresent: !!cfg?.appId,
        graphVersion: cfg?.graphVersion ?? null,
        timestamp: Date.now(),
      };
    },
  };
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

  // TEMPORARY diagnostics — null unless injected (tests) or `?waDiag=1` present.
  // Every use is guarded; when null there is zero logging and zero behavior
  // change. `launchStartedAt`/`callbackReceived`/`messageReceived` are read only
  // by the diagnostics.
  const diag: EmbeddedSignupDiag | null = env.diag ?? defaultBrowserDiag(env);
  let launchStartedAt = 0;
  let callbackReceived = false;
  let messageReceived = false;

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
      if (diag) {
        diag.log("timeout", {
          phase,
          elapsedMs: diag.now() - launchStartedAt,
          callbackReceived,
          messageReceived,
        });
      }
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
        diag?.log("preload_resolved");
      },
      () => {
        sdkState = "error";
        diag?.log("preload_rejected");
      }
    );
  }

  function onMessage(ev: MessageEventLike) {
    if (!isFacebookOrigin(ev.origin)) return;
    messageReceived = true;
    let payload: unknown;
    let parseOk = true;
    try {
      payload = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    } catch {
      parseOk = false;
    }
    const obj =
      parseOk && payload && typeof payload === "object"
        ? (payload as { type?: unknown; event?: unknown })
        : null;
    const isWa = obj?.type === "WA_EMBEDDED_SIGNUP";
    const evt = obj?.event;
    const eventType =
      evt === "FINISH"
        ? "FINISH"
        : evt === "CANCEL"
          ? "CANCEL"
          : evt === "ERROR"
            ? "ERROR"
            : "unknown";
    if (diag) {
      diag.log("message", {
        origin: ev.origin,
        parseOk,
        isWaEmbeddedSignup: isWa,
        eventType,
      });
    }

    if (!parseOk || !isWa) {
      return;
    }

    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    if (data.phone_number_id) ids.phoneNumberId = String(data.phone_number_id);
    if (data.waba_id) ids.wabaId = String(data.waba_id);
    if (data.business_id) ids.businessId = String(data.business_id);

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
    callbackReceived = false;
    messageReceived = false;
    setPhase("launching");
    if (diag) launchStartedAt = diag.now();

    listener = onMessage;
    env.addMessageListener(listener);
    armTimer();

    if (diag) {
      diag.log("fb_login_call", {
        phase,
        hasReadyFb: !!readyFb,
        hasLoginFn: typeof readyFb.login === "function",
        readyFbFromPreload: readyFb === fb,
        readyFbIsWindowFb: diag.isWindowFb(readyFb),
        ...diag.snapshot(),
      });
    }

    try {
      // Synchronous — called within the user gesture, with no await before it.
      readyFb.login(
        (response) => {
          callbackReceived = true;
          if (diag) {
            diag.log("fb_login_callback", {
              hasResponse: !!response,
              hasAuthResponse: !!response?.authResponse,
              hasCode: !!response?.authResponse?.code,
              hasStatus:
                typeof response?.status === "string" &&
                response.status.length > 0,
            });
          }
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
