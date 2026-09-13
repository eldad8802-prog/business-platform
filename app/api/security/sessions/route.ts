/**
 * GET /api/security/sessions — the owner's own devices.
 *
 * Which row is "this device" comes from the verified access token's `sid`, read
 * server-side. Not from the refresh cookie, which is scoped to its own path and
 * never reaches here, and not from the User-Agent, which would be a guess.
 *
 * The response carries a DTO assembled in the directory module: no hash, no
 * generation, no rotation history, no raw User-Agent.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { listSessions } from "@/lib/auth/session-directory";

export async function GET(req: Request) {
  try {
    const context = await getAuthContext(req);
    if (context === null) return authRequiredResponse(req);

    const sessions = await listSessions({
      userId: context.user.id,
      currentSessionId: context.sessionId,
    });

    return NextResponse.json(
      {
        sessions,
        // A token minted before per-device revocation shipped names no session,
        // so nothing can be marked as current and "log out other devices" has no
        // safe pivot. The UI reads this rather than inferring it from an absent
        // crown, and the honest fix is one refresh away.
        currentIdentified: context.sessionId !== null,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("SESSIONS_LIST_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
