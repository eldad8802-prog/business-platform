import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { receivingService } from "@/lib/services/inventory/receiving.service";
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

function parseReceivingSessionId(value: string): number {
  const receivingSessionId = Number(value);

  if (!receivingSessionId || Number.isNaN(receivingSessionId)) {
    throw new InventoryValidationError("Invalid receiving session id");
  }

  return receivingSessionId;
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

  console.error("Receiving post route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const receivingSessionId = parseReceivingSessionId(params.id);

    const result = await receivingService.postReceivingSession({
      businessId: user.businessId,
      receivingSessionId,
      postedByUserId: user.id,
    });

    return NextResponse.json({
      success: true,
      receivingSession: result.receivingSession,
      movements: result.movements,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
