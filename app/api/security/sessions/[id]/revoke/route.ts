/**
 * POST /api/security/sessions/[id]/revoke — end one device.
 *
 * POST rather than DELETE, deliberately: a session is not deleted. The row stays
 * and gains a revocation, which is a state transition with a reason and a time,
 * and DELETE semantics would promise a removal that does not happen.
 *
 * An unknown id and another user's id return the SAME 404. That is the whole
 * anti-enumeration property: a caller cannot learn from this endpoint whether a
 * guessed id is a real session belonging to someone else.
 *
 * No generation bump. Ending one device must not end the others, and
 * `tokenVersion` is the global switch reserved for "log out everywhere".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { clearRefreshCookie } from "@/lib/auth/refresh-cookie";
import { revokeSession } from "@/lib/auth/session-directory";
import { recordSecurityEvent } from "@/lib/security/security-events";

/** `<uuid>` and nothing else, so a malformed id never reaches a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const context = await getAuthContext(req);
    if (context === null) return authRequiredResponse(req);

    const { id } = await params;

    // A shape that cannot be a session id gets the same answer as one that is not
    // the caller's. Answering differently would say "that was a valid uuid".
    if (!UUID.test(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const result = await revokeSession({
      userId: context.user.id,
      sessionId: id,
      currentSessionId: context.sessionId,
    });

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: { "cache-control": "no-store" } }
      );
    }

    await recordSecurityEvent({ type: "AUTH_SESSION_REVOKED", outcome: "SUCCESS", reason: result.wasCurrent ? "current_session" : "other_session", userId: context.user.id, req });
    const res = NextResponse.json(
      {
        success: true,
        // The client needs to know whether it has just ended its own session, so
        // it can drop its token and go to the sign-in screen instead of rendering
        // a list it can no longer fetch.
        wasCurrent: result.wasCurrent,
      },
      { headers: { "cache-control": "no-store" } }
    );

    if (result.wasCurrent) {
      // Ending this device means ending it here too: the refresh credential must
      // go, or the browser would quietly mint a new access token for a session
      // that has just been revoked — and be refused by gate 4 on every request in
      // between. Clearing works from any route because expiring a cookie does not
      // require it to have been sent.
      clearRefreshCookie(res);
    }

    return res;
  } catch (error) {
    console.error("SESSION_REVOKE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
