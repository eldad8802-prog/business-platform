/**
 * Business Memory IMPL-3 · vendor-category Derivation Policy v1 (PURE RULE).
 *
 * The FIRST derivation policy — scope is EXACTLY vendor→category (no generic framework, no other
 * domain). It turns the owner-decision evidence for a vendor subject into candidate category
 * propositions + a derived state. Pure: no DB, no clock, no random, no env, no VendorLearning, no RIA,
 * no C1, no network. Deterministic: same admissible evidence → same candidates in the same order.
 *
 * CONFLICT SEMANTICS (the central decision — Claim pre-impl §8; chosen: A · candidate-set):
 *   Every DISTINCT category value that received owner support stays a candidate. No majority, no
 *   recency, no threshold — none of those, because each silently PICKS A WINNER and smuggles hidden
 *   precedence (INV-8; Claim pre-impl §5/§6). Candidate-set is the only rule that preserves the
 *   owner's full signal, keeps conflict explainable, and never resolves it inside memory (Contract §6/§8).
 *
 * QUALIFYING SUPPORT (INV-4 — silence is not approval):
 *   An owner-decision evidence item supports category C iff its owner-final category === C (non-empty)
 *   AND the owner ACTED on category (verdict ∈ {confirmed, corrected}). `not-submitted` / `rejected` /
 *   null category contribute NO support. Category values are matched EXACTLY (whitespace-trimmed, NOT
 *   case-folded) — no dedup/merge heuristic (Claim pre-impl §7).
 *
 * DUPLICATES (Claim pre-impl §7): each qualifying ReviewEvent is a real owner decision → a unit of
 *   support. Duplicates add supporting refs to the SAME candidate; they never create new candidates
 *   and are never dedup'd away. The support count is an explanation input, never confidence (§10).
 */
import type { EvidenceRef, OwnerDecisionEvidence } from "@/lib/business-memory/evidence";
import type { DerivedClaimCandidate, DerivedClaimState, DeriveOptions } from "./claim-candidate.contract";

export const VENDOR_CATEGORY_POLICY_NAME = "vendor-category" as const;

/** An owner-decision item supports a category iff the owner acted on it with a non-empty final value. */
function supportedCategory(e: OwnerDecisionEvidence): string | null {
  const acted = e.verdicts.category === "confirmed" || e.verdicts.category === "corrected";
  if (!acted) return null;
  const value = (e.ownerFinal.category ?? "").trim();
  return value.length > 0 ? value : null;
}

function refKey(r: EvidenceRef): string {
  return `${r.kind}:${r.businessId}:${r.recordId}`;
}

/**
 * Apply the vendor-category rule to a subject's owner-decision evidence items (already tenant- and
 * subject-scoped, in the adapter's canonical order). Returns candidates (ordered by proposition value)
 * + the derived state. `erasedRefs` excludes evidence from support and enables `withdrawn` (§8).
 */
export function deriveVendorCategoryCandidates(
  items: readonly OwnerDecisionEvidence[],
  options: DeriveOptions = {},
): { candidates: DerivedClaimCandidate[]; state: DerivedClaimState } {
  const erased = new Set((options.erasedRefs ?? []).map(refKey));

  // Group ALL qualifying support (pre-erasure) and admissible support (post-erasure) by category value.
  const qualifyingValues = new Set<string>();
  const byValue = new Map<string, EvidenceRef[]>();

  for (const e of items) {
    const value = supportedCategory(e);
    if (value == null) continue;
    qualifyingValues.add(value);
    if (erased.has(refKey(e.ref))) continue; // erased evidence contributes no support
    const list = byValue.get(value) ?? [];
    list.push(e.ref);
    byValue.set(value, list);
  }

  // Candidates: one per distinct admissible value, ordered deterministically by proposition value
  // (value-based order — NOT support count, which would imply ranking/precedence).
  const candidates: DerivedClaimCandidate[] = [...byValue.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((propositionValue) => ({
      claimType: VENDOR_CATEGORY_POLICY_NAME,
      propositionValue,
      supportingRefs: byValue.get(propositionValue) as EvidenceRef[],
    }));

  let state: DerivedClaimState;
  if (candidates.length >= 2) state = "conflicting";
  else if (candidates.length === 1) state = "supported";
  else if (qualifyingValues.size > 0) state = "withdrawn"; // had support, erased away
  else state = "insufficient";

  return { candidates, state };
}
