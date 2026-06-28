// DB Identity Registry — Domain Kernel (pure transition logic + record model)
//
// The DB Identity Registry is the Source of Truth for CURRENT Database Identity
// (DB Identity Registry Design v1 §1/§11/§18). This module is its Domain Kernel:
// the pure, STORAGE-AGNOSTIC business logic — data model, legal transitions, and
// invariants. It is NOT the persistence layer; storage/wiring belong to a future
// layer and do not change the Registry's status as a (persistent) Source of Truth.
//
// It is NOT an Event Log, NOT a Projection, NOT a Controller, NOT a Policy engine,
// NOT a Gate, NOT an Approval system. It performs no Migration / Verification /
// Production ops / Runtime. It only holds current identity and applies authority-
// supplied transitions with structural validation, emitting a provenance record
// (for the Audit Trail) on every applied transition.

import {
  isLegalStatusTransition,
  checkStatusPreconditions,
  identityPreconditionCleared as statusPreconditionCleared,
  isFailClosed as statusFailClosed,
} from './db-identity-status.mjs';
import { FORBIDDEN_VALUE } from '../event-log/sanitize.mjs';

export const ENVIRONMENTS = Object.freeze(['production', 'preview', 'development', 'staging']);

function emptyRecord(environment) {
  return {
    environment,
    status: 'UNKNOWN',
    binding: { branch_ref: null, branch_label: null, endpoint_token: null },
    confidence: 'none',
    evidence_refs: [],
    provenance: null, // provenance of the LAST transition (reference only)
    last_verified_at: null,
    drift: { last_checked_at: null, drift_signal: 'none', drift_reason: null },
  };
}

// Create an empty Registry Kernel state: one UNKNOWN record per environment.
export function createRegistry(environments = ENVIRONMENTS) {
  const records = {};
  for (const env of environments) records[env] = emptyRecord(env);
  return { records };
}

export function getRecord(registry, environment) {
  return registry.records[environment] || null;
}

// §13.4: the binding must never carry a secret. Reject any binding field whose
// value looks like a connection string / credential. branch/host tokens are fine.
function bindingHasSecret(binding) {
  if (!binding) return false;
  for (const v of Object.values(binding)) {
    if (typeof v === 'string' && FORBIDDEN_VALUE.test(v)) return true;
  }
  return false;
}

// §13.7: a preview environment must never be bound to the production identity.
function violatesPreviewProduction(registry, environment, binding) {
  if (environment !== 'preview' || !binding) return false;
  const prod = registry.records.production;
  if (!prod || !prod.binding) return false;
  const sameRef = binding.branch_ref != null && binding.branch_ref === prod.binding.branch_ref;
  const sameTok = binding.endpoint_token != null && binding.endpoint_token === prod.binding.endpoint_token;
  return sameRef || sameTok;
}

// Apply an authority-supplied transition. Pure: returns a NEW registry on success
// (input unchanged). Fail-closed: an illegal/invalid transition is REJECTED and
// the registry is left unchanged. Returns:
//   { ok: true, registry, record, provenance }   or   { ok: false, reason }
//
// `request` = { to_status, binding?, confidence?, evidence_refs?, provenance:{source,
//   method, actor, decided_at}, independent_verification?, four_conditions_met?, drift? }
export function applyTransition(registry, environment, request) {
  const current = registry.records[environment];
  if (!current) return { ok: false, reason: `unknown environment: ${environment}` };

  const to = request.to_status;
  if (!isLegalStatusTransition(current.status, to)) {
    return { ok: false, reason: `illegal transition ${current.status} -> ${to}` };
  }

  // §13.5: every transition requires provenance (source + actor + method).
  const prov = request.provenance;
  if (!prov || !prov.source || !prov.actor || !prov.method) {
    return { ok: false, reason: 'provenance is required (source, actor, method)' };
  }

  const pre = checkStatusPreconditions(to, request);
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const nextBinding = request.binding
    ? { branch_ref: request.binding.branch_ref ?? null, branch_label: request.binding.branch_label ?? null, endpoint_token: request.binding.endpoint_token ?? null }
    : current.binding;

  if (bindingHasSecret(nextBinding)) {
    return { ok: false, reason: 'binding must not contain a secret / connection string' };
  }
  if (violatesPreviewProduction(registry, environment, nextBinding)) {
    return { ok: false, reason: 'preview must not be bound to the production identity' };
  }

  const registry_version = (current.provenance?.registry_version ?? 0) + 1;
  const decided_at = prov.decided_at ?? null;

  // Provenance record for the Audit Trail (immutable; emitted, not stored here).
  const provenance = {
    source: prov.source,
    method: prov.method,
    actor: prov.actor,
    decided_at,
    prior_status: current.status,
    registry_version,
    evidence_refs: Array.isArray(request.evidence_refs) ? request.evidence_refs : [],
  };

  const nextRecord = {
    environment,
    status: to,
    binding: nextBinding,
    confidence: request.confidence ?? (to === 'VERIFIED' ? 'high' : current.confidence),
    evidence_refs: Array.isArray(request.evidence_refs) ? request.evidence_refs : current.evidence_refs,
    provenance, // reference to the last transition's provenance
    last_verified_at: to === 'VERIFIED' ? decided_at : current.last_verified_at,
    drift: request.drift
      ? { last_checked_at: request.drift.last_checked_at ?? null, drift_signal: request.drift.drift_signal ?? 'none', drift_reason: request.drift.drift_reason ?? null }
      : { last_checked_at: current.drift.last_checked_at, drift_signal: 'none', drift_reason: null },
  };

  // Immutable update: build a new registry, leave the input untouched.
  const nextRegistry = { records: { ...registry.records, [environment]: nextRecord } };
  return { ok: true, registry: nextRegistry, record: nextRecord, provenance };
}

// Necessary-but-not-sufficient (§2a): identity block cleared ONLY when VERIFIED.
// This is NOT an authorization to migrate/promote — only the identity precondition.
export function identityPreconditionCleared(registry, environment) {
  const r = registry.records[environment];
  return r ? statusPreconditionCleared(r.status) : false;
}

export function isFailClosed(registry, environment) {
  const r = registry.records[environment];
  return r ? statusFailClosed(r.status) : true;
}
