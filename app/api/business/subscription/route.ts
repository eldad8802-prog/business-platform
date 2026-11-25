import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadSubscriptionView } from "@/lib/services/subscriptions/subscription-view.service";

/**
 * GET /api/business/subscription — the owner's subscription view (subscriptions stage C; owner decision 2026-11-25:
 * display only, no counters). Plan / trial / limited as facts, what needs attention now, the plan terms shown before
 * choosing a plan, and the open request. Session only; the business comes from the session, never from the request.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const view = await loadSubscriptionView(user.businessId);
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[subscription] view failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "SUBSCRIPTION_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
