import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parsePurchaseOrderId(value: string): number {
  const purchaseOrderId = Number(value);

  if (!purchaseOrderId || Number.isNaN(purchaseOrderId)) {
    throw new InventoryValidationError("Invalid purchase order id");
  }

  return purchaseOrderId;
}

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

  console.error("Purchase order detail route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const purchaseOrderId = parsePurchaseOrderId(params.id);

    const purchaseOrder = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          purchaseOrderService.getPurchaseOrder(
            { businessId: user.businessId, purchaseOrderId },
            { tx }
          )
        )
    );

    return NextResponse.json({
      success: true,
      purchaseOrder,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
