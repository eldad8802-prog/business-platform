import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadUsageView } from "@/lib/services/subscriptions/usage/usage-snapshot.service";

/**
 * GET /api/business/usage — "my usage" for the business in the session (subscriptions stage C): subscription state,
 * trial days left, and per quota metric the quota, used, remaining, renewal date and whether it was reached.
 * Session only; the business comes from the session, never from the request. Read-only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const view = await loadUsageView(user.businessId);
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[usage] view failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "USAGE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
