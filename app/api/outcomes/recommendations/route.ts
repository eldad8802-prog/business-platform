import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { ownerRecommendations } from "@/lib/knowledge/outcomes/owner-surface.service";

/**
 * Closed Loop — the owner's Dubiz recommendations (what, why, evidence, options, after).
 *
 * The business comes from the session. Behind the `owner_recommendations` feature: when it is off for this
 * business the answer is `{ enabled: false }` and nothing else. Only recommendations whose WHY was captured
 * durably are listed.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await ownerRecommendations(user.businessId, new Date());
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/outcomes/recommendations error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Failed to load recommendations" }, { status: 500 });
  }
}
