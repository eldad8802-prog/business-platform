/**
 * M4 · The evidence sources — every place the knowledge layer reads a business's data.
 *
 * ALL OF IT IS HERE. There is no other file in `lib/knowledge` that opens a query, and that is the
 * property the whole milestone's tenant safety rests on: one file to audit, every function in it
 * wrapped in `tenantTx`, and a CI guard that fails if any of these tables is ever reached through the
 * global Prisma client instead.
 *
 * WINDOW-BOUNDED, NOT WHOLE-HISTORY. Each source filters to its rules' window in SQL. DOC-04 shipped
 * loading a tenant's entire `FinancialRecord` history and discarding most of it in memory, which was
 * fine at twenty-four rows and would not have been at twenty-four thousand. The rules filter again to
 * the same window, so the two must agree — the battery asserts that a bounded load and an unbounded
 * one produce an identical fingerprint.
 *
 * NOTHING HERE INTERPRETS. A loader's job is to turn rows into the small, named observation types the
 * rules declare, dropping what a rule may not see. Where a decision looks like judgement — which date
 * counts, what "short" means — it is stated in the observation type's own documentation, next to the
 * rule that depends on it.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { DAY_MS } from "../rule.contract";
import type { SettlementObservation } from "../rules/payables";
import type { MovementObservation, AlertObservation } from "../rules/inventory";
import type {
  SupplierOrderObservation,
  SupplierDeliveryObservation,
} from "../rules/suppliers";
import type { VendorDocumentObservation, ReviewObservation } from "../rules/documents";
import type { PaperworkObservation } from "../rules/documents-paperwork-lag";
import { civilDateInZone, DEFAULT_BUSINESS_TIME_ZONE, toDayNumber } from "@/lib/services/business-cost/business-cost-core";
import { loadBusinessCostInputs } from "@/lib/services/business-cost/business-cost.service";
import { COST_SOURCE_WINDOW_DAYS, type CostAuditEvent, type CostLedgerSnapshot } from "@/lib/knowledge/rules/cost";
import {
  resolveSettlement, toCents,
  type CoverageEvent, type IncomeDocumentObservation, type PaymentRequestObservation, type QuoteObservation,
} from "../rules/income";
import { computeExpectedPaymentDate, resolveCustomerPaymentTermsDays } from "@/lib/services/billing/collection/payment-terms";
import { authoritativeAllocationWhere, authoritativeCreditNoteWhere } from "@/lib/services/billing/domain/billing-allocation-authority";
import {
  openingOf,
  type ConversationOpeningObservation, type FollowUpObservation, type LeadObservation,
} from "../rules/funnel";
import {
  ACCOUNTANT_EXPORT_KINDS,
  type ActObservation, type AppointmentObservation, type DemandSignalObservation, type HandledInstallmentObservation,
  type ObligationObservation,
} from "../rules/operations";

function startOf(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * DAY_MS);
}

/* ══════════════════════════════ PAYABLES ══════════════════════════════ */

/**
 * Settled installments: what was due, and when it was actually paid.
 *
 * THE FOUR PREDICATES THAT MAKE THIS EVIDENCE RATHER THAN DATA
 *   `reversedAt: null`            — a reversed allocation is the system being told it was wrong
 *   `payment.status: RECORDED`    — a voided payment settled nothing
 *   `installment.status: SCHEDULED` — excludes CANCELLED, and excludes SETTLED_LEGACY, which was
 *                                   backfilled from the pre-ledger model as an owner's recollection
 *                                   with no allocation behind it
 *   `paidAt` inside the window    — bounded in SQL, on an index that already exists
 *
 * `externallyBacked` is computed from the payment's unrevoked evidence. It asks only whether anything
 * beyond the owner's own assertion exists — NOT whether a bank settled anything. There is no bank
 * feed in this system today, so even a BANK_TRANSACTION evidence row began life as a statement line
 * the owner uploaded. The measure that consumes this is named accordingly.
 */
export async function loadSettlements(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<SettlementObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.paymentAllocation.findMany({
      where: {
        businessId,
        reversedAt: null,
        payment: { status: "RECORDED", paidAt: { gte: startOf(now, windowDays), lte: now } },
        installment: { status: "SCHEDULED" },
      },
      orderBy: [{ id: "asc" }],
      select: {
        id: true,
        businessId: true,
        payment: {
          select: {
            paidAt: true,
            payeeId: true,
            evidences: { where: { revokedAt: null }, select: { kind: true } },
          },
        },
        installment: { select: { dueAt: true } },
      },
    }),
  );

  return rows.map((r) => ({
    recordId: r.id,
    businessId: r.businessId,
    at: r.payment.paidAt,
    expectedAt: r.installment.dueAt,
    payeeId: r.payment.payeeId,
    // AP-06 v2 — a CHEQUE evidence is the owner asserting the cheque cleared (`clearedSource` is
    // always OWNER_ASSERTED; there is no bank-observed path). It is the same authority as MANUAL, and
    // v1 counting it as "backed" overstated the record. DOCUMENT, BANK_TRANSACTION and
    // PAYMENT_PROVIDER each point at a record that exists independently of the owner saying so.
    externallyBacked: r.payment.evidences.some((e) => e.kind !== "MANUAL" && e.kind !== "CHEQUE"),
  }));
}

/* ══════════════════════════════ INVENTORY ══════════════════════════════ */

export async function loadMovements(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<MovementObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.inventoryMovement.findMany({
      where: { businessId, createdAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        businessId: true,
        createdAt: true,
        itemId: true,
        movementType: true,
        reason: true,
      },
    }),
  );
  return rows.map((r) => ({
    recordId: r.id,
    businessId: r.businessId,
    at: r.createdAt,
    itemId: r.itemId,
    movementType: r.movementType,
    reason: r.reason,
  }));
}

/**
 * Alerts, at the moment they were RAISED.
 *
 * `isResolved` is deliberately not filtered on: the measure counts how often an item came under
 * pressure, and an alert the owner has since cleared still happened. Resolution latency would be the
 * more interesting measure and is not available — `InventoryAlert.resolvedAt` exists in the schema
 * and no code has ever written it, so every resolved alert claims to have been resolved at no
 * particular time. That gap is recorded rather than worked around.
 */
export async function loadAlerts(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<AlertObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.inventoryAlert.findMany({
      where: {
        businessId,
        itemId: { not: null },
        createdAt: { gte: startOf(now, windowDays), lte: now },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, businessId: true, createdAt: true, itemId: true, type: true },
    }),
  );
  return rows.flatMap((r) =>
    r.itemId == null
      ? []
      : [{
          recordId: r.id,
          businessId: r.businessId,
          at: r.createdAt,
          itemId: r.itemId,
          alertType: r.type,
        }],
  );
}

/* ══════════════════════════════ SUPPLIERS ══════════════════════════════ */

/**
 * Purchase orders placed with an IDENTIFIED supplier.
 *
 * `supplierId: { not: null }` is the line that keeps this honest. Orders carrying only a free-text
 * `supplierName` are dropped, not grouped by that name — see the header of the suppliers rules for
 * why that is the whole point rather than a limitation.
 */
export async function loadSupplierOrders(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<SupplierOrderObservation[]> {
  const from = startOf(now, windowDays);
  const rows = await tenantTx(businessId, (tx) =>
    tx.purchaseOrder.findMany({
      where: {
        businessId,
        supplierId: { not: null },
        // A DRAFT was never placed and a CANCELLED order was withdrawn: neither is a purchase the
        // business made, and counting them would invent beats in a rhythm that never happened.
        status: { notIn: ["DRAFT", "CANCELLED"] },
        // Either the owner's own order date is in the window, or there is none and the row's creation
        // is. Expressed as an OR rather than a COALESCE so the existing indexes can still be used.
        OR: [
          { orderDate: { gte: from, lte: now } },
          { orderDate: null, createdAt: { gte: from, lte: now } },
        ],
      },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, supplierId: true, orderDate: true, createdAt: true },
    }),
  );
  return rows.flatMap((r) =>
    r.supplierId == null
      ? []
      : [{
          recordId: r.id,
          businessId: r.businessId,
          at: r.orderDate ?? r.createdAt,
          supplierId: r.supplierId,
          datedFromCreation: r.orderDate == null,
        }],
  );
}

/**
 * Finished orders: how long they took, and whether everything turned up.
 *
 * CLOSED only. `settlePurchaseOrderStatus` moves an order to CLOSED when receiving has settled it, so
 * CLOSED is the system's own statement that this order is done — which is exactly the precondition
 * for asking how long it took or whether it was complete. An order still awaiting delivery is not
 * late and is not short; it is unfinished, and either answer would be an invention.
 *
 * A line is SHORT when everything received against it, across every posted session, still falls below
 * what was ordered. The epsilon is there because these are floats and a 3.0 delivered against a 3.0
 * ordered must never register as 0.0000000004 missing.
 */
const QTY_EPSILON = 1e-6;

export async function loadSupplierDeliveries(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<SupplierDeliveryObservation[]> {
  const from = startOf(now, windowDays);
  const rows = await tenantTx(businessId, (tx) =>
    tx.purchaseOrder.findMany({
      where: {
        businessId,
        supplierId: { not: null },
        status: "CLOSED",
        orderDate: { not: null },
        // SUPP-02/03 v2 — an order created by approving a supplier-purchase draft is created CONFIRMED
        // and received in full in ONE transaction (supplier-purchase-approval.service.ts). Its "lead
        // time" is always zero and it can never be short, so it says nothing about the supplier and
        // v1 counting it pulled both measures towards "instant and complete".
        sourceSupplierPurchaseDraftId: null,
        // Bounded in SQL like every other source. An order's observation time is its LAST posted
        // receipt, so an order finishing inside the window has at least one receipt inside it; the
        // superset this admits is trimmed to the exact window by the rules.
        receivingSessions: { some: { status: "POSTED", receivedAt: { gte: from, lte: now } } },
      },
      orderBy: [{ id: "asc" }],
      select: {
        id: true,
        businessId: true,
        supplierId: true,
        orderDate: true,
        lines: {
          select: {
            id: true,
            orderedQty: true,
            status: true,
            receivingLines: {
              where: { receivingSession: { status: "POSTED" } },
              select: { receivedQty: true },
            },
          },
        },
        receivingSessions: {
          where: { status: "POSTED", receivedAt: { not: null } },
          select: { receivedAt: true },
        },
      },
    }),
  );

  return rows.flatMap((po) => {
    if (po.supplierId == null || po.orderDate == null) return [];
    const received = po.receivingSessions
      .map((s) => s.receivedAt)
      .filter((d): d is Date => d != null);
    if (received.length === 0) return [];
    const finishedAt = received.reduce((a, b) => (a > b ? a : b));

    // A cancelled line was never expected to arrive, so it cannot be short.
    const live = po.lines.filter((l) => l.status !== "CANCELLED");
    const linesShort = live.filter(
      (l) => l.receivingLines.reduce((s, rl) => s + rl.receivedQty, 0) + QTY_EPSILON < l.orderedQty,
    ).length;

    return [{
      recordId: po.id,
      businessId: po.businessId,
      at: finishedAt,
      expectedAt: po.orderDate,
      supplierId: po.supplierId,
      linesOrdered: live.length,
      linesShort,
    }];
  });
}

/* ══════════════════════════════ DOCUMENTS ══════════════════════════════ */

/** DOC-04's evidence, now bounded in SQL rather than filtered in memory. */
export async function loadPaperwork(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<PaperworkObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.financialRecord.findMany({
      where: { businessId, approvedAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      select: { id: true, businessId: true, date: true, approvedAt: true },
    }),
  );
  return rows.map((r) => ({
    recordId: r.id,
    businessId: r.businessId,
    documentDate: r.date,
    approvedAt: r.approvedAt,
  }));
}

/**
 * M6 · DOC-04's evidence plus the document's direction, for the temporal rule's context slices.
 *
 * A separate loader rather than a new field on DOC-04's observation, so the M2/M4 rule and its
 * fingerprints stay exactly as they were. Same predicate, same window semantics.
 */
export type PaperworkWithDirection = {
  readonly recordId: number;
  readonly businessId: number;
  readonly documentDate: Date;
  readonly approvedAt: Date;
  readonly direction: string;
};

export async function loadPaperworkWithDirection(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<PaperworkWithDirection[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.financialRecord.findMany({
      where: { businessId, approvedAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      select: { id: true, businessId: true, date: true, approvedAt: true, direction: true },
    }),
  );
  return rows.map((r) => ({
    recordId: r.id,
    businessId: r.businessId,
    documentDate: r.date,
    approvedAt: r.approvedAt,
    direction: r.direction,
  }));
}

/**
 * Approved documents, attributed to a RESOLVED vendor identity.
 *
 * The join that makes DOC-02 and DOC-05 possible, and the reason M4 and M5 are one milestone:
 *
 *   FinancialRecord.vendorName  →  VendorLearning (unique per business+name)
 *                               →  PartyResolutionClaim (subject DOCUMENT_VENDOR)
 *                               →  Party
 *
 * A vendor name with no `VendorLearning` row, or one the identity layer has not anchored, yields NO
 * observation. That is the design: a per-vendor habit exists only for a vendor Dubiz has actually
 * resolved, and never for a spelling.
 *
 * Only ACTIVE claims count. A claim the owner retracted stops contributing immediately, which is how
 * an identity rejection invalidates the knowledge built on it.
 */
export async function loadVendorDocuments(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<VendorDocumentObservation[]> {
  return tenantTx(businessId, async (tx) => {
    const records = await tx.financialRecord.findMany({
      where: { businessId, date: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, date: true, vendorName: true, amount: true, direction: true },
    });
    if (records.length === 0) return [];

    const vendors = await tx.vendorLearning.findMany({
      where: { businessId, vendorName: { in: [...new Set(records.map((r) => r.vendorName))] } },
      select: { id: true, vendorName: true },
    });
    if (vendors.length === 0) return [];

    const claims = await tx.partyResolutionClaim.findMany({
      where: {
        businessId,
        status: "ACTIVE",
        subjectType: "DOCUMENT_VENDOR",
        subjectId: { in: vendors.map((v) => v.id) },
      },
      select: { subjectId: true, partyId: true },
    });

    const partyOfVendorRow = new Map(claims.map((c) => [c.subjectId, c.partyId]));
    const partyOfName = new Map<string, number>();
    for (const v of vendors) {
      const partyId = partyOfVendorRow.get(v.id);
      if (partyId != null) partyOfName.set(v.vendorName, partyId);
    }

    return records.flatMap((r) => {
      const partyId = partyOfName.get(r.vendorName);
      return partyId == null
        ? []
        : [{
            recordId: r.id,
            businessId: r.businessId,
            at: r.date,
            partyId,
            amount: r.amount,
            direction: r.direction,
          }];
    });
  });
}

/**
 * Human reviews, reduced to "did the person have to change anything".
 *
 * `ReviewEvent.verdicts` is a per-field record of what the engine believed and what the human
 * submitted, written inside the approval transaction since the correction ledger shipped. This reads
 * the VERDICT and the FIELD NAME and nothing else — a corrected amount is the business's money and
 * has no business in a derived artifact, so the values never leave this function.
 */
const VERDICT_CORRECTED = "corrected";

export async function loadReviews(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<ReviewObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.reviewEvent.findMany({
      where: { businessId, occurredAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: { id: true, businessId: true, occurredAt: true, verdicts: true },
    }),
  );

  return rows.map((r) => {
    const correctedFields = correctedFieldsOf(r.verdicts);
    return {
      recordId: r.id,
      businessId: r.businessId,
      at: r.occurredAt,
      corrected: correctedFields.length > 0,
      correctedFields,
    };
  });
}

/**
 * Read the field names whose verdict was "corrected", defensively.
 *
 * `verdicts` is Json written by an earlier version of the product, so its shape is a historical fact
 * rather than a guarantee. A row this cannot parse contributes ZERO corrections rather than throwing
 * — a malformed payload from 2026 must not be able to stop a tenant's whole derivation — and because
 * it also still counts as an observation, the resulting rate is conservative rather than inflated.
 */
export function correctedFieldsOf(verdicts: unknown): string[] {
  if (verdicts == null || typeof verdicts !== "object" || Array.isArray(verdicts)) return [];
  const out: string[] = [];
  for (const [field, v] of Object.entries(verdicts as Record<string, unknown>)) {
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      if ((v as Record<string, unknown>).verdict === VERDICT_CORRECTED) out.push(field);
    }
  }
  return out.sort();
}

/* ─────────────────────── Business Cost learning (Wave 1) ─────────────────────── */

/**
 * The cost ledger for one business: the Business Cost engine's own inputs (its loader: one tenantTx,
 * RLS on every table, explicit businessId filter) plus when each commitment was RECORDED and the
 * audit events that make a change or an end explicit. One observation per business.
 */
export async function loadCostLedger(businessId: number, now: Date): Promise<CostLedgerSnapshot[]> {
  const day = toDayNumber(civilDateInZone(now, DEFAULT_BUSINESS_TIME_ZONE));
  const inputs = await loadBusinessCostInputs({ businessId, paidFromDay: day - COST_SOURCE_WINDOW_DAYS, paidToDay: day });
  const { meta, audit } = await tenantTx(businessId, async (tx) => ({
    meta: await tx.commitment.findMany({
      where: { businessId },
      select: { id: true, createdAt: true },
      orderBy: { id: "asc" },
    }),
    audit: await tx.payablesAuditEvent.findMany({
      where: { businessId, eventType: { in: ["INSTALLMENT_AMOUNT_CHANGED", "COMMITMENT_ENDED"] } },
      select: { id: true, eventType: true, commitmentId: true, installmentId: true, occurredAt: true, metadata: true },
      orderBy: { id: "asc" },
    }),
  }));
  return [
    {
      businessId,
      inputs,
      commitmentMeta: meta.map((m) => ({ commitmentId: m.id, createdAt: m.createdAt })),
      audit: audit.map((e) => ({
        id: e.id,
        eventType: e.eventType as CostAuditEvent["eventType"],
        commitmentId: e.commitmentId,
        installmentId: e.installmentId,
        occurredAt: e.occurredAt,
        metadata: (e.metadata as Record<string, unknown> | null) ?? null,
      })),
    },
  ];
}

/* ══════════════════════ INCOME (All-Feature Learning Coverage · W2) ══════════════════════ */

/**
 * ISSUED income documents (TAX_INVOICE, TAX_INVOICE_RECEIPT) issued inside the window, with everything
 * authoritative that happened to them.
 *
 * THE SAME DEFINITIONS THE OWNER'S COLLECTION SCREEN USES, imported rather than restated:
 *   due        `resolveCustomerPaymentTermsDays` (customer → business → 30) + `computeExpectedPaymentDate`
 *              (the Israeli due DAY), exactly as `awaiting-payment.rules.ts` computes it
 *   paid       only allocations of an ISSUED receipt (`authoritativeAllocationWhere`)
 *   credited   only ISSUED credit notes referencing the invoice (`authoritativeCreditNoteWhere`)
 * Movements dated after `now` are dropped, so a rebuild at an earlier `now` sees an earlier world.
 *
 * Reminders are the owner's own CollectionAction rows naming the invoice, directly or through a payment
 * request raised for it. `customerId` is the document's own foreign key — never a phone/email match.
 */
export async function loadIncomeDocuments(
  businessId: number,
  now: Date,
  windowDays: number,
): Promise<IncomeDocumentObservation[]> {
  const { profile, docs, actions } = await tenantTx(businessId, async (tx) => {
    const profile = await tx.businessProfile.findUnique({ where: { businessId }, select: { billingPaymentTermsDays: true } });
    const docs = await tx.billingDocument.findMany({
      where: {
        businessId,
        status: "ISSUED",
        documentType: { in: ["TAX_INVOICE", "TAX_INVOICE_RECEIPT"] },
        issuedAt: { gte: startOf(now, windowDays), lte: now },
      },
      orderBy: [{ id: "asc" }],
      select: {
        id: true, businessId: true, documentType: true, customerId: true, issuedAt: true, totalAmount: true,
        customer: { select: { paymentTermsDays: true } },
        paymentAllocationsAsInvoice: {
          where: { businessId, ...authoritativeAllocationWhere(businessId) },
          select: { allocatedAmount: true, receiptDocument: { select: { issuedAt: true } } },
        },
        creditNotes: { where: { businessId, ...authoritativeCreditNoteWhere() }, select: { totalAmount: true, issuedAt: true } },
      },
    });
    const ids = docs.map((d) => d.id);
    const actions = ids.length === 0 ? [] : await tx.collectionAction.findMany({
      where: {
        businessId,
        // A reminder about an invoice issued in the window cannot predate the window.
        occurredAt: { gte: startOf(now, windowDays), lte: now },
        OR: [{ billingDocumentId: { in: ids } }, { paymentRequestId: { not: null } }],
      },
      select: { billingDocumentId: true, occurredAt: true, paymentRequestId: true },
    });
    const requestIds = [...new Set(actions.map((a) => a.paymentRequestId).filter((x): x is number => x !== null))];
    const requests = requestIds.length === 0 ? [] : await tx.paymentRequest.findMany({
      where: { businessId, id: { in: requestIds }, billingDocumentId: { in: ids } },
      select: { id: true, billingDocumentId: true },
    });
    const docOfRequest = new Map(requests.map((r) => [r.id, r.billingDocumentId as number]));
    return {
      profile, docs,
      actions: actions.map((a) => ({ at: a.occurredAt,
        docId: a.billingDocumentId ?? (a.paymentRequestId !== null ? docOfRequest.get(a.paymentRequestId) ?? null : null) })),
    };
  });

  const firstReminder = new Map<number, Date>();
  for (const a of actions) {
    if (a.docId === null) continue;
    const prev = firstReminder.get(a.docId);
    if (!prev || a.at.getTime() < prev.getTime()) firstReminder.set(a.docId, a.at);
  }

  return docs.map((d) => {
    const issuedAt = d.issuedAt as Date;
    const isInvoice = d.documentType === "TAX_INVOICE";
    const events: CoverageEvent[] = [
      ...d.paymentAllocationsAsInvoice
        .filter((a) => a.receiptDocument.issuedAt !== null && a.receiptDocument.issuedAt.getTime() <= now.getTime())
        .map((a) => ({ at: a.receiptDocument.issuedAt as Date, cents: toCents(a.allocatedAmount), kind: "RECEIPT" as const })),
      ...d.creditNotes
        .filter((c) => c.issuedAt !== null && c.issuedAt.getTime() <= now.getTime())
        .map((c) => ({ at: c.issuedAt as Date, cents: toCents(c.totalAmount), kind: "CREDIT" as const })),
    ];
    const totalCents = toCents(d.totalAmount);
    const s = resolveSettlement(totalCents, events);
    return {
      recordId: d.id,
      businessId: d.businessId,
      docType: d.documentType as "TAX_INVOICE" | "TAX_INVOICE_RECEIPT",
      customerId: d.customerId,
      issuedAt,
      total: totalCents / 100,
      expectedAt: isInvoice
        ? computeExpectedPaymentDate(issuedAt, resolveCustomerPaymentTermsDays(d.customer?.paymentTermsDays ?? null, profile?.billingPaymentTermsDays ?? null))
        : null,
      // A TAX_INVOICE_RECEIPT is paid at issue; it carries no settlement to measure.
      settledAt: isInvoice ? s.settledAt : null,
      creditedOut: s.creditedOut,
      hasCreditNote: s.hasCreditNote,
      firstReminderAt: isInvoice ? firstReminder.get(d.id) ?? null : null,
    };
  });
}

/**
 * ISSUED quotes inside the window. A quote "converted" only when the invoice it became was itself
 * ISSUED — a draft invoice is an intention, the same rule the allocation authority applies.
 */
export async function loadQuotes(businessId: number, now: Date, windowDays: number): Promise<QuoteObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.billingDocument.findMany({
      where: { businessId, status: "ISSUED", documentType: "QUOTE", issuedAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, issuedAt: true, validUntil: true, convertedToInvoice: { select: { status: true, issuedAt: true } } },
    }),
  );
  return rows.map((q) => ({
    recordId: q.id,
    businessId: q.businessId,
    issuedAt: q.issuedAt as Date,
    validUntil: q.validUntil,
    converted: q.convertedToInvoice?.status === "ISSUED"
      && q.convertedToInvoice.issuedAt !== null && q.convertedToInvoice.issuedAt.getTime() <= now.getTime(),
  }));
}

/** Payment requests (links) created inside the window, with their terminal state as the provider reported it. */
export async function loadPaymentRequests(businessId: number, now: Date, windowDays: number): Promise<PaymentRequestObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.paymentRequest.findMany({
      where: { businessId, createdAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, customerId: true, createdAt: true, status: true, paidAt: true },
    }),
  );
  return rows.map((p) => ({
    recordId: p.id,
    businessId: p.businessId,
    customerId: p.customerId,
    createdAt: p.createdAt,
    // A payment recorded after `now` had not happened yet at `now`.
    status: p.status === "PAID" && p.paidAt !== null && p.paidAt.getTime() > now.getTime() ? "PENDING" : p.status,
    paidAt: p.paidAt !== null && p.paidAt.getTime() <= now.getTime() ? p.paidAt : null,
  }));
}

/* ══════════════════════ FUNNEL (All-Feature Learning Coverage · W3) ══════════════════════ */

/** Leads that arrived or closed inside the window. `firstHandledAt` is M5's own field. */
export async function loadLeads(businessId: number, now: Date, windowDays: number): Promise<LeadObservation[]> {
  const from = startOf(now, windowDays);
  const rows = await tenantTx(businessId, (tx) =>
    tx.lead.findMany({
      where: { businessId, OR: [{ createdAt: { gte: from, lte: now } }, { closedAt: { gte: from, lte: now } }] },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, createdAt: true, firstHandledAt: true, status: true, closedAt: true },
    }),
  );
  return rows.map((l) => ({
    recordId: l.id, businessId: l.businessId, createdAt: l.createdAt,
    firstHandledAt: l.firstHandledAt !== null && l.firstHandledAt.getTime() <= now.getTime() ? l.firstHandledAt : null,
    status: l.status as LeadObservation["status"],
    closedAt: l.closedAt !== null && l.closedAt.getTime() <= now.getTime() ? l.closedAt : null,
  }));
}

/** Completed lead next-actions that had a due day (LeadLifecycleEvent `next_action_completed`). */
export async function loadLeadFollowUps(businessId: number, now: Date, windowDays: number): Promise<FollowUpObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.leadLifecycleEvent.findMany({
      where: { businessId, kind: "next_action_completed", previousDueAt: { not: null }, occurredAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, occurredAt: true, previousDueAt: true },
    }),
  );
  return rows.map((e) => ({ recordId: e.id, businessId: e.businessId, completedAt: e.occurredAt, dueAt: e.previousDueAt as Date }));
}

/**
 * Conversations that started inside the window, reduced to their opening exchange (`openingOf`): the
 * first inbound with a provider message id (a real delivery), then the first outbound that did not fail.
 */
export async function loadConversationOpenings(businessId: number, now: Date, windowDays: number): Promise<ConversationOpeningObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.conversation.findMany({
      where: { businessId, startedAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: {
        id: true, businessId: true,
        messages: {
          where: { businessId, sentAt: { lte: now } },
          orderBy: [{ sentAt: "asc" }, { id: "asc" }],
          take: 50,
          select: { sentAt: true, direction: true, providerMessageId: true, sendStatus: true },
        },
      },
    }),
  );
  const out: ConversationOpeningObservation[] = [];
  for (const c of rows) {
    const o = openingOf(c.messages.map((m) => ({
      at: m.sentAt, direction: m.direction, fromProvider: m.providerMessageId !== null, sendFailed: m.sendStatus === "FAILED",
    })));
    if (o) out.push({ recordId: c.id, businessId: c.businessId, ...o });
  }
  return out;
}

/* ══════════════════════ OPERATIONS (All-Feature Learning Coverage · W3) ══════════════════════ */

/**
 * Appointments created or due inside the window, each with whether an APPOINTMENT_RESCHEDULED
 * observation exists for it — the only record of a move, since Appointment keeps no history.
 */
export async function loadAppointments(businessId: number, now: Date, windowDays: number): Promise<AppointmentObservation[]> {
  const from = startOf(now, windowDays);
  const { appts, moved } = await tenantTx(businessId, async (tx) => {
    const appts = await tx.appointment.findMany({
      where: { businessId, OR: [{ createdAt: { gte: from, lte: now } }, { startsAt: { gte: from, lte: now } }] },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, status: true, startsAt: true, createdAt: true },
    });
    const ids = appts.map((a) => a.id);
    const moved = ids.length === 0 ? [] : await tx.learningEvent.findMany({
      where: { businessId, eventType: "APPOINTMENT_RESCHEDULED", entityId: { in: ids }, createdAt: { lte: now } },
      select: { entityId: true },
    });
    return { appts, moved };
  });
  const rescheduled = new Set(moved.map((m) => m.entityId));
  return appts.map((a) => ({
    recordId: a.id, businessId: a.businessId, status: a.status as AppointmentObservation["status"],
    startsAt: a.startsAt, createdAt: a.createdAt, rescheduled: rescheduled.has(a.id),
  }));
}

/** Installments the owner marked handled inside the window, and when money was first recorded against them. */
export async function loadHandledInstallments(businessId: number, now: Date, windowDays: number): Promise<HandledInstallmentObservation[]> {
  const { flows, allocs } = await tenantTx(businessId, async (tx) => {
    const flows = await tx.installmentWorkflow.findMany({
      where: { businessId, handledAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ installmentId: "asc" }],
      select: { installmentId: true, businessId: true, handledAt: true },
    });
    const ids = flows.map((f) => f.installmentId);
    const allocs = ids.length === 0 ? [] : await tx.paymentAllocation.findMany({
      where: { businessId, installmentId: { in: ids }, reversedAt: null, payment: { status: "RECORDED", paidAt: { lte: now } } },
      select: { installmentId: true, payment: { select: { paidAt: true } } },
    });
    return { flows, allocs };
  });
  const firstPaid = new Map<number, Date>();
  for (const a of allocs) {
    const prev = firstPaid.get(a.installmentId);
    if (!prev || a.payment.paidAt.getTime() < prev.getTime()) firstPaid.set(a.installmentId, a.payment.paidAt);
  }
  return flows.map((f) => ({ recordId: f.installmentId, businessId: f.businessId, handledAt: f.handledAt as Date, paidAt: firstPaid.get(f.installmentId) ?? null }));
}

/** Obligations the owner marked MET inside the window. Owner-asserted; the rule labels it so. */
export async function loadMetObligations(businessId: number, now: Date, windowDays: number): Promise<ObligationObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.businessObligation.findMany({
      where: { businessId, state: "MET", metAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, dueAt: true, metAt: true },
    }),
  );
  return rows.map((o) => ({ recordId: o.id, businessId: o.businessId, dueAt: o.dueAt, metAt: o.metAt as Date }));
}

/** Demand signals for SERVICES inside the window (products are learned by the inventory rules). */
export async function loadServiceDemandSignals(businessId: number, now: Date, windowDays: number): Promise<DemandSignalObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.offeringDemandSignal.findMany({
      where: { businessId, offeringKind: "SERVICE", businessServiceId: { not: null }, createdAt: { gte: startOf(now, windowDays), lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, businessServiceId: true, createdAt: true },
    }),
  );
  return rows.map((s) => ({ recordId: s.id, businessId: s.businessId, businessServiceId: s.businessServiceId as number, at: s.createdAt }));
}

/** Accountant exports (DATA_EXPORTED observations of an accountant kind) inside the window, at action time. */
export async function loadAccountantExports(businessId: number, now: Date, windowDays: number): Promise<ActObservation[]> {
  const from = startOf(now, windowDays);
  const rows = await tenantTx(businessId, (tx) =>
    tx.learningEvent.findMany({
      where: { businessId, eventType: "DATA_EXPORTED", createdAt: { gte: from, lte: now } },
      orderBy: [{ id: "asc" }],
      select: { id: true, businessId: true, occurredAt: true, createdAt: true, payload: true },
    }),
  );
  return rows
    .filter((e) => (ACCOUNTANT_EXPORT_KINDS as readonly string[]).includes(String((e.payload as Record<string, unknown> | null)?.kind ?? "")))
    .map((e) => ({ recordId: e.id, businessId: e.businessId, at: e.occurredAt ?? e.createdAt }))
    .filter((e) => e.at.getTime() >= from.getTime() && e.at.getTime() <= now.getTime());
}
