/**
 * RIA — C0 CanonicalObservation → SourceReferentBinding adapter · §2 / §4.
 *
 * PACKAGING ONLY. This adapter lifts GROUNDS from an immutable C0 account (tenant,
 * referent type, account identity) and attaches authority-capable inputs supplied by
 * the caller (the pre-minted anchor + authority reference). It performs NO resolution:
 * it does not compare names, compare values, infer SAME/DISTINCT, choose a Canonical
 * Referent, or mint one. The C0 account is read-only and is never mutated.
 *
 * The authority inputs are a SEPARATE argument (not read from the C0 content) so that
 * C0 stays untouched and the authority remains explicit and policy-evaluable.
 */
import type { CanonicalObservation } from "../business-brain/observation.types";
import { deepFreeze } from "../business-brain/deep-freeze";
import type {
  CanonicalReferentId,
  FixtureAuthoritativeRef,
  SourceReferentBinding,
} from "./ria.types";

export interface BindingAuthorityInput {
  /** Pre-minted anchor this binding is attached to (§9: no minting runtime exercised). */
  readonly canonicalReferentId: CanonicalReferentId;
  /** Authority-capable input; POLICY-ONLY. */
  readonly authorityRef: FixtureAuthoritativeRef;
  /** Optional affirmative, targeted distinctness authority (anchor-keyed). */
  readonly affirmativeDistinctFrom?: readonly CanonicalReferentId[];
}

export function bindingFromCot(
  cot: CanonicalObservation,
  authority: BindingAuthorityInput
): SourceReferentBinding {
  // Read GROUNDS only — never the value/datum, never resolve.
  const binding: SourceReferentBinding = {
    tenant: cot.tenant,
    referentType: cot.referent.referentType,
    accountRef: cot.observationAccountId,
    canonicalReferentId: authority.canonicalReferentId,
    authorityRef: authority.authorityRef,
    ...(authority.affirmativeDistinctFrom !== undefined
      ? { affirmativeDistinctFrom: authority.affirmativeDistinctFrom }
      : {}),
  };
  return deepFreeze(binding);
}
