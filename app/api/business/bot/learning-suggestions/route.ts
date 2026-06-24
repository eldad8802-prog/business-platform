import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Learning suggestions list (Stage 8) — PROPOSED items the owner can review.
 *
 * Proposals only — the bot never changes itself. There is no production
 * generator yet; suggestions are seeded by tests/tools directly in the DB.
 * NOT read by the planner/pipeline.
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
      return NextResponse.json({ success: true, count: 0, suggestions: [] });
    }

    const rows = await prisma.businessBotLearningSuggestion.findMany({
      where: { botId: bot.id, status: "PROPOSED" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        description: true,
        payload: true,
        evidence: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      count: rows.length,
      suggestions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  } catch (error) {
    console.error("BOT_LEARNING_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
