/**
 * What a document must LOOK LIKE before it may be issued.
 *
 * Pure: no Prisma, no I/O, no clock. Extracted from the issue service so the
 * rule can be tested without a database and so the one place it differs by
 * document type is visible at a glance rather than buried in a 700-line
 * transaction.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Every document type but one states its money in goods lines, and the original
 * guard was written for those: no lines, nothing to issue. A pure RECEIPT is
 * the exception, and always was — it has no goods because it is not a claim for
 * anything. Its money IS its payment lines. The generic rule therefore rejected
 * every legitimate receipt, and no receipt could ever be issued, which was
 * proven by execution before this module existed.
 *
 * The fix is to ask the question per type, not to stop asking it. A receipt
 * still has to prove it holds money and that its stated total is that money.
 * The requirements for goods-bearing documents are untouched.
 */

import { BillingDocumentType, Prisma } from "@prisma/client";
import { ValidationError } from "@/lib/errors";

export interface IssuableTotals {
  subtotalAmount: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

export interface IssuableDocumentShape {
  documentType: BillingDocumentType;
  /** Goods/service lines. Empty for a pure receipt, by design. */
  lineCount: number;
  /** Payment lines. Present only on receipt-bearing types. */
  paymentAmounts: Prisma.Decimal[];
  /** What the document currently says about itself. */
  stored: IssuableTotals;
  /** What the goods lines add up to. Meaningless for a pure receipt. */
  recomputed: IssuableTotals;
}

/**
 * Throws unless the document is shaped like something that can be issued.
 *
 * Returns the totals that belong on the legal snapshot and the audit record.
 * For a goods-bearing document those are the recomputed ones; for a receipt
 * they are its stored ones, which this function has just proven equal its
 * payment lines. Re-deriving a receipt's totals from goods lines it does not
 * have would put a zero on the legal record for money that was really received.
 */
export function assertIssuableShape(doc: IssuableDocumentShape): IssuableTotals {
  if (doc.documentType === BillingDocumentType.RECEIPT) {
    if (doc.paymentAmounts.length === 0) {
      throw new ValidationError("Cannot issue a receipt with no payment lines");
    }

    const paymentsTotal = doc.paymentAmounts.reduce(
      (sum, amount) => sum.plus(amount),
      new Prisma.Decimal(0)
    );
    if (!paymentsTotal.equals(doc.stored.totalAmount)) {
      throw new ValidationError(
        "Receipt total is inconsistent with its payment lines"
      );
    }

    // A pure receipt records money received, never goods supplied. Anything in
    // the goods columns would mean the document is claiming to be something it
    // is not, and TAX_INVOICE_RECEIPT is the type for that.
    if (
      doc.lineCount > 0 ||
      !doc.stored.subtotalAmount.isZero() ||
      !doc.stored.vatAmount.isZero()
    ) {
      throw new ValidationError(
        "A receipt carries payment lines only — use a tax-invoice-receipt for goods"
      );
    }

    return doc.stored;
  }

  // Unchanged for every other type, including TAX_INVOICE_RECEIPT, which has
  // goods lines and is validated as the invoice-like document it is.
  if (doc.lineCount === 0) {
    throw new ValidationError("Cannot issue a document with no lines");
  }

  if (
    !doc.recomputed.subtotalAmount.equals(doc.stored.subtotalAmount) ||
    !doc.recomputed.vatAmount.equals(doc.stored.vatAmount) ||
    !doc.recomputed.totalAmount.equals(doc.stored.totalAmount)
  ) {
    throw new ValidationError("Document totals are inconsistent with line items");
  }

  return doc.recomputed;
}
