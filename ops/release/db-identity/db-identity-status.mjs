// DB Identity Registry — status model + legal transitions + structural preconditions
//
// Pure, storage-agnostic. Part of the Registry Domain Kernel. Defines the status
// vocabulary, the legal status-transition graph, and the STRUCTURAL preconditions
// each target status requires (per DB Identity Registry Design v1 §8/§9/§17).
//
// This module enforces STRUCTURE only — it never evaluates evidence content
// (that is the Controller's job), never persists, never blocks/migrates.

export const STATUSES = Object.freeze(['UNKNOWN', 'INFERRED', 'VERIFIED', 'SUSPECT']);

// Direct-evidence sources accepted for VERIFIED (§9).
export const DIRECT_SOURCES = Object.freeze(['direct-log', 'build-host-probe']);

// Legal status transitions (§17). Any transition not listed is rejected.
export const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  UNKNOWN: ['INFERRED', 'VERIFIED'],
  INFERRED: ['VERIFIED', 'UNKNOWN'],
  VERIFIED: ['SUSPECT', 'UNKNOWN'],
  SUSPECT: ['VERIFIED', 'INFERRED', 'UNKNOWN'],
});

export function isLegalStatusTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  return (ALLOWED_STATUS_TRANSITIONS[from] || []).includes(to);
}

// Structural preconditions for a target status. Returns { ok, reason }.
// These check the SHAPE of the request/provenance — not the truth of the evidence.
export function checkStatusPreconditions(toStatus, request) {
  const ev = Array.isArray(request.evidence_refs) ? request.evidence_refs : [];
  const prov = request.provenance || {};

  if (toStatus === 'VERIFIED') {
    // §9 / §13.1: direct source + evidence + independent verification + 4 conditions.
    if (!DIRECT_SOURCES.includes(prov.source)) {
      return { ok: false, reason: 'VERIFIED requires a direct-evidence provenance source' };
    }
    if (ev.length === 0) {
      return { ok: false, reason: 'VERIFIED requires non-empty evidence_refs' };
    }
    if (request.independent_verification !== true) {
      return { ok: false, reason: 'VERIFIED requires independent_verification === true' };
    }
    if (request.four_conditions_met !== true) {
      return { ok: false, reason: 'VERIFIED requires four_conditions_met === true (B-2 A8)' };
    }
    return { ok: true };
  }

  if (toStatus === 'INFERRED') {
    // §9: indirect evidence is acceptable, but confidence must be present and evidence non-empty.
    if (!request.confidence || request.confidence === 'none') {
      return { ok: false, reason: 'INFERRED requires confidence other than none' };
    }
    if (ev.length === 0) {
      return { ok: false, reason: 'INFERRED requires non-empty evidence_refs' };
    }
    return { ok: true };
  }

  if (toStatus === 'SUSPECT') {
    // §15: SUSPECT is entered on a drift signal.
    const sig = request.drift && request.drift.drift_signal;
    if (sig !== 'suspected' && sig !== 'confirmed') {
      return { ok: false, reason: 'SUSPECT requires a drift signal (suspected|confirmed)' };
    }
    return { ok: true };
  }

  // UNKNOWN (loss of trust / collapse) has no structural evidence precondition.
  return { ok: true };
}

// Necessary-but-not-sufficient read (§2a / §13.10): identity precondition is
// cleared ONLY when VERIFIED. This is NOT an authorization to act.
export function identityPreconditionCleared(status) {
  return status === 'VERIFIED';
}

// Fail-closed read (§3/§9/§16): any status other than VERIFIED blocks on identity.
export function isFailClosed(status) {
  return status !== 'VERIFIED';
}
