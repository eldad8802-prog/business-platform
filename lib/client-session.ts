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
export async function signOut(): Promise<void> {
  if (typeof window === "undefined") return;

  const token = getClientAuthToken();

  if (token) {
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
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
