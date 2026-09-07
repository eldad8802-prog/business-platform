import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryInsightActionService } from "@/lib/services/inventory/inventory-insight-action.service";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";

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

      // AFTER this branch's transaction has committed. The new item is created at the pending quantity, then the sale removes it.
      //
      // Both insight actions resolve pending POS lines, so both move stock and
      // both are wired. Each loops over every pending match behind the insight
      // inside ONE transaction, and the reconciliation covers the whole
      // inventory domain, so one call per request serves all of them.
      //
      // Cannot affect the response: the action is durable by now, and the sync
      // absorbs its own errors and returns them as data. Tenant context is
      // re-entered because the one above closed with the transaction.
      await runWithTenantContext({ businessId: user.businessId }, () =>
        syncInventoryAlertNotifications(user.businessId, new Date())
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

      // AFTER this branch's transaction has committed. Resolving against an existing item removes the sale quantity.
      //
      // Both insight actions resolve pending POS lines, so both move stock and
      // both are wired. Each loops over every pending match behind the insight
      // inside ONE transaction, and the reconciliation covers the whole
      // inventory domain, so one call per request serves all of them.
      //
      // Cannot affect the response: the action is durable by now, and the sync
      // absorbs its own errors and returns them as data. Tenant context is
      // re-entered because the one above closed with the transaction.
      await runWithTenantContext({ businessId: user.businessId }, () =>
        syncInventoryAlertNotifications(user.businessId, new Date())
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