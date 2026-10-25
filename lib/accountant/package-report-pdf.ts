/**
 * The PDF report of a sealed accountant package (R1) — a printable rendering of the package's OWN
 * workbook, never a second computation.
 *
 * Every value in the PDF is read from the cells of `דוח_<YYYY-MM>.xlsx` inside the sealed ZIP and shown as
 * Excel shows it ("#,##0.00" → 1,234.50; "dd/mm/yyyy" → the cell's date). Nothing is summed, rounded
 * differently, converted or re-read from the ledgers: the "סיכום" sheet's totals are the package's totals.
 * The "what is included / open / warnings" text is the package's own `סיכום.txt`.
 *
 * Hebrew follows the billing PDF text policy (lib/services/billing/pdf/billing-pdf-text-policy.ts): text
 * is escaped and isolated, never reversed; numbers and dates are LTR-isolated. Chromium renders it with
 * the embedded Noto Sans Hebrew font.
 */
import ExcelJS from "exceljs";

import { escapeHtmlForPdf, renderDynamicPdfText } from "@/lib/services/billing/pdf/billing-pdf-text-policy";

/** Bumped whenever the PDF layout changes, so a cached PDF of an older layout is never served. */
export const PACKAGE_PDF_TEMPLATE = "r1";

/** The workbook sheets the report shows, in order, with their printed titles. */
export const PDF_SHEETS: readonly { sheet: string; title: string }[] = [
  { sheet: "סיכום", title: "סיכום" },
  { sheet: "דוח", title: "מסמכים סרוקים שאושרו" },
  { sheet: "מסמכים שהופקו", title: "מסמכים שהופקו בדוביז" },
  { sheet: "ממתינים", title: "מסמכים שעדיין ממתינים לבדיקה (ברשימה בלבד)" },
];

export type ReportCell = { text: string; kind: "text" | "number" | "date" | "empty" };
export type ReportTable = { title: string; headers: string[]; rows: ReportCell[][] };
export type PackageReportModel = { tables: ReportTable[]; summaryLines: string[] };

const NUMBER_2DP = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A cell as Excel displays it. A date cell is shown by its UTC calendar day — exceljs maps the stored
 * serial to that instant, which is exactly the day Excel prints. A "#,##0.00" number keeps its value and
 * gets two decimals with thousands separators; any other number is printed as stored.
 */
export function cellDisplay(cell: ExcelJS.Cell): ReportCell {
  return displayValue(cell.value, cell.numFmt);
}

function displayValue(v: ExcelJS.CellValue, numFmt: string | undefined): ReportCell {
  if (v === null || v === undefined || v === "") return { text: "", kind: "empty" };
  if (v instanceof Date) {
    return { text: `${pad2(v.getUTCDate())}/${pad2(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`, kind: "date" };
  }
  if (typeof v === "number") {
    return { text: numFmt === "#,##0.00" ? NUMBER_2DP.format(v) : String(v), kind: "number" };
  }
  if (typeof v === "object" && "richText" in v) {
    return { text: (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join(""), kind: "text" };
  }
  // A formula cell prints its STORED result (the package's value), formatted like any other cell — the
  // formula is never evaluated here.
  if (typeof v === "object" && "formula" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    if (r === undefined || r === null || (typeof r === "object" && "error" in r)) return { text: "", kind: "empty" };
    return displayValue(r as ExcelJS.CellValue, numFmt);
  }
  return { text: String(v), kind: "text" };
}

/** Reads the package workbook (and its summary text) into the model the PDF prints. */
export async function buildPackageReportModel(xlsx: Buffer, summaryText: string): Promise<PackageReportModel> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const tables: ReportTable[] = [];
  for (const { sheet, title } of PDF_SHEETS) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) continue;
    const width = ws.getRow(1).cellCount;
    const headers = Array.from({ length: width }, (_, i) => cellDisplay(ws.getRow(1).getCell(i + 1)).text);
    const rows: ReportCell[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells = Array.from({ length: width }, (_, i) => cellDisplay(row.getCell(i + 1)));
      if (cells.every((c) => c.kind === "empty")) continue;
      rows.push(cells);
    }
    tables.push({ title, headers, rows });
  }
  const summaryLines = summaryText.replace(/\r\n/g, "\n").split("\n");
  return { tables, summaryLines };
}

export type PackageReportMeta = {
  periodKey: string;
  version: number;
  sha256: string;
};

function cellHtml(c: ReportCell): string {
  if (c.kind === "empty") return "";
  if (c.kind === "number" || c.kind === "date") return renderDynamicPdfText(c.text, "numeric");
  return renderDynamicPdfText(c.text, "mixed");
}

/** The report as a self-contained HTML document (A4, RTL, embedded Hebrew font). Pure. */
export function renderPackageReportHtml(model: PackageReportModel, meta: PackageReportMeta, fontDataUri: string): string {
  const summary = model.summaryLines
    .map((line) => (line.trim() === "" ? `<div class="gap"></div>` : `<div class="sline">${renderDynamicPdfText(line, "mixed")}</div>`))
    .join("");
  const tables = model.tables
    .map((t) => {
      const head = t.headers.map((h) => `<th>${renderDynamicPdfText(h, "label")}</th>`).join("");
      const body =
        t.rows.length === 0
          ? `<tr><td class="none" colspan="${Math.max(t.headers.length, 1)}">${renderDynamicPdfText("אין", "label")}</td></tr>`
          : t.rows.map((r) => `<tr>${r.map((c) => `<td class="${c.kind}">${cellHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<section class="sheet"><h2>${renderDynamicPdfText(t.title, "label")}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
    })
    .join("");
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtmlForPdf(`דוח חודשי ${meta.periodKey}`)}</title>
<style>
@font-face { font-family: "NotoSansHebrew"; src: url("${fontDataUri}") format("truetype"); }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; font-family: "NotoSansHebrew", sans-serif; color: #111827; font-size: 10.5px; }
body { padding: 28px 30px 0; direction: rtl; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 13px; margin: 18px 0 6px; }
.meta { color: #4b5563; font-size: 10px; margin-bottom: 10px; }
.summary { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
.sline { line-height: 1.55; }
.gap { height: 6px; }
table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #e5e7eb; padding: 4px 5px; text-align: right; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
td.number, td.date { white-space: nowrap; }
td.none { color: #6b7280; text-align: center; }
.sheet { page-break-before: auto; }
.pdf-dyn { display: block; }
.pdf-bidi-plain { unicode-bidi: plaintext; display: inline; }
.pdf-bidi-plain--label { font-weight: 600; }
.pdf-dyn--ltr, .pdf-dyn--en { unicode-bidi: isolate; direction: ltr; display: inline-block; }
.foot { color: #6b7280; font-size: 9px; margin-top: 14px; }
</style></head><body>
<h1>${renderDynamicPdfText(`דוח חודשי לרואה החשבון — ${meta.periodKey}`, "label")}</h1>
<div class="meta">${renderDynamicPdfText(`גרסת חבילה ${meta.version} · נחתמה (sha256): `, "mixed")}${renderDynamicPdfText(meta.sha256.slice(0, 16), "english")}</div>
<section class="summary">${summary}</section>
${tables}
<div class="foot">${renderDynamicPdfText("הדוח מוצג מתוך החבילה החתומה עצמה, ללא חישוב מחדש. הוא אינו מאשר שהנהלת החשבונות שלמה.", "mixed")}</div>
</body></html>`;
}

/** Chromium (playwright) HTML → PDF, A4, page numbers in the footer. Same engine as the billing PDFs. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#6b7280;text-align:center;font-family:sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "14px", right: "0px", bottom: "36px", left: "0px" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
