/**
 * Service Desk — the balance of a service case, computed from its charge (ServiceCaseCharge, the last record), its
 * active billing links (ServiceCaseBillingLink) and the billing facts of those documents (billing's read-only
 * readDocumentsSettlement, #1102). Pure: no database, no clock. Billing reports facts; this decides what the case owes.
 *
 * Rules (owner decisions 2026-11-11; billing contract v2):
 *   - No charge record → UNKNOWN (NO_CHARGE_DECISION). The absence of a document is never "no debt".
 *   - NO_CHARGE (the owner's explicit decision, with a reason) and no linked document → NO_CHARGE, 0.
 *   - CHARGEABLE amount C:
 *       documented = Σ over linked charge documents of (total − credited)          (credits come with their invoice)
 *       paid       = Σ over linked tax invoices of (net − outstanding)              (billing's own outstanding rule)
 *                  + Σ over linked tax invoice / receipts of their net              (self-settled, counted once)
 *                  + Σ over linked standalone receipts of notAttributedToAnyInvoice (never their allocated part:
 *                    that money reaches a case only through an invoice's outstanding — no double count)
 *       open       = C − paid;  open ≤ 0 → SETTLED (an overpayment is reported, never silently 0)
 *                   open ≤ Σ linked outstanding → OPEN (the whole open amount is documented)
 *                   otherwise → CHARGE_NOT_DOCUMENTED (part of the charge has no document yet — a debt, e.g. an
 *                   exempt dealer, who issues no tax invoice)
 *   - Any contradiction → UNKNOWN, never corrected automatically: a linked document missing / of another business /
 *     not a settlement document / of the wrong type for its link (CONFLICT); a draft (DRAFT_PENDING); a foreign currency
 *     (FOREIGN_CURRENCY); documented above the charge, or NO_CHARGE with linked documents (CONFLICT); facts that do
 *     not cover a requested id or do not add up (READ_ERROR).
 */
import type { ServiceCaseSettlement } from "./settlement";

/** The current charge of a case (the last ServiceCaseCharge record), or null when none was recorded. */
export type CaseCharge = { mode: "CHARGEABLE"; amountAgorot: number } | { mode: "NO_CHARGE" } | null;

/** An ACTIVE ServiceCaseBillingLink (unlinkedAt IS NULL). */
export type CaseBillingLink = { billingDocumentId: number; role: "CHARGE" | "STANDALONE_PAYMENT" | "AFTER_SALE_CREDIT" };

/** AFTER_SALE_CREDIT links are the record of a T7 credit (it refunds the original sale): never part of the balance. */
const balanceLinks = (links: readonly CaseBillingLink[]) => links.filter((l) => l.role !== "AFTER_SALE_CREDIT");

/**
 * The subset of billing's DocumentsSettlement (#1102) this needs — copied structurally, so the service side does not
 * import a billing module that is not merged yet. Amounts are integer agorot.
 */
export type BillingSettlementFacts = {
  documents: { id: number; type: string | null; flag: "NOT_FOUND" | "NOT_ISSUED" | "NOT_ILS" | "NOT_A_SETTLEMENT_DOCUMENT" | null }[];
  invoices: { id: number; totalAgorot: number; creditedAgorot: number; outstandingAgorot: number }[];
  receipts: { id: number; type: "RECEIPT" | "TAX_INVOICE_RECEIPT"; totalAgorot: number; notAttributedToAnyInvoiceAgorot: number }[];
  credits: { creditNoteId: number; invoiceDocumentId: number; amountAgorot: number }[];
};

export type CaseBalance = ServiceCaseSettlement & {
  /** the explanation shown to the owner; amounts in agorot (null when unknown) */
  detail: { chargeAgorot: number | null; documentedAgorot: number | null; paidAgorot: number | null; overpaidAgorot: number };
};

type Unknown = Extract<ServiceCaseSettlement, { state: "UNKNOWN" }>["reason"];

const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function unknown(reason: Unknown, chargeAgorot: number | null = null): CaseBalance {
  return { state: "UNKNOWN", openBalanceAgorot: null, reason, detail: { chargeAgorot, documentedAgorot: null, paidAgorot: null, overpaidAgorot: 0 } };
}

const CHARGE_TYPES = new Set(["TAX_INVOICE", "TAX_INVOICE_RECEIPT"]);

/** Validates the links against the facts; returns the reason the balance cannot be known, or null. */
function linkProblem(links: readonly CaseBillingLink[], facts: BillingSettlementFacts): Unknown | null {
  const seen = new Set<number>();
  const order: Unknown[] = [];
  for (const l of links) {
    if (!Number.isSafeInteger(l.billingDocumentId) || seen.has(l.billingDocumentId)) return "CONFLICT";
    seen.add(l.billingDocumentId);
    const d = facts.documents.find((x) => x.id === l.billingDocumentId);
    if (!d) return "READ_ERROR";
    if (d.flag === "NOT_FOUND" || d.flag === "NOT_A_SETTLEMENT_DOCUMENT") return "CONFLICT";
    if (d.flag === "NOT_ILS") order.push("FOREIGN_CURRENCY");
    else if (d.flag === "NOT_ISSUED") order.push("DRAFT_PENDING");
    else if (d.flag !== null) return "READ_ERROR";
    if (d.flag === null) {
      const fits = l.role === "CHARGE" ? CHARGE_TYPES.has(d.type ?? "") : d.type === "RECEIPT";
      if (!fits) return "CONFLICT";
    }
  }
  return order.includes("FOREIGN_CURRENCY") ? "FOREIGN_CURRENCY" : order.includes("DRAFT_PENDING") ? "DRAFT_PENDING" : null;
}

/** documented = Σ net of the linked charge documents; paid via those documents; their open part. */
function chargeDocuments(links: readonly CaseBillingLink[], facts: BillingSettlementFacts):
  { documented: number; paid: number; docOpen: number } | Unknown {
  let documented = 0, paid = 0, docOpen = 0;
  for (const l of links) {
    if (l.role !== "CHARGE") continue;
    const type = facts.documents.find((x) => x.id === l.billingDocumentId)?.type;
    if (type === "TAX_INVOICE") {
      const inv = facts.invoices.find((x) => x.id === l.billingDocumentId);
      if (!inv || ![inv.totalAgorot, inv.creditedAgorot, inv.outstandingAgorot].every(isAmount)) return "READ_ERROR";
      const net = inv.totalAgorot - inv.creditedAgorot;
      if (net < 0 || inv.outstandingAgorot > net) return "CONFLICT";
      documented += net;
      paid += net - inv.outstandingAgorot;
      docOpen += inv.outstandingAgorot;
    } else {
      const r = facts.receipts.find((x) => x.id === l.billingDocumentId && x.type === "TAX_INVOICE_RECEIPT");
      if (!r || !isAmount(r.totalAgorot)) return "READ_ERROR";
      // Billing reports no credited total for a tax invoice / receipt and no currency per credit note: a credit against
      // one is not netted here (no cross-currency sum) — the balance is UNKNOWN until the owner resolves it.
      if (facts.credits.some((c) => c.invoiceDocumentId === r.id)) return "CONFLICT";
      documented += r.totalAgorot;
      paid += r.totalAgorot;
    }
  }
  return { documented, paid, docOpen };
}

export function computeCaseBalance(charge: CaseCharge, allLinks: readonly CaseBillingLink[], facts: BillingSettlementFacts): CaseBalance {
  const links = balanceLinks(allLinks);
  if (charge === null) return unknown("NO_CHARGE_DECISION");
  const problem = linkProblem(links, facts);
  if (charge.mode === "NO_CHARGE") {
    if (links.length > 0) return unknown(problem ?? "CONFLICT");
    return { state: "NO_CHARGE", openBalanceAgorot: 0, detail: { chargeAgorot: 0, documentedAgorot: 0, paidAgorot: 0, overpaidAgorot: 0 } };
  }
  const C = charge.amountAgorot;
  if (!isAmount(C) || C === 0) return unknown("READ_ERROR");
  if (problem) return unknown(problem, C);

  const docs = chargeDocuments(links, facts);
  if (typeof docs === "string") return unknown(docs, C);
  let paid = docs.paid;
  for (const l of links) {
    if (l.role !== "STANDALONE_PAYMENT") continue;
    const r = facts.receipts.find((x) => x.id === l.billingDocumentId && x.type === "RECEIPT");
    if (!r || !isAmount(r.notAttributedToAnyInvoiceAgorot) || r.notAttributedToAnyInvoiceAgorot > r.totalAgorot) return unknown("READ_ERROR", C);
    paid += r.notAttributedToAnyInvoiceAgorot;
  }
  if (docs.documented > C) return unknown("CONFLICT", C);

  const open = C - paid;
  const detail = { chargeAgorot: C, documentedAgorot: docs.documented, paidAgorot: paid, overpaidAgorot: open < 0 ? -open : 0 };
  if (open <= 0) return { state: "SETTLED", openBalanceAgorot: 0, ...(open < 0 ? { overpaidAgorot: -open } : {}), detail };
  if (open <= docs.docOpen) return { state: "OPEN", openBalanceAgorot: open, detail };
  return { state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: open, detail };
}

/**
 * A charge change (a new ServiceCaseCharge record, also after a handover) must not contradict issued documents:
 * lowering below what is documented needs a credit note in billing first; NO_CHARGE needs no linked document.
 */
export function checkChargeChange(next: Exclude<CaseCharge, null>, allLinks: readonly CaseBillingLink[], facts: BillingSettlementFacts):
  { ok: true } | { ok: false; code: "NO_CHARGE_WITH_DOCUMENTS" | "CHARGE_BELOW_DOCUMENTED" | "BALANCE_UNKNOWN" } {
  const links = balanceLinks(allLinks);
  if (next.mode === "NO_CHARGE") return links.length > 0 ? { ok: false, code: "NO_CHARGE_WITH_DOCUMENTS" } : { ok: true };
  if (linkProblem(links, facts)) return { ok: false, code: "BALANCE_UNKNOWN" };
  const docs = chargeDocuments(links, facts);
  if (typeof docs === "string") return { ok: false, code: "BALANCE_UNKNOWN" };
  return next.amountAgorot < docs.documented ? { ok: false, code: "CHARGE_BELOW_DOCUMENTED" } : { ok: true };
}
