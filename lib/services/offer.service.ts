import { prisma } from "@/lib/prisma";
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

  return prisma.offer.findMany({
    where: {
      issuingBusinessId: businessId,
    },
    include: {
      issuingBusiness: {
        include: {
          profile: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}