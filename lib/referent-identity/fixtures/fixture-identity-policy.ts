/**
 * RIA — Fixture Identity Method Policy (PROOF ONLY, NON-NORMATIVE) · §2 / §5.
 *
 * Governance source of truth: docs/referent-identity-authority-v1.md (RIA-1 §2/§5, RATIFIED).
 *
 * A fixture Canonical/Internal authority (§2 Class-A): two bindings whose authoritative
 * canonical token SETS intersect — within one tenant and one referent type — are
 * SAME-eligible. This is the RIA analogue of the fixture Equality Domain: it proves the
 * RIA machinery RESPECTS an authority contract; it is NOT production entity matching.
 *
 * Fixture token convention (fixtures-only, opaque to the runtime): a binding's
 * `authorityRef` is a "|"-separated SET of authoritative token atoms — e.g. "A", "A|B".
 * The runtime never parses `authorityRef`; only this fixture policy does. Using SETS
 * (SAME = non-empty intersection) lets a bridge referent (R2 = {A,B}) connect R1 = {A}
 * and R3 = {B} via SAME WITHOUT forcing R1 and R3 to share a token — so a transitive
 * SAME contradiction can be built from independent, unambiguous evaluations.
 *
 * SAME and DISTINCT authorizations are computed SEPARATELY and INDEPENDENTLY:
 *   • DISTINCT — only from an AFFIRMATIVE, targeted distinctness declaration
 *     (affirmativeDistinctFrom, anchor-keyed). A token mismatch is NEVER a DISTINCT.
 *   • SAME     — only from a non-empty intersection of authoritative token sets.
 *   • token intersection never cancels an affirmative DISTINCT, and vice versa.
 *
 * The fixture policy intentionally AVOIDS ambiguous dual-authorization scenarios.
 * General SAME + DISTINCT co-authorization semantics are NOT defined by this proof —
 * they are SEMANTIC-OPEN / deferred (concrete Method-Policy governance). As a safety
 * net, if a single evaluation is BOTH SAME-eligible and DISTINCT-eligible, the policy
 * REFUSES to authorize (abstains) rather than silently selecting one. There is NO
 * branch-order precedence: the SAME/DISTINCT checks are order-independent because the
 * both-eligible case is caught first and neither is chosen.
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
const POLICY_VERSION = "v2";

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

/** Fixture-only: interpret an opaque authorityRef as a "|"-separated set of atoms. */
function tokenSet(b: SourceReferentBinding): Set<string> {
  return new Set(
    String(b.authorityRef)
      .split("|")
      .filter((s) => s.length > 0)
  );
}

/** SAME-eligibility — non-empty intersection of authoritative token sets. */
function sameEligible(a: SourceReferentBinding, b: SourceReferentBinding): boolean {
  const A = tokenSet(a);
  for (const t of tokenSet(b)) {
    if (A.has(t)) return true;
  }
  return false;
}

/** DISTINCT-eligibility — affirmative, targeted, anchor-keyed (never a token mismatch). */
function distinctEligible(a: SourceReferentBinding, b: SourceReferentBinding): boolean {
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

      // Compute the two authorizations SEPARATELY, BEFORE choosing any output.
      const same = sameEligible(a, b);
      const distinct = distinctEligible(a, b);

      // Safety net — a single evaluation that is BOTH SAME- and DISTINCT-eligible is an
      // ambiguous dual authorization whose resolution is SEMANTIC-OPEN. The proof policy
      // ABSTAINS (existing NO_AUTHORIZATION; no new outcome, no adjudication, no pick).
      // Because this is caught first, the two branches below are ORDER-INDEPENDENT.
      if (same && distinct) {
        return {
          kind: "NO_AUTHORIZATION",
          reason:
            "ambiguous dual authorization (SAME + DISTINCT co-eligible) — undefined by this proof policy",
        };
      }

      if (distinct) {
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

      if (same) {
        return {
          kind: "AUTHORIZED",
          basis: basis(
            "SAME",
            a,
            b,
            `intersecting authoritative canonical token sets: ${a.authorityRef} ∩ ${b.authorityRef}`
          ),
        };
      }

      // Otherwise — a token mismatch is NOT a DISTINCT; the question stays UNRESOLVED.
      return {
        kind: "NO_AUTHORIZATION",
        reason: "insufficient authority: disjoint token sets and no affirmative distinctness",
      };
    },
  };
}
