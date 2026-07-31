import { NextRequest, NextResponse } from "next/server";
import { handleError } from "@/lib/handle-error";
import { getCurrentUser } from "@/lib/auth";
import {
  getCouponCode,
  requireIssuerBusinessId,
} from "@/lib/services/revenue/coupon-code.service";

/**
 * W1-01: the coupon redemption secret (token/QR) is NOT public.
 *   - No authenticated business  → 401
 *   - Authenticated, not the issuer → 403
 *   - Authenticated issuer         → 200
 * The issuer identity is derived from the authenticated user ONLY.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const publicId = id;

    const user = await getCurrentUser(req);
    const businessId = requireIssuerBusinessId(user);

    const code = await getCouponCode(publicId, businessId);
    return NextResponse.json(code, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
