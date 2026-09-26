/**
 * M7 · The governed knowledge producers the snapshot reads — and the only file in lib/knowledge/snapshot
 * that queries.
 *
 * Every read is ONE business's, inside `tenantTx(businessId, …)`. Every select names its columns: no
 * `include` of a whole row, no names, phones, emails, free text, tax ids or payloads. What comes back is
 * already knowledge (measures, temporal artifacts, claims, decisions, identity) or authoritative domain
 * state reduced to counts and amounts (payables exposure, collection activity). Raw evidence stays in
 * the database; the snapshot carries references to it.
 *
 * Seven queries in one transaction for the stored knowledge, plus the two existing authoritative
 * engines (L0 facts, awaiting-payment) — a fixed number, independent of how much history exists.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";
import { loadAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.loader";

const DAY = 86_400_000;

export type StoredKnowledge = Awaited<ReturnType<typeof loadStoredKnowledge>>;

export async function loadStoredKnowledge(businessId: number, asOf: Date) {
  return tenantTx(businessId, async (tx) => {
    const version = { select: { version: true, policy: { select: { key: true } } } } as const;

    const measures = await tx.knowledgeMeasure.findMany({
      where: { businessId, status: { in: ["ACTIVE", "INSUFFICIENT_EVIDENCE"] } },
      select: {
        id: true, measureKey: true, entityType: true, entityId: true, status: true,
        valueNumeric: true, valueUnit: true, detail: true, observationCount: true,
        windowStart: true, windowEnd: true, trend: true, evidenceFingerprint: true,
        policyVersion: version,
      },
    });

    const temporal = await tx.temporalKnowledge.findMany({
      where: { businessId, status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY"] } },
      select: {
        id: true, temporalKey: true, domain: true, knowledgeType: true, status: true,
        entityType: true, entityId: true, contextKey: true, valueKind: true, unit: true, asOf: true,
        historyStart: true, recentEnd: true, historyCount: true, recentCount: true,
        baseline: true, recent: true, finding: true, reason: true, evidenceFingerprint: true, confirmedAt: true,
        policyVersion: version,
      },
    });

    const claims = await tx.derivedClaimProjection.findMany({
      where: { businessId },
      select: {
        id: true, subjectDomain: true, subjectNormalizedKey: true, claimType: true, evidenceSetFingerprint: true,
        materializedAt: true, policyVersion: version,
        candidates: { select: { id: true, propositionValue: true } },
      },
    });

    // The owner's own category per learned vendor (set at approval) — the authority a derived
    // category claim is measured against.
    const vendorCategories = await tx.vendorLearning.findMany({
      where: { businessId, vendorNameNormalized: { not: null } },
      select: { id: true, vendorNameNormalized: true, category: true },
    });

    const decisions = await tx.businessInsight.findMany({
      where: { businessId, status: { in: ["ADOPTED", "DISMISSED"] } },
      select: { id: true, insightKey: true, status: true, ownerDecisionAt: true, composerVersion: true },
    });

    // Identity: only claims that bind by AUTHORITY — an owner's confirmation, or a tax id. SELF_ANCHOR
    // says nothing about another subject, and the older Party engine's PHONE binding (confidence
    // BELIEVED, also recorded as DETERMINISTIC_EXACT) is a resemblance, not identity.
    const identity = await tx.partyResolutionClaim.findMany({
      where: {
        businessId, status: "ACTIVE",
        OR: [{ method: "OWNER_CONFIRMED" }, { method: "DETERMINISTIC_EXACT", signalType: "TAX_ID" }],
      },
      select: { id: true, partyId: true, subjectType: true, subjectId: true, method: true },
    });

    const proposals = await tx.entityLinkProposal.findMany({
      where: { businessId, state: { in: ["PROPOSED", "REJECTED"] } },
      select: { id: true, subjectType: true, subjectId: true, candidatePartyId: true, state: true, signalType: true },
    });

    // Payables exposure per payee — the M1 definition of "unpaid": SCHEDULED installments not fully
    // covered by an unreversed allocation on a RECORDED payment. Aggregated here; no titles, no names.
    const installments = await tx.installment.findMany({
      where: { businessId, status: "SCHEDULED", commitment: { payeeId: { not: null } } },
      select: {
        id: true, dueAt: true, scheduledAmount: true, currency: true,
        commitment: { select: { payeeId: true } },
        allocations: {
          where: { reversedAt: null, payment: { status: "RECORDED" } },
          select: { allocatedAmount: true },
        },
      },
    });

    // Owner-initiated reminders in the last 90 days, per customer.
    const actions = await tx.collectionAction.findMany({
      where: { businessId, customerId: { not: null }, occurredAt: { gte: new Date(asOf.getTime() - 90 * DAY), lte: asOf } },
      select: { id: true, customerId: true, occurredAt: true, channel: true },
    });

    return { measures, temporal, claims, vendorCategories, decisions, identity, proposals, installments, actions };
  });
}

/**
 * The two existing authoritative engines. L0 facts are evaluated by their own engine at build time;
 * the awaiting-payment list is evaluated AS OF the snapshot instant. Only structured fields are kept.
 */
export async function loadDomainState(businessId: number, asOf: Date) {
  const facts = await runWithTenantContext({ businessId }, () => getBusinessStatusSnapshot(businessId));
  const awaiting = await loadAwaitingPaymentList(businessId, asOf);
  return {
    facts: facts.items.map((i) => ({
      itemId: i.itemId, domain: i.domain, sourceEngine: i.sourceEngine, semanticCategory: i.semanticCategory,
      severity: i.severity, entityRef: i.entityRef, relatedRefs: i.relatedRefs ?? [],
      moneyImpactBand: i.moneyImpactBand ?? null, blocking: i.blocking ?? false, createdAt: i.createdAt,
    })),
    awaiting: awaiting.customers.map((c) => ({
      customerId: c.customerId,
      totalOutstanding: c.totalOutstanding.toString(),
      currency: c.currency,
      invoiceCount: c.invoices.length,
      invoiceIds: c.invoices.map((i) => i.id),
      maxDaysAwaiting: c.maxDaysAwaiting,
      awaitingSince: c.awaitingSince,
    })),
    unassignedAwaitingCount: awaiting.unassignedCount,
  };
}

export type DomainState = Awaited<ReturnType<typeof loadDomainState>>;
