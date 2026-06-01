import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supplierService } from "@/lib/services/inventory/supplier.service";
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
    select: { id: true, email: true, name: true, businessId: true },
  });

  if (!user) {
    throw new InventoryUnauthorizedError("User not found");
  }

  return user;
}

function parseSupplierId(value: string): number {
  const supplierId = Number(value);

  if (!supplierId || Number.isNaN(supplierId)) {
    throw new InventoryValidationError("Invalid supplier id");
  }

  return supplierId;
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

  console.error("Supplier route error:", error);

  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const supplierId = parseSupplierId(params.id);

    const supplier = await supplierService.getSupplier({
      businessId: user.businessId,
      supplierId,
    });

    return NextResponse.json({ supplier });
  } catch (error) {
    return handleInventoryError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const supplierId = parseSupplierId(params.id);
    const body = await request.json();

    const supplier = await supplierService.updateSupplier({
      businessId: user.businessId,
      supplierId,
      ...(body?.name !== undefined ? { name: body.name } : {}),
      ...(body?.phone !== undefined ? { phone: body.phone } : {}),
      ...(body?.email !== undefined ? { email: body.email } : {}),
      ...(body?.notes !== undefined ? { notes: body.notes } : {}),
      ...(body?.defaultLeadTimeDays !== undefined
        ? { defaultLeadTimeDays: body.defaultLeadTimeDays }
        : {}),
      ...(body?.isActive !== undefined ? { isActive: body.isActive } : {}),
    });

    return NextResponse.json({ supplier });
  } catch (error) {
    return handleInventoryError(error);
  }
}
