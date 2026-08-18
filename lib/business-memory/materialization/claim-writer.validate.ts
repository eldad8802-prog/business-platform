/**
 * Business Memory IMPL-5A · Writer input validation (PURE, fail-closed).
 *
 * Validates a MaterializationCommand BEFORE any DB mutation (§6/§7). On any violation it throws
 * MaterializationRejected — the Writer never silently dedups, repairs input, or picks a winner. No DB,
 * no I/O. Enforces the writer-time tenant invariant the DB does not (no composite tenant FK on links).
 */
import type { EvidenceRef } from "@/lib/business-memory/evidence";
import type { MaterializationCommand } from "./claim-writer.contract";

export class MaterializationRejected extends Error {
  constructor(message: string) {
    super(`[business-memory/materialization] ${message}`);
    this.name = "MaterializationRejected";
  }
}

const refKey = (r: EvidenceRef): string => `${r.kind}:${r.businessId}:${r.recordId}`;

function assert(cond: boolean, message: string): void {
  if (!cond) throw new MaterializationRejected(message);
}

/**
 * Validate the command. Throws MaterializationRejected on any structural / tenant / state-consistency
 * violation. Returns nothing — a clean return means "safe to materialize".
 */
export function validateCommand(command: MaterializationCommand): void {
  const { businessId, result } = command;

  // Tenant authority (trusted businessId; never from a payload) and slot integers.
  assert(Number.isInteger(businessId) && businessId > 0, "businessId must be a positive integer");
  assert(result.subject.businessId === businessId, "result.subject.businessId must equal the command tenant");
  assert(Number.isInteger(result.policyVersionId) && result.policyVersionId > 0, "policyVersionId must be a positive integer");

  // Tenant consistency of every evidence reference (DB does not enforce this — §6).
  const evidenceRefs = result.evidenceSetIdentity.refs;
  for (const ref of evidenceRefs) {
    assert(ref.businessId === businessId, "evidenceSetIdentity contains a cross-tenant ref");
  }
  const evidenceKeys = new Set(evidenceRefs.map(refKey));

  // State ↔ candidate-rowset consistency (Claim persistence v2 §7; Materializer v1 §11).
  const n = result.candidates.length;
  switch (result.state) {
    case "supported": assert(n === 1, "state 'supported' requires exactly one candidate"); break;
    case "conflicting": assert(n >= 2, "state 'conflicting' requires two or more candidates"); break;
    case "insufficient":
    case "withdrawn": assert(n === 0, `state '${result.state}' requires zero candidates`); break;
    default: throw new MaterializationRejected(`unknown derived state '${String(result.state)}'`);
  }

  // Per-candidate structural + subset checks (only meaningful when candidates are persisted).
  const seenProposition = new Set<string>();
  for (const c of result.candidates) {
    assert(c.claimType === result.claimType, "candidate.claimType must match result.claimType");
    assert(!seenProposition.has(c.propositionValue), `duplicate proposition value '${c.propositionValue}'`);
    seenProposition.add(c.propositionValue);
    assert(c.supportingRefs.length >= 1, "a persisted candidate must have at least one supporting ref");

    const seenRef = new Set<string>();
    for (const ref of c.supportingRefs) {
      const k = refKey(ref);
      assert(ref.businessId === businessId, "candidate has a cross-tenant supporting ref");
      assert(!seenRef.has(k), "duplicate supporting ref within a candidate");
      seenRef.add(k);
      // SUBSET rule (Materializer v1 §13): supportingRefs ⊆ evidenceSetIdentity.refs (NOT equality).
      assert(evidenceKeys.has(k), "supporting ref is not within the result's evidence set");
    }
  }
}
