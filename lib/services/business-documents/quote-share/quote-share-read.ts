/**
 * ר1 — the reads of a quote that the share copy, the events and the reminders need. SERVER-ONLY, read only.
 * Deliberately free of the PDF renderer: every route and the Daily Tasks sources import this module, and only the
 * copy route may carry the serverless browser (scripts/ci/pdf-route-tracing-guard.mjs).
 */
import type { BillingDocument, BillingDocumentLine } from "@prisma/client";

import type { BdTx } from "../bd-tx";
import { quoteContentHash } from "./quote-share-content";

export type QuoteCopyRefusal = "NOT_FOUND" | "SERVICE_DESK_QUOTE" | "NO_QUOTE_NUMBER" | "INCOMPLETE_QUOTE" | "CHANGED_DURING_RENDER";

export class QuoteCopyRefusedError extends Error {
  constructor(readonly code: QuoteCopyRefusal) {
    super(code);
    this.name = "QuoteCopyRefusedError";
  }
  get status(): number {
    return this.code === "NOT_FOUND" ? 404 : 409;
  }
}

export type RenderRows = {
  doc: BillingDocument & { lines: BillingDocumentLine[] };
  customer: { id: number; name: string; phone: string | null; email: string | null; city: string | null } | null;
  business: { id: number; name: string; profile: Record<string, unknown> | null };
  serviceDesk: boolean;
};

/** Every read the copy needs, inside the caller's transaction. Nothing is written. */
export async function loadQuoteRenderRows(tx: BdTx, businessId: number, quoteId: number): Promise<RenderRows | null> {
  const doc = await tx.billingDocument.findFirst({
    where: { id: quoteId, businessId, documentType: "QUOTE" },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });
  if (!doc) return null;
  const customer = doc.customerId === null ? null : await tx.customer.findFirst({
    where: { id: doc.customerId, businessId },
    select: { id: true, name: true, phone: true, email: true, city: true },
  });
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      profile: {
        select: {
          billingLegalName: true, billingTaxId: true, billingVatNumber: true, billingPhone: true, billingEmail: true,
          billingAddress: true, billingPaymentNote: true, billingFooterNote: true, billingLogoDataUrl: true,
          billingSignatureDataUrl: true, billingPdfTemplateStyle: true,
        },
      },
    },
  });
  const serviceDesk = (await tx.serviceQuote.count({ where: { businessId, billingDocumentId: quoteId } })) > 0;
  return { doc, customer, business: business as RenderRows["business"], serviceDesk };
}

/** The quote-content view of the render rows (the lines live inside the document row). */
export function contentRowsOf(rows: RenderRows) {
  return { doc: rows.doc, lines: rows.doc.lines, customer: rows.customer };
}

/** A fresh content fingerprint of the quote as it is now (for events and for "changed since this copy"). */
export async function currentQuoteContent(tx: BdTx, businessId: number, quoteId: number): Promise<{ hash: string; rows: RenderRows } | null> {
  const rows = await loadQuoteRenderRows(tx, businessId, quoteId);
  if (!rows) return null;
  return { hash: quoteContentHash(contentRowsOf(rows)), rows };
}

