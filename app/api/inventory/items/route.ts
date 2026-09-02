import { NextRequest, NextResponse } from "next/server";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
// Moved to lib/services/inventory/inventory-core.ts so the Import preview can
// reach the same rule without importing a route.
import { parseInventoryUnitType } from "@/lib/services/inventory/inventory-core";
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";


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

    const item = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          // Tenant-scoped category resolution (a foreign category is invalid).
          let categoryId: number | undefined = undefined;

          if (body.categoryId !== undefined && body.categoryId !== null) {
            const parsedCategoryId = Number(body.categoryId);

            if (Number.isNaN(parsedCategoryId)) {
              throw new InventoryValidationError("Invalid categoryId");
            }

            const category = await tx.inventoryCategory.findFirst({
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

          return inventoryService.createItemWithInitialStock(
            {
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
              categoryId,
            },
            { tx }
          );
        })
    );

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

    const items = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryItem.findMany({
            where: {
              businessId: user.businessId,
            },
            include: {
              category: true,
              alerts: {
                where: {
                  isResolved: false,
                },
                orderBy: {
                  createdAt: "desc",
                },
              },
            },
          })
        )
    );

    return NextResponse.json({
      success: true,
      items,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}