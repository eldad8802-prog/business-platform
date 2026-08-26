/**
 * Business Memory IMPL-2 · Owner-Decision Evidence READER (adapter implementation).
 *
 * Implements OwnerDecisionEvidenceReader over `ReviewEvent`. The physical knowledge lives entirely in
 * ./review-event.mapper; this file adds tenant-scoped fetch + deterministic ordering + evidence-set
 * identity. The row source is INJECTABLE (default binds Prisma) so the core logic — map, filter,
 * order, identity — is pure and DB-free-testable (IMPL-2 §14).
 *
 * INERT: nothing in the product imports this yet (IMPL-2 §15). Reading is read-only; there is no
 * writer, no Claim, no confidence, no policy, no VendorLearning coupling, no RIA/C1 activation.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: ctx-aware short tenant tx per DB step (no global fallback under
// an established context; direct reads only for context-less unit tests).
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import type {
  DomainLocalSubject,
  EvidenceRef,
  EvidenceSetIdentity,
  OwnerDecisionEvidence,
  OwnerDecisionEvidenceReader,
  OwnerDecisionEvidenceSet,
} from "./evidence-contract";
import { mapReviewEvent, matchesSubject, type ReviewEventRow } from "./review-event.mapper";

/** Fetches raw ReviewEvent rows for ONE tenant. Injectable so the reader is testable without a DB. */
export type ReviewEventRowSource = (businessId: number) => Promise<ReviewEventRow[]>;

/** Default row source: tenant-filtered Prisma read, selecting only the fields the mapper needs. */
const prismaRowSource: ReviewEventRowSource = async (businessId) => {
  const rows = await dbStep((db) => db.reviewEvent.findMany({
    where: { businessId },
    select: {
      id: true,
      businessId: true,
      occurredAt: true,
      vendorFinal: true,
      directionFinal: true,
      verdicts: true,
    },
  }));
  return rows as ReviewEventRow[];
};

/**
 * The single canonical ordering this layer guarantees: occurredAt ascending, then the append-only
 * record id (ordinal) ascending as a total-order tiebreaker for equal timestamps (IMPL-2 §8/§9).
 * This is ORDER, not precedence — no item "wins".
 */
function canonicalOrder(a: OwnerDecisionEvidence, b: OwnerDecisionEvidence): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.ordinal - b.ordinal;
}

/** Build the deterministic evidence-set identity. `fingerprint` is a digest of refs — equality only, not authority. */
function buildIdentity(items: readonly OwnerDecisionEvidence[]): EvidenceSetIdentity {
  const refs: EvidenceRef[] = items.map((i) => i.ref);
  const fingerprint = refs.map((r) => `${r.kind}:${r.businessId}:${r.recordId}`).join("|");
  return { refs, ordering: "occurredAt-asc,ordinal-asc", fingerprint };
}

/**
 * Pure core: given raw rows for a tenant + a subject, produce the deterministic owner-decision
 * evidence set. Exposed for tests; the store-bound reader below is a thin wrapper.
 */
export function projectOwnerDecisionEvidence(
  rows: readonly ReviewEventRow[],
  subject: DomainLocalSubject,
): OwnerDecisionEvidenceSet {
  const items = rows
    .map(mapReviewEvent)
    .filter((e) => matchesSubject(e, subject))
    .sort(canonicalOrder);
  return { subject, items, identity: buildIdentity(items) };
}

/** Construct an OwnerDecisionEvidenceReader over a row source (default: Prisma over ReviewEvent). */
export function createReviewEventEvidenceReader(
  rowSource: ReviewEventRowSource = prismaRowSource,
): OwnerDecisionEvidenceReader {
  return {
    async readOwnerDecisionEvidence(businessId, subject) {
      // Tenant comes from the call context (businessId arg), never from a payload. The subject's own
      // businessId must match — a cross-tenant read is not representable.
      if (subject.businessId !== businessId) {
        throw new Error(
          "[business-memory/evidence] cross-tenant read rejected: subject.businessId !== businessId",
        );
      }
      const rows = await rowSource(businessId);
      return projectOwnerDecisionEvidence(rows, subject);
    },
  };
}
