import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { ownerRecommendations } from "@/lib/knowledge/outcomes/owner-surface.service";

/** Closed Loop — one recommendation of the session's business, with its WHY. 404 for any other id. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const recommendationId = Number(id);
  if (!Number.isInteger(recommendationId) || recommendationId <= 0) {
    return NextResponse.json({ error: "invalid recommendation id" }, { status: 400 });
  }
  try {
    const payload = await ownerRecommendations(user.businessId, new Date(), { id: recommendationId });
    if (!payload.enabled) return NextResponse.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
    const item = payload.items[0];
    if (!item) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ...payload, items: undefined, item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/outcomes/recommendations/[id] error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Failed to load recommendation" }, { status: 500 });
  }
}
