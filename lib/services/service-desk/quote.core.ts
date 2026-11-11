/**
 * Service Desk 1.3c — quotes: the pure rules of the service side. No database, no clock, no network, no input mutation.
 *
 * Billing quote documents are never issued (billing-issue refuses QUOTE): they stay DRAFT / PENDING_REVIEW, can still be
 * edited, and billing re-renders their PDF on demand. So when a quote is SENT the service freezes its own record of it:
 *   - docHash     = sha256 of the CANONICAL CONTENT below, computed from the billing document's own rows (never from a
 *                   rendered file, never from a client) — what the approval binds to (version + total + docHash);
 *   - totalAgorot = the billing document's totalAmount in exact agorot (decimal text → integer, no float);
 *   - the PDF     = the bytes the customer received, stored content-addressed in the service storage domain.
 *
 * Canonical content, version "sdq1" — a JSON ARRAY (no object keys, so no key-order question), UTF-8, no whitespace,
 * JSON.stringify string escaping:
 *   ["sdq1", documentType, currency, customerId, customerNameSnapshot | null, validUntil "YYYY-MM-DD" | null,
 *    subtotalAgorot, vatAgorot, totalAgorot,
 *    [[lineIndex, description, quantity, unitPrice, vatRatePercent, lineSubtotalAgorot, lineVatAgorot, lineTotalAgorot], …]]
 *   - lines ordered by lineIndex ascending;
 *   - quantity and unitPrice as decimal text with exactly 4 fraction digits (their Decimal(18,4) scale), vatRatePercent with
 *     exactly 2 (Decimal(5,2)); a leading "-" only for a negative value, no "+", no leading zeros ("0.5000", "12.0000");
 *   - every money amount (Decimal(18,2)) as an integer number of agorot;
 *   - texts exactly as stored (no trimming, no Unicode normalisation): a changed character is a changed quote.
 * Not part of the content: ids (other than the customer), the document number (billing allocates it lazily, at the first
 * render), status, timestamps, PDF metadata — none of them changes what was offered.
 */
import { createHash } from "node:crypto";

import type { QuoteApprovalMethod, ServiceCaseAction, ServiceCaseViolationCode, ServiceQuoteSnapshot } from "./contracts";

export const QUOTE_CANONICAL_VERSION = "sdq1";
/** ServiceQuote.totalAgorot / ServiceCaseCharge.amountAgorot are INTEGER (int4). */
export const MAX_QUOTE_AGOROT = 2_147_483_647;

/** The billing document as the service reads it (decimals as their database text, dates as YYYY-MM-DD). */
export interface BillingQuoteDocument {
  id: number;
  businessId: number;
  documentType: string;
  status: string;
  currency: string;
  customerId: number | null;
  customerNameSnapshot: string | null;
  validUntil: string | null;
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  convertedToInvoiceId: number | null;
}

export interface BillingQuoteLine {
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
}

/** Why a billing document cannot be sent as this case's quote. Tokens only (they travel in the error details). */
export type QuoteDocumentViolation =
  | "QUOTE_DOCUMENT_NOT_FOUND"
  | "QUOTE_DOCUMENT_NOT_QUOTE"
  | "QUOTE_DOCUMENT_CURRENCY"
  | "QUOTE_DOCUMENT_CUSTOMER_MISMATCH"
  | "QUOTE_DOCUMENT_NO_LINES"
  | "QUOTE_DOCUMENT_CONVERTED"
  | "QUOTE_DOCUMENT_ISSUED"
  | "QUOTE_DOCUMENT_AMOUNT_INVALID";

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Exact decimal text at a fixed scale ("1" → "1.0000" at 4). null when malformed or more precise than the scale. */
export function normalizeDecimal(text: string, scale: number): string | null {
  if (typeof text !== "string" || !Number.isInteger(scale) || scale < 0) return null;
  const m = DECIMAL.exec(text.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > scale) return null;
  const int = m[2].replace(/^0+(?=\d)/, "");
  const digits = frac.padEnd(scale, "0");
  const zero = /^0+$/.test(int) && /^0*$/.test(digits);
  const sign = m[1] === "-" && !zero ? "-" : "";
  return scale === 0 ? `${sign}${int}` : `${sign}${int}.${digits}`;
}

/** A money amount (scale ≤ 2) as an exact integer of agorot — never through a float. null when not exact or too large. */
export function decimalToAgorot(text: string): number | null {
  const n = normalizeDecimal(text, 2);
  if (n === null) return null;
  const negative = n.startsWith("-");
  const digits = n.replace("-", "").replace(".", "");
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value > MAX_QUOTE_AGOROT) return null;
  return negative ? -value : value;
}

export type CanonicalQuote = { ok: true; text: string; docHash: string; totalAgorot: number } | { ok: false; violation: QuoteDocumentViolation };

/** The canonical content of a quote (see the file header) and its sha256 (64 lowercase hex). */
export function canonicalQuoteContent(doc: BillingQuoteDocument, lines: readonly BillingQuoteLine[]): CanonicalQuote {
  const subtotal = decimalToAgorot(doc.subtotalAmount);
  const vat = decimalToAgorot(doc.vatAmount);
  const total = decimalToAgorot(doc.totalAmount);
  if (subtotal === null || vat === null || total === null || total < 0) return { ok: false, violation: "QUOTE_DOCUMENT_AMOUNT_INVALID" };
  const sorted = [...lines].sort((a, b) => a.lineIndex - b.lineIndex);
  const out: unknown[] = [];
  for (const l of sorted) {
    const quantity = normalizeDecimal(l.quantity, 4);
    const unitPrice = normalizeDecimal(l.unitPrice, 4);
    const rate = normalizeDecimal(l.vatRatePercent, 2);
    const ls = decimalToAgorot(l.lineSubtotal), lv = decimalToAgorot(l.vatAmount), lt = decimalToAgorot(l.lineTotal);
    if (!Number.isInteger(l.lineIndex) || typeof l.description !== "string" || quantity === null || unitPrice === null || rate === null || ls === null || lv === null || lt === null) {
      return { ok: false, violation: "QUOTE_DOCUMENT_AMOUNT_INVALID" };
    }
    out.push([l.lineIndex, l.description, quantity, unitPrice, rate, ls, lv, lt]);
  }
  const text = JSON.stringify([
    QUOTE_CANONICAL_VERSION, doc.documentType, doc.currency, doc.customerId, doc.customerNameSnapshot ?? null, doc.validUntil ?? null,
    subtotal, vat, total, out,
  ]);
  return { ok: true, text, docHash: createHash("sha256").update(text, "utf8").digest("hex"), totalAgorot: total };
}

/**
 * May this billing document be sent as the quote of this case? Same business (a document of another business is simply
 * not found — the read runs under the tenant's RLS and names the business), a QUOTE, in ILS, of the case's customer, with
 * at least one line, not converted to an invoice yet, never issued (billing never issues a quote — fail closed if one is).
 */
export function checkQuoteDocument(
  doc: BillingQuoteDocument | null,
  lines: readonly BillingQuoteLine[],
  expect: { businessId: number; customerId: number },
): { ok: true; content: Extract<CanonicalQuote, { ok: true }> } | { ok: false; violations: QuoteDocumentViolation[] } {
  if (!doc || doc.businessId !== expect.businessId) return { ok: false, violations: ["QUOTE_DOCUMENT_NOT_FOUND"] };
  const v: QuoteDocumentViolation[] = [];
  if (doc.documentType !== "QUOTE") v.push("QUOTE_DOCUMENT_NOT_QUOTE");
  if (doc.currency !== "ILS") v.push("QUOTE_DOCUMENT_CURRENCY");
  if (doc.customerId === null || doc.customerId !== expect.customerId) v.push("QUOTE_DOCUMENT_CUSTOMER_MISMATCH");
  if (lines.length === 0) v.push("QUOTE_DOCUMENT_NO_LINES");
  if (doc.convertedToInvoiceId !== null) v.push("QUOTE_DOCUMENT_CONVERTED");
  if (doc.status === "ISSUED") v.push("QUOTE_DOCUMENT_ISSUED");
  const content = canonicalQuoteContent(doc, lines);
  if (!content.ok) v.push(content.violation);
  if (v.length > 0 || !content.ok) return { ok: false, violations: v };
  return { ok: true, content };
}

// ── The owner's decision on a sent version ─────────────────────────────────────────────────────────────────

export const OWNER_APPROVAL_METHODS = ["PHONE", "IN_PERSON"] as const satisfies readonly QuoteApprovalMethod[];

export type QuoteDecisionInput =
  | { ok: true; decision: "APPROVE"; method: (typeof OWNER_APPROVAL_METHODS)[number] }
  | { ok: true; decision: "REJECT"; method: (typeof OWNER_APPROVAL_METHODS)[number] }
  | { ok: false; field: "decision" | "method"; linkRefused?: true };

/**
 * The owner records the customer's answer: APPROVE or REJECT, received by PHONE or IN_PERSON (actor OWNER_USER). LINK is
 * the customer's secure link (actor CUSTOMER_LINK) — a contract only, refused here (`linkRefused`).
 */
export function readQuoteDecision(body: { decision?: unknown; method?: unknown }): QuoteDecisionInput {
  if (body.decision !== "APPROVE" && body.decision !== "REJECT") return { ok: false, field: "decision" };
  if (body.method === "LINK") return { ok: false, field: "method", linkRefused: true };
  if (!(OWNER_APPROVAL_METHODS as readonly unknown[]).includes(body.method)) return { ok: false, field: "method" };
  return { ok: true, decision: body.decision, method: body.method as (typeof OWNER_APPROVAL_METHODS)[number] };
}

/** A stored version that can never be decided, by its own state (the core judges the CURRENT version; this names the row). */
export function quoteRowRefusal(state: ServiceQuoteSnapshot["state"]): ServiceCaseViolationCode | null {
  if (state === "SUPERSEDED") return "QUOTE_SUPERSEDED";
  if (state === "WITHDRAWN") return "QUOTE_WITHDRAWN";
  if (state !== "SENT") return "QUOTE_NOT_AWAITING_DECISION";
  return null;
}

/** The core action for a decision on version `row`: an approval names that row's exact version, total and document hash. */
export function decisionAction(
  row: { version: number; totalAgorot: number; docHash: string },
  d: Extract<QuoteDecisionInput, { ok: true }>,
): Extract<ServiceCaseAction, { type: "APPROVE_QUOTE" | "REJECT_QUOTE" }> {
  return d.decision === "APPROVE"
    ? { type: "APPROVE_QUOTE", approval: { version: row.version, totalAgorot: row.totalAgorot, docHash: row.docHash, method: d.method } }
    : { type: "REJECT_QUOTE", version: row.version };
}

/**
 * The charge an approval records (owner decision 2026-11-11, migration 20261126090000): CHARGEABLE at exactly the approved
 * total, source APPROVED_QUOTE, quoteVersion = the approved version. A ₪0 quote (possible only under an approved cover — the
 * core refuses it otherwise) records NO charge: free of charge is the owner's separate NO_CHARGE decision with its reason,
 * which an approval cannot supply (CHECK ServiceCaseCharge_mode: CHARGEABLE needs an amount > 0).
 */
export function chargeForApproval(approved: { version: number; totalAgorot: number }): { mode: "CHARGEABLE"; amountAgorot: number; source: "APPROVED_QUOTE"; quoteVersion: number } | null {
  if (!Number.isInteger(approved.totalAgorot) || approved.totalAgorot <= 0) return null;
  return { mode: "CHARGEABLE", amountAgorot: approved.totalAgorot, source: "APPROVED_QUOTE", quoteVersion: approved.version };
}

/** True for bytes that start like a PDF. */
export const looksLikePdf = (b: Uint8Array) => b.length > 5 && Buffer.from(b.subarray(0, 5)).toString("latin1") === "%PDF-";
