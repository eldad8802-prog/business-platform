import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";
import {
  isSaleIdempotencyConflict,
  recordInventorySale,
} from "@/lib/services/inventory/sale-evidence.service";
import { observeUnitPrice } from "@/lib/services/inventory/sale-price";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function handleInventoryError(error: unknown) {
  if (error instanceof InventoryUnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof InventoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (
    error instanceof InventoryValidationError ||
    error instanceof NegativeInventoryError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof InventoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Inventory sales route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const items = Array.isArray(body.items) ? body.items : [];
    const note = typeof body.note === "string" ? body.note.trim() : "";

    if (items.length === 0) {
      throw new InventoryValidationError("Sale must include at least one item");
    }

    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    const normalizedItems = items.map((item: any, index: number) => {
      const itemId = Number(item.itemId);
      const quantity = Number(item.quantity);

      if (!itemId || Number.isNaN(itemId)) {
        throw new InventoryValidationError("Invalid sale item id");
      }

      if (!quantity || Number.isNaN(quantity) || quantity <= 0) {
        throw new InventoryValidationError("Invalid sale item quantity");
      }

      const observedPrice = observeUnitPrice(item.unitPrice);
      if (observedPrice.kind === "invalid") {
        throw new InventoryValidationError("Invalid unit price");
      }

      return {
        itemId,
        quantity,
        unitPrice: observedPrice.kind === "present" ? observedPrice.amount : null,
        lineKey: String(index),
      };
    });

    // One tenant transaction — sale evidence and stock movements commit together.
    const recorded = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(
          (tx) =>
            recordInventorySale({
              tx,
              businessId: user.businessId,
              source: "MANUAL",
              idempotencyKey: idempotencyKey || null,
              note: note || undefined,
              createdByUserId: user.id,
              lines: normalizedItems,
            }),
          { timeoutMs: 15_000 }
        )
    );

    // AFTER the sale transaction above has committed. A sale can move several
    // items at once, and the sync reconciles the whole inventory domain for
    // this business in one pass, so one call covers every item the sale
    // touched — no per-item loop.
    //
    // It cannot affect the response: the sale is already durable, and the sync
    // swallows its own errors and returns them as data rather than throwing.
    // The tenant context is re-entered because the one above closed with the
    // transaction, and the writer refuses to run without a server-derived tenant.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInventoryAlertNotifications(user.businessId, new Date())
    );

    return NextResponse.json(
      {
        success: true,
        created: recorded.created,
        saleId: recorded.saleId,
        movements: recorded.movements,
      },
      { status: recorded.created ? 201 : 200 }
    );
  } catch (error) {
    if (isSaleIdempotencyConflict(error)) {
      return NextResponse.json(
        { success: true, created: false, movements: [] },
        { status: 200 }
      );
    }
    return handleInventoryError(error);
  }
}