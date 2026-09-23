import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { listOpenInsights } from "@/lib/knowledge/insight.service";

/**
 * M3 — the owner's open insights.
 *
 * The tenant is the SESSION's, never the caller's. There is no `businessId` parameter and there must
 * never be one: an insight is a statement about one business, and letting a request name which one is
 * the whole class of bug the tenant work exists to prevent.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const insights = await listOpenInsights(user.businessId);
    return NextResponse.json({ insights });
  } catch (error) {
    console.error("GET /api/insights error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Failed to load insights" }, { status: 500 });
  }
}
