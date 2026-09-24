import { NextRequest, NextResponse } from "next/server";
import { redeemCoupon } from "@/lib/services/redeem.service";
import { handleError } from "@/lib/handle-error";
import { getCurrentUser } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/errors";

async function getAuthenticatedUser(req: NextRequest) {
  const user = await getCurrentUser(req);

  // Refused either way, but this is an authentication failure, not a
  // malformed request: a ValidationError reported it as 400.
  if (!user?.businessId) {
    throw new UnauthorizedError();
  }

  return { businessId: user.businessId, userId: user.id };
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const { businessId: redeemingBusinessId, userId } = await getAuthenticatedUser(req);

    const result = await redeemCoupon(token, redeemingBusinessId, userId);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}