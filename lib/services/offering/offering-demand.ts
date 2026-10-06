import { Prisma } from "@prisma/client";
import type { OfferingDemandSignalType, OfferingDemandSource } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type OfferingDemandInput = {
  businessId: number;
  kind: "SERVICE" | "PRODUCT";
  offeringId: number;
  signalType: OfferingDemandSignalType;
  source: OfferingDemandSource;
  /**
   * Durable identity of this fact.
   * BOOKING: `booking:appointment:{appointmentId}`
   * PURCHASE: `purchase:sale-line:{saleLineId}` | `purchase:commerce-line:{commerceOrderLineId}` (M7-B)
   */
  idempotencyKey: string;
  appointmentId?: number | null;
  saleLineId?: number | null;
  /** M7-B — the online-store order line (source COMMERCE). */
  commerceOrderLineId?: number | null;
};

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Records one known offering fact inside the caller's transaction.
 * A second write with the same business and idempotency key returns the existing row.
 * This function does not match text and stores no customer or message.
 */
export async function recordOfferingDemand(tx: Tx, input: OfferingDemandInput) {
  const key = input.idempotencyKey.trim();
  if (!key) return null;

  const existing = await tx.offeringDemandSignal.findFirst({
    where: { businessId: input.businessId, idempotencyKey: key },
  });
  if (existing) return existing;

  if (input.kind === "SERVICE") {
    const service = await tx.businessService.findFirst({
      where: { id: input.offeringId, businessId: input.businessId },
      select: { id: true },
    });
    if (!service) return null;
    try {
      return await tx.offeringDemandSignal.create({
        data: {
          businessId: input.businessId,
          offeringKind: "SERVICE",
          businessServiceId: input.offeringId,
          appointmentId: input.appointmentId ?? null,
          signalType: input.signalType,
          source: input.source,
          idempotencyKey: key,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return tx.offeringDemandSignal.findFirst({
        where: { businessId: input.businessId, idempotencyKey: key },
      });
    }
  }

  const item = await tx.inventoryItem.findFirst({
    where: { id: input.offeringId, businessId: input.businessId },
    select: { id: true },
  });
  if (!item) return null;
  try {
    return await tx.offeringDemandSignal.create({
      data: {
        businessId: input.businessId,
        offeringKind: "PRODUCT",
        inventoryItemId: input.offeringId,
        saleLineId: input.saleLineId ?? null,
        commerceOrderLineId: input.commerceOrderLineId ?? null,
        signalType: input.signalType,
        source: input.source,
        idempotencyKey: key,
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    return tx.offeringDemandSignal.findFirst({
      where: { businessId: input.businessId, idempotencyKey: key },
    });
  }
}
