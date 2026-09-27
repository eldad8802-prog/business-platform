/**
 * M6 · Temporal derivation for ONE business, AS OF one instant.
 *
 * Same guarantees as the M4 service it sits beside: one tenant (server-derived), one clock reading
 * passed down, one load per evidence source, a failing rule reported by stage and never by content,
 * and a report that carries counts and outcomes — no values, no entity ids, no evidence.
 *
 * `asOf` is explicit and injectable. A rebuild at the same asOf over the same evidence produces the
 * same artifacts and fingerprints; the writer then confirms instead of appending.
 */
import { resolveDerivationPolicyVersion } from "@/lib/business-memory/policy";
import { assessNumeric, assessRate } from "./engine";
import { temporalCatalogue, type AnyTemporalRule } from "./rules";
import { writeTemporalKnowledge, type TemporalSlotArtifact } from "./temporal-writer";

export type TemporalRuleReport = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly outcome: "ok" | "failed";
  readonly failedStage?: "policy" | "evidence" | "assess" | "write";
  readonly series: number;
  /** knowledgeType → status → count. Counts only. */
  readonly artifacts: Record<string, Record<string, number>>;
  readonly written: number;
  readonly confirmed: number;
  readonly superseded: number;
  readonly staled: number;
  readonly durationMs: number;
};

export type TemporalDerivationReport = {
  readonly asOf: string;
  readonly rulesRun: number;
  readonly rulesOk: number;
  readonly rulesFailed: number;
  readonly rules: readonly TemporalRuleReport[];
  readonly totalDurationMs: number;
};

function artifactsFor(rule: AnyTemporalRule, observations: readonly unknown[], asOf: Date): TemporalSlotArtifact[] {
  const out: TemporalSlotArtifact[] = [];
  for (const s of rule.series(observations)) {
    const produced =
      s.kind === "rate"
        ? assessRate(s.points, rule.spec, asOf)
        : assessNumeric(s.points, rule.spec, asOf, { lastEventAt: s.lastEventAt ?? null });
    for (const a of produced) {
      const reason =
        a.reason && s.fallbackContextKey !== undefined
          ? { ...a.reason, fallbackContextKey: s.fallbackContextKey }
          : a.reason;
      out.push({ ...a, reason, entityType: s.entityType, entityId: s.entityId, contextKey: s.contextKey });
    }
  }
  return out;
}

export async function deriveTemporalForBusiness(
  businessId: number,
  asOf: Date = new Date(),
): Promise<TemporalDerivationReport> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("deriveTemporalForBusiness: a positive, server-derived businessId is required");
  }
  const started = Date.now();
  const rules = temporalCatalogue();

  // One load per distinct source; a failing source fails only its own rules.
  const data = new Map<string, readonly unknown[]>();
  const errors = new Set<string>();
  for (const r of rules) {
    if (data.has(r.source.key) || errors.has(r.source.key)) continue;
    try {
      data.set(r.source.key, await r.source.load(businessId, asOf));
    } catch {
      errors.add(r.source.key);
    }
  }

  const reports: TemporalRuleReport[] = [];
  for (const rule of rules) {
    const t0 = Date.now();
    const base = {
      ruleId: rule.ruleId, ruleVersion: rule.versionLabel, series: 0,
      artifacts: {} as Record<string, Record<string, number>>,
      written: 0, confirmed: 0, superseded: 0, staled: 0,
    };
    const fail = (stage: NonNullable<TemporalRuleReport["failedStage"]>): TemporalRuleReport =>
      ({ ...base, outcome: "failed", failedStage: stage, durationMs: Date.now() - t0 });

    const observations = data.get(rule.source.key);
    if (errors.has(rule.source.key) || !observations) { reports.push(fail("evidence")); continue; }

    let versionId: number;
    try {
      versionId = (await resolveDerivationPolicyVersion({ policyKey: rule.policyKey, versionLabel: rule.versionLabel }))
        .policyVersionId;
    } catch { reports.push(fail("policy")); continue; }

    let artifacts: TemporalSlotArtifact[];
    try {
      artifacts = artifactsFor(rule, observations, asOf);
    } catch { reports.push(fail("assess")); continue; }

    const counts: Record<string, Record<string, number>> = {};
    for (const a of artifacts) {
      counts[a.knowledgeType] ??= {};
      counts[a.knowledgeType][a.status] = (counts[a.knowledgeType][a.status] ?? 0) + 1;
    }
    try {
      const w = await writeTemporalKnowledge({
        businessId, temporalKey: rule.temporalKey, domain: rule.domain, rulePolicyVersionId: versionId,
        valueKind: rule.spec.valueKind, unit: rule.spec.unit, asOf, artifacts,
      });
      reports.push({
        ...base, outcome: "ok", series: new Set(artifacts.map((a) => `${a.entityType}|${a.entityId}|${a.contextKey}`)).size,
        artifacts: counts, ...w, durationMs: Date.now() - t0,
      });
    } catch { reports.push({ ...fail("write"), artifacts: counts }); }
  }

  return {
    asOf: asOf.toISOString(),
    rulesRun: reports.length,
    rulesOk: reports.filter((r) => r.outcome === "ok").length,
    rulesFailed: reports.filter((r) => r.outcome === "failed").length,
    rules: reports,
    totalDurationMs: Date.now() - started,
  };
}
