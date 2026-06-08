import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
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
  const archiveGateResponse = mapInventoryAuthGateError(error);
  if (archiveGateResponse) return archiveGateResponse;

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

  console.error("Receiving sessions route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const purchaseOrderId = parsePurchaseOrderId(params.id);
    const body = await request.json();

    const receivingSession = await receivingService.createReceivingSession({
      businessId: user.businessId,
      purchaseOrderId,
      createdByUserId: user.id,
      receivedAt: body.receivedAt ?? null,
      note: body.note ?? null,
      lines: body.lines,
    });

    return NextResponse.json(
      {
        success: true,
        receivingSession,
      },
      { status: 201 }
    );
  } catch (error) {
    return handleInventoryError(error);
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const purchaseOrderId = parsePurchaseOrderId(params.id);

    const receivingSessions = await receivingService.listReceivingSessions({
      businessId: user.businessId,
      purchaseOrderId,
    });

    return NextResponse.json({
      success: true,
      receivingSessions,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
