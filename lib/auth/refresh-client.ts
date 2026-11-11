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
 *
 * ONE ROTATION ACROSS TABS, TOO
 *
 * Single flight inside a tab is not enough. Two tabs (or the app and a browser
 * tab on the same origin) share one cookie jar but not one promise. If both
 * refresh at once, the server rotates for the first and grace-recovers for the
 * second — correct server-side — but the jar keeps whichever Set-Cookie the
 * browser processed LAST. When that is the older one, the device is left holding
 * a secret that dies with its grace, and the next refresh a day later is refused:
 * a sign-in screen for someone whose session was perfectly alive. So a refresh
 * runs under a cross-tab lock (Web Locks; a heartbeat lease in localStorage
 * where Web Locks is missing), and a tab that waited re-reads the token first:
 * if another tab already replaced it, there is nothing left to do.
 *
 * A LOST RESPONSE IS RECOVERED, NOT EXTENDED
 *
 * The request is sent with `keepalive` so a navigation does not cancel it, and
 * it is never aborted from here. Neither guarantees a response arrives. When the
 * server rotated but the response never landed, the jar still holds the
 * previous secret, which the server accepts for exactly GRACE (120 s) and never
 * longer. So a transient failure is retried on a schedule that ends well inside
 * that window; whatever the retries cannot reach is reported as a failure, and
 * the server — not this module — decides later whether the session is alive.
 * The window is not widened from here, and nothing here ever revokes.
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

/**
 * Waits between attempts after a TRANSIENT failure (network, 5xx, 429). The sum
 * — 77 s — stays inside the server's 120 s grace, so a rotation whose response
 * was lost is still recoverable by the last retry. Changing these is changing
 * that arithmetic.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000, 20_000, 45_000];

/** Must stay below the server's GRACE_MS (lib/auth/refresh-session.ts). */
export const SERVER_GRACE_MS = 120_000;

/** The Web Locks name, and the localStorage lease used where Web Locks is missing. */
export const REFRESH_LOCK_NAME = "dubiz-auth-refresh";
export const REFRESH_LEASE_KEY = "dubiz.auth.refreshLease";

/**
 * Lease timing for the fallback. The holder renews every HEARTBEAT, so a live
 * holder never loses the lease however long its retries run; a tab that died
 * holding it stops renewing and the lease lapses after TTL. SETTLE is how long a
 * writer waits before re-reading to confirm it won a simultaneous acquisition.
 * A waiter gives up after MAX_WAIT and reports a failure — it never proceeds
 * without the lock.
 */
const LEASE_TTL_MS = 15_000;
const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_SETTLE_MS = 120;
const LEASE_POLL_MS = 250;
const LEASE_MAX_WAIT_MS = 100_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The subset of the Web Locks API this module uses. */
export type LockManagerLike = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

/**
 * Everything the refresher touches outside itself. The default reads the real
 * globals AT CALL TIME, so a page (or a test) that replaces `fetch` or
 * `window` is honoured; tests build several of these over one shared store to
 * stand for several tabs.
 */
export type RefreshEnv = {
  storage: () => StorageLike | null;
  locks: () => LockManagerLike | null;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  ownerId: string;
  /**
   * Called once an auth response has been RECEIVED — success or refusal, since
   * either may have set or cleared the cookie. In the Android app it persists the
   * cookie jar (lib/native/auth-cookies.ts); elsewhere it is a no-op.
   */
  afterAuthResponse?: () => void;
};

function randomId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function browserRefreshEnv(): RefreshEnv {
  return {
    storage: () => {
      try {
        return typeof window !== "undefined" ? window.localStorage : null;
      } catch {
        return null;
      }
    },
    locks: () => {
      try {
        const n = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
        return n?.locks && typeof n.locks.request === "function" ? n.locks : null;
      } catch {
        return null;
      }
    },
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    ownerId: randomId(),
    // Loaded on demand so neither a browser nor a test pulls in the native bridge.
    afterAuthResponse: () => {
      void import("@/lib/native/auth-cookies").then((m) => m.flushAuthCookies()).catch(() => {});
    },
  };
}

type Lease = { owner: string; until: number };

function readLease(storage: StorageLike): Lease | null {
  try {
    const raw = storage.getItem(REFRESH_LEASE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Lease>;
    return typeof v.owner === "string" && typeof v.until === "number" ? { owner: v.owner, until: v.until } : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` while no other tab of this origin is refreshing.
 *
 * Web Locks is the real mechanism: the browser grants the lock to one context at
 * a time and releases it if that context dies. The lease is the fallback for a
 * browser without it, and it is best-effort by nature — localStorage offers no
 * compare-and-set across processes — so it is built to fail SAFE: a waiter that
 * cannot get the lease reports a failure instead of refreshing anyway, and the
 * worst outcome of a lost race is a second rotation the server handles inside
 * its grace, never a revocation.
 *
 * Returns `null` when the lease could not be obtained.
 */
export async function withRefreshLock<T>(env: RefreshEnv, fn: () => Promise<T>): Promise<T | null> {
  const locks = env.locks();
  if (locks) {
    return locks.request(REFRESH_LOCK_NAME, { mode: "exclusive" }, fn);
  }

  const storage = env.storage();
  // No storage at all: there is no other tab we could coordinate with that
  // shares our token either, so the in-tab single flight is all there is.
  if (!storage) return fn();

  const started = env.now();
  for (;;) {
    const lease = readLease(storage);
    if (lease === null || lease.until <= env.now() || lease.owner === env.ownerId) {
      try {
        storage.setItem(REFRESH_LEASE_KEY, JSON.stringify({ owner: env.ownerId, until: env.now() + LEASE_TTL_MS }));
      } catch {
        return fn();
      }
      // A tab that read "free" at the same moment may have written after us.
      // Whoever's write survives the settle owns it.
      await env.sleep(LEASE_SETTLE_MS);
      if (readLease(storage)?.owner === env.ownerId) break;
    } else {
      await env.sleep(LEASE_POLL_MS);
    }
    if (env.now() - started > LEASE_MAX_WAIT_MS) return null;
  }

  const heartbeat = env.setInterval(() => {
    try {
      if (readLease(storage)?.owner === env.ownerId) {
        storage.setItem(REFRESH_LEASE_KEY, JSON.stringify({ owner: env.ownerId, until: env.now() + LEASE_TTL_MS }));
      }
    } catch {
      /* the next beat tries again */
    }
  }, LEASE_HEARTBEAT_MS);

  try {
    return await fn();
  } finally {
    env.clearInterval(heartbeat);
    try {
      if (readLease(storage)?.owner === env.ownerId) storage.removeItem(REFRESH_LEASE_KEY);
    } catch {
      /* it lapses on its own */
    }
  }
}

function readTokenFrom(env: RefreshEnv): string | null {
  try {
    return env.storage()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** One request. `credentials: "same-origin"` is what makes the browser send the cookie at all. */
async function attemptRefresh(env: RefreshEnv): Promise<RefreshResult> {
  const sentWith = readTokenFrom(env);
  try {
    const res = await env.fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      // A navigation must not cancel a request that may already have rotated
      // the credential. Never aborted from here, for the same reason.
      keepalive: true,
      headers: { "content-type": "application/json" },
    });
    // The response's Set-Cookie (a rotated secret, or a clearing one) is in the
    // jar now; get it onto disk before anything can kill the app.
    env.afterAuthResponse?.();

    if (res.status === 401 || res.status === 403) return "unauthenticated";
    if (!res.ok) return "failed";

    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) return "failed";

    // A LATE answer must never undo what happened while it was on the way.
    // The token in storage is compared with the one there when the request
    // left: if the person signed out (it is gone) or signed in again (it is a
    // different one), this response belongs to a session the device has moved
    // on from, and writing it back would put that session — possibly one a
    // "clear this device anyway" sign-out left alive on the server — back on
    // the device. Nothing is written; the device keeps what it has now.
    const now = readTokenFrom(env);
    if (now !== sentWith) return now === null ? "unauthenticated" : "refreshed";

    try {
      env.storage()?.setItem(TOKEN_KEY, body.token);
    } catch {
      /* storage refused; the in-memory session continues until the tab closes */
    }
    return "refreshed";
  } catch {
    // Offline, or the response was lost. Not a signal about the session — the
    // existing token stays exactly as it was.
    return "failed";
  }
}

export type Refresher = {
  /**
   * Exchange the cookie for a fresh access token. Concurrent callers in this tab
   * share one attempt; other tabs wait on the lock.
   *
   * `startToken` is the token the caller saw when it decided to refresh. If a
   * different token is in storage by the time this tab holds the lock, another
   * tab (or a sign-in) already replaced it and no request is made.
   */
  refresh: (opts?: { startToken?: string | null }) => Promise<RefreshResult>;
  readonly inFlight: Promise<RefreshResult> | null;
  resetInFlight: () => void;
};

export function createRefresher(env: RefreshEnv): Refresher {
  let inFlight: Promise<RefreshResult> | null = null;

  const replacedSince = (startToken: string | null): boolean => {
    const current = readTokenFrom(env);
    return current !== null && current !== startToken;
  };

  const run = async (startToken: string | null): Promise<RefreshResult> => {
    const result = await withRefreshLock(env, async (): Promise<RefreshResult> => {
      for (let attempt = 0; ; attempt++) {
        if (replacedSince(startToken)) return "refreshed";
        const r = await attemptRefresh(env);
        // A verdict — success or a definitive refusal — is final. Only a
        // transient failure earns another attempt, and only inside the grace.
        if (r !== "failed" || attempt >= RETRY_DELAYS_MS.length) return r;
        await env.sleep(RETRY_DELAYS_MS[attempt]);
      }
    });
    return result ?? "failed";
  };

  return {
    refresh(opts = {}) {
      if (inFlight) return inFlight;
      const startToken = opts.startToken !== undefined ? opts.startToken : readTokenFrom(env);
      inFlight = run(startToken).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get inFlight() {
      return inFlight;
    },
    resetInFlight() {
      inFlight = null;
    },
  };
}

let defaultRefresher: Refresher | null = null;
function refresher(): Refresher {
  defaultRefresher ??= createRefresher(browserRefreshEnv());
  return defaultRefresher;
}

/**
 * Exchange the cookie for a fresh access token. Concurrent callers share one
 * request; other tabs of this origin are serialised behind the refresh lock.
 */
export function refreshAccessToken(): Promise<RefreshResult> {
  return refresher().refresh();
}

/**
 * For a request that came back 401: recover the session if it can be recovered.
 *
 * `rejectedToken` is the token that request carried. If storage already holds a
 * different one, the session was refreshed meanwhile and the caller should
 * simply retry with it — no request is made. Otherwise this is a refresh like
 * any other, sharing the in-flight one if there is one. The SERVER decides: a
 * revoked, expired or globally signed-out session answers `unauthenticated`.
 */
export function recoverSession(rejectedToken: string | null): Promise<RefreshResult> {
  const current = readToken();
  if (current !== null && current !== rejectedToken) return Promise.resolve("refreshed");
  return refresher().refresh({ startToken: rejectedToken });
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
    refresher().resetInFlight();
  },
  get inFlight() {
    return refresher().inFlight;
  },
  /** Replace parts of the default environment (e.g. an instant `sleep`). */
  useEnv: (overrides: Partial<RefreshEnv>) => {
    defaultRefresher = createRefresher({ ...browserRefreshEnv(), ...overrides });
  },
};
