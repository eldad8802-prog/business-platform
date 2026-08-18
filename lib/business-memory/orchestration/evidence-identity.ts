/**
 * Business Memory IMPL-6A · Evidence-set identity equality (PURE, F3).
 *
 * Canonical equality is `refs` + `ordering` — the fingerprint is an optimization/diagnostic aid, NOT
 * the authority (Orchestrator pre-impl v1 §5/§10). We compare the ordered ref list and the ordering
 * label structurally, so the freshness check never *depends on* a digest being authoritative.
 */
import type { EvidenceSetIdentity } from "@/lib/business-memory/evidence";

/** True iff two evidence-set identities are the same canonical set in the same canonical order. */
export function evidenceIdentityEquals(a: EvidenceSetIdentity, b: EvidenceSetIdentity): boolean {
  if (a.ordering !== b.ordering) return false;
  if (a.refs.length !== b.refs.length) return false;
  for (let i = 0; i < a.refs.length; i++) {
    const x = a.refs[i];
    const y = b.refs[i];
    if (x.kind !== y.kind || x.businessId !== y.businessId || x.recordId !== y.recordId) return false;
  }
  return true;
}
