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
  now: Date
): Promise<boolean> {
  const res = await withTenantTransaction((tx) =>
    tx.intakeNormalizedEvent.updateMany({
      where: {
        businessId,
        intakeEventId,
        identityOutcome: { not: "unresolved" },
        contactHintsPurgedAt: null,
      },
      data: { contactHints: Prisma.DbNull, contactHintsPurgedAt: now },
    })
  );
  return res.count > 0;
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
