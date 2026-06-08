import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseDraftId(value: string): number {
  const draftId = Number(value);

  if (!draftId || Number.isNaN(draftId)) {
    throw new InventoryValidationError("Invalid supplier purchase draft id");
  }

  return draftId;
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

  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Supplier purchase approve route error:", error);

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
    const draftId = parseDraftId(params.id);
    const body = await request.json();

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new InventoryValidationError("lines are required");
    }

    const result = await approveSupplierPurchase({
      draftId,
      businessId: user.businessId,
      userId: user.id,
      lines: body.lines,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleInventoryError(error);
  }
}