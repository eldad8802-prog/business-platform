/**
 * Father Engine — C0 / PR3. Field-level provenance validation (anti-laundering).
 *
 * STRUCTURAL rules only — RealityTier has no ranking/precedence yet, so this never
 * compares tiers by "trust level":
 *   • every RealityTier (record + per-field) must pass the injected validator;
 *   • an inference claim must carry a real InferenceSubstrate (non-empty
 *     engine/version/runId) — you cannot claim machine origin without a substrate;
 *   • a field-provenance entry must carry its own real field + channel (never blank),
 *     so it cannot silently inherit the record-level channel.
 *
 * The caller preserves fieldProvenance verbatim into the COT (record-level
 * provenance never upgrades or overwrites field-level grounds).
 */

import type { Provenance } from "../observation.types";
import type { RealityTierValidator } from "./reality-tier-registry";

export type ProvenanceCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "INVALID_REALITY_TIER" | "CHANNEL_LAUNDERING";
      detail: string;
    };

export function validateProvenance(
  p: Provenance,
  validator: RealityTierValidator
): ProvenanceCheck {
  if (!validator.isValid(p.realityTier)) {
    return { ok: false, reason: "INVALID_REALITY_TIER", detail: `record tier "${p.realityTier}"` };
  }
  if (p.inference) {
    const i = p.inference;
    if (!i.engine.trim() || !i.engineVersion.trim() || !i.runId.trim()) {
      return {
        ok: false,
        reason: "CHANNEL_LAUNDERING",
        detail: "inference claim without a real substrate (engine/version/runId)",
      };
    }
  }
  for (const fp of p.fieldProvenance ?? []) {
    if (!fp.field.trim() || !fp.channel.trim()) {
      return {
        ok: false,
        reason: "CHANNEL_LAUNDERING",
        detail: "field provenance with a blank field or channel",
      };
    }
    if (!validator.isValid(fp.realityTier)) {
      return {
        ok: false,
        reason: "INVALID_REALITY_TIER",
        detail: `field "${fp.field}" tier "${fp.realityTier}"`,
      };
    }
  }
  return { ok: true };
}
