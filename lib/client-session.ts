export function getClientAuthToken(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

/**
 * Forget the session locally.
 *
 * This is what happens when a token turns out to be unusable — expired, revoked,
 * rejected. It is NOT how a person signs out: discarding our copy of a token
 * does nothing to the token itself. Use `signOut` for a deliberate logout.
 */
export function clearClientSession(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem("sessionId");
  } catch {
    /* ignore */
  }
}

/**
 * What a sign-out attempt actually achieved. The caller shows the person THIS,
 * never a success the server did not confirm.
 *
 *   signed_out          the server ended this device's session
 *   already_signed_out  there was no live session to end (nothing left to do)
 *   server_failed       the server answered but did not end it (5xx, 429, …)
 *   offline             the server could not be reached
 *
 * On the last two NOTHING local is cleared: the device stays signed in, and
 * the person decides between retrying and `forgetDeviceWithPendingRevoke`.
 */
export type SignOutOutcome = "signed_out" | "already_signed_out" | "server_failed" | "offline";

/**
 * A MARKER, never a credential: "this device was cleared locally while its
 * server-side session was still alive; finish the job when you can".
 *
 * The proof that finishing needs is the refresh cookie itself. It is HttpOnly,
 * SameSite=Strict and scoped to /api/auth/refresh, so no script can read it,
 * copy it or send it anywhere else — and clearing local state does not touch
 * it. The browser attaches it to POST /api/auth/refresh/revoke on its own, and
 * the server ends the session only if that cookie proves possession. Nothing
 * secret is ever written to localStorage.
 */
export const PENDING_REVOKE_KEY = "dubiz.auth.pendingRevoke";

export type CookieRevokeResult = "revoked" | "unproven" | "server_failed" | "offline";

/**
 * End this device's session by its refresh cookie. `revoked` covers "ended
 * now" and "already ended" (the server proved possession either way);
 * `unproven` means the server could not vouch for the cookie, changed nothing,
 * and cleared it — there is nothing more this device can do.
 */
export async function revokeByRefreshCookie(expectedSessionId: string | null = null): Promise<CookieRevokeResult> {
  try {
    const res = await fetch("/api/auth/refresh/revoke", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      ...(expectedSessionId ? { body: JSON.stringify({ expectedSessionId }) } : {}),
    });
    if (!res.ok) return "server_failed";
    const body = (await res.json().catch(() => ({}))) as { revoked?: unknown };
    return body.revoked === true ? "revoked" : "unproven";
  } catch {
    return "offline";
  }
}

/** The token payload, read WITHOUT verifying it — only to know when it expires and which session it names. */
function readPayload(token: string | null): { exp?: unknown; sid?: unknown } | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown; sid?: unknown };
  } catch {
    return null;
  }
}

function tokenIsExpired(token: string): boolean {
  const exp = readPayload(token)?.exp;
  return typeof exp === "number" && exp * 1000 <= Date.now();
}

/** The session SELECTOR the token names. Not a secret: it authenticates nothing on its own. */
function tokenSessionId(token: string | null): string | null {
  const sid = readPayload(token)?.sid;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

/**
 * Sign out deliberately: end THIS device's session on the server, and only
 * then forget it locally.
 *
 * It used to clear local state whatever the server said, so a 500 or a dead
 * network told the person "you are signed out" while the server still honoured
 * the session — the one lie this control must never tell. Now local state is
 * cleared only when the server confirms there is nothing left to end.
 *
 * An EXPIRED access token cannot name its session to /api/auth/logout, so that
 * case goes straight to the cookie route, which can.
 */
export async function signOut(): Promise<SignOutOutcome> {
  if (typeof window === "undefined") return "offline";

  const token = getClientAuthToken();

  if (!token || tokenIsExpired(token)) {
    const r = await revokeByRefreshCookie(tokenSessionId(token));
    if (r === "revoked" || r === "unproven") {
      clearClientSession();
      return r === "revoked" ? "signed_out" : "already_signed_out";
    }
    return r;
  }

  let res: Response;
  try {
    res = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error("signOut: could not reach the server to revoke", error);
    return "offline";
  }

  if (!res.ok) {
    console.error("signOut: server did not revoke the session", res.status);
    return "server_failed";
  }

  const body = (await res.json().catch(() => ({}))) as { alreadySignedOut?: unknown };
  clearClientSession();
  return body.alreadySignedOut === true ? "already_signed_out" : "signed_out";
}

/**
 * The person's explicit choice after a failed sign-out: "clear this device
 * anyway". Local state goes now; the server-side session is ended later by
 * `completePendingRevoke`, which the login screen runs on every load (and when
 * the device comes back online) until the server confirms.
 *
 * The caller must say plainly that the server has NOT confirmed yet.
 */
export function forgetDeviceWithPendingRevoke(now: number = Date.now()): void {
  if (typeof window === "undefined") return;
  try {
    // The session id pins WHICH session to end, so a later sign-in on this
    // device — which replaces the cookie — can never be ended by mistake.
    localStorage.setItem(PENDING_REVOKE_KEY, JSON.stringify({ since: now, sid: tokenSessionId(getClientAuthToken()) }));
  } catch {
    /* without the marker the cookie still proves the session; a later sign-in replaces it */
  }
  clearClientSession();
}

export function hasPendingRevoke(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(PENDING_REVOKE_KEY) !== null;
  } catch {
    return false;
  }
}

export type PendingRevokeResult = "none" | "revoked" | "unproven" | "still_pending";

/**
 * Finish a sign-out that was cleared locally first. Removes the marker only
 * when the server has given a verdict; a failure or no network leaves it for
 * the next attempt.
 */
function readPendingRevoke(): { since?: unknown; sid?: unknown } | null {
  try {
    const raw = localStorage.getItem(PENDING_REVOKE_KEY);
    return raw ? (JSON.parse(raw) as { since?: unknown; sid?: unknown }) : null;
  } catch {
    return null;
  }
}

/** A sign-in on this device replaces the cookie the marker was about. Drop it. */
export function clearPendingRevoke(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PENDING_REVOKE_KEY);
  } catch {
    /* ignore */
  }
}

export async function completePendingRevoke(): Promise<PendingRevokeResult> {
  if (!hasPendingRevoke()) return "none";
  const marker = readPendingRevoke();
  const sid = marker && typeof marker.sid === "string" ? marker.sid : null;
  // Without a session id there is no way to be sure the cookie still belongs to
  // the session being ended, so nothing is sent.
  if (sid === null) {
    clearPendingRevoke();
    return "unproven";
  }
  const r = await revokeByRefreshCookie(sid);
  if (r === "revoked" || r === "unproven") {
    try {
      localStorage.removeItem(PENDING_REVOKE_KEY);
    } catch {
      /* ignore */
    }
    return r;
  }
  return "still_pending";
}

/**
 * Send an unauthenticated visitor to the login screen.
 *
 * Deliberately does NOT call the logout endpoint: this path runs when a token
 * has already been rejected, and there is no session left to revoke.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;

  clearClientSession();

  try {
    window.location.replace(`${window.location.origin}/login`);
  } catch {
    /* ignore */
  }
}

/**
 * Sign out and, ONLY if the server confirmed, go to the login screen. Any other
 * outcome is returned to the control, which keeps the person signed in and
 * offers a retry or an explicit local clear.
 */
export async function signOutAndRedirect(): Promise<SignOutOutcome> {
  if (typeof window === "undefined") return "offline";

  const outcome = await signOut();
  if (outcome === "signed_out" || outcome === "already_signed_out") {
    try {
      window.location.replace(`${window.location.origin}/login`);
    } catch {
      /* ignore */
    }
  }
  return outcome;
}

/** After `forgetDeviceWithPendingRevoke`: leave for the login screen, which finishes the job. */
export function goToLoginAfterLocalClear(): void {
  if (typeof window === "undefined") return;
  try {
    window.location.replace(`${window.location.origin}/login`);
  } catch {
    /* ignore */
  }
}

export function buildClientAuthHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  const token = getClientAuthToken();

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === "UNAUTHORIZED";
}
