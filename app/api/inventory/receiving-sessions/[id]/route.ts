import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { getInventoryAuthenticatedUser as getAuthenticatedUser, mapInventoryAuthGateError } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseReceivingSessionId(value: string): number {
  const receivingSessionId = Number(value);

  if (!receivingSessionId || Number.isNaN(receivingSessionId)) {
    throw new InventoryValidationError("Invalid receiving session id");
  }

  return receivingSessionId;
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

  console.error("Receiving session detail route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const receivingSessionId = parseReceivingSessionId(params.id);

    const receivingSession = await receivingService.getReceivingSession({
      businessId: user.businessId,
      receivingSessionId,
    });

    return NextResponse.json({
      success: true,
      receivingSession,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
