/**
 * WP3 report-data tests (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-report-data.test.ts
 *
 * Pure: derives 2.6 / 5.4 / summary data from a WP1 projection + WP2 build.
 * No DB, no PDF rendering here (that is the render smoke test).
 */
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import type {
  UniformDocumentInput,
  UniformExportAssemblerInput,
} from "@/lib/services/billing/uniform/uniform-export.types";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import {
  APPENDIX_1_DOCUMENT_TYPES,
  buildReport26Data,
  buildReport54Data,
  buildSummaryData,
} from "@/lib/services/billing/uniform/uniform-report-data";
import { formatMoneyDisplay, sumDecimal2 } from "@/lib/services/billing/uniform/uniform-decimal";
import { buildUniformReportDocDefinitions } from "@/lib/services/billing/uniform/uniform-report-render";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const PRIMARY = "123456789012345";
const GEN_AT = "2026-06-20T14:30:00.000Z";

function line() {
  return { lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" };
}
function pay() {
  return { lineIndex: 0, method: "BANK_TRANSFER", amount: "50.00", currency: "ILS", paymentDate: "2026-06-20T09:00:00.000Z", bankName: null, bankBranch: null, bankAccountNumber: null, checkNumber: null, checkDueDate: null, cardBrand: null, cardLast4: null, reference: null };
}
function doc(over: Partial<UniformDocumentInput>): UniformDocumentInput {
  return {
    id: 0, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 1, documentNumberFormatted: "00000001",
    issuedAt: "2026-06-15T10:00:00.000Z", lockedAt: "2026-06-15T10:00:00.000Z", currency: "ILS",
    subtotalAmount: "100.00", vatAmount: "17.00", totalAmount: "117.00",
    allocationNumber: null, allocationApprovedAt: null, isEmergencyAllocation: false, legalSnapshotHash: "h", referenceDocumentId: null,
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", taxIdType: "LTD_COMPANY", city: "תל אביב", phone: null, email: null },
    customerNameSnapshot: "לקוח", lines: [line()], payments: [], issuedSnapshot: null, ...over,
  };
}

const input: UniformExportAssemblerInput = {
  businessId: 3,
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z" },
  business: { businessId: 3, name: "Dubiz", billingLegalName: "דוביז", billingBusinessKind: "LTD_COMPANY", billingTaxId: "515000123", billingVatNumber: "515000123", billingAddress: "רחוב 1", billingPhone: null, billingEmail: null },
  documents: [
    doc({ id: 1, documentNumber: 1, totalAmount: "117.00" }), // TAX_INVOICE
    doc({ id: 4, documentNumber: 4, totalAmount: "100.00" }), // TAX_INVOICE
    doc({ id: 2, documentType: "RECEIPT", documentNumber: 2, totalAmount: "50.00", lines: [], payments: [pay()] }),
    doc({ id: 3, documentType: "TAX_INVOICE_RECEIPT", documentNumber: 3, totalAmount: "234.50", payments: [pay()] }),
  ],
};

const proj = assembleUniformExportProjection(input);
const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, { primaryId: PRIMARY, generatedAt: GEN_AT });

// ---- decimal helpers ----
ok("sumDecimal2", sumDecimal2(["117.00", "100.00", "50.00", "234.50"]) === "501.50");
ok("formatMoneyDisplay thousands", formatMoneyDisplay("1000000") === "1,000,000.00");
ok("formatMoneyDisplay 2dp", formatMoneyDisplay("217") === "217.00");

// ---- §2.6 ----
{
  const d = buildReport26Data(proj, built.meta);
  ok("2.6 lists all appendix-1 types", d.rows.length === APPENDIX_1_DOCUMENT_TYPES.length && d.rows.length === 27);
  const r305 = d.rows.find((r) => r.code === "305")!;
  const r400 = d.rows.find((r) => r.code === "400")!;
  const r320 = d.rows.find((r) => r.code === "320")!;
  const r100 = d.rows.find((r) => r.code === "100")!;
  ok("2.6 305 (TAX_INVOICE) count=2 sum=217.00", r305.count === 2 && r305.sumInclVat === "217.00", r305);
  ok("2.6 400 (RECEIPT) count=1 sum=50.00", r400.count === 1 && r400.sumInclVat === "50.00");
  ok("2.6 320 (TAX_INVOICE_RECEIPT) count=1 sum=234.50", r320.count === 1 && r320.sumInclVat === "234.50");
  ok("2.6 absent type (100) count=0 sum=0.00", r100.count === 0 && r100.sumInclVat === "0.00");
  ok("2.6 totalCount == C100 count", d.totalCount === built.meta.counts.C100 && d.totalCount === 4);
  ok("2.6 totalSum=501.50", d.totalSum === "501.50");
  ok("2.6 business + vat", d.businessName === "דוביז" && d.vatNumber === "515000123");
  ok("2.6 period display", d.periodStart === "01/06/2026" && d.periodEnd === "30/06/2026");
}

// ---- §5.4 ----
{
  const d = buildReport54Data(proj, built.meta, SIMULATOR_SOFTWARE_CONFIG);
  ok("5.4 vat + name", d.vatNumber === "515000123" && d.businessName === "דוביז");
  ok("5.4 const message", d.constMessage === "ביצוע ממשק פתוח הסתיים בהצלחה.");
  ok("5.4 dirPath == meta", d.dirPath === built.meta.dirPath);
  const codes = d.recordRows.map((r) => r.code);
  ok("5.4 record rows present only", JSON.stringify(codes) === JSON.stringify(["A100", "B110", "C100", "D110", "D120", "Z900"]), codes);
  const c100 = d.recordRows.find((r) => r.code === "C100")!;
  ok("5.4 C100 count matches meta", c100.count === built.meta.counts.C100);
  ok("5.4 A100/Z900 = 1", d.recordRows.find((r) => r.code === "A100")!.count === 1 && d.recordRows.find((r) => r.code === "Z900")!.count === 1);
  ok("5.4 software identity", d.softwareName === "DUBIZ" && d.softwareRegistrationNumber === "00000001");
  ok("5.4 generated date/time", d.generatedDate === "20/06/2026" && d.generatedTime === "14:30");
}

// ---- summary ----
{
  const d = buildSummaryData(proj, built.meta, SIMULATOR_SOFTWARE_CONFIG);
  ok("summary totalRecords == meta", d.totalRecords === built.meta.totalBkmvRecords);
  ok("summary record rows match", d.recordRows.map((r) => r.code).join(",") === "A100,B110,C100,D110,D120,Z900");
  ok("summary vendor identity", d.vendorName === "DUBIZ");
}

// ---- determinism (docDefinitions) ----
{
  const a = JSON.stringify(buildUniformReportDocDefinitions(proj, built, SIMULATOR_SOFTWARE_CONFIG));
  const b = JSON.stringify(buildUniformReportDocDefinitions(proj, built, SIMULATOR_SOFTWARE_CONFIG));
  ok("docDefinitions deterministic (same input → identical)", a === b);
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll WP3 report-data tests passed.");
