/**
 * All-Feature Learning Coverage · W2 — the INCOME side: billing, customers, payments-in, collection.
 *
 * Until now Dubiz learned only how money goes out. These rules learn how it comes in, from the domain
 * ledgers that already are the authority for it — never from an inferred identity and never from a
 * LearningEvent duplicate:
 *
 *   BillingDocument (ISSUED TAX_INVOICE / TAX_INVOICE_RECEIPT / QUOTE / CREDIT_NOTE), the receipt→invoice
 *   BillingPaymentAllocation, PaymentRequest, CollectionAction, and the payment terms already resolved
 *   by `lib/services/billing/collection/payment-terms.ts` — ONE definition of "due", shared with the
 *   collection screen the owner sees.
 *
 * WHAT "SETTLED" MEANS HERE. The same figure the collection list shows: an invoice is settled when
 * ISSUED receipt allocations plus ISSUED credit notes cover its total (`computeEconomicRemaining`). The
 * settlement instant is the issue time of the receipt (or credit note) that completed the coverage. An
 * invoice covered by credit notes ALONE was cancelled, not paid — it is excluded from every payment
 * measure, because "paid on time" would be a lie about a document nobody paid.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   - TAX_INVOICE_RECEIPT is paid at issue by definition; it counts toward invoicing cadence and ticket
 *     size, never toward payment timing (it would drag every median to zero).
 *   - Lead → invoice: there is no link in the schema; lead learning lives with leads.
 *   - Collection → payment is SEQUENCE, never cause. COLL-03 records how often a reminded invoice was
 *     settled soon after the reminder; its detail carries `SEQUENCE_NOT_CAUSE`, and nothing downstream
 *     may read it as "reminders work".
 *   - Customer identity across sources (phone / email / tax id) is an owner decision. Per-customer
 *     rules here use the explicit domain foreign key `customerId` only; an invoice without one teaches
 *     nothing about any customer.
 */
import type { MeasureResult } from "../measure.contract";
import type { EvidenceSource, KnowledgeRule, RuleDescriptor } from "../rule.contract";
import {
  cadenceMeasure, groupByEntity, latencyMeasure, shareMeasure, valueMeasure,
  calendarDays, type LatencyPoint, type SharePoint, type TimelinePoint, type ValuePoint,
} from "../rule-kit";

export const INCOME_WINDOW_DAYS = 365;
/** A quote younger than this, or still valid, is not yet a "did not convert". */
export const QUOTE_MATURITY_DAYS = 30;
/** An invoice younger than this is not yet evidence of whether a credit note follows. */
export const CREDIT_MATURITY_DAYS = 30;
/** "Soon after the reminder" for COLL-03. A sequence window, not an effect window. */
export const REMINDER_FOLLOW_DAYS = 14;
/** An invoice is "overdue enough" to expect a reminder once its due day is this far behind. */
export const OVERDUE_GRACE_DAYS = 7;

/* ─────────────────────────────── observation types ─────────────────────────────── */

/**
 * One ISSUED income document (TAX_INVOICE or TAX_INVOICE_RECEIPT).
 *
 * `expectedAt` is the due day from the resolved terms (customer terms, else business terms, else 30) —
 * null for a TAX_INVOICE_RECEIPT, which has no expectation because it is paid at issue.
 * `settledAt` is the instant the invoice became covered by money, or null if it is not (yet) covered
 * or was cancelled by credit notes alone (`creditedOut`).
 * `firstReminderAt` is the earliest CollectionAction recorded for it (directly, or through one of its
 * payment requests) — an owner-initiated reminder, never a delivery.
 */
export type IncomeDocumentObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly docType: "TAX_INVOICE" | "TAX_INVOICE_RECEIPT";
  readonly customerId: number | null;
  readonly issuedAt: Date;
  readonly total: number;
  readonly expectedAt: Date | null;
  readonly settledAt: Date | null;
  readonly creditedOut: boolean;
  readonly hasCreditNote: boolean;
  readonly firstReminderAt: Date | null;
};

/** One ISSUED quote, and whether (and when) it became an invoice. */
export type QuoteObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly issuedAt: Date;
  readonly validUntil: Date | null;
  readonly converted: boolean;
};

/** One payment request (link), with its terminal state. `paidAt` is the provider-verified paid time. */
export type PaymentRequestObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly customerId: number | null;
  readonly createdAt: Date;
  readonly status: "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "EXPIRED";
  readonly paidAt: Date | null;
  readonly expiresAt: Date | null;
};

/* ─────────────────────────────── settlement (pure) ─────────────────────────────── */

/** One authoritative movement against an invoice: an ISSUED receipt's allocation, or an ISSUED credit note. */
export type CoverageEvent = { readonly at: Date; readonly cents: number; readonly kind: "RECEIPT" | "CREDIT" };

/**
 * When did this invoice stop being owed, and was it paid or cancelled?
 *
 * Walks the authoritative movements in time order (ties: receipts first, then by amount, so the
 * answer never depends on row order) and returns the instant cumulative coverage first reached the
 * total — the same arithmetic as `computeEconomicRemaining`, in integer agorot. `creditedOut` is true
 * when credit notes alone reach the total: the invoice was cancelled, and no payment measure may
 * count it. A zero-total invoice is never "settled": there was nothing to pay.
 */
export function resolveSettlement(totalCents: number, events: readonly CoverageEvent[]): {
  settledAt: Date | null; creditedOut: boolean; hasCreditNote: boolean;
} {
  const credited = events.filter((e) => e.kind === "CREDIT").reduce((s, e) => s + e.cents, 0);
  const hasCreditNote = events.some((e) => e.kind === "CREDIT");
  if (totalCents <= 0) return { settledAt: null, creditedOut: false, hasCreditNote };
  if (credited >= totalCents) return { settledAt: null, creditedOut: true, hasCreditNote };
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime()
    || (a.kind === b.kind ? 0 : a.kind === "RECEIPT" ? -1 : 1) || a.cents - b.cents);
  let covered = 0;
  for (const e of ordered) {
    covered += e.cents;
    if (covered >= totalCents) return { settledAt: e.at, creditedOut: false, hasCreditNote };
  }
  return { settledAt: null, creditedOut: false, hasCreditNote };
}

/** Money as integer agorot. Decimal(18,2) values arrive as strings or Decimals; both stringify exactly. */
export function toCents(v: { toString(): string } | number): number {
  return Math.round(Number(v.toString()) * 100);
}

/* ─────────────────────────────── descriptors ─────────────────────────────── */

const FRESH: RuleDescriptor["freshness"] = ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"];
const desc = (d: Omit<RuleDescriptor, "versionLabel" | "freshness" | "windowDays"> & { windowDays?: number }): RuleDescriptor =>
  ({ versionLabel: "v1", freshness: FRESH, windowDays: INCOME_WINDOW_DAYS, ...d });

export const BILL01 = desc({ ruleId: "BILL-01", domain: "billing", measureKey: "billing.invoicing_cadence", policyKey: "billing-invoicing-cadence",
  entityType: null, minSupport: 4, valueUnit: "days", question: "How many days typically pass between two invoices this business issues?" });
export const BILL02 = desc({ ruleId: "BILL-02", domain: "billing", measureKey: "billing.payment_timing", policyKey: "billing-payment-timing",
  entityType: null, minSupport: 5, valueUnit: "days", question: "How many days after (or before) the due day are this business's invoices usually paid?" });
export const BILL03 = desc({ ruleId: "BILL-03", domain: "billing", measureKey: "billing.late_share", policyKey: "billing-late-share",
  entityType: null, minSupport: 5, valueUnit: "ratio", question: "What share of this business's paid invoices were paid after their due day?" });
export const BILL04 = desc({ ruleId: "BILL-04", domain: "billing", measureKey: "billing.quote_conversion", policyKey: "billing-quote-conversion",
  entityType: null, minSupport: 5, valueUnit: "ratio", question: "What share of this business's matured quotes became invoices?" });
export const BILL05 = desc({ ruleId: "BILL-05", domain: "billing", measureKey: "billing.credit_note_share", policyKey: "billing-credit-note-share",
  entityType: null, minSupport: 10, valueUnit: "ratio", question: "What share of this business's matured invoices were followed by a credit note?" });

export const CUST01 = desc({ ruleId: "CUST-01", domain: "customers", measureKey: "customers.payment_timing", policyKey: "customers-payment-timing",
  entityType: "customer", minSupport: 3, valueUnit: "days", question: "How many days after (or before) the due day does this customer usually pay?" });
export const CUST02 = desc({ ruleId: "CUST-02", domain: "customers", measureKey: "customers.invoicing_cadence", policyKey: "customers-invoicing-cadence",
  entityType: "customer", minSupport: 3, valueUnit: "days", question: "How many days typically pass between two invoices to this customer?" });
export const CUST03 = desc({ ruleId: "CUST-03", domain: "customers", measureKey: "customers.ticket_size", policyKey: "customers-ticket-size",
  entityType: "customer", minSupport: 3, valueUnit: "currency", question: "What is the typical invoice amount for this customer, and how far does it range?" });

export const PAY01 = desc({ ruleId: "PAY-01", domain: "payments", measureKey: "payments.link_conversion", policyKey: "payments-link-conversion",
  entityType: null, minSupport: 5, valueUnit: "ratio", question: "What share of this business's resolved payment links were paid?" });
export const PAY02 = desc({ ruleId: "PAY-02", domain: "payments", measureKey: "payments.link_time_to_pay", policyKey: "payments-link-time-to-pay",
  entityType: null, minSupport: 5, valueUnit: "days", question: "How many days typically pass between creating a payment link and it being paid?" });

export const COLL01 = desc({ ruleId: "COLL-01", domain: "collection", measureKey: "collection.reminder_timing", policyKey: "collection-reminder-timing",
  entityType: null, minSupport: 3, valueUnit: "days", question: "How many days after the due day does this owner usually send the first reminder?" });
export const COLL02 = desc({ ruleId: "COLL-02", domain: "collection", measureKey: "collection.overdue_reminded_share", policyKey: "collection-overdue-reminded-share",
  entityType: null, minSupport: 5, valueUnit: "ratio", question: "What share of this business's overdue invoices received a reminder before being paid?" });
export const COLL03 = desc({ ruleId: "COLL-03", domain: "collection", measureKey: "collection.settled_after_reminder_share", policyKey: "collection-settled-after-reminder-share",
  entityType: null, minSupport: 5, valueUnit: "ratio",
  question: "What share of reminded invoices were settled within 14 days after the first reminder? (Sequence, never cause.)" });

/* ─────────────────────────────── derivation (pure) ─────────────────────────────── */

const DAY = 86_400_000;
const isPaidInvoice = (o: IncomeDocumentObservation): o is IncomeDocumentObservation & { settledAt: Date; expectedAt: Date } =>
  o.docType === "TAX_INVOICE" && !o.creditedOut && o.settledAt !== null && o.expectedAt !== null;

const latencyPoints = (rows: readonly IncomeDocumentObservation[]): LatencyPoint[] =>
  rows.filter(isPaidInvoice).map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.settledAt, expectedAt: o.expectedAt }));

export function deriveBillingCadence(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: TimelinePoint[] = rows.map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.issuedAt }));
  return [cadenceMeasure({ measureKey: BILL01.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "billing-document",
    minSupport: BILL01.minSupport, windowDays: BILL01.windowDays, trendMinDelta: 2 }, pts, now, businessId)];
}

export function deriveBillingPaymentTiming(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  return [latencyMeasure({ measureKey: BILL02.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "billing-document",
    minSupport: BILL02.minSupport, windowDays: BILL02.windowDays, trendMinDelta: 2 }, latencyPoints(rows), now, businessId)];
}

export function deriveBillingLateShare(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter(isPaidInvoice).map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.settledAt,
    hit: calendarDays(o.expectedAt, o.settledAt) > 0 }));
  return [shareMeasure({ measureKey: BILL03.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "billing-document",
    minSupport: BILL03.minSupport, windowDays: BILL03.windowDays }, pts, now, businessId)];
}

export function deriveQuoteConversion(rows: readonly QuoteObservation[], now: Date, businessId: number): MeasureResult[] {
  const matured = rows.filter((q) => q.converted || (now.getTime() - q.issuedAt.getTime() >= QUOTE_MATURITY_DAYS * DAY
    && (q.validUntil === null || q.validUntil.getTime() < now.getTime())));
  const pts: SharePoint[] = matured.map((q) => ({ recordId: q.recordId, businessId: q.businessId, at: q.issuedAt, hit: q.converted }));
  return [shareMeasure({ measureKey: BILL04.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "billing-quote",
    minSupport: BILL04.minSupport, windowDays: BILL04.windowDays }, pts, now, businessId)];
}

export function deriveCreditNoteShare(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows
    .filter((o) => o.docType === "TAX_INVOICE" && now.getTime() - o.issuedAt.getTime() >= CREDIT_MATURITY_DAYS * DAY)
    .map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.issuedAt, hit: o.hasCreditNote }));
  return [shareMeasure({ measureKey: BILL05.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "billing-document",
    minSupport: BILL05.minSupport, windowDays: BILL05.windowDays }, pts, now, businessId)];
}

/** Per customer, by the explicit `customerId` foreign key only. Documents without one teach nothing about any customer. */
function perCustomer(rows: readonly IncomeDocumentObservation[]): Map<number, IncomeDocumentObservation[]> {
  return groupByEntity(rows.filter((o) => o.customerId !== null), (o) => o.customerId as number);
}

export function deriveCustomerPaymentTiming(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  return [...perCustomer(rows)].map(([customerId, group]) => latencyMeasure({ measureKey: CUST01.measureKey, entityType: "customer", entityId: customerId,
    valueUnit: "days", evidenceKind: "billing-document", minSupport: CUST01.minSupport, windowDays: CUST01.windowDays, trendMinDelta: 3 },
    latencyPoints(group), now, businessId));
}

export function deriveCustomerCadence(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  return [...perCustomer(rows)].map(([customerId, group]) => cadenceMeasure({ measureKey: CUST02.measureKey, entityType: "customer", entityId: customerId,
    valueUnit: "days", evidenceKind: "billing-document", minSupport: CUST02.minSupport, windowDays: CUST02.windowDays, trendMinDelta: 7 },
    group.map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.issuedAt })), now, businessId));
}

export function deriveCustomerTicketSize(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  return [...perCustomer(rows)].map(([customerId, group]) => valueMeasure({ measureKey: CUST03.measureKey, entityType: "customer", entityId: customerId,
    valueUnit: "currency", evidenceKind: "billing-document", minSupport: CUST03.minSupport, windowDays: CUST03.windowDays },
    group.map((o): ValuePoint => ({ recordId: o.recordId, businessId: o.businessId, at: o.issuedAt, value: o.total })), now, businessId));
}

/** A link is RESOLVED once it is no longer pending, or its expiry has passed (it can no longer be paid). */
const resolved = (p: PaymentRequestObservation, now: Date) =>
  p.status !== "PENDING" || (p.expiresAt !== null && p.expiresAt.getTime() < now.getTime());

export function deriveLinkConversion(rows: readonly PaymentRequestObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter((p) => resolved(p, now)).map((p) => ({ recordId: p.recordId, businessId: p.businessId, at: p.createdAt, hit: p.status === "PAID" }));
  return [shareMeasure({ measureKey: PAY01.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "payment-request",
    minSupport: PAY01.minSupport, windowDays: PAY01.windowDays }, pts, now, businessId)];
}

export function deriveLinkTimeToPay(rows: readonly PaymentRequestObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: LatencyPoint[] = rows.filter((p) => p.status === "PAID" && p.paidAt !== null)
    .map((p) => ({ recordId: p.recordId, businessId: p.businessId, at: p.paidAt as Date, expectedAt: p.createdAt }));
  return [latencyMeasure({ measureKey: PAY02.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "payment-request",
    minSupport: PAY02.minSupport, windowDays: PAY02.windowDays, trendMinDelta: 1 }, pts, now, businessId)];
}

export function deriveReminderTiming(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: LatencyPoint[] = rows.filter((o) => o.docType === "TAX_INVOICE" && o.firstReminderAt !== null && o.expectedAt !== null)
    .map((o) => ({ recordId: o.recordId, businessId: o.businessId, at: o.firstReminderAt as Date, expectedAt: o.expectedAt as Date }));
  return [latencyMeasure({ measureKey: COLL01.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "collection-action",
    minSupport: COLL01.minSupport, windowDays: COLL01.windowDays, trendMinDelta: 3 }, pts, now, businessId)];
}

/**
 * Overdue invoices — due day at least OVERDUE_GRACE_DAYS behind, not cancelled by credit — and whether
 * the owner recorded a reminder before the invoice was paid (or, if unpaid, by now).
 */
export function deriveOverdueRemindedShare(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = [];
  for (const o of rows) {
    if (o.docType !== "TAX_INVOICE" || o.creditedOut || o.expectedAt === null) continue;
    const graceEnd = o.expectedAt.getTime() + OVERDUE_GRACE_DAYS * DAY;
    const settled = o.settledAt?.getTime() ?? null;
    const becameOverdue = settled === null ? graceEnd < now.getTime() : settled > graceEnd;
    if (!becameOverdue) continue;
    const cutoff = settled ?? now.getTime();
    pts.push({ recordId: o.recordId, businessId: o.businessId, at: new Date(graceEnd),
      hit: o.firstReminderAt !== null && o.firstReminderAt.getTime() <= cutoff });
  }
  return [shareMeasure({ measureKey: COLL02.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "billing-document",
    minSupport: COLL02.minSupport, windowDays: COLL02.windowDays }, pts.filter((p) => p.at.getTime() <= now.getTime()), now, businessId)];
}

/** Reminded invoices whose follow window has closed, and whether they were settled inside it. SEQUENCE, never cause. */
export function deriveSettledAfterReminderShare(rows: readonly IncomeDocumentObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = [];
  for (const o of rows) {
    if (o.docType !== "TAX_INVOICE" || o.creditedOut || o.firstReminderAt === null) continue;
    const r = o.firstReminderAt.getTime();
    const windowEnd = r + REMINDER_FOLLOW_DAYS * DAY;
    if (o.settledAt !== null && o.settledAt.getTime() < r) continue; // paid before any reminder: not in this population
    if (windowEnd > now.getTime() && (o.settledAt === null || o.settledAt.getTime() > windowEnd)) continue; // still open
    pts.push({ recordId: o.recordId, businessId: o.businessId, at: o.firstReminderAt,
      hit: o.settledAt !== null && o.settledAt.getTime() >= r && o.settledAt.getTime() <= windowEnd });
  }
  const m = shareMeasure({ measureKey: COLL03.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "collection-action",
    minSupport: COLL03.minSupport, windowDays: COLL03.windowDays }, pts, now, businessId);
  return [{ ...m, detail: { ...(m.detail ?? {}), caveat: "SEQUENCE_NOT_CAUSE" } }];
}

/* ─────────────────────────────── rules ─────────────────────────────── */

export function makeIncomeDocumentSource(load: EvidenceSource<IncomeDocumentObservation>["load"]): EvidenceSource<IncomeDocumentObservation> {
  return { key: "billing.income-documents", windowDays: INCOME_WINDOW_DAYS, load };
}
export function makeQuoteSource(load: EvidenceSource<QuoteObservation>["load"]): EvidenceSource<QuoteObservation> {
  return { key: "billing.quotes", windowDays: INCOME_WINDOW_DAYS, load };
}
export function makePaymentRequestSource(load: EvidenceSource<PaymentRequestObservation>["load"]): EvidenceSource<PaymentRequestObservation> {
  return { key: "payments.requests", windowDays: INCOME_WINDOW_DAYS, load };
}

type R<T> = KnowledgeRule<T>;
// The tenant is read off the sample, exactly as payables does: `derive` stays pure and total, and the
// derivation service overwrites the evidence set's owner with the trusted caller id before persisting.
const rule = <T extends { readonly businessId: number }>(
  descriptor: RuleDescriptor,
  source: EvidenceSource<T>,
  derive: (rows: readonly T[], now: Date, businessId: number) => MeasureResult[],
): R<T> => ({ descriptor, source, derive: (rows, now) => derive(rows, now, rows[0]?.businessId ?? 0) });

export function incomeRules(
  docs: EvidenceSource<IncomeDocumentObservation>,
  quotes: EvidenceSource<QuoteObservation>,
  requests: EvidenceSource<PaymentRequestObservation>,
): [R<IncomeDocumentObservation>[], R<QuoteObservation>[], R<PaymentRequestObservation>[]] {
  return [
    [
      rule(BILL01, docs, deriveBillingCadence),
      rule(BILL02, docs, deriveBillingPaymentTiming),
      rule(BILL03, docs, deriveBillingLateShare),
      rule(BILL05, docs, deriveCreditNoteShare),
      rule(CUST01, docs, deriveCustomerPaymentTiming),
      rule(CUST02, docs, deriveCustomerCadence),
      rule(CUST03, docs, deriveCustomerTicketSize),
      rule(COLL01, docs, deriveReminderTiming),
      rule(COLL02, docs, deriveOverdueRemindedShare),
      rule(COLL03, docs, deriveSettledAfterReminderShare),
    ],
    [rule(BILL04, quotes, deriveQuoteConversion)],
    [rule(PAY01, requests, deriveLinkConversion), rule(PAY02, requests, deriveLinkTimeToPay)],
  ];
}
