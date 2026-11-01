import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import { logAuditEvent } from "@/lib/services/audit.service";

type CreateOfferInput = {
  businessId: number;
  title: string;
  description: string | null;
  customerBenefitText: string;
  imageUrl?: string | null;
  validUntil: Date;
  /** Session user id only (never a request body). Absent → the event records UNKNOWN. */
  actorUserId?: number;
};

export async function createOffer(input: CreateOfferInput) {
  const {
    businessId,
    title,
    description,
    customerBenefitText,
    imageUrl,
    validUntil,
  } = input;

  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }

  if (!title) {
    throw new ValidationError("title is required");
  }

  if (!customerBenefitText) {
    throw new ValidationError("customerBenefitText is required");
  }

  if (Number.isNaN(validUntil.getTime())) {
    throw new ValidationError("validUntil must be a valid date");
  }

  if (validUntil <= new Date()) {
    throw new ValidationError("validUntil must be in the future");
  }

  const offer = await prisma.offer.create({
    data: {
      issuingBusinessId: businessId,
      title,
      description,
      customerBenefitText,
      imageUrl: imageUrl ?? null,
      validUntil,
      isActive: true,
    },
  });

  await logAuditEvent({
    businessId,
    eventType: "REVENUE_OFFER_CREATED",
    entityType: "OFFER",
    entityId: offer.id,
    ...(input.actorUserId
      ? { actor: { type: "OWNER_USER" as const, userId: input.actorUserId }, source: "OWNER_UI" as const }
      : { actor: { type: "UNKNOWN" as const }, source: "UNKNOWN" as const }),
    // No title: it is owner-typed free text.
    payload: {
      offerId: offer.id,
      validUntil: offer.validUntil.toISOString(),
      isActive: offer.isActive,
    },
  });

  return offer;
}

export async function getOffersByBusiness(businessId: number) {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }

  // Two Production constraints shape this read:
  //  - `Business` is column-granted to the runtime role (id, name, createdAt,
  //    deletionRequestedAt, deletedAt — 20260908180000_d2_user_business_privilege_narrowing).
  //    `include` selects every column, so the whole query was refused with
  //    "permission denied for table Business". Select only the granted columns.
  //  - `BusinessProfile` is FORCE RLS, so the nested profile is visible only inside
  //    the tenant transaction. These are the caller's own offers, so its own context.
  return tenantTx(businessId, (tx) =>
    tx.offer.findMany({
      where: {
        issuingBusinessId: businessId,
      },
      include: {
        issuingBusiness: {
          select: {
            id: true,
            name: true,
            createdAt: true,
            deletionRequestedAt: true,
            deletedAt: true,
            profile: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    })
  );
}