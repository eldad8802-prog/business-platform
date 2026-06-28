import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Recommendations list (Stage 6). Opt-in, advisory. Returns PROPOSED items the
 * owner can review. Never read by the planner/pipeline.
 */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    if (!bot) {
      return NextResponse.json({ success: true, recommendations: [], count: 0 });
    }

    const rows = await prisma.businessBotRecommendation.findMany({
      where: { botId: bot.id, status: "PROPOSED" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        payload: true,
        sourceGoalKey: true,
        sourceGoalVersion: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      count: rows.length,
      recommendations: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("BOT_RECOMMENDATIONS_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
