/**
 * Logout.
 *
 * WHY THIS EXISTS: signing out was previously a client-side act only. The
 * browser deleted its copy of the token and navigated to /login, and the server
 * was never told. The token itself stayed valid until it expired, so anyone who
 * already held a copy — a shared machine, a synced browser profile, anything
 * that had read localStorage — kept full access to the business after the owner
 * believed they had left.
 *
 * Logging out now increments the user's token generation, which invalidates
 * every token issued before this moment. That is deliberately global rather than
 * per-device: there is no device identity in a stateless token to revoke
 * individually, and someone signing out of a machine they do not trust is better
 * served by ending every session than by ending the one they are looking at.
 *
 * This is NOT affected by the public-signup gate. Closing registration stops new
 * accounts being created; it has nothing to do with existing users ending their
 * own sessions.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { authDb } from "@/lib/prisma-auth";
import { revokeAllSessionsForUser, REVOKED_REASON } from "@/lib/auth/refresh-session";
import { clearRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    // No valid session to end. This is success, not an error: the caller wanted
    // to not be logged in, and they are not logged in. Returning 401 here would
    // make the client treat an already-expired session as a failed logout and
    // leave its local state behind.
    if (!user) {
      // Nothing to end server-side, but the browser may still be holding a
      // refresh credential for a session that is already gone. Clearing is what
      // makes "signed out" true on this device rather than merely believed.
      const alreadyOut = NextResponse.json({ success: true, alreadySignedOut: true });
      clearRefreshCookie(alreadyOut);
      return alreadyOut;
    }

    // See the same note in the login route: an implicit RETURNING reads back
    // columns the auth plane may not select, so the global sign-out would fail
    // with 42501 while the increment itself is permitted. Nothing consumes the
    // result.
    await authDb().user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true },
    });

    // Logout stays GLOBAL, and persistent login must not quietly reopen the door
    // it closes. Incrementing `tokenVersion` alone would leave every refresh
    // session on every device holding a credential that still finds its row —
    // the mismatch check would refuse it, but only by accident of ordering. The
    // sessions are revoked explicitly instead, so the state says what happened.
    //
    // Revoked, never deleted: retention is a separate lifecycle contract, and
    // this plane holds no DELETE privilege it does not need.
    // In its own try, and this is a security decision rather than caution.
    //
    // The increment above is the load-bearing half: it kills every access token
    // AND every refresh session at once, because a refresh whose
    // `tokenVersionAtIssue` no longer matches the user's generation is refused
    // before it can rotate anything. Marking the rows is what makes that state
    // explicit rather than implied.
    //
    // So if the marking fails, the user IS signed out and the response must say
    // so. Reporting 500 here would tell someone who has already been signed out
    // that they have not been — the worst possible lie for this endpoint to
    // tell, and one a battery caught by revoking against a lab where this plane
    // held no privilege on the table.
    try {
      const revoked = await revokeAllSessionsForUser(authDb(), {
        userId: user.id,
        now: new Date(),
        reason: REVOKED_REASON.LOGOUT,
      });
      if (revoked > 0) {
        console.log(JSON.stringify({ event: "refresh_sessions_revoked", userId: user.id, revoked }));
      }
    } catch (error) {
      console.error(
        "LOGOUT_SESSION_REVOKE_ERROR:",
        error instanceof Error ? error.name : "UnknownError"
      );
    }

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGOUT,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    const res = NextResponse.json({ success: true });
    clearRefreshCookie(res);
    return res;
  } catch (error) {
    console.error("LOGOUT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
