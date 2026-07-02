/**
 * WP3 render smoke test (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-report-render.test.ts
 *
 * Renders the 3 registration reports to PDF buffers via the canonical pdfmake
 * renderer + Hebrew font. Asserts valid, non-empty PDFs. (PDF bytes carry a
 * pdfkit creation timestamp → not byte-deterministic; determinism is asserted
 * on the docDefinition objects in the data test.)
 */
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import type { UniformExportAssemblerInput } from "@/lib/services/billing/uniform/uniform-export.types";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import { renderUniformReports } from "@/lib/services/billing/uniform/uniform-report-render";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const input: UniformExportAssemblerInput = {
  businessId: 3,
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" },
  business: { businessId: 3, name: "Dubiz", billingLegalName: "דוביז", billingBusinessKind: "LTD_COMPANY", billingTaxId: "515000123", billingVatNumber: "515000123", billingAddress: "רחוב 1", billingPhone: null, billingEmail: null },
  documents: [
    {
      id: 1, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 1, documentNumberFormatted: "00000001",
      issuedAt: "2026-06-15T10:00:00.000Z", lockedAt: "2026-06-15T10:00:00.000Z", currency: "ILS",
      subtotalAmount: "100.00", vatAmount: "17.00", totalAmount: "117.00",
      allocationNumber: null, allocationApprovedAt: null, isEmergencyAllocation: false, legalSnapshotHash: "h", referenceDocumentId: null,
      customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", taxIdType: "LTD_COMPANY", city: "תל אביב", phone: null, email: null },
      customerNameSnapshot: "לקוח",
      lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
      payments: [], issuedSnapshot: null,
    },
  ],
};

function isPdf(buf: Buffer): boolean {
  return buf.length > 500 && buf.subarray(0, 4).toString("latin1") === "%PDF";
}

async function run() {
  const proj = assembleUniformExportProjection(input);
  const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, {
    primaryId: "123456789012345",
    generatedAt: "2026-06-20T14:30:00.000Z",
  });

  const pdfs = await renderUniformReports(proj, built, SIMULATOR_SOFTWARE_CONFIG);
  ok("2.6 renders to valid non-empty PDF", isPdf(pdfs.report26Pdf));
  ok("5.4 renders to valid non-empty PDF", isPdf(pdfs.report54Pdf));
  ok("summary renders to valid non-empty PDF", isPdf(pdfs.summaryPdf));

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll WP3 render smoke tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
