/**
 * Business Memory READ-OBS · Durable comparison-observation sink.
 *
 * Persists the (already privacy-safe) bm-read-comparison observation to the existing ProductUsageEvent
 * telemetry table so it is DURABLE + historically queryable via a gated SELECT — unlike the ephemeral
 * Vercel runtime log. Reuses existing infra: NO new table, NO migration, NO new env.
 *
 * Best-effort / never-throws: recordProductUsageEvent is itself best-effort, and this wrapper adds a
 * second try/catch. A telemetry failure can NEVER affect the extraction / product path. It writes ONLY
 * the privacy-safe fields already present on ComparisonLog — never vendor, normalized subject, category
 * value, or evidence payload. It runs only when BUSINESS_MEMORY_READ is ON (the coordinator log is only
 * invoked on the flag-ON branch), so it is DARK by default.
 */
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import type { ComparisonLog } from "./comparison-read";

/** Fixed featureKey for the comparison telemetry stream (free-string featureKey, no catalog change). */
export const READ_COMPARISON_FEATURE_KEY = "business-memory-read-comparison" as const;

/** The exact ProductUsageEvent input for a comparison observation. Pure — privacy-safe fields ONLY. */
export type ComparisonUsageEvent = {
  businessId: number;
  featureKey: typeof READ_COMPARISON_FEATURE_KEY;
  action: ComparisonLog["comparison"];
  outcome: ComparisonLog["outcome"];
  metadata: {
    fallbackReason: ComparisonLog["fallbackReason"];
    policyKey?: string;
    versionLabel?: string;
    fingerprintMatch?: boolean;
  };
};

/**
 * PURE mapping from a ComparisonLog to the telemetry event. Copies ONLY the privacy-safe fields already
 * on ComparisonLog — never vendor, normalized subject, category value, or evidence payload.
 */
export function buildComparisonUsageEvent(entry: ComparisonLog): ComparisonUsageEvent {
  return {
    businessId: entry.businessId,
    featureKey: READ_COMPARISON_FEATURE_KEY,
    action: entry.comparison, // agree | disagree | not-applicable
    outcome: entry.outcome, // memory-available | fallback
    metadata: {
      fallbackReason: entry.fallbackReason,
      ...(entry.policyKey ? { policyKey: entry.policyKey } : {}),
      ...(entry.versionLabel ? { versionLabel: entry.versionLabel } : {}),
      ...(entry.fingerprintMatch === undefined ? {} : { fingerprintMatch: entry.fingerprintMatch }),
    },
  };
}

/** Persist one comparison observation to durable telemetry. Never throws. */
export async function persistComparisonObservation(entry: ComparisonLog): Promise<void> {
  try {
    await recordProductUsageEvent(buildComparisonUsageEvent(entry));
  } catch {
    /* telemetry must never affect the product result */
  }
}
