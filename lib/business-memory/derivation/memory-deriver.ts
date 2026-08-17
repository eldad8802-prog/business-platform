/**
 * Business Memory IMPL-3 · Memory Deriver (PURE orchestration).
 *
 * Applies a PINNED derivation-policy version to a subject's owner-decision evidence set → a
 * DerivedClaimResult (candidates + state). This is Architecture component [3] "Memory Deriver": it
 * does not read evidence itself (the Evidence Adapter did) and it does not persist anything.
 *
 * Pure/deterministic/inert: no DB, no clock, no random, no env, no VendorLearning, no RIA, no C1, no
 * network, no writer, no read-switch. 0 product consumers.
 *
 * POLICY-VERSION PINNING (INV-2; Claim pre-impl §11): the caller passes an explicit
 * `policyVersionId`. There is NO current/latest/default/implicit version lookup here. Mapping the one
 * v1 claimType to its policy FUNCTION is code identity, not version selection — the version identity
 * the function represents is supplied by the caller and echoed into the result.
 */
import type { OwnerDecisionEvidenceSet } from "@/lib/business-memory/evidence";
import type { DerivedClaimResult, DeriveOptions } from "./claim-candidate.contract";
import { deriveVendorCategoryCandidates, VENDOR_CATEGORY_POLICY_NAME } from "./vendor-category.policy";

/**
 * Derive vendor-category Business Memory for ONE subject under ONE pinned policy version.
 * `evidenceSet` comes from the Evidence Adapter (tenant- and subject-scoped, canonically ordered).
 */
export function deriveVendorCategory(
  evidenceSet: OwnerDecisionEvidenceSet,
  policyVersionId: number,
  options: DeriveOptions = {},
): DerivedClaimResult {
  if (!Number.isInteger(policyVersionId) || policyVersionId <= 0) {
    // An explicit, valid policy-version identity is REQUIRED — no implicit/default version (INV-2).
    throw new Error("[business-memory/derivation] a valid pinned policyVersionId is required");
  }
  const { candidates, state } = deriveVendorCategoryCandidates(evidenceSet.items, options);
  return {
    subject: evidenceSet.subject,
    claimType: VENDOR_CATEGORY_POLICY_NAME,
    policyVersionId,
    evidenceSetIdentity: evidenceSet.identity,
    state,
    candidates,
  };
}
