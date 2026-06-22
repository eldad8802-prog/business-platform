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

  console.error("Suppliers route error:", error);

  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

function parseStatus(value: string | null): "active" | "inactive" | "all" {
  if (value === "inactive") return "inactive";
  if (value === "all") return "all";
  return "active";
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const { searchParams } = new URL(request.url);

    const suppliers = await supplierService.listSuppliers({
      businessId: user.businessId,
      status: parseStatus(searchParams.get("status")),
      query: searchParams.get("q"),
      limit: searchParams.get("limit")
        ? Number(searchParams.get("limit"))
        : null,
    });

    return NextResponse.json({ suppliers });
  } catch (error) {
    return handleInventoryError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    const body = await request.json();

    const supplier = await supplierService.createSupplier({
      businessId: user.businessId,
      name: body?.name,
      phone: body?.phone ?? null,
      email: body?.email ?? null,
      taxId: body?.taxId ?? null,
      taxIdType: body?.taxIdType ?? null,
      notes: body?.notes ?? null,
      defaultLeadTimeDays: body?.defaultLeadTimeDays ?? null,
      createdByUserId: user.id,
    });

    // Advisory only: surface likely existing suppliers. Never blocks creation.
    const possibleMatches = await supplierService.findPossibleMatches({
      businessId: user.businessId,
      name: supplier.name,
      phone: supplier.phone,
      email: supplier.email,
      taxId: supplier.taxId,
    });

    return NextResponse.json(
      {
        supplier,
        possibleMatches: possibleMatches.filter((m) => m.id !== supplier.id),
      },
      { status: 201 }
    );
  } catch (error) {
    return handleInventoryError(error);
  }
}
