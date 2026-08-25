import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

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

    const found = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const bot = await tx.businessBot.findUnique({
            where: { businessId: user.businessId },
            select: { id: true },
          });
          const rec = bot
            ? await tx.businessBotRecommendation.findFirst({
                where: { id: recId, botId: bot.id },
                select: { id: true, status: true },
              })
            : null;
          if (!rec) return false;
          if (rec.status === "PROPOSED") {
            await tx.businessBotRecommendation.update({
              where: { id: rec.id },
              data: { status: "DISMISSED", dismissedAt: new Date() },
            });
          }
          return true;
        })
    );
    if (!found) {
      return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, status: "DISMISSED" });
  } catch (error) {
    console.error("BOT_RECOMMENDATION_DISMISS_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
