/**
 * The PDF report model and HTML (lib/accountant/package-report-pdf.ts), proven on a REAL package ZIP built
 * by the package builder (no database, no Chromium):
 *   - the model is read from the package's own workbook: every printed value is the cell as Excel shows it;
 *   - nothing is recomputed: each sheet's rows and numbers round-trip to the workbook's cells;
 *   - issued totals stay per currency (a USD total is never folded into ILS);
 *   - Hebrew text is escaped and isolated, never reversed; markup in a vendor name is inert.
 * Chromium rendering, caching and the route are proven on PG17 by .acct/pdf-download-battery.ts.
 */
import { createHash } from "node:crypto";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import type { IssuedDocumentFact, PeriodFacts, ScannedRecordFact } from "./package-scope";
import { buildPackageReportModel, cellDisplay, renderPackageReportHtml } from "./package-report-pdf";
import { buildAccountantPackage } from "@/lib/reports/accountant-export-zip";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`OK: ${name}`);
  else { failed++; console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const pdfBytes = Buffer.from("%PDF-issued-lab");
const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");

function scanned(over: Partial<ScannedRecordFact> & { id: number }): ScannedRecordFact {
  return {
    documentId: over.id + 1000,
    amount: 100,
    date: new Date("2026-09-10T00:00:00Z"),
    direction: "expense",
    category: "general",
    vendorName: "ספק",
    documentCreatedAt: new Date("2026-09-11T08:00:00Z"),
    documentStatus: "approved",
    fileUrl: `doc-${over.id}.pdf`,
    ...over,
  };
}
function issued(over: Partial<IssuedDocumentFact> & { id: number }): IssuedDocumentFact {
  return {
    documentType: "TAX_INVOICE",
    documentNumberFormatted: `INV-${over.id}`,
    issuedAt: new Date("2026-09-10T09:00:00Z"),
    subtotalAmount: "100.00",
    vatAmount: "18.00",
    totalAmount: "118.00",
    currency: "ILS",
    customerName: "לקוח",
    referenceDocumentId: null,
    pdf: { available: true, storageKey: `biz/1/billing/${over.id}/${pdfSha}.pdf`, sha256: pdfSha },
    ...over,
  };
}

async function main() {
  const facts: PeriodFacts = {
    scanned: [
      scanned({ id: 1, amount: 1234.5, vendorName: "חברת החשמל לישראל בע\"מ" }),
      scanned({ id: 2, amount: -50, vendorName: "<b>ספק</b> & שות'", direction: "income" }),
      scanned({ id: 3, amount: 0.1, vendorName: "Office Depot 2000" }),
    ],
    issued: [
      issued({ id: 10 }),
      issued({ id: 11, currency: "USD", subtotalAmount: "200.00", vatAmount: "0.00", totalAmount: "200.00" }),
    ],
    pending: [{ id: 77, status: "needs_review", createdAt: new Date("2026-09-20T08:00:00Z"), extractedDate: null }],
    identity: { legalName: "העסק שלי בע\"מ", taxId: "515151515" },
  };
  const built = await buildAccountantPackage({
    businessId: 1,
    periodLabel: "2026-09",
    facts,
    generatedAt: new Date("2026-10-01T06:00:00Z"),
    readers: { readOriginal: async () => Buffer.from("%PDF-original"), readIssuedPdf: async () => pdfBytes },
  });
  const zip = await JSZip.loadAsync(built.buffer);
  const xlsx = await zip.file("דוח_2026-09.xlsx")!.async("nodebuffer");
  const summary = await zip.file("סיכום.txt")!.async("string");
  ok("the package ZIP carries the workbook and the summary", xlsx.length > 0 && summary.includes("תקופה: 2026-09"));

  const model = await buildPackageReportModel(xlsx, summary);
  const titles = model.tables.map((t) => t.title);
  ok("four sections, summary first", titles.length === 4 && titles[0] === "סיכום" && titles[1] === "מסמכים סרוקים שאושרו", JSON.stringify(titles));

  // Round trip: every printed cell is the workbook cell as Excel shows it.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const sheetOf: Record<string, string> = { "סיכום": "סיכום", "מסמכים סרוקים שאושרו": "דוח", "מסמכים שהופקו בדוביז": "מסמכים שהופקו", "מסמכים שעדיין ממתינים לבדיקה (ברשימה בלבד)": "ממתינים" };
  let mismatches = 0;
  let numbers = 0;
  for (const t of model.tables) {
    const ws = wb.getWorksheet(sheetOf[t.title])!;
    t.rows.forEach((row, ri) => row.forEach((c, ci) => {
      const expect = cellDisplay(ws.getRow(ri + 2).getCell(ci + 1));
      if (expect.text !== c.text) mismatches++;
      if (c.kind === "number") numbers++;
    }));
  }
  ok("every printed value equals its workbook cell (no recomputation)", mismatches === 0 && numbers > 0, `${mismatches} mismatches, ${numbers} numbers`);

  const report = model.tables[1];
  const recordRows = report.rows.filter((r) => r[0].kind === "date");
  const totalRows = report.rows.filter((r) => r.some((c) => c.text.startsWith("סה״כ")));
  ok("the scanned report has one row per approved record, plus the workbook's own two total rows", recordRows.length === 3 && totalRows.length === 2 && report.rows.length === 5,
    JSON.stringify(report.rows.map((r) => r.map((c) => c.text).join(" | "))));
  const texts = report.rows.flat().map((c) => c.text);
  ok("the workbook total rows print their stored results in the same format", totalRows.every((r) => /^-?[0-9,]+.[0-9]{2}$/.test(r.find((c) => c.kind === "number")?.text ?? "")),
    JSON.stringify(totalRows.map((r) => r.map((c) => c.text))));
  ok("amounts print as Excel shows them: 1,234.50, -50.00, 0.10", texts.includes("1,234.50") && texts.includes("-50.00") && texts.includes("0.10"), JSON.stringify(texts));
  ok("Hebrew vendor names print unchanged", texts.includes("חברת החשמל לישראל בע\"מ"));
  const sumRows = model.tables[0].rows.map((r) => r[0].text);
  ok("issued totals stay per currency: an ILS row and a separate USD row", sumRows.some((s) => s.includes("הופקו בדוביז") && !s.includes("USD")) && sumRows.some((s) => s.includes("— USD")), JSON.stringify(sumRows));
  ok("the pending list carries the waiting document", model.tables[3].rows.length === 1 && model.tables[3].rows[0][0].text === "77");
  ok("the summary text is the package's own", model.summaryLines[0] === "חבילת רואה חשבון" && model.summaryLines.some((l) => l.startsWith("תקופה: 2026-09")));

  const html = renderPackageReportHtml(model, { periodKey: "2026-09", version: 1, sha256: built.sha256 }, "data:font/ttf;base64,AAAA");
  ok("RTL Hebrew document with the embedded font", html.includes('dir="rtl"') && html.includes('lang="he"') && html.includes("@font-face") && html.includes("NotoSansHebrew"));
  ok("markup in a vendor name is escaped, never rendered", html.includes("&lt;b&gt;ספק&lt;/b&gt; &amp; שות'") && !html.includes("<b>ספק</b>"));
  ok("no BiDi control characters are injected", !/[‪-‮⁦-⁩]/.test(html));
  ok("numbers are LTR-isolated", html.includes('<span class="pdf-dyn pdf-dyn--ltr" dir="ltr">1,234.50</span>'));
  ok("the sealed sha256 prefix is printed", html.includes(built.sha256.slice(0, 16)));

  if (failed) {
    console.log(`package-report-pdf: ${failed} failed`);
    process.exit(1);
  }
  console.log("package-report-pdf: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
