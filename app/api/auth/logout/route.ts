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
 * TWO SCOPES
 *
 *   `device` (the default, and what a request with no body means) ends exactly
 *   the session this access token belongs to. Every other device stays signed
 *   in. Logout used to be global, and that is what signed people out of their
 *   phone every time they switched accounts on a laptop: one tap on one device
 *   ended every session they had.
 *
 *   `all` — `{ "scope": "all" }` — is the old behaviour, kept as an explicit
 *   choice: it increments the user's token generation, which invalidates every
 *   token issued before this moment, and revokes every refresh session.
 *
 * A token that names no session predates sid binding. There is no pivot to end
 * just one device with, so it falls back to `all` — the safe direction — and
 * the response says so.
 *
 * WHY "DEVICE" IS IMMEDIATE: the access token carries its session id, and
 * `getAuthContext` refuses a token whose session is revoked on the very next
 * request. Ending the row ends the token; there is no 24-hour tail.
 *
 * HONESTY: the device path has no generation bump to fall back on — the session
 * write IS the logout. If it fails, the response is 500 and the refresh cookie
 * is left in place so the client can retry; it must never be told it signed out
 * when the server still honours the session.
 *
 * This is NOT affected by the public-signup gate. Closing registration stops new
 * accounts being created; it has nothing to do with existing users ending their
 * own sessions.
 */

import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { authDb } from "@/lib/prisma-auth";
import {
  revokeAllSessionsForUser,
  revokeSessionForLogout,
  REVOKED_REASON,
} from "@/lib/auth/refresh-session";
import { clearRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { safeErrorSummary } from "@/lib/security/log-safe-error";

export const dynamic = "force-dynamic";

export type LogoutScope = "device" | "all";

/**
 * The body is optional. Every client shipped before scopes existed sends none,
 * and for them the answer is `device` — which is the behaviour the policy now
 * asks for. Anything present but unreadable is refused rather than guessed at:
 * a typo must not silently become a narrower sign-out than the person chose.
 */
async function readScope(req: Request): Promise<LogoutScope | null> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (raw.trim() === "") return "device";
  try {
    const body = JSON.parse(raw) as { scope?: unknown } | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.scope === undefined || body.scope === "device") return "device";
    if (body.scope === "all") return "all";
    return null;
  } catch {
    return null;
  }
}

/** Telemetry carries a session SELECTOR prefix only — never a secret, token or address. */
function logLogout(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "logout", ...fields }));
}

export async function POST(req: Request) {
  try {
    const scope = await readScope(req);
    if (scope === null) {
      return NextResponse.json({ error: "Invalid logout scope" }, { status: 400 });
    }

    const ctx = await getAuthContext(req);

    // No valid session to end. This is success, not an error: the caller wanted
    // to not be logged in, and they are not logged in. Returning 401 here would
    // make the client treat an already-expired session as a failed logout and
    // leave its local state behind. (An EXPIRED token whose session is still
    // alive is ended through POST /api/auth/refresh/revoke, which proves the
    // session by its cookie instead.)
    if (!ctx) {
      // Nothing to end server-side, but the browser may still be holding a
      // refresh credential for a session that is already gone. Clearing is what
      // makes "signed out" true on this device rather than merely believed.
      const alreadyOut = NextResponse.json({ success: true, alreadySignedOut: true });
      clearRefreshCookie(alreadyOut);
      return alreadyOut;
    }

    const { user, sessionId } = ctx;
    const effective: LogoutScope = scope === "device" && sessionId !== null ? "device" : "all";

    if (effective === "device") {
      // Load-bearing, so NOT wrapped: a throw reaches the outer catch and the
      // client is told the truth.
      const result = await revokeSessionForLogout(authDb(), {
        userId: user.id,
        sessionId: sessionId as string,
        now: new Date(),
      });
      logLogout({ scope: "device", userId: user.id, sid: (sessionId as string).slice(0, 8), result });
    } else {
      // See the same note in the login route: an implicit RETURNING reads back
      // columns the auth plane may not select, so the global sign-out would fail
      // with 42501 while the increment itself is permitted. Nothing consumes the
      // result.
      await authDb().user.update({
        where: { id: user.id },
        data: { tokenVersion: { increment: 1 } },
        select: { id: true },
      });

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
      // that they have not been.
      //
      // Revoked, never deleted: retention is a separate lifecycle contract, and
      // this plane holds no DELETE privilege it does not need.
      try {
        const revoked = await revokeAllSessionsForUser(authDb(), {
          userId: user.id,
          now: new Date(),
          reason: REVOKED_REASON.LOGOUT,
        });
        logLogout({
          scope: "all",
          userId: user.id,
          revoked,
          ...(scope === "device" ? { fallback: "no_sid" } : {}),
        });
      } catch (error) {
        console.error(
          "LOGOUT_SESSION_REVOKE_ERROR:",
          error instanceof Error ? error.name : "UnknownError"
        );
      }
    }

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGOUT,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      metadata: { scope: effective },
    });

    const res = NextResponse.json({ success: true, scope: effective });
    clearRefreshCookie(res);
    return res;
  } catch (error) {
    console.error("LOGOUT_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
