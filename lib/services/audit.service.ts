import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

type AuditLogInput = {
  businessId: number;
  eventType: string;
  entityType: string;
  entityId?: number | null;
  payload?: Record<string, unknown> | null;
};

/**
 * Optional transaction seam.
 *
 * `LearningEvent` is RLS-forced (`p7w2_tenant`, D2/P7 Wave 2), so a write that
 * runs on the global client OUTSIDE a tenant transaction carries no
 * `app.current_business_id` GUC and is rejected the moment the runtime connects
 * as a least-privilege role. Passing the caller's `tx` keeps the event inside
 * the same tenant transaction as the business write it describes — which also
 * makes the pair atomic: no event without its mutation, no mutation without its
 * event.
 *
 * Additive and backward compatible: every existing caller omits it and keeps its
 * current behavior exactly.
 */
type AuditLogOptions = { tx?: Prisma.TransactionClient };

export async function logAuditEvent(
  input: AuditLogInput,
  options?: AuditLogOptions
) {
  const { businessId, eventType, entityType, entityId, payload } = input;

  if (!businessId || Number.isNaN(businessId)) {
    return;
  }

  const db = options?.tx ?? prisma;

  try {
    await db.learningEvent.create({
      data: {
        businessId,
        eventType,
        entityType,
        entityId: entityId ?? null,
        payload: payload
          ? (payload as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (error) {
    // Best-effort for the legacy (no-tx) callers: an audit write must never
    // break the business action it describes.
    //
    // When a `tx` IS supplied the caller has opted into atomicity, so the error
    // is rethrown — swallowing it would leave the surrounding transaction
    // aborted on the database side while telling the caller everything
    // succeeded, which is the worst of both worlds.
    if (options?.tx) {
      throw error;
    }
    console.error("logAuditEvent error:", error);
  }
}