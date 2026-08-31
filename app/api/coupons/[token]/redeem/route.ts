import { NextRequest, NextResponse } from "next/server";
import { redeemCoupon } from "@/lib/services/redeem.service";
import { handleError } from "@/lib/handle-error";
import { getCurrentUser } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/errors";

async function getAuthenticatedBusinessId(req: NextRequest) {
  const user = await getCurrentUser(req);

  // Refused either way, but this is an authentication failure, not a
  // malformed request: a ValidationError reported it as 400.
  if (!user?.businessId) {
    throw new UnauthorizedError();
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