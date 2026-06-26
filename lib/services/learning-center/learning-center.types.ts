/**
 * Learning Center v1 — generic analytics model (READ-ONLY).
 *
 * Computed entirely over the existing General Decision Ledger
 * (ExtractionSnapshot / SliceDecision / ExtractionEvidence / ReviewEvent) plus
 * the existing FinancialRecord. This module NEVER writes, NEVER changes the
 * engine, and is not a user-facing feature.
 *
 * Generic by design: any future engine/field (vendor, category, date, vat,
 * document-number, llm, hybrid …) plugs in purely by writing to the Ledger — no
 * change to this contract is required.
 *
 * Boundaries honored in v1:
 *  - `engineId` is DERIVED from existing fields (no new column, no migration).
 *  - `EngineHealth` is a TYPE ONLY — not collected yet (future instrumentation).
 *  - All "readiness"/score signals are DISPLAY heuristics; they never gate or
 *    tune any engine.
 */

// =========================================================================
// Input rows (raw, read from existing tables; decoupled for pure aggregation)
// =========================================================================

export type SliceDecisionRow = {
  fieldKey: string;
  layer: string | null;
  stage: string | null;
  producedBy: string;
  engineValue: string | null;
  legacyValue: string | null;
  resolutionState: string | null;
  basis: string | null;
  confidenceLabel: string | null;
  documentId: number;
  extractionSnapshotId: number;
  occurredAt: string; // ISO — for Timeline
  sliceEngineVersion: string | null; // for engineId (slice rows)
  liveEngineVersion: string | null; // snapshot.liveEngineVersion (engineId for legacy rows)
};

export type SnapshotRow = {
  id: number;
  documentId: number;
  geometryAvailable: boolean | null;
  occurredAt: string; // ISO
};

export type ReviewEventRow = {
  documentId: number;
  occurredAt: string; // ISO
  verdicts: unknown; // { [reviewField]: { belief, final, verdict, delta? } }
};

/** Lightweight evidence flags (heavy ocrGeometry blob NOT loaded in aggregate). */
export type EvidenceRow = {
  extractionSnapshotId: number;
  hasGeometry: boolean;
  hasReasoning: boolean;
};

/** For Decision Evolution drill-down only. */
export type FinancialRecordRow = {
  documentId: number;
  amount: number | null;
  vendorName: string | null;
  category: string | null;
  direction: string | null;
};

// =========================================================================
// Time window (Timeline)
// =========================================================================

export type TimeWindowKey = "24h" | "7d" | "30d" | "custom" | "all";

export type TimeWindow = {
  key: TimeWindowKey;
  /** inclusive ISO lower bound; null = open (all time). */
  fromIso: string | null;
  /** inclusive ISO upper bound; null = now/open. */
  toIso: string | null;
};

export type TrendBucket = {
  dateIso: string; // YYYY-MM-DD
  snapshots: number;
  corrections: number;
};

// =========================================================================
// Metric outputs
// =========================================================================

export type LayerStageCount = {
  layer: string;
  stage: string;
  count: number;
};

export type EngineCount = {
  engineId: string; // derived, e.g. "slice:amount-slice@1.0.0" | "legacy:unified-extraction-engine@1.0.0"
  producedBy: string;
  count: number;
};

export type VolumeSummary = {
  snapshots: number;
  documentsAnalyzed: number;
  withGeometry: number;
  geometryRate: number | null;
  sliceProducedAmount: number;
};

export type AgreementSummary = {
  agree: number;
  disagree: number;
  sliceAbstain: number;
  comparable: number;
  total: number;
  agreementRate: number | null;
};

/**
 * Extended agreement — not just "was there a disagreement" but WHO WAS RIGHT,
 * judged against the human-confirmed final value (ReviewEvent.final).
 */
export type OutcomeBreakdown = {
  fieldKey: string;
  /** documents where the slice value matched the user's final value. */
  sliceRight: number;
  /** documents where the legacy value matched the user's final value. */
  legacyRight: number;
  /** both engines matched the final value. */
  bothRight: number;
  /** neither engine matched the final value. */
  bothWrong: number;
  /** user confirmed (no change) the published value. */
  userConfirmed: number;
  /** user corrected the published value. */
  userCorrected: number;
  /** no human review available to judge. */
  undetermined: number;
  reviewed: number; // userConfirmed + userCorrected
};

export type FieldCorrection = {
  field: string;
  corrected: number;
  confirmed: number;
  rejected: number;
  notSubmitted: number;
  total: number;
  correctionRate: number | null;
};

export type FieldConfidence = {
  fieldKey: string;
  high: number;
  medium: number;
  low: number;
  none: number;
};

export type FieldCoverage = {
  fieldKey: string;
  resolved: number;
  total: number;
  coverageRate: number | null;
};

export type FieldProducedBy = {
  fieldKey: string;
  slice: number;
  legacy: number;
  total: number;
};

export type AmountSlicePerformance = {
  resolved: number;
  ambiguous: number;
  unresolved: number;
  total: number;
  byBasis: Record<string, number>;
  agreement: AgreementSummary;
  /** Engine was confident (resolved) but the human corrected the amount. */
  resolvedButCorrected: number;
  /** Engine abstained but a value was needed (user supplied / legacy had one). */
  abstainedButNeeded: number;
};

/** Aggregate evidence quality (derived; OCR tier/token detail only on drill-down). */
export type EvidenceQualitySummary = {
  total: number;
  withGeometry: number;
  withReasoning: number;
  geometryRate: number | null;
  reasoningRate: number | null;
  /** 0–100 derived score = avg of geometry + reasoning presence. */
  evidenceQualityScore: number | null;
};

/**
 * DISPLAY-ONLY promotion advisory per field. `readiness` is the label; the UI
 * shows it, but `readinessScore` (0–100) is the continuous backing value for
 * future thresholds/comparisons. NEVER auto-promotes — advisory only.
 */
export type FieldPromotion = {
  fieldKey: string;
  producedBySlice: number;
  agreementRate: number | null;
  resolvedButCorrected: number;
  coverageRate: number | null;
  sliceRight: number;
  legacyRight: number;
  readiness: "shadow_only" | "watch" | "candidate";
  readinessScore: number; // 0–100
  reasons: string[];
};

/**
 * Engine Health — TYPE ONLY in v1. The current Ledger swallows errors and records
 * no runtime, so these cannot be derived from existing data. `status` marks this
 * explicitly; populating it requires a future additive instrumentation phase.
 */
export type EngineHealth = {
  engineId: string;
  status: "not_collected_yet";
  totalRuns: number | null;
  failures: number | null;
  exceptionRate: number | null;
  avgRuntimeMs: number | null;
};

/** Per-document lifecycle trace (Decision Evolution) — drill-down. */
export type DecisionEvolutionField = {
  fieldKey: string;
  legacyValue: string | null;
  sliceValue: string | null;
  finalValue: string | null; // user-confirmed/corrected
  verdict: string | null;
};

export type DecisionEvolution = {
  documentId: number;
  snapshotId: number | null;
  snapshotAt: string | null;
  reviewedAt: string | null;
  engines: string[]; // derived engineIds that touched this document
  fields: DecisionEvolutionField[];
  financialRecord: FinancialRecordRow | null;
  /** ordered lifecycle stages reached. */
  stages: Array<"extracted" | "shadow_slice" | "reviewed" | "financial_record">;
};

// =========================================================================
// Top-level overview
// =========================================================================

export type LearningCenterOverview = {
  generatedAt: string;
  window: TimeWindow;
  volume: VolumeSummary;
  decisionsByLayerStage: LayerStageCount[];
  decisionsByEngine: EngineCount[];
  sliceVsLegacy: AgreementSummary;
  outcomeByField: OutcomeBreakdown[];
  correctionByField: FieldCorrection[];
  confidenceByField: FieldConfidence[];
  coverageByField: FieldCoverage[];
  producedByField: FieldProducedBy[];
  amountSlice: AmountSlicePerformance;
  evidenceQuality: EvidenceQualitySummary;
  promotion: FieldPromotion[];
  engineHealth: EngineHealth[]; // type-only, status: not_collected_yet
  trend: TrendBucket[];
};
