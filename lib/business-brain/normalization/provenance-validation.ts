/**
 * Father Engine — C0 / PR3. Field-level provenance validation (anti-laundering).
 *
 * STRUCTURAL rules only — RealityTier has no ranking/precedence, so this never
 * compares tiers by "trust level":
 *   • every RealityTier (record + per-field) must pass the injected validator;
 *   • an inference claim must carry a real InferenceSubstrate;
 *   • a field-provenance entry must carry its own real field + channel.
 *
 * On failure it returns the STRUCTURED rejection identity (including the offending
 * fieldPath / location) — never a free-form string.
 */

import type { Provenance } from "../observation.types";
import type { RealityTierValidator } from "./reality-tier-registry";
import type { NormalizationRejectionIdentity } from "./normalization-result.types";

type ProvenanceReject = Extract<
  NormalizationRejectionIdentity,
  { reason: "INVALID_REALITY_TIER" | "CHANNEL_LAUNDERING" }
>;

export type ProvenanceCheck = { ok: true } | { ok: false; identity: ProvenanceReject };

export function validateProvenance(
  p: Provenance,
  validator: RealityTierValidator
): ProvenanceCheck {
  if (!validator.isValid(p.realityTier)) {
    return {
      ok: false,
      identity: {
        reason: "INVALID_REALITY_TIER",
        rejectedToken: p.realityTier,
        vocabularyId: validator.vocabularyId,
        location: { kind: "RECORD" },
      },
    };
  }
  if (p.inference) {
    const i = p.inference;
    if (!i.engine.trim() || !i.engineVersion.trim() || !i.runId.trim()) {
      return {
        ok: false,
        identity: {
          reason: "CHANNEL_LAUNDERING",
          violation: "INFERENCE_WITHOUT_SUBSTRATE",
          fieldPath: "$record",
        },
      };
    }
  }
  const fields = p.fieldProvenance ?? [];
  for (let idx = 0; idx < fields.length; idx++) {
    const fp = fields[idx]!;
    const fieldPath = `provenance.fieldProvenance[${idx}]`;
    if (!fp.field.trim() || !fp.channel.trim()) {
      return {
        ok: false,
        identity: { reason: "CHANNEL_LAUNDERING", violation: "BLANK_FIELD_PROVENANCE", fieldPath },
      };
    }
    if (!validator.isValid(fp.realityTier)) {
      return {
        ok: false,
        identity: {
          reason: "INVALID_REALITY_TIER",
          rejectedToken: fp.realityTier,
          vocabularyId: validator.vocabularyId,
          location: { kind: "FIELD", fieldPath },
        },
      };
    }
  }
  return { ok: true };
}
