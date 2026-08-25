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

  console.error("Inventory draft merge route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseDraftIdFromRequest(request: NextRequest): number {
  const segments = request.nextUrl.pathname.split("/").filter(Boolean);
  const mergeIndex = segments.findIndex((segment) => segment === "merge");
  const rawId = mergeIndex > 0 ? segments[mergeIndex - 1] : undefined;

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

    const body = await request.json();

    const targetItemId = Number(body.targetItemId);

    if (!targetItemId || Number.isNaN(targetItemId)) {
      throw new InventoryValidationError("targetItemId is required");
    }

    const { updatedDraft, targetItem } = await runWithTenantContext(
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
              "Only PENDING_REVIEW drafts can be merged"
            );
          }

          // Tenant-scoped target: a foreign item looks non-existent.
          const item = await tx.inventoryItem.findFirst({
            where: {
              id: targetItemId,
              businessId: user.businessId,
            },
          });

          if (!item) {
            throw new InventoryNotFoundError("Target item not found");
          }

          const flipped = await tx.inventoryDraft.updateMany({
            where: { id: draft.id, businessId: user.businessId },
            data: {
              status: InventoryDraftStatus.MERGED,
              mergedToItemId: item.id,
            },
          });
          if (flipped.count !== 1) {
            throw new InventoryNotFoundError("Inventory draft not found");
          }
          const after = await tx.inventoryDraft.findFirst({
            where: { id: draft.id, businessId: user.businessId },
          });
          return { updatedDraft: after, targetItem: item };
        })
    );

    return NextResponse.json({
      success: true,
      draft: updatedDraft,
      mergedToItem: {
        id: targetItem.id,
        name: targetItem.name,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}