import { BillingDocumentType, Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";

const DOCUMENT_NUMBER_PAD = 6;

export function formatQuoteDocumentNumber(value: number): string {
  return String(value).padStart(DOCUMENT_NUMBER_PAD, "0");
}

/**
 * Allocates the next QUOTE sequence number for this business when missing.
 * Idempotent when documentNumber is already set.
 */
export async function allocateQuoteDocumentNumberIfMissing(
  tx: Prisma.TransactionClient,
  args: { businessId: number; billingDocumentId: number }
): Promise<{ documentNumber: number; documentNumberFormatted: string }> {
  const doc = await tx.billingDocument.findFirst({
    where: {
      id: args.billingDocumentId,
      businessId: args.businessId,
      documentType: BillingDocumentType.QUOTE,
    },
    select: {
      id: true,
      documentNumber: true,
      documentNumberFormatted: true,
    },
  });

  if (!doc) {
    throw new NotFoundError("Quote document not found");
  }

  if (
    doc.documentNumber != null &&
    typeof doc.documentNumberFormatted === "string" &&
    doc.documentNumberFormatted.length > 0
  ) {
    return {
      documentNumber: doc.documentNumber,
      documentNumberFormatted: doc.documentNumberFormatted,
    };
  }

  const sequence = await tx.billingDocumentNumberSequence.upsert({
    where: {
      businessId_documentType: {
        businessId: args.businessId,
        documentType: BillingDocumentType.QUOTE,
      },
    },
    create: {
      businessId: args.businessId,
      documentType: BillingDocumentType.QUOTE,
      nextNumber: 2,
    },
    update: {
      nextNumber: { increment: 1 },
    },
  });

  const documentNumber = sequence.nextNumber - 1;
  const documentNumberFormatted = formatQuoteDocumentNumber(documentNumber);

  await updateBillingDocuments(tx, {
    where: {
      id: args.billingDocumentId,
      businessId: args.businessId,
      documentType: BillingDocumentType.QUOTE,
      documentNumber: null,
    },
    intent: "quote_allocate_number",
    data: {
      documentNumber,
      documentNumberFormatted,
    },
  });

  return { documentNumber, documentNumberFormatted };
}
