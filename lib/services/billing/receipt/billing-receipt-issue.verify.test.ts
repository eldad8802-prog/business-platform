/**
 * Receipt & Payment v1 — issue-time FinancialEvent + settlement verify.
 *   npx tsx lib/services/billing/receipt/billing-receipt-issue.verify.test.ts
 *
 * Self-contained: in-memory fake Prisma client (no DB). Verifies the Stage 2
 * correctness rules:
 *   1. RECEIPT      → PAYMENT only (never BILLING_INVOICE).
 *   2. TAX_INVOICE_RECEIPT → BILLING_INVOICE once + PAYMENT once.
 *   3. Settlement status is derived from totals only.
 *   5. FinancialEvent posting is idempotent per (sourceType, sourceKey).
 */
import assert from "node:assert/strict";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  FinancialEventSourceType,
  Prisma,
  type BillingDocument,
} from "@prisma/client";
import {
  ensureBillingInvoicePostedEvent,
  ensureBillingPaymentPostedEvent,
} from "../../financial-events/financial-event.service";
import { computeSettlementStatus } from "./billing-settlement-state.service";

type FakeEventRow = Record<string, unknown>;

function makeFakeTx() {
  const rows: FakeEventRow[] = [];
  const calls = { create: 0 };

  const tx = {
    financialEvent: {
      async findUnique(args: { where: Record<string, unknown> }) {
        const w = args.where;
        if (w.billingDocumentId !== undefined) {
          return (
            rows.find((r) => r.billingDocumentId === w.billingDocumentId) ?? null
          );
        }
        const c = w.businessId_sourceType_sourceKey as
          | { businessId: number; sourceType: string; sourceKey: string }
          | undefined;
        if (c) {
          return (
            rows.find(
              (r) =>
                r.businessId === c.businessId &&
                r.sourceType === c.sourceType &&
                r.sourceKey === c.sourceKey
            ) ?? null
          );
        }
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        calls.create += 1;
        const data = args.data;
        const compositeDup = rows.find(
          (r) =>
            r.businessId === data.businessId &&
            r.sourceType === data.sourceType &&
            r.sourceKey === data.sourceKey
        );
        const docDup =
          data.billingDocumentId != null &&
          rows.find((r) => r.billingDocumentId === data.billingDocumentId);
        if (compositeDup || docDup) {
          throw new Prisma.PrismaClientKnownRequestError("Unique violation", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        const row: FakeEventRow = { billingDocumentId: null, ...data };
        rows.push(row);
        return row;
      },
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, rows, calls };
}

function fakeDoc(overrides: Partial<BillingDocument>): BillingDocument {
  return {
    id: 1,
    businessId: 42,
    documentType: BillingDocumentType.TAX_INVOICE,
    status: BillingDocumentStatus.ISSUED,
    issuedAt: new Date("2026-06-15T00:00:00.000Z"),
    totalAmount: new Prisma.Decimal("117"),
    currency: "ILS",
    customerNameSnapshot: "Customer",
    ...overrides,
  } as unknown as BillingDocument;
}

function bySource(rows: FakeEventRow[], sourceType: string): FakeEventRow[] {
  return rows.filter((r) => r.sourceType === sourceType);
}

async function run() {
  // 1. RECEIPT → PAYMENT only.
  {
    const { tx, rows } = makeFakeTx();
    const doc = fakeDoc({ id: 10, documentType: BillingDocumentType.RECEIPT });
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    assert.equal(bySource(rows, FinancialEventSourceType.BILLING_INVOICE).length, 0);
    assert.equal(bySource(rows, FinancialEventSourceType.PAYMENT).length, 1);
    assert.equal(rows[0].billingDocumentId, null);
    assert.equal(rows[0].sourceKey, "payment:10");
  }

  // 2. TAX_INVOICE_RECEIPT → BILLING_INVOICE once + PAYMENT once.
  {
    const { tx, rows } = makeFakeTx();
    const doc = fakeDoc({ id: 11, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT });
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    assert.equal(bySource(rows, FinancialEventSourceType.BILLING_INVOICE).length, 1);
    assert.equal(bySource(rows, FinancialEventSourceType.PAYMENT).length, 1);
    // invoice event links the document; payment event does not (avoids the
    // billingDocumentId unique collision on the same document).
    assert.equal(bySource(rows, FinancialEventSourceType.BILLING_INVOICE)[0].billingDocumentId, 11);
    assert.equal(bySource(rows, FinancialEventSourceType.PAYMENT)[0].billingDocumentId, null);
  }

  // TAX_INVOICE → BILLING_INVOICE only.
  {
    const { tx, rows } = makeFakeTx();
    const doc = fakeDoc({ id: 12, documentType: BillingDocumentType.TAX_INVOICE });
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    assert.equal(bySource(rows, FinancialEventSourceType.BILLING_INVOICE).length, 1);
    assert.equal(bySource(rows, FinancialEventSourceType.PAYMENT).length, 0);
  }

  // CREDIT_NOTE → neither.
  {
    const { tx, rows } = makeFakeTx();
    const doc = fakeDoc({ id: 13, documentType: BillingDocumentType.CREDIT_NOTE });
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    assert.equal(rows.length, 0);
  }

  // 5. Idempotency — second call is a no-op (findUnique short-circuits create).
  {
    const { tx, rows, calls } = makeFakeTx();
    const doc = fakeDoc({ id: 14, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT });
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    await ensureBillingInvoicePostedEvent(tx, doc);
    await ensureBillingPaymentPostedEvent(tx, doc);
    assert.equal(rows.length, 2);
    assert.equal(calls.create, 2); // only the first of each pair created a row
  }

  // Guards: non-ISSUED / missing issuedAt → no events.
  {
    const { tx, rows } = makeFakeTx();
    await ensureBillingPaymentPostedEvent(
      tx,
      fakeDoc({ id: 15, documentType: BillingDocumentType.RECEIPT, status: BillingDocumentStatus.DRAFT })
    );
    await ensureBillingPaymentPostedEvent(
      tx,
      fakeDoc({ id: 16, documentType: BillingDocumentType.RECEIPT, issuedAt: null })
    );
    assert.equal(rows.length, 0);
  }

  // 3. Settlement status derived from totals only.
  const D = (v: string) => new Prisma.Decimal(v);
  assert.equal(computeSettlementStatus(D("100"), D("0")), "UNPAID");
  assert.equal(computeSettlementStatus(D("100"), D("50")), "PARTIALLY_PAID");
  assert.equal(computeSettlementStatus(D("100"), D("100")), "PAID");
  assert.equal(computeSettlementStatus(D("100"), D("120")), "PAID");

  console.log("billing-receipt issue + settlement: all assertions passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
