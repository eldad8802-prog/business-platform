import { NextRequest, NextResponse } from "next/server";
import { PurchaseOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseStatus(value: string | null): PurchaseOrderStatus | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();

  if (
    !Object.values(PurchaseOrderStatus).includes(
      normalized as PurchaseOrderStatus
    )
  ) {
    throw new InventoryValidationError("Invalid purchase order status");
  }

  return normalized as PurchaseOrderStatus;
}

function parseLimit(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError("Invalid limit");
  }

  return parsed;
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

  console.error("Purchase orders route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const purchaseOrder = await purchaseOrderService.createPurchaseOrder({
      businessId: user.businessId,
      createdByUserId: user.id,
      supplierName: body.supplierName ?? null,
      externalOrderId: body.externalOrderId ?? null,
      source: body.source ?? "MANUAL",
      orderDate: body.orderDate ?? null,
      status: body.status ?? null,
      sourceSupplierPurchaseDraftId:
        body.sourceSupplierPurchaseDraftId ?? null,
      lines: body.lines,
    });

    return NextResponse.json(
      {
        success: true,
        purchaseOrder,
      },
      { status: 201 }
    );
  } catch (error) {
    return handleInventoryError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const status = parseStatus(request.nextUrl.searchParams.get("status"));
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));

    const purchaseOrders = await purchaseOrderService.listPurchaseOrders({
      businessId: user.businessId,
      status,
      limit,
    });

    return NextResponse.json({
      success: true,
      purchaseOrders,
      nextCursor: null,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
