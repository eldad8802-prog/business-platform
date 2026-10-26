/**
 * Revenue sources (S1-A) — the two adapter contracts. docs/revenue-sources-s1a-rivhit.md.
 *
 * A sales source and a payment provider tell different truths, so they have different shapes and land in
 * different layers of revenue truth:
 *
 *   PosDocument   what was SOLD: a sales document (sale / refund) with its lines, VAT and every tender it
 *                 records — cash included. → RevenueSale (+ one RevenueReceipt per tender).
 *   PaymentEvent  what was CHARGED on a card: a charge / refund / cancellation at a terminal. → RevenueReceipt
 *                 (method CARD) only. It never becomes a RevenueSale: a card charge is not a sale, and a provider
 *                 that only clears cards cannot stand in for the till (owner rule, 2026-10-26).
 *
 * `origin` keeps the evidence honest: REGISTER only when the source PROVES the document came from a till;
 * otherwise OFFICE_OR_UNKNOWN, written with sourceKind ACCOUNTING_APP, never POS.
 *
 * Pure: no I/O. Money is integer minor units (bigint), always positive; direction / kind carry the sign.
 */
import type { TenderMethod } from "@/lib/revenue-truth/types";

export type DocumentOrigin = "REGISTER" | "OFFICE_OR_UNKNOWN";

export type PosTender = {
  /** Stable within the document (the source's payment line number). */
  line: number;
  method: TenderMethod;
  direction: "IN" | "OUT";
  amountMinor: bigint;
  cardBrand: string | null;
};

export type PosLine = {
  line: number;
  itemRef: string | null;
  quantity: number;
  /** VAT-exclusive or inclusive as the document says (`pricesIncludeVat`); informational only. */
  lineTotalMinor: bigint;
};

export type PosDocument = {
  /** Stable source identity: unique within one connection, never reused. */
  externalId: string;
  kind: "SALE" | "REFUND";
  origin: DocumentOrigin;
  occurredAt: Date;
  /** YYYY-MM-DD, the Israel business day the source dated the document. */
  businessDay: string;
  registerKey: string | null;
  currency: "ILS";
  /** VAT-inclusive, before discount. */
  grossMinor: bigint;
  discountMinor: bigint;
  /** VAT included in gross − discount. */
  vatMinor: bigint;
  pricesIncludeVat: boolean;
  lines: PosLine[];
  tenders: PosTender[];
  /** Tenders seen but not money taken (tax withheld at source, a deposit drawn down): counted, not recorded. */
  skippedTenders: number;
  cancelled: boolean;
};

/** A standalone receipt: money taken against earlier documents (no sale of its own). */
export type PosReceipt = {
  externalId: string;
  origin: DocumentOrigin;
  occurredAt: Date;
  businessDay: string;
  registerKey: string | null;
  currency: "ILS";
  tenders: PosTender[];
  skippedTenders: number;
  cancelled: boolean;
};

export type PaymentEvent = {
  externalId: string;
  kind: "CHARGE" | "REFUND" | "CANCEL";
  occurredAt: Date;
  businessDay: string;
  terminalRef: string | null;
  currency: "ILS" | "USD" | "EUR";
  amountMinor: bigint;
  cardBrand: string | null;
  installmentCount: number | null;
};

// ── revenue-truth drafts: what each contract may become ─────────────────────────────────────────────

export type SaleDraft = {
  externalId: string;
  sourceKind: "POS" | "ACCOUNTING_APP";
  kind: "SALE" | "REFUND" | "VOID";
  occurredAt: Date;
  businessDay: string;
  registerKey: string | null;
  currency: string;
  grossMinor: bigint;
  discountMinor: bigint;
  vatMinor: bigint;
};

export type ReceiptDraft = {
  externalId: string;
  sourceKind: "POS" | "ACCOUNTING_APP" | "PAYMENT_PROVIDER";
  direction: "IN" | "OUT";
  method: TenderMethod;
  receivedAt: Date;
  businessDay: string;
  registerKey: string | null;
  currency: string;
  amountMinor: bigint;
  cardBrand: string | null;
  installmentCount: number | null;
};

export function sourceKindOf(origin: DocumentOrigin): "POS" | "ACCOUNTING_APP" {
  return origin === "REGISTER" ? "POS" : "ACCOUNTING_APP";
}

/** A sales document → its sale + one receipt per tender (the receipts name the sale once it is written). */
export function posDocumentToRevenue(doc: PosDocument): { sale: SaleDraft; receipts: ReceiptDraft[] } {
  const sourceKind = sourceKindOf(doc.origin);
  return {
    sale: {
      externalId: doc.externalId,
      sourceKind,
      kind: doc.kind,
      occurredAt: doc.occurredAt,
      businessDay: doc.businessDay,
      registerKey: doc.registerKey,
      currency: doc.currency,
      grossMinor: doc.grossMinor,
      discountMinor: doc.discountMinor,
      vatMinor: doc.vatMinor,
    },
    receipts: doc.tenders.map((t) => tenderReceipt(doc.externalId, sourceKind, doc, t)),
  };
}

/** The void of a sale the source cancelled: the same money, kind VOID, its own identity. */
export function voidOf(sale: Pick<SaleDraft, "externalId" | "sourceKind" | "occurredAt" | "businessDay" | "registerKey" | "currency" | "grossMinor" | "discountMinor" | "vatMinor">): SaleDraft {
  return { ...sale, externalId: `${sale.externalId}:void`, kind: "VOID" };
}

export function posReceiptToRevenue(r: PosReceipt): ReceiptDraft[] {
  return r.tenders.map((t) => tenderReceipt(r.externalId, sourceKindOf(r.origin), r, t));
}

function tenderReceipt(
  parentId: string,
  sourceKind: "POS" | "ACCOUNTING_APP",
  at: { occurredAt: Date; businessDay: string; registerKey: string | null; currency: string },
  t: PosTender
): ReceiptDraft {
  return {
    externalId: `${parentId}:pay:${t.line}`,
    sourceKind,
    direction: t.direction,
    method: t.method,
    receivedAt: at.occurredAt,
    businessDay: at.businessDay,
    registerKey: at.registerKey,
    currency: at.currency,
    amountMinor: t.amountMinor,
    cardBrand: t.cardBrand,
    installmentCount: null,
  };
}

/**
 * A payment provider's event → a card receipt, never a sale. A cancellation reverses the money (OUT) like a
 * refund; whether it undoes a sale is for the matching engine to propose and the owner to decide.
 */
export function paymentEventToRevenue(e: PaymentEvent): { receipts: ReceiptDraft[] } {
  return {
    receipts: [
      {
        externalId: e.externalId,
        sourceKind: "PAYMENT_PROVIDER",
        direction: e.kind === "CHARGE" ? "IN" : "OUT",
        method: "CARD",
        receivedAt: e.occurredAt,
        businessDay: e.businessDay,
        registerKey: e.terminalRef,
        currency: e.currency,
        amountMinor: e.amountMinor,
        cardBrand: e.cardBrand,
        installmentCount: e.installmentCount,
      },
    ],
  };
}
