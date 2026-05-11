import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { getVelocityMap } from "@/lib/services/inventory/inventory-velocity.service";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user || !user.businessId) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const items = await prisma.inventoryItem.findMany({
      where: {
        businessId: user.businessId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        currentQuantity: true,
        minimumQuantity: true,
        reorderPoint: true,
      },
    });

    // ── Existing reorder logic — unchanged ────────────────────────────────────
    const suggestions = items
      .map((item) => {
        const threshold =
          item.reorderPoint !== null
            ? item.reorderPoint
            : item.minimumQuantity;

        const shouldReorder =
          item.currentQuantity <= threshold || item.currentQuantity <= 0;

        if (!shouldReorder) return null;

        const targetQuantity = threshold;
        const suggestedOrderQuantity =
          targetQuantity - item.currentQuantity;

        if (suggestedOrderQuantity <= 0) return null;

        return {
          itemId: item.id,
          name: item.name,
          currentQuantity: item.currentQuantity,
          minimumQuantity: item.minimumQuantity,
          reorderPoint: item.reorderPoint,
          suggestedOrderQuantity,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    // ─────────────────────────────────────────────────────────────────────────

    // ── Velocity enrichment — read-only, never alters suggestedOrderQuantity ─
    const currentQtyMap = new Map(
      suggestions.map((s) => [s.itemId, s.currentQuantity])
    );
    const velocityMap = await getVelocityMap(
      user.businessId,
      suggestions.map((s) => s.itemId),
      currentQtyMap
    );

    const enriched = suggestions.map((s) => {
      const v = velocityMap.get(s.itemId);
      return {
        ...s,
        soldLast30d: v?.soldLast30d ?? 0,
        txCount: v?.txCount ?? 0,
        avgDailyRate: v?.avgDailyRate ?? 0,
        daysOfStockLeft: v?.daysOfStockLeft ?? null,
        urgency: v?.urgency ?? null,
      };
    });
    // ─────────────────────────────────────────────────────────────────────────

    return NextResponse.json({
      suggestions: enriched,
    });
  } catch (error) {
    console.error("reorder-suggestions error:", error);

    return NextResponse.json(
      { error: "Failed to fetch reorder suggestions" },
      { status: 500 }
    );
  }
}
