import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Dismiss a recommendation (Stage 6) — status change ONLY. No runtime effect.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await ctx.params;
    const recId = Number(id);
    if (!Number.isInteger(recId) || recId <= 0) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    const rec = bot
      ? await prisma.businessBotRecommendation.findFirst({
          where: { id: recId, botId: bot.id },
          select: { id: true, status: true },
        })
      : null;
    if (!rec) {
      return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
    }

    if (rec.status === "PROPOSED") {
      await prisma.businessBotRecommendation.update({
        where: { id: rec.id },
        data: { status: "DISMISSED", dismissedAt: new Date() },
      });
    }

    return NextResponse.json({ success: true, status: "DISMISSED" });
  } catch (error) {
    console.error("BOT_RECOMMENDATION_DISMISS_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
