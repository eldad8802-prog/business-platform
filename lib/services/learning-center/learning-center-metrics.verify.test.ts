/**
 * Learning Center v1 — Phase 1 unit verification (SYNTHETIC data, NO DB).
 *   npx tsx lib/services/learning-center/learning-center-metrics.verify.test.ts
 *
 * Pure aggregation only. Asserts every Phase-1 metric against hand-computed
 * expectations. Read-only; touches no engine, no schema, no output.
 */

import {
  amountSlicePerformance,
  buildDecisionEvolution,
  buildOverview,
  buildTrend,
  confidenceByField,
  coverageByField,
  correctionRateByField,
  decisionsByEngine,
  decisionsByLayerStage,
  deriveEngineId,
  engineHealthStub,
  evidenceQualitySummary,
  outcomeByField,
  producedByField,
  promotionReadiness,
  sliceVsLegacyAgreement,
  summarizeVolume,
} from "./learning-center-metrics";
import type {
  EvidenceRow,
  ReviewEventRow,
  SliceDecisionRow,
  SnapshotRow,
} from "./learning-center.types";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}\n  expected ${e}\n  got      ${a}`);
  }
}
function ok(name: string, cond: boolean): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const LEGACY_V = "unified-extraction-engine@1.0.0";
const SLICE_V = "amount-slice@1.0.0";

function dec(
  p: Partial<SliceDecisionRow> & { fieldKey: string; documentId: number }
): SliceDecisionRow {
  return {
    layer: "documents",
    stage: "extraction",
    producedBy: "legacy",
    engineValue: null,
    legacyValue: null,
    resolutionState: null,
    basis: null,
    confidenceLabel: null,
    extractionSnapshotId: p.documentId,
    occurredAt: "2026-06-25T10:00:00.000Z",
    sliceEngineVersion: null,
    liveEngineVersion: LEGACY_V,
    ...p,
  };
}

function fieldsForDoc(
  documentId: number,
  amount: Partial<SliceDecisionRow>,
  occurredAt: string
): SliceDecisionRow[] {
  return [
    dec({
      documentId,
      occurredAt,
      fieldKey: "amount.extracted",
      producedBy: "slice",
      sliceEngineVersion: SLICE_V,
      liveEngineVersion: null,
      ...amount,
    }),
    dec({ documentId, occurredAt, fieldKey: "vendor.extracted", engineValue: `V${documentId}`, legacyValue: `V${documentId}` }),
    dec({ documentId, occurredAt, fieldKey: "date.extracted", engineValue: "2022-06-21T00:00:00.000Z", legacyValue: "2022-06-21T00:00:00.000Z" }),
    dec({ documentId, occurredAt, fieldKey: "documentType.extracted", engineValue: "invoice", legacyValue: "invoice" }),
    dec({ documentId, occurredAt, fieldKey: "direction.interpreted", layer: "business", stage: "interpretation", engineValue: "expense", legacyValue: "expense" }),
    dec({ documentId, occurredAt, fieldKey: "category.classified", layer: "business", stage: "classification", engineValue: documentId === 2 ? "general" : "fuel", legacyValue: documentId === 2 ? "general" : "fuel" }),
  ];
}

// --- synthetic ledger ------------------------------------------------------

const snapshots: SnapshotRow[] = [
  { id: 1, documentId: 1, geometryAvailable: true, occurredAt: "2026-06-25T10:00:00.000Z" },
  { id: 2, documentId: 2, geometryAvailable: true, occurredAt: "2026-06-25T11:00:00.000Z" },
  { id: 3, documentId: 3, geometryAvailable: false, occurredAt: "2026-06-24T10:00:00.000Z" },
];

const decisions: SliceDecisionRow[] = [
  ...fieldsForDoc(1, { engineValue: "200", legacyValue: "200", resolutionState: "resolved", basis: "arithmetic_total", confidenceLabel: "low" }, "2026-06-25T10:00:00.000Z"),
  ...fieldsForDoc(2, { engineValue: "300", legacyValue: "350", resolutionState: "resolved", basis: "arithmetic_total", confidenceLabel: "high" }, "2026-06-25T11:00:00.000Z"),
  ...fieldsForDoc(3, { engineValue: "", legacyValue: "100", resolutionState: "unresolved", basis: null, confidenceLabel: null }, "2026-06-24T10:00:00.000Z"),
];

const reviewEvents: ReviewEventRow[] = [
  {
    documentId: 1,
    occurredAt: "2026-06-25T12:00:00.000Z",
    verdicts: {
      amount: { verdict: "confirmed", final: 200 },
      vendorName: { verdict: "confirmed", final: "V1" },
      date: { verdict: "confirmed", final: "2022-06-21T00:00:00.000Z" },
      category: { verdict: "confirmed", final: "fuel" },
      direction: { verdict: "confirmed", final: "expense" },
    },
  },
  {
    documentId: 2,
    occurredAt: "2026-06-25T13:00:00.000Z",
    verdicts: {
      amount: { verdict: "corrected", final: "350", delta: { old: "300", new: "350" } },
      vendorName: { verdict: "confirmed", final: "V2" },
      date: { verdict: "confirmed", final: "2022-06-21T00:00:00.000Z" },
      category: { verdict: "corrected", final: "office" },
      direction: { verdict: "confirmed", final: "expense" },
    },
  },
];

const evidence: EvidenceRow[] = [
  { extractionSnapshotId: 1, hasGeometry: true, hasReasoning: true },
  { extractionSnapshotId: 2, hasGeometry: true, hasReasoning: false },
];

// --- assertions ------------------------------------------------------------

// volume
eq("volume", summarizeVolume(snapshots, decisions), {
  snapshots: 3,
  documentsAnalyzed: 3,
  withGeometry: 2,
  geometryRate: 2 / 3,
  sliceProducedAmount: 3,
});

// layer/stage
eq("layerStage", decisionsByLayerStage(decisions), [
  { layer: "business", stage: "classification", count: 3 },
  { layer: "business", stage: "interpretation", count: 3 },
  { layer: "documents", stage: "extraction", count: 12 },
]);

// derived engineId
eq("engineId.slice", deriveEngineId(decisions[0]), `slice:${SLICE_V}`);
eq("engineId.legacy", deriveEngineId(decisions[1]), `legacy:${LEGACY_V}`);
eq("decisionsByEngine", decisionsByEngine(decisions), [
  { engineId: `legacy:${LEGACY_V}`, producedBy: "legacy", count: 15 },
  { engineId: `slice:${SLICE_V}`, producedBy: "slice", count: 3 },
]);

// slice vs legacy agreement
eq("agreement", sliceVsLegacyAgreement(decisions), {
  agree: 1,
  disagree: 1,
  sliceAbstain: 1,
  comparable: 2,
  total: 3,
  agreementRate: 0.5,
});

// correction by field
const corr = correctionRateByField(reviewEvents);
const amountCorr = corr.find((c) => c.field === "amount.extracted");
eq("correction.amount", amountCorr, {
  field: "amount.extracted",
  corrected: 1,
  confirmed: 1,
  rejected: 0,
  notSubmitted: 0,
  total: 2,
  correctionRate: 0.5,
});
const catCorr = corr.find((c) => c.field === "category.classified");
eq("correction.category.rate", catCorr?.correctionRate, 0.5);

// confidence by field (amount)
const conf = confidenceByField(decisions).find((c) => c.fieldKey === "amount.extracted");
eq("confidence.amount", conf, { fieldKey: "amount.extracted", high: 1, medium: 0, low: 1, none: 1 });

// coverage by field (amount = 2/3; vendor = 1)
const covAmount = coverageByField(decisions).find((c) => c.fieldKey === "amount.extracted");
eq("coverage.amount", covAmount, { fieldKey: "amount.extracted", resolved: 2, total: 3, coverageRate: 2 / 3 });
const covVendor = coverageByField(decisions).find((c) => c.fieldKey === "vendor.extracted");
eq("coverage.vendor", covVendor?.coverageRate, 1);

// producedBy per field
const prodAmount = producedByField(decisions).find((p) => p.fieldKey === "amount.extracted");
eq("producedBy.amount", prodAmount, { fieldKey: "amount.extracted", slice: 3, legacy: 0, total: 3 });
const prodVendor = producedByField(decisions).find((p) => p.fieldKey === "vendor.extracted");
eq("producedBy.vendor", prodVendor, { fieldKey: "vendor.extracted", slice: 0, legacy: 3, total: 3 });

// amount slice performance
eq("amountSlice", amountSlicePerformance(decisions, reviewEvents), {
  resolved: 2,
  ambiguous: 0,
  unresolved: 1,
  total: 3,
  byBasis: { arithmetic_total: 2, none: 1 },
  agreement: { agree: 1, disagree: 1, sliceAbstain: 1, comparable: 2, total: 3, agreementRate: 0.5 },
  resolvedButCorrected: 1,
  abstainedButNeeded: 1,
});

// outcome (who was right) — amount
const outAmount = outcomeByField(decisions, reviewEvents).find((o) => o.fieldKey === "amount.extracted");
eq("outcome.amount", outAmount, {
  fieldKey: "amount.extracted",
  sliceRight: 1,
  legacyRight: 2,
  bothRight: 1,
  bothWrong: 0,
  userConfirmed: 1,
  userCorrected: 1,
  undetermined: 1,
  reviewed: 2,
});

// promotion / readiness (display heuristic) — amount, small sample => shadow_only
const promoAmount = promotionReadiness(decisions, reviewEvents).find((p) => p.fieldKey === "amount.extracted");
ok("promotion.amount.readiness", promoAmount?.readiness === "shadow_only");
ok("promotion.amount.score<=40", (promoAmount?.readinessScore ?? 99) <= 40);
ok("promotion.amount.insufficientSample", (promoAmount?.reasons ?? []).some((r) => r.startsWith("insufficient_sample")));
eq("promotion.amount.resolvedButCorrected", promoAmount?.resolvedButCorrected, 1);
eq("promotion.amount.sliceRight", promoAmount?.sliceRight, 1);
eq("promotion.amount.legacyRight", promoAmount?.legacyRight, 2);

// evidence quality
eq("evidenceQuality", evidenceQualitySummary(snapshots, evidence), {
  total: 3,
  withGeometry: 2,
  withReasoning: 1,
  geometryRate: 2 / 3,
  reasoningRate: 1 / 3,
  evidenceQualityScore: 50,
});

// engine health (type-only stub)
const health = engineHealthStub(decisions);
ok("engineHealth.notCollected", health.every((h) => h.status === "not_collected_yet" && h.totalRuns === null));
ok("engineHealth.engines", health.length === 2);

// trend
eq("trend", buildTrend(snapshots, reviewEvents), [
  { dateIso: "2026-06-24", snapshots: 1, corrections: 0 },
  { dateIso: "2026-06-25", snapshots: 2, corrections: 1 },
]);

// decision evolution — doc 2 (full lifecycle)
const evo = buildDecisionEvolution({
  documentId: 2,
  snapshot: snapshots[1],
  decisions: decisions.filter((d) => d.documentId === 2),
  review: reviewEvents[1],
  financialRecord: { documentId: 2, amount: 350, vendorName: "V2", category: "office", direction: "expense" },
});
eq("evolution.stages", evo.stages, ["extracted", "shadow_slice", "reviewed", "financial_record"]);
ok("evolution.financial", evo.financialRecord?.amount === 350);
const evoAmount = evo.fields.find((f) => f.fieldKey === "amount.extracted");
eq("evolution.amount.field", evoAmount, {
  fieldKey: "amount.extracted",
  legacyValue: "350",
  sliceValue: "300",
  finalValue: "350",
  verdict: "corrected",
});
ok("evolution.engines", evo.engines.includes(`slice:${SLICE_V}`) && evo.engines.includes(`legacy:${LEGACY_V}`));

// buildOverview (orchestrator, window=all)
const overview = buildOverview({ snapshots, decisions, reviewEvents, evidence }, { key: "all", fromIso: null, toIso: null });
eq("overview.volume.docs", overview.volume.documentsAnalyzed, 3);
eq("overview.sliceVsLegacy.rate", overview.sliceVsLegacy.agreementRate, 0.5);
ok("overview.engineHealth.stub", overview.engineHealth.length === 2 && overview.engineHealth[0].status === "not_collected_yet");
ok("overview.trend.nonempty", overview.trend.length === 2);
ok("overview.promotion.amount", overview.promotion.some((p) => p.fieldKey === "amount.extracted"));

// --- window filtering: 25th only excludes doc3 snapshot ---
const overview25 = buildOverview(
  { snapshots, decisions, reviewEvents, evidence },
  { key: "custom", fromIso: "2026-06-25T00:00:00.000Z", toIso: null }
);
eq("window.docs", overview25.volume.documentsAnalyzed, 2);

console.log(`\nLearning Center metrics verify: PASSED ${passed}, FAILED ${failed}`);
if (failed > 0) process.exit(1);
