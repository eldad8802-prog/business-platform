/**
 * RIA — Identity Resolver · §2 / §3.
 *
 * Governance source of truth: docs/referent-identity-authority-v1.md (RIA-1 §0–§7, RATIFIED).
 *
 * RIA-ONLY-ASSERTS. The resolver consumes an AUTHORIZED BASIS (produced by a Method
 * Policy) and records an immutable, append-only Identity Assertion at an explicit
 * point in dual-time. It does NOT read authority-capable inputs (authorityRef /
 * affirmativeDistinctFrom) — it only sees the typed basis — which is what proves the
 * authority could not bypass the Policy → Basis → Assertion → State chain. It never
 * derives a CII (that is cii-derivation's job) and never mutates a C0 account.
 *
 * Time is EXPLICIT (§6): the caller supplies recordedAt + effectiveAt; there is no
 * wall-clock. `assertionId` is a deterministic content digest (reuses C0 canonical
 * serialization), so identical inputs replay to identical assertion identities.
 */
import { canonicalize, sha256Hex } from "../business-brain/canonical-serialize";
import { deepFreeze } from "../business-brain/deep-freeze";
import type { IdentityMethodPolicy } from "./identity-method-policy.interface";
import type {
  AuthorizedBasis,
  IdentityAssertion,
  PolicyDecision,
  SourceReferentBinding,
} from "./ria.types";

export interface AssertionTimes {
  readonly recordedAt: string;
  readonly effectiveAt: string;
}

function assertionIdOf(core: {
  relation: string;
  left: string;
  right: string;
  tenant: { businessId: number };
  referentType: string;
  policyId: string;
  policyVersion: string;
  recordedAt: string;
  effectiveAt: string;
}): string {
  return "ria-assert:sha256:" + sha256Hex(canonicalize(core));
}

/**
 * Record an immutable assertion from an already-authorized basis. The resolver sees
 * ONLY the basis (never the bindings' authority inputs).
 */
export function recordAssertion(
  basis: AuthorizedBasis,
  times: AssertionTimes
): IdentityAssertion {
  const assertionId = assertionIdOf({
    relation: basis.relation,
    left: basis.left,
    right: basis.right,
    tenant: basis.tenant,
    referentType: basis.referentType,
    policyId: basis.policyId,
    policyVersion: basis.policyVersion,
    recordedAt: times.recordedAt,
    effectiveAt: times.effectiveAt,
  });
  const assertion: IdentityAssertion = {
    assertionId,
    relation: basis.relation,
    left: basis.left,
    right: basis.right,
    tenant: basis.tenant,
    referentType: basis.referentType,
    basis,
    recordedAt: times.recordedAt,
    effectiveAt: times.effectiveAt,
  };
  return deepFreeze(assertion);
}

export interface AuthorizeAndRecordResult {
  readonly decision: PolicyDecision;
  /** Present iff the decision was AUTHORIZED — otherwise the question stays UNRESOLVED. */
  readonly assertion: IdentityAssertion | null;
}

/**
 * The full chain for one pair: Policy authorizes → (if authorized) resolver records.
 * NO_AUTHORIZATION yields no assertion (the identity question remains UNRESOLVED — it
 * is never collapsed and never forced into a DISTINCT).
 */
export function authorizeAndRecord(
  policy: IdentityMethodPolicy,
  a: SourceReferentBinding,
  b: SourceReferentBinding,
  times: AssertionTimes
): AuthorizeAndRecordResult {
  const decision = policy.authorize(a, b);
  if (decision.kind === "AUTHORIZED") {
    return { decision, assertion: recordAssertion(decision.basis, times) };
  }
  return { decision, assertion: null };
}
