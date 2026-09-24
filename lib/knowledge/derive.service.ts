/**
 * M4 · Derivation — running the catalogue for one business, once.
 *
 * WHAT THIS GUARANTEES, AND HOW
 *
 *   ONE TENANT           `businessId` is the caller's, server-derived, and it is what every load,
 *                        every write and every reconciliation is scoped to. Nothing here can widen.
 *   ONE LOAD PER SOURCE  Four payables rules describe the same settlement history. They get one
 *                        query between them, not four, and adding a fifth payables rule costs no
 *                        additional read at all.
 *   ONE CLOCK            `now` is captured once and passed to everything. Rules that each called
 *                        `new Date()` would disagree about their own window boundary by milliseconds,
 *                        which is invisible until the day it moves an observation across one.
 *   NO PARTIAL FAILURE   A rule that throws is reported as failed and the rest continue. One bad
 *                        vendor row must not be able to cost a tenant its entire knowledge layer.
 *   EVERYTHING IS SAID   Every rule in the catalogue appears in the report, including the ones that
 *                        declined. "INSUFFICIENT_EVIDENCE across nine rules" is a true and useful
 *                        description of a young business; nine silences are not.
 *
 * WHAT IT DELIBERATELY IS NOT
 *   Not a scheduler, not a queue, not a sweep over tenants. One business per call, invoked
 *   deliberately. Cadence is a decision about cost that nobody has enough information to make yet,
 *   and inventing the infrastructure for it before then would be the expensive way to find out.
 */
import { resolveDerivationPolicyVersion } from "@/lib/business-memory/policy";
import { knowledgeCatalogue } from "./registry";
import { writeMeasure } from "./measure-writer";
import { reconcileRuleMeasures } from "./measure-reconciler";
import type { MeasureResult } from "./measure.contract";
import type { AnyKnowledgeRule } from "./rule.contract";

/** What one measure looked like, reduced to what a report may carry. No values from the business. */
export type MeasureSummary = {
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly status: MeasureResult["status"];
  readonly valueNumeric: number | null;
  readonly valueUnit: string;
  readonly observationCount: number;
  readonly trend: string | null;
  readonly measureId: number;
  readonly evidenceRefs: number;
  readonly writerAction: "created" | "replaced";
};

export type RuleRunReport = {
  readonly ruleId: string;
  readonly domain: string;
  readonly measureKey: string;
  readonly ruleVersion: string;
  readonly entityType: string | null;
  readonly minSupport: number;
  readonly windowDays: number;
  readonly outcome: "ok" | "failed";
  /** Present only when `outcome` is "failed": which stage, never the underlying message. */
  readonly failedStage?: "policy" | "evidence" | "derive" | "write" | "reconcile";
  readonly failureDetail?: string;
  readonly active: number;
  readonly insufficient: number;
  readonly staled: number;
  readonly superseded: number;
  readonly measures: readonly MeasureSummary[];
  readonly durationMs: number;
};

export type DerivationReport = {
  readonly businessId: number;
  readonly now: string;
  readonly rulesRun: number;
  readonly rulesOk: number;
  readonly rulesFailed: number;
  readonly measuresActive: number;
  readonly measuresInsufficient: number;
  readonly measuresStaled: number;
  readonly measuresSuperseded: number;
  readonly sourcesLoaded: readonly { key: string; rows: number; durationMs: number }[];
  readonly rules: readonly RuleRunReport[];
  readonly totalDurationMs: number;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Load every distinct evidence source the catalogue needs, once each.
 *
 * A source that throws yields `undefined` rather than aborting, so the rules that depend on it fail
 * individually with a named stage while every other domain still derives. A tenant with one corrupt
 * purchase order should lose its supplier measures, not its paperwork habit.
 */
async function loadSources(
  rules: readonly AnyKnowledgeRule[],
  businessId: number,
  now: Date,
): Promise<{
  data: Map<string, readonly unknown[]>;
  errors: Map<string, string>;
  timings: { key: string; rows: number; durationMs: number }[];
}> {
  const distinct = new Map<string, AnyKnowledgeRule["source"]>();
  for (const rule of rules) distinct.set(rule.source.key, rule.source);

  const data = new Map<string, readonly unknown[]>();
  const errors = new Map<string, string>();
  const timings: { key: string; rows: number; durationMs: number }[] = [];

  for (const [key, source] of distinct) {
    const started = Date.now();
    try {
      const rows = await source.load(businessId, now);
      data.set(key, rows);
      timings.push({ key, rows: rows.length, durationMs: Date.now() - started });
    } catch (e) {
      errors.set(key, message(e));
      timings.push({ key, rows: -1, durationMs: Date.now() - started });
    }
  }
  return { data, errors, timings };
}

async function runOneRule(
  rule: AnyKnowledgeRule,
  businessId: number,
  now: Date,
  observations: readonly unknown[] | undefined,
  sourceError: string | undefined,
): Promise<RuleRunReport> {
  const started = Date.now();
  const d = rule.descriptor;
  const base = {
    ruleId: d.ruleId,
    domain: d.domain,
    measureKey: d.measureKey,
    ruleVersion: d.versionLabel,
    entityType: d.entityType,
    minSupport: d.minSupport,
    windowDays: d.windowDays,
    active: 0,
    insufficient: 0,
    staled: 0,
    superseded: 0,
    measures: [] as MeasureSummary[],
  };
  const failed = (
    stage: NonNullable<RuleRunReport["failedStage"]>,
    detail: string,
  ): RuleRunReport => ({
    ...base,
    outcome: "failed",
    failedStage: stage,
    failureDetail: detail,
    durationMs: Date.now() - started,
  });

  if (sourceError != null) return failed("evidence", sourceError);
  if (observations == null) return failed("evidence", "source produced no result");

  // Fail-closed on the version. A measure written without a resolved rule version would be an
  // artifact nobody can reproduce, which is worse than no artifact.
  let policyVersionId: number;
  try {
    policyVersionId = (
      await resolveDerivationPolicyVersion({ policyKey: d.policyKey, versionLabel: d.versionLabel })
    ).policyVersionId;
  } catch (e) {
    return failed("policy", message(e));
  }

  let results: MeasureResult[];
  try {
    results = rule.derive(observations, now);
  } catch (e) {
    return failed("derive", message(e));
  }

  const measures: MeasureSummary[] = [];
  let active = 0;
  let insufficient = 0;
  try {
    for (const result of results) {
      // The derivation is pure and cannot know the tenant from an empty sample, so the caller's
      // trusted businessId is authoritative for the evidence set's ownership. The writer then
      // re-checks every individual ref against it.
      const scoped: MeasureResult = {
        ...result,
        evidenceSet: { ...result.evidenceSet, businessId },
      };
      const write = await writeMeasure(businessId, scoped, policyVersionId);
      if (scoped.status === "ACTIVE") active += 1;
      if (scoped.status === "INSUFFICIENT_EVIDENCE") insufficient += 1;
      measures.push({
        entityType: scoped.entityType,
        entityId: scoped.entityId,
        status: scoped.status,
        valueNumeric: scoped.valueNumeric,
        valueUnit: scoped.valueUnit,
        observationCount: scoped.observationCount,
        trend: scoped.trend,
        measureId: write.measureId,
        evidenceRefs: write.evidenceLinkCount,
        writerAction: write.action,
      });
    }
  } catch (e) {
    return { ...failed("write", message(e)), active, insufficient, measures };
  }

  let staled = 0;
  let superseded = 0;
  try {
    const outcome = await reconcileRuleMeasures(
      businessId,
      d.measureKey,
      policyVersionId,
      results.map((r) => r.entityId),
    );
    staled = outcome.staled;
    superseded = outcome.superseded;
  } catch (e) {
    return { ...failed("reconcile", message(e)), active, insufficient, measures };
  }

  return {
    ...base,
    outcome: "ok",
    active,
    insufficient,
    staled,
    superseded,
    measures,
    durationMs: Date.now() - started,
  };
}

/**
 * Derive everything Dubiz can currently learn about one business.
 *
 * `now` is injectable so a replay can ask what the system would have said at a past instant, which is
 * what makes the rebuild proof meaningful: same business, same evidence, same `now`, same answer —
 * including the same evidence fingerprints.
 */
export async function deriveKnowledgeForBusiness(
  businessId: number,
  now: Date = new Date(),
): Promise<DerivationReport> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("deriveKnowledgeForBusiness: a positive, server-derived businessId is required");
  }
  const started = Date.now();
  const rules = knowledgeCatalogue();
  const { data, errors, timings } = await loadSources(rules, businessId, now);

  const reports: RuleRunReport[] = [];
  for (const rule of rules) {
    reports.push(
      await runOneRule(
        rule,
        businessId,
        now,
        data.get(rule.source.key),
        errors.get(rule.source.key),
      ),
    );
  }

  return {
    businessId,
    now: now.toISOString(),
    rulesRun: reports.length,
    rulesOk: reports.filter((r) => r.outcome === "ok").length,
    rulesFailed: reports.filter((r) => r.outcome === "failed").length,
    measuresActive: reports.reduce((s, r) => s + r.active, 0),
    measuresInsufficient: reports.reduce((s, r) => s + r.insufficient, 0),
    measuresStaled: reports.reduce((s, r) => s + r.staled, 0),
    measuresSuperseded: reports.reduce((s, r) => s + r.superseded, 0),
    sourcesLoaded: timings,
    rules: reports,
    totalDurationMs: Date.now() - started,
  };
}
