/**
 * M3 · The insight seam: gather this business's knowledge, compose, persist, and record the decision.
 *
 * The three rules this file enforces, which the composer cannot enforce for itself:
 *   1. only ACTIVE measures are ever handed to a composer;
 *   2. everything is scoped to ONE businessId, established once, at the top;
 *   3. the owner's decision is durable, attributed, and never inferred from a UI state.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";
import {
  composeInsights,
  COMPOSER_VERSION,
  type ComposerInput,
  type InsightDraft,
} from "./insight-composer";

export type GeneratedInsight = { id: number; insightKey: string; action: "created" | "refreshed" };

/**
 * Generate this business's insights.
 *
 * `refreshInPlace` is what keeps a dismissal meaningful: re-running the composer updates the existing
 * row for the same situation rather than creating a new one, so an owner who dismissed something does
 * not meet it again tomorrow wearing a different id. A refresh deliberately does NOT reopen a decided
 * insight — deciding is the owner's, and re-deciding is theirs to initiate too.
 */
export async function generateInsightsForBusiness(
  businessId: number,
): Promise<GeneratedInsight[]> {
  return runWithTenantContext({ businessId }, async () => {
    const snapshot = await getBusinessStatusSnapshot(businessId);

    // ACTIVE only. This is the gate that keeps "we don't know yet" out of everything downstream: an
    // INSUFFICIENT_EVIDENCE measure is a real, stored result, and it is deliberately invisible here.
    const measures = await tenantTx(businessId, (tx) =>
      tx.knowledgeMeasure.findMany({
        where: { businessId, status: "ACTIVE" },
        select: {
          id: true, measureKey: true, valueNumeric: true, valueUnit: true,
          observationCount: true, trend: true,
          policyVersion: { select: { version: true } },
        },
      }),
    );

    const input: ComposerInput = {
      businessId,
      facts: snapshot.items,
      activeMeasures: measures.map((m) => ({
        measureKey: m.measureKey,
        valueNumeric: Number(m.valueNumeric),
        valueUnit: m.valueUnit,
        observationCount: m.observationCount,
        trend: m.trend,
        ruleVersion: m.policyVersion.version,
        measureId: m.id,
      })),
    };

    const drafts = composeInsights(input);
    const out: GeneratedInsight[] = [];
    for (const draft of drafts) out.push(await persistDraft(businessId, draft));
    return out;
  });
}

async function persistDraft(businessId: number, draft: InsightDraft): Promise<GeneratedInsight> {
  return tenantTx(businessId, async (tx) => {
    const existing = await tx.businessInsight.findUnique({
      where: { businessId_dedupeKey: { businessId, dedupeKey: draft.dedupeKey } },
      select: { id: true, status: true },
    });

    const content = {
      insightKey: draft.insightKey,
      severity: draft.severity,
      title: draft.title,
      factLines: draft.factLines as unknown as object,
      interpretation: draft.interpretation,
      uncertainty: draft.uncertainty,
      contributingRules: draft.contributingRules as unknown as object,
      suggestedActions: draft.suggestedActions as unknown as object,
      generatedAt: new Date(),
      composerVersion: COMPOSER_VERSION,
    };

    if (!existing) {
      const created = await tx.businessInsight.create({
        data: { businessId, dedupeKey: draft.dedupeKey, ...content },
        select: { id: true },
      });
      return { id: created.id, insightKey: draft.insightKey, action: "created" as const };
    }

    // Content is refreshed; the DECISION is not touched. The owner's answer outlives the wording.
    await tx.businessInsight.update({ where: { id: existing.id }, data: content });
    return { id: existing.id, insightKey: draft.insightKey, action: "refreshed" as const };
  });
}

export type OwnerDecision = "ADOPTED" | "DISMISSED";

/**
 * Record what the owner decided.
 *
 * Durable, attributed, and timestamped — the thing this codebase does almost nowhere else. A dismissal
 * is recorded with exactly the same weight as an adoption: a system that only stores agreement learns
 * half of what it is being told, and the half it discards is the half that says "you are wrong".
 *
 * `userId` must be server-derived. It is the only actor claim this row will ever have.
 */
export async function recordOwnerDecision(
  businessId: number,
  insightId: number,
  decision: OwnerDecision,
  userId: number,
  note?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { ok: false, reason: "a server-derived userId is required" };
  }
  return tenantTx(businessId, async (tx) => {
    // The tenant predicate is kept alongside the GUC deliberately: the database's guarantee and the
    // application's should agree, and a decision written onto another tenant's insight is not the
    // failure mode to discover later.
    const updated = await tx.businessInsight.updateMany({
      where: { id: insightId, businessId },
      data: {
        status: decision,
        ownerDecisionAt: new Date(),
        ownerDecisionByUserId: userId,
        ownerDecisionNote: note ?? null,
      },
    });
    return updated.count === 1 ? { ok: true } : { ok: false, reason: "insight not found for this business" };
  });
}

/** Open insights for a business, newest first. ACTIVE knowledge only ever produced these. */
export async function listOpenInsights(businessId: number) {
  return tenantTx(businessId, (tx) =>
    tx.businessInsight.findMany({
      where: { businessId, status: "OPEN" },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    }),
  );
}
