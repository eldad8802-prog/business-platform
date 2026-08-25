import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SupplierPurchaseDraftStatus } from "@prisma/client";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
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

    const rejectedId = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          // Atomic tenant-scoped transition — no id-only mutation window.
          const transition = await tx.supplierPurchaseDraft.updateMany({
            where: {
              id: draftId,
              businessId: user.businessId,
              status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
            },
            data: {
              status: SupplierPurchaseDraftStatus.REJECTED,
              rejectedAt: new Date(),
            },
          });
          if (transition.count !== 1) {
            const exists = await tx.supplierPurchaseDraft.findFirst({
              where: { id: draftId, businessId: user.businessId },
              select: { id: true },
            });
            if (!exists) {
              throw new InventoryNotFoundError("Supplier draft not found");
            }
            throw new InventoryValidationError("Draft already processed");
          }
          return draftId;
        })
    );

    return NextResponse.json({
      success: true,
      draftId: rejectedId,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}