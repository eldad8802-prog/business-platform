/**
 * The internal contract future layers (M7) consume: "for business X, what does Dubiz currently know?"
 *
 * ONE business, server-derived, read inside its own tenant transaction. It returns the knowledge
 * exactly as it is stored — measures and temporal knowledge side by side, each with its rule, version,
 * window, evidence fingerprint and status. It does NOT combine domains, rank, interpret or explain:
 * that is M7's job, and doing any of it here would smuggle conclusions into a read.
 *
 * Only ACTIVE knowledge is "current". INSUFFICIENT_HISTORY is returned separately when asked for,
 * because "we do not know yet" is itself something a consumer may need to say.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type KnowledgeSelection = {
  readonly businessId: number;
  readonly measures: readonly {
    readonly measureKey: string;
    readonly entityType: string | null;
    readonly entityId: number | null;
    readonly valueNumeric: string;
    readonly valueUnit: string;
    readonly observationCount: number;
    readonly windowStart: Date;
    readonly windowEnd: Date;
    readonly trend: string | null;
    readonly detail: unknown;
    readonly ruleVersion: string;
    readonly policyKey: string;
    readonly evidenceFingerprint: string;
    readonly materializedAt: Date;
  }[];
  readonly temporal: readonly {
    readonly temporalKey: string;
    readonly domain: string;
    readonly knowledgeType: string;
    readonly status: string;
    readonly entityType: string | null;
    readonly entityId: number | null;
    readonly contextKey: string;
    readonly valueKind: string;
    readonly unit: string;
    readonly asOf: Date;
    readonly historyStart: Date;
    readonly historyEnd: Date;
    readonly recentStart: Date | null;
    readonly recentEnd: Date | null;
    readonly historyCount: number;
    readonly recentCount: number;
    readonly baseline: unknown;
    readonly recent: unknown;
    readonly finding: unknown;
    readonly reason: unknown;
    readonly ruleVersion: string;
    readonly policyKey: string;
    readonly evidenceFingerprint: string;
    readonly confirmedAt: Date;
  }[];
};

export async function selectCurrentKnowledge(
  businessId: number,
  opts: { includeInsufficient?: boolean } = {},
): Promise<KnowledgeSelection> {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("selectCurrentKnowledge: bad businessId");
  const temporalStatuses = opts.includeInsufficient ? ["ACTIVE", "INSUFFICIENT_HISTORY"] : ["ACTIVE"];
  return tenantTx(businessId, async (tx) => {
    const [measures, temporal] = await Promise.all([
      tx.knowledgeMeasure.findMany({
        where: { businessId, status: "ACTIVE" },
        orderBy: [{ measureKey: "asc" }, { entityId: "asc" }, { id: "asc" }],
        include: { policyVersion: { select: { version: true, policy: { select: { key: true } } } } },
      }),
      tx.temporalKnowledge.findMany({
        where: { businessId, status: { in: temporalStatuses as ("ACTIVE" | "INSUFFICIENT_HISTORY")[] } },
        orderBy: [{ temporalKey: "asc" }, { entityId: "asc" }, { contextKey: "asc" }, { knowledgeType: "asc" }, { id: "asc" }],
        include: { policyVersion: { select: { version: true, policy: { select: { key: true } } } } },
      }),
    ]);
    return {
      businessId,
      measures: measures.map((m) => ({
        measureKey: m.measureKey, entityType: m.entityType, entityId: m.entityId,
        valueNumeric: m.valueNumeric.toString(), valueUnit: m.valueUnit, observationCount: m.observationCount,
        windowStart: m.windowStart, windowEnd: m.windowEnd, trend: m.trend, detail: m.detail,
        ruleVersion: m.policyVersion.version, policyKey: m.policyVersion.policy.key,
        evidenceFingerprint: m.evidenceFingerprint, materializedAt: m.materializedAt,
      })),
      temporal: temporal.map((t) => ({
        temporalKey: t.temporalKey, domain: t.domain, knowledgeType: t.knowledgeType, status: t.status,
        entityType: t.entityType, entityId: t.entityId, contextKey: t.contextKey,
        valueKind: t.valueKind, unit: t.unit, asOf: t.asOf,
        historyStart: t.historyStart, historyEnd: t.historyEnd, recentStart: t.recentStart, recentEnd: t.recentEnd,
        historyCount: t.historyCount, recentCount: t.recentCount,
        baseline: t.baseline, recent: t.recent, finding: t.finding, reason: t.reason,
        ruleVersion: t.policyVersion.version, policyKey: t.policyVersion.policy.key,
        evidenceFingerprint: t.evidenceFingerprint, confirmedAt: t.confirmedAt,
      })),
    };
  });
}
