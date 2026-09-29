/**
 * Business Intake · the IntakeNormalizedEvent store — the ONE writer of what
 * Dubiz understood from a receipt. Every function runs in a tenant transaction:
 * FORCE RLS decides which rows exist, and the composite (businessId,
 * intakeEventId) key makes a cross-tenant reference impossible in the schema.
 *
 * Idempotent by construction: one record per receipt (unique intakeEventId);
 * a retry reads and reuses it instead of adding a second.
 *
 * PRIVACY. `contactHints` is personal data. It is purged when the event
 * completes unless the identity outcome is 'unresolved' (M4 needs the hints to
 * propose a link to the owner), and by account erasure. Nothing else here
 * carries a contact value or message content.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { NormalizedIntake, ResultRefs, RouteTarget } from "./contract";

export type StoredNormalized = {
  id: number;
  identityOutcome: string;
  routeTarget: string | null;
  routeOutcome: string | null;
  resultRefs: Prisma.JsonValue | null;
};

const SELECT = {
  id: true,
  identityOutcome: true,
  routeTarget: true,
  routeOutcome: true,
  resultRefs: true,
} as const;

export async function findNormalized(businessId: number, intakeEventId: number): Promise<StoredNormalized | null> {
  return withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.findFirst({ where: { businessId, intakeEventId }, select: SELECT })
  );
}

/**
 * Record the normalization of one receipt. A concurrent or repeated call keeps
 * the FIRST record (ON CONFLICT DO NOTHING on intakeEventId) and returns it.
 */
export async function saveNormalized(
  businessId: number,
  intakeEventId: number,
  normalizerVersion: string,
  n: NormalizedIntake
): Promise<StoredNormalized> {
  return withTenantTransaction(async (tx) => {
    await tx.intakeNormalizedEvent.createMany({
      data: [
        {
          businessId,
          intakeEventId,
          normalizerVersion,
          occurredAt: n.occurredAt,
          contactHints: n.contactHints ? (n.contactHints as Prisma.InputJsonValue) : Prisma.DbNull,
          signals: n.signals as Prisma.InputJsonValue,
          identityOutcome: n.identity,
          attribution: n.attribution ? (n.attribution as Prisma.InputJsonValue) : Prisma.DbNull,
          routeTarget: n.target,
        },
      ],
      skipDuplicates: true,
    });
    const row = await tx.intakeNormalizedEvent.findFirst({ where: { businessId, intakeEventId }, select: SELECT });
    if (!row) throw new Error("intake: normalized record not visible after insert");
    return row;
  });
}

export async function recordRouteOutcome(
  businessId: number,
  intakeEventId: number,
  outcome: "routed" | "ignored",
  refs: ResultRefs | undefined,
  now: Date
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.updateMany({
      where: { businessId, intakeEventId },
      data: {
        routeOutcome: outcome,
        routedAt: now,
        ...(refs && Object.keys(refs).length ? { resultRefs: refs as Prisma.InputJsonValue } : {}),
      },
    })
  );
}

/**
 * Drop the contact hints once the event is done — unless M4 still needs them
 * ('unresolved'). Returns whether anything was purged.
 */
export async function purgeContactHintsIfResolved(
  businessId: number,
  intakeEventId: number,
  now: Date,
  /** M4: a core destination decided identity and materialised the event — the
   *  hints are now only a duplicate of what the domain records hold. */
  opts: { identityDecided?: boolean } = {}
): Promise<boolean> {
  const res = await withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.updateMany({
      where: {
        businessId,
        intakeEventId,
        ...(opts.identityDecided ? {} : { identityOutcome: { not: "unresolved" } }),
        contactHintsPurgedAt: null,
      },
      data: { contactHints: Prisma.DbNull, contactHintsPurgedAt: now },
    })
  );
  return res.count > 0;
}

// ─── M4: identity + routing evidence (historical, per event) ───────────────

type IdentityFields = {
  state: string;
  policyVersion: string;
  customerId: number | null;
  candidates: Array<{ customerId: number }>;
  evidence: Record<string, unknown>;
};
type DecisionFields = { rule: string; destination: RouteTarget; ownerReviewRequired: boolean };

/** What M4 concluded at decision time. Categories only — never identifier values. */
export async function recordIdentityDecision(
  businessId: number,
  intakeEventId: number,
  identity: IdentityFields,
  decision: DecisionFields
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.updateMany({
      // A destination that already recorded its authoritative conclusion (a
      // retry after commit) keeps it: only a not-yet-routed record is written.
      where: { businessId, intakeEventId, routeOutcome: null, resultRefs: { equals: Prisma.DbNull } },
      data: {
        identityState: identity.state,
        identityPolicyVersion: identity.policyVersion,
        identityCustomerId: identity.state === "resolved" ? identity.customerId : null,
        identityEvidence: identity.evidence as Prisma.InputJsonValue,
        identityCandidateCount: identity.candidates.length,
        routingRule: decision.rule,
        routingDestination: decision.destination,
        ownerReviewRequired: decision.ownerReviewRequired,
      },
    })
  );
}

/**
 * An adapter-executed destination that created / found the contact itself
 * (WhatsApp's M2 path: phone → Customer) — record the Customer it resolved to.
 */
export async function finalizeIdentityFromRefs(
  businessId: number,
  intakeEventId: number,
  identity: IdentityFields,
  refs: ResultRefs | undefined
): Promise<void> {
  const customerId = refs?.customerId;
  if (typeof customerId !== "number" || identity.state === "resolved") return;
  if (identity.state !== "unresolved") return; // never "upgrade" an uncertain state silently
  await withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.updateMany({
      where: { businessId, intakeEventId, identityState: "unresolved" },
      data: {
        identityState: "resolved",
        identityCustomerId: customerId,
        identityEvidence: { ...identity.evidence, createdByDestination: true } as Prisma.InputJsonValue,
      },
    })
  );
}

export async function readIdentityDecision(businessId: number, intakeEventId: number) {
  return withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.findFirst({
      where: { businessId, intakeEventId },
      select: {
        identityState: true,
        identityPolicyVersion: true,
        identityEvidence: true,
        identityCandidateCount: true,
        routingRule: true,
        routingDestination: true,
      },
    })
  );
}

export function isRouteTarget(value: unknown): value is RouteTarget {
  return typeof value === "string" && ROUTE_TARGET_SET.has(value);
}
const ROUTE_TARGET_SET = new Set<string>([
  "conversation",
  "message_status",
  "lead",
  "customer",
  "commerce",
  "document",
  "attention",
  "none",
]);
