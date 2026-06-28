// Identity Policy — full Policy Implementation (Release State Machine §2a).
//
// Determines whether the DB Identity precondition is satisfied for a transition,
// by READING a fact supplied by the caller: facts.dbIdentityStatus (sourced from
// the DB Identity Registry by the caller — this policy does NOT read the Registry).
//
// It returns a two-valued Verdict (pass | fail). A `pass` means ONLY that the
// identity precondition is cleared — it is necessary, NOT sufficient (the
// Controller + other policies still decide whether an action may proceed).
//
// Pure, dependency-free except the Verdict model (same layer). No Registry/Event/
// Runtime access; fail-closed on missing/insufficient facts.

import { pass, failClosed } from '../verdict.mjs';

const POLICY = 'Identity';

export function evaluate(facts = {}, context = {}) {
  const status = facts?.dbIdentityStatus;
  const facts_ref = facts?.facts_ref ?? null;
  const evidence_refs = Array.isArray(facts?.evidence_refs) ? facts.evidence_refs : [];
  const opts = { evidence_refs, facts_ref };

  // fail-closed: if the fact is absent/unknown, do not pass on doubt.
  if (typeof status !== 'string') {
    return failClosed(POLICY, 'dbIdentityStatus fact is missing — identity precondition not cleared', opts);
  }
  if (status === 'VERIFIED') {
    // Necessary, not sufficient: clears the identity precondition only.
    return pass(POLICY, 'DB identity is VERIFIED — identity precondition cleared (necessary, not sufficient)', { ...opts, enforcement_level: 'block' });
  }
  // UNKNOWN / INFERRED / SUSPECT (or anything else) → fail-closed.
  return failClosed(POLICY, `DB identity is ${status} (not VERIFIED) — identity precondition not cleared`, opts);
}
