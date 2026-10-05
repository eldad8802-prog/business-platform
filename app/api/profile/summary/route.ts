/**
 * GET /api/profile/summary — the signed-in business's Profile: identity, the
 * three metrics, business-details completion, document-signature state and
 * the subscription view. See lib/services/profile/profile-summary.service.ts.
 *
 * Read-only. The business is the session's; nothing in the request can name
 * another one.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadProfileSummary } from "@/lib/services/profile/profile-summary.service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const summary = await loadProfileSummary({
      businessId: user.businessId,
      businessName: user.business?.name ?? "",
      userName: user.name,
      userEmail: user.email,
    });

    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("PROFILE_SUMMARY_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
