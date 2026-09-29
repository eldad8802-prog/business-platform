/**
 * Business Intake · the operator read model.
 *
 * Answers "the provider says it delivered event X — what happened inside
 * Dubiz?" from ONE place, without exposing what the event contained:
 *
 *   - lookup by the provider's own event id (hashed exactly as the adapter
 *     keyed it) or by receipt id;
 *   - TENANT-SCOPED: runs in the business's tenant transaction, so FORCE RLS
 *     decides what exists. There is deliberately no cross-tenant variant: the
 *     repository has no operator role that may read tenant intake, and M3 does
 *     not invent one. A support endpoint can wrap this once such a role exists;
 *   - never returns the payload, contact hints, message text or provider ids —
 *     only lifecycle, codes, stages, timestamps, attribution and result ids.
 */

import { withTenantTransaction } from "@/lib/tenant/transaction";
import { INTAKE_MAX_ATTEMPTS } from "@/lib/intake/intake-event.store";
import { deriveEventIdentity, type EventIdentityInput } from "./event-identity";

/** One word for "where is this event", derived from the lifecycle columns. */
export type IntakeState = "received" | "processing" | "retrying" | "dead_letter" | "processed" | "ignored";

export type IntakeTrace = {
  receiptId: number;
  sourceKey: string;
  family: string;
  eventType: string;
  dedupeBasis: string;
  state: IntakeState;
  status: string;
  lastStage: string | null;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  occurredAt: string | null;
  receivedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  payloadRetained: boolean;
  normalized: null | {
    normalizerVersion: string;
    identityOutcome: string;
    signals: unknown;
    contactHintsRetained: boolean;
    attribution: unknown;
    routeTarget: string | null;
    routeOutcome: string | null;
    resultRefs: unknown;
    routedAt: string | null;
  };
};

export function deriveIntakeState(
  e: { status: string; nextAttemptAt: Date | null; lastAttemptAt: Date | null },
  now: Date
): IntakeState {
  switch (e.status) {
    case "PROCESSED":
      return "processed";
    case "IGNORED":
      return "ignored";
    case "FAILED":
      return e.nextAttemptAt === null ? "dead_letter" : "retrying";
    default: {
      // RECEIVED / PERSISTED: a live lease means a worker holds it now.
      const leased = e.lastAttemptAt !== null && e.nextAttemptAt !== null && e.nextAttemptAt > now;
      return leased ? "processing" : "received";
    }
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function traceWhere(
  businessId: number,
  where: { id: number } | { sourceKey: string; externalEventId: string },
  now: Date
): Promise<IntakeTrace | null> {
  return withTenantTransaction(async (tx) => {
    const e = await tx.intakeEvent.findFirst({
      where: { businessId, ...where },
      select: {
        id: true,
        sourceKey: true,
        family: true,
        eventType: true,
        dedupeBasis: true,
        status: true,
        lastStage: true,
        attempts: true,
        lastErrorCode: true,
        occurredAt: true,
        receivedAt: true,
        lastAttemptAt: true,
        nextAttemptAt: true,
        processedAt: true,
        payloadPurgedAt: true,
        normalized: {
          select: {
            normalizerVersion: true,
            identityOutcome: true,
            signals: true,
            contactHintsPurgedAt: true,
            contactHints: true,
            attribution: true,
            routeTarget: true,
            routeOutcome: true,
            resultRefs: true,
            routedAt: true,
          },
        },
      },
    });
    if (!e) return null;
    const n = e.normalized;
    return {
      receiptId: e.id,
      sourceKey: e.sourceKey,
      family: e.family,
      eventType: e.eventType,
      dedupeBasis: e.dedupeBasis,
      state: deriveIntakeState(e, now),
      status: e.status,
      lastStage: e.lastStage,
      attempts: e.attempts,
      maxAttempts: INTAKE_MAX_ATTEMPTS,
      lastErrorCode: e.lastErrorCode,
      occurredAt: iso(e.occurredAt),
      receivedAt: e.receivedAt.toISOString(),
      lastAttemptAt: iso(e.lastAttemptAt),
      nextAttemptAt: iso(e.nextAttemptAt),
      processedAt: iso(e.processedAt),
      payloadRetained: e.payloadPurgedAt === null && e.status !== "PROCESSED" && e.status !== "IGNORED",
      normalized: n
        ? {
            normalizerVersion: n.normalizerVersion,
            identityOutcome: n.identityOutcome,
            signals: n.signals,
            // Presence only — the hints themselves never leave the store here.
            contactHintsRetained: n.contactHints !== null && n.contactHintsPurgedAt === null,
            attribution: n.attribution,
            routeTarget: n.routeTarget,
            routeOutcome: n.routeOutcome,
            resultRefs: n.resultRefs,
            routedAt: iso(n.routedAt),
          }
        : null,
    };
  });
}

export function traceIntakeReceipt(businessId: number, receiptId: number, now: Date = new Date()) {
  return traceWhere(businessId, { id: receiptId }, now);
}

/** Look an event up by the provider's own identity, keyed as the adapter keyed it. */
export function traceIntakeByProviderEvent(
  businessId: number,
  sourceKey: string,
  identity: EventIdentityInput,
  now: Date = new Date()
) {
  const { externalEventId } = deriveEventIdentity(identity);
  return traceWhere(businessId, { sourceKey, externalEventId }, now);
}
