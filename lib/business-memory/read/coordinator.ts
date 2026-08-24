/**
 * Business Memory READ-3 · Read Coordinator — implementation (inert, fail-open, read-only).
 *
 * Sequencing: incumbent FIRST → normalize → resolve exact vendor-category/v1 → read Claim (R1) →
 * for a supported Claim ONLY, S2 read-time freshness (compare current evidence identity fingerprint to
 * the Projection's). Anything that is not `supported + fresh` → fall back to the incumbent. The MEMORY
 * augmentation NEVER throws and NEVER changes the product decision: `effective === incumbent` ALWAYS.
 *
 * S2 is READ-ONLY: it reads the canonical evidence identity and compares — no re-derive, no write, no
 * materialization, no retry. Not consulted for absent/conflicting/invalid/unavailable (no needless read).
 *
 * INERT: 0 production callers, no BUSINESS_MEMORY_READ, no product wiring, no read-switch. Defaults wire
 * the real collaborators but nothing calls this coordinator.
 */
import { prisma } from "@/lib/prisma";
import { decideCategory } from "@/lib/services/documents/category-decision.service";
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import { resolveVendorCategoryPolicyVersion } from "@/lib/business-memory/policy";
import { createReviewEventEvidenceReader, type DomainLocalSubject } from "@/lib/business-memory/evidence";
import { readClaim } from "./claim-reader";
import type { ClaimReaderClient } from "./read-claim.contract";
import type {
  CoordinatorDeps,
  CoordinatorInput,
  CoordinatorObservation,
  MemoryOutcome,
  ResolvedPolicyIdentity,
  VendorCategoryDecision,
} from "./coordinator.contract";

const CLAIM_TYPE = "vendor-category" as const;

/** Real collaborators. Imports no writer/deriver/materialization/shadow — read-only by construction. */
export function defaultCoordinatorDeps(): CoordinatorDeps {
  const evidenceReader = createReviewEventEvidenceReader();
  return {
    decideCategory: (businessId, vendorName, text) => decideCategory(businessId, vendorName, text),
    normalize: (vendorName) => ({ normalizedKey: normalizeVendorForLearning(vendorName).normalizedKey }),
    resolvePolicyVersion: () => resolveVendorCategoryPolicyVersion(),
    readClaim: (query) => readClaim(query, prisma as unknown as ClaimReaderClient),
    readEvidenceIdentity: async (businessId, subject) => ({
      fingerprint: (await evidenceReader.readOwnerDecisionEvidence(businessId, subject)).identity.fingerprint,
    }),
  };
}

/**
 * Combine incumbent + Business Memory into a comparison-ready, fail-open decision.
 * `effective` is ALWAYS the incumbent in READ-3. The memory augmentation never throws.
 */
export async function resolveVendorCategoryWithMemory(
  input: CoordinatorInput,
  deps: CoordinatorDeps = defaultCoordinatorDeps(),
): Promise<VendorCategoryDecision> {
  const { businessId, vendorName, text } = input;

  // Incumbent FIRST. Its own errors propagate unchanged — the coordinator introduces NO new failure mode
  // (this is byte-equivalent to a caller invoking the incumbent directly). Everything after is guarded.
  const incumbent = await deps.decideCategory(businessId, vendorName, text);

  const decide = (memory: MemoryOutcome, observation: CoordinatorObservation): VendorCategoryDecision => ({
    incumbent,
    memory,
    effective: incumbent, // READ-3 invariant: never the memory candidate.
    observation,
  });
  const obs = (
    outcome: CoordinatorObservation["outcome"],
    fallbackReason: CoordinatorObservation["fallbackReason"],
    policy?: ResolvedPolicyIdentity,
    fingerprintMatch?: boolean,
  ): CoordinatorObservation => ({
    businessId,
    claimType: CLAIM_TYPE,
    ...(policy ? { policyKey: policy.policyKey, versionLabel: policy.versionLabel, policyVersionId: policy.policyVersionId } : {}),
    outcome,
    fallbackReason,
    ...(fingerprintMatch === undefined ? {} : { fingerprintMatch }),
  });

  try {
    if (!Number.isInteger(businessId) || businessId <= 0) {
      return decide({ status: "unavailable", fallbackReason: "unexpected" }, obs("fallback", "unexpected"));
    }

    const normalizedKey = (deps.normalize(vendorName)?.normalizedKey ?? "").trim();
    if (normalizedKey.length === 0) {
      return decide({ status: "unavailable", fallbackReason: "unavailable" }, obs("fallback", "unavailable"));
    }

    let policy: ResolvedPolicyIdentity;
    try {
      policy = await deps.resolvePolicyVersion();
    } catch {
      return decide({ status: "unavailable", fallbackReason: "resolver-failure" }, obs("fallback", "resolver-failure"));
    }

    const claim = await deps.readClaim({
      businessId,
      subjectDomain: "vendor",
      subjectNormalizedKey: normalizedKey,
      claimType: CLAIM_TYPE,
      policyVersionId: policy.policyVersionId,
    });

    switch (claim.status) {
      case "absent":
        return decide({ status: "absent", fallbackReason: "absent" }, obs("fallback", "absent", policy));
      case "invalid":
        return decide({ status: "invalid", fallbackReason: "invalid" }, obs("fallback", "invalid", policy));
      case "unavailable":
        return decide({ status: "unavailable", fallbackReason: "unavailable" }, obs("fallback", "unavailable", policy));
      case "conflicting":
        return decide(
          { status: "conflicting", candidates: claim.candidates, fallbackReason: "conflicting" },
          obs("fallback", "conflicting", policy),
        );
      case "supported": {
        // S2 freshness — read-only, only for a supported Claim.
        const subject: DomainLocalSubject = { domain: "vendor", normalizedKey, businessId };
        let currentFingerprint: string;
        try {
          currentFingerprint = (await deps.readEvidenceIdentity(businessId, subject)).fingerprint;
        } catch {
          return decide({ status: "unavailable", fallbackReason: "evidence-failure" }, obs("fallback", "evidence-failure", policy));
        }
        const fresh = currentFingerprint === claim.evidenceSetFingerprint;
        if (fresh) {
          return decide(
            { status: "supported", category: claim.category, fresh: true, fallbackReason: null },
            obs("memory-available", null, policy, true),
          );
        }
        return decide(
          { status: "supported", category: claim.category, fresh: false, fallbackReason: "stale" },
          obs("fallback", "stale", policy, false),
        );
      }
      default:
        return decide({ status: "unavailable", fallbackReason: "unexpected" }, obs("fallback", "unexpected", policy));
    }
  } catch {
    // Any unexpected error in the memory path degrades to the incumbent — never throws.
    return decide({ status: "unavailable", fallbackReason: "unexpected" }, obs("fallback", "unexpected"));
  }
}
