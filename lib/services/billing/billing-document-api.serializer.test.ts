/**
 * H2b billing document API serializer (run manually):
 *   npx tsx lib/services/billing/billing-document-api.serializer.test.ts
 */
import { BillingPdfRenderStatus } from "@prisma/client";
import {
  serializeBillingDocumentForApi,
  serializeBillingDocumentsForApi,
} from "@/lib/services/billing/billing-document-api.serializer";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const baseDoc = {
  id: 1,
  businessId: 10,
  documentType: "TAX_INVOICE" as const,
  status: "ISSUED" as const,
  documentNumber: 42,
  documentNumberFormatted: "INV-42",
  customerId: 5,
  customerNameSnapshot: "Acme",
  validUntil: null,
  convertedToInvoiceId: null,
  subtotalAmount: "100.00" as never,
  vatAmount: "17.00" as never,
  totalAmount: "117.00" as never,
  currency: "ILS",
  issuedAt: new Date("2026-06-01T12:00:00.000Z"),
  issuedByUserId: 2,
  createdByUserId: 2,
  issuedSnapshot: { schemaVersion: 1 },
  lockedAt: new Date("2026-06-01T12:00:00.000Z"),
  legalSnapshotHash: "abc123",
  referenceDocumentId: null,
  pdfRenderStatus: BillingPdfRenderStatus.RENDERED,
  pdfTemplateVersion: "v1-html",
  pdfStorageKey: "biz/10/billing/1/deadbeef.pdf",
  pdfHash: "a".repeat(64),
  pdfRenderedAt: new Date("2026-06-01T12:01:00.000Z"),
  pdfRenderError: null,
  createdAt: new Date("2026-06-01T11:00:00.000Z"),
  updatedAt: new Date("2026-06-01T12:01:00.000Z"),
};

const serialized = serializeBillingDocumentForApi(baseDoc);

ok("keeps pdfRenderStatus", serialized.pdfRenderStatus === BillingPdfRenderStatus.RENDERED);
ok("removes pdfStorageKey", !("pdfStorageKey" in serialized));
ok("removes pdfHash", !("pdfHash" in serialized));
ok("removes pdfTemplateVersion", !("pdfTemplateVersion" in serialized));
ok("removes pdfRenderedAt", !("pdfRenderedAt" in serialized));
ok("removes pdfRenderError", !("pdfRenderError" in serialized));
ok("keeps document id", serialized.id === 1);

const withLines = serializeBillingDocumentForApi({
  ...baseDoc,
  lines: [
    {
      id: 99,
      billingDocumentId: 1,
      lineIndex: 0,
      description: "Widget",
      quantity: "1.0000" as unknown as import("@prisma/client").Prisma.Decimal,
      unitPrice: "100.0000" as unknown as import("@prisma/client").Prisma.Decimal,
      vatRatePercent: "17.00" as unknown as import("@prisma/client").Prisma.Decimal,
      lineSubtotal: "100.00" as unknown as import("@prisma/client").Prisma.Decimal,
      vatAmount: "17.00" as unknown as import("@prisma/client").Prisma.Decimal,
      lineTotal: "117.00" as unknown as import("@prisma/client").Prisma.Decimal,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
});

ok("detail includes lines", Array.isArray(withLines.lines) && withLines.lines.length === 1);

const list = serializeBillingDocumentsForApi([baseDoc]);
ok("list serializer returns array", list.length === 1);
ok("list item strips pdfHash", !("pdfHash" in list[0]));

if (failed > 0) {
  console.error(`billing-document-api.serializer.test: ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("billing-document-api.serializer.test: all assertions passed");
}
