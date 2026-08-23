/**
 * Business Memory · SHADOW-COMPARISON-2 · Dry-run comparison CORE (pure, DB-free).
 *
 * Runs the REAL Business Memory read/derive stages on a tenant's ReviewEvent rows and compares the
 * engine's derived candidates/state against an INDEPENDENT "expected truth" computed directly from the
 * owner-decision evidence predicate (owner acted on category with a non-empty final value). It calls:
 *
 *   mapReviewEvent (real) -> projectOwnerDecisionEvidence (real reader core) -> deriveVendorCategory (real deriver)
 *
 * It NEVER writes, never touches the claim writer / orchestrator, and never calls materializeClaim. The
 * expected side is NOT a second call to the deriver — it is a plain, auditable scan of the evidence, so a
 * PASS means two independent computations agree.
 *
 * Pure: no Prisma, no I/O. The DB read + read-only enforcement live in the sibling runner.
 */
import {
  projectOwnerDecisionEvidence,
  mapReviewEvent,
  type ReviewEventRow,
  type OwnerDecisionEvidence,
  type DomainLocalSubject,
  type EvidenceRef,
} from "@/lib/business-memory/evidence";
import { deriveVendorCategory, type DerivedClaimState } from "@/lib/business-memory/derivation";

export type Classification =
  | "PASS"
  | "MISMATCH"
  | "CONFLICT_EXPECTED"
  | "INSUFFICIENT_EXPECTED";

export type ResolvedPolicy = {
  readonly policyKey: string;
  readonly versionLabel: string;
  readonly policyVersionId: number;
};

export type ComparisonRow = {
  readonly businessId: number;
  readonly normalizedSubject: string;
  readonly policyKey: string;
  readonly versionLabel: string;
  readonly policyVersionId: number;
  readonly evidenceRefs: string[]; // "review-event:businessId:recordId"
  readonly evidenceCount: number;
  readonly evidenceFingerprint: string;
  // EXPECTED (independent, traceable directly to owner-decision evidence — NOT the deriver):
  readonly expectedQualifyingCategories: string[]; // distinct, sorted by value
  readonly expectedState: DerivedClaimState;
  readonly qualifyingByCategory: { category: string; verdicts: string[]; refCount: number }[];
  readonly nonSupportingCount: number;
  // ACTUAL (the real vendor-category deriver):
  readonly actualCandidates: string[]; // proposition values, sorted by value
  readonly actualState: DerivedClaimState;
  readonly actualCandidateRefCounts: { category: string; refCount: number }[];
  // comparison verdict:
  readonly classification: Classification;
};

const refKey = (r: EvidenceRef): string => `${r.kind}:${r.businessId}:${r.recordId}`;

/**
 * INDEPENDENT expected truth: the owner "supports" a category iff the owner ACTED on it
 * (verdict confirmed|corrected) with a non-empty final value. This mirrors the OWNER-DECISION rule
 * directly from evidence — it does not invoke the deriver.
 */
function supportedCategoryOf(e: OwnerDecisionEvidence): string | null {
  const acted = e.verdicts.category === "confirmed" || e.verdicts.category === "corrected";
  if (!acted) return null;
  const value = (e.ownerFinal.category ?? "").trim();
  return value.length > 0 ? value : null;
}

function expectedStateFor(distinctCategories: number): DerivedClaimState {
  if (distinctCategories >= 2) return "conflicting";
  if (distinctCategories === 1) return "supported";
  return "insufficient";
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/**
 * Compute one comparison row for a single subject, given the tenant's rows.
 * `subject.businessId` MUST equal `businessId` (the reader rejects a cross-tenant subject).
 */
export function compareSubject(
  rows: readonly ReviewEventRow[],
  subject: DomainLocalSubject,
  policy: ResolvedPolicy,
): ComparisonRow {
  const set = projectOwnerDecisionEvidence(rows, subject); // real reader core (filter + order + identity)

  // EXPECTED — independent scan.
  const byCategory = new Map<string, { verdicts: Set<string>; refs: EvidenceRef[] }>();
  let nonSupporting = 0;
  for (const e of set.items) {
    const value = supportedCategoryOf(e);
    if (value == null) {
      nonSupporting++;
      continue;
    }
    const entry = byCategory.get(value) ?? { verdicts: new Set<string>(), refs: [] };
    entry.verdicts.add(e.verdicts.category);
    entry.refs.push(e.ref);
    byCategory.set(value, entry);
  }
  const expectedQualifyingCategories = [...byCategory.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const qualifyingByCategory = expectedQualifyingCategories.map((category) => ({
    category,
    verdicts: [...(byCategory.get(category) as { verdicts: Set<string> }).verdicts].sort(),
    refCount: (byCategory.get(category) as { refs: EvidenceRef[] }).refs.length,
  }));
  const expectedState = expectedStateFor(expectedQualifyingCategories.length);

  // ACTUAL — the real deriver.
  const derived = deriveVendorCategory(set, policy.policyVersionId);
  const actualCandidates = derived.candidates
    .map((c) => c.propositionValue)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const actualCandidateRefCounts = derived.candidates
    .map((c) => ({ category: c.propositionValue, refCount: c.supportingRefs.length }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  // Comparison.
  const matches =
    setEqual(actualCandidates, expectedQualifyingCategories) &&
    derived.state === expectedState;
  let classification: Classification;
  if (!matches) classification = "MISMATCH";
  else if (expectedQualifyingCategories.length === 0) classification = "INSUFFICIENT_EXPECTED";
  else if (expectedQualifyingCategories.length >= 2) classification = "CONFLICT_EXPECTED";
  else classification = "PASS";

  return {
    businessId: subject.businessId,
    normalizedSubject: subject.normalizedKey,
    policyKey: policy.policyKey,
    versionLabel: policy.versionLabel,
    policyVersionId: policy.policyVersionId,
    evidenceRefs: set.identity.refs.map(refKey),
    evidenceCount: set.items.length,
    evidenceFingerprint: set.identity.fingerprint,
    expectedQualifyingCategories,
    expectedState,
    qualifyingByCategory,
    nonSupportingCount: nonSupporting,
    actualCandidates,
    actualState: derived.state,
    actualCandidateRefCounts,
    classification,
  };
}

/**
 * Compute comparison rows for every distinct vendor subject in a tenant's rows (optionally filtered to
 * a single normalized subject). Distinct subjects are discovered via the REAL mapper, so grouping and
 * derivation use one consistent normalization — no SQL/TS mismatch is possible here.
 */
export function compareTenant(
  rows: readonly ReviewEventRow[],
  businessId: number,
  policy: ResolvedPolicy,
  opts: { subjectFilter?: string | null; maxSubjects?: number } = {},
): { rows: ComparisonRow[]; totalSubjects: number; truncated: boolean } {
  const mapped = rows.map(mapReviewEvent);
  let keys = [...new Set(mapped.map((m) => m.subject.normalizedKey))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const filter = (opts.subjectFilter ?? "").trim();
  if (filter.length > 0) keys = keys.filter((k) => k === filter);

  const totalSubjects = keys.length;
  const cap = opts.maxSubjects ?? 500;
  const truncated = totalSubjects > cap;
  const selected = truncated ? keys.slice(0, cap) : keys;

  const out = selected.map((normalizedKey) =>
    compareSubject(rows, { domain: "vendor", normalizedKey, businessId }, policy),
  );
  return { rows: out, totalSubjects, truncated };
}
