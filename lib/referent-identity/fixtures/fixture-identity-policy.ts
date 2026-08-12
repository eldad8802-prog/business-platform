/**
 * RIA — Fixture Identity Method Policy (PROOF ONLY, NON-NORMATIVE) · §2 / §5.
 *
 * A fixture Canonical/Internal authority (§2 Class-A): two bindings that reference the
 * SAME authoritative canonical token — within one tenant and one referent type — are
 * authorized SAME. This is the RIA analogue of the fixture Equality Domain: it proves
 * the RIA machinery RESPECTS an authority contract; it is NOT production entity matching.
 *
 * It deliberately does NOT match on name, on value, or on "feature A + feature B". The
 * SAME and DISTINCT authorizations are SEPARATE, independent paths:
 *
 *   • DISTINCT — only from an AFFIRMATIVE, targeted distinctness declaration
 *     (affirmativeDistinctFrom, anchor-keyed). A token mismatch is NEVER a DISTINCT.
 *   • SAME     — only from identical authoritative tokens.
 *   • otherwise — NO_AUTHORIZATION (the identity question stays UNRESOLVED).
 *
 * When a pair carries BOTH a targeted affirmative DISTINCT and identical tokens, the
 * targeted/specific authority is the authorized basis for that pair; any residual
 * contradiction with the general token grouping is NOT resolved here — it surfaces at
 * CII derivation as CONFLICT via transitive closure (never a graph-cut). See §7 / RC6.
 */
import type { IdentityMethodPolicy } from "../identity-method-policy.interface";
import type {
  AuthorizedBasis,
  CanonicalReferentId,
  IdentityRelation,
  PolicyDecision,
  SourceReferentBinding,
} from "../ria.types";

const POLICY_ID = "fixture:canonical-internal-authority";
const POLICY_VERSION = "v1";

/** Canonically order the anchor pair so a symmetric relation has one identity. */
function orderedPair(
  x: CanonicalReferentId,
  y: CanonicalReferentId
): readonly [CanonicalReferentId, CanonicalReferentId] {
  return x <= y ? [x, y] : [y, x];
}

function basis(
  relation: IdentityRelation,
  a: SourceReferentBinding,
  b: SourceReferentBinding,
  justification: string
): AuthorizedBasis {
  const [left, right] = orderedPair(a.canonicalReferentId, b.canonicalReferentId);
  return {
    relation,
    left,
    right,
    tenant: a.tenant,
    referentType: a.referentType,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    justification,
  };
}

function affirmativelyDistinct(
  a: SourceReferentBinding,
  b: SourceReferentBinding
): boolean {
  const aSaysB = (a.affirmativeDistinctFrom ?? []).includes(b.canonicalReferentId);
  const bSaysA = (b.affirmativeDistinctFrom ?? []).includes(a.canonicalReferentId);
  return aSaysB || bSaysA;
}

export function makeFixtureIdentityPolicy(): IdentityMethodPolicy {
  return {
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    authorize(a: SourceReferentBinding, b: SourceReferentBinding): PolicyDecision {
      // Guard — no identity authority spans tenants.
      if (a.tenant.businessId !== b.tenant.businessId) {
        return {
          kind: "NO_AUTHORIZATION",
          reason: "cross-tenant: no identity authority spans tenants",
        };
      }
      // Guard — no reconciliation across referent types.
      if (a.referentType !== b.referentType) {
        return {
          kind: "NO_AUTHORIZATION",
          reason: "cross-type: no reconciliation across referent types",
        };
      }
      // DISTINCT path — affirmative + targeted ONLY (checked separately from SAME).
      if (affirmativelyDistinct(a, b)) {
        return {
          kind: "AUTHORIZED",
          basis: basis(
            "DISTINCT",
            a,
            b,
            "affirmative targeted distinctness authority (anchor-keyed)"
          ),
        };
      }
      // SAME path — identical authoritative canonical token (Class-A Canonical/Internal).
      if (a.authorityRef === b.authorityRef) {
        return {
          kind: "AUTHORIZED",
          basis: basis(
            "SAME",
            a,
            b,
            `identical authoritative canonical token: ${a.authorityRef}`
          ),
        };
      }
      // Otherwise — a token mismatch is NOT a DISTINCT; the question stays UNRESOLVED.
      return {
        kind: "NO_AUTHORIZATION",
        reason: "insufficient authority: distinct tokens and no affirmative distinctness",
      };
    },
  };
}
