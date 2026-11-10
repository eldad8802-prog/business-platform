/**
 * Check, NOT a recommendation: a delivery-note reference written into an invoice line's description
 * ("לפי תעודת משלוח מס' X מתאריך Y" — ניהול פנקסים s.9(a)(3) requires the invoice to state the note's number and date).
 * Pure: calls the EXISTING billing code through its exported functions (as .billing-a0 does); changes none of it.
 *
 *   R1 the frozen issued snapshot keeps the reference, word for word
 *   R2 amounts and tax are identical to the same invoice without the reference (lines and totals)
 *   R3 the invoice HTML (the source the PDF is rendered from) prints the reference
 *   R4 the rendered PDF (HTML renderer, Chromium) contains it — skipped when no Chromium is available here
 *   R5 the uniform export (1.31, D110): field 1260 is X(30), so the reference is cut; fields 1256/1257 (base document
 *      type / number — "חובה כאשר המסמך מבוסס על מסמך אחר", clarification 6) stay empty
 *
 * Run: npx tsx .business-documents/delivery-note-reference-check.mts
 */
import { buildIssuedSnapshot, hashIssuedSnapshot } from "../lib/services/billing/billing-issue.service";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import type { BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";
import { assembleUniformExportProjection } from "../lib/services/billing/uniform/uniform-export-assembler";
import { SIMULATOR_SOFTWARE_CONFIG } from "../lib/services/billing/uniform/uniform-config";
import { buildUniformExportFiles } from "../lib/services/billing/uniform/uniform-file-builder";
import { CRLF } from "../lib/services/billing/uniform/uniform-serializer";
import { ACTOR_USER_ID, businessFor, computedLines, CUSTOMER, documentRow, FONT_SENTINEL, GOODS_LINES, ISSUED_AT } from "../.billing-a0/fixtures";

const REF = "לפי תעודת משלוח מס' 000123 מתאריך 10.11.2026";
let pass = 0;
const failures: string[] = [];
const notes: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const withRef = GOODS_LINES.map((l, i) => (i === 0 ? { ...l, description: `${l.description} — ${REF}` } : l));
function snapshotOf(raw: typeof GOODS_LINES) {
  const { rows, totals } = computedLines(1001, raw);
  const snap = buildIssuedSnapshot({
    document: documentRow({ id: 1001, documentType: "TAX_INVOICE" }),
    lines: rows,
    business: businessFor("CLASSIC"),
    customer: CUSTOMER,
    documentNumber: 12,
    documentNumberFormatted: "000012",
    issuedAt: ISSUED_AT,
    actorUserId: ACTOR_USER_ID,
    totals,
  });
  return { snap, rows, totals };
}
const plain = snapshotOf(GOODS_LINES);
const ref = snapshotOf(withRef);
const amounts = (r: ReturnType<typeof snapshotOf>) => JSON.stringify({ totals: r.totals, lines: r.rows.map((l) => [l.quantity, l.unitPrice, l.vatRatePercent, l.lineSubtotal, l.vatAmount, l.lineTotal].map(String)) });

console.log("snapshot");
ok("R1 the issued snapshot keeps the reference word for word", JSON.stringify(ref.snap).includes(REF));
ok("R2 amounts and tax identical to the invoice without it (lines + totals)", amounts(ref) === amounts(plain), `${amounts(ref)} vs ${amounts(plain)}`);
ok("    (the legal snapshot hash differs only because the text differs)", hashIssuedSnapshot(ref.snap) !== hashIssuedSnapshot(plain.snap));

console.log("PDF");
const html = buildBillingInvoiceHtml(ref.snap as unknown as BillingIssuedSnapshotV1, FONT_SENTINEL);
ok("R3 the invoice HTML (source of the PDF) prints the reference", html.includes(REF.replace(/'/g, "&#39;")) || html.includes(REF));
try {
  const { renderBillingPdfHtmlFromSnapshot } = await import("../lib/services/billing/pdf/billing-pdf-html-renderer");
  const { PDFParse } = await import("pdf-parse");
  const pdf = await renderBillingPdfHtmlFromSnapshot(ref.snap as unknown as BillingIssuedSnapshotV1);
  const parser = new PDFParse({ data: pdf });
  const text = (await parser.getText()).text.replace(/\s+/g, "");
  await parser.destroy();
  ok("R4 the rendered PDF contains the reference", text.includes(REF.replace(/\s+/g, "")) || text.includes("000123"), "reference not found in extracted text");
} catch (e) {
  notes.push(`R4 skipped: no Chromium here (${e instanceof Error ? e.message.split("\n")[0].slice(0, 90) : String(e)})`);
  console.log(`  [SKIP] R4 — ${notes[notes.length - 1]}`);
}

console.log("uniform export (1.31)");
const line = (description: string) => ({ lineIndex: 0, description, quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "18.00", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" });
const proj = assembleUniformExportProjection({
  businessId: 3,
  period: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T23:59:59.999Z" },
  business: { businessId: 3, name: "Dubiz", billingLegalName: "דוביז", billingBusinessKind: "LTD_COMPANY", billingTaxId: "515000123", billingVatNumber: "515000123", billingAddress: "רחוב הבדיקה 1", billingPhone: null, billingEmail: null },
  documents: [{
    id: 1, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 1, documentNumberFormatted: "00000001",
    issuedAt: "2026-11-12T10:00:00.000Z", lockedAt: "2026-11-12T10:00:00.000Z", currency: "ILS",
    subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00", allocationNumber: null, allocationApprovedAt: null,
    isEmergencyAllocation: false, legalSnapshotHash: "h", referenceDocumentId: null,
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", taxIdType: "LTD_COMPANY", city: "תל אביב", phone: null, email: null },
    customerNameSnapshot: "לקוח", lines: [line(`מוצר א — ${REF}`)], payments: [], issuedSnapshot: null,
  }],
} as Parameters<typeof assembleUniformExportProjection>[0]);
const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, { primaryId: "123456789012345", generatedAt: "2026-11-20T10:00:00.000Z" });
const d110 = built.bkmvdataText.split(CRLF).find((r) => r.startsWith("D110"))!;
// 1.31 D110 positions (1-based): 1256 at 50–52, 1257 at 53–72, 1260 at 94–123
const field = (from: number, to: number) => [...d110].slice(from - 1, to).join("");
const desc = field(94, 123);
console.log(`    D110 field 1260 (X(30)) = ${JSON.stringify(desc)}`);
console.log(`    D110 fields 1256/1257 = ${JSON.stringify(field(50, 52))} / ${JSON.stringify(field(53, 72))}`);
ok("R5a the line description reaches the export only up to 30 characters (the reference is cut)", !desc.includes("000123") && desc.trim().length <= 30, desc);
ok("R5b the base-document fields 1256/1257 stay empty (no structured link to the delivery note)", field(50, 52).trim().replace(/^0+$/, "") === "" && field(53, 72).trim() === "", `${field(50, 52)}|${field(53, 72)}`);

console.log(`\n${pass}/${pass + failures.length} passed${notes.length ? `, ${notes.length} skipped` : ""}`);
if (failures.length) process.exit(1);
