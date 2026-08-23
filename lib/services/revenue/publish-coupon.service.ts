import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";
import { buildCouponQrValue } from "@/lib/revenue/coupon-base-url";
import {
  composeBenefitSentence,
  validateBenefit,
  DESCRIPTION_MAX,
  type BenefitType,
} from "@/lib/revenue/coupon-benefit";
import {
  composeTermsText,
  israelEndOfDay,
  validateTerms,
  validateValidUntil,
} from "@/lib/revenue/coupon-terms";

/**
 * Publishing a coupon — ONE atomic business operation (COUPON-01).
 *
 * The old flow was two client-driven round trips:
 *     POST /api/offers          → 201, Offer committed
 *     POST /api/offers/:id/coupon → 500, nothing issued
 * leaving an Offer that no coupon points at. In this feature an Offer with no
 * Coupon is not a valid business state — it is invisible to the marketplace, it
 * cannot be redeemed, and it cannot be managed. So publishing is now a single
 * server-side transaction: either the whole business object exists, or nothing
 * is written. That is what makes the audit's orphaned offers structurally
 * impossible rather than merely unlikely.
 */

/** 400 that carries which field to mark, so the wizard need not re-guess. */
export class CouponValidationError extends AppError {
  fields: { field: string; message: string }[];

  constructor(fields: { field: string; message: string }[]) {
    super(fields[0]?.message ?? "Validation Error", 400, "COUPON_INVALID");
    this.name = "CouponValidationError";
    this.fields = fields;
  }
}

export type PublishCouponInput = {
  businessId: number;
  benefitType: BenefitType;
  value: string;
  scope: string;
  description?: string | null;
  /** Owner-typed title. When blank the canonical composed sentence is used. */
  title?: string | null;
  minPurchaseEnabled?: boolean;
  minPurchaseRaw?: string;
  newCustomersOnly?: boolean;
  /** `YYYY-MM-DD` as picked in Israel; expires at 23:59:59.999 Israel time. */
  validUntilDate: string;
  baseUrl: string;
  now?: Date;
};

export type PublishedCouponDTO = {
  offerId: number;
  publicId: string;
  token: string;
  qrValue: string;
  benefit: string;
  description: string | null;
  expiresAt: string;
  status: "ACTIVE";
};

const TITLE_MAX = 80;

export async function publishCoupon(
  input: PublishCouponInput
): Promise<PublishedCouponDTO> {
  const { businessId, baseUrl } = input;
  const now = input.now ?? new Date();

  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new UnauthorizedError();
  }

  // ---- validate everything up front; nothing is written until this passes ----
  const fields: { field: string; message: string }[] = [];

  const benefitInput = {
    benefitType: input.benefitType,
    value: input.value ?? "",
    scope: input.scope ?? "",
  };
  fields.push(...validateBenefit(benefitInput));

  const { terms, errors: termsErrors } = validateTerms({
    minPurchaseEnabled: Boolean(input.minPurchaseEnabled),
    minPurchaseRaw: input.minPurchaseRaw ?? "",
  });
  terms.newCustomersOnly = Boolean(input.newCustomersOnly);
  fields.push(...termsErrors);

  const validUntil = israelEndOfDay(input.validUntilDate ?? "");
  fields.push(...validateValidUntil(validUntil, now));

  const ownerTitle = (input.title ?? "").trim();
  if (ownerTitle.length > TITLE_MAX) {
    fields.push({ field: "title", message: `הכותרת ארוכה מדי (עד ${TITLE_MAX} תווים)` });
  }

  const ownerDescription = (input.description ?? "").trim();
  if (ownerDescription.length > DESCRIPTION_MAX) {
    fields.push({ field: "description", message: `התיאור ארוך מדי (עד ${DESCRIPTION_MAX} תווים)` });
  }

  if (fields.length > 0) {
    throw new CouponValidationError(fields);
  }

  // ---- compose exactly what gets persisted -------------------------------
  const canonical = composeBenefitSentence(benefitInput);
  const benefit = ownerTitle || canonical;
  const termsText = composeTermsText(terms);
  const description =
    [ownerDescription, termsText].filter(Boolean).join(" · ") || null;

  const token = randomUUID();
  const qrValue = buildCouponQrValue(baseUrl, token);

  // ---- one atomic write: Offer + Coupon, or neither ------------------------
  //
  // A NESTED write, deliberately, rather than `prisma.$transaction(async tx =>
  // …)`. Prisma wraps a nested create in a single transaction, so atomicity is
  // identical — but it is one round trip instead of an interactive transaction
  // that pins a pooled connection for the duration. Against a remote (Neon)
  // database the interactive form intermittently fails with "Unable to start a
  // transaction in the given time", which would surface to the owner as the
  // same opaque 500 this whole change set exists to eliminate.
  const offer = await prisma.offer.create({
    data: {
      issuingBusinessId: businessId,
      title: benefit,
      customerBenefitText: benefit,
      description,
      imageUrl: null,
      validUntil,
      isActive: true,
      coupons: {
        create: {
          issuingBusinessId: businessId,
          token,
          qrValue,
          expiresAt: validUntil,
          status: "ACTIVE",
        },
      },
    },
    include: { coupons: true },
  });

  const coupon = offer.coupons[0];

  // Audit is deliberately outside the transaction: an audit-log hiccup must not
  // roll back a coupon the owner has already been told is live.
  await logAuditEvent({
    businessId,
    eventType: "REVENUE_COUPON_PUBLISHED",
    entityType: "COUPON",
    entityId: coupon.id,
    payload: {
      couponId: coupon.id,
      offerId: offer.id,
      publicId: coupon.publicId,
      benefit,
      benefitType: input.benefitType,
      scope: benefitInput.scope,
      minPurchase: terms.minPurchase,
      newCustomersOnly: terms.newCustomersOnly,
      expiresAt: coupon.expiresAt.toISOString(),
    },
  });

  return {
    offerId: offer.id,
    publicId: coupon.publicId,
    token: coupon.token,
    qrValue: coupon.qrValue,
    benefit,
    description,
    expiresAt: coupon.expiresAt.toISOString(),
    status: "ACTIVE",
  };
}
