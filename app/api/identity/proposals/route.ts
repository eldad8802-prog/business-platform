import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listOpenProposals } from "@/lib/identity/entity-identity.service";

/**
 * M5 — what Dubiz suspects, waiting for someone who can actually say.
 *
 * The tenant comes from the session and nothing else. There is no businessId parameter, because a
 * parameter is a thing a caller can change.
 *
 * The response carries no names: a subject kind, a subject id, the party it might be, and WHICH KIND
 * of signal suggested it — never the matched value. The matched value is this business's own data and
 * a surface that renders a proposal will resolve the names it needs through the normal tenant-scoped
 * reads, rather than having them handed over by an identity endpoint.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const proposals = await listOpenProposals(user.businessId);
    return NextResponse.json({ proposals });
  } catch (error) {
    console.error(
      "GET /api/identity/proposals error:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ error: "Failed to load proposals" }, { status: 500 });
  }
}
