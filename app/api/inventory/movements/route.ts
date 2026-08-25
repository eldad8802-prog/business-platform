import { NextRequest, NextResponse } from "next/server";
import {
  InventoryMovementReason,
  InventoryMovementType,
} from "@prisma/client";
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

  console.error("Inventory movement error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

function parseEnum<T extends Record<string, string>>(
  enumObject: T,
  value: unknown,
  fieldName: string
): T[keyof T] {
  if (typeof value !== "string") {
    throw new InventoryValidationError(`${fieldName} is required`);
  }

  const normalized = value.trim().toUpperCase();

  if (!Object.values(enumObject).includes(normalized)) {
    throw new InventoryValidationError(`Invalid ${fieldName}`);
  }

  return normalized as T[keyof T];
}

function parseNumber(value: unknown, field: string): number {
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw new InventoryValidationError(`${field} must be a number`);
  }
  return num;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const itemId = parseNumber(body.itemId, "itemId");
    const quantityDelta = parseNumber(body.quantityDelta, "quantityDelta");

    const movementType = parseEnum(
      InventoryMovementType,
      body.movementType,
      "movementType"
    );

    const reason = parseEnum(
      InventoryMovementReason,
      body.reason,
      "reason"
    );

    const movement = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          inventoryService.createMovement(
            {
              businessId: user.businessId,
              itemId,
              movementType,
              reason,
              quantityDelta,
              note: typeof body.note === "string" ? body.note : undefined,
              createdByUserId: user.id,
            },
            { tx }
          )
        )
    );

    return NextResponse.json(
      {
        success: true,
        movement,
      },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);

    const itemIdParam = request.nextUrl.searchParams.get("itemId");
    const limitParam = request.nextUrl.searchParams.get("limit");

    const where: any = {
      businessId: user.businessId,
    };

    if (itemIdParam) {
      where.itemId = Number(itemIdParam);
    }

    const limit = limitParam ? Number(limitParam) : 50;

    const movements = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryMovement.findMany({
            where,
            orderBy: {
              createdAt: "desc",
            },
            take: limit,
            include: {
              item: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        )
    );

    return NextResponse.json({
      success: true,
      movements,
    });
  } catch (error) {
    return handleError(error);
  }
}