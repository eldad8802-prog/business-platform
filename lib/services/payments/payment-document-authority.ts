/**
 * SEC-01 — server-side amount authority for a document-linked payment request.
 *
 * The problem this closes: the invoice screen posted `amount: doc.totalAmount`
 * from the browser, and the server accepted whatever number arrived. A caller
 * could name a real invoice and pay one shekel against it. Nothing downstream
 * caught it — the webhook's coherence gate compares the callback to the STORED
 * request, and a stored request built from a manipulated amount is internally
 * consistent.
 *
 * WHERE THE AMOUNT COMES FROM. This module does not compute what is owed and
 * does not contain accounting. Billing already owns that question, in one pure,
 * exhaustively tested rule — `computeOutstanding` in
 * `lib/services/billing/collection/awaiting-payment.rules.ts`:
 *
 *     outstanding = total − allocated − credited, floored at zero
 *
 * The store applies that same rule (see `findPayableDocument`) and hands the
 * result here as a string. This module only DECIDES, over strings, whether a
 * requested amount is admissible against it. That split is deliberate: it keeps
 * one accounting rule in the system, and keeps the payments decision layer free
 * of Prisma so it stays testable without a database.
 *
 * PARTIAL PAYMENT IS ALLOWED. Billing already represents partial settlement —
 * `BillingPaymentAllocation` rows, the `PARTIALLY_PAID` settlement status, and
 * `isPartiallySettled` on the collection read-model. Requiring the full balance
 * would remove an existing business capability, so the rule is
 * `0 < amount ≤ outstanding`, not `amount === outstanding`.
 *
 * WHAT THIS DOES NOT DO. It validates; it writes nothing. No allocation is
 * created, no invoice is settled, no debt is closed. Linking a payment to a
 * document still records only the link — closing the debt is a separate,
 * later piece of work with its own compliance requirements.
 */

import { ValidationError } from "@/lib/errors";

/**
 * The only document type that can carry a debt.
 *
 * Mirrors `COLLECTIBLE_DOCUMENT_TYPE` in the billing collection rules (decision
 * D2 there): a TAX_INVOICE_RECEIPT was paid at issuance, and asking for money
 * against one would be asking twice. `payment-document-authority.test.ts`
 * asserts these two constants have not drifted apart.
 */
export const PAYABLE_DOCUMENT_TYPE = "TAX_INVOICE" as const;

/** Only an issued document has a legally meaningful amount. */
export const PAYABLE_DOCUMENT_STATUS = "ISSUED" as const;

/**
 * A billing document as the payments domain needs to see it: identity, the two
 * facts that decide whether it is payable at all, and the authoritative balance
 * already computed by Billing's own rule.
 *
 * Money is carried as a decimal STRING, matching every other amount in this
 * domain, so nothing here depends on Prisma.
 */
export interface PayableDocumentRef {
  id: number;
  businessId: number;
  documentType: string;
  status: string;
  currency: string;
  /** The document's own total. Present for diagnostics; never the payable. */
  totalAmount: string;
  /** Billing's `computeOutstanding`: total − allocated − credited, floored at 0. */
  outstandingAmount: string;
}

/**
 * Convert a 2-decimal money string to integer minor units.
 *
 * Every amount reaching this module has already been normalised to two decimals
 * (`normalizePaymentAmount` for the request, `Decimal(18,2)` for the document),
 * so integer comparison is exact and avoids float equality entirely. Returns
 * null for anything unparseable, which callers treat as a refusal.
 */
export function toMinorUnits(value: string): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const minor = Math.round(num * 100);
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

export interface AssertAmountPayableInput {
  /** The requested amount, already normalised to a 2-decimal string. */
  amount: string;
  /** The requested currency, already normalised to an upper-case ISO code. */
  currency: string;
}

/**
 * Decide whether `input` may be charged against `document`.
 *
 * Throws `ValidationError` with a specific reason on every refusal — the caller
 * surfaces it as a 4xx. Returns the authoritative outstanding amount on success
 * so the caller can record what it validated against.
 */
export function assertAmountPayableAgainstDocument(
  document: PayableDocumentRef,
  input: AssertAmountPayableInput
): { outstandingAmount: string } {
  if (document.documentType !== PAYABLE_DOCUMENT_TYPE) {
    throw new ValidationError(
      `A payment can only be collected against a ${PAYABLE_DOCUMENT_TYPE}; this document is a ${document.documentType}.`
    );
  }
  if (document.status !== PAYABLE_DOCUMENT_STATUS) {
    throw new ValidationError(
      `A payment can only be collected against an ${PAYABLE_DOCUMENT_STATUS} document; this document is ${document.status}.`
    );
  }

  // Currency verification. A request in one currency against a document in
  // another has no defensible meaning, and converting between them silently is
  // exactly the class of defect SEC-05 closed on the provider side.
  if (document.currency.toUpperCase() !== input.currency.toUpperCase()) {
    throw new ValidationError(
      `Currency mismatch: the document is in ${document.currency} and the payment was requested in ${input.currency}.`
    );
  }

  const outstanding = toMinorUnits(document.outstandingAmount);
  const requested = toMinorUnits(input.amount);
  if (outstanding === null || requested === null) {
    throw new ValidationError("Could not determine the payable amount.");
  }

  if (outstanding <= 0) {
    throw new ValidationError(
      "This document has no outstanding balance; there is nothing to collect."
    );
  }
  if (requested <= 0) {
    throw new ValidationError("amount must be a positive number");
  }
  if (requested > outstanding) {
    throw new ValidationError(
      `amount exceeds the document's outstanding balance of ${document.outstandingAmount} ${document.currency}.`
    );
  }

  return { outstandingAmount: document.outstandingAmount };
}
