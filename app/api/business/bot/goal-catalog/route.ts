import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { GOAL_CATALOG, GOAL_CATALOG_VERSION } from "@/lib/features/bot";

/**
 * Read-only Goal Catalog (Stage 2). Static content — no DB, no business state.
 * Never read by the response-planner or the conversation pipeline.
 */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    return NextResponse.json({
      success: true,
      version: GOAL_CATALOG_VERSION,
      categories: GOAL_CATALOG,
    });
  } catch (error) {
    console.error("BOT_GOAL_CATALOG_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
