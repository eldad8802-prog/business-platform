import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getOpenPendingMatches } from "@/lib/services/inventory/pending-match.service";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pendingMatches = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          getOpenPendingMatches(user.businessId, { tx })
        )
    );

    return NextResponse.json({
      success: true,
      pendingMatches,
    });
  } catch (error) {
    console.error("GET /api/inventory/unmatched error:", error);

    return NextResponse.json(
      { error: "Failed to load unmatched inventory items" },
      { status: 500 }
    );
  }
}