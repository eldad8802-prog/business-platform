import { BillingDocumentStatus, Prisma } from "@prisma/client";

/**
 * What makes an accounting document count against a real debt.
 *
 * THE DEFECT THIS CLOSES. A receipt's allocations reduced an invoice's
 * outstanding balance from the moment they were written, which is while the
 * receipt is still a DRAFT. The same codebase already applied the opposite —
 * and correct — rule to the other instrument: the collection loader counts only
 * an ISSUED credit note, on the stated ground that a draft is an intention and
 * must not remove a real debt. Both rules could not be right.
 *
 * So the lifecycle rule is stated once, here, and the two instruments are
 * filtered through the same constant. An unissued document is a plan; an issued
 * one is a legal record. Only the second moves money anyone is owed.
 *
 * WHY THIS IS A WHERE CLAUSE AND NOT A PREDICATE. The three readers all sum
 * money in the database rather than in memory — one over a relation, one over
 * an aggregate. A rule expressed as a TypeScript predicate could not reach
 * either, and a rule restated in three query objects is three rules waiting to
 * drift. A shared `where` fragment is the one form all three can take verbatim.
 *
 * WHAT THIS IS NOT. Nothing here decides whether an allocation may be *written*.
 * A draft receipt may still hold prepared allocations — that is how issuance
 * works, and C1 proved the allocation survives the transition untouched. This
 * module only decides when those rows begin to count.
 */

/**
 * The single lifecycle threshold. Both filters below are built from it, so the
 * receipt rule and the credit-note rule are not merely alike — they are the
 * same constant, and a test asserts it.
 */
export const AUTHORITATIVE_DOCUMENT_STATUS = BillingDocumentStatus.ISSUED;

/**
 * Allocations that actually reduce an invoice balance: those whose receipt has
 * been issued.
 *
 * TENANCY. `businessId` is repeated inside the nested predicate on purpose.
 * This filter introduces a join from an allocation row to the document that
 * produced it, and a foreign key does not know about tenants — a row whose
 * `receiptDocumentId` pointed at another business's receipt would otherwise be
 * qualified by that foreign document's status. Naming the business on both
 * sides of the join makes such a row unmatchable by construction rather than by
 * assumption, and the C2 battery plants exactly that row to prove it.
 *
 * The caller keeps its own `businessId` predicate; this one is additional, not
 * a replacement.
 */
export function authoritativeAllocationWhere(
  businessId: number
): Prisma.BillingPaymentAllocationWhereInput {
  return {
    receiptDocument: {
      businessId,
      status: AUTHORITATIVE_DOCUMENT_STATUS,
    },
  };
}

/**
 * Credit notes that actually reduce an invoice balance.
 *
 * Behaviourally identical to the filter both readers already carried inline —
 * this is the existing rule lifted into the shared module, not a new one, so
 * that the two instruments visibly share one lifecycle threshold instead of
 * agreeing by coincidence.
 */
export function authoritativeCreditNoteWhere(): Prisma.BillingDocumentWhereInput {
  return {
    documentType: "CREDIT_NOTE",
    status: AUTHORITATIVE_DOCUMENT_STATUS,
  };
}
