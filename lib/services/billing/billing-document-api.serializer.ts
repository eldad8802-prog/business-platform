import type { BillingDocument, BillingDocumentLine } from "@prisma/client";

/** Internal PDF pipeline fields — never expose on tenant Billing document APIs. */
const INTERNAL_PDF_FIELDS = [
  "pdfStorageKey",
  "pdfHash",
  "pdfTemplateVersion",
  "pdfRenderedAt",
  "pdfRenderError",
] as const;

type InternalPdfField = (typeof INTERNAL_PDF_FIELDS)[number];

export type BillingDocumentWithLines = {
  lines?: BillingDocumentLine[];
} & Record<string, unknown>;

export type BillingDocumentApi = Omit<BillingDocument, InternalPdfField>;

export type BillingDocumentDetailApi = BillingDocumentApi & {
  lines: BillingDocumentLine[];
};

function stripInternalPdfFields<T extends BillingDocumentWithLines>(
  doc: T
): Omit<T, InternalPdfField> {
  const publicDocument = { ...doc };
  for (const field of INTERNAL_PDF_FIELDS) {
    delete publicDocument[field];
  }
  return publicDocument;
}

export function serializeBillingDocumentForApi<T extends BillingDocumentWithLines>(
  doc: T
): Omit<T, InternalPdfField> {
  return stripInternalPdfFields(doc);
}

export function serializeBillingDocumentsForApi<T extends BillingDocumentWithLines>(
  documents: T[]
): Array<Omit<T, InternalPdfField>> {
  return documents.map((doc) => serializeBillingDocumentForApi(doc));
}
