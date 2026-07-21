import { NextRequest, NextResponse } from "next/server";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from "@/lib/auth/inventory-auth";
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";
import { getSupplierPurchaseHistory } from "@/lib/services/inventory/supplier-purchase-history.read-model";

function parseSupplierId(value: string): number {
  const supplierId = Number(value);
  if (!supplierId || Number.isNaN(supplierId)) {
    throw new InventoryValidationError("Invalid supplier id");
  }
  return supplierId;
}

function parseIntParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new InventoryValidationError("Invalid numeric parameter");
  }
  return n;
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
  console.error("Supplier purchase-orders route error:", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/** Read-only supplier purchase history (S4-P4). Related by supplierId only. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const supplierId = parseSupplierId(params.id);
    const { searchParams } = new URL(request.url);

    const history = await getSupplierPurchaseHistory({
      businessId: user.businessId,
      supplierId,
      limit: parseIntParam(searchParams.get("limit")),
      offset: parseIntParam(searchParams.get("offset")),
    });

    return NextResponse.json(history);
  } catch (error) {
    return handleInventoryError(error);
  }
}
