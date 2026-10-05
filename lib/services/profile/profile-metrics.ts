/**
 * The three Profile metrics, each a count Dubiz can prove from its own records.
 *
 *   activeCustomers  — `Customer` rows the business has not deactivated.
 *   issuedDocuments  — billing documents the business has ISSUED. Dubiz records
 *                      issuing; it does not record sending (sharing goes through
 *                      wa.me / the share sheet and leaves no trace), so this is
 *                      "שהופקו", never "נשלחו".
 *   activeQuotes     — see {@link activeQuoteWhere}.
 *
 * There is no fourth metric. A customer e-signature rate would need customer
 * signing, which does not exist.
 *
 * Every count runs on the caller's tenant transaction client AND names the
 * business explicitly, so it is scoped twice: by RLS and by the WHERE.
 */
import { BillingDocumentStatus, BillingDocumentType, type Prisma } from "@prisma/client";

import type { TenantTxClient } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type ProfileMetrics = {
  activeCustomers: number;
  issuedDocuments: number;
  activeQuotes: number;
};

/**
 * The first instant a quote dated `validUntil` is no longer valid, expressed as
 * the value `validUntil` must be at least.
 *
 * A quote's validity is a calendar date: the owner picks "YYYY-MM-DD" and it is
 * stored as that date's UTC midnight. A quote valid until 5 October is valid for
 * all of 5 October in Israel, so it stays active while `validUntil` is on or
 * after today's Israeli date — i.e. `validUntil >= <today>T00:00Z`.
 */
export function quoteValidityThreshold(now: Date): Date {
  return new Date(`${jerusalemDayKey(now)}T00:00:00.000Z`);
}

/**
 * Active quote = a QUOTE that has not been converted to an invoice and has not
 * expired.
 *
 *   converted  — `convertedToInvoiceId` is set (the only conversion record).
 *   expired    — `validUntil` is before today's Israeli date. A quote with no
 *                `validUntil` has no expiry, so it stays active until converted.
 *
 * Status is deliberately NOT part of the rule: a quote is never ISSUED (the issue
 * service refuses quotes, and conversion requires an editable quote), so every
 * quote lives in DRAFT / PENDING_REVIEW for its whole life. Dubiz also records no
 * "sent", "declined" or "cancelled" state for a quote — an unconverted, unexpired
 * quote the owner abandoned still counts, because nothing says otherwise.
 */
export function activeQuoteWhere(businessId: number, now: Date): Prisma.BillingDocumentWhereInput {
  return {
    businessId,
    documentType: BillingDocumentType.QUOTE,
    convertedToInvoiceId: null,
    OR: [{ validUntil: null }, { validUntil: { gte: quoteValidityThreshold(now) } }],
  };
}

/** Sequential, not Promise.all: a transaction client is a single connection. */
export async function loadProfileMetrics(
  tx: TenantTxClient,
  businessId: number,
  now: Date,
): Promise<ProfileMetrics> {
  const activeCustomers = await tx.customer.count({
    where: { businessId, isActive: true },
  });
  const issuedDocuments = await tx.billingDocument.count({
    where: { businessId, status: BillingDocumentStatus.ISSUED },
  });
  const activeQuotes = await tx.billingDocument.count({
    where: activeQuoteWhere(businessId, now),
  });
  return { activeCustomers, issuedDocuments, activeQuotes };
}
