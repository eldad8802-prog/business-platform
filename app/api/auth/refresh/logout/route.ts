/**
 * POST /api/auth/refresh/logout — sign out, proven by the refresh cookie (L-9).
 *
 * WHY UNDER /api/auth/refresh: the refresh cookie is scoped to that path, so it
 * is sent here and nowhere else. /api/auth/logout authenticates with the access
 * token; when that token has already expired it has no user to sign out, and
 * the refresh sessions it cannot see used to survive the "logout".
 *
 * The client calls this after /api/auth/logout on every sign-out. Possession of
 * the current refresh secret signs the user out globally (same semantics as
 * logout). An unknown secret changes nothing. The cookie is always cleared.
 *
 * Same browser CSRF checks as the refresh endpoint: a cross-site caller must not
 * be able to log anyone out.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { checkBrowserCsrf, clearRefreshCookie, readRefreshCookie } from "@/lib/auth/refresh-cookie";
import { logoutByRefreshCredential } from "@/lib/auth/session-directory";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

const NO_STORE = { "cache-control": "no-store" };

export async function handleCookieLogout(req: Request): Promise<NextResponse> {
  try {
    const csrf = checkBrowserCsrf(req);
    if (!csrf.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    }

    const rl = await consumeRateLimit({
      key: `auth:refresh-logout:${getClientIp(req)}`,
      limit: 30,
      windowMs: 60_000,
      failMode: "closed",
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: rl.backendUnavailable ? 503 : 429, headers: NO_STORE }
      );
    }

    const outcome = await logoutByRefreshCredential(readRefreshCookie(req));
    if (outcome.kind === "signed_out") {
      console.log(JSON.stringify({ event: "logout_by_refresh_cookie", userId: outcome.userId }));
    }
    const res = NextResponse.json({ success: true }, { headers: NO_STORE });
    clearRefreshCookie(res);
    return res;
  } catch (error) {
    console.error("REFRESH_LOGOUT_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleCookieLogout(req);
}
