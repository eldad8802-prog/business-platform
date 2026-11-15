/**
 * Read-only settlement facts for a set of billing documents — for a caller (Service Desk) that links documents to its
 * own records and computes its own balance. Billing reports facts; it never decides what a service case owes.
 *
 * Runs in the CALLER's tenant transaction (RLS applies) and only reads. No schema, no write, no behaviour change.
 * The amounts use the SAME rule as every billing path (billing-invoice-economic-remaining.ts):
 *   invoice outstanding = max(0, total − allocations from ISSUED receipts − ISSUED credit notes)
 *
 * How the data is shaped (verified in code, not assumed):
 *   - An allocation links a RECEIPT document to a TAX_INVOICE (BillingPaymentAllocation). One receipt may allocate to
 *     several invoices; only allocations of an ISSUED receipt count (authoritativeAllocationWhere).
 *   - A receipt's money is identified by the receipt document. A verified online payment produces at most one receipt
 *     (BillingDocument.sourcePaymentTransactionId, UNIQUE) — the transaction id is an attribute, never a second key.
 *   - Σ allocations + unappliedAmount = total holds for receipts with allocations or a stated unapplied amount.
 *     A standalone ("ad-hoc") receipt — e.g. an exempt dealer's, with no invoice — has NO allocations and
 *     unappliedAmount 0: its money is attributed to no invoice by billing data. It is reported as such, never as paid
 *     against anything.
 *   - A TAX_INVOICE_RECEIPT is a charge and its payment in one document (settled by itself, no allocation rows).
 *
 * Every requested id comes back, with a flag when it cannot be read as an ISSUED ILS document of this business.
 * Amounts are integer agorot (columns are Decimal(…, 2), so the conversion is exact).
 */
import { BillingDocumentStatus, Prisma } from "@prisma/client";
import { computeEconomicRemaining } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import {
  authoritativeAllocationWhere,
  authoritativeCreditNoteWhere,
} from "@/lib/services/billing/domain/billing-allocation-authority";

export type SettlementDocumentFlag =
  /** no such document in this business (also: another business's document — RLS does not reveal which) */
  | "NOT_FOUND"
  /** found, but not ISSUED (a draft or pending review carries no settlement fact) */
  | "NOT_ISSUED"
  /** found and issued, but not ILS — amounts are reported, the caller must not net them */
  | "NOT_ILS"
  /** a document type that is neither a charge nor a payment (e.g. a quote) */
  | "NOT_A_SETTLEMENT_DOCUMENT";

export type SettlementDocument = {
  id: number;
  type: string | null;
  status: string | null;
  currency: string | null;
  totalAgorot: number | null;
  issuedAt: string | null;
  flag: SettlementDocumentFlag | null;
};

export type SettlementInvoice = {
  id: number;
  totalAgorot: number;
  /** from ISSUED receipts, any receipt — including receipts the caller did not request */
  allocatedAgorot: number;
  /** ISSUED credit notes referencing this invoice */
  creditedAgorot: number;
  outstandingAgorot: number;
};

export type SettlementReceiptKind =
  /** allocates its whole total to invoices (manual or verified payment) */
  | "ALLOCATED"
  /** allocates part to invoices and states the rest as unapplied (a verified overpayment) */
  | "ALLOCATED_WITH_UNAPPLIED"
  /** no allocation and nothing unapplied: attributed to no invoice by billing data */
  | "STANDALONE";

export type SettlementReceipt = {
  id: number;
  type: "RECEIPT" | "TAX_INVOICE_RECEIPT";
  kind: SettlementReceiptKind | "SELF_SETTLED";
  totalAgorot: number;
  /** Σ allocations of this receipt (to any invoice) */
  allocatedAgorot: number;
  /** the stated overpayment (C3); 0 for manual receipts */
  unappliedAgorot: number;
  /** money billing attributes to NO invoice: total − allocations (= unapplied, or the whole total when STANDALONE) */
  notAttributedToAnyInvoiceAgorot: number;
  paymentTransactionId: number | null;
};

export type SettlementAllocation = {
  receiptDocumentId: number;
  invoiceDocumentId: number;
  amountAgorot: number;
  /** both ends are among the requested ids */
  bothRequested: boolean;
};

export type SettlementCredit = { creditNoteId: number; invoiceDocumentId: number; amountAgorot: number };

export type DocumentsSettlement = {
  requestedIds: number[];
  documents: SettlementDocument[];
  invoices: SettlementInvoice[];
  receipts: SettlementReceipt[];
  allocations: SettlementAllocation[];
  credits: SettlementCredit[];
  asOf: string;
};

type ReadTx = Pick<Prisma.TransactionClient, "billingDocument" | "billingPaymentAllocation">;

const ISSUED = BillingDocumentStatus.ISSUED;
const MAX_IDS = 500;

/** Decimal(…, 2) → integer agorot, exactly. */
export function toAgorot(d: Prisma.Decimal | string | number | null | undefined): number {
  const v = new Prisma.Decimal(d ?? 0).mul(100);
  if (!v.isInteger()) throw new Error("amount has more than 2 decimal places");
  const n = v.toNumber();
  if (!Number.isSafeInteger(n)) throw new Error("amount out of range");
  return n;
}

export async function readDocumentsSettlement(
  tx: ReadTx,
  businessId: number,
  documentIds: number[]
): Promise<DocumentsSettlement> {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("invalid businessId");
  const ids = [...new Set(documentIds)].filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b);
  if (ids.length !== new Set(documentIds).size) throw new Error("documentIds must be positive integers");
  if (ids.length > MAX_IDS) throw new Error(`at most ${MAX_IDS} documents per read`);

  const rows = ids.length
    ? await tx.billingDocument.findMany({
        where: { businessId, id: { in: ids } },
        select: { id: true, documentType: true, status: true, currency: true, totalAmount: true, issuedAt: true,
          unappliedAmount: true, sourcePaymentTransactionId: true },
      })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const documents: SettlementDocument[] = ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, type: null, status: null, currency: null, totalAgorot: null, issuedAt: null, flag: "NOT_FOUND" };
    const base = { id, type: r.documentType, status: r.status, currency: r.currency, totalAgorot: toAgorot(r.totalAmount),
      issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null };
    const flag: SettlementDocumentFlag | null =
      !["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"].includes(r.documentType) ? "NOT_A_SETTLEMENT_DOCUMENT"
      : r.status !== ISSUED ? "NOT_ISSUED"
      : r.currency !== "ILS" ? "NOT_ILS"
      : null;
    return { ...base, flag };
  });
  const usable = (type: string) => rows.filter((r) => r.documentType === type && r.status === ISSUED && r.currency === "ILS");
  const requested = new Set(ids);

  // invoices: outstanding by the shared rule, from ALL ISSUED receipts and credit notes (requested or not)
  const invoiceRows = usable("TAX_INVOICE");
  const invoiceIds = invoiceRows.map((r) => r.id);
  const invoiceAllocations = invoiceIds.length
    ? await tx.billingPaymentAllocation.findMany({
        where: { businessId, invoiceDocumentId: { in: invoiceIds }, ...authoritativeAllocationWhere(businessId) },
        select: { receiptDocumentId: true, invoiceDocumentId: true, allocatedAmount: true },
      })
    : [];
  const creditRows = invoiceIds.length
    ? await tx.billingDocument.findMany({
        where: { businessId, referenceDocumentId: { in: invoiceIds }, ...authoritativeCreditNoteWhere() },
        select: { id: true, referenceDocumentId: true, totalAmount: true },
      })
    : [];
  const invoices: SettlementInvoice[] = invoiceRows.map((inv) => {
    const allocated = invoiceAllocations.filter((a) => a.invoiceDocumentId === inv.id)
      .reduce((s, a) => s.plus(a.allocatedAmount), new Prisma.Decimal(0));
    const credited = creditRows.filter((c) => c.referenceDocumentId === inv.id)
      .reduce((s, c) => s.plus(c.totalAmount), new Prisma.Decimal(0));
    return { id: inv.id, totalAgorot: toAgorot(inv.totalAmount), allocatedAgorot: toAgorot(allocated),
      creditedAgorot: toAgorot(credited), outstandingAgorot: toAgorot(computeEconomicRemaining(inv.totalAmount, allocated, credited)) };
  });

  // receipts: what each requested receipt allocates (to any invoice), and what billing attributes to no invoice
  const receiptRows = usable("RECEIPT");
  const receiptIds = receiptRows.map((r) => r.id);
  const receiptAllocations = receiptIds.length
    ? await tx.billingPaymentAllocation.findMany({
        where: { businessId, receiptDocumentId: { in: receiptIds }, ...authoritativeAllocationWhere(businessId) },
        select: { receiptDocumentId: true, invoiceDocumentId: true, allocatedAmount: true },
      })
    : [];
  const receipts: SettlementReceipt[] = [
    ...receiptRows.map((r): SettlementReceipt => {
      const allocated = receiptAllocations.filter((a) => a.receiptDocumentId === r.id)
        .reduce((s, a) => s.plus(a.allocatedAmount), new Prisma.Decimal(0));
      const unapplied = new Prisma.Decimal(r.unappliedAmount);
      const kind: SettlementReceiptKind = allocated.isZero() && unapplied.isZero() ? "STANDALONE"
        : unapplied.isZero() ? "ALLOCATED" : "ALLOCATED_WITH_UNAPPLIED";
      const notAttributed = new Prisma.Decimal(r.totalAmount).minus(allocated);
      return { id: r.id, type: "RECEIPT", kind, totalAgorot: toAgorot(r.totalAmount), allocatedAgorot: toAgorot(allocated),
        unappliedAgorot: toAgorot(unapplied), notAttributedToAnyInvoiceAgorot: toAgorot(notAttributed.lessThan(0) ? 0 : notAttributed),
        paymentTransactionId: r.sourcePaymentTransactionId ?? null };
    }),
    ...usable("TAX_INVOICE_RECEIPT").map((r): SettlementReceipt => ({
      id: r.id, type: "TAX_INVOICE_RECEIPT", kind: "SELF_SETTLED", totalAgorot: toAgorot(r.totalAmount), allocatedAgorot: 0,
      unappliedAgorot: 0, notAttributedToAnyInvoiceAgorot: 0, paymentTransactionId: r.sourcePaymentTransactionId ?? null,
    })),
  ];

  // allocations touching a requested invoice or a requested receipt — each (receipt, invoice) pair ONCE
  const seen = new Set<string>();
  const allocations: SettlementAllocation[] = [];
  for (const a of [...invoiceAllocations, ...receiptAllocations]) {
    const key = `${a.receiptDocumentId}:${a.invoiceDocumentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allocations.push({ receiptDocumentId: a.receiptDocumentId, invoiceDocumentId: a.invoiceDocumentId,
      amountAgorot: toAgorot(a.allocatedAmount), bothRequested: requested.has(a.receiptDocumentId) && requested.has(a.invoiceDocumentId) });
  }
  allocations.sort((x, y) => x.receiptDocumentId - y.receiptDocumentId || x.invoiceDocumentId - y.invoiceDocumentId);

  const credits: SettlementCredit[] = creditRows
    .map((c) => ({ creditNoteId: c.id, invoiceDocumentId: c.referenceDocumentId as number, amountAgorot: toAgorot(c.totalAmount) }))
    .sort((x, y) => x.creditNoteId - y.creditNoteId);

  return { requestedIds: ids, documents, invoices, receipts, allocations, credits, asOf: new Date().toISOString() };
}
