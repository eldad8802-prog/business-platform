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

function parsePositiveId(value: string, fieldName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError(`Invalid ${fieldName}`);
  }

  return parsed;
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

  console.error("Purchase order remaining decision route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; lineId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const purchaseOrderId = parsePositiveId(params.id, "purchase order id");
    const purchaseOrderLineId = parsePositiveId(
      params.lineId,
      "purchase order line id"
    );
    const body = await request.json();

    const purchaseOrderLine =
      await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
        businessId: user.businessId,
        purchaseOrderId,
        purchaseOrderLineId,
        decidedByUserId: user.id,
        remainingDecision: body.remainingDecision,
        remainingDecisionQty: body.remainingDecisionQty ?? null,
        expectedAt: body.expectedAt ?? null,
        remainingDecisionNote: body.remainingDecisionNote ?? null,
      });

    return NextResponse.json({
      success: true,
      purchaseOrderLine,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
