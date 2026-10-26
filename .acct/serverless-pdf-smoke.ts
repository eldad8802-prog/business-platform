/**
 * The accountant PDF report rendered the way Vercel renders it: @sparticuz/chromium (serverless build)
 * launched through playwright-core, inside an Amazon Linux 2023 container (the OS Vercel functions run on),
 * with no Playwright browser download present. No database, no network.
 *
 * Builds a real package ZIP with the package builder (synthetic facts, Hebrew and Latin text, two
 * currencies), reads its workbook into the report model, renders the HTML in SERVERLESS mode and checks
 * the result is a real A4 PDF with the Hebrew font embedded.
 */
import { createHash } from "node:crypto";

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { buildPackageReportModel, chromiumMode, renderHtmlToPdf, renderPackageReportHtml } from "@/lib/accountant/package-report-pdf";
import { buildAccountantPackage } from "@/lib/reports/accountant-export-zip";
import { getNotoSansHebrewFontDataUri } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  ok("the job runs as a serverless function would (mode detection)", chromiumMode() === "serverless", chromiumMode());
  const issuedPdf = Buffer.from("%PDF-issued-lab");
  const pdfSha = createHash("sha256").update(issuedPdf).digest("hex");
  const s = (id: number, amount: number, vendorName: string, direction = "expense") => ({
    id, documentId: id + 1000, amount, date: new Date("2026-09-10T00:00:00Z"), direction, category: "fuel", vendorName,
    documentCreatedAt: new Date("2026-09-10T08:00:00Z"), documentStatus: "approved", fileUrl: `doc-${id}.pdf`,
  });
  const built = await buildAccountantPackage({
    businessId: 1,
    periodLabel: "2026-09",
    generatedAt: new Date("2026-10-01T06:00:00Z"),
    facts: {
      scanned: [s(1, 1234.5, "חברת החשמל לישראל בע\"מ"), s(2, 410, "Office Depot ישראל"), s(3, 2500, "לקוח פרטי", "income")],
      issued: [
        { id: 10, documentType: "TAX_INVOICE", documentNumberFormatted: "INV-0042", issuedAt: new Date("2026-09-12T09:00:00Z"), subtotalAmount: "1000.00", vatAmount: "180.00", totalAmount: "1180.00", currency: "ILS", customerName: "מאפיית הלב", referenceDocumentId: null, pdf: { available: true, storageKey: `biz/1/billing/10/${pdfSha}.pdf`, sha256: pdfSha } },
        { id: 11, documentType: "TAX_INVOICE", documentNumberFormatted: "INV-0043", issuedAt: new Date("2026-09-18T09:00:00Z"), subtotalAmount: "300.00", vatAmount: "0.00", totalAmount: "300.00", currency: "USD", customerName: "Acme Ltd", referenceDocumentId: null, pdf: { available: true, storageKey: `biz/1/billing/11/${pdfSha}.pdf`, sha256: pdfSha } },
      ],
      pending: [],
      identity: { legalName: "העסק שלי בע\"מ", taxId: "515151515" },
    },
    readers: { readOriginal: async () => Buffer.from("%PDF-original"), readIssuedPdf: async () => issuedPdf },
  });
  const zip = await JSZip.loadAsync(built.buffer);
  const model = await buildPackageReportModel(await zip.file("דוח_2026-09.xlsx")!.async("nodebuffer"), await zip.file("סיכום.txt")!.async("string"));
  const html = renderPackageReportHtml(model, { periodKey: "2026-09", version: 1, sha256: built.sha256 }, getNotoSansHebrewFontDataUri());

  const t0 = Date.now();
  const pdf = await renderHtmlToPdf(html, "serverless");
  const ms = Date.now() - t0;
  console.log(`  [INFO] serverless render took ${ms} ms, ${pdf.length} bytes`);
  ok("a real PDF is produced in serverless mode", pdf.subarray(0, 5).toString("latin1") === "%PDF-");
  const doc = await PDFDocument.load(pdf);
  const size = doc.getPage(0).getSize();
  ok("A4 pages", doc.getPageCount() >= 1 && Math.abs(size.width - 595.28) <= 2 && Math.abs(size.height - 841.89) <= 2, JSON.stringify(size));
  ok("the Hebrew font is embedded", /NotoSansHebrew/.test(pdf.toString("latin1")));
  ok("rendered well inside the 60 s function limit (cold start included)", ms < 45_000, `${ms} ms`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
