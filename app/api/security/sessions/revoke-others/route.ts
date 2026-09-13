/**
 * POST /api/security/sessions/revoke-others — end every other device.
 *
 * The current session survives, and that is the entire difference between this
 * and "log out everywhere". So it must not touch `tokenVersion`: bumping the
 * generation would end the caller's own session, which is the opposite of what
 * the control promises and would sign out the person pressing it.
 *
 * A token that names no session is REFUSED rather than served. Guessing which row
 * to spare is the one mistake here whose failure mode is signing the owner out of
 * everything they have.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { revokeOtherSessions } from "@/lib/auth/session-directory";

export async function POST(req: Request) {
  try {
    const context = await getAuthContext(req);
    if (context === null) return authRequiredResponse(req);

    if (context.sessionId === null) {
      // A pre-rollout token. Distinct from a refusal, because the client can fix
      // it: one refresh mints a token that names its session, and the retry then
      // works. Saying so is better than a generic error the UI cannot act on.
      return NextResponse.json(
        { error: "Refresh required", code: "SESSION_UNIDENTIFIED" },
        { status: 409, headers: { "cache-control": "no-store" } }
      );
    }

    const { revoked } = await revokeOtherSessions({
      userId: context.user.id,
      currentSessionId: context.sessionId,
    });

    if (revoked > 0) {
      console.log(
        JSON.stringify({ event: "sessions_revoked_by_user", userId: context.user.id, revoked })
      );
    }

    return NextResponse.json(
      { success: true, revoked },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error(
      "SESSIONS_REVOKE_OTHERS_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
