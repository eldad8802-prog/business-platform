import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

/**
 * Dismiss a learning suggestion (Stage 8) — STATUS FLIP ONLY. No runtime effect.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await ctx.params;
    const sid = Number(id);
    if (!Number.isInteger(sid) || sid <= 0) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    const row = bot
      ? await prisma.businessBotLearningSuggestion.findFirst({
          where: { id: sid, botId: bot.id },
          select: { id: true, status: true },
        })
      : null;
    if (!row) {
      return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
    }

    if (row.status === "PROPOSED") {
      await prisma.businessBotLearningSuggestion.update({
        where: { id: row.id },
        data: { status: "DISMISSED", dismissedAt: new Date() },
      });
    }

    return NextResponse.json({ success: true, status: "DISMISSED" });
  } catch (error) {
    console.error("BOT_LEARNING_DISMISS_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
