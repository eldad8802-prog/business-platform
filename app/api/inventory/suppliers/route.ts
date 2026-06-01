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
      notes: body?.notes ?? null,
      defaultLeadTimeDays: body?.defaultLeadTimeDays ?? null,
    });

    // Advisory only: surface likely existing suppliers. Never blocks creation.
    const possibleMatches = await supplierService.findPossibleMatches({
      businessId: user.businessId,
      name: supplier.name,
      phone: supplier.phone,
      email: supplier.email,
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
