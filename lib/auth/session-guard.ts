/**
 * ONE DECISION for "the server refused this request's session".
 *
 * Before this module every screen decided for itself: some cleared the token
 * and jumped to /login on the first 401, some cleared it and stayed put, the
 * refresh coordinator cleared it without navigating, and a background poller
 * ignored it. The result was both kinds of wrong at once — sign-outs that a
 * refresh would have fixed, and revoked sessions that kept showing business
 * data on screen until the person happened to tap something.
 *
 * The rule, in one place:
 *
 *   401 on a request  → ask the server once (refresh, single-flight, cross-tab
 *                       locked — lib/auth/refresh-client.ts):
 *     refreshed       → the session is fine; the caller may RETRY a read once.
 *                       A write is never retried from here.
 *     unauthenticated → the session is over (revoked, expired, signed out
 *                       everywhere, password reset). Local state goes, the page
 *                       is hidden at once and replaced by /login — so nothing
 *                       already rendered stays visible.
 *     failed          → network, timeout, 5xx, 429: says nothing about the
 *                       session. Nothing is cleared; the caller shows its error.
 *   403               → never routed here. Forbidden is not signed out.
 *
 * LOOPS: a token is recovered at most once. If a request fails with 401 using a
 * token that this module itself just obtained, the 401 is not about the session
 * (the server accepted it a moment ago), so it is reported as transient — no
 * second refresh, no redirect, no loop.
 */

import { readToken, recoverSession } from "@/lib/auth/refresh-client";

const TOKEN_KEY = "token";

export type RejectionOutcome = "recovered" | "signed_out" | "transient";

/** Tokens this module obtained by recovery, so a 401 on them is never chased again. */
const recoveredTokens = new Set<string>();

/**
 * The marker an unfinished sign-out leaves ("clear this device anyway",
 * lib/client-session.ts — PENDING_REVOKE_KEY). Kept in step with it by
 * lib/auth/session-guard-coverage.test.ts.
 *
 * While it is present, the refresh cookie still in the jar is the PROOF that
 * finishes that sign-out — not a session to resume. Recovering with it would
 * bring back exactly the session the person asked this device to forget.
 */
export const PENDING_REVOKE_KEY = "dubiz.auth.pendingRevoke";

function signOutPending(): boolean {
  try {
    return window.localStorage.getItem(PENDING_REVOKE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The session is over: forget it here and leave for /login, hiding the page
 * first so business data already on screen is not left visible while the
 * navigation runs. The pending sign-out marker (lib/client-session.ts) is left
 * alone on purpose — it belongs to an earlier, unfinished sign-out.
 */
export function endSessionLocally(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem("user");
    window.localStorage.removeItem("sessionId");
  } catch {
    /* storage refused; the navigation below still leaves the page */
  }
  if (window.location.pathname === "/login") return; // already there: no redirect loop
  try {
    document.documentElement.style.visibility = "hidden";
  } catch {
    /* ignore */
  }
  try {
    window.location.replace(`${window.location.origin}/login`);
  } catch {
    /* ignore */
  }
}

/**
 * Handle a 401. `rejectedToken` is the token the refused request carried (null
 * if it carried none). `retry` re-runs a READ and is called at most once, only
 * after a successful recovery; pass nothing for a write.
 */
export async function handleUnauthorized(opts: {
  rejectedToken: string | null;
  retry?: () => void | Promise<void>;
}): Promise<RejectionOutcome> {
  if (typeof window === "undefined") return "transient";
  const { rejectedToken, retry } = opts;

  if (rejectedToken !== null && recoveredTokens.has(rejectedToken)) {
    // The server accepted this exact token a moment ago. This 401 is about the
    // request, not the session: report it, do not chase it.
    return "transient";
  }

  if (rejectedToken === null && signOutPending()) {
    // No token because the person cleared this device and the sign-out is still
    // pending. Never resume from the cookie that proves it: go to /login, where
    // the pending sign-out is finished. (With a token — a later sign-in — the
    // marker belongs to an older session and does not apply.)
    endSessionLocally();
    return "signed_out";
  }

  const result = await recoverSession(rejectedToken);

  if (result === "refreshed") {
    const fresh = readToken();
    if (fresh) recoveredTokens.add(fresh);
    if (retry) {
      await retry();
    } else if (rejectedToken === null) {
      // The page had no token at all, so it rendered nothing private; a reload
      // picks up the recovered session without discarding anyone's input.
      window.location.reload();
    }
    return "recovered";
  }

  if (result === "unauthenticated") {
    endSessionLocally();
    return "signed_out";
  }

  return "transient";
}

/** Test seam. Not used by the app. */
export const __testing = {
  reset: () => recoveredTokens.clear(),
};
