/**
 * PERSISTENT LOGIN — the browser's side of the refresh, in one place.
 *
 * WHY THIS SHAPE
 *
 * 81 files read the access token straight out of `localStorage`, and there is no
 * shared fetch layer to hang a 401-retry on. Building one would mean touching
 * all 81 to solve a problem none of them have. So refresh is PROACTIVE instead:
 * the token is replaced before it expires, and every existing call site keeps
 * reading the same key and never learns that any of this happened.
 *
 * The refresh credential itself is never visible here. It is an HttpOnly cookie;
 * this module only asks the server to exchange it, and the server decides.
 *
 * SINGLE FLIGHT
 *
 * Boot, the timer and a return from background can all fire within the same
 * moment — a laptop opening its lid does all three. Overlapping refreshes are
 * not merely wasteful: each one rotates the credential, so a burst turns into a
 * chain of rotations where every response but the last is stale. One in-flight
 * promise is shared by every caller.
 */

const TOKEN_KEY = "token";

/** Refresh this long before the access token expires, so a slow network still lands. */
const SKEW_MS = 5 * 60 * 1000;

/** Never schedule further out than this, so a long-lived tab still checks in. */
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

/** Floor for the scheduled delay, so a nearly-expired token cannot spin the timer. */
const MIN_TIMER_MS = 30 * 1000;

export type RefreshResult = "refreshed" | "not_needed" | "unauthenticated" | "failed";

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // A browser with site data blocked. Nothing to refresh into.
    return null;
  }
}

function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage refused; the in-memory session continues until the tab closes */
  }
}

/**
 * Only for a DEFINITIVE refusal. A dead token left in storage is worse than no
 * token: every screen reads it, sends it, and fails with 401 forever, and the
 * user is shown a broken app instead of a sign-in.
 *
 * Never called for a network failure or a 500 — those say nothing about the
 * session, and turning them into a sign-out would make a flaky connection
 * indistinguishable from an ended one.
 */
function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * The access token's expiry, read WITHOUT verifying it. Verification is the
 * server's job and needs the secret; the client only needs to know when to ask
 * for a new one, and a forged `exp` costs an attacker nothing but their own
 * refresh schedule.
 */
export function readTokenExpiry(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Exchange the cookie for a fresh access token. Concurrent callers share one
 * request.
 *
 * `credentials: "same-origin"` is required: without it the browser sends no
 * cookie at all and the endpoint sees an unauthenticated request.
 */
export function refreshAccessToken(): Promise<RefreshResult> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
      });

      if (res.status === 401 || res.status === 403) return "unauthenticated";
      if (!res.ok) return "failed";

      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== "string" || body.token.length === 0) return "failed";

      writeToken(body.token);
      return "refreshed";
    } catch {
      // Offline, or the request was cancelled by a navigation. Not a signal
      // about the session — the existing token stays exactly as it was.
      return "failed";
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Milliseconds until this token should be replaced. Zero means "now". */
export function msUntilRefresh(now: number, expiryMs: number | null): number {
  if (expiryMs === null) return 0;
  const due = expiryMs - SKEW_MS - now;
  if (due <= 0) return 0;
  return Math.min(due, MAX_TIMER_MS);
}

/** True when the token is missing or already past its expiry. */
export function isTokenExpired(now: number, expiryMs: number | null): boolean {
  return expiryMs === null ? false : expiryMs <= now;
}

/**
 * What boot must do, decided SYNCHRONOUSLY.
 *
 * The decision has to be available before the first paint, because the gate
 * that holds the authenticated shell reads it in a layout effect. Making it
 * async would cost every healthy load a blank frame to answer a question whose
 * answer was already sitting in localStorage.
 */
export type BootstrapDecision = "no_session" | "ready" | "must_refresh";

export function bootstrapDecision(now: number = Date.now()): BootstrapDecision {
  const token = readToken();
  if (token === null) return "no_session";
  const expiry = readTokenExpiry(token);
  // A token whose payload we cannot read is not ours to judge. The server will
  // reject it if it is invalid; refreshing on its behalf would rotate the
  // credential for no reason.
  if (expiry === null) return "ready";
  return msUntilRefresh(now, expiry) === 0 ? "must_refresh" : "ready";
}

export type BootstrapOutcome = "no_session" | "ready" | "refreshed" | "unauthenticated" | "degraded";

/**
 * Boot. At most ONE refresh, and only when the access token is actually spent.
 *
 * A healthy token is left alone: refreshing it would rotate the credential on
 * every mount, which is a write, a network round trip and a new secret for a
 * session that had nothing wrong with it.
 */
export async function bootstrapRefresh(
  opts: { now?: () => number; refresh?: () => Promise<RefreshResult> } = {}
): Promise<BootstrapOutcome> {
  const now = opts.now ?? (() => Date.now());
  const refresh = opts.refresh ?? refreshAccessToken;

  const decision = bootstrapDecision(now());
  if (decision !== "must_refresh") return decision;

  const result = await refresh();
  if (result === "refreshed") return "refreshed";
  if (result === "unauthenticated") {
    clearToken();
    return "unauthenticated";
  }
  // Transient. The token stays exactly as it was; the caller carries on and the
  // timer will try again.
  return "degraded";
}

export type CoordinatorHandle = { stop: () => void };

/**
 * Start the coordinator. Returns a stop function; safe to call twice.
 *
 * Three triggers, one path:
 *   - boot, so a tab opened after the token expired recovers before it renders
 *     anything that depends on being signed in;
 *   - a timer, so an open tab never reaches expiry;
 *   - visibility and focus, because a suspended laptop runs no timers — a
 *     machine asleep past expiry wakes up with a dead token and must refresh
 *     before ordinary activity resumes.
 */
export function startRefreshCoordinator(
  opts: {
    now?: () => number;
    refresh?: () => Promise<RefreshResult>;
    onUnauthenticated?: () => void;
    /** Set when the bootstrap gate has already run boot and is awaiting it. */
    skipBoot?: boolean;
  } = {}
): CoordinatorHandle {
  const now = opts.now ?? (() => Date.now());
  const refresh = opts.refresh ?? refreshAccessToken;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (stopped) return;
    const expiry = readTokenExpiry(readToken());
    if (expiry === null) return; // signed out, or a token we cannot read
    const delay = Math.max(MIN_TIMER_MS, msUntilRefresh(now(), expiry));
    timer = setTimeout(() => void tick(), delay);
  };

  const tick = async () => {
    if (stopped) return;

    // Two reasons to do nothing, and both matter.
    //
    // No token means nobody is signed in on this device: asking the server
    // would only tell an anonymous visitor that they are anonymous.
    //
    // A token that is not yet due means there is nothing to fix. Refreshing it
    // anyway would ROTATE the credential on every mount — a write, a round trip
    // and a new secret for a session that had nothing wrong with it.
    const decision = bootstrapDecision(now());
    if (decision === "no_session") return;
    if (decision === "ready") {
      schedule();
      return;
    }

    const result = await refresh();
    if (result === "unauthenticated") {
      // The server has spoken: this credential is finished. Drop the dead token
      // so screens stop presenting it, and let the caller decide where the user
      // goes — this module does not navigate, so it stays testable and does not
      // fight the router.
      clearToken();
      opts.onUnauthenticated?.();
      return;
    }
    schedule();
  };

  const onVisible = () => {
    if (stopped) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const expiry = readTokenExpiry(readToken());
    // Only when the token is actually spent. A tab switched to and from every
    // few seconds must not become a refresh generator.
    if (isTokenExpired(now(), expiry) || msUntilRefresh(now(), expiry) === 0) {
      void tick();
    }
  };

  // The gate runs boot itself and holds the shell until it resolves; running it
  // again here would be a second decision on the same question.
  if (opts.skipBoot === true) schedule();
  else void tick();

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onVisible);
  }

  return {
    stop: () => {
      stopped = true;
      clear();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onVisible);
      }
    },
  };
}

/** Test seam. Not used by the app. */
export const __testing = {
  resetInFlight: () => {
    inFlight = null;
  },
  get inFlight() {
    return inFlight;
  },
};
