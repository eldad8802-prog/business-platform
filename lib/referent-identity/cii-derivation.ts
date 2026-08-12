/**
 * RIA — Current Identity Interpretation derivation · §1 / §6 / §7.
 *
 * Derives the DERIVED equivalence-class (CII) for a query anchor from the append-only
 * Identity History, under an explicit Temporal Reconstruction Context. It reads ONLY
 * assertions (never authority-capable inputs, never C0 values) — proving the chain
 * Policy → Basis → Assertion → State is not bypassed.
 *
 * Guarantees realized:
 *   • §6 applicability — an assertion counts iff known (recordedAt ≤ historyBoundary)
 *     AND effective (effectiveAt ≤ evaluationTime). No wall-clock; order is not authority.
 *   • §1/§7 SAME-closure — transitive union over applicable SAME assertions.
 *   • §7 DISTINCT constrains — an applicable DISTINCT whose endpoints fall in the SAME
 *     closure class is a CONTRADICTION → disposition CONFLICT (abstain). Members are
 *     NEVER partitioned, cut, or reduced to a "consistent subset" (RC6).
 *   • UNRESOLVED no-collapse — an anchor with no applicable SAME stays a singleton; it
 *     is never merged with another feature's anchor.
 *   • tenant / type guards — only assertions in the query's tenant + referent type are
 *     considered (assertions never bridge tenants/types by construction).
 *   • determinism — members are canonically ordered for replay.
 */
import { deepFreeze } from "../business-brain/deep-freeze";
import type { ReferentType, Tenant } from "../business-brain/observation.types";
import type {
  CanonicalReferentId,
  CiiDisposition,
  CurrentIdentityInterpretation,
  IdentityAssertion,
  IdentityHistory,
  TemporalReconstructionContext,
} from "./ria.types";

function isApplicable(
  a: IdentityAssertion,
  tenant: Tenant,
  referentType: ReferentType,
  ctx: TemporalReconstructionContext
): boolean {
  return (
    a.tenant.businessId === tenant.businessId &&
    a.referentType === referentType &&
    // ISO-8601 UTC timestamps compare correctly as strings (fixed width, Z-suffixed).
    a.recordedAt <= ctx.historyBoundary &&
    a.effectiveAt <= ctx.evaluationTime
  );
}

export function deriveCii(
  query: CanonicalReferentId,
  tenant: Tenant,
  referentType: ReferentType,
  history: IdentityHistory,
  ctx: TemporalReconstructionContext
): CurrentIdentityInterpretation {
  const applicable = history.filter((a) => isApplicable(a, tenant, referentType, ctx));
  const sameEdges = applicable.filter((a) => a.relation === "SAME");
  const distinctEdges = applicable.filter((a) => a.relation === "DISTINCT");

  // SAME-closure via BFS from the query anchor (transitive, symmetric).
  const memberSet = new Set<CanonicalReferentId>([query]);
  const frontier: CanonicalReferentId[] = [query];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const edge of sameEdges) {
      let neighbor: CanonicalReferentId | null = null;
      if (edge.left === current) neighbor = edge.right;
      else if (edge.right === current) neighbor = edge.left;
      if (neighbor !== null && !memberSet.has(neighbor)) {
        memberSet.add(neighbor);
        frontier.push(neighbor);
      }
    }
  }

  // §7 CONFLICT — an applicable DISTINCT with BOTH endpoints inside the class contradicts
  // the SAME-closure. Surface CONFLICT and ABSTAIN; do NOT cut/partition (RC6).
  const conflict = distinctEdges.some(
    (d) => memberSet.has(d.left) && memberSet.has(d.right)
  );
  const disposition: CiiDisposition = conflict ? "CONFLICT" : "RESOLVED";

  // Deterministic canonical ordering for replay.
  const members = [...memberSet].sort();

  return deepFreeze({ tenant, referentType, members, disposition });
}

/**
 * Identity ALIGNMENT gate for cross-feature consumers (e.g. Detection Grammar).
 * Two anchors are aligned iff they share ONE RESOLVED CII. A CONFLICT interpretation is
 * NOT aligned (abstain), and two anchors in different classes are NOT aligned.
 * This returns a boolean LICENSE only — it computes no value relation and never implies
 * value equality (RIA SAME ≠ Equality EQUAL).
 */
export function anchorsAligned(
  cii: CurrentIdentityInterpretation,
  left: CanonicalReferentId,
  right: CanonicalReferentId
): boolean {
  return (
    cii.disposition === "RESOLVED" &&
    cii.members.includes(left) &&
    cii.members.includes(right)
  );
}
