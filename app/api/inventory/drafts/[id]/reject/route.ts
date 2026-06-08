import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryDraftStatus } from "@prisma/client";
import { getInventoryAuthenticatedUserBasic as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

function handleError(error: unknown) {
  const archiveGateResponse = mapInventoryAuthGateError(error);
  if (archiveGateResponse) return archiveGateResponse;

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

    const draft = await prisma.inventoryDraft.findFirst({
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

    const updatedDraft = await prisma.inventoryDraft.update({
      where: { id: draft.id },
      data: {
        status: InventoryDraftStatus.REJECTED,
      },
    });

    return NextResponse.json({
      success: true,
      draft: updatedDraft,
    });
  } catch (error) {
    return handleError(error);
  }
}