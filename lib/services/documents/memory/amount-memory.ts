/**
 * Document Memory & Learning — Phase 2 MVP (amount, SHADOW only).
 *
 * Pure structural-prior + re-ranking core. This is NOT wired into any live
 * extraction decision: it is consumed only by an offline shadow runner.
 *
 * Locked invariants enforced structurally here:
 *   • Answer ⊆ Candidates ⊆ Evidence — the re-ranker can only ever return a
 *     value that is already one of the evidence-produced candidates.
 *   • No value memory — a prior stores a structural BAND (vertical position
 *     class), never an amount. It learns "where the winner tends to sit", never
 *     "what the winner is".
 *   • Scope = (business, vendor, docType, direction). Family is NOT a scope key.
 *   • Consistency gate is the primary guard: a prior influences ranking only
 *     with ≥ MIN_SUPPORT corrections whose winners agree on a band ≥ CONSISTENCY.
 *   • Evidence-first: when the engine already resolved confidently, memory does
 *     not change the winner. Memory acts only inside genuine ambiguity.
 *   • No support → No Effect (memory winner === current winner).
 */

export const MIN_SUPPORT = 3;
export const CONSISTENCY_RATIO = 0.66;

export type VerticalBand = "top" | "middle" | "bottom";

export type AmountScopeKey = {
  businessId: number;
  vendor: string;
  docType: string;
  direction: string;
};

/** One human correction, enriched with the structural band of the winning candidate. */
export type AmountCorrection = {
  scope: AmountScopeKey;
  documentId: number;
  humanAmount: number;
  /** Vertical band of the candidate the human chose; null if not locatable. */
  wonBand: VerticalBand | null;
};

/** An evidence-produced amount candidate (one per MoneyAmount). */
export type AmountCandidate = {
  value: number;
  band: VerticalBand | null;
  isCurrentWinner: boolean;
};

/** A learned structural prior for one scope. preferredBand=null ⇒ No Effect. */
export type AmountPrior = {
  scope: AmountScopeKey;
  support: number;
  consistent: boolean;
  preferredBand: VerticalBand | null;
};

export type ReRankReason =
  | "no_prior"
  | "evidence_resolved_dominates"
  | "no_band_match"
  | "reranked_in_ambiguity";

export type ReRankOutcome = {
  currentWinner: number | null;
  memoryWinner: number | null;
  changed: boolean;
  priorApplied: boolean;
  reason: ReRankReason;
};

export function scopeKey(s: AmountScopeKey): string {
  return [s.businessId, s.vendor.trim(), s.docType, s.direction].join("|");
}

/**
 * Vertical band from a 0..1 normalized vertical position (0=top, 1=bottom).
 * Value-free structural feature.
 */
export function bandOfNormalizedY(normY: number | null): VerticalBand | null {
  if (normY == null || Number.isNaN(normY)) return null;
  if (normY < 1 / 3) return "top";
  if (normY < 2 / 3) return "middle";
  return "bottom";
}

/**
 * Prior Generation — group corrections by scope, gate by support + consistency.
 * Learns the dominant vertical band of human winners. No values stored.
 */
export function buildAmountPriors(
  corrections: readonly AmountCorrection[]
): Map<string, AmountPrior> {
  const groups = new Map<string, AmountCorrection[]>();
  for (const c of corrections) {
    const k = scopeKey(c.scope);
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }

  const priors = new Map<string, AmountPrior>();
  for (const [k, list] of groups) {
    const scope = list[0].scope;
    const located = list.filter((c) => c.wonBand != null);
    const support = located.length;

    if (support < MIN_SUPPORT) {
      priors.set(k, { scope, support, consistent: false, preferredBand: null });
      continue;
    }

    const tally: Record<VerticalBand, number> = { top: 0, middle: 0, bottom: 0 };
    for (const c of located) tally[c.wonBand as VerticalBand] += 1;
    const [dominantBand, dominantCount] = (
      Object.entries(tally) as [VerticalBand, number][]
    ).sort((a, b) => b[1] - a[1])[0];

    const consistent = dominantCount / support >= CONSISTENCY_RATIO;
    priors.set(k, {
      scope,
      support,
      consistent,
      preferredBand: consistent ? dominantBand : null, // inconsistent ⇒ No Effect
    });
  }
  return priors;
}

/**
 * Shadow Re-Ranking — bounded, evidence-first. Returns a candidate value or the
 * unchanged current winner. NEVER invents a value or candidate.
 */
export function reRankAmount(params: {
  candidates: readonly AmountCandidate[];
  currentWinner: number | null;
  currentResolved: boolean;
  prior: AmountPrior | null;
}): ReRankOutcome {
  const { candidates, currentWinner, currentResolved, prior } = params;

  // No prior / below-support / inconsistent ⇒ No Effect.
  if (!prior || prior.preferredBand == null) {
    return { currentWinner, memoryWinner: currentWinner, changed: false, priorApplied: false, reason: "no_prior" };
  }

  // Evidence-first: a confident evidence resolution is never overridden by memory.
  if (currentResolved) {
    return { currentWinner, memoryWinner: currentWinner, changed: false, priorApplied: true, reason: "evidence_resolved_dominates" };
  }

  // Genuine ambiguity: prefer a candidate that sits in the learned band.
  const matches = candidates.filter((c) => c.band === prior.preferredBand);
  if (matches.length === 0) {
    return { currentWinner, memoryWinner: currentWinner, changed: false, priorApplied: true, reason: "no_band_match" };
  }

  // Answer ⊆ Candidates: pick an existing candidate (largest magnitude in band —
  // a neutral structural tie-break, still never a remembered value).
  const memoryWinner = matches.reduce((a, b) => (b.value > a.value ? b : a)).value;
  return {
    currentWinner,
    memoryWinner,
    changed: memoryWinner !== currentWinner,
    priorApplied: true,
    reason: "reranked_in_ambiguity",
  };
}

export type MemoryMeasurement = {
  documentsReRanked: number;
  priorsAvailable: number;
  priorsActive: number; // preferredBand != null
  priorApplied: number;
  winnerChanged: number;
  noEffect: number;
  // agreement vs human verdict — only computable where a verdict is present
  withVerdict: number;
  currentAgreesHuman: number;
  memoryAgreesHuman: number;
  memoryNetAgreementDelta: number; // memoryAgrees − currentAgrees (the impact signal)
};

export function emptyMeasurement(): MemoryMeasurement {
  return {
    documentsReRanked: 0,
    priorsAvailable: 0,
    priorsActive: 0,
    priorApplied: 0,
    winnerChanged: 0,
    noEffect: 0,
    withVerdict: 0,
    currentAgreesHuman: 0,
    memoryAgreesHuman: 0,
    memoryNetAgreementDelta: 0,
  };
}

function approxEq(a: number | null, b: number | null): boolean {
  return a != null && b != null && Math.abs(a - b) <= 0.01;
}

/** Fold one re-rank record (optionally with a human verdict) into the measurement. */
export function accumulate(
  m: MemoryMeasurement,
  outcome: ReRankOutcome,
  humanVerdict: number | null
): MemoryMeasurement {
  const next = { ...m };
  next.documentsReRanked += 1;
  if (outcome.priorApplied) next.priorApplied += 1;
  if (outcome.changed) next.winnerChanged += 1;
  else next.noEffect += 1;

  if (humanVerdict != null) {
    next.withVerdict += 1;
    const cur = approxEq(outcome.currentWinner, humanVerdict) ? 1 : 0;
    const mem = approxEq(outcome.memoryWinner, humanVerdict) ? 1 : 0;
    next.currentAgreesHuman += cur;
    next.memoryAgreesHuman += mem;
    next.memoryNetAgreementDelta += mem - cur;
  }
  return next;
}
