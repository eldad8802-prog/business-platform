import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupplierPurchaseDraft } from "@/lib/services/inventory/supplier-purchase-intake.service";
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

type AuthenticatedUser = {
  id: number;
  businessId: number;
  email: string;
  name: string | null;
};

async function getAuthenticatedUser(
  request: NextRequest
): Promise<AuthenticatedUser> {
  const authorizationHeader = request.headers.get("authorization");

  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new InventoryUnauthorizedError("Missing or invalid authorization header");
  }

  const token = authorizationHeader.replace("Bearer ", "").trim();

  if (!token) {
    throw new InventoryUnauthorizedError("Missing token");
  }

  const userId = Number(token);

  if (!userId || Number.isNaN(userId)) {
    throw new InventoryUnauthorizedError("Invalid token");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      businessId: true,
    },
  });

  if (!user) {
    throw new InventoryUnauthorizedError("User not found");
  }

  return user;
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

  console.error("Supplier purchases route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);

    const drafts = await prisma.supplierPurchaseDraft.findMany({
      where: {
        businessId: user.businessId,
      },
      include: {
        lines: {
          orderBy: {
            id: "asc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      success: true,
      drafts,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new InventoryValidationError(
        "Supplier purchase must include at least one line"
      );
    }

    const result = await createSupplierPurchaseDraft({
      businessId: user.businessId,
      supplierName: body.supplierName ?? null,
      externalOrderId: body.externalOrderId ?? null,
      source: body.source ?? "MANUAL",
      orderDate: body.orderDate ?? null,
      createdByUserId: user.id,
      lines: body.lines,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleInventoryError(error);
  }
}