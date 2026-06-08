import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supplierService } from "@/lib/services/inventory/supplier.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseSupplierId(value: string): number {
  const supplierId = Number(value);

  if (!supplierId || Number.isNaN(supplierId)) {
    throw new InventoryValidationError("Invalid supplier id");
  }

  return supplierId;
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
