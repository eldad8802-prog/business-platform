import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
} from "@prisma/client";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import { allocateQuoteDocumentNumberIfMissing } from "@/lib/services/billing/quote-document-number";
import { canEditDraft } from "@/lib/services/billing/domain/billing-status.machine";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";
import { billingTenantTx } from "./billing-tenant-tx";

export type ConvertQuoteToInvoiceInput = {
  businessId: number;
  actorUserId: number;
  quoteBillingDocumentId: number;
};

export async function convertQuoteToInvoice(
  input: ConvertQuoteToInvoiceInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new UnauthorizedError();
  }
  if (
    !input.actorUserId ||
    Number.isNaN(input.actorUserId) ||
    !Number.isInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    throw new UnauthorizedError();
  }
  if (
    !input.quoteBillingDocumentId ||
    !Number.isInteger(input.quoteBillingDocumentId) ||
    input.quoteBillingDocumentId <= 0
  ) {
    throw new ValidationError("quoteBillingDocumentId must be a positive integer");
  }

  const result = await billingTenantTx(input.businessId, async (tx) => {
    const quote = await tx.billingDocument.findFirst({
      where: {
        id: input.quoteBillingDocumentId,
        businessId: input.businessId,
        documentType: BillingDocumentType.QUOTE,
      },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    if (!quote) {
      throw new NotFoundError("Quote not found");
    }

    if (!canEditDraft(quote.status)) {
      throw new ForbiddenError("Quote cannot be converted in its current state");
    }

    if (quote.convertedToInvoiceId !== null) {
      throw new ForbiddenError("ההצעה כבר הומרה לחשבונית");
    }

    const customerNameSnapshot = (quote.customerNameSnapshot ?? "").trim();
    if (customerNameSnapshot.length === 0) {
      throw new ValidationError("יש למלא שם לקוח לפני המרה לחשבונית");
    }

    if (quote.lines.length === 0) {
      throw new ValidationError("יש להוסיף לפחות שורה אחת לפני המרה");
    }

    const issuerProfile = await tx.businessProfile.findUnique({
      where: { businessId: input.businessId },
      select: {
        billingLegalName: true,
        billingBusinessKind: true,
        billingTaxId: true,
        billingPhone: true,
        billingEmail: true,
        billingAddress: true,
      },
    });
    assertBillingIdentityReadyForTaxInvoice(issuerProfile);

    await allocateQuoteDocumentNumberIfMissing(tx, {
      businessId: input.businessId,
      billingDocumentId: quote.id,
    });

    const quoteFresh = await tx.billingDocument.findFirstOrThrow({
      where: { id: quote.id, businessId: input.businessId },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    const parsedLines = quoteFresh.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      vatRatePercent: line.vatRatePercent,
      lineIndex: line.lineIndex,
    }));

    const { lines: computedLines, totals } = recomputeAll(parsedLines);

    const invoice = await tx.billingDocument.create({
      data: {
        businessId: input.businessId,
        documentType: BillingDocumentType.TAX_INVOICE,
        status: BillingDocumentStatus.DRAFT,
        currency: quoteFresh.currency,
        customerId: quoteFresh.customerId,
        customerNameSnapshot: quoteFresh.customerNameSnapshot,
        subtotalAmount: totals.subtotalAmount,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        pdfRenderStatus: BillingPdfRenderStatus.PENDING,
        createdByUserId: input.actorUserId,
      },
    });

    await tx.billingDocumentLine.createMany({
      data: computedLines.map((line) => ({
        billingDocumentId: invoice.id,
        lineIndex: line.lineIndex,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        vatRatePercent: line.vatRatePercent,
        lineSubtotal: line.lineSubtotal,
        vatAmount: line.vatAmount,
        lineTotal: line.lineTotal,
      })),
    });

    const updateQuote = await updateBillingDocuments(tx, {
      where: {
        id: quoteFresh.id,
        businessId: input.businessId,
        convertedToInvoiceId: null,
        documentType: BillingDocumentType.QUOTE,
      },
      intent: "quote_mark_converted",
      data: {
        convertedToInvoiceId: invoice.id,
      },
    });

    if (updateQuote.count !== 1) {
      throw new ForbiddenError("Conversion failed — quote may have been converted already");
    }

    const createdInvoice = await tx.billingDocument.findFirstOrThrow({
      where: { id: invoice.id, businessId: input.businessId },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: createdInvoice.id,
      actorUserId: input.actorUserId,
      eventType: "BILLING_QUOTE_CONVERTED_TO_INVOICE",
      summary: "Quote converted to invoice",
      metadata: {
        quoteId: quoteFresh.id,
        invoiceId: createdInvoice.id,
        quoteDocumentNumber: quoteFresh.documentNumber,
        quoteDocumentNumberFormatted: quoteFresh.documentNumberFormatted,
        customerId: createdInvoice.customerId,
        subtotalAmount: totals.subtotalAmount.toString(),
        vatAmount: totals.vatAmount.toString(),
        totalAmount: totals.totalAmount.toString(),
        currency: createdInvoice.currency,
        actorUserId: input.actorUserId,
      },
    });

    return { invoice: createdInvoice, quoteId: quoteFresh.id };
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_QUOTE_CONVERTED_TO_INVOICE",
    entityType: "BILLING_DOCUMENT",
    entityId: result.invoice.id,
    payload: {
      invoiceId: result.invoice.id,
      quoteId: result.quoteId,
      actorUserId: input.actorUserId,
    },
  });

  return result.invoice;
}
