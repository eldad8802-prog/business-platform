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
    externallyBacked: r.payment.evidences.some((e) => e.kind !== "MANUAL"),
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
  const rows = await tenantTx(businessId, (tx) =>
    tx.purchaseOrder.findMany({
      where: {
        businessId,
        supplierId: { not: null },
        status: "CLOSED",
        orderDate: { not: null },
        receivingSessions: { some: { status: "POSTED", receivedAt: { not: null } } },
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
