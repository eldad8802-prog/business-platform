import { NextRequest, NextResponse } from "next/server";
import { redeemCoupon } from "@/lib/services/redeem.service";
import { handleError } from "@/lib/handle-error";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/errors";

async function getAuthenticatedBusinessId(req: NextRequest) {
  const authHeader = req.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new ValidationError("Unauthorized");
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    throw new ValidationError("Unauthorized");
  }

  const userId = Number(token);

  if (!userId || Number.isNaN(userId)) {
    throw new ValidationError("Unauthorized");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      businessId: true,
    },
  });

  if (!user?.businessId) {
    throw new ValidationError("Unauthorized");
  }

  return user.businessId;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const redeemingBusinessId = await getAuthenticatedBusinessId(req);

    const result = await redeemCoupon(token, redeemingBusinessId);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}