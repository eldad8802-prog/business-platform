import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InventoryUnitType } from "@prisma/client";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseInventoryUnitType(value: unknown): InventoryUnitType {
  if (typeof value !== "string") {
    throw new InventoryValidationError("unitType is required");
  }

  const normalizedValue = value.trim().toUpperCase();

  if (!Object.values(InventoryUnitType).includes(normalizedValue as InventoryUnitType)) {
    throw new InventoryValidationError("Invalid unitType");
  }

  return normalizedValue as InventoryUnitType;
}

function parseOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsedValue = Number(value);

  if (Number.isNaN(parsedValue)) {
    throw new InventoryValidationError(`${fieldName} must be a valid number`);
  }

  return parsedValue;
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

  console.error("Inventory items route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const name =
      typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      throw new InventoryValidationError("name is required");
    }

    const unitType = parseInventoryUnitType(body.unitType);

    const supplierName =
      typeof body.supplierName === "string" && body.supplierName.trim()
        ? body.supplierName.trim()
        : undefined;

    // 🔥 חדש — קטגוריה
    let categoryId: number | undefined = undefined;

    if (body.categoryId !== undefined && body.categoryId !== null) {
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

      categoryId = parsedCategoryId;
    }

    const item = await inventoryService.createItemWithInitialStock({
      businessId: user.businessId,
      name,
      unitType,
      supplierName,
      initialQuantity: parseOptionalNumber(body.initialQuantity, "initialQuantity"),
      minimumQuantity: parseOptionalNumber(body.minimumQuantity, "minimumQuantity"),
      reorderPoint: parseOptionalNumber(body.reorderPoint, "reorderPoint"),
      costPerUnit: parseOptionalNumber(body.costPerUnit, "costPerUnit"),
      sellPricePerUnit: parseOptionalNumber(body.sellPricePerUnit, "sellPricePerUnit"),
      sku: typeof body.sku === "string" ? body.sku : undefined,
      barcode: typeof body.barcode === "string" ? body.barcode : undefined,
      imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
      createdByUserId: user.id,

      // 🔥 חדש
      categoryId,
    });

    return NextResponse.json(
      {
        success: true,
        item,
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

    const items = await prisma.inventoryItem.findMany({
      where: {
        businessId: user.businessId,
      },
      include: {
        category: true, // 🔥 חדש
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

    return NextResponse.json({
      success: true,
      items,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}