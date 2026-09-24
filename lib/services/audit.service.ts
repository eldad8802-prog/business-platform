import { Prisma } from "@prisma/client";
import { tenantTx } from "@/lib/tenant/tenant-tx";

/**
 * Who or what caused the event.
 *
 * M5. Until now this seam could not carry an actor even when the caller had one — three of the five
 * `LearningEvent` writers held the signed-in user and discarded it, because there was nowhere to put
 * them. Every other audit trail in this codebase (billing, payments, payables, platform) has recorded
 * an actor since the day it was written; this one, the only GENERIC tenant-scoped event bus, did not.
 * An event with nobody attached is a poor foundation for learning about behaviour.
 *
 * OPTIONAL, deliberately. A caller that genuinely does not know must be able to say nothing rather
 * than be pushed into asserting UNKNOWN or, worse, guessing. Omitting it leaves both columns NULL —
 * which is exactly what every historical row already says.
 */
export type AuditActor =
  | { type: "OWNER_USER"; userId: number }
  | { type: "SYSTEM" }
  | { type: "INTEGRATION" }
  | { type: "UNKNOWN" };

type AuditLogInput = {
  businessId: number;
  eventType: string;
  entityType: string;
  entityId?: number | null;
  payload?: Record<string, unknown> | null;
  /** Server-derived only. An actor that arrived in a request body is not evidence of anything. */
  actor?: AuditActor;
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
  const { businessId, eventType, entityType, entityId, payload, actor } = input;

  if (!businessId || Number.isNaN(businessId)) {
    return;
  }

  const data = {
    businessId,
    eventType,
    entityType,
    entityId: entityId ?? null,
    payload: payload ? (payload as Prisma.InputJsonValue) : Prisma.JsonNull,
    actorType: actor?.type ?? null,
    // The user id is written only for OWNER_USER. A SYSTEM or INTEGRATION event has no person behind
    // it, and attaching one — even the user whose request happened to trigger the background work —
    // would put a name on a decision nobody made.
    actorUserId: actor?.type === "OWNER_USER" ? actor.userId : null,
  };

  try {
    if (options?.tx) {
      // The caller opted into atomicity: the event lands in the same transaction as the mutation it
      // describes. No event without its mutation, no mutation without its event.
      await options.tx.learningEvent.create({ data });
    } else {
      /**
       * M5 — the no-tx path now opens its OWN tenant transaction.
       *
       * It used to fall through to the bare `prisma` singleton, which carries no
       * `app.current_business_id`. `LearningEvent` is FORCE RLS, so under the least-privilege
       * runtime every such write was rejected with 42501, caught below, logged, and DISCARDED.
       * Dozens of callers across billing, CRM, coupons and conversations pass no `tx` — so the only
       * generic event bus in the system has been dropping their events on the floor: visibly in the
       * logs, and invisibly everywhere that matters.
       *
       * The M4/M5 battery found it by running this exact path as a measured NOBYPASSRLS role, which
       * is how the original Business Memory defect was found and precisely why that battery exists.
       * `businessId` is already required and server-derived, so there is nothing to decide here —
       * the fallback simply stops being context-less.
       */
      await tenantTx(businessId, (tx) => tx.learningEvent.create({ data }));
    }
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