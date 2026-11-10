/**
 * Right-to-left text in the supplier order PDF (lib/pdf/rtl-inline-text). Pure: no DB, no network.
 *
 * Found in the business 9 pilot (2026-11-10): the PDF header printed "zibuD" for "Dubiz". Cause, proven here on the
 * real renderers: pdfmake has no bidi; fontkit draws a word's glyphs reversed when its first letter is Hebrew, so the
 * header kept as one word printed its Latin part backwards, and multi-word Hebrew texts (product and supplier names)
 * were laid out word by word left to right — read in reversed word order.
 *
 * 1. rtlInlines itself (Hebrew, English, mixed, numbers, brackets, bidi controls, empty).
 * 2. What the SERVER renderer actually draws (the saved purchase-order sheet): every pdfkit text call is captured with
 *    its position and fontkit's glyph order, and the drawn line, left to right, must be the expected one — written
 *    out by hand below, not computed by the code under test.
 * 3. The BROWSER download (pdfmake's browser bundle, with its own pdfkit/fontkit) draws the very same text at the very
 *    same positions as the server, and its header reads "Dubiz" (it read "zibuD" before the fix).
 *
 * Run: npx tsx lib/pdf/rtl-inline-text.test.mts
 */
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { rtlInlines } from "@/lib/pdf/rtl-inline-text";
import { renderSupplierOrderPdf, supplierOrderHeaderTitle } from "@/lib/services/business-documents/po-sheet/po-sheet-pdf";
import {
  buildSupplierPurchaseOrderDocDefinition,
  SUPPLIER_ORDER_PDF_FONTS,
  type SupplierPurchaseDraftForDocument,
} from "@/lib/services/inventory/supplier-purchase-document.service";

const require = createRequire(import.meta.url);
const NBSP = " ";
const sp = (s: string) => s.replaceAll(NBSP, " ");

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("1. rtlInlines: direction runs in visual order (left to right)");
const runs = (v: string | null | undefined) => rtlInlines(v).map((i) => sp(i.text));
const UNIT: [string, string | null | undefined, string[]][] = [
  ["Hebrew only: one run, words kept together", "מוצר א", ["מוצר א"]],
  ["English only: unchanged, one run", "Coca Cola", ["Coca Cola"]],
  ["English locale header: unchanged", "Inventory · Dubiz", ["Inventory · Dubiz"]],
  ["Hebrew header with the Latin brand: brand on the left", "מלאי · Dubiz", ["Dubiz", "מלאי · "]],
  ["Hebrew then Latin", "שוקולד Milka", ["Milka", "שוקולד "]],
  ["Latin then Hebrew", "iPhone 15 כחול", [" כחול", "iPhone 15"]],
  ["number with a unit inside Hebrew", "קוקה קולה 1.5L", ["1.5L", "קוקה קולה "]],
  ["percent sign stays with its number", "חלב 3% 1 ליטר", [" ליטר", "3% 1", "חלב "]],
  ["Hebrew quotation mark inside a word", 'ספק גדול בע"מ', ['ספק גדול בע"מ']],
  ["brackets mirrored in right-to-left runs", "מוצר (Milka)", ["(", "Milka", "מוצר )"]],
  ["bidi control characters are dropped", "‫מלאי‏ · Dubiz‬", ["Dubiz", "מלאי · "]],
  ["digits only", "#41", ["#41"]],
  ["empty / null", null, [""]],
];
for (const [name, input, want] of UNIT) {
  const got = runs(input);
  ok(name, isDeepStrictEqual(got, want), `${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
ok("spaces become NBSP inside a run (pdfmake must not split it into words)", rtlInlines("מוצר א")[0].text === `מוצר${NBSP}א`);

// ---------------------------------------------------------------------------------------------------------------
type Frag = { x: number; y: number; drawn: string };
let frags: Frag[] = [];
const PDFDocument = require("pdfkit");
const originalText = PDFDocument.prototype.text;
PDFDocument.prototype.text = function (this: { _font: { font: { layout: (t: string, f?: unknown) => { glyphs: { codePoints: number[] }[] } } } }, text: unknown, x: unknown, y: unknown, options?: { features?: unknown }) {
  if (typeof text === "string" && typeof x === "number" && typeof y === "number") {
    const glyphs = this._font.font.layout(text, options?.features).glyphs;
    frags.push({ x, y, drawn: glyphs.map((g) => String.fromCodePoint(...(g.codePoints.length ? g.codePoints : [0x3f]))).join("") });
  }
  // eslint-disable-next-line prefer-rest-params
  return originalText.apply(this, arguments);
};

const draftWith = (rawName: string, supplierName = "ספק"): SupplierPurchaseDraftForDocument => ({
  id: 8, supplierName, externalOrderId: null, orderDate: "2026-11-02T22:30:00.000Z", lines: [{ rawName, quantity: 7, unitType: "UNIT" }],
});
const lineAt = (y: number, minX = -Infinity) => sp(frags.filter((f) => Math.round(f.y) === Math.round(y) && f.x > minX).sort((a, b) => a.x - b.x).map((f) => f.drawn).join(""));

console.log("2. the server renderer (saved purchase-order sheet) draws the expected glyphs, left to right");
// expected DRAWN order, left to right, written by hand: a Hebrew run is drawn last letter first
const HEADERS: [string, string][] = [
  [supplierOrderHeaderTitle("he"), "Dubiz · יאלמ"],
  [supplierOrderHeaderTitle("en"), "Inventory · Dubiz"],
];
for (const [title, want] of HEADERS) {
  frags = [];
  await renderSupplierOrderPdf(draftWith("מוצר א"), { headerTitle: title, displayDate: "3.11.2026" });
  const got = lineAt(Math.min(...frags.map((f) => f.y)));
  ok(`header ${JSON.stringify(title)} drawn as ${JSON.stringify(want)}`, got === want, `drawn ${JSON.stringify(got)}`);
}
const CELLS: [string, string][] = [
  ["מוצר א", "א רצומ"],
  ["חלב טרי", "ירט בלח"],
  ["שוקולד Milka", "Milka דלוקוש"],
  ["Coca Cola", "Coca Cola"],
  ["קוקה קולה 1.5L", "1.5L הלוק הקוק"],
  ["iPhone 15 כחול", "לוחכ iPhone 15"],
  ["מוצר (Milka)", "(Milka) רצומ"],
  ['ספק גדול בע"מ', 'מ"עב לודג קפס'],
];
for (const [name, want] of CELLS) {
  frags = [];
  await renderSupplierOrderPdf(draftWith(name), { headerTitle: supplierOrderHeaderTitle("he"), displayDate: "3.11.2026" });
  const qty = frags.find((f) => f.drawn === "7");
  const got = qty ? lineAt(qty.y, qty.x + 1) : "(quantity cell not found)";
  ok(`product ${JSON.stringify(name)} drawn as ${JSON.stringify(want)}`, got === want, `drawn ${JSON.stringify(got)}`);
}
{
  frags = [];
  await renderSupplierOrderPdf(draftWith("מוצר א", "Tnuva תנובה"), { headerTitle: supplierOrderHeaderTitle("he"), displayDate: "3.11.2026" });
  const lines = [...new Set(frags.map((f) => Math.round(f.y)))].map((y) => lineAt(y));
  ok('supplier "Tnuva תנובה" drawn as "הבונת Tnuva" (Latin on the right, read first)', lines.some((l) => l.startsWith("הבונת Tnuva")), JSON.stringify(lines.find((l) => l.includes("Tnuva"))));
}

console.log("3. the browser download draws the same text at the same positions as the server");
type Item = { s: string; x: number; y: number };
async function pdfItems(buf: Uint8Array): Promise<Item[]> {
  const pdf = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const tc = await (await pdf.getPage(1)).getTextContent();
  return (tc.items as { str?: string; transform: number[] }[]).filter((i) => i.str).map((i) => ({ s: i.str as string, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) }));
}
const pdfMake = require("pdfmake/build/pdfmake.js");
const FONT = "NotoSansHebrew-Regular.ttf";
const vfs = { [FONT]: (hebrewFontVfs as Record<string, string>)[FONT] };
pdfMake.vfs = vfs;
pdfMake.fonts = SUPPLIER_ORDER_PDF_FONTS; // as downloadSupplierPurchaseOrderPdf sets it
pdfMake.addVirtualFileSystem?.(vfs);
for (const locale of ["he", "en"] as const) {
  const title = supplierOrderHeaderTitle(locale);
  const draft: SupplierPurchaseDraftForDocument = { ...draftWith("שוקולד Milka", "Tnuva תנובה"), externalOrderId: "P-8",
    lines: CELLS.map(([rawName], i) => ({ rawName, quantity: i + 1, unitType: "UNIT" })) };
  const context = { headerTitle: title, displayDate: "3.11.2026" };
  const server = await pdfItems(await renderSupplierOrderPdf(draft, context));
  const browser = await pdfItems(await pdfMake.createPdf(buildSupplierPurchaseOrderDocDefinition(draft, context), undefined, SUPPLIER_ORDER_PDF_FONTS, vfs).getBuffer());
  ok(`${locale}: browser page = server page (text and positions)`, server.length > 10 && isDeepStrictEqual(browser, server), `${browser.length} vs ${server.length} items`);
  // a Hebrew reader reads the header line's pieces from the right (pdfjs gives each piece in its own reading order)
  const header = sp(browser.filter((i) => i.y === browser[0]?.y).sort((a, b) => b.x - a.x).map((i) => i.s).join(""));
  ok(`${locale}: the browser header reads ${JSON.stringify(title)}`, header === title, JSON.stringify(header));
}

PDFDocument.prototype.text = originalText;
console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
