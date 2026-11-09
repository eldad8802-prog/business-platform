/**
 * END THIS DEVICE'S SESSION BY ITS REFRESH COOKIE.
 *
 * POST /api/auth/refresh/revoke
 *
 * The logout route needs a live access token to know which session to end.
 * Two real situations do not have one:
 *
 *   - the access token has already expired (a device opened after a day away,
 *     where the person taps "sign out" before anything refreshed), and
 *   - a sign-out attempted offline, completed when the device is back online.
 *
 * The refresh cookie is still on the device, and it is the one credential that
 * names this device's session and proves possession of it. It is scoped to
 * `/api/auth/refresh`, which is exactly why this lives underneath that path:
 * the browser attaches the cookie here and nowhere else.
 *
 * THE ANSWER IS THE TRUTH, AND NOTHING MORE
 *
 *   `{ revoked: true }`   possession was proven and the session is ended (now,
 *                         or it already was).
 *   `{ revoked: false }`  nothing could be proven — no cookie, a malformed one,
 *                         or a secret past its grace. Nothing was changed, and
 *                         the client must not tell the person the server-side
 *                         session ended.
 *
 * The body never says WHY a credential was not accepted: an endpoint that tells
 * "unknown" apart from "expired" apart from "revoked" is an oracle for whoever
 * is probing it.
 *
 * The cookie is cleared on both answers — the person asked to leave this device
 * — but NOT on a server error, so a failed attempt can be retried with the
 * credential that proves it.
 *
 * CSRF: the same checks as refresh. SameSite=Strict keeps the cookie off
 * cross-site requests; the Origin check is the second layer. A refused CSRF
 * check changes nothing, so a cross-site page cannot sign anyone out.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authDb } from "@/lib/prisma-auth";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { checkBrowserCsrf, clearRefreshCookie, readRefreshCookie } from "@/lib/auth/refresh-cookie";
import { revokeSessionByCredential } from "@/lib/auth/refresh-session";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function handleRefreshRevoke(
  req: Request,
  deps: { now?: () => Date; run?: typeof revokeSessionByCredential } = {}
): Promise<NextResponse> {
  const now = deps.now?.() ?? new Date();
  const run = deps.run ?? revokeSessionByCredential;

  try {
    const csrf = checkBrowserCsrf(req);
    if (!csrf.ok) {
      console.warn(JSON.stringify({ event: "refresh_revoke_csrf_refused", reason: csrf.reason }));
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
    }

    const ip = getClientIp(req);
    const rl = await consumeRateLimit({ key: `auth:refresh-revoke:${ip}`, limit: 30, windowMs: 60_000 });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: NO_STORE }
      );
    }

    const outcome = await run(authDb(), { credential: readRefreshCookie(req), now });
    const revoked = outcome.kind === "revoked";
    console.log(
      JSON.stringify({
        event: "logout",
        scope: "device",
        via: "refresh_cookie",
        result: revoked ? (outcome.alreadyEnded ? "already_ended" : "revoked") : "unproven",
        ...(revoked ? { sid: outcome.sessionId.slice(0, 8) } : {}),
      })
    );

    const res = NextResponse.json({ revoked }, { headers: NO_STORE });
    clearRefreshCookie(res);
    return res;
  } catch (error) {
    console.error("REFRESH_REVOKE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleRefreshRevoke(req);
}
