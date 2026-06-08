import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import { createPlatformAuditEventTx } from "./platform-audit.service";

export type BusinessArchiveState = {
  businessId: number;
  archivedAt: string | null;
  archivedByUserId: number | null;
};

export type BusinessArchiveMutationResult = {
  business: BusinessArchiveState;
};

type ArchiveMutationInput = {
  actorUserId: number;
  businessId: number;
  req?: Request;
};

function toArchiveState(row: {
  id: number;
  archivedAt: Date | null;
  archivedByUserId: number | null;
}): BusinessArchiveState {
  return {
    businessId: row.id,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedByUserId: row.archivedByUserId,
  };
}

async function loadArchivableBusiness(businessId: number) {
  const business = await prisma.business.findFirst({
    where: {
      id: businessId,
      name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      archivedByUserId: true,
    },
  });

  if (!business) {
    throw new NotFoundError("Business not found");
  }

  return business;
}

export async function archiveBusiness(
  input: ArchiveMutationInput
): Promise<BusinessArchiveMutationResult> {
  const business = await loadArchivableBusiness(input.businessId);

  if (business.archivedAt) {
    throw new ValidationError("Business is already archived");
  }

  const archivedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.business.update({
      where: { id: input.businessId },
      data: {
        archivedAt,
        archivedByUserId: input.actorUserId,
      },
      select: {
        id: true,
        archivedAt: true,
        archivedByUserId: true,
      },
    });

    await createPlatformAuditEventTx(tx, {
      actorUserId: input.actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.BUSINESS_ARCHIVED,
      targetType: "BUSINESS",
      targetId: String(input.businessId),
      metadata: {
        businessId: input.businessId,
        businessName: business.name,
        archivedAt: archivedAt.toISOString(),
      },
      req: input.req,
    });

    return row;
  });

  return { business: toArchiveState(updated) };
}

export async function unarchiveBusiness(
  input: ArchiveMutationInput
): Promise<BusinessArchiveMutationResult> {
  const business = await loadArchivableBusiness(input.businessId);

  if (!business.archivedAt) {
    throw new ValidationError("Business is not archived");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.business.update({
      where: { id: input.businessId },
      data: {
        archivedAt: null,
        archivedByUserId: null,
      },
      select: {
        id: true,
        archivedAt: true,
        archivedByUserId: true,
      },
    });

    await createPlatformAuditEventTx(tx, {
      actorUserId: input.actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.BUSINESS_UNARCHIVED,
      targetType: "BUSINESS",
      targetId: String(input.businessId),
      metadata: {
        businessId: input.businessId,
        businessName: business.name,
        previousArchivedAt: business.archivedAt?.toISOString() ?? null,
        previousArchivedByUserId: business.archivedByUserId,
      },
      req: input.req,
    });

    return row;
  });

  return { business: toArchiveState(updated) };
}
