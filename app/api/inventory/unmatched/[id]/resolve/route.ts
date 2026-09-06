import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  rejectPendingMatch,
  resolvePendingMatchWithExistingItem,
  resolvePendingMatchWithNewItem,
} from "@/lib/services/inventory/pending-match.service";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(request);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const pendingMatchId = Number(id);

    if (!pendingMatchId || Number.isNaN(pendingMatchId)) {
      return NextResponse.json(
        { error: "Invalid pending match id" },
        { status: 400 }
      );
    }

    const body = await request.json();

    if (body.action === "LINK_EXISTING") {
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
              resolvePendingMatchWithExistingItem(
                {
                  pendingMatchId,
                  businessId: user.businessId,
                  userId: user.id,
                  itemId,
                },
                { tx }
              ),
            { timeoutMs: 15_000 }
          )
      );

      // AFTER this branch's transaction has committed. Reached only on a committed resolution.
      // Resolving an unmatched POS line finally applies the sale, so stock goes
      // DOWN here — unlike receiving and approval, this path can CREATE or
      // reopen a critical-stock notification rather than resolve one.
      //
      // One sync per resolution, not per unit. The REJECT branch below moves no
      // stock and deliberately has none.
      //
      // Cannot affect the response: the resolution is durable by now, and the
      // sync absorbs its own errors and returns them as data. Tenant context is
      // re-entered because the one above closed with the transaction.
      await runWithTenantContext({ businessId: user.businessId }, () =>
        syncInventoryAlertNotifications(user.businessId, new Date())
      );

      return NextResponse.json(result);
    }

    if (body.action === "CREATE_NEW") {
      if (!body.itemData?.name || !body.itemData?.unitType) {
        return NextResponse.json(
          { error: "itemData.name and itemData.unitType are required" },
          { status: 400 }
        );
      }

      const result = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction(
            (tx) =>
              resolvePendingMatchWithNewItem({
        pendingMatchId,
        businessId: user.businessId,
        userId: user.id,
        itemData: {
          name: body.itemData.name,
          unitType: body.itemData.unitType,
          minimumQuantity: body.itemData.minimumQuantity,
          reorderPoint: body.itemData.reorderPoint,
          costPerUnit: body.itemData.costPerUnit,
          sellPricePerUnit: body.itemData.sellPricePerUnit,
          sku: body.itemData.sku ?? null,
          barcode: body.itemData.barcode ?? null,
        },
              }, { tx }),
            { timeoutMs: 15_000 }
          )
      );

      // AFTER this branch's transaction has committed. Reached only when the new item and its sale both committed.
      // Resolving an unmatched POS line finally applies the sale, so stock goes
      // DOWN here — unlike receiving and approval, this path can CREATE or
      // reopen a critical-stock notification rather than resolve one.
      //
      // One sync per resolution, not per unit. The REJECT branch below moves no
      // stock and deliberately has none.
      //
      // Cannot affect the response: the resolution is durable by now, and the
      // sync absorbs its own errors and returns them as data. Tenant context is
      // re-entered because the one above closed with the transaction.
      await runWithTenantContext({ businessId: user.businessId }, () =>
        syncInventoryAlertNotifications(user.businessId, new Date())
      );

      return NextResponse.json(result);
    }

    if (body.action === "REJECT") {
      const result = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction((tx) =>
            rejectPendingMatch(
              {
                pendingMatchId,
                businessId: user.businessId,
                userId: user.id,
              },
              { tx }
            )
          )
      );

      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: "Invalid resolve action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("POST /api/inventory/unmatched/[id]/resolve error:", error);

    return NextResponse.json(
      { error: "Failed to resolve pending match" },
      { status: 500 }
    );
  }
}