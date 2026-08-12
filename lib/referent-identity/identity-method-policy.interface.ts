/**
 * RIA — Identity Method Policy (the contract the resolver DEPENDS ON) · §5.
 *
 * The Method Policy is the ONLY component permitted to read authority-capable inputs
 * (SourceReferentBinding.authorityRef / affirmativeDistinctFrom) and to decide whether
 * an authorized basis exists. It realizes the §5 substrate + §2 separation:
 *
 *   • Authority CLASS ≠ Authorized BASIS — the policy emits a concrete, justified basis,
 *     never a bare class.
 *   • SAME-authorization and DISTINCT-authorization are SEPARATE, independent paths.
 *     A token mismatch alone is NEVER a DISTINCT — it is NO_AUTHORIZATION (UNRESOLVED).
 *   • The policy never returns a CII and never records an assertion (that is the
 *     resolver's job); it decides authorization only.
 *
 * A policy is identified by (policyId, policyVersion); replay pins both.
 */
import type {
  PolicyDecision,
  SourceReferentBinding,
} from "./ria.types";

export interface IdentityMethodPolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  /**
   * Decide whether the two bindings' anchors may be asserted SAME or DISTINCT, or
   * whether there is NO authorization (leaving the identity question UNRESOLVED).
   * MUST NOT mutate its inputs and MUST be deterministic.
   */
  authorize(a: SourceReferentBinding, b: SourceReferentBinding): PolicyDecision;
}
