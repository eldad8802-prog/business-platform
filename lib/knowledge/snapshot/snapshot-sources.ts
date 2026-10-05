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
import { loadServedCustomers, TRUST_CLAIM_SELECT } from "@/lib/services/trust/trust-claim.service";
import { Prisma } from "@prisma/client";
import { computeEconomicRemaining } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import { authoritativeAllocationWhere, authoritativeCreditNoteWhere } from "@/lib/services/billing/domain/billing-allocation-authority";
import { computeExpectedPaymentDate, resolveCustomerPaymentTermsDays } from "@/lib/services/billing/collection/payment-terms";
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
      // STALE baselines too: "this subject has gone quiet" is knowledge (temporal interpretation).
      where: { businessId, status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY", "STALE"] } },
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

    // M9 — outcome learning: recommendations of the last year (or still live), each with the owner's
    // decisions and its live assessment. Ids, states, counts and dates only; the snapshot reduces them
    // to memory and patterns (lib/knowledge/outcomes/learn.ts).
    const outcomes = await tx.outcomeRecommendation.findMany({
      where: { businessId, OR: [{ status: "ACTIVE" }, { issuedAt: { gte: new Date(asOf.getTime() - 365 * DAY) } }], issuedAt: { lte: asOf } },
      select: {
        id: true, recommendationKey: true, version: true, type: true, family: true, subjectType: true, subjectId: true,
        targetCount: true, status: true, issuedAt: true, closedAt: true,
        decisions: { where: { decidedAt: { lte: asOf } }, select: { id: true, decision: true, decidedAt: true } },
        assessments: {
          where: { status: "ACTIVE" },
          select: { id: true, decisionState: true, actionState: true, outcomeState: true, direction: true, attribution: true, uncertainty: true, detail: true },
        },
      },
      orderBy: [{ recommendationKey: "asc" }, { version: "asc" }],
    });

    const { identityStatements, identityFacts } = await loadIdentityKnowledge(tx, businessId, asOf);
    const { trustClaims, servedCustomers } = await loadTrustKnowledge(tx, businessId, asOf);
    // Business Brain depth: memory, record links and the receivables window (same transaction).
    const depth = await loadDepth(tx, businessId, asOf);

    return { depth, measures, temporal, claims, vendorCategories, decisions, identity, proposals, installments, actions, outcomes, identityStatements, identityFacts, trustClaims, servedCustomers };
  });
}

/**
 * P2 — the owner's ACTIVE identity statements and identity-fact authorities, inside the caller's
 * tenant transaction. References and flags only:
 *   - statements: `text` is not selected, so an owner's free-text description cannot reach the snapshot
 *   - facts: the canonical value is compared with the approved hash INSIDE the database; only the
 *     boolean comes back, so no name, city, phone or email enters the snapshot
 */
export async function loadIdentityKnowledge(tx: Prisma.TransactionClient, businessId: number, asOf: Date) {
  const identityStatements = await tx.businessIdentityStatement.findMany({
    where: { businessId, status: "ACTIVE", createdAt: { lte: asOf } },
    select: {
      id: true, dimension: true, code: true, channel: true, source: true, sourceRef: true, status: true,
      confirmedByUserId: true, publicUseApproved: true, createdAt: true,
    },
    orderBy: [{ dimension: "asc" }, { id: "asc" }],
  });
  const identityFacts = await tx.$queryRaw<Array<{
    id: number; fact: string; sourceField: string; publicUseApproved: boolean;
    confirmedByUserId: number | null; confirmedAt: Date; valueCurrent: boolean;
  }>>`
    SELECT a."id", a."fact"::text AS "fact", a."sourceField", a."publicUseApproved", a."confirmedByUserId", a."confirmedAt",
           coalesce(a."valueHash" = encode(sha256(convert_to(
             CASE a."fact"::text
               WHEN 'BUSINESS_NAME'  THEN b."name"
               WHEN 'CITY'           THEN p."city"
               WHEN 'OPENING_HOURS'  THEN p."openingHours"
               WHEN 'PUBLIC_PHONE'   THEN p."billingPhone"
               WHEN 'PUBLIC_EMAIL'   THEN p."billingEmail"
               WHEN 'PUBLIC_ADDRESS' THEN p."billingAddress"
               WHEN 'PUBLIC_WHATSAPP' THEN w."displayPhoneNumber"
             END, 'UTF8')), 'hex'), false) AS "valueCurrent"
      FROM "BusinessIdentityFactAuthority" a
      JOIN "Business" b ON b."id" = a."businessId"
      LEFT JOIN "BusinessProfile" p ON p."businessId" = a."businessId"
      LEFT JOIN "WhatsAppConnection" w ON w."businessId" = a."businessId"
     WHERE a."businessId" = ${businessId} AND a."status" = 'ACTIVE' AND a."createdAt" <= ${asOf}
     ORDER BY a."fact", a."id"`;
  return { identityStatements, identityFacts };
}

/**
 * P3-A — the owner's ACTIVE trust claims, with the current served-customer evidence (p3.evidence.v1)
 * so assembly can tell which claims have lapsed. The private document reference is never selected.
 */
export async function loadTrustKnowledge(tx: Prisma.TransactionClient, businessId: number, asOf: Date) {
  const trustClaims = await tx.businessTrustClaim.findMany({
    where: { businessId, status: "ACTIVE", createdAt: { lte: asOf } },
    select: TRUST_CLAIM_SELECT,
    orderBy: [{ claimKind: "asc" }, { id: "asc" }],
  });
  const servedCustomers = trustClaims.some((c) => c.claimClass === "SAFE_FACTUAL") ? await loadServedCustomers(businessId, tx) : null;
  return { trustClaims, servedCustomers };
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

/* ══════════════════════ Business Brain · DEPTH ══════════════════════ */

/**
 * Business Brain · the DEPTH producers the snapshot reads — memory, record links and the receivables
 * window. Called INSIDE the snapshot's tenant transaction (`loadStoredKnowledge`), so every read is ONE
 * business's, with `businessId` named in every predicate as well.
 *
 * Nothing here is raw evidence or free text: aggregated counts, dates, statuses, typed ids and (for the
 * receivables window) one sum. A fixed number of queries, bounded by `take` where history can grow.
 *
 *   MEMORY        what Dubiz USED to know: STALE measures ("true until the subject went quiet") and
 *                 SUPERSEDED versions (replaced by a newer rule version), plus superseded temporal
 *                 baselines ("what normal used to be"). History is kept, never authoritative.
 *   RECORD LINKS  relationships the product's own foreign keys assert — customer ↔ invoices / payment
 *                 links / reminders / appointments / leads, service ↔ appointments, supplier ↔ item
 *                 (purchase-order lines). Never inferred from a name, phone, email or tax id.
 *   RECEIVABLES   issued invoices still owed whose due day falls in the next 30 days — the collection
 *                 screen's own definitions of "due" and "remaining", imported rather than restated.
 */
export const LINK_WINDOW_DAYS = 365;
export const RECEIVABLES_WINDOW_DAYS = 30;
const MEMORY_TAKE = 2000;
const BASELINE_TAKE = 500;

export type RecordLink = {
  /** What the foreign key says: e.g. "customer.invoices" = BillingDocument.customerId. */
  readonly relation: string;
  readonly left: { readonly type: string; readonly id: number };
  readonly right: { readonly type: string; readonly id: number } | null; // null = the domain records themselves
  readonly records: number;
  readonly lastAt: Date | null;
};

export async function loadDepth(tx: Prisma.TransactionClient, businessId: number, asOf: Date) {
  const since = new Date(asOf.getTime() - LINK_WINDOW_DAYS * DAY);
  const version = { select: { version: true, policy: { select: { key: true } } } } as const;

  /* MEMORY */
  const historicalMeasures = await tx.knowledgeMeasure.findMany({
    where: { businessId, status: { in: ["STALE", "SUPERSEDED"] }, windowEnd: { lte: asOf } },
    select: {
      id: true, measureKey: true, entityType: true, entityId: true, status: true, valueNumeric: true, valueUnit: true,
      observationCount: true, windowStart: true, windowEnd: true, evidenceFingerprint: true, policyVersion: version,
    },
    orderBy: [{ windowEnd: "desc" }, { id: "desc" }],
    take: MEMORY_TAKE,
  });
  const previousBaselines = await tx.temporalKnowledge.findMany({
    where: { businessId, knowledgeType: "BASELINE", status: "SUPERSEDED", supersededAt: { lte: asOf } },
    select: {
      id: true, temporalKey: true, domain: true, entityType: true, entityId: true, contextKey: true, valueKind: true, unit: true,
      historyStart: true, historyEnd: true, historyCount: true, baseline: true, supersededAt: true, evidenceFingerprint: true, policyVersion: version,
    },
    orderBy: [{ supersededAt: "desc" }, { id: "desc" }],
    take: BASELINE_TAKE,
  });

  /* RECORD LINKS — aggregated per entity, FK only */
  const links: RecordLink[] = [];
  const push = (relation: string, leftType: string, rows: { key: number | null; n: number; last: Date | null }[]) => {
    for (const r of rows) if (r.key !== null && r.n > 0) links.push({ relation, left: { type: leftType, id: r.key }, right: null, records: r.n, lastAt: r.last });
  };
  const invoices = await tx.billingDocument.groupBy({
    by: ["customerId"],
    where: { businessId, customerId: { not: null }, status: "ISSUED", documentType: { in: ["TAX_INVOICE", "TAX_INVOICE_RECEIPT"] }, issuedAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { issuedAt: true },
  });
  push("customer.invoices", "customer", invoices.map((g) => ({ key: g.customerId, n: g._count._all, last: g._max.issuedAt })));
  const requests = await tx.paymentRequest.groupBy({
    by: ["customerId"], where: { businessId, customerId: { not: null }, createdAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { createdAt: true },
  });
  push("customer.payment_links", "customer", requests.map((g) => ({ key: g.customerId, n: g._count._all, last: g._max.createdAt })));
  const reminders = await tx.collectionAction.groupBy({
    by: ["customerId"], where: { businessId, customerId: { not: null }, occurredAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { occurredAt: true },
  });
  push("customer.reminders", "customer", reminders.map((g) => ({ key: g.customerId, n: g._count._all, last: g._max.occurredAt })));
  const appts = await tx.appointment.groupBy({
    by: ["customerId"], where: { businessId, customerId: { not: null }, createdAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { createdAt: true },
  });
  push("customer.appointments", "customer", appts.map((g) => ({ key: g.customerId, n: g._count._all, last: g._max.createdAt })));
  const leads = await tx.lead.groupBy({
    by: ["customerId"], where: { businessId, customerId: { not: null }, createdAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { createdAt: true },
  });
  push("customer.leads", "customer", leads.map((g) => ({ key: g.customerId, n: g._count._all, last: g._max.createdAt })));
  const serviceAppts = await tx.appointment.groupBy({
    by: ["businessServiceId"], where: { businessId, businessServiceId: { not: null }, createdAt: { gte: since, lte: asOf } },
    _count: { _all: true }, _max: { createdAt: true },
  });
  push("business-service.appointments", "business-service", serviceAppts.map((g) => ({ key: g.businessServiceId, n: g._count._all, last: g._max.createdAt })));
  // supplier ↔ inventory item, as the business's own purchase orders state it (drafts and cancellations excluded)
  const supplied = await tx.$queryRaw<{ supplierId: number; itemId: number; n: number; last: Date | null }[]>`
    SELECT po."supplierId" AS "supplierId", l."itemId" AS "itemId", count(*)::int AS n, max(coalesce(po."orderDate", po."createdAt")) AS last
      FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" po ON po."id" = l."purchaseOrderId"
     WHERE po."businessId" = ${businessId} AND po."supplierId" IS NOT NULL AND l."itemId" IS NOT NULL
       AND po."status" NOT IN ('DRAFT', 'CANCELLED') AND coalesce(po."orderDate", po."createdAt") BETWEEN ${since} AND ${asOf}
     GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 2000`;
  for (const s of supplied) {
    links.push({ relation: "supplier.items", left: { type: "supplier", id: Number(s.supplierId) }, right: { type: "inventory-item", id: Number(s.itemId) }, records: Number(s.n), lastAt: s.last });
  }
  links.sort((a, b) => a.relation.localeCompare(b.relation) || a.left.id - b.left.id || (a.right?.id ?? 0) - (b.right?.id ?? 0));

  /* RECEIVABLES — due within the next 30 days, still owed */
  const profile = await tx.businessProfile.findUnique({ where: { businessId }, select: { billingPaymentTermsDays: true } });
  const open = await tx.billingDocument.findMany({
    where: { businessId, status: "ISSUED", documentType: "TAX_INVOICE", issuedAt: { gte: new Date(asOf.getTime() - 400 * DAY), lte: asOf } },
    select: {
      id: true, issuedAt: true, totalAmount: true, currency: true,
      customer: { select: { paymentTermsDays: true } },
      paymentAllocationsAsInvoice: { where: { businessId, ...authoritativeAllocationWhere(businessId) }, select: { allocatedAmount: true } },
      creditNotes: { where: { businessId, ...authoritativeCreditNoteWhere() }, select: { totalAmount: true } },
    },
    orderBy: [{ id: "asc" }],
    take: 5000,
  });
  const horizon = asOf.getTime() + RECEIVABLES_WINDOW_DAYS * DAY;
  let dueCount = 0;
  let dueSum = 0;
  let currency: string | null = null;
  const dueIds: number[] = [];
  for (const d of open) {
    const allocated = d.paymentAllocationsAsInvoice.reduce((s, a) => s.plus(a.allocatedAmount), new Prisma.Decimal(0));
    const credited = d.creditNotes.reduce((s, c) => s.plus(c.totalAmount), new Prisma.Decimal(0));
    const remaining = computeEconomicRemaining(d.totalAmount, allocated, credited);
    if (remaining.lessThanOrEqualTo(0)) continue;
    const due = computeExpectedPaymentDate(d.issuedAt, resolveCustomerPaymentTermsDays(d.customer?.paymentTermsDays ?? null, profile?.billingPaymentTermsDays ?? null));
    if (!due || due.getTime() < asOf.getTime() || due.getTime() > horizon) continue;
    dueCount += 1;
    dueSum += Number(remaining.toString());
    currency = currency ?? d.currency;
    dueIds.push(d.id);
  }
  const receivablesWindow = { days: RECEIVABLES_WINDOW_DAYS, invoices: dueCount, amount: Math.round(dueSum * 100) / 100, currency, invoiceIds: dueIds };

  return { historicalMeasures, previousBaselines, links, receivablesWindow };
}
