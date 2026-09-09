/**
 * POST /api/auth/refresh — exchange a rotating refresh credential for a short
 * access token.
 *
 * POST only, and not for tidiness: a GET can be triggered by an `<img>` tag, and
 * this endpoint returns a credential.
 *
 * ONE FAILURE RESPONSE for every refusal. The reason is server-side only. A
 * caller that could tell "unknown secret" from "session revoked" from "no such
 * session" would learn whether a selector it guessed exists, and the selector is
 * the half of the credential that authenticates nothing precisely so that
 * knowing it is harmless.
 *
 * EVERY REFUSAL CLEARS THE COOKIE. The credential presented is either invalid,
 * expired, superseded or revoked; in none of those cases will it ever work
 * again, so leaving it in the jar only guarantees the next request fails too.
 *
 * The response body never contains the secret, the digest or the selector.
 */
import { NextResponse } from "next/server";
import { AuthTokenConfigError } from "@/lib/auth";
import {
  clearRefreshCookie,
  readRefreshCookie,
  serializeRefreshCookie,
  verifyRefreshCsrf,
} from "@/lib/auth/refresh-cookie";
import { refreshAccessToken } from "@/lib/auth/refresh-session.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Identical for every refusal, and never cached. */
function refused(): NextResponse {
  const res = NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  res.headers.set("set-cookie", clearRefreshCookie());
  res.headers.set("cache-control", "no-store");
  return res;
}

export async function POST(req: Request) {
  try {
    // CSRF first. The cookie is attached automatically by the browser, so this
    // check runs BEFORE the credential is read at all — a cross-site caller must
    // not be able to make this endpoint touch the database.
    const csrf = verifyRefreshCsrf(req);
    if (!csrf.ok) {
      console.warn(`REFRESH_CSRF_REFUSED: ${csrf.reason}`);
      return refused();
    }

    const outcome = await refreshAccessToken(readRefreshCookie(req));

    if (!outcome.ok) {
      // Server-side only. The client is told nothing beyond 401.
      console.warn(`REFRESH_REFUSED: ${outcome.reason}`);
      return refused();
    }

    const res = NextResponse.json({
      success: true,
      token: outcome.token,
      user: outcome.user,
    });
    res.headers.set(
      "set-cookie",
      serializeRefreshCookie(outcome.cookieValue, outcome.maxAgeSeconds)
    );
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AuthTokenConfigError) {
      console.error("REFRESH_ERROR:", error.message);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
    // Name only. A driver-level failure can carry the connection string in its
    // message, and this route runs on the auth plane.
    console.error(
      "REFRESH_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
