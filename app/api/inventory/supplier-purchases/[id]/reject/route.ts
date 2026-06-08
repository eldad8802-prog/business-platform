import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SupplierPurchaseDraftStatus } from "@prisma/client";
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

  console.error("Supplier purchase reject route error:", error);

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

    const draft = await prisma.supplierPurchaseDraft.findFirst({
      where: {
        id: draftId,
        businessId: user.businessId,
      },
    });

    if (!draft) {
      throw new InventoryNotFoundError("Supplier draft not found");
    }

    if (draft.status !== SupplierPurchaseDraftStatus.PENDING_REVIEW) {
      throw new InventoryValidationError("Draft already processed");
    }

    await prisma.supplierPurchaseDraft.update({
      where: {
        id: draft.id,
      },
      data: {
        status: SupplierPurchaseDraftStatus.REJECTED,
      },
    });

    return NextResponse.json({
      success: true,
      draftId: draft.id,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}