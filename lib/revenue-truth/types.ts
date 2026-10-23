/**
 * Revenue truth — the normalized evidence the read model takes. docs/revenue-truth-milestone-a.md.
 *
 * Every amount is integer minor units (bigint) in its own currency. These shapes are deliberately not Prisma
 * rows: the read model is pure, and `sources.ts` is the one place that maps the database (the new Revenue*
 * tables plus BillingDocument / PaymentTransaction / ExternalTransaction, read in place) onto them.
 */
import type { CurrencyCode } from "@/lib/money/currency";
import type { JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type TenderMethod = "CASH" | "CARD" | "CHEQUE" | "BANK_TRANSFER" | "DIGITAL_WALLET" | "VOUCHER" | "OTHER";
export type Capture = "API_PUSH" | "API_PULL" | "FILE_STRUCTURED" | "FILE_EXTRACTED" | "MANUAL";
export type Validation = "PASSED" | "WARNINGS" | "FAILED";
export type LinkKind = "SALE_SAME_AS_DOCUMENT" | "TENDER_SETTLED_BY" | "SETTLEMENT_DEPOSITED_AS" | "CASH_DEPOSITED_AS";
export type DecisionKind = "CONFIRMED" | "REJECTED" | "REVOKED";

/** Layer 1, register stream: one POS sale / refund / void (RevenueSale). */
export type RegisterSale = {
  id: number;
  sourceScope: string;
  registerKey: string | null;
  businessDay: JerusalemDayKey;
  kind: "SALE" | "REFUND" | "VOID";
  currency: CurrencyCode;
  grossMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  vatMinor: bigint;
};

/** Layer 2, register stream: money taken in / paid back at the till (RevenueReceipt). */
export type RegisterReceipt = {
  id: number;
  sourceScope: string;
  registerKey: string | null;
  businessDay: JerusalemDayKey;
  direction: "IN" | "OUT";
  method: TenderMethod;
  currency: CurrencyCode;
  amountMinor: bigint;
};

/** Layer 1, the Z report (RevenueDailyClose) with its tender lines. */
export type DailyClose = {
  id: number;
  sourceScope: string;
  salesScope: string | null;
  registerKey: string;
  externalId: string;
  revision: number;
  capture: Capture;
  validation: Validation;
  businessDay: JerusalemDayKey;
  currency: CurrencyCode;
  grossMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  voidMinor: bigint;
  totalMinor: bigint;
  vatMinor: bigint;
  tenders: { id: number; method: TenderMethod; amountMinor: bigint }[];
};

/** Layer 3 (RevenueSettlement). */
export type Settlement = {
  id: number;
  validation: Validation;
  currency: CurrencyCode;
  grossMinor: bigint;
  feeMinor: bigint;
  otherDeductionsMinor: bigint;
  netMinor: bigint;
};

/** Layer 4: an incoming bank line (ExternalTransaction, direction CREDIT, read in place). */
export type BankCredit = {
  id: number;
  currency: CurrencyCode;
  amountMinor: bigint;
};

/** A Dubiz-issued document (BillingDocument, status ISSUED, read in place). Amounts are positive. */
export type DubizDocument = {
  id: number;
  documentType: "TAX_INVOICE" | "TAX_INVOICE_RECEIPT" | "CREDIT_NOTE" | "RECEIPT";
  currency: CurrencyCode;
  totalMinor: bigint;
  vatMinor: bigint;
  referenceDocumentId: number | null;
  sourcePaymentTransactionId: number | null;
};

/** A verified Dubiz payment (PaymentTransaction, status PAID, read in place). A refund is negative. */
export type DubizPayment = {
  id: number;
  currency: CurrencyCode;
  amountMinor: bigint;
};

export type Link = {
  id: number;
  linkKind: LinkKind;
  saleId: number | null;
  receiptId: number | null;
  dailyCloseTenderId: number | null;
  settlementId: number | null;
  externalTransactionId: number | null;
  billingDocumentId: number | null;
  amountMinor: bigint | null;
  currency: CurrencyCode;
};

export type Decision = {
  id: number;
  linkId: number | null;
  dailyCloseId: number | null;
  decision: DecisionKind;
};

export type RevenueInputs = {
  sales: RegisterSale[];
  receipts: RegisterReceipt[];
  closes: DailyClose[];
  settlements: Settlement[];
  deposits: BankCredit[];
  documents: DubizDocument[];
  payments: DubizPayment[];
  links: Link[];
  decisions: Decision[];
};

export function emptyInputs(): RevenueInputs {
  return { sales: [], receipts: [], closes: [], settlements: [], deposits: [], documents: [], payments: [], links: [], decisions: [] };
}
