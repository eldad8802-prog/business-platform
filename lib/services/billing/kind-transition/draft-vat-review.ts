/**
 * 4a T3 — drafts created before "מעבר לעוסק מורשה" with a 0% VAT line must be reviewed before they are issued
 * (or, for a quote, finalized with a number). Owner decisions 2026-11-24 (D5–D8, QUOTE included).
 *
 * In scope (a document whose VAT means something), when the business has a BusinessKindTransition row:
 *   - TAX_INVOICE, TAX_INVOICE_RECEIPT, QUOTE;
 *   - CREDIT_NOTE only when the document it credits was issued on or after confirmedAt (a credit for a historical,
 *     pre-transition document follows that document's own VAT: never blocked);
 *   - never RECEIPT (payment lines only, no VAT).
 * "Created before the transition" = the draft's createdAt < confirmedAt, or, for an invoice converted from a quote, the
 * quote's createdAt < confirmedAt (a new draft made from an old quote does not reset the clock).
 * It needs a review when at least one line is 0%. Review = an explicit confirmation by a user of the business, recorded
 * as one append-only BillingAuditEvent (BILLING_DRAFT_VAT_REVIEW_CONFIRMED) bound to the business, the document, the
 * transition and the exact content (a fingerprint). Any change to that content invalidates it. A plain save never
 * records it. Nothing here changes a rate, a price, an amount or an issued document. Keeping 0% after the review is
 * allowed.
 *
 * Businesses without a transition: evaluate() reads one empty row set and returns NOT_REQUIRED, so their issuance is
 * unchanged.
 */
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { ConflictError } from "@/lib/errors";

export const DRAFT_VAT_REVIEW_EVENT = "BILLING_DRAFT_VAT_REVIEW_CONFIRMED" as const;
export const DRAFT_VAT_REVIEW_REQUIRED_CODE = "DRAFT_VAT_REVIEW_REQUIRED" as const;
/** Owner-approved wording (D8). */
export const DRAFT_VAT_REVIEW_MESSAGE =
  "המסמך נוצר לפני המעבר שלך לעוסק מורשה. לפני הפקת המסמך, יש לבדוק ולעדכן את שיעורי המע״מ בהתאם לסוג העסקה.";
export const DRAFT_VAT_REVIEW_BUTTON = "בדיקת מע״מ במסמך";

export type ReviewableDoc = {
  id: number;
  businessId: number;
  documentType: string;
  status: string;
  createdAt: Date;
  currency: string;
  customerId: number | null;
  referenceDocumentId: number | null;
  lines: Array<{ lineIndex: number; description: string; quantity: Prisma.Decimal | string | number; unitPrice: Prisma.Decimal | string | number; vatRatePercent: Prisma.Decimal | string | number }>;
};

export type DraftVatReviewState =
  | { required: false; reason: "NO_TRANSITION" | "CREATED_AFTER_TRANSITION" | "TYPE_NOT_IN_SCOPE" | "CREDIT_FOR_HISTORICAL_DOCUMENT" | "NO_ZERO_RATE_LINE" }
  | { required: true; reviewed: boolean; fingerprint: string; transitionId: number; transitionConfirmedAt: string; originCreatedAt: string; zeroRateLineIndexes: number[] };

const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v).toString();

/**
 * The content the review covers. Anything that can change which VAT treatment is right: the type, the currency, the
 * customer, the credited document, and every line's description, quantity, unit price and VAT rate.
 */
export function vatReviewFingerprint(doc: Pick<ReviewableDoc, "id" | "documentType" | "currency" | "customerId" | "referenceDocumentId" | "lines">): string {
  const lines = [...doc.lines].sort((a, z) => a.lineIndex - z.lineIndex).map((l) => [l.lineIndex, l.description, dec(l.quantity), dec(l.unitPrice), dec(l.vatRatePercent)]);
  const canonical = JSON.stringify({ v: 1, id: doc.id, t: doc.documentType, c: doc.currency, cu: doc.customerId, ref: doc.referenceDocumentId, lines });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const VAT_REVIEW_TYPES = ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "QUOTE", "CREDIT_NOTE"] as const;

type Tx = Prisma.TransactionClient;

/** Read-only: does this draft need a review, and is the latest review still valid for its exact content? */
export async function evaluateDraftVatReviewTx(tx: Tx, doc: ReviewableDoc): Promise<DraftVatReviewState> {
  const transition = await tx.businessKindTransition.findUnique({ where: { businessId: doc.businessId }, select: { id: true, confirmedAt: true } });
  if (!transition) return { required: false, reason: "NO_TRANSITION" };
  if (!(VAT_REVIEW_TYPES as readonly string[]).includes(doc.documentType)) return { required: false, reason: "TYPE_NOT_IN_SCOPE" };

  let origin = doc.createdAt;
  if (doc.documentType === "TAX_INVOICE") {
    const quote = await tx.billingDocument.findFirst({
      where: { businessId: doc.businessId, documentType: "QUOTE", convertedToInvoiceId: doc.id },
      select: { createdAt: true },
    });
    if (quote && quote.createdAt < origin) origin = quote.createdAt;
  }
  if (!(origin < transition.confirmedAt)) return { required: false, reason: "CREATED_AFTER_TRANSITION" };

  if (doc.documentType === "CREDIT_NOTE") {
    const credited = doc.referenceDocumentId === null ? null : await tx.billingDocument.findFirst({
      where: { id: doc.referenceDocumentId, businessId: doc.businessId }, select: { issuedAt: true },
    });
    // No credited document, or one issued before the transition → that document's own VAT governs.
    if (!credited?.issuedAt || credited.issuedAt < transition.confirmedAt) return { required: false, reason: "CREDIT_FOR_HISTORICAL_DOCUMENT" };
  }

  const zeroRateLineIndexes = doc.lines.filter((l) => new Prisma.Decimal(l.vatRatePercent).isZero()).map((l) => l.lineIndex).sort((a, z) => a - z);
  if (zeroRateLineIndexes.length === 0) return { required: false, reason: "NO_ZERO_RATE_LINE" };

  const fingerprint = vatReviewFingerprint(doc);
  const last = await tx.billingAuditEvent.findFirst({
    where: { businessId: doc.businessId, billingDocumentId: doc.id, eventType: DRAFT_VAT_REVIEW_EVENT },
    orderBy: { id: "desc" },
    select: { metadata: true },
  });
  const meta = (last?.metadata ?? null) as { fingerprint?: unknown; transitionId?: unknown } | null;
  const reviewed = !!meta && meta.fingerprint === fingerprint && meta.transitionId === transition.id;
  return {
    required: true, reviewed, fingerprint, transitionId: transition.id, transitionConfirmedAt: transition.confirmedAt.toISOString(),
    originCreatedAt: origin.toISOString(), zeroRateLineIndexes,
  };
}

/** The issuance / quote-finalization gate. Call it on the document as read inside the issuing transaction. */
export async function assertDraftVatReviewedTx(tx: Tx, doc: ReviewableDoc): Promise<void> {
  const s = await evaluateDraftVatReviewTx(tx, doc);
  if (s.required && !s.reviewed) throw new ConflictError(DRAFT_VAT_REVIEW_REQUIRED_CODE, DRAFT_VAT_REVIEW_MESSAGE);
}
