import { handleUnauthorized } from "@/lib/auth/session-guard";

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
 * Sign out deliberately: revoke server-side, then forget locally.
 *
 * The order matters. Revocation needs the token, so the local copy is cleared
 * only after the request has been made. The local state is cleared even when the
 * request fails — a person who pressed "sign out" on a shared machine must not
 * be left logged in because the network was down. That case is logged rather
 * than silently swallowed, because it leaves a token alive on the server that
 * the owner believes is dead.
 */
/** The native cookie-jar persistence (Android app only), loaded on demand. Never throws. */
async function persistCookieJar(): Promise<void> {
  try {
    const { flushAuthCookies } = await import("@/lib/native/auth-cookies");
    await flushAuthCookies();
  } catch {
    /* best effort */
  }
}

export async function signOut(): Promise<void> {
  if (typeof window === "undefined") return;

  const token = getClientAuthToken();

  if (token) {
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      // Android app: the response cleared the refresh cookie in the jar; put the
      // cleared jar on disk so a quick kill cannot bring the old cookie back.
      await persistCookieJar();
      if (!res.ok) {
        console.error("signOut: server did not revoke the session", res.status);
      }
    } catch (error) {
      console.error("signOut: could not reach the server to revoke", error);
    }
  }

  clearClientSession();
}

/**
 * A request came back 401 (or there was no token to send). Decide it the one
 * way every screen now decides it — lib/auth/session-guard.ts:
 *
 *   the session can be refreshed → stay (nothing is re-run from here, so a write
 *                                  is never repeated; the screen's next load uses
 *                                  the new token).
 *   the server ended the session → local state goes, the page is hidden and
 *                                  replaced by /login.
 *   network / timeout / 429 / 5xx → nothing is cleared; the screen shows its error.
 *
 * It used to clear the token and leave on the first 401, so a token that had
 * merely expired — with a perfectly good refresh session behind it — sent the
 * person to the sign-in screen. Deliberately does NOT call the logout endpoint:
 * a rejected token has no session left to revoke.
 */
export function redirectToLogin(): void {
  // Deliberately takes NO arguments: screens pass it straight to onClick, and an
  // optional parameter would receive the click event. A screen that wants its
  // READ retried after recovery calls handleUnauthorized({ retry }) directly.
  if (typeof window === "undefined") return;
  void handleUnauthorized({ rejectedToken: getClientAuthToken() });
}

/** Sign out and return to the login screen. The path a "log out" control takes. */
export async function signOutAndRedirect(): Promise<void> {
  if (typeof window === "undefined") return;

  await signOut();

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
