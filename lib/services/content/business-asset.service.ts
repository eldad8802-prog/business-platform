import { Prisma, type BusinessAssetOrigin } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export class BusinessAssetNotFoundError extends Error {
  constructor() {
    super("Asset not found");
    this.name = "BusinessAssetNotFoundError";
  }
}

export type RecordBusinessAssetInput = {
  businessId: number;
  origin: BusinessAssetOrigin;
  storageKey?: string | null;
  assetRef?: string | null;
  contentRunId?: number | null;
  idempotencyKey?: string | null;
};

export type RecordedBusinessAsset = {
  id: number;
  created: boolean;
  origin: BusinessAssetOrigin;
  storageKey: string | null;
  assetRef: string | null;
  contentRunId: number | null;
  publicUseApproved: boolean;
};

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export async function requireOwnedContentRun(businessId: number, contentRunId: number) {
  await assertRunInTenant(businessId, contentRunId);
}

async function assertRunInTenant(businessId: number, contentRunId: number | null | undefined) {
  if (contentRunId == null) return;
  const run = await tenantTx(businessId, (tx) =>
    tx.contentRun.findFirst({
      where: { id: contentRunId, businessId },
      select: { id: true },
    })
  );
  if (!run) throw new BusinessAssetNotFoundError();
}

export async function findBusinessAssetByIdempotency(
  businessId: number,
  idempotencyKey: string
): Promise<RecordedBusinessAsset | null> {
  const existing = await prisma.businessAsset.findUnique({
    where: {
      businessId_idempotencyKey: { businessId, idempotencyKey },
    },
  });
  if (!existing || existing.businessId !== businessId) return null;
  return {
    id: existing.id,
    created: false,
    origin: existing.origin,
    storageKey: existing.storageKey,
    assetRef: existing.assetRef,
    contentRunId: existing.contentRunId,
    publicUseApproved: existing.publicUseApproved,
  };
}

/**
 * One retained asset fact. publicUseApproved is always false here.
 * A retry of the same idempotency key returns the existing row.
 */
export async function recordBusinessAsset(
  input: RecordBusinessAssetInput
): Promise<RecordedBusinessAsset> {
  const storageKey = input.storageKey?.trim() || null;
  const assetRef = input.assetRef?.trim() || null;
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (!storageKey && !assetRef) {
    throw new Error("Asset requires a storage key or a durable reference");
  }

  await assertRunInTenant(input.businessId, input.contentRunId);

  if (idempotencyKey) {
    const existing = await findBusinessAssetByIdempotency(input.businessId, idempotencyKey);
    if (existing) return existing;
  }

  try {
    const created = await prisma.businessAsset.create({
      data: {
        businessId: input.businessId,
        origin: input.origin,
        storageKey,
        assetRef,
        contentRunId: input.contentRunId ?? null,
        publicUseApproved: false,
        idempotencyKey,
      },
    });
    return {
      id: created.id,
      created: true,
      origin: created.origin,
      storageKey: created.storageKey,
      assetRef: created.assetRef,
      contentRunId: created.contentRunId,
      publicUseApproved: created.publicUseApproved,
    };
  } catch (error) {
    if (idempotencyKey && isUniqueConflict(error)) {
      const existing = await findBusinessAssetByIdempotency(input.businessId, idempotencyKey);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function getBusinessAsset(businessId: number, assetId: number) {
  return prisma.businessAsset.findFirst({
    where: { id: assetId, businessId },
  });
}
