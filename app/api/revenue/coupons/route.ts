import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { resolveCouponBaseUrl } from "@/lib/revenue/coupon-base-url";
import {
  CouponValidationError,
  publishCoupon,
} from "@/lib/services/revenue/publish-coupon.service";

/**
 * Publish a coupon — the single atomic replacement for the old two-call
 * `POST /api/offers` → `POST /api/offers/:id/coupon` sequence (COUPON-01).
 *
 * A non-2xx from here means nothing was written at all, which is what lets the
 * wizard treat "not ok" as an honest failure instead of showing a success
 * screen over a half-created record.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const str = (v: unknown) => (typeof v === "string" ? v : "");

    const coupon = await publishCoupon({
      businessId: user.businessId,
      // Cast is safe: `publishCoupon` validates the type against the enum and
      // throws a 400 before touching the database.
      benefitType: str(body.benefitType) as never,
      value: str(body.value),
      scope: str(body.scope),
      description: str(body.description),
      title: str(body.title),
      minPurchaseEnabled: Boolean(body.minPurchaseEnabled),
      minPurchaseRaw: str(body.minPurchase),
      newCustomersOnly: Boolean(body.newCustomersOnly),
      validUntilDate: str(body.validUntilDate),
      baseUrl: resolveCouponBaseUrl(req),
    });

    return NextResponse.json({ coupon }, { status: 201 });
  } catch (error) {
    // Field-level errors are passed through so the wizard can mark the exact
    // input rather than showing a generic toast.
    if (error instanceof CouponValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code, fields: error.fields },
        { status: error.statusCode }
      );
    }
    return handleError(error);
  }
}
