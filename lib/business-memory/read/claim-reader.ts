/**
 * Business Memory READ-2 (R1) · Claim Reader — implementation (inert, read-only).
 *
 * Reads ONE DerivedClaimProjection by its FULL 5-tuple identity and classifies its intrinsic state. It:
 *   - looks up ONLY by (businessId, subjectDomain, subjectNormalizedKey, claimType, policyVersionId) —
 *     never by subject alone, never without businessId, never findFirst, never current/latest;
 *   - is NOT a resolver (policyVersionId is a required, already-resolved input);
 *   - is non-throwing (any client/DB error → `unavailable`);
 *   - reads only — the injected client type cannot express a write;
 *   - does NOT read Evidence, does NOT derive, does NOT materialize, has NO VendorLearning/fallback,
 *     NO confidence/score/ranking/recommendation, NO staleness (that needs current evidence → coordinator).
 *
 * INERT / UNWIRED: no product/API/route consumer imports this.
 */
import type {
  ClaimReaderClient,
  ReadClaimQuery,
  ReadClaimResult,
} from "./read-claim.contract";

/** True for a positive, safe integer. */
function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/**
 * Read a single Business Memory Claim by full identity. Never throws; returns a typed result.
 * `client` is REQUIRED and narrow (read-only by type) — the reader binds no Prisma/DB of its own.
 */
export async function readClaim(
  query: ReadClaimQuery,
  client: ClaimReaderClient,
): Promise<ReadClaimResult> {
  // Fail-closed, typed input validation — a malformed identity can never widen the lookup.
  if (!isPositiveInt(query?.businessId)) {
    return { status: "unavailable", detail: "invalid query: businessId must be a positive integer" };
  }
  if (query.subjectDomain !== "vendor") {
    return { status: "unavailable", detail: "invalid query: subjectDomain must be 'vendor'" };
  }
  if (typeof query.subjectNormalizedKey !== "string" || query.subjectNormalizedKey.length === 0) {
    return { status: "unavailable", detail: "invalid query: subjectNormalizedKey must be a non-empty string" };
  }
  if (query.claimType !== "vendor-category") {
    return { status: "unavailable", detail: "invalid query: claimType must be 'vendor-category'" };
  }
  if (!isPositiveInt(query.policyVersionId)) {
    return { status: "unavailable", detail: "invalid query: policyVersionId must be a positive integer" };
  }

  let row;
  try {
    row = await client.derivedClaimProjection.findUnique({
      where: {
        businessId_subjectDomain_subjectNormalizedKey_claimType_policyVersionId: {
          businessId: query.businessId,
          subjectDomain: query.subjectDomain,
          subjectNormalizedKey: query.subjectNormalizedKey,
          claimType: query.claimType,
          policyVersionId: query.policyVersionId,
        },
      },
      select: {
        evidenceSetFingerprint: true,
        candidates: { select: { propositionValue: true, _count: { select: { evidenceLinks: true } } } },
      },
    });
  } catch (e) {
    return { status: "unavailable", detail: e instanceof Error ? e.message : "claim lookup failed" };
  }

  // No Projection for this exact identity → nothing materialized here.
  if (row == null) {
    return { status: "absent" };
  }

  const candidates = row.candidates ?? [];

  // A persisted Projection ALWAYS carries >=1 candidate (the writer deletes the slot for
  // insufficient/withdrawn). Zero candidates on a persisted row is a structural anomaly.
  if (candidates.length === 0) {
    return { status: "invalid", detail: "persisted projection has zero candidates" };
  }

  // Exactly one candidate → a single supported category. ONLY here do we return a category.
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      status: "supported",
      category: only.propositionValue,
      candidateRefCount: only._count?.evidenceLinks ?? 0,
      evidenceSetFingerprint: row.evidenceSetFingerprint,
    };
  }

  // Two or more candidates → a candidate-set conflict. We return ALL values and pick NO winner.
  // Sorted for STABLE OUTPUT ONLY (value order, never precedence).
  const values = candidates
    .map((c) => c.propositionValue)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { status: "conflicting", candidates: values, evidenceSetFingerprint: row.evidenceSetFingerprint };
}
