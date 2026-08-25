import { NextResponse } from "next/server";

import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = user.businessId;
    // D2/P7-W4B: the snapshot loaders read FORCE-RLS'd tables (Message,
    // ReplySuggestion) — run under the session tenant context so their
    // context-aware tenant transactions engage.
    const snapshot = await runWithTenantContext({ businessId }, () =>
      getBusinessStatusSnapshot(businessId)
    );

    return NextResponse.json(snapshot);
  } catch (error: unknown) {
    console.error("GET /api/business-status error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to load business status";

    return NextResponse.json(
      { error: "Failed to load business status", details: message },
      { status: 500 }
    );
  }
}
