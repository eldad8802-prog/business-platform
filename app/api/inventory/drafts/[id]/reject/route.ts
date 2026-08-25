import { NextRequest, NextResponse } from "next/server";
import { InventoryDraftStatus } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { getInventoryAuthenticatedUserBasic as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

function handleError(error: unknown) {
  if (error instanceof InventoryUnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof InventoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof InventoryValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof InventoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Inventory draft reject route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseDraftIdFromRequest(request: NextRequest): number {
  const segments = request.nextUrl.pathname.split("/").filter(Boolean);
  const rejectIndex = segments.findIndex((segment) => segment === "reject");
  const rawId = rejectIndex > 0 ? segments[rejectIndex - 1] : undefined;

  if (!rawId) {
    throw new InventoryValidationError("Invalid draft id");
  }

  const draftId = Number(rawId);

  if (!draftId || Number.isNaN(draftId)) {
    throw new InventoryValidationError("Invalid draft id");
  }

  return draftId;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const draftId = parseDraftIdFromRequest(request);

    const updatedDraft = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const draft = await tx.inventoryDraft.findFirst({
            where: {
              id: draftId,
              businessId: user.businessId,
            },
          });

          if (!draft) {
            throw new InventoryNotFoundError("Inventory draft not found");
          }

          if (draft.status !== InventoryDraftStatus.PENDING_REVIEW) {
            throw new InventoryValidationError(
              "Only PENDING_REVIEW drafts can be rejected"
            );
          }

          const flipped = await tx.inventoryDraft.updateMany({
            where: { id: draft.id, businessId: user.businessId },
            data: {
              status: InventoryDraftStatus.REJECTED,
            },
          });
          if (flipped.count !== 1) {
            throw new InventoryNotFoundError("Inventory draft not found");
          }
          return tx.inventoryDraft.findFirst({
            where: { id: draft.id, businessId: user.businessId },
          });
        })
    );

    return NextResponse.json({
      success: true,
      draft: updatedDraft,
    });
  } catch (error) {
    return handleError(error);
  }
}