/**
 * Business Memory IMPL-6A · Single-Pass Orchestrator (inert, best-effort G1, S1 stale).
 *
 * For ONE trusted tenant + vendor subject:
 *   resolve VENDOR_CATEGORY_POLICY (once) → read owner-decision evidence A → derive(A, policyVersionId)
 *   → re-read owner-decision evidence B → if identity(A) == identity(B) write once, else return `stale`.
 *
 * Guarantees (Orchestrator pre-impl v1, owner-ratified G1/S1/O1): a result is written only when the
 * canonical evidence-set identity used for derivation still matches a final pre-write read. It does NOT
 * guarantee linearizability and does NOT close the final-read→write TOCTOU window (§17): a transient
 * stale projection is acceptable here because Claims are a derived, rebuildable, non-authoritative cache
 * with no product reader. No retry, no lock, no compare-and-write, no timestamp heuristic.
 *
 * INERT: no product trigger, no VendorLearning, no recommendation. All collaborators are injected
 * (defaults bind the real components); the Orchestrator adds no derivation/selection/confidence logic.
 */
import { vendorSubject } from "@/lib/business-memory/evidence";
import { createReviewEventEvidenceReader } from "@/lib/business-memory/evidence";
import { resolveVendorCategoryPolicyVersion } from "@/lib/business-memory/policy";
import { deriveVendorCategory } from "@/lib/business-memory/derivation";
import { materializeClaim, MaterializationRejected } from "@/lib/business-memory/materialization";
import { PolicyResolutionFailed } from "@/lib/business-memory/policy";
import { evidenceIdentityEquals } from "./evidence-identity";
import type {
  OrchestratorDeps,
  OrchestratorInput,
  OrchestratorOutcome,
  OrchestratorPolicyIdentity,
} from "./orchestrator.contract";

/** Bind the real merged components as the default collaborators. */
export function defaultOrchestratorDeps(): OrchestratorDeps {
  const reader = createReviewEventEvidenceReader();
  return {
    resolvePolicyVersion: () => resolveVendorCategoryPolicyVersion(),
    readOwnerDecisionEvidence: (businessId, subject) => reader.readOwnerDecisionEvidence(businessId, subject),
    deriveClaim: (evidenceSet, policyVersionId) => deriveVendorCategory(evidenceSet, policyVersionId),
    writeClaim: (command) => materializeClaim(command),
  };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run one single-pass vendor-category orchestration. Returns a typed OrchestratorOutcome; expected
 * failures are surfaced as `failed` outcomes (never swallowed), not thrown.
 */
export async function runVendorCategoryOrchestration(
  input: OrchestratorInput,
  deps: OrchestratorDeps = defaultOrchestratorDeps(),
): Promise<OrchestratorOutcome> {
  const { businessId } = input;

  // 1) Trusted tenant + canonical subject (no client-controlled authority; no duplicated normalization).
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return { kind: "failed", stage: "tenant-subject", message: "businessId must be a positive integer" };
  }
  const subject = vendorSubject(businessId, input.vendorInput);

  // 2) Resolve the governed policy binding — once, up front (fail fast; no current/latest).
  let policyIdentity: OrchestratorPolicyIdentity;
  try {
    const resolved = await deps.resolvePolicyVersion();
    policyIdentity = {
      policyKey: resolved.policyKey,
      versionLabel: resolved.versionLabel,
      policyVersionId: resolved.policyVersionId,
    };
  } catch (e) {
    return { kind: "failed", stage: "policy-resolution", message: msg(e) };
  }

  // 3) First owner-decision evidence read.
  let evidenceA;
  try {
    evidenceA = await deps.readOwnerDecisionEvidence(businessId, subject);
  } catch (e) {
    return { kind: "failed", stage: "evidence-read-first", message: msg(e) };
  }

  // 4) Derive (pure; the Orchestrator interprets nothing).
  let result;
  try {
    result = deps.deriveClaim(evidenceA, policyIdentity.policyVersionId);
  } catch (e) {
    return { kind: "failed", stage: "derivation", message: msg(e) };
  }

  // 5) Second (freshness) read.
  let evidenceB;
  try {
    evidenceB = await deps.readOwnerDecisionEvidence(businessId, subject);
  } catch (e) {
    return { kind: "failed", stage: "evidence-read-second", message: msg(e) };
  }

  // 6) Freshness = F3 canonical identity equality (refs+ordering; fingerprint is only a diagnostic).
  if (!evidenceIdentityEquals(evidenceA.identity, evidenceB.identity)) {
    return {
      kind: "stale",
      evidenceFingerprintFirst: evidenceA.identity.fingerprint,
      evidenceFingerprintSecond: evidenceB.identity.fingerprint,
      policyIdentity,
    };
  }

  // 7) Stable → invoke the narrow Writer exactly once. It re-validates tenant/policy/structure itself.
  //    NOTE (§17): evidence may still change between this final read and the write; O1 does not close
  //    that TOCTOU window and claims no linearizability — a transient stale projection self-corrects.
  let outcome;
  try {
    outcome = await deps.writeClaim({ businessId, result });
  } catch (e) {
    const stage = e instanceof MaterializationRejected ? "writer-validation" : "writer-error";
    return { kind: "failed", stage, message: msg(e) };
  }

  const kind = outcome.action === "created" || outcome.action === "replaced"
    ? "materialized"
    : outcome.action === "deleted"
      ? "deleted"
      : "no-op";
  return {
    kind,
    writerAction: outcome.action,
    candidateCount: outcome.candidateCount,
    evidenceFingerprint: evidenceA.identity.fingerprint,
    policyIdentity,
  };
}

// Re-export so callers can narrow on the resolver's typed failure if they inject a custom resolver.
export { PolicyResolutionFailed };
