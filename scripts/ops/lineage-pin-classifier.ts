/**
 * All-Feature Learning Coverage — the ONE rule for a knowledge row pinned to a lineage its rule no longer uses.
 * Pure; shared by the final proof (learning-coverage-proof.ts) and the diagnostic (learning-coverage-pin-diagnostic.ts),
 * so both classify the same row the same way. Nothing here knows a rule id or a business.
 *
 * Grounded in the reconciler's contract (lib/knowledge/measure-reconciler.ts): after a rule runs under a new
 * version, every ACTIVE / INSUFFICIENT_EVIDENCE row under a different version becomes SUPERSEDED; nothing is
 * deleted; only ACTIVE is consumed.
 *
 *   LIVE_WRONG_PIN                 the row is still live (ACTIVE / INSUFFICIENT_EVIDENCE) under a lineage the
 *                                  current rule does not use — a real defect. FAILS.
 *   LEGITIMATE_HISTORY             out of circulation (SUPERSEDED / STALE) AND corroborated: it was materialized
 *                                  before the expected lineage version existed, OR a live row under the expected
 *                                  lineage exists for the same slot. PASSES.
 *   HISTORICAL_STATUS_UNEXPLAINED  out of circulation but neither corroboration holds. FAILS (fail-closed).
 */
export type PinClass = "LEGITIMATE_HISTORY" | "HISTORICAL_STATUS_UNEXPLAINED" | "LIVE_WRONG_PIN";

export type PinFacts = {
  /** The mismatched row's status. */
  readonly status: string;
  readonly materializedAt: Date;
  /** Creation time of the expected (current) lineage version; null if it does not exist (cannot corroborate). */
  readonly expectedLineageCreatedAt: Date | null;
  /** Status of the row for the same business / measure key / subject under the expected lineage, if any. */
  readonly currentSlotStatus: string | null;
};

const HISTORICAL = new Set(["SUPERSEDED", "STALE"]);
/** A current-lineage slot row corroborates only if it is itself in circulation (written by the current rule). */
const LIVE = new Set(["ACTIVE", "INSUFFICIENT_EVIDENCE"]);

export function classifyPinMismatch(f: PinFacts): PinClass {
  if (!HISTORICAL.has(f.status)) return "LIVE_WRONG_PIN";
  const predatesLineage = f.expectedLineageCreatedAt !== null && f.materializedAt.getTime() < f.expectedLineageCreatedAt.getTime();
  const replacedBySlot = f.currentSlotStatus !== null && LIVE.has(f.currentSlotStatus);
  return predatesLineage || replacedBySlot ? "LEGITIMATE_HISTORY" : "HISTORICAL_STATUS_UNEXPLAINED";
}
