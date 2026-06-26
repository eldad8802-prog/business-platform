/**
 * Learning Center v1 — pure aggregation (NO DB, NO side effects, deterministic).
 *
 * Maps already-collected ledger rows to display metrics. Generic: keyed by
 * fieldKey / derived engineId so any future engine plugs in for free. Nothing
 * here influences the engine; it only summarizes existing Evidence.
 */

import type {
  AgreementSummary,
  AmountSlicePerformance,
  DecisionEvolution,
  EngineCount,
  EngineHealth,
  EvidenceQualitySummary,
  EvidenceRow,
  FieldConfidence,
  FieldCorrection,
  FieldCoverage,
  FieldProducedBy,
  FieldPromotion,
  FinancialRecordRow,
  LayerStageCount,
  LearningCenterOverview,
  OutcomeBreakdown,
  ReviewEventRow,
  SliceDecisionRow,
  SnapshotRow,
  TimeWindow,
  TrendBucket,
} from "./learning-center.types";

const AMOUNT_FIELD = "amount.extracted";

/** ReviewEvent verdict field -> ledger fieldKey. documentType has no verdict yet. */
export const REVIEW_FIELD_TO_FIELDKEY: Record<string, string> = {
  amount: "amount.extracted",
  vendorName: "vendor.extracted",
  date: "date.extracted",
  category: "category.classified",
  direction: "direction.interpreted",
};

const FIELDKEY_TO_REVIEW_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(REVIEW_FIELD_TO_FIELDKEY).map(([k, v]) => [v, k])
);

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

// --- engine identity (DERIVED — no new column) -----------------------------

export function deriveEngineId(row: SliceDecisionRow): string {
  if (row.producedBy === "slice") {
    return `slice:${normalize(row.sliceEngineVersion) || "unknown"}`;
  }
  if (row.producedBy === "legacy") {
    return `legacy:${normalize(row.liveEngineVersion) || "unknown"}`;
  }
  return `${row.producedBy}:unknown`;
}

// --- verdict parsing -------------------------------------------------------

type VerdictEntry = { verdict?: unknown; final?: unknown };

function parseVerdicts(raw: unknown): Record<string, VerdictEntry> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, VerdictEntry>;
  }
  return {};
}

/** Latest ReviewEvent per document (append-only ledger may have several). */
function latestReviewByDoc(
  reviewEvents: ReviewEventRow[]
): Map<number, ReviewEventRow> {
  const map = new Map<number, ReviewEventRow>();
  for (const ev of reviewEvents) {
    const cur = map.get(ev.documentId);
    if (!cur || ev.occurredAt > cur.occurredAt) map.set(ev.documentId, ev);
  }
  return map;
}

// --- time window -----------------------------------------------------------

function inWindow(iso: string, w: TimeWindow): boolean {
  if (w.fromIso && iso < w.fromIso) return false;
  if (w.toIso && iso > w.toIso) return false;
  return true;
}

// --- volume / distributions ------------------------------------------------

export function summarizeVolume(
  snapshots: SnapshotRow[],
  decisions: SliceDecisionRow[]
) {
  const documents = new Set(snapshots.map((s) => s.documentId));
  const withGeometry = snapshots.filter((s) => s.geometryAvailable === true).length;
  const sliceProducedAmount = decisions.filter(
    (d) => d.fieldKey === AMOUNT_FIELD && d.producedBy === "slice"
  ).length;
  return {
    snapshots: snapshots.length,
    documentsAnalyzed: documents.size,
    withGeometry,
    geometryRate: rate(withGeometry, snapshots.length),
    sliceProducedAmount,
  };
}

export function decisionsByLayerStage(
  decisions: SliceDecisionRow[]
): LayerStageCount[] {
  const map = new Map<string, LayerStageCount>();
  for (const d of decisions) {
    const layer = d.layer ?? "unknown";
    const stage = d.stage ?? "unknown";
    const key = `${layer}|${stage}`;
    const cur = map.get(key) ?? { layer, stage, count: 0 };
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort(
    (a, b) => a.layer.localeCompare(b.layer) || a.stage.localeCompare(b.stage)
  );
}

export function decisionsByEngine(decisions: SliceDecisionRow[]): EngineCount[] {
  const map = new Map<string, EngineCount>();
  for (const d of decisions) {
    const engineId = deriveEngineId(d);
    const cur =
      map.get(engineId) ?? { engineId, producedBy: d.producedBy, count: 0 };
    cur.count += 1;
    map.set(engineId, cur);
  }
  return [...map.values()].sort((a, b) => a.engineId.localeCompare(b.engineId));
}

// --- agreement (basic) -----------------------------------------------------

export function sliceVsLegacyAgreement(
  decisions: SliceDecisionRow[]
): AgreementSummary {
  const slice = decisions.filter((d) => d.producedBy === "slice");
  let agree = 0;
  let disagree = 0;
  let sliceAbstain = 0;
  for (const d of slice) {
    const sv = normalize(d.engineValue);
    const lv = normalize(d.legacyValue);
    if (sv === "") {
      sliceAbstain += 1;
      continue;
    }
    if (lv === "") continue;
    if (sv === lv) agree += 1;
    else disagree += 1;
  }
  const comparable = agree + disagree;
  return {
    agree,
    disagree,
    sliceAbstain,
    comparable,
    total: slice.length,
    agreementRate: rate(agree, comparable),
  };
}

// --- outcome (who was right, vs human final) -------------------------------

export function outcomeByField(
  decisions: SliceDecisionRow[],
  reviewEvents: ReviewEventRow[]
): OutcomeBreakdown[] {
  const reviews = latestReviewByDoc(reviewEvents);
  const byField = new Map<string, SliceDecisionRow[]>();
  for (const d of decisions) {
    const arr = byField.get(d.fieldKey) ?? [];
    arr.push(d);
    byField.set(d.fieldKey, arr);
  }

  const out: OutcomeBreakdown[] = [];
  for (const [fieldKey, rows] of byField) {
    const reviewField = FIELDKEY_TO_REVIEW_FIELD[fieldKey];
    const o: OutcomeBreakdown = {
      fieldKey,
      sliceRight: 0,
      legacyRight: 0,
      bothRight: 0,
      bothWrong: 0,
      userConfirmed: 0,
      userCorrected: 0,
      undetermined: 0,
      reviewed: 0,
    };
    for (const d of rows) {
      const ev = reviews.get(d.documentId);
      const entry = reviewField && ev ? parseVerdicts(ev.verdicts)[reviewField] : undefined;
      if (!entry || (entry.verdict !== "confirmed" && entry.verdict !== "corrected")) {
        o.undetermined += 1;
        continue;
      }
      o.reviewed += 1;
      if (entry.verdict === "confirmed") o.userConfirmed += 1;
      else o.userCorrected += 1;

      const final = normalize(entry.final);
      const sliceVal = d.producedBy === "slice" ? normalize(d.engineValue) : "";
      const legacyVal = normalize(d.legacyValue);
      const sliceHit = sliceVal !== "" && sliceVal === final;
      const legacyHit = legacyVal !== "" && legacyVal === final;
      if (sliceHit) o.sliceRight += 1;
      if (legacyHit) o.legacyRight += 1;
      if (sliceHit && legacyHit) o.bothRight += 1;
      if (!sliceHit && !legacyHit) o.bothWrong += 1;
    }
    out.push(o);
  }
  return out.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

// --- correction rate -------------------------------------------------------

export function correctionRateByField(
  reviewEvents: ReviewEventRow[]
): FieldCorrection[] {
  const reviews = latestReviewByDoc(reviewEvents);
  const fields = Object.keys(REVIEW_FIELD_TO_FIELDKEY);
  const acc = new Map<string, FieldCorrection>(
    fields.map((f) => [
      f,
      {
        field: REVIEW_FIELD_TO_FIELDKEY[f],
        corrected: 0,
        confirmed: 0,
        rejected: 0,
        notSubmitted: 0,
        total: 0,
        correctionRate: null,
      },
    ])
  );
  for (const ev of reviews.values()) {
    const verdicts = parseVerdicts(ev.verdicts);
    for (const f of fields) {
      const entry = acc.get(f);
      if (!entry) continue;
      const v = normalize(verdicts[f]?.verdict);
      entry.total += 1;
      if (v === "corrected") entry.corrected += 1;
      else if (v === "confirmed") entry.confirmed += 1;
      else if (v === "rejected") entry.rejected += 1;
      else entry.notSubmitted += 1;
    }
  }
  for (const entry of acc.values()) {
    entry.correctionRate = rate(entry.corrected, entry.corrected + entry.confirmed);
  }
  return [...acc.values()];
}

// --- confidence / coverage / producedBy ------------------------------------

export function confidenceByField(
  decisions: SliceDecisionRow[]
): FieldConfidence[] {
  const map = new Map<string, FieldConfidence>();
  for (const d of decisions) {
    const cur =
      map.get(d.fieldKey) ??
      ({ fieldKey: d.fieldKey, high: 0, medium: 0, low: 0, none: 0 } as FieldConfidence);
    const c = normalize(d.confidenceLabel);
    if (c === "high") cur.high += 1;
    else if (c === "medium") cur.medium += 1;
    else if (c === "low") cur.low += 1;
    else cur.none += 1;
    map.set(d.fieldKey, cur);
  }
  return [...map.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

export function coverageByField(decisions: SliceDecisionRow[]): FieldCoverage[] {
  const map = new Map<string, FieldCoverage>();
  for (const d of decisions) {
    const cur =
      map.get(d.fieldKey) ??
      ({ fieldKey: d.fieldKey, resolved: 0, total: 0, coverageRate: null } as FieldCoverage);
    cur.total += 1;
    if (normalize(d.engineValue) !== "") cur.resolved += 1;
    map.set(d.fieldKey, cur);
  }
  const out = [...map.values()];
  for (const c of out) c.coverageRate = rate(c.resolved, c.total);
  return out.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

export function producedByField(decisions: SliceDecisionRow[]): FieldProducedBy[] {
  const map = new Map<string, FieldProducedBy>();
  for (const d of decisions) {
    const cur =
      map.get(d.fieldKey) ??
      ({ fieldKey: d.fieldKey, slice: 0, legacy: 0, total: 0 } as FieldProducedBy);
    cur.total += 1;
    if (d.producedBy === "slice") cur.slice += 1;
    else if (d.producedBy === "legacy") cur.legacy += 1;
    map.set(d.fieldKey, cur);
  }
  return [...map.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

// --- amount slice performance ----------------------------------------------

function correctedDocsForField(
  reviewEvents: ReviewEventRow[],
  reviewField: string
): Set<number> {
  const out = new Set<number>();
  for (const ev of latestReviewByDoc(reviewEvents).values()) {
    if (parseVerdicts(ev.verdicts)[reviewField]?.verdict === "corrected") {
      out.add(ev.documentId);
    }
  }
  return out;
}

export function amountSlicePerformance(
  decisions: SliceDecisionRow[],
  reviewEvents: ReviewEventRow[]
): AmountSlicePerformance {
  const amount = decisions.filter(
    (d) => d.fieldKey === AMOUNT_FIELD && d.producedBy === "slice"
  );
  const byBasis: Record<string, number> = {};
  let resolved = 0;
  let ambiguous = 0;
  let unresolved = 0;
  for (const d of amount) {
    const rs = normalize(d.resolutionState);
    if (rs === "resolved") resolved += 1;
    else if (rs === "ambiguous") ambiguous += 1;
    else unresolved += 1;
    const basis = normalize(d.basis) || "none";
    byBasis[basis] = (byBasis[basis] ?? 0) + 1;
  }
  const corrected = correctedDocsForField(reviewEvents, "amount");
  let resolvedButCorrected = 0;
  let abstainedButNeeded = 0;
  for (const d of amount) {
    const isResolved = normalize(d.resolutionState) === "resolved";
    const wasCorrected = corrected.has(d.documentId);
    if (isResolved && wasCorrected) resolvedButCorrected += 1;
    if (!isResolved && (wasCorrected || normalize(d.legacyValue) !== "")) {
      abstainedButNeeded += 1;
    }
  }
  return {
    resolved,
    ambiguous,
    unresolved,
    total: amount.length,
    byBasis,
    agreement: sliceVsLegacyAgreement(amount),
    resolvedButCorrected,
    abstainedButNeeded,
  };
}

// --- evidence quality (derived) --------------------------------------------

export function evidenceQualitySummary(
  snapshots: SnapshotRow[],
  evidence: EvidenceRow[]
): EvidenceQualitySummary {
  const total = snapshots.length;
  const withGeometry = snapshots.filter((s) => s.geometryAvailable === true).length;
  const withReasoning = evidence.filter((e) => e.hasReasoning === true).length;
  const gr = rate(withGeometry, total);
  const rr = rate(withReasoning, total);
  const score =
    gr === null && rr === null ? null : ((gr ?? 0) + (rr ?? 0)) * 50; // 0–100
  return {
    total,
    withGeometry,
    withReasoning,
    geometryRate: gr,
    reasoningRate: rr,
    evidenceQualityScore: score,
  };
}

// --- promotion readiness (display-only, score 0–100) -----------------------

export function promotionReadiness(
  decisions: SliceDecisionRow[],
  reviewEvents: ReviewEventRow[]
): FieldPromotion[] {
  const produced = producedByField(decisions).filter((p) => p.slice > 0);
  const coverage = new Map(coverageByField(decisions).map((c) => [c.fieldKey, c]));
  const outcomes = new Map(outcomeByField(decisions, reviewEvents).map((o) => [o.fieldKey, o]));

  return produced.map((p) => {
    const sliceRows = decisions.filter(
      (d) => d.fieldKey === p.fieldKey && d.producedBy === "slice"
    );
    const agreement = sliceVsLegacyAgreement(sliceRows);
    const reviewField = FIELDKEY_TO_REVIEW_FIELD[p.fieldKey];
    const corrected = reviewField
      ? correctedDocsForField(reviewEvents, reviewField)
      : new Set<number>();
    const resolvedButCorrected = sliceRows.filter(
      (d) => normalize(d.resolutionState) === "resolved" && corrected.has(d.documentId)
    ).length;
    const cov = coverage.get(p.fieldKey)?.coverageRate ?? null;
    const outcome = outcomes.get(p.fieldKey);

    // DISPLAY heuristic score (0–100): agreement, minus confident-correction penalty.
    const agr = agreement.agreementRate ?? 0;
    const penalty = Math.min(resolvedButCorrected * 10, 40);
    let score = clamp(Math.round(agr * 100 - penalty), 0, 100);

    const reasons: string[] = [];
    let readiness: FieldPromotion["readiness"];
    if (p.slice < 30) {
      readiness = "shadow_only";
      score = Math.min(score, 40);
      reasons.push(`insufficient_sample:${p.slice}`);
    } else if (score >= 90 && resolvedButCorrected === 0) {
      readiness = "candidate";
      reasons.push("high_agreement_no_confident_corrections");
    } else {
      readiness = "watch";
      if (agreement.agreementRate !== null && agreement.agreementRate < 0.95) {
        reasons.push(`agreement_below_threshold:${agreement.agreementRate.toFixed(2)}`);
      }
      if (resolvedButCorrected > 0) reasons.push(`resolved_but_corrected:${resolvedButCorrected}`);
    }

    return {
      fieldKey: p.fieldKey,
      producedBySlice: p.slice,
      agreementRate: agreement.agreementRate,
      resolvedButCorrected,
      coverageRate: cov,
      sliceRight: outcome?.sliceRight ?? 0,
      legacyRight: outcome?.legacyRight ?? 0,
      readiness,
      readinessScore: score,
      reasons,
    };
  });
}

// --- engine health (TYPE ONLY — not collected yet) -------------------------

export function engineHealthStub(decisions: SliceDecisionRow[]): EngineHealth[] {
  const engineIds = new Set(decisions.map((d) => deriveEngineId(d)));
  return [...engineIds].sort().map((engineId) => ({
    engineId,
    status: "not_collected_yet" as const,
    totalRuns: null,
    failures: null,
    exceptionRate: null,
    avgRuntimeMs: null,
  }));
}

// --- trend -----------------------------------------------------------------

export function buildTrend(
  snapshots: SnapshotRow[],
  reviewEvents: ReviewEventRow[]
): TrendBucket[] {
  const map = new Map<string, TrendBucket>();
  const ensure = (d: string): TrendBucket => {
    const cur = map.get(d) ?? { dateIso: d, snapshots: 0, corrections: 0 };
    map.set(d, cur);
    return cur;
  };
  for (const s of snapshots) ensure(dayKey(s.occurredAt)).snapshots += 1;
  for (const ev of latestReviewByDoc(reviewEvents).values()) {
    const verdicts = parseVerdicts(ev.verdicts);
    const anyCorrected = Object.values(verdicts).some((v) => v?.verdict === "corrected");
    if (anyCorrected) ensure(dayKey(ev.occurredAt)).corrections += 1;
  }
  return [...map.values()].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

// --- decision evolution (per document, drill-down) -------------------------

export function buildDecisionEvolution(input: {
  documentId: number;
  snapshot: SnapshotRow | null;
  decisions: SliceDecisionRow[];
  review: ReviewEventRow | null;
  financialRecord: FinancialRecordRow | null;
}): DecisionEvolution {
  const { documentId, snapshot, decisions, review, financialRecord } = input;
  const verdicts = review ? parseVerdicts(review.verdicts) : {};
  const fields = decisions
    .map((d) => {
      const reviewField = FIELDKEY_TO_REVIEW_FIELD[d.fieldKey];
      const entry = reviewField ? verdicts[reviewField] : undefined;
      return {
        fieldKey: d.fieldKey,
        legacyValue: d.legacyValue,
        sliceValue: d.producedBy === "slice" ? d.engineValue : null,
        finalValue: entry ? normalize(entry.final) || null : null,
        verdict: entry && typeof entry.verdict === "string" ? entry.verdict : null,
      };
    })
    .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));

  const engines = [...new Set(decisions.map(deriveEngineId))].sort();
  const stages: DecisionEvolution["stages"] = [];
  if (snapshot) stages.push("extracted");
  if (decisions.some((d) => d.producedBy === "slice")) stages.push("shadow_slice");
  if (review) stages.push("reviewed");
  if (financialRecord) stages.push("financial_record");

  return {
    documentId,
    snapshotId: snapshot?.id ?? null,
    snapshotAt: snapshot?.occurredAt ?? null,
    reviewedAt: review?.occurredAt ?? null,
    engines,
    fields,
    financialRecord,
    stages,
  };
}

// --- top-level overview (pure orchestrator) --------------------------------

export function buildOverview(
  input: {
    snapshots: SnapshotRow[];
    decisions: SliceDecisionRow[];
    reviewEvents: ReviewEventRow[];
    evidence: EvidenceRow[];
  },
  window: TimeWindow
): LearningCenterOverview {
  const snapshots = input.snapshots.filter((s) => inWindow(s.occurredAt, window));
  const decisions = input.decisions.filter((d) => inWindow(d.occurredAt, window));
  const reviewEvents = input.reviewEvents.filter((r) => inWindow(r.occurredAt, window));
  const snapshotIds = new Set(snapshots.map((s) => s.id));
  const evidence = input.evidence.filter((e) => snapshotIds.has(e.extractionSnapshotId));

  return {
    generatedAt: new Date().toISOString(),
    window,
    volume: summarizeVolume(snapshots, decisions),
    decisionsByLayerStage: decisionsByLayerStage(decisions),
    decisionsByEngine: decisionsByEngine(decisions),
    sliceVsLegacy: sliceVsLegacyAgreement(decisions),
    outcomeByField: outcomeByField(decisions, reviewEvents),
    correctionByField: correctionRateByField(reviewEvents),
    confidenceByField: confidenceByField(decisions),
    coverageByField: coverageByField(decisions),
    producedByField: producedByField(decisions),
    amountSlice: amountSlicePerformance(decisions, reviewEvents),
    evidenceQuality: evidenceQualitySummary(snapshots, evidence),
    promotion: promotionReadiness(decisions, reviewEvents),
    engineHealth: engineHealthStub(decisions),
    trend: buildTrend(snapshots, reviewEvents),
  };
}
