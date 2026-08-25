import { NextRequest, NextResponse } from "next/server";
import { InventoryDraftStatus, InventoryUnitType } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { getInventoryAuthenticatedUserBasic as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function handleError(error: unknown) {
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

  console.error("Inventory draft approve route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseDraftIdFromRequest(request: NextRequest): number {
  const segments = request.nextUrl.pathname.split("/").filter(Boolean);
  const approveIndex = segments.findIndex((segment) => segment === "approve");
  const rawId = approveIndex > 0 ? segments[approveIndex - 1] : undefined;

  if (!rawId) {
    throw new InventoryValidationError("Invalid draft id");
  }

  const draftId = Number(rawId);

  if (!draftId || Number.isNaN(draftId)) {
    throw new InventoryValidationError("Invalid draft id");
  }

  return draftId;
}

function parseUnitType(value: unknown): InventoryUnitType {
  if (typeof value !== "string") {
    throw new InventoryValidationError("unitType is required");
  }

  const normalizedValue = value.trim().toUpperCase();

  if (
    !Object.values(InventoryUnitType).includes(
      normalizedValue as InventoryUnitType
    )
  ) {
    throw new InventoryValidationError("Invalid unitType");
  }

  return normalizedValue as InventoryUnitType;
}

function parseOptionalNumber(
  value: unknown,
  fieldName: string
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsedValue = Number(value);

  if (Number.isNaN(parsedValue)) {
    throw new InventoryValidationError(`${fieldName} must be a valid number`);
  }

  return parsedValue;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const draftId = parseDraftIdFromRequest(request);
    const body = await request.json();

    const { updatedDraft, createdItem } = await runWithTenantContext(
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
        "Only PENDING_REVIEW drafts can be approved"
      );
    }

    const finalName =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : draft.detectedName?.trim();

    if (!finalName) {
      throw new InventoryValidationError("name is required for approval");
    }

    const finalUnitType =
      body.unitType !== undefined
        ? parseUnitType(body.unitType)
        : draft.detectedUnitType;

    if (!finalUnitType) {
      throw new InventoryValidationError("unitType is required for approval");
    }

    const item = await inventoryService.createItemWithInitialStock({
      businessId: user.businessId,
      name: finalName,
      unitType: finalUnitType,
      initialQuantity: parseOptionalNumber(body.initialQuantity, "initialQuantity"),
      minimumQuantity: parseOptionalNumber(body.minimumQuantity, "minimumQuantity"),
      reorderPoint: parseOptionalNumber(body.reorderPoint, "reorderPoint"),
      costPerUnit: parseOptionalNumber(body.costPerUnit, "costPerUnit"),
      sellPricePerUnit: parseOptionalNumber(body.sellPricePerUnit, "sellPricePerUnit"),
      sku: typeof body.sku === "string" ? body.sku : undefined,
      barcode:
        typeof body.barcode === "string"
          ? body.barcode
          : draft.detectedBarcode || undefined,
      imageUrl:
        typeof body.imageUrl === "string"
          ? body.imageUrl
          : draft.imageUrl || undefined,
      createdByUserId: user.id,
    }, { tx });

    // Tenant-scoped status flip inside the same transaction (no id-only window).
    const flipped = await tx.inventoryDraft.updateMany({
      where: { id: draft.id, businessId: user.businessId },
      data: {
        status: InventoryDraftStatus.APPROVED,
      },
    });
    if (flipped.count !== 1) {
      throw new InventoryNotFoundError("Inventory draft not found");
    }
    const after = await tx.inventoryDraft.findFirst({
      where: { id: draft.id, businessId: user.businessId },
    });

    return { updatedDraft: after, createdItem: item };
        })
    );

    return NextResponse.json({
      success: true,
      draft: updatedDraft,
      item: createdItem,
    });
  } catch (error) {
    return handleError(error);
  }
}