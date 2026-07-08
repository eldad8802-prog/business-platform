import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryUnitType, InventoryMovementReason } from "@prisma/client";
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

  console.error("Inventory item [id] route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseItemIdFromRequest(request: NextRequest): number {
  const segments = request.nextUrl.pathname.split("/").filter(Boolean);
  const rawId = segments[segments.length - 1];

  if (!rawId) {
    throw new InventoryValidationError("Invalid item id");
  }

  const itemId = Number(rawId);

  if (!itemId || Number.isNaN(itemId)) {
    throw new InventoryValidationError("Invalid item id");
  }

  return itemId;
}

function parseRequiredNonNegativeNumber(
  value: unknown,
  fieldName: string
): number {
  const parsedValue = Number(value);

  if (Number.isNaN(parsedValue)) {
    throw new InventoryValidationError(`${fieldName} must be a valid number`);
  }

  if (parsedValue < 0) {
    throw new InventoryValidationError(`${fieldName} cannot be negative`);
  }

  return parsedValue;
}

function parseOptionalNullableNumber(
  value: unknown,
  fieldName: string
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  if (Number.isNaN(parsedValue)) {
    throw new InventoryValidationError(`${fieldName} must be a valid number`);
  }

  if (parsedValue < 0) {
    throw new InventoryValidationError(`${fieldName} cannot be negative`);
  }

  return parsedValue;
}

function parseUnitType(value: unknown): InventoryUnitType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new InventoryValidationError("Invalid unitType");
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

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const itemId = parseItemIdFromRequest(request);

    const item = await prisma.inventoryItem.findFirst({
      where: {
        id: itemId,
        businessId: user.businessId,
      },
      include: {
        alerts: {
          where: {
            isResolved: false,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!item) {
      throw new InventoryNotFoundError("Inventory item not found");
    }

    return NextResponse.json({
      success: true,
      item,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const itemId = parseItemIdFromRequest(request);

    const existingItem = await prisma.inventoryItem.findFirst({
      where: {
        id: itemId,
        businessId: user.businessId,
      },
    });

    if (!existingItem) {
      throw new InventoryNotFoundError("Inventory item not found");
    }

    const body = await request.json();

    const data: {
      name?: string;
      unitType?: InventoryUnitType;
      minimumQuantity?: number;
      reorderPoint?: number | null;
      costPerUnit?: number | null;
      sellPricePerUnit?: number | null;
      sku?: string | null;
      barcode?: string | null;
      imageUrl?: string | null;
      isActive?: boolean;
      supplierName?: string | null;
      categoryId?: number | null;
    } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new InventoryValidationError("Invalid name");
      }

      data.name = body.name.trim();
    }

    if (body.unitType !== undefined) {
      data.unitType = parseUnitType(body.unitType);
    }

    if (body.minimumQuantity !== undefined) {
      data.minimumQuantity = parseRequiredNonNegativeNumber(
        body.minimumQuantity,
        "minimumQuantity"
      );
    }

    if (body.reorderPoint !== undefined) {
      data.reorderPoint = parseOptionalNullableNumber(
        body.reorderPoint,
        "reorderPoint"
      );
    }

    if (body.costPerUnit !== undefined) {
      data.costPerUnit = parseOptionalNullableNumber(
        body.costPerUnit,
        "costPerUnit"
      );
    }

    if (body.sellPricePerUnit !== undefined) {
      data.sellPricePerUnit = parseOptionalNullableNumber(
        body.sellPricePerUnit,
        "sellPricePerUnit"
      );
    }

    if (body.sku !== undefined) {
      data.sku =
        typeof body.sku === "string" && body.sku.trim()
          ? body.sku.trim()
          : null;
    }

    if (body.barcode !== undefined) {
      data.barcode =
        typeof body.barcode === "string" && body.barcode.trim()
          ? body.barcode.trim()
          : null;
    }

    if (body.imageUrl !== undefined) {
      data.imageUrl =
        typeof body.imageUrl === "string" && body.imageUrl.trim()
          ? body.imageUrl.trim()
          : null;
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") {
        throw new InventoryValidationError("isActive must be boolean");
      }

      data.isActive = body.isActive;
    }

    if (body.supplierName !== undefined) {
      data.supplierName =
        typeof body.supplierName === "string" && body.supplierName.trim()
          ? body.supplierName.trim()
          : null;
    }

    if (body.categoryId !== undefined) {
      if (body.categoryId === null) {
        data.categoryId = null;
      } else {
        const parsedCategoryId = Number(body.categoryId);

        if (Number.isNaN(parsedCategoryId)) {
          throw new InventoryValidationError("Invalid categoryId");
        }

        const category = await prisma.inventoryCategory.findFirst({
          where: {
            id: parsedCategoryId,
            businessId: user.businessId,
          },
        });

        if (!category) {
          throw new InventoryValidationError("Category not found");
        }

        data.categoryId = parsedCategoryId;
      }
    }

    const updatedItem = await prisma.inventoryItem.update({
      where: { id: itemId },
      data,
    });

    return NextResponse.json({
      success: true,
      item: updatedItem,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const itemId = parseItemIdFromRequest(request);

    const existingItem = await prisma.inventoryItem.findFirst({
      where: {
        id: itemId,
        businessId: user.businessId,
      },
    });

    if (!existingItem) {
      throw new InventoryNotFoundError("Inventory item not found");
    }

    // An item that took part in receiving, ordering, POS mapping, or any stock
    // movement beyond its INITIAL_STOCK seed carries inventory truth we must not
    // erase (a hard delete would also be blocked by ReceivingLine's onDelete:
    // Restrict FK). In that case we archive it — it leaves the active inventory
    // list but its history stays intact and auditable. Only a fresh/mistaken
    // item with no real activity is removed permanently.
    const [receivingLines, purchaseOrderLines, posMappings, realMovements] =
      await Promise.all([
        prisma.receivingLine.count({ where: { itemId } }),
        prisma.purchaseOrderLine.count({ where: { itemId } }),
        prisma.pOSProductMapping.count({ where: { itemId } }),
        prisma.inventoryMovement.count({
          where: {
            itemId,
            reason: { not: InventoryMovementReason.INITIAL_STOCK },
          },
        }),
      ]);

    const isInUse =
      receivingLines > 0 ||
      purchaseOrderLines > 0 ||
      posMappings > 0 ||
      realMovements > 0;

    if (isInUse) {
      await prisma.inventoryItem.update({
        where: { id: itemId },
        data: { isActive: false },
      });

      return NextResponse.json({ success: true, archived: true });
    }

    // No real activity: remove permanently. Cascading FKs clear the lone
    // INITIAL_STOCK seed movement and any open alerts.
    await prisma.inventoryItem.delete({ where: { id: itemId } });

    return NextResponse.json({ success: true, deleted: true });
  } catch (error) {
    return handleError(error);
  }
}