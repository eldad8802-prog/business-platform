import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryInsightActionService } from "@/lib/services/inventory/inventory-insight-action.service";

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    if (!body.key || typeof body.key !== "string") {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    if (body.action === "CREATE_ITEM_FROM_INSIGHT") {
      const result = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction(
            (tx) =>
              inventoryInsightActionService.createItemFromInsight(
                {
                  businessId: user.businessId,
                  userId: user.id,
                  key: body.key,
                },
                { tx }
              ),
            { timeoutMs: 15_000 }
          )
      );

      return NextResponse.json(result);
    }

    if (body.action === "LINK_EXISTING_FROM_INSIGHT") {
      const itemId = Number(body.itemId);

      if (!itemId || Number.isNaN(itemId)) {
        return NextResponse.json(
          { error: "itemId is required" },
          { status: 400 }
        );
      }

      const result = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction(
            (tx) =>
              inventoryInsightActionService.linkExistingFromInsight(
                {
                  businessId: user.businessId,
                  userId: user.id,
                  key: body.key,
                  itemId,
                },
                { tx }
              ),
            { timeoutMs: 15_000 }
          )
      );

      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/inventory/insights/action error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to execute insight action" },
      { status: 500 }
    );
  }
}