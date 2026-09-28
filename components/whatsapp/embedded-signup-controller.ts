import type { EmbeddedSignupConfig } from "./embedded-signup-config";
import { isFacebookSdkInitialized, type FacebookSdk } from "./facebook-sdk";

/**
 * Framework-agnostic controller for the Meta Embedded Signup capture.
 *
 * The imperative flow (preload the SDK, open FB.login from within the user
 * gesture, listen for the WA_EMBEDDED_SIGNUP messages, bound every wait) lives
 * here as plain JS with injected dependencies so it can be unit-tested without
 * a browser or React. The React hook ({@link ./use-embedded-signup}) is a thin
 * wrapper that mirrors the emitted state into component state.
 *
 * Meta delivers the result in TWO independent halves, in no guaranteed order:
 *   - the `FB.login` callback carries the authorization `code`;
 *   - a `WA_EMBEDDED_SIGNUP` window message (`FINISH*`) carries
 *     `phone_number_id` / `waba_id`.
 * The backend needs all three, so the attempt succeeds only once BOTH halves
 * are in. Whichever half arrives first starts a short reconcile wait for the
 * other; if it never comes the attempt fails with a named reason instead of
 * posting an incomplete result (which the backend would refuse with 400).
 *
 * Bounded waits (none of them can be extended by Meta traffic):
 *   - `timeoutMs`   absolute deadline for the whole attempt, armed once at
 *                   launch. Meta sends no progress events while the owner fills
 *                   in the popup, so there is no inactivity timer — it would cut
 *                   off a real owner mid-OTP. The owner can always cancel.
 *   - `reconcileMs` wait for the missing half after the first one arrived.
 *
 * Popup refusal: the SDK opens Meta's window synchronously inside `FB.login`
 * via `window.open`, and when the browser refuses it (site pop-up setting,
 * an extension) the SDK fails SILENTLY — no window, no callback, no message,
 * no console error. `observePopup` watches that one call, so a refused
 * window ends the attempt at once as `popup_blocked` instead of waiting.
 *
 * Coexistence (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) reports only
 * `waba_id` — per Meta's docs there is no phone_number_id in that event — so
 * for that flow the WABA alone completes the result and the server resolves
 * the number from the WABA with the exchanged token.
 *
 * Every attempt carries an id. Callbacks/messages from an earlier attempt (a
 * late FB.login callback after a timeout, a duplicate FINISH) are ignored, so a
 * finished attempt can never be overwritten.
 */

export type EmbeddedSignupPhase =
  | "idle"
  | "launching"
  | "success"
  | "cancelled"
  | "error";

/**
 * Why an attempt ended in `error`. Safe to log and show: a fixed vocabulary,
 * never a Meta message, id, code or token.
 */
export type EmbeddedSignupErrorCode =
  | "config_missing" // NEXT_PUBLIC Meta app / config id not in this build
  | "sdk_unavailable" // the Facebook SDK has not loaded (yet, or failed)
  | "login_threw" // FB.login threw synchronously
  | "meta_error" // Meta reported ERROR
  | "timeout" // absolute deadline reached
  | "missing_code" // Meta finished but the login callback carried no code
  | "missing_ids" // a code arrived but Meta never reported the phone/WABA
  | "no_phone_number" // Meta finished without a phone number (e.g. FINISH_ONLY_WABA)
  | "popup_blocked"; // the browser refused to open Meta's window

export type EmbeddedSignupResult = {
  /** Sensitive — held in memory only, never logged or persisted. */
  code: string;
  /** Absent for coexistence onboarding — the server resolves it from the WABA. */
  phoneNumberId?: string;
  wabaId: string;
  businessId?: string;
  /** Which Meta flow finished. */
  flow: "cloud_api" | "coexistence";
};

/** Meta's coexistence finish event — carries waba_id only. */
export const COEXISTENCE_FINISH_EVENT = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

export type EmbeddedSignupState = {
  phase: EmbeddedSignupPhase;
  result: EmbeddedSignupResult | null;
  error: EmbeddedSignupErrorCode | null;
};

/** Minimal shape of a window "message" event the controller reads. */
export type MessageEventLike = { origin: string; data: unknown };

/**
 * Diagnostics sink (see {@link defaultBrowserDiag}). Every method is
 * side-effect-only: it MUST NOT change phase/timer/listener/flow, and MUST emit
 * only non-secret data (booleans, state names, error codes, durations).
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
  /** ABSOLUTE deadline (ms) for one attempt. Never re-armed by Meta events. */
  timeoutMs: number;
  /** Wait (ms) for the second half of the result once the first arrived. */
  reconcileMs?: number;
  /**
   * Runs `fn` (the FB.login call) and reports whether a window was opened
   * during it: true / false (refused) / null (no open attempt was observed).
   * Browser: a `window.open` wrapper installed only for that synchronous call.
   */
  observePopup?: (fn: () => void) => { opened: boolean | null };
  /** navigator.userActivation booleans, for diagnostics only. */
  getUserActivation?: () => { isActive: boolean; hasBeenActive: boolean } | null;
  /**
   * Optional diagnostics override (used by tests). When omitted, the controller
   * falls back to {@link defaultBrowserDiag}, which is active ONLY when the page
   * URL carries `?waDiag=1`; otherwise diagnostics are fully off (null). Logging
   * never changes flow and never emits secrets.
   */
  diag?: EmbeddedSignupDiag;
};

export const DEFAULT_RECONCILE_MS = 20_000;

export function isFacebookOrigin(origin: string): boolean {
  return (
    typeof origin === "string" &&
    (origin === "https://www.facebook.com" ||
      origin === "https://web.facebook.com" ||
      origin.endsWith(".facebook.com"))
  );
}

/** Meta's finish events: FINISH, FINISH_ONLY_WABA, FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING. */
export function isFinishEvent(evt: unknown): evt is string {
  return typeof evt === "string" && (evt === "FINISH" || evt.startsWith("FINISH_"));
}

/** Diagnostics gate — true only when the page URL carries `?waDiag=1`. */
export function isWaDiagEnabled(search: string | undefined | null): boolean {
  if (!search) return false;
  try {
    return new URLSearchParams(search).get("waDiag") === "1";
  } catch {
    return false;
  }
}

/**
 * Browser diagnostics sink — active ONLY when `?waDiag=1` is present. Emits
 * `[WA_ES_DIAG]` console lines carrying booleans, state names, error codes, the
 * (public) graph version and durations. It NEVER emits App ID / Config ID
 * values, access tokens, the auth code, phone number / WABA / business ids, or
 * auth headers. Returns null when disabled or off-browser, so normal users get
 * zero logging and zero behavior change.
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
  /** Abandon the current attempt and return to idle (also the owner's "cancel"). */
  reset: () => void;
  /** Tear down all listeners/timers/subscribers. */
  dispose: () => void;
  subscribe: (fn: (s: EmbeddedSignupState) => void) => () => void;
  getState: () => EmbeddedSignupState;
};

export function createEmbeddedSignupController(
  env: EmbeddedSignupEnv
): EmbeddedSignupController {
  const reconcileMs = env.reconcileMs ?? DEFAULT_RECONCILE_MS;

  let phase: EmbeddedSignupPhase = "idle";
  let result: EmbeddedSignupResult | null = null;
  let error: EmbeddedSignupErrorCode | null = null;

  // Per-attempt collection. `attempt` invalidates every closure of an earlier
  // attempt: a stale callback compares its captured id and does nothing.
  let attempt = 0;
  let code: string | null = null;
  let ids: { phoneNumberId?: string; wabaId?: string; businessId?: string } = {};
  let finished = false;
  let finishEvent: string | null = null;

  let listener: ((ev: MessageEventLike) => void) | null = null;
  let deadlineTimer: number | null = null;
  let reconcileTimer: number | null = null;
  let fb: FacebookSdk | null = null;
  let sdkState: "idle" | "loading" | "ready" | "error" = "idle";
  let disposed = false;
  const subscribers = new Set<(s: EmbeddedSignupState) => void>();

  const diag: EmbeddedSignupDiag | null = env.diag ?? defaultBrowserDiag(env);
  let launchStartedAt = 0;
  let callbackReceived = false;
  let messageReceived = false;

  function emit() {
    if (disposed) return;
    const snapshot: EmbeddedSignupState = { phase, result, error };
    subscribers.forEach((fn) => fn(snapshot));
  }

  function clearTimers() {
    if (deadlineTimer !== null) {
      env.clearTimer(deadlineTimer);
      deadlineTimer = null;
    }
    if (reconcileTimer !== null) {
      env.clearTimer(reconcileTimer);
      reconcileTimer = null;
    }
  }

  function removeListener() {
    if (listener) {
      env.removeMessageListener(listener);
      listener = null;
    }
  }

  /** The single exit from `launching`. Cleans up, then emits once. */
  function settle(
    next: Exclude<EmbeddedSignupPhase, "launching" | "idle">,
    reason: EmbeddedSignupErrorCode | null = null
  ) {
    clearTimers();
    removeListener();
    phase = next;
    error = next === "error" ? reason : null;
    if (diag) {
      diag.log("settled", {
        phase: next,
        error,
        elapsedMs: diag.now() - launchStartedAt,
        callbackReceived,
        messageReceived,
        finished,
        hasCode: code !== null,
        hasPhoneNumberId: !!ids.phoneNumberId,
        hasWabaId: !!ids.wabaId,
      });
    }
    emit();
  }

  function fail(reason: EmbeddedSignupErrorCode) {
    settle("error", reason);
  }

  function isCurrent(id: number) {
    return !disposed && id === attempt && phase === "launching";
  }

  /** Arms the reconcile wait once per attempt; never touches the deadline. */
  function armReconcile(id: number, onExpire: () => void) {
    if (reconcileTimer !== null) return;
    reconcileTimer = env.setTimer(() => {
      reconcileTimer = null;
      if (isCurrent(id)) onExpire();
    }, reconcileMs);
  }

  /** Succeeds when both halves are in; names the gap when one never can be. */
  function tryComplete(id: number) {
    if (!isCurrent(id) || code === null) return;
    const coexistence = finishEvent === COEXISTENCE_FINISH_EVENT;
    if (ids.wabaId && (ids.phoneNumberId || coexistence)) {
      result = {
        code,
        wabaId: ids.wabaId,
        flow: coexistence ? "coexistence" : "cloud_api",
        ...(ids.phoneNumberId ? { phoneNumberId: ids.phoneNumberId } : {}),
        ...(ids.businessId ? { businessId: ids.businessId } : {}),
      };
      settle("success");
      return;
    }
    if (finished) {
      // Meta already said it is done and did not name what we need.
      fail(ids.wabaId ? "no_phone_number" : "missing_ids");
      return;
    }
    armReconcile(id, () => fail("missing_ids"));
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

  function makeMessageHandler(id: number) {
    return function onMessage(ev: MessageEventLike) {
      if (!isFacebookOrigin(ev.origin)) return;
      let payload: unknown;
      let parseOk = true;
      try {
        payload = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        parseOk = false;
      }
      const obj =
        parseOk && payload && typeof payload === "object"
          ? (payload as { type?: unknown; event?: unknown; data?: unknown })
          : null;
      const isWa = obj?.type === "WA_EMBEDDED_SIGNUP";
      const evt = obj?.event;
      const eventType = isFinishEvent(evt)
        ? evt === "FINISH"
          ? "FINISH"
          : "FINISH_VARIANT"
        : evt === "CANCEL"
          ? "CANCEL"
          : evt === "ERROR"
            ? "ERROR"
            : "other";
      if (diag) {
        diag.log("message", {
          origin: ev.origin,
          parseOk,
          isWaEmbeddedSignup: isWa,
          eventType,
          current: isCurrent(id),
        });
      }
      if (!parseOk || !isWa || !isCurrent(id)) return;
      messageReceived = true;

      const data =
        obj?.data && typeof obj.data === "object"
          ? (obj.data as Record<string, unknown>)
          : {};
      if (data.phone_number_id) ids.phoneNumberId = String(data.phone_number_id);
      if (data.waba_id) ids.wabaId = String(data.waba_id);
      if (data.business_id) ids.businessId = String(data.business_id);

      if (evt === "CANCEL") {
        settle("cancelled");
      } else if (evt === "ERROR") {
        fail("meta_error");
      } else if (isFinishEvent(evt)) {
        if (finished) return; // duplicate FINISH — already recorded
        finished = true;
        finishEvent = evt;
        if (code !== null) {
          tryComplete(id);
        } else {
          // FINISH first: the login callback with the code should follow.
          armReconcile(id, () => fail("missing_code"));
        }
      }
      // Any other message is informational only: it does not extend any timer.
    };
  }

  function launch() {
    if (phase === "launching") return; // one attempt at a time
    const config = env.getConfig();
    if (!config) {
      attempt++;
      launchStartedAt = diag ? diag.now() : 0;
      fail("config_missing");
      return;
    }

    const readyFb = fb ?? env.getReadyFb();
    if (!readyFb) {
      // SDK not ready yet (still preloading, or the load failed). Never leave
      // the owner stuck in "launching": surface a retryable error and kick a
      // background (re)load so the next click can open the popup.
      attempt++;
      launchStartedAt = diag ? diag.now() : 0;
      fail("sdk_unavailable");
      preload();
      return;
    }

    clearTimers();
    removeListener();
    const id = ++attempt;
    result = null;
    error = null;
    code = null;
    ids = {};
    finished = false;
    finishEvent = null;
    callbackReceived = false;
    messageReceived = false;
    phase = "launching";
    emit();
    if (diag) launchStartedAt = diag.now();

    listener = makeMessageHandler(id);
    env.addMessageListener(listener);
    deadlineTimer = env.setTimer(() => {
      deadlineTimer = null;
      if (isCurrent(id)) fail("timeout");
    }, env.timeoutMs);

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

    const activation = env.getUserActivation?.() ?? null;
    const callLogin = () =>
      // Synchronous — called within the user gesture, with no await before it.
      readyFb.login(
        (response) => {
          if (diag) {
            diag.log("fb_login_callback", {
              hasResponse: !!response,
              hasAuthResponse: !!response?.authResponse,
              hasCode: !!response?.authResponse?.code,
              hasStatus:
                typeof response?.status === "string" &&
                response.status.length > 0,
              current: isCurrent(id),
            });
          }
          if (!isCurrent(id)) return; // late callback of a finished attempt
          if (callbackReceived) return; // duplicate callback
          callbackReceived = true;
          const received = response?.authResponse?.code;
          if (received) {
            code = received;
            tryComplete(id);
          } else if (finished) {
            // Meta finished the signup but handed us no code to exchange.
            fail("missing_code");
          } else {
            // Popup closed / cancelled without returning a code.
            settle("cancelled");
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

    let popupOpened: boolean | null = null;
    try {
      popupOpened = env.observePopup ? env.observePopup(callLogin).opened : (callLogin(), null);
    } catch (err) {
      diag?.log("fb_login_threw", {
        errorName: typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name : "unknown",
        activationIsActive: activation?.isActive ?? null,
      });
      if (isCurrent(id)) fail("login_threw");
      return;
    }
    diag?.log("fb_login_returned", {
      popupOpened,
      activationIsActive: activation?.isActive ?? null,
      activationHasBeenActive: activation?.hasBeenActive ?? null,
      current: isCurrent(id),
    });
    // The SDK gives no signal when the browser refuses its window: without this
    // the owner would wait on a spinner for a popup that will never exist.
    if (popupOpened === false && isCurrent(id)) fail("popup_blocked");
  }

  function reset() {
    attempt++; // invalidates every pending callback/message of the old attempt
    clearTimers();
    removeListener();
    code = null;
    ids = {};
    finished = false;
    finishEvent = null;
    result = null;
    error = null;
    phase = "idle";
    emit();
  }

  function dispose() {
    attempt++;
    clearTimers();
    removeListener();
    subscribers.clear();
    disposed = true;
  }

  function subscribe(fn: (s: EmbeddedSignupState) => void) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function getState(): EmbeddedSignupState {
    return { phase, result, error };
  }

  return { preload, launch, reset, dispose, subscribe, getState };
}
